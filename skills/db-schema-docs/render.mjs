// db-schema-docs renderer. Turns a describe_table result into a keyword-docs
// db-schema Markdown doc, and upserts the matching index entry.
//
// The generated doc emits the SAME slots as claude-hooks' db-schema template
// (테이블명 / 용도 / 컬럼표 / PK / FK·관계 / 인덱스 / 대표쿼리 / 마이그레이션 주의) —
// but it is generated, not hand-filled, so structural slots stay in sync with
// the live catalog while human-authored meaning survives regeneration.
//
// Two slot classes, split by HTML-comment markers (invisible in rendered MD):
//   auto   — 컬럼표 구조(명/타입/널/기본값) · PK · 인덱스 · FK/관계. Fully
//            re-derived from describe_table on every run.
//   manual — 용도 · (컬럼별) 설명 · 대표쿼리 · 마이그레이션 주의. Written by a
//            human/agent; PRESERVED verbatim across regeneration.
//
// Regeneration merge (renderDoc with `existing`):
//   - manual regions (purpose/queries/migration): existing text kept as-is.
//   - column 설명 cells: preserved PER COLUMN NAME — a fresh structural row gets
//     back the human description that was on the row of the same name. New
//     columns seed from the Oracle column comment (or a {{설명}} scaffold);
//     dropped columns disappear.
//   - a pre-existing file WITHOUT our markers is treated as hand-authored and is
//     NOT overwritten (status "conflict") — never clobber someone's manual doc.
//
// Path convention (verified against the provider's docBaseFor): the index lives
// at .claude/context-docs.db-schema.json, and because it sits in a `.claude`
// dir, a doc `path` resolves against the REPO ROOT — so the entry path is the
// repo-root-relative `.claude/docs/db/<table>.md`.

const SCAFFOLD = {
  purpose: "{{용도 한 줄 — 무엇을 저장하는가}}. {{쓰기 주체 → 읽기 주체}}",
  queries: "{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}",
  migration: "{{선택 — 변경 이력, 함부로 바꾸면 안 되는 컬럼과 이유}}",
  cell: "{{설명}}",
};

// A column count above this makes the injected slice mostly a giant table, so we
// suggest precision 0.5 (link-only) — matches the template's guidance.
export const WIDE_TABLE_COLUMNS = 40;

function region(kind, id, body) {
  return `<!-- dbdoc:${kind}:${id} -->\n${body}\n<!-- dbdoc:end:${id} -->`;
}

function regionRe(id) {
  return new RegExp(`<!-- dbdoc:(?:auto|manual):${id} -->\\n([\\s\\S]*?)\\n<!-- dbdoc:end:${id} -->`);
}

/** Inner body of a marked region, or null if absent. */
export function extractRegion(content, id) {
  const m = typeof content === "string" ? content.match(regionRe(id)) : null;
  return m ? m[1] : null;
}

export function hasMarkers(content) {
  return typeof content === "string" && /<!-- dbdoc:(?:auto|manual):/.test(content);
}

// A cell can't contain a raw pipe or newline without breaking the table row.
function cell(value) {
  if (value == null) return "-";
  const s = String(value).trim();
  if (s === "") return "-";
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  return t.slice(1, t.endsWith("|") ? -1 : undefined).split("|").map((s) => s.trim());
}

// Map COLUMN_NAME(upper) -> its human 설명 cell, read from an existing doc's
// columns region. Header/separator/scaffold rows are skipped so they never
// masquerade as a preserved description.
export function extractColumnDescriptions(content) {
  const map = new Map();
  const body = extractRegion(content, "columns");
  if (!body) return map;
  for (const line of body.split("\n")) {
    const cells = splitRow(line);
    if (!cells || cells.length < 5) continue;
    const name = cells[0];
    if (name === "컬럼" || /^-+$/.test(name) || name.startsWith("{{")) continue;
    map.set(name.toUpperCase(), cells[4]);
  }
  return map;
}

