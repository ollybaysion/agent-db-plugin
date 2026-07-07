// Connection config loading. Design: docs/design.md §4, §4.1.
//
// Global-only location: ~/.oracle-mcp/connections.json. Passwords are NEVER in
// this file — only `passwordEnv` (an env var name) is stored; the real secret
// lives in the shell env (e.g. ~/.oracle-mcp/env.sh, chmod 600, sourced in shell).
// Missing file → server still starts; list_connections explains how to create it
// (fail-soft).

import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".oracle-mcp");
export const CONFIG_PATH = join(CONFIG_DIR, "connections.json");

/**
 * Load and validate connections.json.
 * Returns { connections: {...}, limits: {...}, errors: [...] }.
 * A malformed alias is dropped (fail-soft) rather than failing the whole server.
 * TODO(impl): JSON schema validation, per-alias error collection, passwordEnv
 * resolution reported (set / unset) for list_connections.
 */
export async function loadConfig() {
  throw new Error("NotImplemented: loadConfig (skeleton) — see docs/design.md §4");
}

/**
 * Resolve an alias's password from its `passwordEnv`. Never logs or returns the
 * value except into the pool config. Missing env → clear, actionable error.
 */
export function resolvePassword(/* aliasConfig */) {
  throw new Error("NotImplemented: resolvePassword (skeleton) — see docs/design.md §4");
}
