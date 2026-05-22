# monday-cli

[![npm version](https://img.shields.io/npm/v/monday-cli.svg)](https://www.npmjs.com/package/monday-cli)
[![CI](https://github.com/Firer/monday-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Firer/monday-cli/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

> An agent-first CLI for [Monday.com](https://monday.com). Pull tasks,
> file backlog items, transition statuses, and post comments from the
> terminal — designed for AI coding agents (Claude Code, Codex,
> Aider) with humans as a welcome second audience.

---

## Why

AI coding agents need to operate on real tickets. Monday.com has a
GraphQL API, but each agent learning that schema from scratch is
wasteful — and the API is sharp-edged (40+ column types, idiosyncratic
mutation shapes, complex pagination). `monday-cli` is the abstraction:
**one stable contract** (universal envelope, 29 stable error codes,
JSON Schema introspection) that every agent can target.

- **Agent-first ergonomics.** `--json` everywhere, stable
  `error.code`, deterministic `meta`, no interactive prompts.
- **`monday board describe`** emits paste-ready `--set <token>=<value>`
  examples for every writable column — agents discover board
  structure without reading external docs.
- **`monday schema --json`** dumps every command's input flags and
  output shape as JSON Schema 2020-12 — no `--help` scraping.
- **`--dry-run`** on every mutation; **`confirmation_required`** for
  destructive bulk ops (no surprise deletes).
- **Two-layer token redaction** scrubs the API token from every
  emitted byte (logs, error messages, stack traces). Hardened
  against an adversarial fixture suite.

## Install

```bash
npm install -g monday-cli
```

Requires **Node.js ≥ 22**.

## Quick start

```bash
# 1. Set your Monday API token (admin or member; guests can't mint one).
#    Get one at https://<your-org>.monday.com/admin/integrations/api
#    (`monday auth login` is registered but the OAuth flow is not yet
#    available — authenticate via the env var.)
export MONDAY_API_TOKEN="<your-token>"

# 2. Smoke test — confirm the token works.
monday account whoami --json

# 3. Install shell completion (bash / zsh / fish). The default mode
#    emits raw script bytes on stdout (so the redirect works); `--json`
#    opts into the envelope.
monday completion bash >> ~/.bashrc        # or .zshrc / config.fish

# 4. Is everything wired up?
monday status --json                       # DNS / TCP / TLS / auth / cache probe matrix
monday usage --json                        # remaining daily Monday API operations

# 5. Discover a board's shape (columns / groups / views).
monday board describe 12345 --json         # full schema + example_set per writable column
monday board views 12345 --json            # views only (Kanban / Gantt / Calendar / Table / …)

# 6. List a board's items.
monday item list --board 12345 --json

# 7. File a new task.
monday item create --board 12345 --name "Refactor login" \
  --set status=Backlog --set 'Due date'=+1w --json

# 8. Long-poll for activity on an item (NDJSON stream).
#    Per-event NDJSON record + a `{"_meta": {...}}` trailer carrying
#    the session counters. Use `--once` to drain backlog without
#    polling further; SIGINT (Ctrl-C) drains gracefully and exits 130.
monday item watch 67890 --once             # or --max-events 50 --max-duration 1h

# 9. Upload a file to a column or to an update (comment).
#    Both surface `--dry-run` for an envelope preview without the
#    multipart round-trip.
monday item upload 67890 --column 'Attachments' ./screenshot.png --json
monday update upload <update-id> ./diagram.png --json

# 10. Parallel partial-success bulk updates. `--concurrency <N>` (1..32)
#     opts into parallel dispatch; envelope is byte-equivalent to the
#     sequential `--concurrency 1` default, input order is preserved in
#     `data.results[]` regardless of completion order.
monday item update --where status=Backlog --set status='Working on it' \
  --board 12345 --yes --continue-on-error --concurrency 4 --json

# 11. Browse the workdocs surface.
monday doc list --workspace 5 --order-by used_at --limit 10 --json
monday doc get 88001 --json                # full Document with blocks

# 12. Workdocs CRUD. Doc-level: create / rename / delete / duplicate.
monday doc create-in-workspace --workspace 5 --name "Design notes" --json
monday doc rename 88001 --name "Design notes (v2)" --json
monday doc duplicate 88001 --with-updates --json
monday doc delete 88001 --yes --json
#     Per-block: block-create / block-update / block-delete.
monday doc block-create 88001 --type normal_text --content '{"text":"hi"}' --json
#     Bulk import from HTML / markdown — no per-block round-trips.
monday doc import-html --workspace 5 --html ./page.html --title "Imported" --json
monday doc append-markdown 88001 --markdown ./notes.md --json

# 13. Team writers.
monday user team-list --json
monday user team-create --name "Platform" --users 7,9 --json
monday user team-add-members <tid> --users 11,13 --json

# 14. File-column friendly `--set` writes — every shape reaching
#     Monday's file-upload wire. `--dry-run` emits `planned_changes` on
#     any of these without the multipart round-trip.
monday item set 67890 'Attachments'=./screenshot.png --json
monday item update 67890 --set 'Attachments'=./diagram.png --json
monday item update --board 12345 --where status=Backlog \
  --set 'Attachments'=./report.pdf --yes --continue-on-error \
  --concurrency 4 --json                   # bulk file dispatch
monday item create --board 12345 --name "Field report" \
  --set 'Attachments'=./report.pdf --set 'Spec'=./spec.pdf \
  --set status='Working on it' --json      # multi-file at create-time
cat report.pdf | monday item set 67890 'Attachments'=- \
  --filename report.pdf --json             # stdin file source

# 15. Find-or-create with idempotent matching. Re-running with the
#     same args is safe — 0 / 1 / 2+ matches route to create / update
#     / `ambiguous_match` (a stable error code agents can key off).
monday item upsert --board 12345 --name "Refactor login" \
  --match-by name --set status='Working on it' --json

# 16. Move a ticket forward, then comment on it.
monday item set 67890 status=Done --json
monday update create 67890 --body "Shipped in PR #1234" --json

# 17. Monday Dev convention layer (sprint / epic / release / task).
#     First-time setup auto-detects boards by Monday's stock template
#     names.
monday dev discover --apply --json         # writes ~/.monday-cli/config.toml
monday dev sprint current --json           # the active sprint
monday dev task list --mine --json         # my open tasks

# 18. Outbound writes — webhooks + notifications.
monday webhook list 12345 --json
monday notification send --user 7 --target 67890 \
  --target-type item --text "PTAL" --json
```

## Usage

The CLI follows a `monday <noun> <verb>` shape:

```bash
# Discovery
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

# Updating items
monday item set <item-id> status=Done
monday item update <item-id> --set status=Done --set 'Due date'=+1w
monday item clear <item-id> status

# Comments (Monday "updates")
monday update list <item-id>
monday update create <item-id> --body "Shipped in PR #1234"

# Schemas (the agent's discovery hammer)
monday schema                          # full registry as JSON Schema 2020-12
monday schema item.set                 # one command's schema (dotted name)

# Diagnostics + escape hatch
monday board doctor <board-id>         # flag duplicate titles, non-writable
                                       # column types, broken board_relations
monday raw '{ me { id name email } }'  # GraphQL escape hatch
monday raw 'mutation { ... }' --allow-mutation --dry-run
```

For worked agent walkthroughs (pick up a backlog item → mark
in-progress → leave a comment → mark done), filter DSL syntax,
dry-run shapes, and error handling, see
[`docs/examples.md`](./docs/examples.md).

## Output format

- **TTY (you in a terminal):** human-friendly tables, truncated to fit
  the terminal width.
- **Pipe / redirect:** JSON, no flags needed — `monday item list | jq`
  works.
- **Agent in a pseudo-TTY:** pass `--json` (alias for `--output json`)
  to force JSON regardless of terminal detection. JSON output is
  never truncated.

Every JSON response uses the same universal envelope:

```json
{
  "ok": true,
  "data": ...,
  "meta": {
    "schema_version": "1",
    "api_version": "2026-01",
    "cli_version": "0.8.0",
    "request_id": "0e6f1a7b-...",
    "source": "live",
    "cache_age_seconds": null,
    "retrieved_at": "2026-05-01T10:00:00Z",
    "complexity": null
  },
  "warnings": []
}
```

Errors carry a stable `error.code` — agents key off the code,
never the English message:

```json
{
  "ok": false,
  "error": {
    "code": "rate_limited",
    "message": "...",
    "retryable": true,
    "retry_after_seconds": 30,
    "details": { "...": "..." }
  },
  "meta": { "..." }
}
```

The full envelope and error-code contract live in
[`docs/cli-design.md`](./docs/cli-design.md) §6 (binding) and
[`docs/output-shapes.md`](./docs/output-shapes.md) (per-command
reference).

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error (bad args, `confirmation_required`) |
| 2 | API or network error |
| 3 | Config error (missing token, etc.) |
| 130 | SIGINT (Ctrl-C) |

## Agent quickstart

If you're an AI coding agent driving this CLI:

1. **Always pass `--json`.** Pseudo-TTY detection isn't reliable
   inside an agent harness. `--json` is an alias for
   `--output json` and forces JSON on every command. JSON is
   never truncated; tables are.
2. **Branch on `error.code`, not `error.message`.** The 29 stable
   codes (`not_found`, `confirmation_required`, `column_archived`,
   `unsupported_column_type`, `rate_limited`, `stale_cursor`,
   `ambiguous_match`, `tag_not_found`, `oauth_failed`, …) are
   part of the contract.
   Messages are not.
3. **Read `meta.source`** to know whether the data is
   `"live"` / `"cache"` / `"mixed"` / `"none"`. `"mixed"` means
   board metadata came from cache while the rest hit live —
   non-trivial for writes because Monday's column state may have
   drifted. `cache_age_seconds` tells you how stale the cached
   portion is.
4. **Discover commands** via `monday schema --json`. Every
   command's input flags + output `data` shape are
   introspectable as JSON Schema 2020-12 — no `--help` scraping.
5. **Discover board structure** via
   `monday board describe <board-id> --json`. Each writable column
   carries `example_set`, paste-ready `--set <token>=<value>`
   strings the agent can use without external Monday docs.
6. **Use `--dry-run`** on any mutation to preview the change as a
   `planned_changes[]` envelope before committing. Bulk ops
   without `--yes` return `confirmation_required` (exit 1) by
   default.
7. **Per-command output reference** lives in
   [`docs/output-shapes.md`](./docs/output-shapes.md) — what `data`
   looks like for every shipped command. Worked agent sessions in
   [`docs/examples.md`](./docs/examples.md).

## Configuration

The CLI reads configuration from environment variables. Source
priority (first match wins):

1. `MONDAY_API_TOKEN` in `process.env` (current shell).
2. `MONDAY_API_TOKEN=...` in a `.env` file in the working directory.

`--token <value>` is **not** a supported flag — tokens passed on the
command line leak via `ps`, shell history, and crash dumps. If you
must pass one inline, prefer `MONDAY_API_TOKEN=... monday ...` so
the token stays in the process env only.

The CLI sends `Authorization: <token>` (no `Bearer ` prefix).
Monday's API rejects the `Bearer ` form.

See [`.env.example`](./.env.example) for all supported variables
(API URL override, API-Version pin, request timeout, etc.).

## Scope

**v0.10.0 (current).** Internal cleanup — no behaviour change.
Collapses duplicate noun-description literals across the command
registry into a single source of truth so command help text can no
longer silently drift from the canonical phrasing. **118 commands**
across boards, items (single + bulk via `--where`), columns, groups,
workspaces, teams, workdocs, updates, files, and the `monday dev`
workflow namespace. No breaking changes vs v0.9.0.

**What's next.** Roadmap headlines (see
[`docs/cli-design.md`](./docs/cli-design.md) §13 for the full
roadmap):

- Cross-board `monday item move` with column-value overrides
- Item descriptions on read (paired with item-set-description on
  write)
- Profile-scoped argument defaults via `~/.monday-cli/config.toml`
- Resumable cross-board search cursor

A user-entity contract migration plus Monday API version pin bumps
(to `2026-04`, then `2026-07`) defer pending upstream Monday SDK
releases.

See [CHANGELOG.md](./CHANGELOG.md) for the full per-release history.

## Documentation

- **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical CLI
  contract. **Start here** if you want to understand the full
  surface, the JSON envelope, error codes, or the per-version
  scope (§13).
- [`docs/output-shapes.md`](./docs/output-shapes.md) — per-command
  output reference with concrete examples.
- [`docs/examples.md`](./docs/examples.md) — worked agent sessions.
- [`docs/architecture.md`](./docs/architecture.md) — module
  boundaries (commands → api → SDK).
- [`docs/api-reference.md`](./docs/api-reference.md) — Monday
  concepts cheat sheet.
- [`docs/development.md`](./docs/development.md) — local dev
  workflow, adding a new command.
- [`CLAUDE.md`](./CLAUDE.md) — agent-facing project context and
  conventions.

## Development

```bash
git clone https://github.com/Firer/monday-cli.git
cd monday-cli
npm install              # `prepare` hook auto-builds dist/
npm run dev -- account whoami --json    # tsx-based dev runner

# Quality gates (all must pass before merge):
npm run typecheck
npm run lint
npm test
```

The full dev workflow + how to add a new command is in
[`docs/development.md`](./docs/development.md). Conventions:

- **Strictest TypeScript** (`exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- **No `any`** (lint-enforced).
- **Parse at every boundary** with zod.
- **Mock at the network boundary, not internal modules.**
- **Branch coverage 95.45% floor** for branches; 95% floor for
  statements / functions / lines (v0.3-M22 ratcheted branches
  from 94% via an OAuth coverage-push session — see
  `vitest.config.ts`).
- **Atomic commits, Conventional Commits.**

## Contributing

PRs welcome. Read [`docs/cli-design.md`](./docs/cli-design.md) for
the contract before writing code — anything that changes the
output envelope or error codes is a major-version bump and
requires explicit doc revision.

## License

[MIT](./LICENSE) © Nick Webster
