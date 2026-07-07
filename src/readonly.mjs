// Read-only enforcement: the single choke point every query passes through.
// Design: docs/design.md §5 (4-layer defense) and §5 실행 시퀀스.
//
// Layers:
//   L1  every query runs inside `SET TRANSACTION READ ONLY` → DB rejects DML /
//       FOR UPDATE with ORA-01456 (verified §11-1).
//   L2  statement whitelist: after stripping comments/whitespace the FIRST keyword
//       must be SELECT or WITH (and NOT `WITH FUNCTION`/`WITH PROCEDURE`). This is
//       the ONLY guard against DDL, LOCK TABLE, and PL/SQL blocks — L1 lets those
//       through (verified §11-2, §12-5). Implemented below (pure, unit-tested).
//   L3  autocommit off + no commit code path + unconditional rollback.
//   L4  node-oracledb runs exactly one statement per execute() (verified §11-4).

// Statements whose first keyword we accept. Positive match → DDL/DML/PLSQL/LOCK
// are all rejected by construction (design §5 "L2 설계 원칙").
const ALLOWED_FIRST_KEYWORDS = new Set(["SELECT", "WITH"]);

/**
 * Strip SQL comments so the first real keyword can be read.
 * Handles -- line comments and block comments. NOTE: this is a
 * first-cut stripper; the full test matrix (design §9 단위 / §5 예외 cases:
 * string literals containing comment delimiters, WITH FUNCTION, leading `(`)
 * lands with implementation. Do not treat as hardened yet.
 */
function stripComments(sql) {
  return sql
    .replace(/--[^\n]*/g, " ") // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " "); // block comments
}

/**
 * L2 gate. Returns { ok: true } or { ok: false, reason } — never throws.
 * The reason string is surfaced to the agent verbatim (design §8).
 */
export function validateReadOnlyStatement(sql) {
  if (typeof sql !== "string" || !sql.trim()) {
    return { ok: false, reason: "빈 SQL입니다." };
  }
  const cleaned = stripComments(sql).replace(/^[\s(]+/, ""); // tolerate leading `(`
  const m = cleaned.match(/^([a-zA-Z]+)/);
  const first = m ? m[1].toUpperCase() : "";

  if (!ALLOWED_FIRST_KEYWORDS.has(first)) {
    return {
      ok: false,
      reason: `SELECT/WITH 문만 실행할 수 있습니다 (read-only). 받은 첫 키워드: ${first || "?"}`,
    };
  }
  // WITH FUNCTION / WITH PROCEDURE: inline PL/SQL can write via AUTONOMOUS_TRANSACTION
  // (design §5 예외, verified §11-3). Reject.
  if (first === "WITH") {
    const afterWith = cleaned.replace(/^WITH\s+/i, "").match(/^([a-zA-Z]+)/);
    const next = afterWith ? afterWith[1].toUpperCase() : "";
    if (next === "FUNCTION" || next === "PROCEDURE") {
      return { ok: false, reason: "WITH FUNCTION/PROCEDURE 는 허용되지 않습니다 (read-only)." };
    }
  }
  return { ok: true };
}

/**
 * The single execution path. TODO(impl): wire the §5 sequence —
 *   validateReadOnlyStatement → deny-scan → getConnection → rollback →
 *   callTimeout → SET TRANSACTION READ ONLY → execute(maxRows+1) →
 *   cap/serialize (format.mjs) → rollback → close. Audit on the way out.
 * Kept as a stub in the skeleton; implementation later.
 */
export async function executeReadOnly(/* { pool, sql, binds, limits } */) {
  throw new Error("NotImplemented: executeReadOnly (skeleton) — see docs/design.md §5");
}
