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
**one stable contract** (universal envelope, 28 stable error codes,
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
export MONDAY_API_TOKEN="<your-token>"

# 2. Smoke test
monday account whoami --json

# 3. List a board's items (replace 12345 with your board ID)
monday item list --board 12345 --json

# 4. File a new task (v0.2)
monday item create --board 12345 --name "Refactor login" \
  --set status=Backlog --set 'Due date'=+1w --json

# 5. Find-or-create with idempotent matching (v0.2)
#    Re-running with the same args is safe — 0/1/2+ matches route to
#    create / update / `ambiguous_match` (the 27th stable error code).
monday item upsert --board 12345 --name "Refactor login" \
  --match-by name --set status='Working on it' --json

# 6. Move a ticket forward
monday item set 67890 status=Done --json

# 7. Comment on it
monday update create 67890 --body "Shipped in PR #1234" --json
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
    "cli_version": "0.2.0",
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
2. **Branch on `error.code`, not `error.message`.** The 28 stable
   codes (`not_found`, `confirmation_required`, `column_archived`,
   `unsupported_column_type`, `rate_limited`, `stale_cursor`,
   `ambiguous_match`, `tag_not_found`, …) are part of the contract.
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

**v0.2.0 (published — first npm release as `monday-cli`):**
the v0.1 read-only core + safe-mutations surface PLUS the full
mutation surface (item lifecycle, update mutations, workspace
lifecycle, board lifecycle, board columns + groups). Built
incrementally across M8–M18; one breaking change vs v0.1 (see
[CHANGELOG.md](./CHANGELOG.md) for the full upgrade guide).
`npm install -g monday-cli` pulls the published artifact.

**v0.1.0 (git tag, foundation milestone — not published to npm
under the `monday-cli` name):** read-only core (account, workspace,
board, user, update, item) + safe mutations (`item set` /
`item clear` / `item update` single + bulk, `update create`) +
diagnostics (`board doctor`) + GraphQL escape hatch (`raw`) +
filter DSL (`--where` + `--filter-json`) + cursor pagination with
stale-cursor fail-fast + NDJSON streaming + local cache. v0.1.0
shipped to `main` as the foundation milestone but the npm publish
slipped to v0.2.0; the v0.1 surface is fully present in the
published v0.2.0 tarball.

**What v0.2 added:**

- **M8** added the `--set-raw <col>=<json>` escape hatch (bypasses
  the friendly translator; gated against read-only-forever and
  files-shaped types) and the `link` / `email` / `phone` firm-row
  friendly translators.
- **M9** added `monday item create` — top-level + classic-only
  subitem creation with single round-trip semantics, optional
  positional placement (`--position before|after --relative-to
  <iid>`), and the same `--set` / `--set-raw` surface as
  `item update`.
- **M10** closed the item-lifecycle cluster — `monday item archive`
  / `delete` / `duplicate`. The two destructive verbs share the
  `--yes` confirmation gate (`--dry-run` exempts) and read the
  source item for the dry-run preview; `archive` is wire-level
  idempotent, `delete` non-idempotent (re-running after an interim
  `create` would target the new item). `duplicate` is creative
  (no `--yes`), runs two-leg live (board lookup + mutation —
  Monday requires `board_id`), takes `--with-updates` to copy the
  source's comments, and extends the live envelope's `data` with
  `duplicated_from_id` so an agent has the source-ID echo handy.
- **M11** closed the four-verb lifecycle set with `monday item
  move` — same-board (`--to-group <gid>`) via `move_item_to_group`
  or cross-board (`--to-group <gid> --to-board <bid>`) via
  `move_item_to_board`. Cross-board moves use
  `--columns-mapping '{<src>: <target>}'` to bridge columns whose
  IDs differ between source and target; the strict default
  rejects unmatched columns pre-mutation with
  `details.unmatched` + `details.example_mapping` (agents
  copy-paste the seed into their retry) rather than letting
  Monday silently drop them. `--columns-mapping {}` is the
  explicit "drop everything (Monday's permissive default)"
  opt-in. `--to-group` is required for both forms because
  Monday's `move_item_to_board(group_id: ID!)` is mandatory.
  Value-overrides on cross-board mappings deferred to v0.3
  (Monday's `ColumnMappingInput` carries no value slot —
  agents fire `monday item set` post-move when they need
  overrides).
- **M12** ships the idempotency cluster — `monday item upsert`
  + bulk `monday item clear --where`. Upsert takes
  `--match-by <col>[,<col>...]` plus `--name` / `--set` and
  routes 0 / 1 / 2+ matches to `create_item` / `update_item` /
  `ambiguous_match` (the 27th stable error code). Sequential-
  retry idempotent — re-running with the same args from the
  same agent is safe; concurrent agents are NOT a uniqueness
  guarantee (agents should pick a stable hidden key column for
  `--match-by` so race-induced duplicates surface as
  `ambiguous_match` on the next call). The match-by safe-list is
  intentionally narrow in v0.2: `name` / `text` / `long_text` /
  `numbers` / external_id-shaped hidden text round-trip
  verbatim; `status` / `dropdown` round-trip via label-text;
  `people` is restricted to `me`; `date` / `link` / `email` /
  `phone` are NOT v0.2-safe (the lookup-leg vs mutation-leg
  grammars don't reconverge at the wire — see cli-design §5.8
  for the per-kind breakdown). Bulk `clear --where` extends
  M5b's per-item clear with the same cursor walk + `--yes`
  gate + per-item failure decoration as bulk `update --where`.

**Writer allowlist** (other types return `unsupported_column_type`
with per-category guidance):
`status`, `text`, `long_text`, `numbers`, `dropdown`, `date`,
`people`, plus M8 firm row `link`, `email`, `phone`, plus v0.3-M19
row `tags`, `board_relation`, `dependency`.

- **M13** ships the full update mutation surface — `monday update
  reply` / `edit` / `delete` / `like` / `unlike` / `pin` / `unpin`
  / `clear-all`. The eight new verbs introduce the **partial-
  success envelope** (`update clear-all` returns `ok: true` with
  per-target outcomes in `data.results: [...]`); the envelope is
  `ok: true` whenever the dispatch ran, with per-target failures
  surfacing as `data.results[i].error: { code, message }` rather
  than top-level `ok: false`. M13 also flips `update list`'s
  default-replies behaviour (now empty unless `--with-replies`
  is set — the one breaking change in v0.2).
- **M14** ships the workspace lifecycle — `monday workspace
  create` / `update` / `delete` / `add-users` / `remove-users`.
  `add-users` / `remove-users` reuse M13's partial-success
  envelope and add resolver-fronted dispatch (mixed numeric IDs
  + emails through `userByEmail`); per-token resolution failures
  land as records inside `data.results` with the input token
  echoed verbatim.
- **M15** ships the board lifecycle — `monday board create` /
  `update` / `archive` / `delete` / `duplicate` / `add-users`.
  `board duplicate` introduces the **wrapped envelope** shape
  (`data: { board: <projection>, is_async }`) because Monday's
  `BoardDuplication` carries an `is_async` slot the projection
  doesn't model. `board update` is per-attribute fan-out across
  Monday's `update_board(board_attribute, new_value)` surface
  with a force-live final read leg (Monday's per-attribute calls
  return only the changed slice).
- **M16** ships board column lifecycle + the §8 eager-
  invalidation contract — `monday board column-create` /
  `column-update` / `column-delete`. Every board-structure
  mutation calls `invalidateBoard(boardId)` post-success so a
  same-process `board describe` sees fresh state without TTL
  eviction. `column-create` adds the
  `noncanonical_column_type` warning for non-allowlisted column
  types with per-category `suggested_write_path` (raw_writable /
  read_only_forever / files_shaped). M16 retrofitted `board
  update` / `archive` / `delete` to participate in the §8
  contract.
- **M17** ships board group lifecycle — `monday board group-
  create` / `group-update` / `group-archive` / `group-duplicate`
  / `group-delete`. Group-update is per-attribute fan-out across
  Monday's single `update_group(group_attribute, new_value)`
  surface with NO force-live read leg (Monday's `update_group`
  returns the full Group projection post-mutation, distinguishing
  group-update from board-update). Group-create + group-update
  validate `--color` against the pinned Monday-supported palette
  in `src/api/group-color.ts`. Group-archive carries a snapshot-
  bearing dry-run from cached board metadata; group-delete is
  destructive-no-read minimal.

- **M18** closed v0.2 with NDJSON streaming for `item search` +
  `update list` (the missing pair vs M7's `item list` streaming
  pin), envelope-snapshots refresh (60 → 92), `output-shapes.md`
  audit, README quickstart with `item create` + `item upsert`
  examples, this CHANGELOG, and the version bump to `0.2.0`.

**v0.3 in progress.** **M19 closed** — `tags`, `board_relation`,
`dependency` friendly translators (slipped from v0.2 tentative at
M18 close per cli-design §13 + §5.3) graduated; `monday account
tags` read verb shipped (closes the §6.5 `tag_not_found.details
.hint` forward-reference). **Deferred to later v0.3 milestones**:
`monday item time-track start/stop` (M20), `monday auth login` +
`~/.monday-cli/config.toml` multi-profile (M21), `monday status` /
`monday usage` diagnostics (M22), cross-board `item search` +
`board favorites` (M23), `item history` (M24),
`item update --continue-on-error` partial-success (M25), `monday
dev` workflow shortcuts (M26), `notification send` + `webhook list/
create/delete` (M27), multi-level subitem creation (M28).
**v0.4:** `monday item watch`, `--concurrency`, asset uploads.
See [`docs/cli-design.md`](./docs/cli-design.md) §13 for the
full roadmap, [`docs/v0.3-plan.md`](./docs/v0.3-plan.md) for the
in-progress v0.3 milestones, and
[`docs/v0.2-plan.md`](./docs/v0.2-plan.md) for the v0.2 milestone
history.

See [CHANGELOG.md](./CHANGELOG.md) for the per-release contract.

## Documentation

- **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical CLI
  contract. **Start here** if you want to understand the full
  surface, the JSON envelope, error codes, or the v0.1 vs v0.2
  split.
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
- **Branch coverage 94%+ floor.**
- **Atomic commits, Conventional Commits.**

## Contributing

PRs welcome. Read [`docs/cli-design.md`](./docs/cli-design.md) for
the contract before writing code — anything that changes the
output envelope or error codes is a major-version bump and
requires explicit doc revision.

## License

[MIT](./LICENSE) © Nick Webster
