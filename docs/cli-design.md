# CLI Design

> Status: design proposal. Nothing here is implemented yet — this is the
> blueprint that subsequent commits will build against. Updates land via
> PRs that argue for the change.

## 1. Audience and goals

**Primary user: AI coding agents.** Claude Code, Codex, Cursor agents,
shell-spawned subagents, and similar tools are the design centre. Every
ergonomics decision below tilts toward "predictable for software" before
"pleasant for humans". Humans get a good experience as a side-effect, but
when the two conflict, the agent wins.

What that means in practice:

- **Pipe-safe by default.** When stdout is not a TTY (i.e. piped or
  redirected), output is JSON — `monday item list | jq` always works
  without flags. When stdout *is* a TTY, output is a human-readable
  table with sensibly truncated values; agents running in pseudo-TTYs
  pass `--json` (an explicit alias for `--output json`) to force the
  machine format. This is a deliberate trade: agents pay one extra
  flag in pseudo-TTY contexts, humans get a friendly default in their
  terminal, and pipelines (the most common agent invocation pattern)
  Just Work.
- **Deterministic shapes.** Field names in the JSON schema don't change
  between releases except via SemVer-major. Adding a field is minor;
  removing or renaming is breaking. The output schema version is
  embedded in `meta.schema_version` (see §6) so agents can pin.
- **No interactive prompts.** The CLI never blocks for input. Anything
  that would prompt instead returns a structured error telling the
  caller what flag would have answered the prompt.
- **Stable error codes.** Errors carry a snake_case `code` field that's
  part of the public contract. Agents key off codes, not English
  messages.
- **Cheap discovery.** An agent encountering the CLI for the first time
  can introspect everything it needs (`monday schema`, `monday board
  describe`, `monday schema [<command>]`) without trial and error.
- **No telemetry, no surprise side-effects.** The only outbound calls
  go to Monday — never to anyone else — and only when a command needs
  them.

Secondary user: humans running ad-hoc queries from the terminal. They
get colour, truncated tables, and spinners — but only when stdout is a
TTY, and only via the same code paths that agents use, never via
parallel "human-friendly" alternatives that could drift.

## 2. Monday's API in one page

**API version pin.** The CLI pins to **Monday API `2026-01`** —
matching `CURRENT_VERSION` exported by the installed
`@mondaydotcomorg/api@14.0.0` SDK (verifiable in
`node_modules/@mondaydotcomorg/api/dist/esm/lib/constants/index.d.ts`).
The pin is sent on every request via the `API-Version` header.
Bumping the pin requires bumping the SDK in lockstep and is a
SemVer-minor (or major if any output schema changes). The user can
override the pin per-invocation with `--api-version` or per-environment
with `MONDAY_API_VERSION` — useful for opting into newer Monday API
versions (e.g. `2026-04`) ahead of an SDK bump, at the cost of needing
raw GraphQL for any fields the SDK can't type.

**SDK ↔ API drift.** Monday's live API moves quarterly; the SDK
catches up on its own cadence. Even at the pinned 2026-01 version,
the SDK's typed surface lags Monday's actual schema in places —
features like `BatteryValue` for status rollups,
`hierarchy_type` / `is_leaf` / `capabilities` for multi-level boards
appear in newer Monday versions but aren't typed by SDK 14.0.0. The
CLI handles this by:
1. Surfacing what the SDK types via the typed client (the common path).
2. Falling back to `client.request<T>()` raw GraphQL for fields beyond
   the SDK's coverage (escape hatch in `src/api/`).
3. Pinning to a tested SDK+API pair so the gaps are predictable.

**Boundary-typing trap.** The SDK exports `QueryVariables = Record<string, any>`
for raw `client.request()` arguments. The CLI's `src/api/` wrapper
must wrap this so the `any` doesn't leak into `commands/*` — internal
code should see `Record<string, unknown>` (or named GraphQL input
types) and parse at the boundary. Tracked in §14.

The schema map below was pulled from the live SDK types in
`node_modules/@mondaydotcomorg/api`.

```
Account
└── Workspace                 (groups boards by team)
    └── Folder                 (optional grouping inside a workspace)
        └── Board              (the spreadsheet — the central object)
            ├── Group          (a "section" of rows)
            │   └── Item       (a row — a task, ticket, etc.)
            │       ├── ColumnValue × N    (typed cells, see below)
            │       ├── Subitem × N        (item with parent_item set;
            │       │                       lives on a sibling sub-items board)
            │       ├── Update × N         (comment thread)
            │       └── Asset × N          (file attachments)
            └── Column         (column definition: id, type, settings)

User, Team, Tag, Webhook, Doc, Notification — global, not nested under boards.
```

### 2.1 Query roots (read)

- `me` — connected user
- `account` — connected account info
- `workspaces`, `folders`, `boards`, `items`, `users`, `teams`,
  `tags`, `docs`, `webhooks`, `updates`, `assets`
- `next_items_page(cursor)` — pagination continuation
- `items_page_by_column_values(board_id, columns)` — search by column
- `complexity` — current rate-limit budget
- `version`, `versions` — API version probing

### 2.2 Mutation roots (write) — the ones the CLI surfaces

Items: `create_item`, `create_subitem`, `change_column_value`,
`change_simple_column_value`, `change_multiple_column_values`,
`move_item_to_group`, `move_item_to_board`, `archive_item`,
`delete_item`, `duplicate_item`, `clear_item_updates`.

Boards: `create_board`, `update_board`, `archive_board`, `delete_board`,
`duplicate_board`, `add_users_to_board`, `delete_subscribers_from_board`,
`add_teams_to_board`.

Columns / groups: `create_column`, `change_column_metadata`,
`change_column_title`, `delete_column`, `create_group`, `update_group`,
`duplicate_group`, `archive_group`, `delete_group`.

Updates / comments: `create_update`, `edit_update`, `delete_update`,
`like_update`, `unlike_update`, `pin_to_top`, `unpin_from_top`.

Files: `add_file_to_column`, `add_file_to_update`.

Workspaces / teams: `create_workspace`, `update_workspace`,
`delete_workspace`, `add_users_to_workspace`,
`delete_users_from_workspace`, `create_team`, `delete_team`,
`add_users_to_team`, `remove_users_from_team`, `add_teams_to_workspace`.

Webhooks: `create_webhook`, `delete_webhook`.

Notifications: `create_notification`.

Tags: `create_or_get_tag`.

Apps/marketplace/docs/timeline mutations exist but are outside the CLI's
v1 scope.

### 2.3 Column types — 40+ kinds, three categories

The trickiest part of the API. Every column has one of ~40 types from
the `ColumnType` enum:

| Category | Types |
|----------|-------|
| **Simple writable** | `text`, `long_text`, `numbers`, `checkbox`, `link`, `email`, `phone`, `country`, `hour`, `rating`, `vote`, `tags`, `world_clock`, `week`, `color_picker`, `location` |
| **Structured writable** | `status`, `dropdown`, `date`, `timeline`, `people` (the deprecated singular `person` too), `team`, `board_relation`, `dependency`, `file`, `doc` |
| **Read-only / system** | `creation_log`, `last_updated`, `item_id`, `auto_number`, `name`, `formula`, `mirror`, `progress`, `subtasks`, `time_tracking`, `item_assignees`, `button`, `integration`, `unsupported` |

Reading: every column type has its own GraphQL type implementing
`ColumnValue` (e.g. `StatusValue`, `DateValue`, `PeopleValue`). The
shapes are all different.

Writing: `change_column_value(board_id, item_id, column_id, value: JSON)`.
The `value` is a JSON-stringified blob whose shape depends on the column
type. Examples:

| Column type | Writing shape (the `value` arg, stringified) |
|-------------|----------------------------------------------|
| `text` | `"some text"` (or use `change_simple_column_value` with a plain string) |
| `status` | `{"label": "Done"}` or `{"index": 1}` |
| `date` | `{"date": "2026-04-29", "time": "14:30:00"}` |
| `dropdown` | `{"labels": ["Backend"]}` (or `{"ids": [1]}`) |
| `people` | `{"personsAndTeams": [{"id": 12345, "kind": "person"}]}` |
| `link` | `{"url": "...", "text": "..."}` |
| `numbers` | `"42"` (string!) |
| `checkbox` | `{"checked": "true"}` |
| `timeline` | `{"from": "2026-01-01", "to": "2026-01-31"}` |
| `board_relation` | `{"item_ids": [123, 456]}` |

This is the single biggest UX problem with Monday's API. **The CLI's job
is to abstract this away.** See §5.3.

### 2.4 Pagination

The flat `items` query (no args) is deprecated. Modern path:

```graphql
boards(ids: [123]) {
  items_page(limit: 500, query_params: { rules: [...] }) {
    cursor
    items { id name column_values { ... } }
  }
}
# then:
next_items_page(cursor: "...") { cursor items { ... } }
```

- Page size: ≤ 500
- Cursor lifetime: 60 minutes from the *initial* `items_page` call
- `query_params` supports filter rules (`column_id` + operator +
  `compare_value`), AND/OR rule groups, `order_by`, and `ids` (max 100).

### 2.5 Rate limits and complexity

Five distinct limits, all reported with a `retry_in_seconds` field
(or a `Retry-After` HTTP header for the IP/locked-resource cases):

- **Per-minute query count:** 1k–5k depending on plan tier (Pro 2.5k,
  Enterprise 5k). Specific endpoints stricter (e.g. board create: 40/min).
- **Complexity points:** 5M–10M points/min depending on auth method.
  Each field has a cost; large item-list queries can exhaust this fast.
  You can probe via the `complexity` field on any query.
- **Daily call cap** — account-level ceiling on total calls per day.
- **Concurrency cap** — simultaneous in-flight requests per token.
- **IP rate cap** — per-source-IP limiter (matters for shared egress).
- **Resource locks (HTTP 423)** — Monday returns `423 Locked` when a
  resource is being mutated by another writer; treat as a transient
  retry condition.

Error codes the CLI maps:
| Monday signal | CLI `error.code` | HTTP | Carries |
|---------------|------------------|------|---------|
| `ComplexityException` | `complexity_exceeded` | 200* | `retry_in_seconds` |
| `Minute limit rate exceeded` | `rate_limited` | 429 | `retry_in_seconds` |
| `DAILY_LIMIT_EXCEEDED` | `daily_limit_exceeded` | 200* | (often no retry) |
| `Concurrency limit exceeded` | `concurrency_exceeded` | 200* | `retry_in_seconds` |
| `IP_RATE_LIMIT_EXCEEDED` | `ip_rate_limited` | 429 | `Retry-After` |
| (locked resource) | `resource_locked` | 423 | `Retry-After` |

\* Monday returns most application-level errors as HTTP 200 with an
`errors` array in the body — the CLI normalises these to non-zero
exit codes and a stderr error envelope (see §6.5).

**Retry behaviour.** The CLI applies exponential backoff with jitter
on `rate_limited`, `complexity_exceeded`, `concurrency_exceeded`,
`ip_rate_limited`, `resource_locked`, and `network_error` — capped at
`--retry <n>` (default 3). It does **not** retry `daily_limit_exceeded`,
`unauthorized`, `forbidden`, `validation_failed`, or `not_found`.
If the underlying SDK / `graphql-request` adds its own retry layer in
a future version, the CLI must disable that to avoid double-retry
(tracked in §14).

### 2.6 Auth

Three auth methods:
1. **Personal API token** (admin/member only; admin panel) — header
   `Authorization: <token>`, no `Bearer ` prefix.
2. **OAuth** (apps) — user grants permission, app receives access token.
3. **Short-lived JWT** (browser-embedded apps) — `seamlessApiClient`
   handles this; not relevant to CLI use.

CLI v1: personal token only (env or `.env`). v2: OAuth flow with
profile-based credentials cache.

### 2.7 Monday Dev — convention, not API

Monday Dev has no dedicated API. It's a template that ships with named
boards (Tasks, Bugs, Sprints, Epics, Releases) wired together via
`board_relation` columns and standard `status`/`person`/`date` columns
configured a certain way. The CLI's `monday dev …` namespace is **pure
convenience** that resolves the right board IDs from per-profile config.

### 2.8 Multi-level boards and rollup columns

Monday's recent API versions surface multi-level board hierarchies
(up to **5 subitem layers**) and rollup columns that aggregate values
from
linked items. Two consequences:

- **Status rollups read as `BatteryValue`, not `StatusValue`.**
  The display value is a battery-style aggregate of the underlying
  status distribution — not a single label. The CLI surfaces this
  with `type: "battery"` in §6.1's column-value shape; agents that
  expect a single `label` on a column they thought was `status` will
  hit `unsupported_column_type` if they pass `--set` against it
  (battery columns are read-only).
- **Rollup columns require `capabilities: [CALCULATED]`** on the
  column metadata to opt-in to inclusion in queries. The CLI's
  `monday board describe` requests this capability so rollup values
  appear in the output.
- **`hierarchy_type` / `is_leaf`** distinguish parent boards from
  sub-items boards in the multi-level model. SDK 14.0.0 does not type
  these fields; the CLI fetches them via raw GraphQL.

### 2.9 Other column-write quirks worth knowing

- **File column clear** — to remove all files from a `file` column,
  send `value: {"clear_all": true}`. This is destructive and not
  reversible via the API; the CLI treats it as needing `--yes`.
- **Formula columns** — read-only with a Monday-imposed cap on the
  rendered display value's size. If a formula's output is truncated,
  Monday returns the truncated string with no indicator; agents should
  not rely on formula output for canonical data.
- **Mirror columns** — read-only; reflect a column from a linked
  board. When Monday can't resolve the linked item, mirror returns an
  empty `display_value` with no error. The CLI surfaces `text` (the
  rendered value) and `mirrored_items` (the underlying refs) so
  agents can detect this.
- **`change_simple_column_value` vs `change_column_value`** — the
  "simple" form takes a plain string and works for `text`, `numbers`,
  `phone`, `email`, `link.text-only`, `country`, `hour`. The full form
  takes JSON and is required for everything else. The CLI picks the
  right form per column type automatically.

## 3. Design principles

### 3.1 Agent-first ergonomics — the load-bearing rules

