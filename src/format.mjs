// Result serialization + output caps. Design: docs/design.md §6, §6.2.
//
// Token-frugal shape: { columns, rows, rowCount, truncated, hint?, elapsedMs }.
// columns carries per-column type metadata so a consumer knows a string cell is
// actually a NUMBER (§6.2). All caps announce truncation — silent truncation
// makes the agent reason over partial data as if complete (§6).
//
// Caps (design §6):
//   row    default 100 / hard 1000  — fetch maxRows+1, truncate to maxRows,
//                                      flag truncated (verified §11-5/5b).
//   cell   2000 chars                — VARCHAR2 sliced; LOB via lob.getData(1, CAP+1)
//                                      server-side partial read (verified §12-10).
//                                      NEVER fetchAsString a LOB (memory bomb §12-2).
//   total  30000 chars               — trim rows, report "N행 중 M행".
//   time   callTimeout               — enforced at connection layer (pool.mjs).

export const CAPS = { rowDefault: 100, rowHard: 1000, cell: 2000, total: 30000 };

/**
 * Shape a node-oracledb result (metaData + rows) into the response object,
 * applying cell + total caps and the row-truncation flag.
 * TODO(impl): per-cell LOB handling (getData(1, CAP+1) + lob.length for the
 * "…[truncated, total NkB]" note; read BEFORE the connection is returned to the
 * pool — LOBs are connection-bound, §6.2), NUMBER-as-string column typing.
 */
export function shapeResult(/* { metaData, rows, maxRows, elapsedMs } */) {
  throw new Error("NotImplemented: shapeResult (skeleton) — see docs/design.md §6");
}
