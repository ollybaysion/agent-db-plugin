import { test } from "node:test";
import assert from "node:assert/strict";
import oracledb from "oracledb";
import { getConnection, closeAllPools, sessionCallback } from "../src/pool.mjs";

// These are pure unit tests against a mocked oracledb.createPool — no real DB.
// Real-DB behavior (actual pooling/NLS/idle release) is covered by
// pool.integration.test.mjs against the Docker container (design §9).

test("sessionCallback runs the hardening statements in order, then calls back with no error", async () => {
  const executed = [];
  const fakeConnection = {
    execute: async (sql) => {
      executed.push(sql);
    },
  };
  let callbackErr = "not-called";
  await sessionCallback(fakeConnection, "", (err) => {
    callbackErr = err;
  });

  assert.equal(callbackErr, undefined);
  assert.equal(executed.length, 3);
  assert.match(executed[0], /DISABLE PARALLEL QUERY/);
  assert.match(executed[1], /NLS_NUMERIC_CHARACTERS/);
  assert.match(executed[2], /NLS_DATE_FORMAT/);
});

test("sessionCallback surfaces an ALTER SESSION failure via the callback, not a throw", async () => {
  const fakeConnection = {
    execute: async () => {
      throw new Error("ORA-99999: boom");
    },
  };
  let callbackErr;
  await assert.doesNotReject(
    () =>
      sessionCallback(fakeConnection, "", (err) => {
        callbackErr = err;
      }),
  );
  assert.match(callbackErr.message, /ORA-99999/);
});

test("getConnection lazily creates one pool per alias and sets callTimeout from limits", async (t) => {
  const createPoolCalls = [];
  const fakePool = { getConnection: async () => ({}), close: async () => {} };
  t.mock.method(oracledb, "createPool", async (opts) => {
    createPoolCalls.push(opts);
    return fakePool;
  });

  process.env.TEST_ORA_PW_POOL_ALIAS = "s3cret";
  const aliasConfig = {
    connectString: "x:1521/X",
    user: "U",
    passwordEnv: "TEST_ORA_PW_POOL_ALIAS",
    limits: { callTimeout: 12, poolMax: 3 },
  };

  const conn1 = await getConnection("pool-alias-a", aliasConfig);
  const conn2 = await getConnection("pool-alias-a", aliasConfig);

  assert.equal(createPoolCalls.length, 1, "second getConnection reuses the cached pool");
  assert.equal(createPoolCalls[0].poolAlias, "pool-alias-a");
  assert.equal(createPoolCalls[0].poolMin, 0);
  assert.equal(createPoolCalls[0].poolMax, 3);
  assert.equal(createPoolCalls[0].password, "s3cret");
  assert.equal(conn1.callTimeout, 12000);
  assert.equal(conn2.callTimeout, 12000);

  await closeAllPools(); // keep the module-singleton pool cache clean for later tests
  delete process.env.TEST_ORA_PW_POOL_ALIAS;
});

test("getConnection rejects clearly when passwordEnv is unset, without ever calling createPool", async (t) => {
  t.mock.method(oracledb, "createPool", async () => {
    throw new Error("should not be called");
  });
  delete process.env.TEST_ORA_PW_POOL_UNSET;
  const aliasConfig = {
    connectString: "x:1521/X",
    user: "U",
    passwordEnv: "TEST_ORA_PW_POOL_UNSET",
    limits: { callTimeout: 30, poolMax: 4 },
  };

  await assert.rejects(() => getConnection("pool-alias-unset", aliasConfig), /TEST_ORA_PW_POOL_UNSET/);
  const createPoolMock = oracledb.createPool.mock;
  assert.equal(createPoolMock.callCount(), 0);
});

test("closeAllPools closes every cached pool and clears the cache so a later getConnection recreates it", async (t) => {
  const closeDrains = [];
  const fakePool = {
    getConnection: async () => ({}),
    close: async (drainSeconds) => {
      closeDrains.push(drainSeconds);
    },
  };
  t.mock.method(oracledb, "createPool", async () => fakePool);

  process.env.TEST_ORA_PW_POOL_CLOSE = "pw";
  const aliasConfig = {
    connectString: "x:1521/X",
    user: "U",
    passwordEnv: "TEST_ORA_PW_POOL_CLOSE",
    limits: { callTimeout: 30, poolMax: 4 },
  };

  await getConnection("pool-alias-close", aliasConfig);
  await closeAllPools();
  assert.deepEqual(closeDrains, [10]);

  const createPoolCallsAfter = [];
  t.mock.method(oracledb, "createPool", async (opts) => {
    createPoolCallsAfter.push(opts);
    return fakePool;
  });
  await getConnection("pool-alias-close", aliasConfig);
  assert.equal(createPoolCallsAfter.length, 1, "closed pool is recreated on next use");

  delete process.env.TEST_ORA_PW_POOL_CLOSE;
});

test("closeAllPools tolerates a pool.close() failure without throwing (fail-soft shutdown)", async (t) => {
  const fakePool = {
    getConnection: async () => ({}),
    close: async () => {
      throw new Error("ORA-99999: close boom");
    },
  };
  t.mock.method(oracledb, "createPool", async () => fakePool);

  process.env.TEST_ORA_PW_POOL_CLOSE_FAIL = "pw";
  const aliasConfig = {
    connectString: "x:1521/X",
    user: "U",
    passwordEnv: "TEST_ORA_PW_POOL_CLOSE_FAIL",
    limits: { callTimeout: 30, poolMax: 4 },
  };

  await getConnection("pool-alias-close-fail", aliasConfig);
  await assert.doesNotReject(() => closeAllPools());

  delete process.env.TEST_ORA_PW_POOL_CLOSE_FAIL;
});
