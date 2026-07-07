// Audit log. Design: docs/design.md §8 (감사 로그).
//
// One JSONL line per execution at ~/.oracle-mcp/audit/audit-YYYY-MM-DD.jsonl:
//   { ts, alias, tool, sql, elapsedMs, rowCount, truncated, oraError }
// Bind values are NOT logged. Caveat (§8/§12-8): binds are only *recommended*,
// so an agent that inlines a literal (WHERE ssn='...') still writes it into
// `sql` — the audit file can be sensitive, hence 0600 perms on the file and
// 0700 on its directory.
//
// fail-open: a logging failure must NEVER block a query (stderr warning only,
// never throws).

import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUDIT_DIR = join(homedir(), ".oracle-mcp", "audit");

function dailyFilePath(dir, now) {
  const iso = now.toISOString().slice(0, 10); // YYYY-MM-DD
  return join(dir, `audit-${iso}.jsonl`);
}

/**
 * Append one audit record. Swallows its own errors (fail-open) — permissions,
 * a missing home dir, or a full disk must never block the query the record
 * describes. `dir`/`now` are overridable for testing without touching the
 * real ~/.oracle-mcp/audit (same seam as pool.mjs/readonly.mjs's injectable
 * defaults).
 */
export async function auditLog(record, { dir = AUDIT_DIR, now = new Date() } = {}) {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: now.toISOString(),
      alias: record.alias,
      tool: record.tool,
      sql: record.sql,
      elapsedMs: record.elapsedMs,
      rowCount: record.rowCount ?? null,
      truncated: record.truncated ?? null,
      oraError: record.oraError ?? null,
    });
    // mode only takes effect when the file is created, not on an existing one —
    // fine here since every process/day starts a fresh file (§8 "일 단위 파일").
    await appendFile(dailyFilePath(dir, now), line + "\n", { mode: 0o600 });
  } catch (err) {
    console.error(`[agent-db-plugin] 감사 로그 기록 실패 (fail-open, 쿼리는 계속 진행): ${err.message}`);
  }
}
