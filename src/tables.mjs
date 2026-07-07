// Table access control glob matching. Design: docs/design.md §5 (테이블 접근
// 제한 — 수준 1+2), §12-4. Issue #7.
//
// Two independent enforcement levels share the same glob syntax
// (`"SCHEMA_PATTERN.TABLE_PATTERN"`, `*` wildcards, case-insensitive) but apply
// it very differently:
//
//   Level 1 (list_tables/describe_table, tables.allow) — fully enforced. The
//   catalog rows these tools already fetched are filtered by owner+table
//   against the allow patterns; there's no code path that returns a row
//   without passing through this filter (§5 "완전 강제").
//
//   Level 2 (run_query, tables.deny) — best-effort. There's no structured
//   owner/table to check here, only the raw SQL text the agent wrote, so this
//   scans for the pattern's table-name half as a whole-identifier match
//   anywhere in the statement. A view/synonym wrapping the real table
//   (`SELECT * FROM emp_pay_synonym`) passes the scan untouched — documented
//   and accepted (§5 "준강제"), not a bug to fix here.
//
// Both empty/undefined pattern lists mean "no restriction" — allow/deny are
// opt-in per connection (§5 "커넥션별 선택 설정").

const IDENT_CHARS = "A-Za-z0-9_$#"; // Oracle unquoted-identifier charset

function globSegmentToRegExpSource(segment) {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return escaped.replace(/\*/g, `[${IDENT_CHARS}]*`);
}

function splitPattern(pattern) {
  const dot = pattern.indexOf(".");
  if (dot === -1) return { ownerPattern: "*", tablePattern: pattern };
  return { ownerPattern: pattern.slice(0, dot), tablePattern: pattern.slice(dot + 1) };
}

/** Exact owner+table glob match, e.g. "ERP.GL_*" vs (owner="ERP", table="GL_ACCOUNTS"). */
export function matchesQualifiedName(owner, table, pattern) {
  const { ownerPattern, tablePattern } = splitPattern(pattern);
  const ownerRe = new RegExp(`^${globSegmentToRegExpSource(ownerPattern)}$`, "i");
  const tableRe = new RegExp(`^${globSegmentToRegExpSource(tablePattern)}$`, "i");
  return ownerRe.test(owner) && tableRe.test(table);
}

/** design §5 수준1 (describe_table side). No allow list configured → unrestricted. */
export function isTableAllowed(owner, table, allowPatterns) {
  if (!Array.isArray(allowPatterns) || allowPatterns.length === 0) return true;
  return allowPatterns.some((pattern) => matchesQualifiedName(owner, table, pattern));
}

/** design §5 수준1 (list_tables side). Rows are raw catalog objects with OWNER/TABLE_NAME keys. */
export function filterAllowedTables(rows, allowPatterns) {
  if (!Array.isArray(allowPatterns) || allowPatterns.length === 0) return rows;
  return rows.filter((row) => isTableAllowed(row.OWNER, row.TABLE_NAME, allowPatterns));
}

// Whole-identifier match anywhere in free text. Lookaround (not native `\b`,
// which is \w-only) so `$`/`#` — legal in Oracle identifiers but not in \w —
// don't create a false boundary mid-name. Quoted identifiers (`"HR_SALARY"`)
// still match without stripping the quotes first: `"` isn't an identifier
// char either, so it already satisfies the boundary on both sides.
function wholeIdentifierRegExp(tablePattern) {
  const src = globSegmentToRegExpSource(tablePattern);
  return new RegExp(`(?<![${IDENT_CHARS}])${src}(?![${IDENT_CHARS}])`, "i");
}

/**
 * design §5 수준2 (run_query side). Scans raw SQL text for any deny pattern's
 * table-name half — the schema half is dropped because free text has no
 * reliable owner qualifier to check it against (an unqualified `FROM
 * HR_SALARY` carries no schema at all). Returns {ok:true} or
 * {ok:false, reason}; never throws.
 *
 * This runs inside executeReadOnly (§5 "우회 경로 없음" — deny must live in
 * the single choke point), so it also sees schema.mjs's own fixed catalog
 * queries, not just agent-written run_query SQL. A deny pattern whose
 * table-name half happens to glob-match an `ALL_*` catalog view (e.g. an
 * overly broad `"*.ALL_*"`) would therefore also block list_tables/
 * describe_table — an admin misconfiguration to avoid, not something this
 * module tries to distinguish.
 */
export function scanForDeniedTables(sql, denyPatterns) {
  if (!Array.isArray(denyPatterns) || denyPatterns.length === 0) return { ok: true };
  for (const pattern of denyPatterns) {
    const { tablePattern } = splitPattern(pattern);
    const match = wholeIdentifierRegExp(tablePattern).exec(sql);
    if (match) {
      return {
        ok: false,
        reason:
          `허용되지 않은 테이블입니다: ${match[0]} (deny 패턴 ${pattern}과 일치). ` +
          `뷰/시노님을 통한 우회는 차단되지 않습니다.`,
      };
    }
  }
  return { ok: true };
}
