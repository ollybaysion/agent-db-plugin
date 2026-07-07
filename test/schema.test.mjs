import { test } from "node:test";
import assert from "node:assert/strict";
import { listTables, describeTable } from "../src/schema.mjs";
import { HARD_MAX_ROWS } from "../src/config.mjs";

// Pure unit tests against a fake executeReadOnly (injectable — same seam
// readonly.mjs uses, for the same reason: ESM named exports can't be
// monkey-patched). Real-DB catalog queries are covered by schema.integration.test.mjs.

function fakeExecuteReadOnly(bySqlSnippet) {
  return async ({ sql, maxRows }) => {
    for (const [snippet, handler] of bySqlSnippet) {
      if (sql.includes(snippet)) return handler({ sql, maxRows });
    }
    throw new Error(`no fake handler matched sql: ${sql}`);
  };
}

function okResult(columns, rows) {
  return { ok: true, columns: columns.map((name) => ({ name, type: "VARCHAR2" })), rows, rowCount: rows.length, truncated: false, elapsedMs: 1 };
}

const aliasConfig = { user: "APP_RO", connectString: "x:1521/X", passwordEnv: "PW" };

test("listTables: binds schema/name_filter as values, never assembles them into SQL", async () => {
  const calls = [];
  const executeReadOnly = async (opts) => {
    calls.push(opts);
    return okResult(["OWNER", "TABLE_NAME", "COMMENTS"], [["APP", "T1", "note"]]);
  };

  const result = await listTables("a", aliasConfig, {
    schema: "app",
    nameFilter: "t_%",
    executeReadOnly,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.tables, [{ owner: "APP", table: "T1", comment: "note" }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].binds.schema, "APP");
  assert.equal(calls[0].binds.nameFilter, "T_%");
  assert.match(calls[0].sql, /:schema/);
  assert.match(calls[0].sql, /:nameFilter/);
  assert.equal(calls[0].maxRows, HARD_MAX_ROWS);
});

test("listTables: no filters -> no extra WHERE conditions, still works", async () => {
  const executeReadOnly = async ({ sql, binds }) => {
    assert.deepEqual(binds, {});
    assert.doesNotMatch(sql, /:schema/);
    return okResult(["OWNER", "TABLE_NAME", "COMMENTS"], []);
  };
  const result = await listTables("a", aliasConfig, { executeReadOnly });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tables, []);
});

test("listTables: a query failure surfaces as {ok:false, error}", async () => {
  const executeReadOnly = async () => ({ ok: false, error: "ORA-01017: invalid username/password" });
  const result = await listTables("a", aliasConfig, { executeReadOnly });
  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-01017/);
});

test("listTables: allow patterns hide tables outside the catalog surface (design §5 수준1)", async () => {
  const executeReadOnly = async () =>
    okResult(
      ["OWNER", "TABLE_NAME", "COMMENTS"],
      [
        ["ERP", "GL_ACCOUNTS", null],
        ["ERP", "HR_SALARY", null],
        ["ERP", "AP_INVOICES", null],
      ],
    );
  const restrictedConfig = { ...aliasConfig, tables: { allow: ["ERP.GL_*", "ERP.AP_*"] } };
  const result = await listTables("a", restrictedConfig, { executeReadOnly });
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.tables.map((t) => t.table),
    ["GL_ACCOUNTS", "AP_INVOICES"],
  );
});

test("listTables: no allow list configured -> every table is visible", async () => {
  const executeReadOnly = async () =>
    okResult(["OWNER", "TABLE_NAME", "COMMENTS"], [["ERP", "HR_SALARY", null]]);
  const result = await listTables("a", aliasConfig, { executeReadOnly });
  assert.equal(result.ok, true);
  assert.deepEqual(result.tables.map((t) => t.table), ["HR_SALARY"]);
});

