# agent-db-plugin

Read-only Oracle (19c) access for Claude Code, delivered as an MCP server plugin.
Multiple databases and accounts by alias; **writes are blocked at the server
layer** so a write-capable account can still only read; output is capped so large
results don't blow up the agent's context.

> **Status: v1 read-only MVP implemented** (issues #2–#9 — config, pooling,
> read-only execution, output caps/type serialization, schema introspection,
> table allow/deny, audit logging, bundle/CI verification). Full design and
> adversarial-verification record: [`docs/design.md`](docs/design.md).

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
| `list_tables` | tables for an alias (`tables.allow`-filtered) |
| `describe_table` | columns, PK/FK, indexes, row-count estimate (`tables.allow`-gated) |
| `run_query` | `SELECT`/`WITH` only, capped output, `tables.deny`-scanned |

## Configuration

Global file `~/.oracle-mcp/connections.json` (per-user, never committed). It holds
**no secrets** — only `passwordEnv`, the *name* of an env var. See
[`connections.example.json`](connections.example.json). Put real passwords in your
shell env (e.g. `~/.oracle-mcp/env.sh`, `chmod 600`, sourced from `.bashrc`).

## Develop

```bash
npm install
npm test                 # unit + integration (integration self-skips without a reachable DB)
npm run test:integration # only test/*.integration.test.mjs — needs a reachable DB
npm run build            # esbuild bundle → dist/server.mjs (what the plugin runs)
npm run seed:test-db     # optional: populate a local container for manual poking around
```

Integration tests run against `gvenzl/oracle-free:23-slim` (Docker) and are
skipped individually when no DB is reachable, so `npm test` stays green on a
laptop with no container running. `test/bundle.integration.test.mjs` is the
local smoke gate (design §9): it builds the real esbuild bundle, spawns
`dist/server.mjs`, and round-trips `run_query` over actual MCP stdio — the one
test that exercises the bundled artifact instead of the source directly (this
is exactly what caught esbuild's ESM output needing a `createRequire` shim for
oracledb's Node-builtin `require()` calls — see the `--banner:js` in
`package.json`'s `build` script). CI (`.github/workflows/ci.yml`) runs this
same suite against an Oracle service container on every push/PR.

### Running against the company DB

**`ORACLE_TEST_*` must point at a dedicated sandbox schema with DDL rights on
its own objects — not the read-only account the plugin will actually run
with in production.** `npm run test:integration`'s `before()` hooks
`CREATE`/`DROP TABLE`/`INDEX`/`SYNONYM` to seed fixtures (same as the local
`gvenzl/oracle-free` container's `testuser`); a real `APP_RO`-style read-only
account (§4) can't run those DDL statements, so pointing the suite at one
fails at fixture setup, not because anything is broken. Use whatever your DBA
provisions for this — a scratch schema on the real 19c instance is enough to
get real-19c-only behavior (character set, real network/latency) without
touching production data.

Checklist before trusting a green `npm run test:integration` run:

- [ ] `ORACLE_TEST_CONNECT_STRING`/`ORACLE_TEST_USER`/`ORACLE_TEST_PASSWORD`
      point at the real 19c instance's sandbox schema, not the local container
- [ ] the sandbox schema's `NLS_CHARACTERSET` is what production actually uses
      (e.g. `KO16MSWIN949`) — the local `gvenzl/oracle-free` container
      defaults to `AL32UTF8`, so this is the one thing Docker CI can't stand
      in for
- [ ] `npm run build && node dist/server.mjs` boots against the company
      connections.json without the `Dynamic require` error described above
      (thin mode has no native-module surface, but re-verify after any
      `node-oracledb`/esbuild version bump — §9-6 is a live assumption, not a
      one-time fact)
- [ ] a real `run_query`/`describe_table` round trip against a production-shaped
      table (wide columns, LOB, FK) in the sandbox schema, to catch anything
      the seed fixtures didn't

**Separately — the automated suite can't verify this, since it needs DDL —
manually check the actual production-facing read-only account** (the one a
real `connections.json` alias will use) at least once: point a throwaway
alias at it and run `list_connections`/`list_tables`/`describe_table`/a plain
`run_query` SELECT by hand, confirming its `ALL_*` catalog visibility (§7) and
grants behave the way `list_tables`/`describe_table` assume — a locked-down
account may see a narrower catalog than the sandbox schema does.

## License

MIT
