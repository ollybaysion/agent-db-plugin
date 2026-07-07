// Connection config loading. Design: docs/design.md §4, §4.1.
//
// Global-only location: ~/.oracle-mcp/connections.json. Passwords are NEVER in
// this file — only `passwordEnv` (an env var name) is stored; the real secret
// lives in the shell env (e.g. ~/.oracle-mcp/env.sh, chmod 600, sourced in shell).
// Missing file → server still starts; list_connections explains how to create it
// (fail-soft).

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".oracle-mcp");
export const CONFIG_PATH = join(CONFIG_DIR, "connections.json");

// §6 출력 캡: defaultMaxRows는 얼마든 설정 가능하지만 1,000을 절대 넘지 못한다 —
// connections.json 값으로도 못 늘리는 불변 상한.
export const HARD_MAX_ROWS = 1000;

const DEFAULT_LIMITS = Object.freeze({
  defaultMaxRows: 100,
  callTimeout: 30,
  poolMax: 4,
});

const REQUIRED_FIELDS = ["connectString", "user", "passwordEnv"];

export const NO_CONFIG_HINT =
  `${CONFIG_PATH} 이 없습니다. 아래 형식으로 작성하세요 (템플릿: connections.example.json):\n` +
  `{\n  "connections": {\n    "my-db": {\n      "connectString": "host:1521/SERVICE",\n` +
  `      "user": "APP_RO",\n      "passwordEnv": "ORA_PW_MY_DB"\n    }\n  }\n}`;

function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function mergeLimits(globalLimits, connLimits) {
  const merged = { ...DEFAULT_LIMITS, ...globalLimits, ...connLimits };
  if (merged.defaultMaxRows > HARD_MAX_ROWS) merged.defaultMaxRows = HARD_MAX_ROWS;
  if (typeof merged.callTimeoutMax === "number" && merged.callTimeout > merged.callTimeoutMax) {
    merged.callTimeout = merged.callTimeoutMax;
  }
  return merged;
}

// design §4/§5: a top-level `tables` (allow/deny) applies to EVERY alias — the
// DBs are near-identical, so the access lists are declared once and only the few
// differing aliases override. The merge is per-key, symmetric with mergeLimits:
// an alias's `allow`/`deny` REPLACES the global one for that key (each array
// whole, never element-merged), but a key the alias omits is inherited. So an
// alias that customizes only `allow` still keeps the global `deny` — important
// because deny is typically a safety guard (e.g. `*.PII_*`) you don't want a
// per-alias allow tweak to silently drop. Returns undefined when neither side
// sets tables, preserving tables.mjs's "no list → unrestricted" contract.
function resolveTables(globalTables, connTables) {
  if (!globalTables && !connTables) return undefined;
  return { ...globalTables, ...connTables };
}

/** Returns an error string, or null if a tables spec (allow/deny arrays) is well-formed. */
function validateTablesSpec(label, tables) {
  if (!isPlainObject(tables)) return `${label}: tables는 객체여야 합니다`;
  for (const key of ["allow", "deny"]) {
    if (tables[key] !== undefined && !Array.isArray(tables[key])) {
      return `${label}: tables.${key}는 배열이어야 합니다`;
    }
  }
  return null;
}

/** Returns an error string, or null if the alias config is well-formed. */
function validateAlias(alias, raw) {
  if (!isPlainObject(raw)) return `${alias}: 설정이 객체가 아닙니다`;

  for (const field of REQUIRED_FIELDS) {
    if (typeof raw[field] !== "string" || raw[field].length === 0) {
      return `${alias}: 필수 필드 누락 또는 형식 오류 - ${field}`;
    }
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    return `${alias}: description은 문자열이어야 합니다`;
  }
  if (raw.tables !== undefined) {
    const tablesError = validateTablesSpec(alias, raw.tables);
    if (tablesError) return tablesError;
  }
  if (raw.limits !== undefined && !isPlainObject(raw.limits)) {
    return `${alias}: limits는 객체여야 합니다`;
  }
  return null;
}

/**
 * Load and validate connections.json.
 * Returns { connections: {...}, errors: [...], hint? }.
 * A malformed alias is dropped (fail-soft) rather than failing the whole server;
 * its error is collected for list_connections. A missing file is not an error —
 * it returns an empty config plus a `hint` with the write-this-file instructions.
 */
export async function loadConfig(path = CONFIG_PATH) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { connections: {}, errors: [], hint: NO_CONFIG_HINT };
    return { connections: {}, errors: [`설정 파일을 읽을 수 없습니다: ${err.message}`] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { connections: {}, errors: [`connections.json 파싱 실패: ${err.message}`] };
  }

  const globalLimits = isPlainObject(parsed?.limits) ? parsed.limits : {};
  const rawConnections = isPlainObject(parsed?.connections) ? parsed.connections : {};

  const connections = {};
  const errors = [];

  // Top-level tables is fail-soft too: a malformed global spec is collected as an
  // error and dropped (globalTables stays undefined), rather than failing every
  // alias that would otherwise inherit it.
  let globalTables;
  if (parsed?.tables !== undefined) {
    const tablesError = validateTablesSpec("최상위 tables", parsed.tables);
    if (tablesError) errors.push(tablesError);
    else globalTables = parsed.tables;
  }

  for (const [alias, rawAlias] of Object.entries(rawConnections)) {
    const error = validateAlias(alias, rawAlias);
    if (error) {
      errors.push(error);
      continue;
    }
    connections[alias] = {
      connectString: rawAlias.connectString,
      user: rawAlias.user,
      passwordEnv: rawAlias.passwordEnv,
      description: rawAlias.description,
      tables: resolveTables(globalTables, rawAlias.tables),
      limits: mergeLimits(globalLimits, rawAlias.limits),
      passwordStatus: passwordEnvStatus(rawAlias.passwordEnv),
    };
  }

  return { connections, errors };
}

/** "set" | "unset" — never reveals the value itself. */
export function passwordEnvStatus(passwordEnv) {
  return process.env[passwordEnv] ? "set" : "unset";
}

/**
 * Resolve an alias's password from its `passwordEnv`. Never logs or returns the
 * value except into the pool config. Missing env → clear, actionable error.
 */
export function resolvePassword(aliasConfig) {
  const { passwordEnv } = aliasConfig;
  const value = process.env[passwordEnv];
  if (!value) {
    throw new Error(
      `비밀번호 env 변수(${passwordEnv})가 설정되지 않았습니다. ` +
        `~/.oracle-mcp/env.sh 에 export ${passwordEnv}=... 를 추가하고 셸을 다시 불러오세요.`,
    );
  }
  return value;
}