test("describeTable: rejects an invalid identifier without ever calling executeReadOnly", async () => {
  const result = await describeTable("a", aliasConfig, "bad;name", {
    executeReadOnly: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /잘못된 테이블 식별자/);
});

test("describeTable: rejects a table outside the allow patterns without ever calling executeReadOnly (design §5 수준1)", async () => {
  const restrictedConfig = { ...aliasConfig, tables: { allow: ["ERP.GL_*"] } };
  const result = await describeTable("a", restrictedConfig, "ERP.HR_SALARY", {
    executeReadOnly: async () => {
      throw new Error("should not be called");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /허용되지 않은 테이블/);
});

test("describeTable: table param without a schema prefix defaults to the connection's own user", async () => {
  const calls = [];
  const executeReadOnly = fakeExecuteReadOnly([
    ['FROM "APP_RO"."MYTABLE"', () => ({ ok: true })],
    ["all_tables", () => okResult(["NUM_ROWS", "LAST_ANALYZED"], [["10", "2026-07-08T00:00:00"]])],
    ["all_tab_columns", () => okResult(["COLUMN_NAME"], [])],
    ["constraint_type = 'P'", () => okResult(["COLUMN_NAME"], [])],
    ["constraint_type = 'R'", () => okResult(["FK_COLUMN"], [])],
    ["all_indexes", () => okResult(["INDEX_NAME"], [])],
    ["all_ind_columns", () => okResult(["INDEX_NAME"], [])],
  ]);
  const wrapped = async (opts) => {
    calls.push(opts.sql);
    return executeReadOnly(opts);
  };

  const result = await describeTable("a", aliasConfig, "mytable", { executeReadOnly: wrapped });
  assert.equal(result.ok, true);
  assert.equal(result.owner, "APP_RO");
  assert.equal(result.table, "MYTABLE");
  assert.ok(calls.some((sql) => sql.includes('"APP_RO"."MYTABLE"')));
});

test("describeTable: a missing/inaccessible table returns the ORA error verbatim, no further queries run", async () => {
  let catalogQueriesRun = 0;
  const executeReadOnly = async ({ sql }) => {
    if (sql.includes("FROM ")) {
      return { ok: false, error: "ORA-00942: table or view does not exist" };
    }
    catalogQueriesRun++;
    return okResult(["X"], []);
  };
  const result = await describeTable("a", aliasConfig, "SCHEMA.NOPE", { executeReadOnly });
  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-00942/);
  assert.equal(catalogQueriesRun, 0);
});

test("describeTable: assembles columns/PK/FK/indexes from the catalog queries into a structured shape", async () => {
  const executeReadOnly = fakeExecuteReadOnly([
    ['FROM "APP"."ORDERS"', () => ({ ok: true })],
    [
      "all_tables",
      () => okResult(["NUM_ROWS", "LAST_ANALYZED"], [["100", "2026-07-08T00:00:00"]]),
    ],
    [
      "all_tab_columns",
      () =>
        okResult(
          ["COLUMN_NAME", "DATA_TYPE", "DATA_LENGTH", "DATA_PRECISION", "DATA_SCALE", "NULLABLE", "DATA_DEFAULT", "COLUMN_ID", "COMMENTS"],
          [
            ["ID", "NUMBER", "22", "10", "0", "N", null, "1", null],
            ["STATUS", "VARCHAR2", "20", null, null, "N", "'NEW' ", "2", "주문 상태"],
          ],
        ),
    ],
    [
      "constraint_type = 'P'",
      () => okResult(["CONSTRAINT_NAME", "COLUMN_NAME", "POSITION", "CONSTRAINT_TYPE"], [["ORD_PK", "ID", "1", "P"]]),
    ],
    [
      "constraint_type = 'R'",
      () => okResult(["FK_COLUMN", "REF_TABLE", "REF_COLUMN"], [["CUSTOMER_ID", "CUSTOMERS", "ID"]]),
    ],
    ["all_indexes", () => okResult(["INDEX_NAME", "UNIQUENESS"], [["ORD_PK", "UNIQUE"], ["ORD_STATUS_IDX", "NONUNIQUE"]])],
    [
      "all_ind_columns",
      () =>
        okResult(
          ["INDEX_NAME", "COLUMN_NAME", "COLUMN_POSITION"],
          [
            ["ORD_PK", "ID", "1"],
            ["ORD_STATUS_IDX", "STATUS", "1"],
          ],
        ),
    ],
  ]);

  const result = await describeTable("a", aliasConfig, "APP.ORDERS", { executeReadOnly });

  assert.equal(result.ok, true);
  assert.deepEqual(result.columns, [
    { name: "ID", type: "NUMBER(10,0)", nullable: false, default: null, comment: null },
    { name: "STATUS", type: "VARCHAR2(20)", nullable: false, default: "'NEW'", comment: "주문 상태" },
  ]);
  assert.deepEqual(result.primaryKey, ["ID"]);
  assert.deepEqual(result.foreignKeys, [{ column: "CUSTOMER_ID", refTable: "CUSTOMERS", refColumn: "ID" }]);
  assert.deepEqual(result.indexes, [
    { name: "ORD_PK", unique: true, columns: ["ID"] },
    { name: "ORD_STATUS_IDX", unique: false, columns: ["STATUS"] },
  ]);
  assert.equal(result.numRows, "100");
  assert.equal(result.lastAnalyzed, "2026-07-08T00:00:00");
});
