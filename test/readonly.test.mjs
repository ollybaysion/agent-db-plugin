import { test } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { validateReadOnlyStatement, executeReadOnly } from "../src/readonly.mjs";
import { HARD_MAX_ROWS } from "../src/config.mjs";

const ok = (sql) => assert.equal(validateReadOnlyStatement(sql).ok, true, sql);
const no = (sql) => assert.equal(validateReadOnlyStatement(sql).ok, false, sql);

test("allows SELECT / WITH", () => {
  ok("SELECT * FROM dual");
  ok("  select 1 from dual");
  ok("WITH t AS (SELECT 1 FROM dual) SELECT * FROM t");
  ok("/* hi */ SELECT 1 FROM dual");
  ok("-- lead\nSELECT 1 FROM dual");
  ok("(SELECT 1 FROM dual)");
});

test("rejects DML / DDL / PLSQL / LOCK", () => {
  no("INSERT INTO t VALUES (1)");
  no("UPDATE t SET x=1");
  no("DELETE FROM t");
  no("MERGE INTO t USING s ON (t.id=s.id) WHEN MATCHED THEN UPDATE SET t.x=1");
  no("DROP TABLE t");
  no("CREATE TABLE t (x NUMBER)");
  no("TRUNCATE TABLE t");
  no("ALTER SESSION SET x=y");
  no("GRANT SELECT ON t TO u");
  no("LOCK TABLE t IN EXCLUSIVE MODE"); // §12-5: only L2 catches this
  no("BEGIN NULL; END;");
  no("DECLARE x NUMBER; BEGIN NULL; END;");
  no("CALL proc()");
});

test("rejects WITH FUNCTION / PROCEDURE (autonomous-txn write path, §11-3)", () => {
  no("WITH FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END; SELECT f FROM dual");
  no("with   procedure p is begin null; end; select 1 from dual");
});

test("rejects empty / non-string", () => {
  no("");
  no("   ");
  no(undefined);
});

// executeReadOnly — the single execution path (design §5). These are pure unit
// tests against a fake connection (getConnection/shapeResult are injectable —
// see the doc comment in readonly.mjs for why: ESM named exports can't be
// monkey-patched like pool.test.mjs mocks the oracledb CJS object). Real-DB
// behavior is covered by readonly.integration.test.mjs.

test("executeReadOnly: L2 rejects before ever calling getConnection", async () => {
  const result = await executeReadOnly({
    alias: "exec-gate",
    aliasConfig: {},
    sql: "CREATE TABLE t (x NUMBER)",
    getConnection: async () => {
      throw new Error("should not be called");
    },
    audit: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /SELECT\/WITH/);
});

test("executeReadOnly: deny-scan rejects a denied table before ever calling getConnection (design §5 수준2)", async () => {
  const result = await executeReadOnly({
    alias: "exec-gate",
    aliasConfig: { tables: { deny: ["ERP.HR_SALARY"] } },
    sql: "SELECT * FROM hr_salary",
    getConnection: async () => {
      throw new Error("should not be called");
    },
    audit: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /HR_SALARY/);
});

test("executeReadOnly: a query with no denied table reference passes the deny-scan through to execution", async () => {
  const fakeConnection = {
    rollback: async () => {},
    execute: async () => ({ metaData: [], rows: [] }),
    close: async () => {},
  };
  const result = await executeReadOnly({
    alias: "a",
    aliasConfig: { tables: { deny: ["ERP.HR_SALARY"] } },
    sql: "SELECT * FROM gl_accounts",
    getConnection: async () => fakeConnection,
    shapeResult: () => ({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 }),
    audit: async () => {},
  });
  assert.equal(result.ok, true);
});

test("executeReadOnly: full sequence — checkout-rollback before STRO, execute with maxRows+1, shape, unconditional rollback+close", async () => {
  const calls = [];
  const fakeConnection = {
    rollback: async () => {
      calls.push("rollback");
    },
    execute: async (sql, binds, opts) => {
      calls.push(["execute", sql, opts]);
      return { metaData: [{ name: "X" }], rows: [["1"]] };
    },
    close: async () => {
      calls.push("close");
    },
  };
  const aliasConfig = { limits: { defaultMaxRows: 50 } };
  const shaped = { columns: ["X"], rows: [["1"]], rowCount: 1, truncated: false, elapsedMs: 0 };

  const result = await executeReadOnly({
    alias: "a",
    aliasConfig,
    sql: "SELECT 1 FROM dual",
    getConnection: async (alias, cfg) => {
      assert.equal(alias, "a");
      assert.equal(cfg, aliasConfig);
      return fakeConnection;
    },
    shapeResult: (args) => {
      assert.equal(args.maxRows, 50);
      assert.deepEqual(args.metaData, [{ name: "X" }]);
      assert.deepEqual(args.rows, [["1"]]);
      assert.equal(typeof args.elapsedMs, "number");
      return shaped;
    },
    audit: async () => {},
  });

  assert.deepEqual(result, { ok: true, ...shaped });
  assert.equal(calls[0], "rollback"); // §12-3 checkout-time cleanup, before STRO
  assert.equal(calls[1][0], "execute");
  assert.match(calls[1][1], /SET TRANSACTION READ ONLY/);
  assert.equal(calls[2][0], "execute");
  assert.equal(calls[2][1], "SELECT 1 FROM dual");
  assert.equal(calls[2][2].maxRows, 51); // maxRows+1 (§6 truncation detection)
  assert.equal(calls[2][2].outFormat, oracledb.OUT_FORMAT_ARRAY);
  assert.equal(calls[3], "rollback"); // unconditional, before close
  assert.equal(calls[4], "close");
});

test("executeReadOnly: maxRows override is clamped to the hard cap", async () => {
  let capturedMaxRows;
  const fakeConnection = {
    rollback: async () => {},
    execute: async (sql, binds, opts) => {
      if (opts) capturedMaxRows = opts.maxRows;
      return { metaData: [], rows: [] };
    },
    close: async () => {},
  };

  await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT 1 FROM dual",
    maxRows: HARD_MAX_ROWS * 10,
    getConnection: async () => fakeConnection,
    shapeResult: () => ({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 }),
    audit: async () => {},
  });

  assert.equal(capturedMaxRows, HARD_MAX_ROWS + 1);
});

