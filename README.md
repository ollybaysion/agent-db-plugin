# agent-db-plugin

Read-only Oracle (19c) access for Claude Code, delivered as an MCP server plugin.
Multiple databases and accounts by alias; **writes are blocked at the server
layer** so a write-capable account can still only read; output is capped so large
results don't blow up the agent's context.

> **Status: skeleton.** The architecture, tool surface, and safety model are laid
> out and the read-only statement gate (L2) is implemented and unit-tested. The
> DB-touching handlers are stubs — see the `NotImplemented` markers. Full design
> and adversarial-verification record: [`docs/design.md`](docs/design.md).

## How it enforces read-only

Four layers, because no single one is complete (details + live verification in
`docs/design.md` §5, §11, §12):

| Layer | Mechanism | Catches |
| --- | --- | --- |
| L1 | every query inside `SET TRANSACTION READ ONLY` | DML / `FOR UPDATE` → ORA-01456 |
| L2 | first-keyword whitelist (`SELECT`/`WITH` only) | DDL, `LOCK TABLE`, PL/SQL, `WITH FUNCTION` |
| L3 | no commit path + unconditional rollback | anything that slipped through |
| L4 | one statement per `execute()` | `SELECT …; DROP …` chaining |

The one residual risk (calling a *pre-existing* `AUTONOMOUS_TRANSACTION` function
from a SELECT) is documented, not hidden — a read-only DB account is the real fix.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_connections` | aliases + status (never returns passwords) |
| `list_tables` | tables for an alias (allow-filtered) |
| `describe_table` | columns, PK/FK, indexes, row-count estimate |
| `run_query` | `SELECT`/`WITH` only, capped output |

## Configuration

Global file `~/.oracle-mcp/connections.json` (per-user, never committed). It holds
**no secrets** — only `passwordEnv`, the *name* of an env var. See
[`connections.example.json`](connections.example.json). Put real passwords in your
shell env (e.g. `~/.oracle-mcp/env.sh`, `chmod 600`, sourced from `.bashrc`).

## Develop

```bash
npm install
npm test          # L2 validator unit tests
npm run build     # esbuild bundle → dist/server.mjs (what the plugin runs)
```

Integration tests run against `gvenzl/oracle-free:23-slim` (Docker); see
`docs/design.md` §9.

## License

MIT
