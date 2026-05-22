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

**v0.9.0 (current — `monday-cli@0.9.0` on npm):**
the v0.8 surface PLUS the multi-level board cluster. Three pieces:
**(1) Multi-level subitem nesting works** — `monday item create
--parent <iid>` now succeeds on `multi_level` boards. This corrects
a SHIPPED-INCORRECT rejection in v0.8.0 that asserted a now-false
data-model claim ("Monday's `sub_items_board` carries no `subtasks`
column at `2026-01`") and carried a `details.deferred_to: "v0.9"`
slot — while shipping at v0.9. A 2026-05-22 dev-board probe sweep
proved Monday supports the nesting at the CLI's `2026-01` pin via
the host board's self-referencing `subtasks` column, so the gate is
deleted. Closes the M28 deferral (slipped v0.4 → v0.9). Classic
boards continue to reject (the `subtasks`-column self-reference
doesn't exist there) with an accurate message. **(2) Board
hierarchy is now readable** — `Board.hierarchy_type` (`"classic"` |
`"multi_level"`) surfaces in `monday board get`, `board list`,
`board describe`, and the create/update/archive/delete/duplicate
mutation projections, so agents branch on hierarchy without an
extra `describe` round-trip. **`monday board duplicate`** is
documented as the multi-level-board creation path
(`duplicate_board_with_pulses` preserves the source's hierarchy);
`monday board create` is always classic at `2026-01`
(`create_board` has no hierarchy argument). **(3) Board views are
now readable** — a new `monday board views <bid>` verb projects the
collection of views on a board (Kanban / Gantt / Calendar / Table /
Form / Chart / etc.) with all 13 wire fields per view 1:1.
`monday board describe` gains the same view collection under a
`views[]` slot. Verb shares the metadata cache with describe /
columns / groups (one fetch supports four reads). **No breaking
changes vs v0.8.0** — the M50 rejection deletion is a bug-fix
correction, not a contract re-shape (Monday supports the operation
v0.8.0 claimed unsupported); the output envelope + 29 stable error
codes are unchanged. **118 commands shipped** (+1 vs v0.8 —
`board views`). Built incrementally as M50 + M51 + M52.

**SDK-stall note.** v0.9 is the 4th consecutive release where
`@mondaydotcomorg/api` has stayed pinned at `^14.0.0` (no SDK 15.x
or 16.x publication in the window), so the v0.7-deferred M39 / M40
/ M41 cluster (gated on SDK 15.x baking `2026-04` natively) and the
v0.8-skeleton M44 / M45 user-entity migration (gated on SDK 16.x)
stay deferred a 4th consecutive release. The API stays pinned at
`2026-01`. See [CHANGELOG.md](./CHANGELOG.md) for the full
per-milestone release notes.

**v0.8.0 (the previous release):**
the v0.7 surface PLUS — most importantly — the 🚨 P1 file-upload
wire-format **FIX** (M49). Published v0.7.0 shipped the Apollo
multipart spec, which live Monday rejects, so `monday item upload` /
`monday update upload` / every friendly file `--set` was broken
against live Monday for five milestones (M31/M38/M42/M43/M46).
v0.8.0 emits Monday's native multipart shape (`query` + sibling
`variables` + string-`map` + named part, POSTed to `/v2/file`) and
is the **first release where file uploads actually work live**
(live-verified via a `RUN_LIVE_TESTS`-gated smoke test). On top of
the fix, three feature folds: multi-file `--set` per call across
update (single + bulk) + create (M46, lifting the single-file gate);
stdin file `--set <file-col>=-` with `--filename` (M47); and writable
create-time `board_relation` / `dependency` column settings via
`monday board column-create --type board_relation --settings
'{"boardIds":[…]}'` (M48). Plus an internal `src/api/` error-
decoration refactor cluster. **No breaking changes vs v0.7.0** — the
v0.8 surface is additive (the output envelope + 29 stable error codes
are unchanged); M49 is a fix that ships in the same minor. Built
incrementally as M49 + the refactor cluster + M46 + M47 + M48.

**v0.7.0 (the prior release):**
the v0.6 surface PLUS the two file-`--set` carve-outs deferred at
v0.6-M38 — bulk `monday item update --where ... --set <file-col>=
<path>` (M42, per-item multipart fan-out under `--concurrency` /
`--continue-on-error`) and create-time `monday item create --set
<file-col>=<path>` (M43, two-leg `create_item` + `add_file_to_
column` dispatch under the §5.8 orphan-warn atomicity envelope).
**No breaking changes vs v0.6.0** — the v0.7 surface is additive
(M42 + M43 only). Both close v0.6-M38 D5 / D6 deferrals so the
friendly file-`--set` form reaches every callShape (single-item /
bulk / create-time). **NOTE:** file uploads in published v0.7.0 are
live-broken (the M49 P1 above) — upgrade to v0.8.0 for working
uploads. The originally-planned Monday API `2026-04` pin bump (M39)
+ `monday item set-description` (M40) + `monday doc block-create-bulk`
(M41) DEFERRED at 2026-05-20 pending `@mondaydotcomorg/api` SDK 15.x.

**OAuth deferral (unchanged from v0.7.0).** `monday auth login` is
registered but the canonical Monday OAuth app is not registered in
v0.8.0; the verb surfaces a clear `usage_error.details.reason:
oauth_unregistered` pointing at `MONDAY_API_TOKEN`. Multi-profile
config + per-profile credentials cache work fully against API
tokens; OAuth registration revisits in v0.8.x / v0.9 contingent on
user demand.

**v0.6.0 (the earlier release):**
the v0.5 surface PLUS files-shaped friendly `--set <file-col>=<path>`
writes on `monday item set` + `monday item update` (single-item
paths), closing the v0.4 → v0.5 → v0.6 carry-over of the inline
form. Sibling-branch dispatch at the column-resolution boundary
routes file `--set` to the v0.4-M31 `add_file_to_column` multipart
wire; the friendly translator stays JSON-output-shaped for the 13
existing writable types. **No breaking changes vs v0.5.0** — the
v0.6 surface is additive (M38 only). Built as a single milestone
(M38). The bulk + create-time carve-outs deferred at v0.6-M38
(D5 / D6) carry forward to v0.7 (above).

**v0.5.0 (an even-earlier release):**
the v0.4 surface PLUS the full team-writer surface
(`monday user team-list/get/create/delete/add-members/remove-members`),
the full Monday workdocs CRUD mutation surface — doc-level
(`monday doc create-in-workspace/create-on-column/rename/delete/duplicate`),
doc-block (`monday doc block-create/block-update/block-delete`),
and doc-content import (`monday doc import-html/append-markdown`) —
closing the v0.4-M32 workdocs-mutation deferral. **16 new CLI
verbs across 9 wire mutations.** Built incrementally across M34–M37.

**v0.4.0 (a yet-earlier release):**
the v0.3 surface PLUS long-poll item activity streaming
(`monday item watch <iid>` — NDJSON), parallel bulk dispatch
(`monday item update --where ... --concurrency <N>`), asset uploads
(`monday item upload` / `monday update upload` — multipart wire),
Monday workdocs reads (`monday doc list` / `monday doc get` — full
workdocs CRUD mutation surface deferred to v0.5; shipped at v0.5),
and shell completion (`monday completion bash|zsh|fish`). Built
incrementally across M29–M33.

**v0.3.0 (an older release):**
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

**What v0.7 added (M42 + M43; full per-milestone narrative in
[CHANGELOG.md](./CHANGELOG.md)):**

- **M42** — `monday item update --where ... --set <file-col>=
  <path>` ships the bulk file-`--set` carve-out fold deferred at
  v0.6-M38 D5. Per-item multipart fan-out across the `--where`-
  resolved item-id set, dispatched through the existing v0.4-M30
  `dispatchParallel` over a shared `MultipartTransport`. `--
  concurrency 1..32` (default 1) opts into bounded parallel
  dispatch; `--continue-on-error` partitions per-item wire
  failures into the M25 partial-success envelope while leaving
  whole-call-abort semantics for the upfront local file pre-check
  (cli-design §5.8). New aggregate `data.summary` slots:
  `column_id` / `filename` / `file_size_bytes` echo the dispatched
  file alongside `matched_count` / `applied_count` / `failed_count`.
  Reuses M31's multipart wire verbatim + v0.6-M38's
  `executeFileColumnSet` runtime body — no new wire op. The pre-
  v0.7-M42 literal `"file_set_on_bulk_unsupported"` (the M38 D5
  rejection) stays RESERVED in docstrings + regression-guarded;
  the runtime path no longer surfaces it.

- **M43** — `monday item create --set <file-col>=<path>` ships
  the create-time file-`--set` carve-out fold deferred at v0.6-
  M38 D6. Two-leg dispatch: leg-1 `create_item` bundles the non-
  file `column_values` atomically into the wire call; leg-2
  `add_file_to_column` attaches the file to the newly-created
  item. Pair is non-atomic by construction — leg-2 failure
  surfaces `internal_error` with `details.reason: "create_then_
  file_upload_partial_failure"` + `details.created_item_id`
  echoing the leg-1 orphan + `details.column_id` + `details.
  cause` (M31 wire-failure projection) + `details.hint`
  directing agents to retry leg-2 alone (`monday item set <iid>
  <file-col>=<path>`) OR rollback (`monday item delete <iid>
  --yes`) per the §5.8 orphan-warn atomicity envelope (D1
  closure). `--dry-run` emits two `planned_changes` entries
  (`create_item` with bundled non-file `column_values`, then
  `add_file_to_column`); leg-2 carries no `item_id` slot because
  the item doesn't exist at dry-run time. Reuses M31's multipart
  wire + v0.6-M38's `executeFileColumnSet` runtime body — no new
  wire op. The pre-v0.7-M43 literal
  `"file_set_on_create_unsupported"` (the M38 D6 rejection) stays
  RESERVED + regression-guarded; the runtime path no longer
  surfaces it. The mixed-set mutex rule SUPPRESSED on
  `'item_create'` per D6 asymmetry — `create_item` natively
  bundles non-file `column_values` atomically into leg-1 so the
  multi-`--set` shape is legitimate at create time (universal
  multi-file mutex still applies — 2+ file entries reject as
  before).

- **Deferred from v0.7 (pending SDK 15.x with `CURRENT_VERSION
  = '2026-04'` natively):** M39 (Monday API pin bump `2026-01`
  → `2026-04`), M40 (`monday item set-description <iid>` via
  `set_item_description_content`), M41 (`monday doc block-
  create-bulk <did>` via `create_doc_blocks`). The original
  v0.7 framing collapsed to the M42 + M43 carve-out folds at
  2026-05-20 because (a) SDK 15.x hadn't published, (b) M40's
  empirical probe revealed paid-tier gating + opaque
  `INTERNAL_SERVER_ERROR { service: 'docs-api' }` on free-tier
  accounts, and (c) the string-literal API-version override
  carried maintenance overhead disproportionate to a single
  user-blocked verb. Findings preserved for the re-attempt
  session.

**What v0.6 added (M38; full per-milestone narrative in
[CHANGELOG.md](./CHANGELOG.md)):**

- **M38** — `monday item set <iid> <file-col>=<path>` +
  `monday item update <iid> --set <file-col>=<path>` ship the
  files-shaped friendly `--set` writer path, closing the v0.4 →
  v0.5 → v0.6 carry-over of the inline form. Sibling-branch
  dispatch at the column-resolution boundary routes file `--set`
  to the v0.4-M31 `add_file_to_column` multipart wire; the
  friendly translator stays JSON-output-shaped for the 13
  existing writable types (per D1 closure). Mutex rules
  (post v0.7-M42 + v0.7-M43 carve-out folds): exactly one
  file `--set` per call on every callShape (universal multi-
  file mutex — 2+ entries surface `usage_error.details.reason:
  "multi_file_set_unsupported"`); mixing a file `--set` with
  any value `--set` / `--set-raw` / `--name` surfaces `usage_
  error.details.reason: "mixed_file_and_value_sets"` on
  `'item_set'` / `'item_update_single'` / `'item_update_bulk'`,
  SUPPRESSED on `'item_create'` per v0.7-M43 D6 asymmetry
  (`create_item` natively bundles non-file `column_values`
  atomically into leg-1). The bulk `item update --where ...
  --set <file-col>=<path>` path shipped at v0.7-M42 (D5
  carve-out fold; per-item multipart fan-out under
  `--concurrency` / `--continue-on-error`); the create-time
  `item create --set <file-col>=<path>` path shipped at
  v0.7-M43 (D6 carve-out fold; two-leg `create_item` +
  `add_file_to_column` dispatch under the §5.8 orphan-warn
  atomicity envelope). The v0.6-M38 literals
  `"file_set_on_bulk_unsupported"` and
  `"file_set_on_create_unsupported"` stay RESERVED in
  docstrings + regression-guarded; the runtime path no longer
  surfaces them. `--set-raw <file-col>=<json>` STAYS REJECTED
  per D3 — Monday's wire has no JSON-shape for
  `change_column_value` on file columns; `monday item upload`
  from v0.4-M31 remains the verb-shaped alternative path. **No
  new ERROR_CODES** at M38 (registry stays at 29 — all
  rejections route through existing `usage_error` /
  `unsupported_column_type` / `not_found` / `validation_failed`
  codes with `details.reason` discrimination).

**v0.10 (next):** **Carry-forward backlog** (unpicked
candidates remain in cli-design.md §13 slipped-candidates list
pending future candidate-selection sessions). The v0.3-M28
multi-level subitem nesting deferral **SHIPPED** at v0.9-M50 —
the 2026-05-22 dev-board probe refuted the "Monday's
`sub_items_board` carries no `subtasks` column" premise (Monday
supports the nesting on multi-level boards via the host board's
self-referencing `subtasks` column at the CLI's `2026-01` pin),
so it leaves the backlog. Still deferred: the original v0.8
SKELETON's user-entity migration (M44) + `user activity` (M45) +
the Monday API `2026-07` pin defer pending
`@mondaydotcomorg/api` SDK 16.x; the v0.7-deferred M39 (API
`2026-04` pin) + M40 (`item set-description`) + M41 (`doc
block-create-bulk`) re-open when SDK 15.x ships `2026-04`
natively (M40 is feature-confirmed on `multi_level` boards by
the same 2026-05-22 probe — only the M39 SDK gate remains; v0.9
stayed on `2026-01`, SDK still 14.0.0, 4th consecutive
deferral); cross-board `item move` value-overrides (Monday's
`ColumnMappingInput` still carries no value slot — slipped four
times for the same reason); resumable cross-board cursor
pagination (per-board cursor-lifetime under aggregation needs
design work); profile-scoped argument defaults (filed at the
v0.6 kickoff candidate-selection session — extends `~/.monday-
cli/config.toml` with a `[profiles.<name>.defaults]` table
carrying scoping args; requires a prerequisite §13 carve-out
Decision at pre-flight distinguishing aliases-as-stored-
command-strings (still non-goal) from defaults-as-stored-flag-
values (carve-out)); `Item.description` read-side coverage
(filed at v0.9-M52 close, paired with the v0.7-M40 reopen
above — the read pairs naturally with the deferred mutation,
so both should re-open together when SDK 15.x publishes).

See [`docs/cli-design.md`](./docs/cli-design.md) §13 for the
full roadmap, [`docs/v0.6-plan.md`](./docs/v0.6-plan.md) for the
v0.6 milestone history, [`docs/v0.5-plan.md`](./docs/v0.5-plan.md)
for v0.5, [`docs/v0.4-plan.md`](./docs/v0.4-plan.md) for v0.4,
[`docs/v0.3-plan.md`](./docs/v0.3-plan.md) for v0.3, and
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