test("executeReadOnly: a DB-level rejection (e.g. FOR UPDATE → ORA-01456) is returned verbatim, and cleanup still runs", async () => {
  const calls = [];
  const fakeConnection = {
    rollback: async () => {
      calls.push("rollback");
    },
    execute: async (sql) => {
      if (/SET TRANSACTION/.test(sql)) {
        calls.push("stro");
        return;
      }
      throw new Error("ORA-01456: may not perform insert/delete/update operation inside a READ ONLY transaction");
    },
    close: async () => {
      calls.push("close");
    },
  };

  const result = await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT * FROM t FOR UPDATE",
    getConnection: async () => fakeConnection,
    audit: async () => {},
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-01456/);
  assert.deepEqual(calls, ["rollback", "stro", "rollback", "close"]);
});

test("executeReadOnly: a connection-checkout failure (e.g. pool exhausted) is returned as {ok:false, error}", async () => {
  const result = await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT 1 FROM dual",
    getConnection: async () => {
      throw new Error("NJS-040: connection request timeout");
    },
    audit: async () => {},
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /NJS-040/);
});

// audit wiring (design §8, issue #8) — executeReadOnly calls `audit` exactly
// once per invocation, regardless of which exit path was taken. `audit`
// defaults to the real audit.mjs implementation, so every test above that
// doesn't care about auditing overrides it with a no-op to avoid writing to
// the developer's real ~/.oracle-mcp/audit. audit.mjs's own behavior (line
// format, perms, fail-open) is covered directly in audit.test.mjs.

test("executeReadOnly: audits an L2 rejection — no DB round trip, but still one record with oraError set", async () => {
  const calls = [];
  await executeReadOnly({
    alias: "erp-prod",
    aliasConfig: {},
    sql: "DROP TABLE t",
    tool: "run_query",
    getConnection: async () => {
      throw new Error("should not be called");
    },
    audit: async (record) => calls.push(record),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].alias, "erp-prod");
  assert.equal(calls[0].tool, "run_query");
  assert.equal(calls[0].sql, "DROP TABLE t");
  assert.equal(typeof calls[0].elapsedMs, "number");
  assert.equal(calls[0].rowCount, null);
  assert.equal(calls[0].truncated, null);
  assert.match(calls[0].oraError, /SELECT\/WITH/);
});

test("executeReadOnly: audits a successful query with rowCount/truncated from the shaped result and no oraError", async () => {
  const calls = [];
  const fakeConnection = {
    rollback: async () => {},
    execute: async () => ({ metaData: [], rows: [] }),
    close: async () => {},
  };
  await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT 1 FROM dual",
    tool: "list_tables",
    getConnection: async () => fakeConnection,
    shapeResult: () => ({ columns: [], rows: [], rowCount: 3, truncated: true, elapsedMs: 5 }),
    audit: async (record) => calls.push(record),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "list_tables");
  assert.equal(calls[0].rowCount, 3);
  assert.equal(calls[0].truncated, true);
  assert.equal(calls[0].oraError, null);
});

test("executeReadOnly: audits a DB-level failure with the ORA message as oraError", async () => {
  const calls = [];
  const fakeConnection = {
    rollback: async () => {},
    execute: async (sql) => {
      if (/SET TRANSACTION/.test(sql)) return;
      throw new Error("ORA-01456: may not perform insert/delete/update operation inside a READ ONLY transaction");
    },
    close: async () => {},
  };
  await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT * FROM t FOR UPDATE",
    getConnection: async () => fakeConnection,
    audit: async (record) => calls.push(record),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].rowCount, null);
  assert.match(calls[0].oraError, /ORA-01456/);
});
