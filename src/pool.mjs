// Per-alias connection pools. Design: docs/design.md §3.1, §6.1.
//
// One lazily-created pool per alias (poolMin:0 so idle sessions return to the DB
// after poolTimeout — DBA-friendly). A sessionCallback hardens each physical
// connection ONCE: disable parallel query (load control, §6.1) and pin NLS so
// agent-written TO_CHAR/date formatting is deterministic across DBs (§6.2).

// import oracledb from "oracledb";

// oracledb.fetchAsString = [oracledb.NUMBER]; // §6.2: NUMBER lossless as string
//                                             // (2^53 corruption, verified §12-1)

/**
 * Session hardening run once per physical connection (design §6.1 / §6.2).
 * TODO(impl):
 *   ALTER SESSION DISABLE PARALLEL QUERY
 *   ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'
 *   ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS'
 * User SQL cannot undo these — ALTER SESSION is rejected by L2 (readonly.mjs).
 */
// async function sessionCallback(conn, _tag) { ... }

/**
 * Get (or lazily create) the pool for an alias, then check out a connection.
 * TODO(impl): createPool with the §3.1 params (poolMin:0, poolMax from limits,
 * poolTimeout:60, poolPingInterval:60, queueTimeout, stmtCacheSize) + callTimeout,
 * + sessionCallback above.
 */
export async function getConnection(/* alias, aliasConfig, limits */) {
  throw new Error("NotImplemented: getConnection (skeleton) — see docs/design.md §3.1");
}

/** Close all pools on shutdown (SIGTERM / stdio close). */
export async function closeAllPools() {
  throw new Error("NotImplemented: closeAllPools (skeleton) — see docs/design.md §3.1");
}
