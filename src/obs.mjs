// Observability emit (SENDING side) — claude-hooks#87.
//
// Mirrors claude-hooks lib/obs-client.mjs's `postEnvelope`, reimplemented here
// because this plugin ships as a standalone esbuild bundle (package.json build:
// --bundle --packages=bundle) running in its own process (.mcp.json), so it
// cannot import claude-hooks' lib. One DbQuery event per SQL execution, emitted
// from the same single choke point as the audit record (readonly.mjs).
//
// Discipline — fail-open extended to LATENCY (design §8): a logging/emit failure
// must NEVER block a query, and neither may a slow or absent collector. So this
// is fire-and-forget: the caller does not await it, it NEVER throws or rejects,
// and every socket path is bounded by a timeout. Writes nothing to stdout/stderr
// — this process's stdout is the MCP stdio stream and must not be corrupted.
//
// sql is sent VERBATIM (no masking — scoped out per #87 discussion): the audit
// file already keeps the same raw sql at 0600, and this is a local/rehearsal
// deployment only (the in-office Windows MCP host has no reachable collector).

import http from "node:http";

const DEFAULT_TIMEOUT_MS = 2000;

// Read at call time (not module load) so OBS_HOST/OBS_PORT overrides take effect
// even after import — the seam the unit tests point at a stub server.
function target() {
  const port = Number(process.env.OBS_PORT);
  return {
    host: process.env.OBS_HOST || "127.0.0.1",
    port: Number.isInteger(port) && port > 0 ? port : 4090,
  };
}

// POST one envelope to the collector. Resolves ALWAYS (never rejects): on the
// end of the response, on any socket error (ECONNREFUSED when the collector is
// down), or on timeout. The collector requires a loopback Host header (421
// otherwise) and validates/redacts leniently on its own post-ack path.
export function postEnvelope(envelope, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let body;
    try {
      body = JSON.stringify(envelope);
    } catch {
      return resolve();
    }
    const headers = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      Host: "127.0.0.1",
    };
    if (process.env.OBS_TOKEN) headers.Authorization = `Bearer ${process.env.OBS_TOKEN}`;
    const { host, port } = target();
    const req = http.request(
      { host, port, path: "/events", method: "POST", headers, timeout: timeoutMs },
      (res) => {
        res.resume();
        res.on("end", resolve);
        res.on("error", resolve);
      },
    );
    req.on("error", resolve); // ECONNREFUSED (collector down) etc. — swallow
    req.on("timeout", () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

/**
 * Emit one DbQuery event for a completed query execution (design §8 / #87).
 * `record` is the same object handed to the audit log
 * ({ alias, tool, sql, elapsedMs, rowCount, truncated, oraError }). Returns a
 * promise that ALWAYS resolves; callers fire-and-forget it (do not await) so a
 * slow/absent collector can never delay the query response. The audit record
 * and this event share one call site — one event per SQL execution, `tool`
 * distinguishes run_query from describe_table/list_tables catalog reads.
 */
export function emitDbQuery(record, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const envelope = {
      source_app: process.env.OBS_SOURCE_APP || "agent-db-plugin",
      session_id: process.env.OBS_SESSION_ID || "agent-db",
      hook_event_type: "DbQuery",
      tool_name: record.tool, // collector promotes it to a column; harmless
      payload: {
        alias: record.alias,
        tool: record.tool,
        sql: record.sql,
        elapsedMs: record.elapsedMs,
        rowCount: record.rowCount ?? null,
        truncated: record.truncated ?? null,
        oraError: record.oraError ?? null,
      },
      timestamp: Date.now(),
    };
    return postEnvelope(envelope, { timeoutMs });
  } catch {
    return Promise.resolve(); // an emit bug must never affect a query
  }
}
