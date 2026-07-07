import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditLog } from "../src/audit.mjs";

// Pure unit tests against a scratch directory (never ~/.oracle-mcp/audit) —
// design §8 "Done when": line format, binds excluded, fail-open on write
// failure, 0700/0600 perms, daily filename. No DB/network involved.

async function withTmpDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agent-db-plugin-audit-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(dir, dateIso) {
  const content = await readFile(join(dir, `audit-${dateIso}.jsonl`), "utf8");
  return content.trim().split("\n").map((line) => JSON.parse(line));
}

test("auditLog: writes one JSONL line with the expected fields", async () => {
  await withTmpDir(async (dir) => {
    const now = new Date("2026-07-08T03:04:05.000Z");
    await auditLog(
      {
        alias: "erp-prod",
        tool: "run_query",
        sql: "SELECT 1 FROM dual",
        elapsedMs: 12,
        rowCount: 1,
        truncated: false,
      },
      { dir, now },
    );

    const [line] = await readLines(dir, "2026-07-08");
    assert.deepEqual(line, {
      ts: "2026-07-08T03:04:05.000Z",
      alias: "erp-prod",
      tool: "run_query",
      sql: "SELECT 1 FROM dual",
      elapsedMs: 12,
      rowCount: 1,
      truncated: false,
      oraError: null,
    });
  });
});

test("auditLog: an error outcome records oraError and null rowCount/truncated", async () => {
  await withTmpDir(async (dir) => {
    const now = new Date("2026-07-08T03:04:05.000Z");
    await auditLog(
      {
        alias: "erp-prod",
        tool: "run_query",
        sql: "DROP TABLE t",
        elapsedMs: 1,
        rowCount: null,
        truncated: null,
        oraError: "SELECT/WITH 문만 실행할 수 있습니다 (read-only). 받은 첫 키워드: DROP",
      },
      { dir, now },
    );

    const [line] = await readLines(dir, "2026-07-08");
    assert.equal(line.rowCount, null);
    assert.equal(line.truncated, null);
    assert.match(line.oraError, /DROP/);
  });
});

test("auditLog: never writes bind values, even if the caller passes them through", async () => {
  await withTmpDir(async (dir) => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    await auditLog(
      {
        alias: "a",
        tool: "run_query",
        sql: "SELECT * FROM t WHERE ssn = :ssn",
        binds: { ssn: "123-45-6789" }, // not a real field of the record shape
        elapsedMs: 1,
        rowCount: 1,
        truncated: false,
      },
      { dir, now },
    );

    const [line] = await readLines(dir, "2026-07-08");
    assert.equal(line.binds, undefined);
    assert.equal(JSON.stringify(line).includes("123-45-6789"), false);
  });
});

test("auditLog: appends multiple executions as separate lines in the same daily file", async () => {
  await withTmpDir(async (dir) => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    await auditLog({ alias: "a", tool: "run_query", sql: "SELECT 1 FROM dual", elapsedMs: 1 }, { dir, now });
    await auditLog({ alias: "a", tool: "run_query", sql: "SELECT 2 FROM dual", elapsedMs: 2 }, { dir, now });

    const lines = await readLines(dir, "2026-07-08");
    assert.equal(lines.length, 2);
    assert.equal(lines[0].sql, "SELECT 1 FROM dual");
    assert.equal(lines[1].sql, "SELECT 2 FROM dual");
  });
});

test("auditLog: daily filename is derived from `now`, not the system clock", async () => {
  await withTmpDir(async (dir) => {
    await auditLog(
      { alias: "a", tool: "run_query", sql: "SELECT 1 FROM dual", elapsedMs: 1 },
      { dir, now: new Date("2030-01-15T12:00:00.000Z") },
    );
    const content = await readFile(join(dir, "audit-2030-01-15.jsonl"), "utf8");
    assert.match(content, /SELECT 1 FROM dual/);
  });
});

test("auditLog: creates the audit directory 0700 and the file 0600 (§8 sensitive-file posture)", async () => {
  await withTmpDir(async (parent) => {
    const dir = join(parent, "audit"); // let auditLog itself mkdir -p this
    const now = new Date("2026-07-08T00:00:00.000Z");
    await auditLog({ alias: "a", tool: "run_query", sql: "SELECT 1 FROM dual", elapsedMs: 1 }, { dir, now });

    const dirMode = (await stat(dir)).mode & 0o777;
    const fileMode = (await stat(join(dir, "audit-2026-07-08.jsonl"))).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
  });
});

test("auditLog: fail-open — a write failure is swallowed (never throws) and warns to stderr", async () => {
  await withTmpDir(async (parent) => {
    // A regular file where auditLog expects a directory: mkdir(dir, {recursive})
    // fails (ENOTDIR/EEXIST depending on platform) — a portable way to force
    // the failure path without relying on OS permission bits.
    const blockedDir = join(parent, "not-a-directory");
    await writeFile(blockedDir, "x");

    const originalConsoleError = console.error;
    const warnings = [];
    console.error = (...args) => warnings.push(args.join(" "));
    try {
      await assert.doesNotReject(() =>
        auditLog(
          { alias: "a", tool: "run_query", sql: "SELECT 1 FROM dual", elapsedMs: 1 },
          { dir: blockedDir, now: new Date("2026-07-08T00:00:00.000Z") },
        ),
      );
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /감사 로그 기록 실패/);
  });
});
