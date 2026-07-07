import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeResult, CAPS } from "../src/format.mjs";

function metaCol(name, type) {
  return { name, dbTypeName: type };
}

// Fakes node-oracledb's Lob API just enough for shapeResult's cell logic:
// getData(1-based offset, amount) and an async close(). `text` may be a
// string (CLOB) — length/slicing work the same way for both in these tests.
// `getDataCalls` records the (start, amount) of each read so a test can assert
// the read was BOUNDED — this is the real §12-2 memory-bomb guard (an integration
// heap-delta check can't catch it: a whole-materialize allocation is transient and
// GC-eligible before heapUsed is next sampled, so it never shows up).
function fakeLob(text, closeCalls, getDataCalls) {
  return {
    length: text.length,
    getData: async (start, amount) => {
      getDataCalls?.push({ start, amount });
      return text.slice(start - 1, start - 1 + amount);
    },
    close: async () => {
      closeCalls?.push("close");
    },
  };
}

test("shapeResult: columns carry {name, type} from metaData", async () => {
  const result = await shapeResult({
    metaData: [metaCol("ID", "NUMBER"), metaCol("NAME", "VARCHAR2")],
    rows: [["1", "alpha"]],
    maxRows: 100,
    elapsedMs: 5,
  });
  assert.deepEqual(result.columns, [
    { name: "ID", type: "NUMBER" },
    { name: "NAME", type: "VARCHAR2" },
  ]);
  assert.equal(result.elapsedMs, 5);
});

test("shapeResult: row cap — maxRows+1 fetched, truncated to maxRows with a hint", async () => {
  const rows = [["1"], ["2"], ["3"]]; // 3 rows fetched for maxRows=2 (the +1 truncation-detection row)
  const result = await shapeResult({
    metaData: [metaCol("ID", "NUMBER")],
    rows,
    maxRows: 2,
    elapsedMs: 1,
  });
  assert.equal(result.truncated, true);
  assert.equal(result.rowCount, 2);
  assert.deepEqual(result.rows, [["1"], ["2"]]);
  assert.match(result.hint, /행 2개에서 절단/);
});

test("shapeResult: no row cap when rows.length === maxRows exactly (no false positive, §11-5b)", async () => {
  const rows = [["1"], ["2"]];
  const result = await shapeResult({
    metaData: [metaCol("ID", "NUMBER")],
    rows,
    maxRows: 2,
    elapsedMs: 1,
  });
  assert.equal(result.truncated, false);
  assert.equal(result.rowCount, 2);
  assert.equal(result.hint, undefined);
});

test("shapeResult: a long VARCHAR2 cell is sliced at the cell cap with a truncation note", async () => {
  const long = "x".repeat(CAPS.cell + 500);
  const result = await shapeResult({
    metaData: [metaCol("NAME", "VARCHAR2")],
    rows: [[long]],
    maxRows: 100,
    elapsedMs: 1,
  });
  const cell = result.rows[0][0];
  assert.equal(cell.startsWith("x".repeat(CAPS.cell)), true);
  assert.match(cell, /\[truncated, total/);
});

test("shapeResult: a short VARCHAR2 cell passes through untouched", async () => {
  const result = await shapeResult({
    metaData: [metaCol("NAME", "VARCHAR2")],
    rows: [["short"]],
    maxRows: 100,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "short");
});

test("shapeResult: DATE/TIMESTAMP (no tz) format via local getters, not toISOString", async () => {
  // multi-arg Date constructor sets fields via the LOCAL calendar by definition,
  // so this is a self-consistent check regardless of the test runner's TZ.
  const d = new Date(2026, 6, 8, 9, 30, 0); // month is 0-based → July
  const result = await shapeResult({
    metaData: [metaCol("D", "DATE"), metaCol("TS", "TIMESTAMP")],
    rows: [[d, d]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "2026-07-08T09:30:00");
  assert.equal(result.rows[0][1], "2026-07-08T09:30:00");
});

test("shapeResult: TIMESTAMP WITH TIME ZONE formats as UTC ISO (toISOString)", async () => {
  const d = new Date(Date.UTC(2026, 6, 8, 4, 0, 0)); // absolute instant
  const result = await shapeResult({
    metaData: [metaCol("TSTZ", "TIMESTAMP WITH TIME ZONE")],
    rows: [[d]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "2026-07-08T04:00:00.000Z");
});

test("shapeResult: null cells pass through as null regardless of column type", async () => {
  const result = await shapeResult({
    metaData: [metaCol("D", "DATE"), metaCol("DOC", "CLOB")],
    rows: [[null, null]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.deepEqual(result.rows[0], [null, null]);
});

test("shapeResult: CLOB is partially read via a BOUNDED getData(1, cap+1) — never whole (§12-2) — truncated with a note, and closed", async () => {
  const closeCalls = [];
  const getDataCalls = [];
  const big = "c".repeat(CAPS.cell + 1_000_000); // a "huge" CLOB
  const result = await shapeResult({
    metaData: [metaCol("DOC", "CLOB")],
    rows: [[fakeLob(big, closeCalls, getDataCalls)]],
    maxRows: 10,
    elapsedMs: 1,
  });
  const cell = result.rows[0][0];
  assert.equal(cell.startsWith("c".repeat(CAPS.cell)), true);
  assert.match(cell, /\[truncated, total/);
  assert.deepEqual(closeCalls, ["close"]);
  // The memory-bomb guard: exactly one read, bounded to cap+1, regardless of the
  // CLOB's real size. A regression to getData(1, lob.length) or fetchAsString would
  // request (or materialize) the whole megabyte-plus and this fails.
  assert.deepEqual(getDataCalls, [{ start: 1, amount: CAPS.cell + 1 }]);
});

test("shapeResult: a CLOB shorter than the cap is returned whole, no truncation note", async () => {
  const result = await shapeResult({
    metaData: [metaCol("DOC", "CLOB")],
    rows: [[fakeLob("short clob")]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "short clob");
});

test("shapeResult: BLOB never surfaces content — a size placeholder only, and is closed without ever reading data", async () => {
  const closeCalls = [];
  let getDataCalled = false;
  const lob = {
    length: 1_200_000,
    getData: async () => {
      getDataCalled = true;
      return Buffer.alloc(0);
    },
    close: async () => closeCalls.push("close"),
  };
  const result = await shapeResult({
    metaData: [metaCol("BIN", "BLOB")],
    rows: [[lob]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "<BLOB 1.1MB>");
  assert.equal(getDataCalled, false);
  assert.deepEqual(closeCalls, ["close"]);
});

test("shapeResult: an inline Buffer (RAW) is shown as a size placeholder, not raw bytes", async () => {
  const result = await shapeResult({
    metaData: [metaCol("R", "RAW")],
    rows: [[Buffer.alloc(10)]],
    maxRows: 10,
    elapsedMs: 1,
  });
  assert.equal(result.rows[0][0], "<RAW 0.0KB>");
});

test("shapeResult: total-size cap trims trailing rows and reports N-of-M, independent of the row cap", async () => {
  const wideRow = ["x".repeat(2000)];
  const rows = Array.from({ length: 20 }, () => wideRow); // 20 * ~2000 chars ≈ way over CAPS.total
  const result = await shapeResult({
    metaData: [metaCol("NAME", "VARCHAR2")],
    rows,
    maxRows: 100, // well above rows.length — row cap does NOT fire
    elapsedMs: 1,
  });
  assert.equal(result.truncated, true);
  assert.ok(result.rows.length < 20);
  assert.match(result.hint, /행 중 \d+행만 표시/);
  assert.ok(JSON.stringify(result.rows).length <= CAPS.total);
});
