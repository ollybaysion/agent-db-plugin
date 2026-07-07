// Audit log. Design: docs/design.md §8 (감사 로그).
//
// One JSONL line per execution at ~/.oracle-mcp/audit/audit-YYYY-MM-DD.jsonl:
//   { ts, alias, tool, sql, elapsedMs, rowCount, truncated, oraError }
// Bind values are NOT logged. Caveat (§8): binds are only *recommended*, so an
// agent that inlines a literal (WHERE ssn='...') still writes it into `sql`.
// Treat the audit file as potentially sensitive → 0600 perms.
//
// fail-open: a logging failure must NEVER block a query (stderr warning only).

/**
 * Append one audit record. Swallows its own errors (fail-open).
 * TODO(impl): daily file path, mkdir -p audit dir with 0600, JSONL append.
 */
export async function auditLog(/* record */) {
  // intentionally best-effort; never throw
}
