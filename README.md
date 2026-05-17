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
#
#    OAuth login (`monday auth login`) is registered but deferred in
#    v0.5.0 — the verb surfaces a clear `usage_error.details.reason:
#    oauth_unregistered` pointing here. Authenticate via the env var.
export MONDAY_API_TOKEN="<your-token>"

# 2. Smoke test — confirm the token works.
monday account whoami --json

# 3. Install shell completion (v0.4-M33 — bash / zsh / fish).
#    The default mode emits raw script bytes on stdout (so the redirect
#    works); `--json` opts INTO the §6 envelope.
monday completion bash >> ~/.bashrc        # or .zshrc / config.fish

# 4. Is everything wired up? (v0.3 diagnostics cluster)
monday status --json                       # 7-probe DNS/TCP/TLS/auth/cache matrix
monday usage --json                        # remaining daily Monday API operations

# 5. List a board's items (replace 12345 with your board ID)
monday item list --board 12345 --json

# 6. File a new task (v0.2)
monday item create --board 12345 --name "Refactor login" \
  --set status=Backlog --set 'Due date'=+1w --json

# 7. Long-poll for activity on an item (v0.4-M29 — NDJSON stream).
#    Per-event NDJSON record + a `{"_meta": {...}}` trailer carrying
#    the session counters. Use `--once` to drain backlog without
#    polling further; SIGINT (Ctrl-C) drains gracefully and exits 130.
monday item watch 67890 --once             # or --max-events 50 --max-duration 1h

# 8. Upload a file to a column or update (v0.4-M31 — multipart wire).
#    `add_file_to_column` for item columns; `add_file_to_update` for
#    comment attachments. Both surface `--dry-run` for an envelope
#    preview without the multipart round-trip.
monday item upload 67890 --column 'Attachments' ./screenshot.png --json
monday update upload <update-id> ./diagram.png --json

# 9. Parallel partial-success bulk updates (v0.4-M30).
#    `--concurrency <N>` (range 1..32) opts into parallel dispatch on
#    the M25 partial-success path. Envelope is byte-equivalent to the
#    sequential `--concurrency 1` default; input order is preserved
#    in `data.results[]` regardless of completion order.
monday item update --where status=Backlog --set status='Working on it' \
  --board 12345 --yes --continue-on-error --concurrency 4 --json

# 10. Browse the workdocs surface (v0.4-M32 — read-only at v0.4).
monday doc list --workspace 5 --order-by used_at --limit 10 --json
monday doc get 88001 --json                # full Document with blocks

# 11. Workdocs CRUD (v0.5-M35 + v0.5-M36 + v0.5-M37 — the full
#     mutation surface deferred at v0.4-M32 D8 closure).
#     Doc-level CRUD (M35): create / rename / delete / duplicate.
monday doc create-in-workspace --workspace 5 --name "Design notes" --json
monday doc rename 88001 --name "Design notes (v2)" --json
monday doc duplicate 88001 --with-updates --json
monday doc delete 88001 --yes --json
#     Doc-block CRUD (M36): block-create / block-update / block-delete.
#     16-value `DocBlockContentType` enum for `--type`.
monday doc block-create 88001 --type normal_text --content '{"text":"hi"}' --json
#     Bulk import from HTML / markdown (M37): no per-block round-trips.
monday doc import-html --workspace 5 --html ./page.html --title "Imported" --json
monday doc append-markdown 88001 --markdown ./notes.md --json

# 12. Team writers (v0.5-M34 — deferred from v0.4 at the post-M33
#     candidate-selection session). Six new verbs under `monday user`.
monday user team-list --json
monday user team-create --name "Platform" --users 7,9 --json
monday user team-add-members <tid> --users 11,13 --json

# 13. Find-or-create with idempotent matching (v0.2)
#     Re-running with the same args is safe — 0/1/2+ matches route to
#     create / update / `ambiguous_match` (one of the 29 stable error codes).
monday item upsert --board 12345 --name "Refactor login" \
  --match-by name --set status='Working on it' --json

# 14. Move a ticket forward, then comment on it
monday item set 67890 status=Done --json
monday update create 67890 --body "Shipped in PR #1234" --json

