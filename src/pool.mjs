// Per-alias connection pools. Design: docs/design.md §3.1, §6.1.
//
// One lazily-created pool per alias (poolMin:0 so idle sessions return to the DB
// after poolTimeout — DBA-friendly). A sessionCallback hardens each physical
// connection ONCE: disable parallel query (load control, §6.1) and pin NLS so
// agent-written TO_CHAR/date formatting is deterministic across DBs (§6.2).

import oracledb from "oracledb";

import { resolvePassword } from "./config.mjs";

oracledb.fetchAsString = [oracledb.NUMBER]; // §6.2: NUMBER lossless as string
//                                             (2^53 corruption, verified §12-1)

const POOL_MIN = 0; // idle sessions return to the DB (§3.1 lifecycle)
const POOL_INCREMENT = 1;
const POOL_TIMEOUT_SECONDS = 60;
const POOL_PING_INTERVAL_SECONDS = 60;
const QUEUE_TIMEOUT_MS = 10000; // pool exhausted → clear error, not an infinite wait
const STMT_CACHE_SIZE = 30;
const POOL_CLOSE_DRAIN_SECONDS = 10;
const DEFAULT_CALL_TIMEOUT_SECONDS = 30;

// alias -> Promise<Pool>. A Promise (not the Pool itself) is cached so concurrent
// first-use callers await the same createPool() instead of racing to register
// the same poolAlias twice (oracledb rejects a duplicate poolAlias).
const pools = new Map();

/**
 * Session hardening run once per physical connection (design §6.1 / §6.2).
 * node-oracledb always invokes this callback-style — (connection, requestedTag,
 * callbackFn) — regardless of this function being declared async, so we must
 * call callbackFn ourselves rather than just returning/throwing.
 */
export async function sessionCallback(connection, _requestedTag, callbackFn) {
  try {
    await connection.execute("ALTER SESSION DISABLE PARALLEL QUERY");
    await connection.execute("ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'");
    await connection.execute(`ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS'`);
    callbackFn();
  } catch (err) {
    callbackFn(err);
  }
}

async function createPool(alias, aliasConfig) {
  const { connectString, user } = aliasConfig;
  const password = resolvePassword(aliasConfig); // throws → rejects (async fn)
  const poolMax = aliasConfig.limits?.poolMax;
  return oracledb.createPool({
    poolAlias: alias,
    connectString,
    user,
    password,
    poolMin: POOL_MIN,
    poolMax,
    poolIncrement: POOL_INCREMENT,
    poolTimeout: POOL_TIMEOUT_SECONDS,
    poolPingInterval: POOL_PING_INTERVAL_SECONDS,
    queueTimeout: QUEUE_TIMEOUT_MS,
    stmtCacheSize: STMT_CACHE_SIZE,
    sessionCallback,
  });
}

function getPool(alias, aliasConfig) {
  let poolPromise = pools.get(alias);
  if (!poolPromise) {
    poolPromise = createPool(alias, aliasConfig).catch((err) => {
      pools.delete(alias); // don't cache a failed attempt — allow retry
      throw err;
    });
    pools.set(alias, poolPromise);
  }
  return poolPromise;
}

/**
 * Get (or lazily create) the pool for an alias, then check out a connection
 * with callTimeout set from its (already-merged/clamped, see config.mjs) limits.
 */
export async function getConnection(alias, aliasConfig) {
  const pool = await getPool(alias, aliasConfig);
  const connection = await pool.getConnection();
  const callTimeout = aliasConfig.limits?.callTimeout ?? DEFAULT_CALL_TIMEOUT_SECONDS;
  connection.callTimeout = callTimeout * 1000; // driver property is milliseconds
  return connection;
}

/** Close all pools on shutdown (SIGTERM / stdio close). Fail-soft per pool. */
export async function closeAllPools() {
  const entries = [...pools.entries()];
  pools.clear();
  await Promise.all(
    entries.map(async ([alias, poolPromise]) => {
      try {
        const pool = await poolPromise;
        await pool.close(POOL_CLOSE_DRAIN_SECONDS);
      } catch (err) {
        console.error(`[agent-db-plugin] 풀 종료 실패 (${alias}):`, err.message);
      }
    }),
  );
}
