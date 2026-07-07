// agent-db-plugin — read-only Oracle MCP server (stdio).
// Design: docs/design.md. This file wires the MCP plumbing and tool schemas;
// the DB-touching handlers are stubs in the skeleton (implementation later).
//
// Tools (design §7):
//   list_connections  — aliases + status (never returns passwords)
//   list_tables       — ALL_TABLES/ALL_TAB_COMMENTS, allow-filtered (§5 수준1)
//   describe_table    — columns/PK/FK/indexes/NUM_ROWS (§7)
//   run_query         — SELECT/WITH only, via executeReadOnly single path (§5)

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { validateReadOnlyStatement } from "./readonly.mjs";

const TOOLS = [
  {
    name: "list_connections",
    description:
      "설정된 DB alias 목록과 상태(비밀번호 env 설정 여부). 비밀번호는 반환하지 않음.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_tables",
    description: "alias의 테이블 목록 (allow 필터 적용). ALL_TABLES 기반.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "connections.json 의 alias" },
        schema: { type: "string", description: "스키마(owner) 필터, 선택" },
        name_filter: { type: "string", description: "테이블명 LIKE 필터, 선택" },
      },
      required: ["db"],
      additionalProperties: false,
    },
  },
  {
    name: "describe_table",
    description:
      "테이블 구조: 컬럼/PK/FK/인덱스(컬럼순서·유니크)/규모(NUM_ROWS). 숫자 컬럼은 문자열로 반환.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "connections.json 의 alias" },
        table: { type: "string", description: "테이블명 (스키마 접두 허용)" },
      },
      required: ["db", "table"],
      additionalProperties: false,
    },
  },
  {
    name: "run_query",
    description:
      "SELECT/WITH 조회 전용. 쓰기·DDL·PL/SQL 차단. 숫자는 문자열로, 대용량은 캡되어 반환(truncated 표시). 바인드(:name) 권장.",
    inputSchema: {
      type: "object",
      properties: {
        db: { type: "string", description: "connections.json 의 alias" },
        sql: { type: "string", description: "SELECT 또는 WITH 로 시작하는 단일 문장" },
        binds: { type: "object", description: "바인드 변수, 선택", additionalProperties: true },
        max_rows: { type: "number", description: "행 상한 override (하드 상한까지)" },
      },
      required: ["db", "sql"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "agent-db-plugin", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // L2 pre-check on run_query so the skeleton demonstrates the guard even before
  // the DB path exists. Full path (deny-scan, pools, caps) lands with impl (§5).
  if (name === "run_query") {
    const gate = validateReadOnlyStatement(args.sql ?? "");
    if (!gate.ok) {
      return { content: [{ type: "text", text: gate.reason }], isError: true };
    }
  }

  // TODO(impl): dispatch to handlers (config/pool/executeReadOnly/format/audit).
  return {
    content: [
      {
        type: "text",
        text: `NotImplemented(skeleton): ${name}. 구현 예정 — docs/design.md 참고.`,
      },
    ],
    isError: true,
  };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio server stays alive until the client closes the stream.
}

main().catch((err) => {
  // stderr only — stdout is the MCP channel.
  console.error("[agent-db-plugin] fatal:", err);
  process.exit(1);
});
