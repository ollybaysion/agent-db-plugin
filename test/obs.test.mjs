import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { emitDbQuery } from "../src/obs.mjs";
import { executeReadOnly } from "../src/readonly.mjs";

// obs.mjs is the SENDING side of #87. Pure unit tests: emitDbQuery is pointed at
// a stub HTTP server via OBS_PORT (read at call time), and the fire-and-forget /
// latency-isolation contract is verified by injecting a throwing / hanging emit
// into executeReadOnly. No real collector, no DB.

function stubCollector() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(body);
      } catch {
        /* leave null */
      }
      received.push({ headers: req.headers, json });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
  });
  return { server, received };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function withPort(port, fn) {
  const prev = process.env.OBS_PORT;
  process.env.OBS_PORT = String(port);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.OBS_PORT;
    else process.env.OBS_PORT = prev;
  }
}

const fakeConnection = {
  rollback: async () => {},
  execute: async () => ({ metaData: [], rows: [] }),
  close: async () => {},
};
const okShape = () => ({ columns: [], rows: [], rowCount: 0, truncated: false, elapsedMs: 0 });

test("emitDbQuery posts a well-formed DbQuery envelope with a loopback Host header", async () => {
  const { server, received } = stubCollector();
  const port = await listen(server);
  try {
    await withPort(port, () =>
      emitDbQuery({
        alias: "erp-prod",
        tool: "run_query",
        sql: "SELECT * FROM gl_accounts WHERE id = 1",
        elapsedMs: 42,
        rowCount: 7,
        truncated: false,
        oraError: null,
      }),
    );
    assert.equal(received.length, 1);
    const env = received[0].json;
    assert.equal(env.hook_event_type, "DbQuery");
    assert.equal(env.tool_name, "run_query");
    assert.equal(env.source_app, "agent-db-plugin");
    assert.equal(received[0].headers.host, "127.0.0.1"); // loopback Host, not the ephemeral test host
    assert.equal(env.payload.alias, "erp-prod");
    assert.equal(env.payload.sql, "SELECT * FROM gl_accounts WHERE id = 1"); // verbatim, no masking (#87)
    assert.equal(env.payload.elapsedMs, 42);
    assert.equal(env.payload.rowCount, 7);
    assert.equal(env.payload.truncated, false);
    assert.equal(env.payload.oraError, null);
    assert.equal(typeof env.timestamp, "number");
  } finally {
    await close(server);
  }
});

test("emitDbQuery resolves (never throws) when the collector is down", async () => {
  // Bind then close to obtain a port with nothing listening → ECONNREFUSED.
  const dead = http.createServer();
  const port = await listen(dead);
  await close(dead);
  await withPort(port, async () => {
    await emitDbQuery({ alias: "a", tool: "run_query", sql: "SELECT 1 FROM dual", elapsedMs: 1 });
    assert.ok(true); // reaching here without throwing IS the assertion
  });
});

test("executeReadOnly returns its outcome even when emit throws synchronously", async () => {
  const result = await executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT 1 FROM dual",
    tool: "run_query",
    getConnection: async () => fakeConnection,
    shapeResult: okShape,
    audit: async () => {},
    emit: () => {
      throw new Error("emit boom");
    },
  });
  assert.equal(result.ok, true);
});

test("executeReadOnly resolves promptly when emit hangs (fire-and-forget latency isolation)", async () => {
  const run = executeReadOnly({
    alias: "a",
    aliasConfig: {},
    sql: "SELECT 1 FROM dual",
    tool: "run_query",
    getConnection: async () => fakeConnection,
    shapeResult: okShape,
    audit: async () => {},
    emit: () => new Promise(() => {}), // never resolves — must not block the query
  });
  const guard = new Promise((_, reject) => {
    const t = setTimeout(() => reject(new Error("executeReadOnly blocked on emit")), 1000);
    t.unref();
  });
  const result = await Promise.race([run, guard]);
  assert.equal(result.ok, true);
});