# 15. Monday Dev convention layer (v0.3 — sprint/epic/release/task)
#     First-time setup auto-detects boards by Monday's stock template names.
monday dev discover --apply --json         # writes ~/.monday-cli/config.toml
monday dev sprint current --json           # the active sprint
monday dev task list --mine --json         # my open tasks

# 16. Outbound writes (v0.3 — webhooks + notifications)
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
    "cli_version": "0.5.0",
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

**v0.5.0 (current — `monday-cli@0.5.0` on npm):**
the v0.4 surface PLUS the full team-writer surface
(`monday user team-list/get/create/delete/add-members/remove-members`),
the full Monday workdocs CRUD mutation surface — doc-level
(`monday doc create-in-workspace/create-on-column/rename/delete/duplicate`),
doc-block (`monday doc block-create/block-update/block-delete`),
and doc-content import (`monday doc import-html/append-markdown`) —
closing the v0.4-M32 workdocs-mutation deferral. **16 new CLI
verbs across 9 wire mutations.** **No breaking changes vs v0.4.0**
— every v0.5 surface is additive. Built incrementally across
M34–M37. See [CHANGELOG.md](./CHANGELOG.md) for the full
per-milestone release notes.

**OAuth deferral (unchanged from v0.4.0).** `monday auth login` is
registered but the canonical Monday OAuth app is not registered in
v0.5.0; the verb surfaces a clear `usage_error.details.reason:
oauth_unregistered` pointing at `MONDAY_API_TOKEN`. Multi-profile
config + per-profile credentials cache work fully against API
tokens; OAuth registration revisits in v0.5.x / v0.6 contingent on
user demand.

**v0.4.0 (the previous release):**
the v0.3 surface PLUS long-poll item activity streaming
(`monday item watch <iid>` — NDJSON), parallel bulk dispatch
(`monday item update --where ... --concurrency <N>`), asset uploads
(`monday item upload` / `monday update upload` — multipart wire),
Monday workdocs reads (`monday doc list` / `monday doc get` — full
workdocs CRUD mutation surface deferred to v0.5; shipped at v0.5),
and shell completion (`monday completion bash|zsh|fish`). Built
incrementally across M29–M33.

**v0.3.0 (the prior release):**
the v0.2 mutating core PLUS the Monday Dev convention layer
(`monday dev` namespace — sprint / epic / release / task workflow
shortcuts on top of standard board CRUD), multi-profile auth
(`monday auth login/logout --profile <name>` + `~/.monday-cli/
config.toml`), diagnostics (`monday status` + `monday usage`),
cross-board `monday item search` + `monday board favorites`,
per-item history (`monday item history <iid>`), partial-success
bulk updates (`monday item update --where ... --continue-on-error`),
outbound writes (`monday webhook list/create/delete` +
`monday notification send`), and three new writable column types
(`tags`, `board_relation`, `dependency`) closing the v0.2
tentative-row carryover. **No breaking changes vs v0.2.0** — every
v0.3 surface is additive. Built incrementally across M19–M28.

**v0.2.0 (the foundation-of-mutations release):**
the v0.1 read-only core + safe-mutations surface PLUS the full
mutation surface (item lifecycle, update mutations, workspace
lifecycle, board lifecycle, board columns + groups). Built
incrementally across M8–M18; one breaking change vs v0.1 (see
[CHANGELOG.md](./CHANGELOG.md) for the full upgrade guide).

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

**What v0.3 added (M19–M28; full per-milestone narrative in
[CHANGELOG.md](./CHANGELOG.md)):**

- **M19** — `tags`, `board_relation`, `dependency` friendly
  `--set` translators (closes the v0.2 tentative-row carryover);
  `monday account tags` read verb closes the `tag_not_found.
  details.hint` forward-reference.
- **M20** — `monday item time-track start/stop <iid>` registered
  for forward-compatibility (documentation-only; throw
  `usage_error` today — empirical probe 2026-05-10 confirmed
  Monday's API doesn't currently expose time-tracking writes).
- **M21 + M28** — multi-profile auth via `~/.monday-cli/
  config.toml` + `--profile <name>` global flag; per-profile
  credentials cache at `~/.monday-cli/credentials` (mode 0600).
  `monday auth login` is registered but the canonical OAuth app
  is not registered in v0.3.0 — the verb surfaces `usage_error.
  details.reason: oauth_unregistered` pointing at
  `MONDAY_API_TOKEN`. Multi-profile config + per-profile token
  caching work fully today.
