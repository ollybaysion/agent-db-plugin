import { test } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { getConnection, closeAllPools } from "../src/pool.mjs";

// Real-DB integration test (design §9 Done-when: 접속 성공 / 유휴 반납(poolMin:0) /
// NLS 고정 실동작). Runs against the local `oracle-mcp-test` Docker container
// (gvenzl/oracle-free, same one used for the design's live verification —
// scratchpad/oracle-verify/verify.mjs) if reachable; otherwise every case is
// skipped so `npm test` stays DB-independent (Docker/CI wiring is issue #9).

const TEST_CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const TEST_USER = process.env.ORACLE_TEST_USER ?? "testuser";
const TEST_PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";
const PASSWORD_ENV = "TEST_ORA_PW_POOL_INTEGRATION";

const aliasConfig = {
  connectString: TEST_CONNECT_STRING,
  user: TEST_USER,
  passwordEnv: PASSWORD_ENV,
  limits: { callTimeout: 30, poolMax: 4 },
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

test("getConnection: checks out a working connection from a lazily-created pool", { skip: !dbReachable && "oracle-mcp-test DB 미도달 — Docker 통합환경에서만 실행" }, async () => {
  process.env[PASSWORD_ENV] = TEST_PASSWORD;
  try {
    const conn = await getConnection("pool-it-basic", aliasConfig);
    try {
      const result = await conn.execute("SELECT 1 AS ok FROM DUAL");
      // NUMBER comes back as a string — pool.mjs sets fetchAsString=[NUMBER] globally (§6.2)
      assert.equal(result.rows[0][0], "1");
    } finally {
      await conn.close();
    }
  } finally {
    delete process.env[PASSWORD_ENV];
    await closeAllPools();
  }
});

test("sessionCallback hardening: NLS is pinned regardless of the DB's default locale", { skip: !dbReachable && "oracle-mcp-test DB 미도달 — Docker 통합환경에서만 실행" }, async () => {
  process.env[PASSWORD_ENV] = TEST_PASSWORD;
  try {
    const conn = await getConnection("pool-it-nls", aliasConfig);
    try {
      const result = await conn.execute(
        `SELECT parameter, value FROM NLS_SESSION_PARAMETERS
         WHERE parameter IN ('NLS_NUMERIC_CHARACTERS', 'NLS_DATE_FORMAT')`,
      );
      const values = Object.fromEntries(result.rows);
      assert.equal(values.NLS_NUMERIC_CHARACTERS, ".,");
      assert.equal(values.NLS_DATE_FORMAT, 'YYYY-MM-DD"T"HH24:MI:SS');
    } finally {
      await conn.close();
    }
  } finally {
    delete process.env[PASSWORD_ENV];
    await closeAllPools();
  }
});

test("pool lifecycle: poolMin is 0 and a released connection isn't held in-use", { skip: !dbReachable && "oracle-mcp-test DB 미도달 — Docker 통합환경에서만 실행" }, async () => {
  process.env[PASSWORD_ENV] = TEST_PASSWORD;
  try {
    const conn = await getConnection("pool-it-idle", aliasConfig);
    await conn.close(); // return to the pool (not a real DB disconnect)

    const pool = oracledb.getPool("pool-it-idle");
    assert.equal(pool.poolMin, 0, "poolMin:0 — idle sessions are allowed to drain to zero");
    assert.equal(pool.connectionsInUse, 0, "checked-in connection is not counted as in-use");
  } finally {
    delete process.env[PASSWORD_ENV];
    await closeAllPools();
  }
});
