import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import oracledb from "oracledb";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Bundle boot + real thin-mode connect, through the actual esbuild artifact
// (design §9-6 — "the one unverified core assumption"): every other test in
// this suite exercises src/*.mjs directly or via node:test's module loader,
// never the bundled dist/server.mjs a plugin install actually runs. esbuild's
// single-file bundle could in principle break oracledb's internal thin-mode
// wiring even though every unit/integration test against the source passes —
// this is the one test that would catch that.
//
// Runs against the local `oracle-mcp-test` Docker container when reachable;
// otherwise skipped (Docker/CI wiring is this same issue, #9). Never touches
// the developer's real ~/.oracle-mcp/connections.json — ORACLE_MCP_CONFIG_PATH
// (server.mjs) points the spawned bundle at a throwaway temp file instead.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST_SERVER = join(REPO_ROOT, "dist", "server.mjs");

const TEST_CONNECT_STRING = process.env.ORACLE_TEST_CONNECT_STRING ?? "localhost:1521/FREEPDB1";
const TEST_USER = process.env.ORACLE_TEST_USER ?? "testuser";
const TEST_PASSWORD = process.env.ORACLE_TEST_PASSWORD ?? "testpw";
const PASSWORD_ENV = "TEST_ORA_PW_BUNDLE_INTEGRATION";
const ALIAS = "bundle-it";

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

let tmpConfigDir;
let tmpConfigPath;

before(async () => {
  if (!dbReachable) return;
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  tmpConfigDir = await mkdtemp(join(tmpdir(), "agent-db-plugin-bundle-it-"));
  tmpConfigPath = join(tmpConfigDir, "connections.json");
  await writeFile(
    tmpConfigPath,
    JSON.stringify({
      connections: {
        [ALIAS]: { connectString: TEST_CONNECT_STRING, user: TEST_USER, passwordEnv: PASSWORD_ENV },
      },
    }),
  );
});

after(async () => {
  if (!dbReachable) return;
  if (tmpConfigDir) await rm(tmpConfigDir, { recursive: true, force: true });
});

async function connectToBundle() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DIST_SERVER],
    env: {
      ...process.env,
      ORACLE_MCP_CONFIG_PATH: tmpConfigPath,
      [PASSWORD_ENV]: TEST_PASSWORD,
    },
  });
  const client = new Client({ name: "bundle-integration-test", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

test("dist/server.mjs boots, speaks MCP over stdio, and lists the expected tools", { skip }, async () => {
  const client = await connectToBundle();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ["describe_table", "list_connections", "list_tables", "run_query"]);
  } finally {
    await client.close();
  }
});

test("dist/server.mjs: run_query round-trips a real thin-mode connection (design §9-6)", { skip }, async () => {
  const client = await connectToBundle();
  try {
    const result = await client.callTool({
      name: "run_query",
      arguments: { db: ALIAS, sql: "SELECT 1 AS one FROM dual" },
    });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.rows, [["1"]]); // fetchAsString(NUMBER) — same as source (§6.2)
  } finally {
    await client.close();
  }
});

test("dist/server.mjs: read-only enforcement (L2) survives the bundle — a DDL statement is still rejected", { skip }, async () => {
  const client = await connectToBundle();
  try {
    const result = await client.callTool({
      name: "run_query",
      arguments: { db: ALIAS, sql: "CREATE TABLE bundle_it_escape (x NUMBER)" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /SELECT\/WITH/);
  } finally {
    await client.close();
  }
});