- **M22** — `monday status` (7-probe DNS/TCP/TLS/auth/cache/
  redaction/env-var matrix per cli-design §11.5) + `monday usage`
  (daily Monday API operation budget remaining from
  `platform_api.daily_*`).
- **M23** — Cross-board `monday item search` (omit `--board`;
  scope via `--workspace` / `--favorites` / `--max-boards`) +
  `monday board favorites` (the current user's starred boards).
- **M24** — `monday item history <iid>` (two-source chronological
  merge: `activity_logs` + `updates`; per-event typed projection
  for `update_column_value`, synthesized `update_posted` /
  `update_replied` from the updates source).
- **M25** — `monday item update --where ... --continue-on-error`
  attempts every matched item regardless of per-item failure;
  emits a partial-success envelope with `data.summary.
  failed_count` + per-item `data.results[]`. Orthogonal to
  `--yes`.
- **M26** — `monday dev` namespace (sprint / epic / release /
  task workflow shortcuts on top of standard board CRUD). Three
  setup verbs (`dev discover [--apply]` / `dev configure` /
  `dev doctor`) + 10 workflow verbs. Per-profile board mapping
  in `[profiles.<name>.dev]`.
- **M27** — Outbound writes: `monday webhook list/create/delete`
  (live-only; webhooks land on the user's own HTTPS endpoint —
  the CLI never receives) + `monday notification send`
  (single-recipient at v0.3).
- **M28** — 0.3.0 release prep. Multi-level subitem creation
  deferred out of v0.3 per Decision 11 (Monday's `sub_items_board`
  carries no `subtasks` column at API `2026-01`).

**What v0.4 added (M29–M33; full per-milestone narrative in
[CHANGELOG.md](./CHANGELOG.md)):**

- **M29** — `monday item watch <iid>` long-polls `boards.activity_
  logs(item_ids:)` for per-item event streaming. NDJSON output:
  one event record per emitted activity-log row + a trailing
  `{"_meta": {...}}` record carrying the seven session counters
  (`events_emitted` / `polls_made` / `failed_polls` /
  `last_seen_event_id` / `circuit_broken_at` / `exit_reason` /
  `watch_duration_seconds`). `--once` drains backlog and exits
  without polling further; `--max-events` / `--max-duration`
  ceilings exit cleanly; SIGINT drains gracefully + exits 130.
  Circuit-breaker trips after 5 consecutive `complexity_exceeded`
  polls.
- **M30** — `monday item update --where ... --concurrency <N>`
  (range 1..32; default 1) opts into bounded parallel dispatch on
  the M25 partial-success path. Envelope is byte-equivalent to the
  sequential default; input order is preserved in `data.results[]`
  regardless of completion order. `--concurrency 1` routes through
  `dispatchSequential`; `> 1` routes through `dispatchParallel`.
- **M31** — `monday item upload <iid> --column <col> <file>` +
  `monday update upload <update-id> <file>` ship the first multipart
  wire surface (`add_file_to_column` / `add_file_to_update`). Both
  surface `--dry-run` for a planned-change envelope preview without
  the multipart round-trip. Uploads are non-idempotent (each
  successful call mints a fresh `Asset` ID); cache invalidation
  fires single-leg on success. Read-side `item assets` / `update
  assets` verbs deferred to v0.4.x per M31 Decision D6.
- **M32** — `monday doc list [--workspace <wid>,...] [--order-by
  <created_at|used_at>] [--limit <n>] [--page <n>]` + `monday doc
  get <did>` ship read-only access to Monday's workdocs surface
  (`Query.docs(...)`). Page/limit pagination (no cursor on this
  Monday surface). The full workdocs CRUD mutation surface (9
  mutations: `create_doc` / `update_doc_name` / `delete_doc` /
  `duplicate_doc` / `import_doc_from_html` / `add_content_to_doc_
  from_markdown` / `create_doc_block` / `update_doc_block` /
  `delete_doc_block`) is deferred to v0.5.
- **M33** — `monday completion <bash|zsh|fish>` ships shell
  completion script generation. The default mode emits raw script
  bytes on stdout regardless of TTY/pipe context (so `monday
  completion bash >> ~/.bashrc` works as a sourceable file —
  cli-design §3.1 #2 raw-bytes carve-out); `--json` opts INTO the
  §6 envelope with `data: { shell, script }`. Hand-rolled per-shell
  templates (commander 14.0.3 ships no built-in completion
  machinery, verified by empirical probe at M33 pre-flight).

**What v0.5 added (M34–M37; full per-milestone narrative in
[CHANGELOG.md](./CHANGELOG.md)):**

- **M34** — `monday user team-list/get/create/delete/add-members/
  remove-members` ship the full team-writer surface. The two read
  verbs (`team-list` / `team-get`) close the v0.4-M33 candidate-
  selection deferral; the four mutations introduce a new partial-
  success projection for `team-add-members` / `team-remove-members`
  (Monday's `change_team_memberships` returns `failed_users` +
  `successful_users` lists; the CLI projects to the universal §6.1
  `results: [{user_id, ok, ...}]` shape with input-order preserved
  + failed-bucket-priority discipline).
- **M35** — `monday doc create-in-workspace/create-on-column/rename/
  delete/duplicate` ship the doc-level CRUD writer surface. Two
  create variants (per D7) — `create-in-workspace` (`--workspace`
  required + optional `--folder` / `--kind`) vs `create-on-column`
  (`--item` + `--column` against an existing file-shaped column).
  `rename` (`update_doc_name`), `delete --yes` (`delete_doc` — the
  destructive verb in the cluster), and `duplicate [--with-updates]`
  (`duplicate_doc`) round out the lifecycle. Backed by 4 Monday
  wire mutations.
- **M36** — `monday doc block-create/block-update/block-delete`
  ship the doc-block CRUD surface. `--type <DocBlockContentType>`
  takes one of 16 enum values (`normal_text` / `large_title` /
  `quote` / `bulleted_list` / `check_list` / `code` / `divider` /
  …) per D10 closure. `--content <json>` (parsed via the M27-lifted
  `parseJsonArg` helper). Per-type content payload shapes
  documented in `docs/output-shapes.md` "Per-block content shapes"
  reference table — 7 cassette-pinned variants + 9 TBD / inferred
  variants awaiting follow-up cassettes per D11.
- **M37** — `monday doc import-html/append-markdown` ship bulk
  doc-content import in a single wire round-trip (no per-block
  loop). `import-html` creates a new doc from an HTML payload;
  `append-markdown` appends blocks to an existing doc from a
  markdown payload. Both surface mutex argv sources
  (`--html <file|-> | --html-string <s>` /
  `--markdown <file|-> | --markdown-string <s>`) backed by the new
  generic `readSourceContent` helper at `src/utils/source-content.ts`
  (R-v0.5-NEW-18 lifted ahead-of-feat from M13's `readUpdateBody`
  — 5 consumers post-lift). Wire-side payload cap pre-empted at
  parse boundary via `MAX_DOC_IMPORT_PAYLOAD_BYTES = 256_000` per
  D13 empirical-probe pinning (rejected at 500KB, OK at 250KB on
  both surfaces).

**v0.6 (next):** multi-level subitems remain conditional on
Monday's data model surfacing them (slipped from v0.4 → v0.5 →
v0.6 across two consecutive release-preps — Monday's
`sub_items_board` still carries no `subtasks` column at API
`2026-01`); cross-board `item move` value-overrides (Monday's
`ColumnMappingInput` still carries no value slot — slipped twice
for the same reason); resumable cross-board cursor pagination
(per-board cursor-lifetime under aggregation needs design work);
files-shaped friendly column writes (`--set <file-col>=<path>` and
`--set-raw <file-col>=<json>` — `monday item upload` from v0.4-M31
is the verb-shaped alternative path agents should use today).

See [`docs/cli-design.md`](./docs/cli-design.md) §13 for the
full roadmap, [`docs/v0.5-plan.md`](./docs/v0.5-plan.md) for the
v0.5 milestone history, [`docs/v0.4-plan.md`](./docs/v0.4-plan.md)
for v0.4, [`docs/v0.3-plan.md`](./docs/v0.3-plan.md) for v0.3, and
[`docs/v0.2-plan.md`](./docs/v0.2-plan.md) for v0.2.

See [CHANGELOG.md](./CHANGELOG.md) for the per-release contract.

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
