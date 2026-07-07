// agent-db-plugin — read-only Oracle MCP server (stdio).
// Design: docs/design.md. This file wires the MCP plumbing and tool schemas
// to the handlers in schema.mjs/readonly.mjs.
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

import { executeReadOnly } from "./readonly.mjs";
import { loadConfig } from "./config.mjs";
import { listTables, describeTable } from "./schema.mjs";

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
      "SELECT/WITH 조회 전용. 쓰기·DDL·PL/SQL 차단. 숫자는 문자열로, 대용량은 캡되어 반환(truncated 표시). 바인드(:name) 권장. " +
        "관리자가 지정한 deny 테이블명이 SQL에 등장하면 거부됨.",
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

// Loaded once at startup (§4) — before server.connect(), so no tool call can
// race it. A missing/malformed connections.json is fail-soft (config.mjs);
// list_connections is how an agent discovers what's actually usable.
let config = { connections: {}, errors: [] };

function textContent(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorContent(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function listConnectionsPayload() {
  return {
    connections: Object.entries(config.connections).map(([alias, aliasConfig]) => ({
      alias,
      description: aliasConfig.description ?? null,
      user: aliasConfig.user,
      passwordStatus: aliasConfig.passwordStatus,
    })),
    errors: config.errors,
    ...(config.hint ? { hint: config.hint } : {}),
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "list_connections") {
    return textContent(listConnectionsPayload());
  }

  if (name === "list_tables" || name === "describe_table" || name === "run_query") {
    const aliasConfig = config.connections[args.db];
    if (!aliasConfig) {
      return errorContent(`알 수 없는 alias: ${args.db}. list_connections로 확인하세요.`);
    }

    if (name === "list_tables") {
      const result = await listTables(args.db, aliasConfig, {
        schema: args.schema,
        nameFilter: args.name_filter,
      });
      return result.ok ? textContent(result) : errorContent(result.error);
    }

    if (name === "describe_table") {
      const result = await describeTable(args.db, aliasConfig, args.table);
      return result.ok ? textContent(result) : errorContent(result.error);
    }

    // run_query: L2/deny/read-only/caps/audit all happen inside
    // executeReadOnly's single path (§5, §8).
    const result = await executeReadOnly({
      alias: args.db,
      aliasConfig,
      sql: args.sql ?? "",
      binds: args.binds ?? {},
      maxRows: args.max_rows,
      tool: "run_query",
    });
    return result.ok ? textContent(result) : errorContent(result.error);
  }

  return errorContent(`NotImplemented(skeleton): ${name}. 구현 예정 — docs/design.md 참고.`);
});

async function main() {
  // ORACLE_MCP_CONFIG_PATH lets tests/smoke checks point at an isolated
  // connections.json instead of the real ~/.oracle-mcp one (design §9-6) —
  // unset in normal use, so real deployments are unaffected.
  config = await loadConfig(process.env.ORACLE_MCP_CONFIG_PATH || undefined);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio server stays alive until the client closes the stream.
}

main().catch((err) => {
  // stderr only — stdout is the MCP channel.
  console.error("[agent-db-plugin] fatal:", err);
  process.exit(1);
});