function columnDescription(col, preserved) {
  const prior = preserved.get(col.name.toUpperCase());
  if (prior && prior !== SCAFFOLD.cell && prior !== "-") return prior;
  if (col.comment && String(col.comment).trim()) return cell(col.comment);
  return SCAFFOLD.cell;
}

function renderColumns(columns, preserved) {
  const header = "| 컬럼 | 타입 | 널 | 기본값 | 설명 |\n| --- | --- | --- | --- | --- |";
  const rows = columns.map((col) => {
    const nn = col.nullable ? "Y" : "N";
    return `| ${cell(col.name)} | ${cell(col.type)} | ${nn} | ${cell(col.default)} | ${columnDescription(col, preserved)} |`;
  });
  return [header, ...rows].join("\n");
}

function renderKeys(desc) {
  const lines = [`- PK: ${desc.primaryKey?.length ? desc.primaryKey.join(", ") : "-"}`];
  if (desc.indexes?.length) {
    const idx = desc.indexes
      .map((ix) => `${ix.name}(${(ix.columns ?? []).join(", ")}${ix.unique ? ", UNIQUE" : ""})`)
      .join("; ");
    lines.push(`- 인덱스: ${idx}`);
  }
  if (desc.foreignKeys?.length) {
    const fk = desc.foreignKeys.map((f) => `${f.column} → ${f.refTable}.${f.refColumn}`).join("; ");
    lines.push(`- 관계: ${fk}`);
  }
  return lines.join("\n");
}

function purposeScaffold(tableComment) {
  const t = tableComment == null ? "" : String(tableComment).trim();
  return t ? `${t}. {{쓰기 주체 → 읽기 주체}}` : SCAFFOLD.purpose;
}

/**
 * Render (or regenerate) one table's doc.
 * @returns {{status:"created"|"updated"|"conflict", markdown?:string, reason?:string}}
 */
export function renderDoc(desc, { tableComment = null, existing = null } = {}) {
  if (existing && existing.trim() && !hasMarkers(existing)) {
    return {
      status: "conflict",
      reason: `기존 문서에 dbdoc 마커가 없어 덮어쓰지 않습니다(수기 문서 보호): ${desc.owner}.${desc.table}`,
    };
  }
  const preserved = existing ? extractColumnDescriptions(existing) : new Map();
  const purpose = (existing && extractRegion(existing, "purpose")) ?? purposeScaffold(tableComment);
  const queries = (existing && extractRegion(existing, "queries")) ?? SCAFFOLD.queries;
  const migration = (existing && extractRegion(existing, "migration")) ?? SCAFFOLD.migration;

  const markdown = [
    `# ${desc.owner}.${desc.table}`,
    "",
    region("manual", "purpose", purpose),
    "",
    region("auto", "columns", renderColumns(desc.columns ?? [], preserved)),
    "",
    region("auto", "keys", renderKeys(desc)),
    "",
    "---",
    "",
    "## 대표 쿼리",
    "",
    region("manual", "queries", queries),
    "",
    "## 마이그레이션 주의",
    "",
    region("manual", "migration", migration),
    "",
  ].join("\n");

  return { status: existing ? "updated" : "created", markdown };
}

/** repo-root-relative doc path (also the index entry path). */
export function docRelPath(table) {
  return `.claude/docs/db/${table.toLowerCase()}.md`;
}

/** Keyword defaults: bare table name + schema-qualified, both lowercase. */
export function keywordsFor(owner, table) {
  return [table.toLowerCase(), `${owner}.${table}`.toLowerCase()];
}

/**
 * Add or replace this table's entry in a db-schema index array (matched by
 * path). Returns a new array; does not mutate the input.
 */
export function upsertIndexEntry(entries, desc, { precision } = {}) {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const entry = { keywords: keywordsFor(desc.owner, desc.table), path: docRelPath(desc.table) };
  if (precision != null && precision !== 1) entry.precision = precision;
  const i = list.findIndex((e) => e && e.path === entry.path);
  if (i >= 0) list[i] = entry;
  else list.push(entry);
  return list;
}
