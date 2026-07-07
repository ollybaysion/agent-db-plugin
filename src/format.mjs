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

const NAIVE_DATE_TYPES = new Set(["DATE", "TIMESTAMP"]);
const TZ_DATE_TYPES = new Set(["TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"]);
const CLOB_TYPES = new Set(["CLOB", "NCLOB"]);
const BLOB_TYPES = new Set(["BLOB"]);

function pad(n) {
  return String(n).padStart(2, "0");
}

// node-oracledb converts DATE/TIMESTAMP (no time zone) into a JS Date using the
// Node process's LOCAL time zone during the driver's own read — not UTC. So
// recovering the original Oracle wall-clock value requires the LOCAL getters,
// not the UTC ones: toISOString() would silently shift the value by whatever
// the process's local UTC offset happens to be. Verified live: under
// TZ=Asia/Seoul, `DATE '2026-07-08'` round-trips to exactly "2026-07-08T00:00:00"
// via local getters, but toISOString() reports "2026-07-07T15:00:00.000Z" — off
// by a full day. Local-getter reconstruction is deployment-TZ-agnostic because
// the driver's encode and this decode always use the same (whatever) local TZ.
function formatNaiveDate(date) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// TIMESTAMP WITH [LOCAL] TIME ZONE: the driver's JS Date already represents the
// correct absolute instant (the original offset was applied during conversion —
// verified live: '09:30 +05:30' → correct UTC 04:00), but a JS Date has no
// per-instance slot to recover the originally-entered offset text itself, so it
// can't be rendered back out. toISOString() (UTC) is the best available
// *correct* rendering; the original offset display is a known, accepted loss.
function formatTzDate(date) {
  return date.toISOString();
}

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / 1024).toFixed(1)}KB`;
}

// Text truncation is measured in CHARACTERS, not bytes — both a CLOB's lob.length
// and a JS string's .length are character counts. Labeling them KB/MB (formatBytes)
// understates multibyte text (a 2,500-char Korean CLOB is ~7KB in UTF-8, not 2.4KB),
// so the note reports a plain char count instead.
function formatCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function truncationNote(totalChars) {
  return `...[truncated, total ${formatCount(totalChars)} chars]`;
}

async function closeLobQuietly(lob) {
  try {
    await lob.close();
  } catch {
    // best-effort — a Lob already closed/invalidated shouldn't fail the request
  }
}

async function shapeCell(value, dbTypeName) {
  if (value === null || value === undefined) return null;

  if (NAIVE_DATE_TYPES.has(dbTypeName)) return formatNaiveDate(value);
  if (TZ_DATE_TYPES.has(dbTypeName)) return formatTzDate(value);

  if (CLOB_TYPES.has(dbTypeName)) {
    const totalChars = value.length; // sync property — no round-trip (§6.2)
    const text = await value.getData(1, CAPS.cell + 1); // server-side partial read
    await closeLobQuietly(value);
    return text.length > CAPS.cell ? text.slice(0, CAPS.cell) + truncationNote(totalChars) : text;
  }

  if (BLOB_TYPES.has(dbTypeName)) {
    const totalBytes = value.length; // never fetch binary content into the response (§6)
    await closeLobQuietly(value);
    return `<BLOB ${formatBytes(totalBytes)}>`;
  }

  if (Buffer.isBuffer(value)) {
    // Inline RAW/LONG RAW — same "never show binary content" rule as BLOB.
    return `<${dbTypeName} ${formatBytes(value.length)}>`;
  }

  if (typeof value === "string" && value.length > CAPS.cell) {
    return value.slice(0, CAPS.cell) + truncationNote(value.length);
  }

  return value;
}

/**
 * Shape a node-oracledb result (metaData + rows, array outFormat) into the
 * response object, applying the row/cell/total caps and type normalization.
 * Async: LOB cells require a round-trip per cell, and design §6.2 requires
 * reading them before the connection is returned to the pool — the caller
 * (executeReadOnly) must await this before its unconditional close().
 */
export async function shapeResult({ metaData, rows, maxRows, elapsedMs }) {
  const columns = metaData.map((col) => ({ name: col.name, type: col.dbTypeName }));

  const rowCapped = rows.length > maxRows;
  const cappedRows = rowCapped ? rows.slice(0, maxRows) : rows;

  const shapedRows = [];
  for (const row of cappedRows) {
    const shapedRow = [];
    for (let i = 0; i < row.length; i++) {
      shapedRow.push(await shapeCell(row[i], metaData[i].dbTypeName));
    }
    shapedRows.push(shapedRow);
  }

  let finalRows = shapedRows;
  let totalCapped = false;
  while (finalRows.length > 1 && JSON.stringify(finalRows).length > CAPS.total) {
    finalRows = finalRows.slice(0, -1);
    totalCapped = true;
  }

  let hint;
  if (rowCapped) {
    hint = `행 ${maxRows}개에서 절단됨. WHERE로 좁히거나 집계(GROUP BY/COUNT)를 사용하세요.`;
  }
  if (totalCapped) {
    const note = `응답 크기 제한으로 ${shapedRows.length}행 중 ${finalRows.length}행만 표시됩니다.`;
    hint = hint ? `${hint} ${note}` : note;
  }

  return {
    columns,
    rows: finalRows,
    rowCount: finalRows.length,
    truncated: rowCapped || totalCapped,
    ...(hint ? { hint } : {}),
    elapsedMs,
  };
}
