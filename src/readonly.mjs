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

import oracledb from "oracledb";

import { getConnection as checkoutConnection } from "./pool.mjs";
import { shapeResult as shapeResultImpl } from "./format.mjs";
import { HARD_MAX_ROWS } from "./config.mjs";
import { scanForDeniedTables } from "./tables.mjs";

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

const DEFAULT_MAX_ROWS = 100;

/**
 * The single execution path (design §5 시퀀스) — every query goes through here,
 * so L2/deny/read-only/caps can't be bypassed by a different code path.
 *
 * `getConnection`/`shapeResult` are injectable (default to the real pool.mjs /
 * format.mjs implementations) so this can be unit-tested against a fake
 * connection: ESM named exports can't be monkey-patched the way the oracledb
 * CJS object can be (see pool.test.mjs), so a plain default-parameter seam
 * stands in for that.
 */
export async function executeReadOnly({
  alias,
  aliasConfig,
  sql,
  binds = {},
  maxRows,
  getConnection = checkoutConnection,
  shapeResult = shapeResultImpl,
} = {}) {
  const gate = validateReadOnlyStatement(sql);
  if (!gate.ok) return { ok: false, error: gate.reason };

  const denyGate = scanForDeniedTables(sql, aliasConfig?.tables?.deny);
  if (!denyGate.ok) return { ok: false, error: denyGate.reason };

  const effectiveMaxRows = Math.min(
    maxRows ?? aliasConfig?.limits?.defaultMaxRows ?? DEFAULT_MAX_ROWS,
    HARD_MAX_ROWS,
  );

  let connection;
  try {
    connection = await getConnection(alias, aliasConfig);
    await connection.rollback(); // §12-3: checkout-time cleanup of a dirty pooled connection
    await connection.execute("SET TRANSACTION READ ONLY");

    const startedAt = Date.now();
    const result = await connection.execute(sql, binds, {
      maxRows: effectiveMaxRows + 1, // +1 for truncation detection (§6)
      outFormat: oracledb.OUT_FORMAT_ARRAY,
    });
    const elapsedMs = Date.now() - startedAt;

    return {
      ok: true,
      ...(await shapeResult({
        metaData: result.metaData,
        rows: result.rows,
        maxRows: effectiveMaxRows,
        elapsedMs,
      })),
    };
  } catch (err) {
    return { ok: false, error: err.message }; // ORA code+message verbatim (§8)
  } finally {
    if (connection) {
      await connection.rollback().catch(() => {}); // unconditional — read-only txn/lock cleanup
      await connection.close().catch(() => {});
    }
  }
}
