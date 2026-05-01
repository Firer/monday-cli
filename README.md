# monday-cli

A TypeScript CLI for interacting with [Monday.com](https://monday.com) and
Monday Dev — designed first for AI coding agents (Claude Code, Codex, etc.)
that need to pull tasks, file backlog items, and edit boards from the
terminal, with humans as a welcome second audience.

> **Status:** v0.1.0 — first release. Network surface spans 5
> nouns (account / workspace / board / user / update / item
> reads), the four M5b mutation commands (`item set` / `item
> clear` / `item update` single + bulk / `update create`), the
> M6 diagnostics + escape hatch (`board doctor` + `raw`), filter
> DSL (`--where` + `--filter-json`), cursor-based pagination
> with stale-cursor fail-fast + NDJSON streaming, the seven
> column-value writers, the dry-run engine, plus local-only
> commands (cache / config / schema). The agent-flow E2E pins
> the full v0.1 contract end-to-end across four binary spawns.
> The full design lives in [`docs/cli-design.md`](./docs/cli-design.md) — read it
> if you want to know what the CLI looks like end-to-end.
> See [CLAUDE.md](./CLAUDE.md) for agent-facing project context.

## Requirements

- Node.js ≥ 22
- A Monday.com API token (admin or member; guests cannot mint one)

## Install

Not yet published to npm. For local install during development:

```bash
git clone <repo-url> monday-cli
cd monday-cli
npm install
npm run build
npm link        # exposes the `monday` bin in your PATH
```

For the dev workflow (no build step), see
[docs/development.md](./docs/development.md).

## Auth quickstart

The CLI authenticates with a Monday.com API token. The simplest setup:

```bash
export MONDAY_API_TOKEN="<your-token>"
monday account whoami            # smoke test
```

**Where to get a token.** From your Monday admin panel, at
`https://<your-org>.monday.com/admin/integrations/api`. Admins or
members only — guests cannot mint API tokens.

**Source priority.** The CLI looks for the token in this order, first
match wins:

1. `MONDAY_API_TOKEN` in `process.env` (current shell — always wins).
2. `MONDAY_API_TOKEN=...` in a `.env` file in the working directory.

`--token <value>` is **not** a supported flag. Tokens passed on the
command line leak via `ps`, shell history, and crash dumps. If you
need to pass one inline, prefer `MONDAY_API_TOKEN=... monday ...` —
that keeps the token in the process env only.

**Wire format.** The CLI sends `Authorization: <token>` (no
`Bearer ` prefix). Monday's API rejects the `Bearer ` form — don't
add it manually if you ever inspect the wire.

See [`.env.example`](./.env.example) for the full set of supported
variables (API URL override, API-Version pin, request-timeout, etc.).

## Usage

The CLI follows a `monday <noun> <verb>` shape with singular nouns:

```bash
# Discovery (run once to orient)
monday account whoami
monday board list
monday board describe <board-id>      # full board schema with column types

# Reading items
monday item list --board <board-id>
monday item list --board <board-id> --where status=Backlog --where owner=me
monday item list --board <board-id> --all --output ndjson | jq '...'
monday item get <item-id>
monday item find "Refactor login" --board <board-id>
monday item search --board <board-id> --where status=Done
monday item subitems <item-id>

# Updating items (v0.1: in-place updates only; create/move/archive in v0.2)
monday item set <item-id> status=Done
monday item update <item-id> --set status=Done --set 'Due date'=+1w

# Comments
monday update list <item-id>
monday update create <item-id> --body "Shipped in PR #1234"

# Schemas (the agent's discovery hammer)
monday schema                          # full CLI command schema as JSON Schema
monday schema item.set                 # one command's schema (dotted name)

# Diagnostics (M6)
monday board doctor <board-id>         # flag duplicate titles, non-writable
                                       # column types, broken board_relations
monday raw '{ me { id name email } }'  # GraphQL escape hatch
```

For longer worked examples — the canonical agent flow (pick up a
backlog item → mark in-progress → leave a comment → mark done),
filter syntax, dry-run shapes, error handling — see
[`docs/examples.md`](./docs/examples.md).

### Output format

- **TTY (you in a terminal):** human-friendly tables, truncated to fit width.
- **Pipe / redirect:** JSON, no flags needed — `monday item list | jq` works.
- **Agent in pseudo-TTY:** pass `--json` (alias for `--output json`) to force
  JSON regardless of terminal detection. JSON output is never truncated.

Every JSON response uses the same envelope:

```json
{ "ok": true, "data": ..., "meta": { ... }, "warnings": [] }
```

Errors carry a stable `error.code` (e.g. `not_found`, `rate_limited`,
`unsupported_column_type`) — agents key off the code, never the message.
The full envelope contract is locked in `docs/cli-design.md` §6.

### Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error (bad args) |
| 2 | API or network error |
| 3 | Config error (missing token, etc.) |
| 130 | SIGINT |

## Agent quickstart

If you're an AI coding agent driving this CLI:

1. **Always pass `--json`** — pseudo-TTY detection isn't reliable
   inside an agent harness. `--json` is an alias for
   `--output json` and forces JSON on every command. JSON is never
   truncated; tables are.
2. **Branch on `error.code`, not `error.message`.** The 26 stable
   v0.1 codes are listed in [`docs/cli-design.md`](./docs/cli-design.md) §6.5
   — `not_found`, `confirmation_required`, `column_archived`,
   `unsupported_column_type`, `rate_limited`, `stale_cursor`, etc.
   Codes are part of the contract; messages are not.
3. **Read `meta.source`** to know whether the data is `"live"` /
   `"cache"` / `"mixed"` / `"none"`. `"mixed"` means board metadata
   came from cache and the rest hit live — non-trivial for write
   operations because Monday's column state may have drifted.
   `cache_age_seconds` tells you how stale the cached portion is.
4. **Pass `--verbose`** if you want `meta.complexity` populated.
   Without `--verbose`, complexity is `null` (the CLI doesn't add a
   complexity field on every query). Useful when planning a bulk
   walk against the 5M points/min budget.
5. **Discover commands and their schemas** with `monday schema --json`
   (full registry as JSON Schema 2020-12) or
   `monday schema <command-name> --json` (one command). No
   `--help`-scraping needed — every command's input flags + output
   `data` shape are introspectable.
6. **Discover board structure** with
   `monday board describe <board-id> --json`. Each writable column
   carries `example_set` — paste-ready `--set <token>=<value>`
   strings the agent can use without consulting external Monday docs.
7. **Per-command output reference** lives in
   [`docs/output-shapes.md`](./docs/output-shapes.md) — what `data`
   looks like for every shipped command. Worked agent sessions in
   [`docs/examples.md`](./docs/examples.md).

## Documentation

- [CLAUDE.md](./CLAUDE.md) — agent-facing project context and conventions.
- **[docs/cli-design.md](./docs/cli-design.md)** — canonical CLI contract.
  **Start here** if you want to understand what the CLI does, what's in
  v0.1 vs deferred, or what the JSON envelope shape is.
- [docs/output-shapes.md](./docs/output-shapes.md) — per-command output
  reference. What `data` looks like for every shipped command, with
  concrete examples.
- [docs/architecture.md](./docs/architecture.md) — module boundaries
  (commands → api → SDK).
- [docs/api-reference.md](./docs/api-reference.md) — Monday concepts cheat
  sheet (supplementary; the canonical schema view is `cli-design.md` §2).
- [docs/development.md](./docs/development.md) — local dev workflow,
  adding a new command.

## License

UNLICENSED — internal/private project.
