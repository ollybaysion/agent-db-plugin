import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDoc,
  upsertIndexEntry,
  docRelPath,
  keywordsFor,
  hasMarkers,
  extractColumnDescriptions,
} from "../skills/db-schema-docs/render.mjs";

// A describe_table result (the exact shape src/schema.mjs.describeTable returns).
function glAccounts() {
  return {
    owner: "ERP",
    table: "GL_ACCOUNTS",
    columns: [
      { name: "ACCOUNT_ID", type: "NUMBER(10,0)", nullable: false, default: null, comment: "계정 PK" },
      { name: "NAME", type: "VARCHAR2(100)", nullable: false, default: null, comment: null },
      { name: "STATUS", type: "VARCHAR2(1)", nullable: true, default: "'A'", comment: null },
    ],
    primaryKey: ["ACCOUNT_ID"],
    foreignKeys: [{ column: "PARENT_ID", refTable: "GL_ACCOUNTS", refColumn: "ACCOUNT_ID" }],
    indexes: [{ name: "IX_GL_NAME", unique: false, columns: ["NAME"] }],
    numRows: 1000,
    lastAnalyzed: null,
  };
}

test("renderDoc: fresh doc fills structural slots, seeds 설명 from column comment, scaffolds the rest", () => {
  const { status, markdown } = renderDoc(glAccounts());
  assert.equal(status, "created");
  assert.match(markdown, /^# ERP\.GL_ACCOUNTS$/m);
  assert.ok(hasMarkers(markdown));
  // column comment seeds the 설명 cell; a column without a comment gets the scaffold
  assert.match(markdown, /\| ACCOUNT_ID \| NUMBER\(10,0\) \| N \| - \| 계정 PK \|/);
  assert.match(markdown, /\| STATUS \| VARCHAR2\(1\) \| Y \| 'A' \| \{\{설명\}\} \|/);
  assert.match(markdown, /- PK: ACCOUNT_ID/);
  assert.match(markdown, /- 인덱스: IX_GL_NAME\(NAME\)/);
  assert.match(markdown, /- 관계: PARENT_ID → GL_ACCOUNTS\.ACCOUNT_ID/);
  assert.match(markdown, /\{\{용도 한 줄/); // purpose scaffold, human-fillable
});

test("renderDoc: a table comment seeds the 용도 line", () => {
  const { markdown } = renderDoc(glAccounts(), { tableComment: "총계정원장 계정 마스터" });
  assert.match(markdown, /총계정원장 계정 마스터\. \{\{쓰기 주체 → 읽기 주체\}\}/);
});

test("renderDoc: regeneration refreshes structure but preserves manual regions and per-column 설명", () => {
  // Start from a generated doc, then simulate human edits to manual content.
  const edited = renderDoc(glAccounts(), { tableComment: "총계정원장" })
    .markdown.replace("{{쓰기 주체 → 읽기 주체}}", "배치가 쓰고 리포트가 읽는다")
    .replace(
      "| ACCOUNT_ID | NUMBER(10,0) | N | - | 계정 PK |",
      "| ACCOUNT_ID | NUMBER(10,0) | N | - | 계정 고유번호(사람이 채움) |",
    )
    .replace("{{선택 — 이 테이블을 쓰는 전형적 쿼리 1~2개}}", "SELECT * FROM ERP.GL_ACCOUNTS WHERE STATUS='A'");

  // Regenerate against a STRUCTURAL change: STATUS widened, NAME dropped, a new column added.
  const changed = glAccounts();
  changed.columns = [
    { name: "ACCOUNT_ID", type: "NUMBER(10,0)", nullable: false, default: null, comment: "계정 PK" },
    { name: "STATUS", type: "VARCHAR2(2)", nullable: true, default: "'A'", comment: null },
    { name: "CREATED_AT", type: "DATE", nullable: false, default: null, comment: null },
  ];

  const { status, markdown } = renderDoc(changed, { existing: edited });
  assert.equal(status, "updated");
  // structural refresh
  assert.match(markdown, /\| STATUS \| VARCHAR2\(2\) \|/); // type widened
  assert.doesNotMatch(markdown, /\| NAME \|/); // dropped column gone
  assert.match(markdown, /\| CREATED_AT \| DATE \| N \| - \| \{\{설명\}\} \|/); // new column scaffolded
  // preservation
  assert.match(markdown, /계정 고유번호\(사람이 채움\)/); // per-column 설명 kept for a surviving column
  assert.match(markdown, /배치가 쓰고 리포트가 읽는다/); // manual 용도 kept
  assert.match(markdown, /SELECT \* FROM ERP\.GL_ACCOUNTS WHERE STATUS='A'/); // manual 대표쿼리 kept
});

test("renderDoc: a pre-existing doc WITHOUT our markers is a conflict, never overwritten", () => {
  const res = renderDoc(glAccounts(), { existing: "# 손으로 쓴 문서\n\n마커 없음." });
  assert.equal(res.status, "conflict");
  assert.equal(res.markdown, undefined);
  assert.match(res.reason, /마커가 없어/);
});

test("renderDoc: index/관계 lines are dropped when the table has none; PK shows '-'", () => {
  const bare = {
    owner: "X",
    table: "Y",
    columns: [{ name: "A", type: "NUMBER", nullable: true, default: null, comment: null }],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
  };
  const { markdown } = renderDoc(bare);
  assert.match(markdown, /- PK: -/);
  assert.doesNotMatch(markdown, /- 인덱스:/);
  assert.doesNotMatch(markdown, /- 관계:/);
});

test("renderDoc: pipes and newlines in a cell are escaped so they can't break the table", () => {
  const desc = {
    owner: "X",
    table: "Y",
    columns: [{ name: "C", type: "VARCHAR2(10)", nullable: true, default: "a|b", comment: "line1\nline2 | pipe" }],
    primaryKey: [],
    foreignKeys: [],
    indexes: [],
  };
  const { markdown } = renderDoc(desc);
  assert.match(markdown, /\| C \| VARCHAR2\(10\) \| Y \| a\\\|b \| line1 line2 \\\| pipe \|/);
});

test("extractColumnDescriptions: reads name→설명, skipping header/separator rows", () => {
  const { markdown } = renderDoc(glAccounts());
  const map = extractColumnDescriptions(markdown);
  assert.equal(map.get("ACCOUNT_ID"), "계정 PK");
  assert.equal(map.get("STATUS"), "{{설명}}");
  assert.equal(map.has("컬럼"), false);
});

test("upsertIndexEntry: adds a repo-root-relative entry, replaces by path, sets precision only when non-default", () => {
  const gl = glAccounts();
  let idx = upsertIndexEntry([], gl);
  assert.deepEqual(idx, [
    { keywords: ["gl_accounts", "erp.gl_accounts"], path: ".claude/docs/db/gl_accounts.md" },
  ]);
  // same table again → replace, not duplicate
  idx = upsertIndexEntry(idx, gl);
  assert.equal(idx.length, 1);
  // precision only emitted when != 1
  assert.equal(upsertIndexEntry([], gl, { precision: 0.5 })[0].precision, 0.5);
  assert.equal(upsertIndexEntry([], gl, { precision: 1 })[0].precision, undefined);
  // other entries are preserved
  const other = { keywords: ["foo"], path: ".claude/docs/db/foo.md" };
  const merged = upsertIndexEntry([other], gl);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0], other);
});

test("docRelPath / keywordsFor: lowercase, schema-qualified + bare keyword", () => {
  assert.equal(docRelPath("GL_ACCOUNTS"), ".claude/docs/db/gl_accounts.md");
  assert.deepEqual(keywordsFor("ERP", "GL_ACCOUNTS"), ["gl_accounts", "erp.gl_accounts"]);
});
