import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { executeReadOnly } from "../src/readonly.mjs";
import { getConnection as checkoutConnection, closeAllPools } from "../src/pool.mjs";

// Real-DB integration test (design §9 done-when, issue #4): DML/FOR UPDATE →
// ORA-01456, DDL escapes the read-only txn but L2 catches it first, and a
// semicolon-chained statement is rejected by the driver (L4). Runs against the
// local `oracle-mcp-test` Docker container when reachable; otherwise every
// case is skipped so `npm test` stays DB-independent (Docker/CI wiring is #9).

const TEST_CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const TEST_USER = process.env.ORACLE_TEST_USER ?? "testuser";
const TEST_PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";
const PASSWORD_ENV = "TEST_ORA_PW_READONLY_INTEGRATION";
const ALIAS = "readonly-it";

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
// §11: querying a table whose definition changed <1s ago, under a read-only
// txn) — rare, and worse under a loaded box running the whole suite
// concurrently. The design's own documented mitigation is a single retry, not
// production retry logic (that's a future trigger, not #4's scope) — so apply
// it here, test-side only.
async function runExpectingShapeStub(fn) {
  const result = await fn();
  if (!result.ok && /ORA-01466/.test(result.error)) {
    await delay(750);
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
      `BEGIN EXECUTE IMMEDIATE 'DROP TABLE t_readonly_it'; EXCEPTION WHEN OTHERS THEN NULL; END;`,
    );
    await setup.execute(`CREATE TABLE t_readonly_it (id NUMBER PRIMARY KEY, note VARCHAR2(100))`);
    await setup.execute(`INSERT INTO t_readonly_it VALUES (1, 'alpha')`);
    await setup.execute(`COMMIT`);
  } finally {
    await setup.close();
  }
  // ORA-01466 ("table definition has changed") can hit a read-only txn against a
  // table altered <1s ago (design §11 관찰 항목) — let it settle past that window
  // so the tests below exercise L1/L2/L4, not this unrelated edge case.
  await delay(1100);
});

after(async () => {
  if (!dbReachable) return;
  delete process.env[PASSWORD_ENV];
  await closeAllPools();
});

test("executeReadOnly: SELECT ... FOR UPDATE is rejected with ORA-01456 (§11-1) — DML proper (UPDATE/INSERT/DELETE) never even reaches L1, L2 already rejects it (see readonly.test.mjs)", { skip }, async () => {
  const result = await executeReadOnly({
    alias: ALIAS,
    aliasConfig,
    sql: "SELECT * FROM t_readonly_it FOR UPDATE",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-01456/);
});

test("executeReadOnly: DDL is rejected by L2 before ever reaching the DB (design §11-2 shows L1 alone would let it escape)", { skip }, async () => {
  const result = await executeReadOnly({
    alias: ALIAS,
    aliasConfig,
    sql: "CREATE TABLE t_readonly_it_escape (x NUMBER)",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /SELECT\/WITH/);
});

test("executeReadOnly: a semicolon-chained statement is rejected by the driver, not silently run (§11-4/L4)", { skip }, async () => {
  const result = await executeReadOnly({
    alias: ALIAS,
    aliasConfig,
    sql: "SELECT 1 FROM dual; SELECT 2 FROM dual",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ORA-03405/);
});

test("executeReadOnly: a valid SELECT reaches the (not-yet-implemented) shaping hook and still cleans up the connection", { skip }, async () => {
  const result = await runExpectingShapeStub(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT note FROM t_readonly_it WHERE id = 1",
    }),
  );
  // format.mjs's shapeResult is issue #5's job — until then this is the expected
  // failure mode for an otherwise-successful query. What this test actually
  // proves is that checkout/rollback/STRO/execute all ran without error and the
  // connection was handed back to the pool cleanly (poolMin:0 → connectionsInUse:0).
  assert.equal(result.ok, false);
  assert.match(result.error, /NotImplemented: shapeResult/);

  const pool = oracledb.getPool(ALIAS);
  assert.equal(pool.connectionsInUse, 0);
});

test("executeReadOnly: checkout-time rollback cleans up a dirty pooled connection before the next query (§12-3)", { skip }, async () => {
  // Reuses the same alias's pool (already warmed by the prior tests) — checks
  // out directly via pool.mjs, leaves an uncommitted write dangling, releases
  // it back dirty, then confirms executeReadOnly's next checkout still works
  // (i.e. its own checkout-rollback cleared the dangling txn instead of the
  // next SET TRANSACTION READ ONLY failing with ORA-01453).
  const dirty = await checkoutConnection(ALIAS, aliasConfig);
  await dirty.execute("UPDATE t_readonly_it SET note = 'dirty' WHERE id = 1");
  await dirty.close(); // returned to the pool with an uncommitted txn still open

  const result = await runExpectingShapeStub(() =>
    executeReadOnly({
      alias: ALIAS,
      aliasConfig,
      sql: "SELECT note FROM t_readonly_it WHERE id = 1",
    }),
  );
  assert.equal(result.ok, false); // still hits the shapeResult stub, not ORA-01453
  assert.match(result.error, /NotImplemented: shapeResult/);
});
