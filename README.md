# monday-cli

A TypeScript CLI for interacting with [Monday.com](https://monday.com) and
Monday Dev — designed first for AI coding agents (Claude Code, Codex, etc.)
that need to pull tasks, file backlog items, and edit boards from the
terminal, with humans as a welcome second audience.

> **Status:** v0.1 in progress — M0–M6 shipped; M7 (release prep)
> next. Network surface spans 5 nouns (account / workspace / board
> / user / update / item reads), the four M5b mutation commands
> (`item set` / `item clear` / `item update` single + bulk /
> `update create`), the M6 diagnostics + escape hatch (`board
> doctor` + `raw`), filter DSL (`--where` + `--filter-json`),
> cursor-based pagination with stale-cursor fail-fast + NDJSON
> streaming, the seven column-value writers, the dry-run engine,
> plus local-only commands (cache / config / schema). The
> agent-flow E2E pins the full v0.1 contract end-to-end across
> four binary spawns.
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

## Configuration

Configuration is read from environment variables. The simplest setup:

```bash
export MONDAY_API_TOKEN="<your-token>"
```

A `.env` file in the working directory is also picked up. See
[`.env.example`](./.env.example) for the full set of supported variables.

## Usage (v0.1 in progress — read commands + safe mutations shipping)

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
monday schema item-set                 # one command's schema

# Diagnostics (M6)
monday board doctor <board-id>         # flag duplicate titles, non-writable
                                       # column types, broken board_relations
monday raw '{ me { id name email } }'  # GraphQL escape hatch
```

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

## Documentation

- [CLAUDE.md](./CLAUDE.md) — agent-facing project context and conventions.
- **[docs/cli-design.md](./docs/cli-design.md)** — canonical CLI contract.
  **Start here** if you want to understand what the CLI does, what's in
  v0.1 vs deferred, or what the JSON envelope shape is.
- [docs/architecture.md](./docs/architecture.md) — module boundaries
  (commands → api → SDK).
- [docs/api-reference.md](./docs/api-reference.md) — Monday concepts cheat
  sheet (supplementary; the canonical schema view is `cli-design.md` §2).
- [docs/development.md](./docs/development.md) — local dev workflow,
  adding a new command.

## License

UNLICENSED — internal/private project.
