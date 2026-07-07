import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { executeReadOnly } from "../src/readonly.mjs";
import { closeAllPools } from "../src/pool.mjs";
import { CAPS } from "../src/format.mjs";

// Real-DB integration test (design §9/§5 done-when, issue #5): big NUMBER is
// lossless, a large CLOB is capped to ~2KB without materializing the whole
// thing, and each cap's `truncated`/hint shows up correctly — through the real
// executeReadOnly → shapeResult path. Runs against the local `oracle-mcp-test`
// Docker container when reachable; otherwise every case is skipped so
// `npm test` stays DB-independent (Docker/CI wiring is issue #9).

const TEST_CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const TEST_USER = process.env.ORACLE_TEST_USER ?? "testuser";
const TEST_PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";
const PASSWORD_ENV = "TEST_ORA_PW_FORMAT_INTEGRATION";
const ALIAS = "format-it";

const aliasConfig = {
  connectString: TEST_CONNECT_STRING,
  user: TEST_USER,
  passwordEnv: PASSWORD_ENV,
  limits: { callTimeout: 30, poolMax: 4, defaultMaxRows: 100 },
};

async function isDbReachable() {
  try {
    const conn = await oracledb.getConnection({
      connectString: TEST_CONNECT_STRING,
      user: TEST_USER,
      password: TEST_PASSWORD,
    });
    await conn.close();
    return true;
  } catch {
    return false;
  }
}

const dbReachable = await isDbReachable();
const skip = !dbReachable && "oracle-mcp-test DB 미도달 — Docker 통합환경에서만 실행";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ORA-01466 ("table definition has changed") is a documented edge case (design
// §11: querying a table whose definition changed recently, under a read-only
// txn) — how wide that window needs to be is load-dependent (observed needing
// >1s on this long-running, repeatedly-hammered container). The design's own
// mitigation is a retry, not a bigger fixed sleep — apply it here, test-side.
async function execRetrying01466(fn) {
  const result = await fn();
  if (!result.ok && /ORA-01466/.test(result.error)) {
    await delay(2000);
    return fn();
  }
  return result;
}

before(async () => {
  if (!dbReachable) return;
  process.env[PASSWORD_ENV] = TEST_PASSWORD;
  const setup = await oracledb.getConnection({
    connectString: TEST_CONNECT_STRING,
    user: TEST_USER,
    password: TEST_PASSWORD,
  });
  try {
    await setup.execute(
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE t_format_it'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    );
    await setup.execute(
      `CREATE TABLE t_format_it (id NUMBER, big_num NUMBER, doc CLOB, bin BLOB, note VARCHAR2(4000))`,
    );
    await setup.execute(
      `INSERT INTO t_format_it VALUES (
         1, 90071992547409929,
         RPAD('c', 32767, 'c'),
         UTL_RAW.CAST_TO_RAW('binarydata'),
         'hello'
       )`,
    );
    // Grow the CLOB to ~8MB (32767 * 2^8) without a giant literal, so the cap test
    // exercises the partial read against a genuinely large driver Lob end-to-end.
    // (The "never materialize the whole thing" guarantee itself is asserted
    // deterministically in format.test.mjs via a bounded-getData spy — see the note
    // there on why an integration heap-delta check can't catch that regression.)
    for (let i = 0; i < 8; i++) await setup.execute(`UPDATE t_format_it SET doc = doc || doc`);
    await setup.execute(`COMMIT`);
  } finally {
    await setup.close();
  }
  await delay(1100); // best-effort settle window — execRetrying01466 covers the rest
});

after(async () => {
  if (!dbReachable) return;
  delete process.env[PASSWORD_ENV];
  await closeAllPools();
});

test("big NUMBER (> 2^53) round-trips losslessly as a string (§12-1)", { skip }, async () => {
  const result = await execRetrying01466(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT big_num FROM t_format_it WHERE id = 1",
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows[0][0], "90071992547409929");
  assert.deepEqual(result.columns[0], { name: "BIG_NUM", type: "NUMBER" });
});

test("a large (~8MB) CLOB is capped to the cell size, read end-to-end through the real Lob (§12-2)", { skip }, async () => {
  const result = await execRetrying01466(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT doc FROM t_format_it WHERE id = 1",
    }),
  );

  assert.equal(result.ok, true);
  const cell = result.rows[0][0];
  assert.equal(cell.length <= CAPS.cell + 40, true); // capped text + a short truncation note
  assert.match(cell, /\[truncated, total/);
  // This exercises the partial read against a genuine multi-MB driver Lob, but it
  // can only prove the OUTPUT is capped — a whole-materialize regression would also
  // produce a capped output. The definitive "never materialize the whole LOB" guard
  // is the bounded-getData assertion in format.test.mjs: a heap-delta check here
  // can't catch it (the transient allocation is GC-eligible before heapUsed is next
  // sampled, so it never registers — verified by regressing the code locally).
});

test("a BLOB never surfaces content, only a size placeholder", { skip }, async () => {
  const result = await execRetrying01466(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT bin FROM t_format_it WHERE id = 1",
    }),
  );
  assert.equal(result.ok, true);
  assert.match(result.rows[0][0], /^<BLOB [\d.]+KB>$/);
});

test("row cap: max_rows override truncates and reports truncated=true with a hint", { skip }, async () => {
  const setup = await oracledb.getConnection({
    connectString: TEST_CONNECT_STRING,
    user: TEST_USER,
    password: TEST_PASSWORD,
  });
  try {
    await setup.execute(`BEGIN EXECUTE IMMEDIATE 'DROP TABLE t_format_rowcap'; EXCEPTION WHEN OTHERS THEN NULL; END;`);
    await setup.execute(`CREATE TABLE t_format_rowcap (id NUMBER)`);
    for (let i = 1; i <= 5; i++) await setup.execute(`INSERT INTO t_format_rowcap VALUES (${i})`);
    await setup.execute("COMMIT");
  } finally {
    await setup.close();
  }
  await delay(1100);

  const result = await execRetrying01466(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT id FROM t_format_rowcap ORDER BY id",
      maxRows: 3,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 3);
  assert.deepEqual(result.rows, [["1"], ["2"], ["3"]]);
  assert.match(result.hint, /행 3개에서 절단/);
});

test("no false-positive truncation when the result set is exactly max_rows (§11-5b)", { skip }, async () => {
  const result = await execRetrying01466(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT id FROM t_format_rowcap WHERE id <= 3 ORDER BY id",
      maxRows: 3,
    }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.truncated, false);
  assert.equal(result.rowCount, 3);
});