1. **stdout is the result; stderr is for human-only signal.**
   Spinners, progress indicators, debug logs (under `--verbose`),
   and TTY-mode follow-up hints all go to stderr. `monday item list
   | jq` must always work — nothing the JSON consumer cares about
   ends up on stderr. **Note:** structured warnings (the
   `warnings: []` array in §6's envelope) are **part of the JSON
   response** and ride on stdout — agents read them programmatically.
   Stderr only carries human-readable rendering of those same
   warnings, and only in TTY/table mode.
2. **Default output: table on TTY, JSON when piped.** Pipes auto-switch
   to JSON so `monday item list | jq` Just Works without flags.
   Humans typing in a terminal see a friendly, truncated table.
   Agents running in a pseudo-TTY (Claude Code, Codex's shell tool,
   etc.) explicitly pass `--json` (alias for `--output json`) — one
   flag, totally unambiguous, no auto-detect surprises. `MONDAY_OUTPUT`
   env var pins the default per-environment for sticky agent contexts.
3. **Single canonical JSON schema per command.** The JSON shape of
   `monday item get`'s output doesn't change based on flags. `--minimal`
   may omit non-essential fields (like column titles), `--include-updates`
   adds them — but field *names* and *types* stay stable, and the
   `meta.schema_version` reflects the contract version.
4. **Errors are a structured envelope on stderr with a stable `code`.**
   See §6.5. Agents key off `error.code`, never English messages.
5. **Exit codes are part of the contract:** 0 success, 1 usage,
   2 API/network, 3 config, 130 SIGINT. Documented in
   `architecture.md`; this design doesn't change them.
6. **Idempotency is documented per command.** Output envelope includes
   a `created` boolean (in `data` for upsert-style commands). Mutations
   carry a `--dry-run` that prints the planned change without executing.
7. **No interactive prompts. Ever.** Confirmation flags (`--yes`)
   short-circuit any "are you sure?" path. Without `--yes`, destructive
   commands fail fast with `code: "confirmation_required"`.
8. **Deterministic ordering.** Lists default to ordered output (by ID,
   ascending) regardless of Monday's response order, unless
   `--order-by` is set.
9. **Self-documenting.** `monday schema <command>` returns a JSON
   Schema description of the command's input flags and output shape.
   `--help` is for humans; `monday schema` is for agents.
10. **Telemetry-free.** No analytics calls. No update checks (defer
    `update-notifier` until requested).

### 3.2 Human ergonomics (TTY only)

When stdout is a TTY and `--output` is unset:

- **Tables** for collections via `cli-table3` (or similar). Long
  string values are truncated to fit the terminal width — see
  "Truncation" below.
- **Progress spinners** on long ops (ora; auto-disables under `CI=1`).
- **Colour** for status/severity (chalk; respects `NO_COLOR`,
  `FORCE_COLOR`, `CI`).
- **Concise follow-up hints** on stderr ("ran out of items? try
  `monday item list … --all`"). Suppressible with `--quiet` or
  `MONDAY_NO_HINTS=1`. Hints **never** go to stdout.
- Switching to a pipe disables tables, spinners, colour, and hints
  silently. No flags needed.

**Truncation.** Table cells are truncated based on terminal width
(`process.stdout.columns`), divided across the visible columns with a
small floor (12 chars) per column. Truncated values get a trailing `…`
(single character ellipsis). Three knobs:

- `--width <N>` — force a target terminal width.
- `--full` — disable truncation; long values wrap or overflow.
- `--columns <c1,c2,...>` — show only these columns (by ID or title).

**Truncation never affects JSON output.** JSON values are always
returned in full; truncation is a presentation concern only. This is
deliberate — agents asking for JSON should never have to worry about
losing data to display logic.

**Exclusivity.** `--json` and `--output table` are mutually exclusive;
passing both is a `usage_error`. So is asking for `--full` with
`--json` (it's a no-op, but a noisy one — flag it).

## 4. Command surface

Two-level structure: `monday <noun> <verb> [args] [flags]`. Two levels
deep is the cap — agents lose track of three-level trees.

### 4.1 Top-level nouns

| Noun | Wraps Monday concept | Notes |
|------|---------------------|-------|
| `account` | account, me, version, complexity | Probes and self-info. |
| `workspace` | Workspace, Folder | Folder ops nested under workspace. |
| `board` | Board, Column, Group | Columns/groups are board-scoped, so they live here. |
| `item` | Item, Subitem, ColumnValue | Subitem is `item create --parent`. |
| `update` | Update, Reply, Like, Pin | Comment threads on items. |
| `user` | User, Team | Team ops nested under user. |
| `webhook` | Webhook | Board-scoped. |
| `doc` | Document | Read-only in v1. |
| `notification` | Notification | Send only. |
| `dev` | Monday Dev convenience | Sprint, epic, release shortcuts. |
| `cache` | Local board-metadata cache | Inspect, clear. |
| `config` | Effective config | Show resolved env, mask token. |
| `raw` | Arbitrary GraphQL escape hatch | For agents that need a query the CLI doesn't surface. |
| `schema` | Local introspection | Returns CLI command schema as JSON. |

### 4.2 Verb vocabulary

Standard verbs across nouns (only used where they make sense):

- `list` — read collection (paginated; `--all` to auto-paginate)
- `get` — read one by ID
- `find` — read one by name (errors if ambiguous; `--first` to silence)
- `search` — full-text or column-value search (uses
  `items_page_by_column_values`)
- `create` — new resource
- `update` — modify existing
- `delete` — hard delete
- `archive` — soft delete (most resources)
- `move` — relocate (e.g. item to group, item to board)
- `duplicate` — copy
- `describe` — full details inc. schema (more than `get`)
- `watch` — poll for changes (long-running; emits NDJSON)

### 4.3 Full command tree

Below, `<bid>` = board ID, `<iid>` = item ID, `<cid>` = column ID, etc.
Bracketed flags `[--xxx]` are optional; angle-bracketed `<arg>` are
required positionals. **Phase markers** in the right column show
which release each command lands in. Agents reading this tree as
ground truth should ignore commands beyond the active version.

```
COMMAND                                                                      PHASE

# === ACCOUNT ===
monday account whoami                                                        v0.1
monday account info                       # account name, plan, limits       v0.1
monday account version                    # API version in use               v0.1
monday account complexity                 # remaining complexity budget      v0.1

# === WORKSPACE ===
monday workspace list                     # all visible workspaces           v0.1
monday workspace get <wid>                                                   v0.1
monday workspace folders <wid>            # folders inside workspace         v0.1
monday workspace create --name <n> [--kind open|closed]                      v0.2
monday workspace update <wid> [--name <n>] [--kind ...]                      v0.2
monday workspace delete <wid> --yes                                          v0.2
monday workspace add-users <wid> --users <id|email>,...                      v0.2
monday workspace remove-users <wid> --users <id|email>,...                   v0.2

# === BOARD ===
monday board list [--workspace <wid>] [--state active|archived|all]          v0.1
monday board get <bid>                                                       v0.1
monday board find <name> [--workspace <wid>] [--first]                       v0.1
monday board describe <bid>               # full schema; see §11.2           v0.1
monday board doctor <bid>                 # diagnostics; see §11.2           v0.1
monday board subscribers <bid>                                               v0.1
monday board favorites                    # current user's starred boards   v0.3
                                          # natural scoping lever for v0.3
                                          # cross-board `item search`
monday board create --name <n> [--workspace <wid>] [--kind public|private|share]  v0.2
monday board update <bid> [--name <n>] [--description <d>]                   v0.2
monday board archive <bid> --yes                                             v0.2
monday board delete <bid> --yes                                              v0.2
monday board duplicate <bid> [--name <n>] [--workspace <wid>]                v0.2
monday board add-users <bid> --users <id|email>,...                          v0.2

# Columns (board-scoped)
monday board columns <bid>                # list columns                     v0.1
monday board column-create <bid> --type <type> --title <t> [--description <d>]   v0.2
monday board column-update <bid> <cid> [--title <t>] [--description <d>]     v0.2
monday board column-delete <bid> <cid> --yes                                 v0.2

# Groups (board-scoped)
monday board groups <bid>                                                    v0.1
monday board group-create <bid> --name <n> [--position top|bottom]           v0.2
monday board group-update <bid> <gid> [--name <n>] [--color <c>]             v0.2
monday board group-archive <bid> <gid>                                       v0.2
monday board group-duplicate <bid> <gid>                                     v0.2
monday board group-delete <bid> <gid> --yes                                  v0.2

# === ITEM ===
# All item commands take EITHER a positional <iid> OR can resolve the board
# via --board <bid>. Some operations (item set/update with --set) require
# board context — when not derivable from <iid>, --board is required.
# See §5.3 for board_id resolution and §5.5 for --where filter rules.
monday item list --board <bid> [--group <gid>] [--where <expr>]... [--filter-json <json>] [--state active|archived|all] [--all] [--limit <N>]   v0.1
monday item get <iid>                     # single item with column values   v0.1
monday item find <name> --board <bid> [--first]                              v0.1
monday item search --board <bid> --where <col>=<val>...                      v0.1
                                          # uses items_page_by_column_values
                                          # cross-board (omit --board): v0.3
monday item set <iid> (<col>=<val> | --set-raw <col>=<json>) [--board <bid>]   # single column write   v0.1 (--set-raw v0.2)
                                          # positional <col>=<val> uses friendly translator (§5.3)
                                          # --set-raw skips translation; agent supplies wire-shape JSON
monday item clear <iid> <col> [--board <bid>]       # clear column value     v0.1
monday item clear --board <bid> <col> (--where <c>=<v>... | --filter-json <json>) [--yes] [--dry-run]   v0.2
                                          # bulk clear — same gating as item update --where
                                          # live (non-empty match): requires --yes unless --dry-run is set
monday item update <iid> [--name <n>] [--set <col>=<val>]... [--set-raw <col>=<json>]... [--board <bid>] [--create-labels-if-missing]   v0.1 (--set-raw v0.2)
                                          # single-item multi-column atomic update
                                          # at least one of --name / --set / --set-raw required
                                          # --set and --set-raw against the same <col> → usage_error
monday item update --board <bid> (--where <c>=<v>... | --filter-json <json>) [--name <n>] [--set <col>=<val>]... [--set-raw <col>=<json>]... [--create-labels-if-missing] [--yes] [--dry-run]   v0.1 (--set-raw v0.2)
                                          # bulk update — at least one of --name / --set / --set-raw required
                                          # live (non-empty match): requires --yes unless --dry-run is set
                                          # --dry-run takes precedence over --yes when both are passed
                                          # --continue-on-error (partial-success envelope): v0.3
monday item create --board <bid> --name <n> [--group <gid>] [--set <col>=<val>]... [--set-raw <col>=<json>]... [--parent <iid>] [--position before|after --relative-to <iid>]   v0.2
                                          # --name empty after trim → usage_error
                                          # duplicate resolved column IDs across --set / --set-raw
                                          # entries → usage_error (covers --set + --set, --set-raw
                                          # + --set-raw, and --set + --set-raw permutations;
                                          # resolution-time enforced — see §5.3)
                                          # --set / --set-raw values bundle into the single
                                          # create_item / create_subitem mutation — single
                                          # round-trip, no post-create fallback (see §5.8)
                                          # --parent <iid> → create_subitem; column resolution
                                          # targets the subitems board, not the parent's board.
                                          # Classic boards only — multi-level boards rejected
                                          # with usage_error carrying details.hierarchy_type;
                                          # multi-level subitem support deferred to v0.3
                                          # --parent is mutually exclusive with --group and
                                          # --position/--relative-to (subitems don't live in
                                          # groups; their position is parent-scoped, not
                                          # relative-to-arbitrary-item)
                                          # --position and --relative-to are required together;
                                          # one without the other → usage_error
                                          # --relative-to must reference an item on the same board
monday item upsert --board <bid> --name <n> --match-by <col>[,<col>...] [--set <col>=<val>]... [--set-raw <col>=<json>]... [--create-labels-if-missing] [--dry-run]   v0.2
                                          # idempotency-cluster verb (M12). 0 matches → create_item;
                                          # 1 match → change_multiple_column_values with synthetic
                                          # `name` (same wire shape as `item update --name --set`);
                                          # 2+ matches → `ambiguous_match` with details.candidates.
                                          # `--match-by` accepts column tokens (resolved via the same
                                          # resolver `--set` uses) plus the literal `name`
                                          # pseudo-token; the match value comes from `--name <n>`
                                          # for `name` and from the corresponding `--set <token>=
                                          # <value>` for each column token. AND-combined.
                                          # Sequential-retry idempotent only — concurrent agents
                                          # observing zero matches both create; the next call
                                          # surfaces the duplicate as `ambiguous_match`. Race
                                          # mitigation: pick a stable hidden-key column for
                                          # `--match-by`. Concurrent-write protection: v0.4 (§9.3).
                                          # `--set-raw <col>=<json>` participates in column updates
                                          # but cannot appear in `--match-by` (JSON wire shapes
                                          # aren't filter-comparable scalars).
                                          # `data.operation: "create_item" | "update_item"` slot
                                          # exposes the branch (§6.4); dry-run encodes the same
                                          # via `planned_changes[0].operation`.
monday item move <iid> --to-group <gid> [--to-board <bid>] [--columns-mapping <json>]   v0.2
                                          # Two transports under one verb:
                                          # `--to-group <gid>` alone → same-board move
                                          # via `move_item_to_group` (no metadata loads).
                                          # `--to-group <gid> --to-board <bid>` →
                                          # cross-board move via `move_item_to_board`.
                                          # Monday requires `group_id: ID!` on the target
                                          # board, so `--to-group` is mandatory for both
                                          # forms. `--to-board <bid>` alone (no
                                          # `--to-group`) → `usage_error`.
                                          # `--columns-mapping <json>` is cross-board-only;
                                          # passing it without `--to-board` → `usage_error`.
                                          # Strict default per §8 decision 5 — source
                                          # column IDs that don't appear on target AND
                                          # aren't bridged by --columns-mapping →
                                          # `usage_error` with `details.unmatched: [...]` +
                                          # `details.example_mapping`.
                                          # `--columns-mapping {}` is the explicit "drop
                                          # everything (Monday's permissive default)" opt-in.
                                          # Mapping value form: `{<src>: <target>}` (string-
                                          # to-string). The richer `{id, value?}` form for
                                          # value-overrides is deferred to v0.3 (Monday's
                                          # `ColumnMappingInput` carries no value slot;
                                          # supporting it requires a non-atomic post-move
                                          # `change_multiple_column_values`). Agents needing
                                          # overrides fire `monday item set <iid>
                                          # <target>=<value>` post-move.
                                          # `--dry-run` previews the source-item snapshot +
                                          # the planned `column_mappings` for cross-board
                                          # (still raises `usage_error` on unmatched —
                                          # agents shouldn't have to interpret a "would-fail"
                                          # dry-run shape).
                                          # Idempotent: false (verb-level conservative bound;
                                          # `move_item_to_group` is wire-level no-op when
                                          # already in target group per §9.1, but
                                          # `move_item_to_board` re-running on the target
                                          # board is undefined SDK behaviour).
monday item duplicate <iid> [--with-updates]                                 v0.2
                                          # creative verb — no `--yes` gate
                                          # (the gate is for destructive ops
                                          # only per §3.1 #7; re-running this
                                          # creates a second duplicate).
                                          # `--with-updates` copies the
                                          # source item's updates (Monday's
                                          # `with_updates` boolean).
                                          # `--dry-run` previews the would-
                                          # duplicate item via single-leg
                                          # `ItemDuplicateRead`; live is
                                          # two-leg (board lookup +
                                          # `duplicate_item` mutation —
                                          # Monday requires `board_id`).
                                          # Idempotent: false. Mutation
                                          # envelope `data` extends with
                                          # `duplicated_from_id` (lineage
                                          # echo per §6.4 line 1827-1831's
                                          # upsert precedent).
monday item archive <iid> --yes                                              v0.2
                                          # --yes mandatory for live archive
                                          # (destructive — Monday's 30-day
                                          # recovery window is the only way
                                          # back; no `unarchive` mutation
                                          # exists, see §5.4). Without --yes
                                          # → confirmation_required (exit 1).
                                          # --dry-run previews the would-
                                          # archive item without --yes.
                                          # Idempotent: re-archiving an
                                          # already-archived item is a no-op
                                          # on Monday's side (§9.1 table).
monday item delete <iid> --yes                                               v0.2
                                          # --yes mandatory for live delete.
                                          # Re-deleting an already-deleted
                                          # item surfaces `not_found` — the
                                          # mutation itself is idempotent
                                          # past the first call, but the
                                          # CLI marks `idempotent: false`
                                          # because re-running with the
                                          # same args after an interim
                                          # `monday item create` would
                                          # delete the *new* item.
                                          # No `restore` — see §5.4
monday item watch <iid> [--interval 30s] [--until-status <label>]            v0.4
                                          # polls; emits NDJSON change events
monday item history <iid>                 # activity log: status / col / assign  v0.3
                                          # changes + comments, chronological

# Subitems
monday item subitems <iid>                # list children                    v0.1
                                          # subitem creation = item create --parent <iid> (v0.2)

# === UPDATE (comments) ===
monday update list <iid>                  # comments on an item              v0.1
                                          # --with-replies: thread expansion (v0.2)
monday update list --board <bid>          # all updates across the board     v0.2
monday update get <uid>                                                      v0.1
monday update create <iid> --body <md> | --body-file <path>                  v0.1
                                          # markdown rendered to HTML;
                                          # in v0.1 because workflow shortcuts depend on it
monday update reply <uid> --body <md> | --body-file <path>                   v0.2
monday update edit <uid> --body <md> | --body-file <path>                    v0.2
monday update delete <uid> --yes                                             v0.2
monday update like <uid>                                                     v0.2
monday update unlike <uid>                                                   v0.2
monday update pin <uid>                                                      v0.2
monday update unpin <uid>                                                    v0.2
monday update clear-all <iid> --yes       # delete all updates on item       v0.2

# === USER ===
monday user list [--name <n>] [--email <e>] [--kind all|guests|non_guests]   v0.1
monday user get <uid>                                                        v0.1
monday user me                            # alias for `account whoami`       v0.1

# Teams (nested under user)
monday user team-list                                                        v0.4
monday user team-get <tid>                                                   v0.4
monday user team-create --name <n> [--description <d>] [--users <id>,...]    v0.4
monday user team-delete <tid> --yes                                          v0.4
monday user team-add-members <tid> --users <id|email>,...                    v0.4
monday user team-remove-members <tid> --users <id|email>,...                 v0.4

# === WEBHOOK (board-scoped; CLI never *receives*) ===
monday webhook list <bid>                                                    v0.3
monday webhook create <bid> --url <u> --event <e> [--config <json>]          v0.3
monday webhook delete <wid> --yes                                            v0.3

# === DOC (read-only in v0.4) ===
monday doc list [--workspace <wid>]                                          v0.4
monday doc get <did>                                                         v0.4

# === NOTIFICATION ===
monday notification send --user <uid> --target <iid|bid> --target-type item|board --text <t>   v0.3

# === DEV (workflow shortcuts; see §5.2 carve-out, §5.9) ===
monday dev discover [--apply]             # auto-detect & write config       v0.3
monday dev configure [--tasks-board <bid>] [--sprints-board <bid>] ...       v0.3
monday dev doctor                         # diagnostics; see §11.3           v0.3
monday dev sprint current                                                    v0.3
monday dev sprint list [--state active|past|future]                          v0.3
monday dev sprint items <sid>                                                v0.3
monday dev epic list [--state active|done]                                   v0.3
monday dev epic items <eid>                                                  v0.3
monday dev release list                                                      v0.3
monday dev task list [--mine] [--status not_done] [--sprint current]         v0.3
monday dev task start <iid>               # status → "Working on it"         v0.3
monday dev task done <iid> [--message <m>] # status → "Done" + optional update v0.3
monday dev task block <iid> --reason <r>  # status → "Stuck" + comment       v0.3

# === RAW (escape hatch) ===
monday raw <query> [--vars <json>] [--allow-mutation] [--operation-name <n>] v0.1
monday raw --query-file <path> [--vars-file <path>] [--allow-mutation]       v0.1
                                                    [--operation-name <n>]

# === SCHEMA ===
monday schema                             # full CLI schema as JSON Schema   v0.1
monday schema <command>                   # JSON Schema for one command      v0.1

# === CACHE ===
monday cache list                         # what's cached                    v0.1
monday cache clear [--board <bid>]                                           v0.1
monday cache stats                                                           v0.1

# === CONFIG ===
monday config show                        # resolved config (token redacted) v0.1
monday config path                        # location(s) considered           v0.1

# === DIAGNOSTICS ===
monday status                             # connectivity + auth probe        v0.3
                                          # short-circuits on DNS / TCP / TLS / 401
                                          # without touching account state;
                                          # bundles api-version + cache dir +
                                          # redaction self-test
monday usage                              # rolling 24h API budget remaining v0.3
                                          # complements per-query `account
                                          # complexity`; agents self-throttle
                                          # ahead of bulk operations

# === HELP / VERSION (commander defaults) ===
monday --help                                                                v0.1
monday --version                                                             v0.1
monday <noun> --help                                                         v0.1
```

**Positional vs `--board` convention.** Where a command operates on
a single board (everything under `monday board`, `monday item list`,
`monday item create`, `monday item search`, `monday item find`),
the board is passed via `--board <bid>` rather than a positional —
this keeps `<iid>` available as a positional on item-scoped
commands without ambiguity. Item-scoped commands (`item get`,
`item set`, `item update`, etc.) take the item ID as a positional;
they only need `--board` when board context can't be derived from
the item (see §5.3).

### 4.4 Global flags

Available on every command:

| Flag | Default | Effect |
|------|---------|--------|
| `--output <fmt>` | `table` (TTY) / `json` (non-TTY); override via `MONDAY_OUTPUT` | `json`, `table`, `text`, `ndjson` |
| `--json` | — | Shorthand for `--output json`. Use this in agent contexts. |
| `--table` | — | Shorthand for `--output table`. Mutually exclusive with `--json`. |
| `--full` | off (TTY only) | Disable table value truncation — wrap or overflow instead. |
| `--width <N>` | terminal columns | Force table target width (TTY only). |
| `--columns <c1,...>` | all | Show only these columns (by ID or title) in table output. |
| `--minimal` | off | Omit non-essential descriptive fields (e.g. column `title`) from JSON output. |
| `--quiet` / `-q` | off | Suppress stderr progress and follow-up hints. Errors still go to stderr. |
| `--verbose` / `-v` | off | Debug logs to stderr (request bodies, complexity cost). Tokens always redacted. |
| `--no-color` | auto (respects `NO_COLOR`, `FORCE_COLOR`, `CI`) | Disable colour. |
| `--no-cache` | off | Skip the local board-metadata cache. |
| `--profile <name>` | from `MONDAY_PROFILE` | Selects credentials/config block (deferred to v0.3). |
| `--api-version <v>` | `2026-01` (pinned to match SDK 14.0.0; override via env) | Sets `API-Version` request header. |
| `--timeout <ms>` | from env / 30000 | Per-request timeout. |
| `--retry <n>` | 3 | Max retries on transient errors (with backoff + jitter). |
| `--dry-run` | off | Mutations: print planned change, don't execute. |
| `--yes` / `-y` | off | Skip confirmation gate on destructive ops. |
| `--body-file <path>` | — | Where a command takes a `--body` (long-form text), read it from this file. `--body-file -` reads stdin. Avoids shell-quoting hell for multi-line markdown. |

The `monday raw` command additionally takes `--query-file <path>` /
`--vars-file <path>` for the GraphQL document and variables (each
also accepts `-` for stdin), `--allow-mutation` (required to send
`mutation` operations — read paths are safe-by-default), and
`--operation-name <name>` (required when the document defines more
than one executable operation). These are subcommand-scoped, not
global, because they're raw-only (M6 close — Codex pass-2 alignment
note).

## 5. Where the CLI diverges from the API (and why)

Monday's GraphQL is well-designed for apps but several of its ergonomic
choices fight against a CLI. Each divergence below is a deliberate
trade.

### 5.1 Verb normalisation

Monday's mutation names are inconsistent: `create_item`,
`change_column_value`, `move_item_to_group`, `archive_board`,
`add_users_to_board`. The CLI normalises to a small verb vocabulary
(`create`, `update`, `set`, `move`, `archive`, `add-users`, …). One
concept = one verb across nouns.

### 5.2 Two-level depth, not three (with one carve-out)

Monday models things like "the column values of an item of a board".
That's three levels deep. The CLI flattens:
- `monday item set <iid> <col>=<val>` not `monday item column-value
  change <iid> <cid> <val>`.
- `monday item move <iid> --to-group <gid>` not `monday item move-to-
  group <iid> <gid>`.

Cost: a few flags carry information that's structural in GraphQL.
Benefit: every CRUD command stays under ~3 positional args.

**Carve-out: workflow namespaces may be three levels deep.** The
`dev` namespace (and any future workflow shortcuts like `service` or
`crm`) explicitly opts into a third level — `monday dev sprint
current`, `monday dev task done <iid>`. The reasoning: workflow
shortcuts are *purpose-built compositions* over the standard CRUD
surface, and their value comes from naming a workflow concept
(`sprint`, `epic`, `release`, `task`) that doesn't exist as a Monday
entity. Flattening them to `monday dev-sprint current` would lose the
hierarchy that makes them discoverable. The two-level rule applies to
the CRUD surface (`account`, `board`, `item`, `update`, `user`,
`webhook`, `doc`, etc.); workflow namespaces are the explicit
exception, not the default.

### 5.3 The column-value abstraction (the big one)

Raw API: `change_column_value(board_id, item_id, column_id, value: JSON)`,
where `value` is a column-type-specific JSON blob the user must
construct correctly.

CLI: `monday item set <iid> <col>=<val>`. The CLI:

1. **Resolves `board_id`.** `change_column_value` requires it, but
   most CLI commands take only an item ID. Two paths:
   - **Explicit (preferred):** `--board <bid>` skips a lookup and is
     authoritative — the resolver works against the user-provided
     board, even if the item actually lives elsewhere.
   - **Implicit:** the CLI calls `items(ids: [<iid>])` to get
     `board.id`, then proceeds. Caches the item→board mapping for the
     lifetime of the process.
   When ambiguity is impossible (the agent already passed `--board`),
   the implicit lookup is skipped entirely. The same `<board_id>`
   resolution applies to `--set-raw <col>=<json>` (v0.2): the raw
   payload bypasses the friendly translator but the column still
   resolves through the standard board metadata, so `--board <bid>`
   has the same effect on both flags.

   **`--board` / item-board mismatch.** If `--board <bid>` is passed
   and the item actually lives on a different board, the live path
   trusts `--board` and proceeds (the resolver hits the user-named
   board's columns; column IDs are board-scoped, so resolution
   typically fails with `column_not_found` and the cache-miss
   refresh re-confirms). `--dry-run` is stricter, but the
   mismatch check fires **late** in the dry-run pipeline — only
   after column resolution, archived-state checks, value
   translation, and duplicate-token checks have all passed
   against the requested board. The pipeline reads the item
   *after* those steps, then compares `item.board.id` against
   `--board`. So a wrong `--board` can still surface earlier
   typed errors first (`column_not_found`, `column_archived`,
   `unsupported_column_type`, translator `usage_error` for
   invalid dates / empty dropdowns / unknown emails, duplicate
   target). When all of those pass and boards diverge, dry-run
   returns `usage_error` with `details.item_board_id` (the
   item's real board) and `details.requested_board_id` (the
   `--board` value) so the agent can self-correct rather than
   committing a write against the wrong board.
2. **Resolves `<col>` to a column ID.** Resolution rules:
   1. **Exact match against column IDs** on the board (case-sensitive
      — Monday IDs are stable, lowercase, snake-case strings).
   2. **Exact match against column titles** with normalisation:
      - Unicode NFC normalisation
      - Surrounding whitespace trimmed
      - Case-folded (Unicode-aware, locale-independent — equivalent
        to `String.prototype.toLocaleLowerCase('und')`)
      - Internal whitespace collapsed to single spaces
   3. **ID/title collision** — if a token matches one column's ID
      *and* another column's title, the ID match wins (deterministic),
      and a `warnings: [{ code: "column_token_collision", ... }]`
      entry is emitted. To force the title match in this case, use
      explicit prefix syntax: `title:Status` (vs `id:status`).
   4. **Ambiguous title** (multiple columns share the title after
      normalisation) → `error.code = "ambiguous_column"` with
      `details.candidates: [{id, title, type}, ...]`. Agents should
      retry with the explicit `id:<column_id>` prefix.
   5. **No match** → `error.code = "column_not_found"`. Before
      surfacing the error, the CLI **refreshes the board metadata
      cache once** (§8) and retries — guards against stale-cache
      false negatives after a column is added.
   6. **Archived columns** are not resolvable by default — they're
      filtered out of the board metadata. Pass `--include-archived`
      on read commands to see them; mutations against archived
      columns return `column_archived` regardless.
   7. **`me` token in people columns** — `--set Owner=me` and
      `--where owner=me` resolve `me` to the connected user's ID
      (same as `monday account whoami`). Per-column-type sugar.
      Only applies to `people` columns.

   The resolved `column_id` is **echoed in mutation output** (§6.4
   `resolved_ids`) so agents can capture stable IDs for future calls.

   **`--set` parser rules.** `--set <token>=<value>` splits on the
   *first* `=`. Tokens containing `=` (rare but possible in column
   IDs / titles) need shell quoting and either explicit prefix
   syntax or quoted-equals form: `--set 'title:Plan A=B'=approved`.
3. **v0.1 supported column types** (the friendly translation):
   - `text`, `long_text` — pass-through string.
   - `numbers` — pass-through (Monday quirk: stringified numeric).
   - `status` — `Done` → `{"label":"Done"}`. Numeric input → `{"index":N}`.
     Status indexes are more stable than labels across renames; agents
     that have an index from `board describe` can use it directly.
   - `dropdown` — `Backend,Frontend` → `{"labels":["Backend","Frontend"]}`.
     Numeric IDs → `{"ids":[1,2]}`.
   - `date` — `2026-04-29` → `{"date":"2026-04-29"}`,
     `2026-04-29T14:30` → `{"date":"2026-04-29","time":"14:30:00"}`,
     `today`, `tomorrow`, `+3d`, `-1w` → resolved relative date in the
     **profile timezone** (see below).
   - `people` (singular `person` deprecated) —
     `alice@example.com,bob@example.com` →
     `{"personsAndTeams":[{"id":N,"kind":"person"},...]}` via user
     directory lookup. Cache hits are typical; cache misses do a
     `users(emails: [...])` call. Unknown email →
     `error.code = "user_not_found"` with the unmatched email in
     `details`.

   **v0.2 expansion** (additions to the v0.1 allowlist; ships
   alongside `--set-raw` in the M8 writer-expansion milestone).
   All v0.2-additions are rich payloads — they go through
   `change_column_value` like the v0.1 rich types (`status` /
   `dropdown` / `date` / `people`):

   - `link` — `<url>` (one segment) → `{"url":<url>,"text":<url>}`;
     `<url>|<text>` (pipe-split, max 1 split, both segments
     trimmed) → `{"url":<url>,"text":<text>}`. URL validated via
     `z.string().url()`; failure → `usage_error`. Pipe-form with
     empty trailer rejected (`usage_error`); use `--set-raw`
     (below) to write a link with empty `text`.
   - `email` — single email → `{"email":<value>,"text":<value>}`;
     `<email>|<text>` → `{"email":<email>,"text":<text>}`. Email
     validated via `z.string().email()`; failure → `usage_error`.
   - `phone` — `<phone>|<country>` (pipe form mandatory) →
     `{"phone":<phone>,"countryShortName":<country>}` where
     `<country>` is a 2-letter ISO 3166-1 alpha-2 code (uppercase
     — `US`, `GB`, `JP`). E.164-loose validation
     (`+?\d{6,15}`); ISO code validated against a frozen allowlist.
     Single-segment form (`--set Mobile=+15551234567` without
     `|US`) is rejected with `usage_error` — Monday's phone-column
     validation requires both the number and a 2-letter country
     code AND verifies they match (per Monday's phone-validation
     changelog), so the friendly translator can't safely default
     `countryShortName: ""`. Agents who need to write a phone with
     no country (Monday allows it for some legacy fixtures) use
     `--set-raw`.
   - `tags` (tentative — may slip to v0.3) — comma-split tag
     names → `{"tag_ids":[N1,N2]}` via account-tag directory
     lookup. Cache mirrors the user directory pattern from M5a.
     Unknown tag name → `error.code = "tag_not_found"` with the
     unmatched name in `details` (new stable code — 27th if
     `tags` ships firm; the v0.2-plan §9.2 "Before M12" gate
     adds it to §6.5). Slip risk: per-account `tags` query may
     be too expensive to cache cleanly; M8 fixture work decides
     at close.
   - `board_relation` (tentative — may slip to v0.3) —
     comma-split item IDs → `{"item_ids":[N1,N2]}`. Item IDs
     accepted directly (no name-resolution sugar in v0.2 — agents
     `item find <name>` first, then `--set`). Cross-board
     references validated against the source column's allowed
     boards — Monday's `board_relation` column settings expose
     `boardIds` (array) or `boardId` (singular) per
     `get_column_type_schema`; the CLI normalises to
     `allowed_boards = settings.boardIds ?? [settings.boardId]`.
     Off-board IDs → `usage_error` with `details.allowed_boards:
     [...]` for self-correction. Slip risk: linked-board
     enumeration may require a per-call complexity-budget design
     pass.
   - `dependency` (tentative — may slip to v0.3) — same shape
     as `board_relation` but uses Monday's separate `dependency`
     column payload. Same slip risk.

4. **All other column types in v0.2 → `unsupported_column_type`,
   keyed by roadmap category.** The error always includes `column_id`
   and `type`; the rest of the details depend on which row of the
   writer-expansion roadmap the type sits on:
   - **v0.3 writer-expansion candidates** (any of `tags`,
     `board_relation`, `dependency` slipped from v0.2's tentative
     row, plus `time_tracking`) carry `deferred_to: "v0.3"`. The
     `--set-raw` escape hatch (below) accepts these types in v0.2
     for agents that own the wire shape.
   - **read-only-forever** types (`mirror`, `formula`, `auto_number`,
     `creation_log`, `last_updated`, `item_id`) carry `read_only:
     true` (no `deferred_to`). Monday computes these server-side;
     the API never makes them writable, regardless of CLI version.
     The hint points at the underlying source column. `--set-raw`
     does **not** accept these types — the read-only-forever check
     fires after column resolution but before mutation (the type
     is only known once the column resolves).
   - **future** types (anything else — e.g. `battery`,
     `item_assignees`, `rating`) carry `deferred_to: "future"`
     with a generic message that doesn't commit to a specific
     version. `--set-raw` accepts these (the user owns the wire
     shape) provided the type accepts a payload via
     `change_column_value` / `change_multiple_column_values`.
   - **`files`-shaped types** (`file`, anything else where Monday
     uses `add_file_to_column` rather than `change_column_value`)
     carry `deferred_to: "v0.4"` (asset upload is pinned to v0.4
     per §13). `--set-raw` rejects these too — the underlying
     mutation isn't `change_column_value` so a raw payload can't
     reach the right wire surface.
   No silent partial support — every translator either lands
   end-to-end or surfaces `unsupported_column_type` with a
   hint that points at `--set-raw` or the type's roadmap slot.
5. **Picks the right mutation.** Of the writable allowlist:
   - `change_simple_column_value` (plain string) — for `text`,
     `long_text`, `numbers`. These types accept a bare string.
   - `change_column_value` (JSON) — for `status`, `dropdown`,
     `date`, `people` (v0.1) and `link`, `email`, `phone`,
     `tags`, `board_relation`, `dependency` (v0.2 expansion).
     These types need a JSON object.
   - `change_multiple_column_values` — when the same item has 2+
     `--set` / `--set-raw` flags, OR when `--name <n>` is
     combined with one or more `--set` / `--set-raw` flags.
     Saves a round-trip and is **atomic on Monday's side** (all
     columns succeed together or all fail; never partial success).
   `--set-raw` (v0.2) always uses `change_column_value` for the
   single-column case and `change_multiple_column_values` for the
   bundled case — the simple variant is an optimisation that
   doesn't apply to user-supplied raw payloads.

   **`item create` (M9) carve-in.** Both `--set` and `--set-raw`
   translated values bundle into the single `create_item` /
   `create_subitem` mutation's `column_values` parameter — *not*
   `change_column_value` / `change_multiple_column_values`. The
   wire mutation is different but the per-column-blob shape
   inside `column_values` is **expected** to mirror the multi-
   mutation contract below — the v0.1 fixture pass against
   `change_multiple_column_values` covers all seven v0.1 types
   on writes-to-existing-items, but the create path's wire
   acceptance for the per-blob edge cases (`long_text` bare-
   string vs. `{"text": ...}` re-wrap most notably) needs an
   M9 fixture pin before the rule is contractually frozen. The
   item's name is the separate `item_name` wire parameter
   (Monday's flag, not a synthetic `name` key inside
   `column_values`). No post-create fallback to a follow-up
   `change_multiple_column_values` call is permitted — see §5.8
   for the state-safety rationale.

   **Per-column-blob shapes inside `change_multiple_column_values`.**
   The multi mutation accepts a `column_values` JSON object keyed
   by column ID. Most types use the same blob the single mutation
   uses, but two divergences are pinned by fixture and form part
   of the contract:
   - `long_text` is re-wrapped as `{"text": "<value>"}` inside
     multi (the simple mutation accepts a bare string for the same
     column; multi requires the object form).
   - `name` is accepted as a synthetic key alongside real column
     IDs when `--name` is combined with `--set`. `name` is *not* a
     real board column — it's Monday's per-item title field — but
     `change_multiple_column_values` honours it as a key, so the
     CLI bundles it into the same atomic mutation rather than
     issuing a separate `change_item_name` call.

**Multi-column update:** `monday item update <iid> --set status=Done
--set owner=alice@x.com --set due=2026-05-01` consolidates into one
`change_multiple_column_values` call. `--name` may be added in
the same call: `monday item update <iid> --name "New title" --set
status=Done` bundles the rename and the column write atomically.

**Escape hatch (v0.2):** `--set-raw <col>=<json>` skips the
friendly translation and writes the literal Monday-shape JSON
the user supplies. The flag is **not implemented in v0.1**; it
lands in v0.2's M8 writer-expansion milestone. Contract:

- **Column resolution still applies.** `<col>` resolves through
  the same ID/title/case-fold path as `--set` (step 2 above),
  including the cache-miss-refresh-once rule (step 5 there). The
  resolved column's type is checked against two reject lists
  before mutation:
  - **Read-only-forever** (`mirror`, `formula`, `auto_number`,
    `creation_log`, `last_updated`, `item_id`) → surfaces
    `unsupported_column_type` with `read_only: true`. Monday
    never accepts writes against these regardless of payload.
  - **`files`-shaped** (`file`, anything else where Monday's
    write path is `add_file_to_column` rather than
    `change_column_value`) → surfaces `unsupported_column_type`
    with `deferred_to: "v0.4"`. The friendly translator and
    `--set-raw` both go through column-value mutations
    (`change_column_value` / `change_multiple_column_values`
    on `item set` / `item update`; `create_item` /
    `create_subitem.column_values` on `item create` per the
    M9 carve-in above) — none of these wire surfaces accept
    `add_file_to_column`-style payloads, so a `--set-raw` raw
    payload can't reach the right wire surface for these
    types. Asset upload is pinned to v0.4 (§13).
  Every other type (writable + tentative-slipped + future where
  the API accepts `change_column_value`) is accepted by
  `--set-raw`; the user owns wire-shape correctness.
- **JSON boundary validation; no type-shape validation.** The
  CLI parses `<json>` once at the argv boundary and verifies
  it is a JSON object (a `JsonObject` per zod) — malformed JSON
  or non-object JSON (string / number / array / null at the
  top level) returns `usage_error` with the parse error in
  `details`. The CLI does **not** validate the parsed object
  against any per-type schema; Monday's server-side rejection
  surfaces as `validation_failed` with Monday's message.
  `--set-raw` is for agents that have read Monday's developer
  docs and want to bypass the friendly translator's grammar
  (e.g. to write a `link` with empty `text`, which the friendly
  pipe-form rejects).
- **Mutual exclusion with `--set`.** `--set <col>=<val>` and
  `--set-raw <col>=<json>` against the **same** `<col>` (same
  resolved column ID) are mutually exclusive. Detection is
  resolution-time, not parse-time: the argv-parse layer can't
  tell whether two distinct tokens (`--set status=Done` and
  `--set-raw "Status Column"='{...}'`) resolve to the same
  column ID without board metadata. After both flags' tokens
  resolve, a duplicate-ID check fires before mutation; collision
  → `usage_error` with `details.column_id` and the conflicting
  tokens. Different columns in the same call are fine
  (`--set status=Done --set-raw weird_col='{...}'` on
  `item set` / `item update` bundles into one
  `change_multiple_column_values`; on `item create` both
  bundle into `create_item` / `create_subitem.column_values`
  per the M9 carve-in above).
- **`--dry-run` supported.** The dry-run echoes the **parsed**
  JSON object in `planned_changes[].diff[<col>].to` (no
  translator round-trip; the parsed object is what would be
  sent on the wire). Whitespace and key ordering from the
  original `<json>` argv string are not preserved — equivalent
  payloads can render differently.

The friendly translator covers up to thirteen types (`text`,
`long_text`, `numbers`, `status`, `dropdown`, `date`, `people`
from v0.1; `link`, `email`, `phone` firm v0.2 additions; `tags`,
`board_relation`, `dependency` tentative v0.2 additions, any of
which may slip to v0.3 — so the v0.2 firm count is ten and the
v0.2 stretch count is thirteen).
Anything outside that allowlist has two escape paths: `--set-raw`
for the per-column write (provided the type accepts
`change_column_value` — read-only-forever and `files`-shaped
types are excluded), or the `monday raw` GraphQL escape (§4.3)
for the whole-mutation write (file upload via
`add_file_to_column` falls here until v0.4).

**Writer-expansion roadmap.** Per-type slots for the friendly
translator (`--set <col>=<val>`). v0.1 had no escape hatch — types
outside the allowlist waited on the next version. v0.2 ships
`--set-raw <col>=<json>` alongside the friendly-type batch
(M8 — see "Escape hatch" above), so v0.2+ agents have a write
path for any type the API accepts via column-value mutations
(`change_column_value` / `change_multiple_column_values` for
`item set` / `item update`; `create_item` /
`create_subitem.column_values` for `item create`) even when
the friendly translator hasn't landed for it yet. Read-only-forever types and
`files`-shaped types (which use `add_file_to_column`) remain
unreachable through `--set-raw`; file upload waits for v0.4.
Slots in the table below
are the *current best plan* — v0.2 may re-slot the harder types
(`tags`, `board_relation`, `dependency`) to v0.3 after M8 fixture
work surfaces the design cost; this table is a planning anchor,
not a binding schedule.

| Type | Target version | Notes |
|------|----------------|-------|
| `text`, `long_text`, `numbers`, `status`, `dropdown`, `date`, `people` | **v0.1** | Initial allowlist (M5a). |
| `link`, `email`, `phone` | **v0.2** (firm) | M8 — pipe-form translator + URL/email/E.164 validation. |
| `tags` | v0.2 (tentative) | M8 — needs account-tag directory lookup. May slip to v0.3 if per-account `tags` query proves too expensive to cache. |
| `board_relation`, `dependency` | v0.2 (tentative) | M8 — cross-board item-ID validation against the column's `boardIds` (or singular `boardId`) settings. May slip to v0.3 if linked-board enumeration needs a complexity-budget design pass. |
| `time_tracking` | v0.3 | Start/stop semantics — verbs, not value writes. |
| `files` | v0.4 | Pinned via `add_file_to_column` (§13 v0.4). |
| `mirror`, `formula`, `auto_number`, `creation_log`, `last_updated`, `item_id` | **read-only forever** | Monday-computed; not writable by API. `--set-raw` rejects these too. |

The "read-only forever" row matters for agents: trying `--set` on a
mirror/formula/etc. surfaces `unsupported_column_type` and will
*always* surface that, regardless of version. The hint should point
at the underlying source column, not at `--set-raw`.

**Clearing column values.** `monday item clear <iid> <col>` is the
dedicated, type-portable verb for resetting a column to empty.
Per-type payload sent to `change_simple_column_value` /
`change_column_value`:

| Type | Clear payload | Mutation |
|------|---------------|----------|
| `text` | `""` | `change_simple_column_value` |
| `long_text` | `""` | `change_simple_column_value` |
| `numbers` | `""` | `change_simple_column_value` |
| `status` | `{}` | `change_column_value` |
| `dropdown` | `{}` | `change_column_value` |
| `date` | `{}` | `change_column_value` |
| `people` | `{}` | `change_column_value` |

`--set <col>=""` does **not** clear uniformly — it's
value-shaping, not intent-disambiguating, so the translator's
behavior is type-specific:

- `text` / `long_text` / `numbers` pass `""` through (which
  Monday treats as a clear for these types).
- `status` sends `{"label": ""}` (an empty label, *not* a
  clear — Monday will reject this if the board has no empty
  status entry).
- `dropdown` / `date` / `people` reject empty input with
  `usage_error` (the per-translator emptiness check fires
  before the dispatcher).

Use `monday item clear` whenever you mean "reset this column" —
it's the only surface that produces the right payload across the
writable types. Bulk clear via `monday item clear --board <bid>
<col> --where <c>=<v>... --yes` ships in v0.2 (M12); v0.1
agents fall back to `xargs monday item clear`. The v0.2 expansion
extends the per-type clear table — `link` / `email` / `phone` /
`tags` / `board_relation` / `dependency` all clear to `{}` via
`change_column_value`, mirroring v0.1's rich-type clear payloads.
Non-allowlisted column types return `unsupported_column_type`
from `clear` matching the `set` policy: any v0.3-deferred types
(tentative slips from v0.2's row, plus `time_tracking`) carry
`deferred_to: "v0.3"`; read-only-forever types (`mirror` /
`formula` / `auto_number` / `creation_log` / `last_updated` /
`item_id`) carry `read_only: true` with a hint pointing at the
underlying source column. `clear` does not accept `--set-raw` —
the dedicated verb's whole point is type-portable reset; agents
who need to write a custom JSON value use `--set-raw` on `set`
or `update`.

**Relative dates and timezone.** `today`, `tomorrow`, `+3d`, `-1w`,
`+2h` are resolved against the active **profile timezone**, set in
config (`MONDAY_TIMEZONE` env or `[profiles.<n>] timezone = "..."`),
defaulting to the system timezone. The resolved absolute date is
echoed in the dry-run output as `details.resolved_from` so agents
can verify before applying. The dry-run shape is the canonical one
defined in §6.4 — always `data: null`, `meta.dry_run: true`,
`planned_changes: [...]` (array even for single-item changes):

```json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "schema_version": "1", "api_version": "2026-01", ... },
  "planned_changes": [
    {
      "operation": "change_simple_column_value",
      "board_id": "67890",
      "item_id": "12345",
      "resolved_ids": { "due": "date_4" },
      "diff": { "date_4": { "from": "2026-04-25", "to": "2026-05-02" } },
      "details": { "resolved_from": { "input": "+1w",
                                      "timezone": "Europe/London",
                                      "now": "2026-04-25T14:00:00+01:00" } }
    }
  ],
  "warnings": []
}
```

### 5.4 No `restore` — archive is one-way (in v0.1)

Monday has `archive_item` and `delete_item` but **no `unarchive`
mutation**. The official "restore" pattern is to read the archived
item's data and recreate it as a new item — but that:

- assigns a **new ID**, breaking any external link that referenced
  the old one;
- does **not** carry over the original `created_at`, `creator`,
  comment thread (`updates`), file attachments (`assets`), automation
  history, or activity log;
- leaves the archived original in place (so naïve users end up with
  duplicates).

This isn't restore semantics — it's "make a new item that looks like
the old one". Calling it `restore` would mislead agents into a
data-loss decision. **v0.1 ships no `restore` command.**

If we need this later, the right shape is an explicit, lossy
operation that names what it is:

```
monday item recreate-from-archive <iid> --acknowledge-loss
                                        [--carry-updates]   # best-effort
                                        [--delete-original] # opt-in cleanup
```

Returning `{ "ok": true, "data": <new item>, "original_id": "<old>",
"loss": ["updates", "assets", ...] }` so the caller knows what didn't
make it. Until that's designed and implemented, agents that need
"restore" semantics should be told to query archived items
(`item list --state archived`) and explicitly recreate.

### 5.5 Filtering — narrow in v0.1, expand later

Monday's `query_params.rules` is a verbose JSON object with rule
groups, AND/OR operators, and 17 rule operators. Building a
fully-faithful DSL is a real effort and easy to get subtly wrong.

**v0.1 surface — two narrow knobs:**

1. **Repeatable `--where <col><op><val>`** for the common case.
   Operators are restricted to a small allowlist that covers ~90% of
   agent queries:
   - `=`  (alias for `any_of` with a single value)
   - `!=` (alias for `not_any_of`)
   - `~=` (alias for `contains_text`)
   - `<`, `<=`, `>`, `>=` (numeric / date comparisons)
   - `is_empty` / `is_not_empty` (no value: `--where due:is_empty`)
   Multiple `--where` flags are AND'd. No OR, no nested groups, no
   `within_last(7d)`-style sugar in v0.1. Examples:
   ```
   --where status=Done
   --where status=Done --where owner=alice@example.com
   --where due:is_not_empty --where priority>=3
   ```
2. **`--filter-json <json>`** is the escape hatch — the literal
   Monday `query_params` object. Used by power users / agents that
   need OR / nested groups / `within_last` / `between`. Never
   parsed; passed through as the GraphQL var.

**v0.2+ may add a boolean DSL** (`status:Done AND owner:me OR
priority>=4`) once we have real fixtures and edge cases from agents.
The narrow `--where` surface ships first because it's small enough
to test exhaustively and big enough to be useful.

### 5.6 Pagination

Monday pages at 500 items max with a **60-minute cursor lifetime**
counted from the *initial* `items_page` request. The CLI exposes
both layers, with explicit semantics around expiry:

- **Default `monday item list <bid>`** returns one page (500) with
  the cursor in the output envelope's `meta.next_cursor` field.
- **`--all`** auto-paginates. Each `next_items_page` request happens
  immediately after the previous response; under normal load the
  whole walk fits well inside 60 minutes.
- **`--limit <N>`** caps total returned items across pages.
- **`ndjson` output** streams items as they arrive — agents can
  start processing without waiting for the whole walk. v0.1 covers
  `item list`; v0.2 extends streaming to `item search` and the
  `update list` verbs (`<iid>`, `--board`) as the comment surface
  bulks up to volumes that benefit from incremental output.

**Stale cursor handling — fail, don't silently re-issue.** If the
60-minute window elapses mid-walk (e.g. an agent paused between
pages), the next `next_items_page` call returns an error. The CLI
surfaces this as:

```json
{ "error": {
    "code": "stale_cursor",
    "message": "Cursor expired (60 min lifetime). Restart pagination.",
    "details": {
      "cursor_age_seconds": 3712,
      "items_returned_so_far": 1500,
      "last_item_id": "5042"
    } } }
```

Why fail rather than silently re-issue the initial query? Because
between page N and the re-issued initial query the board may have
changed (items archived, statuses updated). A silent re-issue can
**duplicate** rows (item appeared in old page 1 and new page 1) or
**skip** rows (item was reordered out of the new walk's range).
Both are silent corruption.

**Resume guidance (v0.1): there is no safe deterministic resume.**
The naïve workarounds — filtering on `created_at >= last_seen` or on
`id > last_seen` — are subtly wrong:

- `created_at` is not unique (collisions on the boundary tick); ties
  must be broken on a second key, and even then it only works if the
  original walk was ordered by `created_at`.
- Item `id` is not guaranteed to match Monday's internal walk order,
  and `items_page` rules don't include a documented `id >` operator.

If a walk has to be restarted, the agent's options in v0.1 are:
1. Restart from scratch and use a filter that's known-stable (e.g.
   `--where 'status:any_of(Done)'` for a frozen subset).
2. Accept idempotent reprocessing — design downstream operations so
   re-seeing an already-processed item is a no-op (the
   `change_column_value` family is idempotent; `create_*` is not).
3. Use `--filter-json` with an explicit `order_by` and the known last
   sort tuple, then deduplicate client-side.

A first-class deterministic resume token (query-digest + order-key +
last-tuple, with optional bloom-filter for processed IDs) is in §14
as a v0.2+ candidate. Until then, **fail-fast and let the caller
choose the recovery strategy** — silent corruption is worse than a
known restart.

A second cursor-pagination caveat: the CLI's "deterministic ordering"
rule (§3.1 #8) is **per-page only**. The CLI sorts each page's items
by ID ascending before emitting, but the server-side cursor walk
order is whatever Monday returns. Across an `--all` walk, items can
appear in surprising relative positions if Monday's internal order
isn't ID-sorted. Pass `--filter-json` with an explicit `order_by`
clause for cross-page determinism.

### 5.7 IDs only on positional args; `find` for names

Positional arguments are **always** treated as IDs. There's no
in-band "is this an ID or a name?" inference, and no `name:"..."`
prefix sugar (which is shell-quoting bait — agents end up
double-escaping it).

- `monday item get 12345` — by ID. Always. No exceptions.
- `monday item find "Refactor login" --board <bid>` — by name. The
  `find` verb is the only way names enter the CLI.

`find` semantics:
- Returns one resource if exactly one matches.
- Returns `error.code = "ambiguous_name"` with `details.candidates`
  (an array of `{id, name, ...}`) if multiple match. Pass `--first`
  to pick the lowest-ID match (rarely the right call for agents;
  exists for humans).
- Returns `error.code = "not_found"` if zero match.

Mutation outputs **always echo** the resolved resource IDs (item,
board, group, etc.) under `data`, and resolved column-token
echoes (`<col>=<value>` → resolved column ID) under the
top-level `resolved_ids` slot (§6.4). An agent doing a `find`
followed by an action captures the stable IDs once and reuses
them.

### 5.8 `create_item` — atomicity, state safety, and idempotency

`create_item` is not idempotent — calling it twice creates two items.

**Single round-trip with bundled column values.** When `monday item
create` carries `--set <col>=<val>` / `--set-raw <col>=<json>`
flags, every translated column value bundles into the
`create_item.column_values` (or `create_subitem.column_values`)
parameter and ships in **one** GraphQL mutation. The CLI does
**not** fall back to a two-call pattern (`create_item` followed by
`change_multiple_column_values`) on failure: a partial-state failure
between the two calls would leave an item with the requested name
but missing column values, and the API surfaces no post-hoc
discriminator between a half-applied create and a deliberate
name-only create. If `create_item.column_values` rejects any value
(server-side `validation_failed`, archived column not caught by
the cache-refresh path, etc.), the whole mutation fails and **no
item is created**. Agents who see the failure should fix the
offending value and retry — the create is still safe to retry
because no item exists. The same rule applies to `create_subitem`.

This is a state-safety contract, not just an implementation choice.
A future v0.3+ `--continue-on-error` style flag (mirroring the
deferred bulk-mutation flag in §4.3) would be the place to relax
it, by either (a) accepting the partial-state risk explicitly with
a typed warning in the success envelope, or (b) implementing
compensating-delete semantics. v0.2 ships neither.

**Idempotent variant via `item upsert`** (v0.2 M12). Pattern:

```
monday item upsert --board <bid> --name "Refactor login" --match-by name --set status=Backlog
```

The CLI:
1. Searches for an item matching the `--match-by` field(s) (page-
   walks `items_page` with AND-combined `any_of` rules).
2. **0 matches** → branches to `create_item` with the bundled
   column values (single round-trip per §5.8 — same wire shape as
   `monday item create`). `data.operation: "create_item"`.
3. **1 match** → branches to `change_multiple_column_values` with a
   synthetic `name` key bundled alongside the resolved column
   values (the v0.1 contract M5b ships for `item update --name
   <n> --set <c>=<v>...`). M12 produces the same wire shape as
   `monday item update` rather than re-implementing rename.
   `data.operation: "update_item"`.
4. **2+ matches** → fails with `ambiguous_match` (§6.5) carrying
   `details.candidates: [{id, name}, ...]` and the resolved
   `match_by` / `match_values` echo. **No mutation fires.** Agents
   tighten the predicate (more match-by columns or a stable hidden
   key column) so the next call resolves to a single item.

**Sequential-retry idempotent only.** Re-running with the same args
from the same agent is safe: the second call sees the first call's
created item and branches to `update_item` (same wire shape as the
first-call create with column values; the post-state matches).
**Concurrent agents are not a uniqueness guarantee** — two agents
observing zero matches at the same instant both branch to
`create_item`. The next call from either agent surfaces the
duplicate as `ambiguous_match`, giving the agent the recovery info
to widen `--match-by`. Concurrent-write protection through Monday's
resource-locking mutations is a v0.4 candidate (§9.3).

`--match-by` accepts column tokens (resolved via the same column
resolver `--set` uses) plus the literal `name` pseudo-token, which
matches against the item's `name` field. Multiple match-by tokens
AND-combine — adding a token narrows the match set, so an agent
seeing `ambiguous_match` knows widening the predicate by one column
is the recovery path. The match value for a column token comes from
the corresponding `--set <token>=<value>` (which is required for
every match-by column token); the match value for the `name` token
comes from `--name <n>`. `--set-raw <col>=<json>` entries cannot
participate in match-by because the JSON wire shape isn't a
filter-comparable scalar.

For uniqueness across runs, agents should use a stable hidden text
column as a synthetic key (or compose multiple match-by tokens) so
the first call deterministically lands in the create branch and
subsequent calls land in the update branch.

### 5.9 The `dev` namespace

Monday Dev's "sprint", "epic", "release", "bug", "task" concepts
are board conventions, not API entities. The CLI's `dev` namespace
is the explicit three-level carve-out called out in §5.2.

Mechanics:

1. **Configuration.** Board mappings live in the per-profile config
   under `[profiles.<name>.dev]` (see §7.2):
   ```toml
   [profiles.work.dev]
   tasks_board   = "987654"
   sprints_board = "987655"
   epics_board   = "987656"
   bugs_board    = "987657"
   timezone      = "Europe/London"  # used for relative date resolution
   ```
   Configured via `monday dev configure --tasks-board <bid> ...` or
   `monday dev discover` (auto-detect — see §11).
2. **Translation.** `monday dev task done <iid>` becomes a
   `change_simple_column_value` on the configured tasks board's
   status column. The CLI knows the board's status column ID and
   the canonical "Done" label from cached `board describe` output.
3. **Workflow shortcuts** that would otherwise be multi-step
   pipelines: `current sprint`, `tasks assigned to me`,
   `epic items`, `task block --reason "..."` (status + comment).

**Failure modes:**
- No `dev` config for the active profile → `error.code =
  "dev_not_configured"` with a structured hint pointing at
  `monday dev configure` and `monday dev discover`.
- A configured board doesn't expose the expected column (e.g.
  status column missing on tasks board) → `error.code =
  "dev_board_misconfigured"` with the column the CLI was looking
  for and what it found instead. `monday dev doctor` flags this
  proactively.

## 6. Output schema (JSON contract)

The output contract is part of the CLI's public surface. Breaking it
requires a major version bump. The rules below are normative;
per-command JSON shapes are pinned by integration-test fixtures and
described inline in §6.1–§6.5 alongside the universal envelope.
A per-command reference (every shipped command's `data` shape, with
concrete examples) lives in
[`output-shapes.md`](./output-shapes.md) — read that first if you
just want to know what `monday <noun> <verb> --json` returns.

**Schema version.** Every JSON output carries
`meta.schema_version: "1"`. Adding a field is non-breaking (no bump);
removing/renaming/retyping is a major bump (`"2"`). Agents pin against
this string.

### 6.1 Universal envelope

Every command returns one of two top-level shapes:

```json
{
  "ok": true,
  "data": <resource | array>,
  "meta": { ... },
  "warnings": [ ... ]
}
```

or, on failure:

```json
{
  "ok": false,
  "error": { ... },
  "meta": { ... }
}
```

`meta` is **always** present and carries:

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | string | Pin against this. Currently `"1"`. |
| `api_version` | string | The pinned Monday API version, e.g. `"2026-01"`. |
| `cli_version` | string | The CLI's own SemVer. |
| `request_id` | string | UUID generated per CLI invocation. Echoed in errors so users can correlate logs. |
| `source` | `"live"` \| `"cache"` \| `"mixed"` \| `"none"` | Whether the data is from a live API call, the local cache, both, or neither. `"none"` is used for errors that fail before any read (usage, config, parser errors). |
| `cache_age_seconds` | number \| null | Age of the cached portion. `null` when `source` is `"live"` or `"none"`. |
| `retrieved_at` | string | ISO 8601 UTC timestamp. |
| `complexity` | object \| null | When `--verbose`: `{ used, remaining, reset_in_seconds }` from Monday's `complexity` field. Always null without `--verbose` to avoid an extra GraphQL field on every query. |

`warnings` is an array of `{ code, message, details? }`. Always
delivered as part of the stdout JSON envelope. Used for non-fatal
degradations:

- Cache served stale data because a refresh failed (`code: "stale_cache"`).
- A bulk operation skipped some items (`code: "bulk_partial_skip"`,
  details lists the unprocessed IDs).
- A `--verbose` complexity hint suggesting a more efficient query.
- Something the user should know but that didn't fail the command.

What `warnings` is **not** for: partial-success of a single
`change_multiple_column_values` mutation. That mutation is atomic on
Monday's side (all columns or none), so there's no per-column
warning channel for it. Bulk multi-item ops via `--where` filters
are different — they iterate one mutation per item, and partial
failures across items go in `warnings` (or split into separate
`successes`/`failures` arrays in the data — see §6.4).

When stdout is a TTY (table mode), warnings are also rendered
human-readably to stderr in yellow so the user notices them. JSON
output mode never duplicates to stderr.

### 6.2 Single resource (`data` shape)

```json
{
  "ok": true,
  "data": {
    "id": "12345",
    "name": "Refactor login",
    "board_id": "67890",
    "group_id": "topics",
    "state": "active",
    "url": "https://...",
    "created_at": "2026-04-29T10:00:00Z",
    "updated_at": "2026-04-29T11:00:00Z",
    "columns": {
      "status_4": { "id": "status_4", "type": "status", "title": "Status",   "text": "Working on it", "label": "Working on it", "index": 1 },
      "person":   { "id": "person",   "type": "people", "title": "Owner",    "text": "Alice",          "people": [{ "id": "1", "name": "Alice", "email": "alice@example.com" }] },
      "date4":    { "id": "date4",    "type": "date",   "title": "Due date", "text": "2026-05-01",     "date": "2026-05-01", "time": null }
    }
  },
  "meta": { ... },
  "warnings": []
}
```

Rules:

- **IDs are always strings.** Monday returns numeric IDs but they
  exceed JS-safe integer range. Always quote.
- **Timestamps are ISO 8601 in UTC** (`Z` suffix).
- **`columns` is keyed by column ID.** The ID is *also* present
  inside each column-value object as `id` — keying is for fast
  lookup, the inline `id` is so `Object.values(columns)` produces
  self-identifying records. Both views are first-class.
- **Every column value has a base shape** of `{ id, type, title,
  text, ...typedFields }`:
  - `id` — column ID (matches the map key).
  - `type` — column type from §2.3 (e.g. `"status"`, `"date"`,
    `"people"`, `"battery"`, `"mirror"`, `"formula"`, ...).
  - `title` — current human title (see §6.5 on bloat).
  - `text` — Monday's rendered display value (best-effort string
    representation — present even for read-only columns where the
    typed shape isn't writable). Mirror and formula columns rely
    on this. (`dependency` is writable as of v0.2 via `item_ids`;
    its read shape exposes `display_value` and `linked_item_ids`
    rather than relying on `text`.)
  - typed fields — type-specific keys like `label`/`index` (status),
    `date`/`time` (date), `people: [...]` (people), `from`/`to`
    (timeline), `linked_item_ids` (dependency / board_relation),
    etc. See `monday board describe <bid>`'s `example_set` per
    writable column for the per-type shape an agent can write
    back; read-side projection is fixture-pinned.
- **Read-only columns** (mirror, formula, battery, item_assignees,
  time_tracking, etc.) include `text` and whatever typed payload
  Monday exposes; consumers should not pass `--set` against them
  (`unsupported_column_type`).

### 6.3 Collection (`data` shape)

```json
{
  "ok": true,
  "data": [ <resource>, <resource>, ... ],
  "meta": {
    "schema_version": "1",
    "api_version": "2026-01",
    "request_id": "...",
    "source": "live",
    "retrieved_at": "...",
    "next_cursor": "abc123",
    "has_more": true,
    "total_returned": 500,
    "columns": {
      "status_4": { "id": "status_4", "type": "status", "title": "Status" },
      "person":   { "id": "person",   "type": "people", "title": "Owner" },
      "date4":    { "id": "date4",    "type": "date",   "title": "Due date" }
    }
  },
  "warnings": []
}
```

Notes:

- `next_cursor`, `has_more`, `total_returned` live in `meta` (not
  beside `data`) — keeps `data` a clean list for `data.map(...)`-style
  consumers.
- **Title de-duplication for collections.** When all items in a
  collection share the same column schema (the common case for
  `monday item list` against a single board), the per-cell `title`
  is dropped from each item's `columns` and consolidated into
  `meta.columns` (the same column-base shape as §6.2 minus the
  per-row typed values). Saves ~30 bytes × N columns × M items on
  large lists. Single-resource calls keep titles inline (§6.2).
  Cross-board lists fall back to inline titles.
- For `--output ndjson`: each line is one resource (no envelope).
  The final line is the meta:
  `{ "_meta": { "next_cursor": ..., "has_more": ..., "schema_version": "1", ... } }`.
  Agents stream items, then read the trailer for pagination state.

### 6.4 Mutation result

```json
{
  "ok": true,
  "data": <resource>,
  "meta": { ... },
  "warnings": [],
  "side_effects": [ ... ],
  "resolved_ids": { "status": "status_4", "due": "date4" }
}
```

`resolved_ids` (optional) echoes the token → column-ID mapping
that §5.3 step 2 promised. Present on every column-mutation
envelope (`item set` / `item clear` / `item update`) where the
command initialised a `resolvedIds` map — including
`item update --name "..."` with no `--set`, which emits `{}`
because the command path constructs the empty map and passes
it through (no column resolver actually runs). **Absent** on:
- mutations that don't take column tokens at all (e.g.
  `update create`);
- bulk `item update` no-op success (zero matches → the bulk
  walker returns before constructing the resolved-id map,
  so the slot is omitted).

Agents should treat absent and empty `{}` equivalently — both
mean "no token-to-ID echoes to capture". Canonical key order in
the envelope: after `side_effects`, before the closing brace.
Agents that capture `resolved_ids` once can skip subsequent
metadata lookups when issuing follow-up writes.

`side_effects` (optional) lists secondary operations the CLI
performed implicitly — e.g. `monday dev task done --message "..."`
posts an update; that's a side-effect:

```json
"side_effects": [
  { "kind": "update_created", "id": "u_77", "item_id": "5001", "body": "..." }
]
```

**Bulk mutations** (`--where` / `--filter-json`) wrap the
per-item resources in a `data` envelope with a `summary` slot
and emit the same top-level `resolved_ids` echo as single-item
mutations (one `--set` token resolves once, applies to N items):

```json
{
  "ok": true,
  "data": {
    "summary": {
      "matched_count": 12,
      "applied_count": 12,
      "board_id": "67890"
    },
    "items": [
      { "id": "5001", "name": "...", "columns": { ... } },
      { "id": "5002", "name": "...", "columns": { ... } }
    ]
  },
  "meta": { ... },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

`matched_count` is the number of items the filter resolved
against. On success, `applied_count === matched_count` — every
matched item was mutated; both fields appear identically. The
partial-progress shape (`applied_count < matched_count`) lives
on the error envelope, not here — see §6.5 for the bulk
per-item failure error decoration. `items` carries the same
per-item resource shape as single-item mutations.

For `--dry-run`:

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true },
  "planned_changes": [
    {
      "operation": "change_multiple_column_values",
      "board_id": "67890",
      "item_id": "12345",
      "resolved_ids": { "status": "status_4", "due": "date4" },
      "diff": {
        "status_4": { "from": { "label": "Backlog", "index": 0 }, "to": { "label": "Working on it", "index": 1 } },
        "date4":    { "from": null, "to": { "date": "2026-05-02" }, "details": { "resolved_from": { "input": "+1w", "timezone": "Europe/London" } } }
      }
    }
  ],
  "warnings": []
}
```

`planned_changes` is **always an array** — single-item mutations get
a one-element array. Bulk mutations (via `--where` /
`--filter-json`) populate it fully. `data` is `null` for dry-runs.

**Per-mutation-kind `planned_changes` shapes.** Different
mutation verbs produce different planned-change shapes; the
`operation` slot is the discriminator. Three shapes ship in v0.1:

- **Column-mutation shape** (`item set` / `item clear` /
  `item update`). The shape shown above:
  `operation: "change_simple_column_value" |
  "change_column_value" | "change_multiple_column_values"`,
  with `board_id`, `item_id`, `resolved_ids`, and `diff`.
- **Comment-create shape** (`update create`). Diverges
  intentionally — there's no column to resolve and no `from →
  to` diff to render. Carries `operation: "create_update"`,
  `item_id`, `body`, and `body_length`; *omits* `board_id`,
  `resolved_ids`, and `diff`. `meta.source: "none"` (no API
  call fired). Re-running without `--dry-run` creates a fresh
  comment, so `update create --dry-run` is a preview-of-payload
  rather than a preview-of-state-change:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "create_update",
        "item_id": "12345",
        "body": "Tagging @ops — please review the staging deploy.",
        "body_length": 48
      }
    ],
    "warnings": []
  }
  ```

- **Raw-GraphQL shape** (`monday raw` with a `mutation`
  selected; M6 close). The CLI can't introspect arbitrary
  GraphQL — there's no per-column diff and no resolved-ids
  echo because the writer didn't run any token resolution.
  Carries `operation: "raw_graphql"`, `operation_kind:
  "mutation"`, the selected `operation_name` (or `null` for
  anonymous), the verbatim `query`, and the `variables` JSON
  the wire call would have carried. `meta.source: "none"` (no
  API call fired). Honoured per §9.2's universal mutation +
  `--dry-run` binding; for read-only documents (or mixed docs
  whose `--operation-name` selects a query) `--dry-run` is a
  no-op and the query executes normally:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "raw_graphql",
        "operation_kind": "mutation",
        "operation_name": "Bump",
        "query": "mutation Bump { create_workspace(name: \"X\", kind: open) { id } }",
        "variables": {}
      }
    ],
    "warnings": []
  }
  ```

- **Item-create shape** (`item create`; v0.2 M9). The new
  item doesn't exist yet, so there's no prior state to diff
  against — every `diff[<col>].from` is `null`. The item's
  `name` and any optional placement (`group_id`, `position`)
  are hoisted to top-level slots rather than buried inside
  `diff`, mirroring the comment-create shape's preference for
  agent-scannable surface fields. `resolved_ids` echoes the
  same `<token> → <column_id>` map column-mutation shapes
  carry, since `--set` and `--set-raw` resolve against the
  target board's metadata exactly as for `item set/update`.
  Top-level `create_item` form:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, ... },
    "planned_changes": [
      {
        "operation": "create_item",
        "board_id": "67890",
        "name": "Refactor login",
        "group_id": "topics",
        "resolved_ids": { "status": "status_4", "due": "date_4" },
        "diff": {
          "status_4": { "from": null, "to": { "label": "Working on it", "index": 1 } },
          "date_4":   { "from": null, "to": { "date": "2026-05-02" } }
        }
      }
    ],
    "warnings": []
  }
  ```

  When `--position before|after --relative-to <iid>` is set,
  the planned change carries an additional `position: { method:
  "before" | "after", relative_to: "<iid>" }` slot. When
  `--group` is omitted, `group_id` is omitted (Monday assigns
  the board's default group server-side; dry-run can't
  predict the resolved ID without firing the mutation).

  **Subitem variant** (`--parent <iid>` set; `operation:
  "create_subitem"`). Identical shape to `create_item` with
  three deltas: `operation` flips to `"create_subitem"`,
  `board_id` is **omitted** (Monday derives the subitems
  board from the parent at server-side; the CLI doesn't echo
  it because column resolution targets the subitems board's
  own metadata and surfacing it as `board_id` would falsely
  imply the agent's `--board` value), and a new
  `parent_item_id: "<iid>"` slot carries the parent. `--group`
  / `--position` are not valid with `--parent` (subitems live
  on the auto-generated subitems board, not in groups; their
  position is parent-scoped, not relative-to-arbitrary-item)
  — argv-parse rejects with `usage_error`, so neither slot
  appears in the subitem dry-run shape. `resolved_ids` and
  `diff` keep the same per-column shape. **Classic boards
  only:** subitem creation against multi-level boards
  (`hierarchy_type: "multi_level"` per §2.8 — where subitems
  live on the parent's board rather than an auto-generated
  subitems board) is rejected with `usage_error` carrying
  `details.hierarchy_type`. Multi-level subitem support is
  deferred to v0.3.

- **Item-archive shape** (`item archive`; v0.2 M10).
  `operation: "archive_item"`, `item_id`, and `item: <projected
  source snapshot>` (the §6.2 single-resource shape the source
  item would have *before* archive — so an agent can verify the
  ID before re-running with `--yes`). *Omits* `board_id` (Monday's
  `archive_item(item_id)` doesn't take a board parameter; the
  CLI doesn't surface one), `resolved_ids`, and `diff` (no
  per-column changes). `meta.source: "live"` because the
  source-item read fired:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "live", ... },
    "planned_changes": [
      {
        "operation": "archive_item",
        "item_id": "12345",
        "item": { "id": "12345", "name": "Refactor login", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

- **Item-delete shape** (`item delete`; v0.2 M10). Identical
  shape to item-archive with `operation` flipped to
  `"delete_item"`. Re-deleting an already-deleted item surfaces
  `not_found` past the live mutation; the dry-run path simply
  reports the source item the live call would target. Same
  `meta.source: "live"` and same omissions.

- **Item-duplicate shape** (`item duplicate`; v0.2 M10).
  Identical shape to item-archive + item-delete with two
  divergences. (1) `operation: "duplicate_item"`. (2) An
  additional `with_updates: true | false` slot echoes the
  agent's `--with-updates` flag (defaults `false`) so the
  preview tells the agent whether re-running without `--dry-run`
  would copy the source item's updates. The dry-run is
  single-leg (`ItemDuplicateRead` only); the live path is
  two-leg (`ItemBoardLookup` + `duplicate_item` — Monday's
  `duplicate_item(board_id: ID!, item_id, with_updates)`
  requires `board_id`, derived from the source item's board).
  `meta.source: "live"`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "live", ... },
    "planned_changes": [
      {
        "operation": "duplicate_item",
        "item_id": "12345",
        "with_updates": true,
        "item": { "id": "12345", "name": "Refactor login", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

- **Item-move-to-group shape** (`item move --to-group <gid>`; v0.2
  M11). Same-board (group) move. Carries `operation:
  "move_item_to_group"`, `item_id`, `to_group_id`, and `item:
  <projected source snapshot>`. Single-leg dry-run (the source-item
  read via `ItemMoveRead`); *omits* `board_id`, `to_board_id`,
  `column_mappings`, `resolved_ids`, and `diff` (no per-column
  changes; the move doesn't translate column values). `meta.source:
  "live"` because the source-item read fired:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "live", ... },
    "planned_changes": [
      {
        "operation": "move_item_to_group",
        "item_id": "12345",
        "to_group_id": "new_group",
        "item": { "id": "12345", "name": "Refactor login", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

- **Item-move-to-board shape** (`item move --to-group <gid>
  --to-board <bid>`; v0.2 M11). Cross-board move. Carries
  `operation: "move_item_to_board"`, `item_id`, `to_board_id`,
  `to_group_id`, `column_mappings: [{source, target}, ...]`, and
  `item: <projected source snapshot>`. The `column_mappings` array
  enumerates every source-column-with-data + its target column —
  verbatim ID matches surface explicitly (so the array fully
  describes what Monday would receive on the wire). Three-leg
  dry-run (`ItemMoveRead` + source-board metadata + target-board
  metadata, parallel for the two metadata loads); *omits*
  `board_id`, `resolved_ids`, and `diff`. `meta.source` is
  `'live'` or `'mixed'` — the source-item read leg is always live,
  so pure `'cache'` is impossible; the metadata loads can hit
  cache, which collapses the aggregate to `'mixed'`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "move_item_to_board",
        "item_id": "12345",
        "to_board_id": "222",
        "to_group_id": "topics",
        "column_mappings": [
          { "source": "status_4", "target": "status_42" },
          { "source": "date4", "target": "date4" }
        ],
        "item": { "id": "12345", "name": "Refactor login", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

  Strict default per §8 decision 5 — source columns whose IDs
  don't exist on target AND aren't bridged by `--columns-mapping`
  raise `usage_error` (exit 1) even on `--dry-run`, so agents see
  the same shape the live mutation would surface rather than a
  preview-of-failure. The error carries `details.unmatched:
  [{source_col_id, source_title, source_type}]` +
  `details.example_mapping: {<source>: "<target_col_id>"}` so the
  next call's `--columns-mapping` is a copy-paste away.
  `--columns-mapping {}` (empty object) bypasses the check —
  Monday's permissive default applies (silently drops unmatched).

Future mutation verbs may add new shapes; `operation` stays the
discriminator. Agents should switch on `operation` rather than
assume a fixed slot list.

For `monday item upsert` (M12), `data.operation` indicates which
branch the wire mutation took:

```json
{ "ok": true,
  "data": { "id": "5001", "operation": "create_item", ... },
  "meta": { ..., "source": "mixed" },
  "warnings": [],
  "resolved_ids": { "status": "status_4" } }
```

`data.operation` is `"create_item"` (no match — fresh create) or
`"update_item"` (one match — synthetic-name + bundled column-values
rename via `change_multiple_column_values` per §5.3 step 5). 2+
matches → `ambiguous_match` (§6.5), no mutation fired. The slot
lives on `data` rather than `meta` because v0.1's mutation envelope
already keeps operation-shape signals in `data` (e.g.
`duplicated_from_id` for `item duplicate`); `meta` is reserved for
cross-verb cache / source / pagination state. M12 round-2 P2 closed.

For `monday item duplicate`, the live mutation envelope's
`data` extends the §6.2 projection with `duplicated_from_id:
<source-iid>` so an agent has the source-ID echo handy without
having to remember the positional they passed:

```json
{ "ok": true, "data": { "id": "67890", "duplicated_from_id": "12345", ... }, ... }
```

This mirrors upsert's `created` flag — verb-specific business
signals extend `data`; top-level slots are reserved for cross-verb
shapes (`resolved_ids`, `side_effects`).

### 6.5 Error

To stderr (and the *only* thing on stderr at non-debug verbosity):

```json
{
  "ok": false,
  "error": {
    "code": "complexity_exceeded",
    "message": "Complexity budget exceeded — wait 30s before retrying.",
    "http_status": 200,
    "monday_code": "ComplexityException",
    "request_id": "0e6f1a7b-...",
    "retryable": true,
    "retry_after_seconds": 30,
    "details": {
      "complexity_used": 9500000,
      "complexity_remaining": 500000,
      "complexity_reset_in_seconds": 30
    }
  },
  "meta": { ... }
}
```

Fields:

| Field | Type | Notes |
|-------|------|-------|
| `code` | string | **Stable** snake_case. Agents key off this. |
| `message` | string | Human-readable. **Not** part of the contract — may change between releases. |
| `http_status` | number | The actual HTTP status (200 for most Monday app errors). |
| `monday_code` | string \| null | Monday's own error code/exception name when present, raw. |
| `request_id` | string | The `meta.request_id` from this invocation. |
| `retryable` | boolean | Whether the CLI considers automated retry safe. |
| `retry_after_seconds` | number \| null | Hint for caller-driven retry. |
| `details` | object | Code-specific extra context. Per-code schemas listed below. |

**Stable error codes (v0.1).** The full list grows over time;
removals are major bumps.

| Code | Origin | Retryable? |
|------|--------|------------|
| `usage_error` | CLI parsing | No |
| `confirmation_required` | Destructive op without `--yes` | No |
| `not_found` | Item/board/etc. doesn't exist | No |
| `ambiguous_name` | `find` matched multiple | No |
| `ambiguous_column` | `--set` resolved to multiple columns | No |
| `ambiguous_match` | `item upsert` matched 2+ items (M12) | No |
| `column_not_found` | `--set` matched no column | No |
| `user_not_found` | Email lookup failed | No |
| `unsupported_column_type` | Tried `--set` on a type not in v0.1 allowlist | No |
| `column_archived` | `--set` against a column archived on the board | No |
| `unauthorized` | Token missing/invalid | No |
| `forbidden` | Token valid, lacks permission | No |
| `rate_limited` | Per-minute quota | Yes |
| `complexity_exceeded` | Complexity budget | Yes |
| `daily_limit_exceeded` | Daily quota | No |
| `concurrency_exceeded` | Too many in-flight | Yes |
| `ip_rate_limited` | IP cap | Yes |
| `resource_locked` | HTTP 423 | Yes |
| `validation_failed` | Monday rejected payload (bad status label, etc.) | No |
| `stale_cursor` | Pagination cursor expired | No (caller restarts) |
| `config_error` | Bad config (missing token, etc.) | No |
| `cache_error` | Local cache I/O failure | Yes (auto-retried without cache) |
| `network_error` | Transport failure | Yes |
| `timeout` | Request timed out | Yes |
| `dev_not_configured` | `monday dev …` without dev config | No |
| `dev_board_misconfigured` | Configured dev board missing expected column | No |
| `internal_error` | CLI bug; report it | No |

**`details` schemas per code.** The `details` slot is code-specific;
slots that ship in v0.1 across multiple codes:

- `details.resolver_warnings: [{code, ...}, ...]` — present
  when the column resolver emitted warnings during the
  resolution that fed the failing call. Folds
  `column_token_collision` and `stale_cache_refreshed` into the
  error envelope so a cache-stale-then-failure flow doesn't lose
  the cache-was-stale signal. **Applied across all live
  mutation paths** (`item set` / `item clear` / `item update`):
  translator `usage_error`, `unsupported_column_type`,
  `user_not_found`, mutation-time `validation_failed` (and its
  `column_archived` remap). Also folded on the dry-run engine's
  `column_archived` throw. Other dry-run translator failures
  (`unsupported_column_type`, `user_not_found`, translator
  `usage_error`) currently bubble without the warnings fold —
  parity gap logged for v0.2 review.
- `details.remapped_from: "validation_failed"` — only on
  `column_archived` errors that came through a live mutation
  whose pre-mutation resolution was cache-sourced. The CLI
  re-fetches metadata, confirms the column is now archived, and
  remaps `validation_failed` → `column_archived` so agents key
  off the stable code rather than English. Live-sourced
  resolutions skip the remap (the live read already saw the
  archived flag).

**Per-code `details` schemas:**

- `confirmation_required` (bulk mutations without `--yes` or
  `--dry-run`):
  - `matched_count: number` — count of items the filter
    resolved against.
  - `where_clauses: string[]` — always present. Carries the
    raw `--where` clauses verbatim; empty array (`[]`) when
    only `--filter-json` was passed.
  - `filter_json: string` — present only when `--filter-json
    <s>` was passed; absent otherwise. Carries the raw JSON
    string the user supplied (not the parsed object).
  - `board_id: string` — the `--board <bid>` the bulk runs
    against.
- `column_archived`:
  - `column_id: string`, `column_title: string` — the archived
    column the agent targeted.
  - `details.remapped_from` (optional, see above).
  - `details.resolver_warnings` (optional, see above).
- `ambiguous_column`:
  - `candidates: [{ id, title, type }, ...]` — the matching
    columns. Agents retry with explicit `id:<column_id>` prefix.
- `ambiguous_match` (M12 — `item upsert` matched 2+ items):
  - `board_id: string` — the `--board <bid>` the upsert ran against.
  - `match_by: string[]` — the resolved `--match-by` tokens (the
    literal `name` pseudo-token plus any column tokens, in the
    order the agent supplied).
  - `match_values: { [token: string]: string }` — the value the
    upsert matched on, per token. Echoes `--name` for the `name`
    pseudo-token and the corresponding `--set <token>=<value>` for
    each column token.
  - `matched_count: number` — total candidates Monday returned.
  - `candidates: [{ id, name }, ...]` — first ≤10 matched items
    by Monday return order. Agents tighten `--match-by` (add
    columns or pick a stable hidden key column) so the next call
    resolves to a single item. The list is capped at 10 because the
    cursor-walked match set can grow unbounded; the typed error is
    a recovery signal, not a paginated read surface.
- `usage_error` for `--board` / item-board mismatch (dry-run
  only — see §5.3 step 1):
  - `item_board_id: string` — the item's actual `board.id`.
  - `requested_board_id: string` — the value passed to
    `--board`.
- **Bulk per-item failure** — when a bulk mutation fails
  partway through, the typed error envelope is decorated with
  partial-progress slots so agents can resume cleanly:
  - `matched_count: number` — same as above.
  - `applied_count: number` — items mutated before the
    failure.
  - `applied_to: [string, ...]` — IDs of items mutated before
    the failure (in mutation order).
  - `failed_at_item: string` — ID of the item the failure
    fired on.

  The error `code` is whichever the per-item mutation produced
  (`column_archived`, `validation_failed`, `complexity_exceeded`,
  …). The bulk envelope wraps these so agents can implement
  resume-on-rerun using `applied_to` to scope follow-up work in
  their own orchestration (e.g. by narrowing the filter to
  exclude already-applied IDs, or by issuing per-item retries
  for the items in `matched_count − applied_count`). The v0.1
  filter DSL doesn't include an `id_not_in` operator; bulk
  resume is caller-orchestrated, not a single re-run.

Exit codes (unchanged from §3.1): 0 success, 1 usage, 2 API/network,
3 config, 130 SIGINT.

## 7. Configuration

### 7.1 v1 — env vars only (already implemented)

`MONDAY_API_TOKEN` (required), `MONDAY_API_VERSION`, `MONDAY_API_URL`,
`MONDAY_REQUEST_TIMEOUT_MS`. Loaded via `dotenv` from `.env` in cwd.

### 7.2 v2 — config file with profiles

`~/.monday-cli/config.toml`:

```toml
default_profile = "work"

[profiles.work]
api_token_env = "MONDAY_API_TOKEN_WORK"     # never store the token in plaintext
api_version = "2026-01"
default_workspace = "1234567"

[profiles.work.dev]
tasks_board = "987654"
sprints_board = "987655"
epics_board = "987656"
bugs_board   = "987657"

[profiles.personal]
api_token_env = "MONDAY_API_TOKEN_PERSONAL"
```

Selection order: `--profile` flag > `MONDAY_PROFILE` env >
`default_profile` in config > `MONDAY_API_TOKEN` env (falls back to
v1 mode if no config file exists).

Tokens are **never** stored in the config file. Reference an env var
name (`api_token_env`) or use the future `monday auth login` flow
which writes a secrets file at `~/.monday-cli/credentials` (mode 0600).

### 7.3 v3 — `monday auth login`

OAuth flow. Opens a browser, listens on a localhost port, exchanges the
code, writes credentials. Out of scope for this design's first pass.

## 8. Caching

Some lookups are expensive and rarely change:
- **Board metadata** — columns, groups, status labels, dropdown options.
  Needed for every item create/update to translate friendly values.
- **User directory** — id ↔ email/name. Needed for `--set
  owner=alice@x.com`.

Cache lives at `$XDG_CACHE_HOME/monday-cli/` (falling back to
`~/.cache/monday-cli/`):

```
boards/<board-id>.json     # full board describe response
users/index.json           # email → id map
schema/version.json        # API version pin
```

- TTL: 5 minutes per file by default; `--no-cache` bypasses.
- Invalidated on cache-miss-then-write or via `monday cache clear`.
- Per-profile, namespaced under the profile name in v0.3+.
- File mode 0600. Never contains tokens.

**Auto-refresh on resolution failure.** When the CLI is about to
return `column_not_found`, `user_not_found`, `validation_failed`
(from Monday — bad status label, bad person ID, etc.), or the
column-resolution path otherwise dead-ends, it **first invalidates
the relevant cache entry, refetches, and retries once**. If the
retry still fails, the error is real and surfaced. This handles the
common "user added a new column / status / member, agent's cache is
stale, command would otherwise wrongly say 'no such thing'"
scenario without requiring `--no-cache` discipline from agents.

The refresh path is recorded in `meta.source = "mixed"` (cache
served the first attempt, live served the retry) and a
`warnings: [{ code: "stale_cache_refreshed", ... }]` entry is
emitted so agents can see when the cache was misleading them.

## 9. Idempotency, dry-run, and concurrency

### 9.1 Idempotency

| Operation | Idempotent? | Notes |
|-----------|-------------|-------|
| `change_column_value(s)` | Yes | Same input → same state |
| `archive_item`, `archive_board` | Yes | Re-archiving is a no-op |
| `move_item_to_group` | Yes | If already in target group, no-op |
| `move_item_to_board` | **No** | Re-running on an item already on the target board is undefined SDK behaviour; the `monday item move` verb's `idempotent: false` is the conservative bound across same-board (idempotent) + cross-board (not) paths |
| `create_item`, `create_board`, `create_column`, `create_group` | **No** | Use `upsert` variants |
| `item upsert` | Sequential-retry yes; concurrent no | Re-running with the same args from the same agent is safe (second call branches to `update_item`); two concurrent agents observing zero matches both branch to `create_item`. Recovery: the next call surfaces the duplicate as `ambiguous_match`. v0.4 candidate: lock-resource semantics (§9.3). |
| `delete_*` | Yes (after first call) | Item already deleted → returns `not_found` |
| `add_users_to_*` | Yes | Adding a user already a member is a no-op |
| `create_update` (comment) | **No** | Two calls = two comments |

### 9.2 Dry-run

Every mutating command supports `--dry-run`. The output shape is
defined once in §6.4: `data: null`, `meta.dry_run: true`,
`planned_changes: [...]` — an array of one element for single-item
mutations, N elements for bulk operations. Implementation: the
command runs all the read-side resolution (column lookups, ID
resolution, relative-date resolution) and constructs the GraphQL
request body, then prints `planned_changes` instead of sending it.

`--dry-run` is **never** a partial-execute. Either every planned
change is reported and zero are applied, or the command failed
during read-side resolution and `data` is null with a populated
`error`.

### 9.3 Concurrency (deferred to v0.4)

In v0.1–v0.3 the CLI is single-process and makes **one outbound
request at a time** per command. Sequential is correct under
Monday's complexity budget; a hot bulk loop with a tight
`--where` filter saturates a single connection just fine and avoids
hitting the per-account concurrency cap mid-walk.

`--concurrency <n>` for parallel bulk mutations is deferred to v0.4
(see §13). When implemented, it will probe Monday's
`concurrency_exceeded` signal on first use, back off on failure, and
respect the per-account ceiling.

## 10. Bulk and pipelines

The CLI is built to compose with shell pipelines. Two patterns:

### 10.1 stdin positional input

Where a command takes a single ID positional, passing `-` reads IDs
from stdin (one per line):

```
monday item list <bid> --where status=Backlog --output ndjson \
  | jq -r '.id' \
  | xargs -n1 monday item set --board <bid> --set status=Working
```

(`xargs -n1` is the safest pattern — `-` as stdin-positional is also
supported but `xargs` is more shell-idiomatic and works without
special CLI handling.)

### 10.2 Built-in bulk via filter

Bulk commands accept `--where` (repeatable) or `--filter-json`
instead of a positional and apply the mutation to every match:

```
monday item update --board <bid> --where status=Backlog \
  --set status=Working --dry-run
```

`--dry-run` returns `planned_changes: [...]` (see §6.4) — both
single-item and bulk forms use the same envelope. The agent
can review before re-running without `--dry-run`. Bulk mutations
without `--dry-run` *and* without `--yes` fail with
`code: "confirmation_required"`.

## 11. Discovery and introspection

Discovery is a load-bearing feature for agents. Three layers, smallest
to largest scope:

### 11.1 CLI introspection — `monday schema`

- `monday schema` — full CLI command schema as JSON Schema. Each
  command's input flags (with types, defaults, required-ness) and
  output shape are described as JSON Schema 2020-12. Agents ingest
  this once and never need `--help`. Embeds the current
  `schema_version`, the full stable error-code list with `retryable`
  and HTTP-status hints, and the pinned API version.
- `monday schema <command>` — JSON Schema for a single command.
- `monday schema --output text` — pretty-printed for humans.

### 11.2 Workspace discovery — `monday board …`

- `monday board list` — every board the token can see, with workspace
  and folder ancestry.
- `monday board describe <bid>` — the source of truth for what `--set`
  accepts on items in that board. Returns:
  - All columns with `id`, `type`, `title`, `archived`, `description`,
    `settings_str` (parsed where possible), and a `writable` boolean
    (true if the type is in the friendly-translator allowlist —
    seven types in v0.1; widens to ten firm (up to thirteen if
    the tentative `tags` / `board_relation` / `dependency`
    translators ship) in v0.2 with the M8 additions, plus
    `--set-raw` accepts every type the API will write to via
    `change_column_value` / `change_multiple_column_values`).
  - For `status` columns: the full label/index map with style.
  - For `dropdown` columns: the option list with IDs and labels.
  - For `board_relation` and `dependency` columns: the
    `boardIds` / `boardId` allowlist (writable in v0.2 — see
    §5.3 step 3 v0.2 expansion).
  - For `mirror` / `formula` / battery (rollup): the source
    column or formula text. (Read-only.)
  - Groups (id, title, color, position).
  - `hierarchy_type` and `is_leaf` (multi-level boards; via raw
    GraphQL — see §2.8).
  - For each writable column type, an **example `--set` value** in
    the response so an agent reading `describe` once has everything
    it needs to write.
- `monday board doctor <bid>` — diagnostics. Surfaces:
  - Duplicate column titles (would cause `ambiguous_column` on
    title-based `--set`).
  - Columns of types not in the friendly-translator allowlist
    (not writable via `--set` in v0.1; v0.2 widens coverage by
    up to six new types — three firm + three tentative — plus
    `--set-raw` for everything else the API will write to via
    `change_column_value`).
  - Stale cache entries vs. live state.
  - Missing/broken `board_relation` targets (linked board archived).
  - For `dev`-mapped boards: missing expected columns
    (status/owner/sprint/epic).

### 11.3 Workflow discovery — `monday dev …`

For agents working a Monday Dev workspace:

- `monday dev discover` — auto-detects sprint/epic/release/bugs/tasks
  boards by name in the active workspace and prints a config block.
  `--apply` writes the block to the active profile's config.
- `monday dev configure` — explicit override for individual board
  mappings. Equivalent to editing the config file by hand.
- `monday dev doctor` — runs `board doctor` against each configured
  dev board plus checks the cross-board `board_relation` wiring (do
  tasks link to epics? do epics link to releases?).

### 11.4 Self-correlation

Every error response carries `meta.request_id` and (where applicable)
`error.request_id`. The CLI logs this same UUID to stderr in
`--verbose` mode so users can `grep` their logs against the same key
they see in the JSON output. Useful for postmortems on flaky
mutations.

## 12. Workflow shortcuts (agent-flavoured)

The killer use case: an agent picking up a task, working it, marking it
done. Built as composed commands that wrap the underlying ops:

```
monday dev task list --mine --status not_done
# → returns ranked list, agent picks one
monday dev task start <iid>
# → status: "Working on it", optional comment
# ... agent does the work ...
monday dev task done <iid> --message "PR #1234"
# → status: "Done", posts update with the message
```

These are sugar over standard mutations but worth the extra surface
area because they encode the workflow once.

## 13. Roadmap

The phasing below is **scope-anchored** — earlier phases ship the
output contract, error codes, and command surface that later phases
build on. v0.1 is deliberately tight so the contract gets fixture
coverage before we extend it.

### v0.1 (alpha — "the read-only core + safe mutations")

**Goal: an agent can read everything the CLI surfaces, make small
scoped idempotent changes, and post comments narrating its work.**

- `account whoami`, `account info`, `account version`,
  `account complexity`
- `board list/get/find/describe/doctor`
- `board columns` / `board groups`
- `item list/get/find/search` (with **narrow** `--where` filter +
  `--filter-json` escape; no boolean DSL yet, see §5.5)
- `item subitems`
- `item set`, `item clear`, and `item update --set` with **only** the
  v0.1 column allowlist (`status`, `text`, `long_text`, `numbers`,
  `dropdown`, `date`, `people`). Other types are not writable in
  v0.1 — they surface `unsupported_column_type` keyed by roadmap
  category per §5.3 step 4: `deferred_to: "v0.2"` for the v0.2
  writer-expansion row, `read_only: true` for read-only-forever
  types (mirror / formula / auto_number / creation_log /
  last_updated / item_id), `deferred_to: "future"` for everything
  else. The `--set-raw` escape hatch lands in v0.2 with the
  writer-expansion milestone.
- `update list/get/create` — read AND post comments. (`update create`
  is in v0.1 because the agent workflow narrative — start a task,
  do the work, post a result comment — is meaningfully degraded
  without it. It's also a single non-idempotent mutation with no
  column-type complexity, which makes it cheap to ship safely. Other
  update mutations — reply/edit/delete/like/pin — wait for v0.2.)
- `cache list/clear/stats`
- `config show/path`
- `schema` (with full JSON Schema), `raw` (with `--query-file`,
  `--vars-file`, `--allow-mutation`, `--operation-name`; mutations
  are blocked by default and the `operationName` is selected from
  the parsed AST — M6 close)
- `board doctor` (3 diagnostics: duplicate column titles,
  unsupported column types per roadmap category, broken
  `board_relation` targets — M6)
- All global flags from §4.4
- Stable JSON envelope (§6) and full v0.1 error code set
- **Test fixtures + recorded GraphQL responses** before any v0.2
  command lands

### v0.2 (mutating core — "agents can drive a backlog")

- **Writer expansion** — `--set-raw <col>=<json>` escape hatch
  (deferred from v0.1) on `item set` / `item update` / bulk
  `item update --where`, alongside friendly-type expansion for
  `link`, `email`, `phone`, `tags` (tentative), `board_relation`
  (tentative), and `dependency` (tentative). v0.1's
  `unsupported_column_type` `deferred_to: "v0.2"` becomes
  actionable here.
- `item create/move/archive/delete/duplicate`
- `item upsert` (idempotency via `--match-by`; see §5.8)
- `update reply/edit/delete/like/pin` (with `--body-file` where
  applicable; `update create` already in v0.1)
- `update list --board <bid>` — board-wide updates feed (companion to
  the per-item `update list <iid>` already in v0.1; pairs with the
  v0.2 update mutations above)
- `update list <iid> --with-replies` — comment-thread expansion;
  v0.1 surfaces only top-level updates, reply trees require a nested
  Monday query that pairs with `update reply` above
- NDJSON streaming for `item search` and `update list` (`<iid>` +
  `--board`) — symmetric with v0.1's `item list` streaming once the
  comment-surface verbs land and grow the data volumes that benefit
  from incremental output
- `item clear --where ... <col> --yes` — bulk clear symmetric with
  v0.1's bulk `item update --where`; reuses the cursor-walk +
  `confirmation_required` + `--yes` / `--dry-run` gating + per-item
  `applied_count` / `failed_at_item` decoration. Per-item leg
  already built (M5b's `translateColumnClear`); bulk path just
  walks `items_page`. Dedicated verb because empty `--set` values
  are rejected at the translator boundary, so faking bulk clear via
  `item update --where ... --set X=` doesn't work
- `board create/archive/delete/duplicate`
- `board column-create/column-update/column-delete`
- `board group-create/group-update/group-archive/group-duplicate/group-delete`
- Boolean filter DSL — superset of v0.1's `--where`, only after
  fixtures show clear demand

### v0.3 (Monday Dev + multi-profile)

- `dev sprint/epic/release/task` workflow shortcuts
- `dev discover/configure/doctor`
- `item search` cross-board (omit `--board`) — "find my open tasks
  anywhere I have access" without the agent iterating boards. Needs
  a per-call complexity-budget design pass (Monday charges
  complexity per-board scanned); interacts with v0.3 `board
  favorites` and likely workspace scoping (`--workspace <wid>`)
- `item history <iid>` — per-item activity log (status changes,
  column edits, assignments, comments interleaved chronologically).
  Introduces a new §6 envelope shape (event objects with
  `created_at`, `actor_id`, `kind`, `before` / `after`); distinct
  from the org-wide audit feed listed as a non-goal candidate in
  §13.5
- `board favorites` — current user's starred boards. Pairs with the
  v0.3 cross-board `item search` as a natural scoping lever
  (`item search --favorites`); shipping it in isolation buys little
  agent value, so the two land together
- `item update --continue-on-error` — partial-success bulk path.
  Today's bulk `item update --where` fails fast on the first
  per-item error (matched items before the failure surface in
  `details.applied_to` per §6.5). The flag would attempt every
  matched item regardless and emit a new partial-success envelope
  with per-item `{ok, error?}` records — that's a §6.4 sub-section,
  not just a flag. Deferred to v0.3 so the v0.2 bulk-clear (above)
  fixture-pins the existing failure-decoration shape first; the
  partial-success envelope design pass benefits from one milestone
  of operational signal on the fail-fast variant
- `monday status` — connectivity + auth probe (DNS / TCP / TLS /
  401) that short-circuits without touching account state. Bundles
  pinned API version vs. server's reported version, cache dir +
  writability, redaction self-test, env-var pickup summary. Lands
  with the v0.3 diagnostics cluster (`auth login`, `dev doctor`,
  `monday usage`) — solo it's low value once `account whoami`
  works, but together they form a coherent "is everything working?"
  surface
- `monday usage` — rolling 24h API complexity budget remaining.
  Complements v0.1's per-query `account complexity` (spot probe)
  with the "have I burned through my daily budget?" shape, so an
  agent can self-throttle before a bulk run. Minimum-viable shape
  (24h rolling) lands at v0.3; per-minute rate-limit headroom +
  concurrency-cap headroom can grow into the same envelope at v0.4
  alongside `--concurrency` without re-pinning the contract
- Profiles in `~/.monday-cli/config.toml`
- `monday auth login` — OAuth flow + credentials cache (mode 0600)
- `notification send`
- `webhook list/create/delete` (board webhooks; CLI never *receives*)

### v0.4 (polish + nice-to-haves)

- `item watch <iid>` (polling; see §14 for the cadence question)
- Shell completion (bash / zsh / fish) via commander
- Bulk operations with `--concurrency` (probed against Monday's
  per-account concurrency cap)
- Asset upload (`add_file_to_column`, `add_file_to_update`)
- `doc list/get` (read-only; full docs CRUD deferred further)
- `team` create/manage

### Explicitly deferred from v0.1's stable contract

So an agent reading the contract knows what's *not* there yet:

- Webhooks (v0.3) — CLIs can't host the receive endpoint.
- Notifications (v0.3).
- Docs CRUD (read-only in v0.4; full CRUD later).
- OAuth profiles (v0.3) — token-from-env only in v0.1.
- `item watch` (v0.4).
- `--concurrency` bulk parallelism (v0.4).
- Boolean filter DSL (v0.2).
- Broad column-type write support — allowlist grows in v0.2+; per-type
  target slots in §5.3 "Writer-expansion roadmap".
- `item recreate-from-archive` — undecided; explicitly *not*
  shipping a misleading `restore` (see §5.4).

### Permanent non-goals

- Hosting webhooks (CLIs can't expose public HTTP — out of model).
- App framework / installable monday apps (different surface area).
- Real-time GraphQL subscriptions (Monday's endpoint doesn't support
  them).
- Telemetry, update-notifier, analytics — ever.
- Forms (Monday's public-submission feature) — receiving submissions
  from outside the account is the same hosted-endpoint shape as
  webhooks (already non-goal). The read-only "what forms exist?"
  surface alone isn't worth a verb-noun expansion when `board
  describe` already covers column mappings and `monday raw` covers
  the rare power-user case.
- Saved queries / aliases (e.g. `monday alias save my-tasks "..."`).
  The CLI reads only from env/argv, with the §8 cache as the sole
  derived state — that statelessness is what makes `monday item
  list | jq` predictable across machines and lets agents reason
  about behavior from argv alone. Local aliases would silently
  change behavior across machines; synced aliases would be a
  hosted-service shape. Shell aliases / shell functions are the
  established UNIX answer — the CLI doesn't need to compete with
  `bash`.
- `monday undo` (replay-based reversal of recent mutations). Two
  reasons: (1) requires a local mutation log, breaking the
  statelessness above; (2) Monday's state model is authoritative
  and concurrent — between the original mutation and the undo,
  another writer (user, agent, automation) may have changed the
  same column, and "undo" would silently overwrite their work.
  Real undo needs CAS semantics Monday's API doesn't expose.
  Honest substitutes: `--dry-run` for "preview before writing"
  (v0.1) and reading the prior value from `item history` for
  "restore manually" (v0.3). An agent that needs reversibility
  branches on dry-run output rather than betting on undo working
  under concurrency.

## 14. Open questions

1. **Published name on npm.** `monday-cli` is taken. Likely
   `@nick-webster/monday-cli` or similar scope. Decide before publish.
2. **Default `--output` for "stdout TTY but stdin piped".** Today
   we'd serve a table. The piped stdin is a soft agent signal — but
   not strong enough alone (humans pipe stdin too). Lean: keep
   stdout-TTY-detection as the only signal, document the `--json`
   override, validate with fixtures once we build them.
3. **Should `monday item upsert` write a hidden tracking column to
   make idempotency robust across renames?** Pros: actually idempotent
   even if the user renames the matched item. Cons: pollutes the
   board schema with a CLI-managed column. Default off; opt-in via
   `--write-tracking-column`.
4. **Watch-via-polling cadence and circuit breaker (v0.4).** Polling
   at 30s is fine for one watcher; if an agent spawns 50 in parallel
   that's 100 req/min just from polling. Cap concurrent watches
   per profile? Single-process backoff if Monday signals
   `concurrency_exceeded`?
5. **Auth caching format (v0.3).** `monday auth login` should
   produce a file compatible with `gh`/`aws`-style credentials
   helpers, or use our own format? Lean toward our own JSON for
   simplicity, file mode 0600.
6. **Deterministic pagination resume.** Today (§5.6) we fail-fast
   on `stale_cursor`. A future enhancement: the CLI emits a "resume
   token" in the failure that includes the last-seen item ID and a
   reconstructable filter, so a re-invocation with `--resume <token>`
   walks from where it left off without duplicates. Needs careful
   thought about deletions and reorders mid-walk.
7. **SDK retry interaction.** If a future `@mondaydotcomorg/api`
   adds its own retry layer, our retry layer would compound. Need a
   compile-time check (or runtime probe of SDK version) to ensure we
   don't double-retry. Track SDK changelog when bumping.
8. **Caching multi-level board metadata.** SDK 14.0.0 doesn't expose
   `hierarchy_type`/`is_leaf`; we fetch via raw GraphQL. Should the
   raw-GraphQL responses go through the same cache layer as the
   typed ones, or stay separate to avoid mixed staleness? Lean:
   same cache, `meta.source` per-field.

---

## Appendix A — example sessions

Moved to [`examples.md`](./examples.md) — instructional reference, not
contract. Five worked sessions covering pick-up-a-task, bulk re-triage
with dry-run, fresh-agent discovery, pipelining via `jq`/`xargs`, and
cursor-expiry recovery.

---

## Appendix B — at-a-glance verb-noun matrix

|              | list | get | find | create | update | set | move | archive | delete | duplicate | describe |
|--------------|:----:|:---:|:----:|:------:|:------:|:---:|:----:|:-------:|:------:|:---------:|:--------:|
| account      |      |  ✓  |      |        |        |     |      |         |        |           |          |
| workspace    |  ✓   |  ✓  |      |   ✓    |   ✓    |     |      |         |   ✓    |           |          |
| board        |  ✓   |  ✓  |  ✓   |   ✓    |   ✓    |     |      |    ✓    |   ✓    |     ✓     |    ✓     |
| board column |  ✓   |     |      |   ✓    |   ✓    |     |      |         |   ✓    |           |          |
| board group  |  ✓   |     |      |   ✓    |   ✓    |     |      |    ✓    |   ✓    |     ✓     |          |
| item         |  ✓   |  ✓  |  ✓   |   ✓    |   ✓    |  ✓  |  ✓   |    ✓    |   ✓    |     ✓     |          |
| update       |  ✓   |  ✓  |      |   ✓    |   ✓    |     |      |         |   ✓    |           |          |
| user         |  ✓   |  ✓  |      |        |        |     |      |         |        |           |          |
| team         |  ✓   |  ✓  |      |   ✓    |        |     |      |         |   ✓    |           |          |
| webhook      |  ✓   |     |      |   ✓    |        |     |      |         |   ✓    |           |          |
| doc          |  ✓   |  ✓  |      |        |        |     |      |         |        |           |          |
