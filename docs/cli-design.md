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
  describe`, `--help --output json`) without trial and error.
- **No telemetry, no surprise side-effects.** The only outbound calls
  go to Monday — never to anyone else — and only when a command needs
  them.

Secondary user: humans running ad-hoc queries from the terminal. They
get colour, truncated tables, and spinners — but only when stdout is a
TTY, and only via the same code paths that agents use, never via
parallel "human-friendly" alternatives that could drift.

## 2. Monday's API in one page

**API version pin.** The CLI pins to **Monday API `2026-04`** —
matching the version the installed `@mondaydotcomorg/api@14.0.0` SDK
was generated against. The pin is sent on every request via the
`API-Version` header. Bumping the pin requires bumping the SDK in
lockstep and is a SemVer-minor (or major if any output schema changes).
The user can override the pin per-invocation with `--api-version` or
per-environment with `MONDAY_API_VERSION`.

**SDK ↔ API drift.** Monday's live API moves quarterly; the SDK
catches up on its own cadence. SDK 14.0.0 lacks several 2026-04 types
(`BatteryValue` for status rollups, `hierarchy_type` / `is_leaf` /
`capabilities` for multi-level boards). The CLI handles this by:
1. Surfacing what the SDK types via the typed client (the common path).
2. Falling back to `client.request<T>()` raw GraphQL for fields beyond
   the SDK's coverage (escape hatch in `src/api/`).
3. Pinning to a tested SDK+API pair so the gaps are predictable.

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
| **Structured writable** | `status`, `dropdown`, `date`, `timeline`, `people` (the deprecated singular `person` too), `team`, `board_relation`, `file`, `doc` |
| **Read-only / system** | `creation_log`, `last_updated`, `item_id`, `auto_number`, `name`, `formula`, `mirror`, `dependency`, `progress`, `subtasks`, `time_tracking`, `item_assignees`, `button`, `integration`, `unsupported` |

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
exit codes and a stderr error envelope (see §6.4).

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

### 2.8 Multi-level boards and rollup columns (2026-04)

The 2026-04 API surfaces multi-level board hierarchies (up to **5
subitem layers**) and rollup columns that aggregate values from
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

1. **stdout is the result; everything else is stderr.** Spinners,
   progress, debug logs, warnings → stderr. `monday item list | jq`
   must always work.
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
   See §6.4. Agents key off `error.code`, never English messages.
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
required positionals.

```
# === ACCOUNT ===
monday account whoami                      # the connected user
monday account info                        # account name, plan, limits
monday account version                     # API version in use
monday account complexity                  # remaining complexity budget

# === WORKSPACE ===
monday workspace list                      # all visible workspaces
monday workspace get <wid>
monday workspace create --name <n> [--kind open|closed]
monday workspace update <wid> [--name <n>] [--kind ...]
monday workspace delete <wid> --yes
monday workspace folders <wid>             # folders inside workspace
monday workspace add-users <wid> --users <id|email>,...
monday workspace remove-users <wid> --users <id|email>,...

# === BOARD ===
monday board list [--workspace <wid>] [--state active|archived|all]
monday board get <bid>
monday board find <name> [--workspace <wid>] [--first]
monday board describe <bid>                # full schema: columns, groups, statuses
monday board create --name <n> [--workspace <wid>] [--kind public|private|share]
monday board update <bid> [--name <n>] [--description <d>]
monday board archive <bid> --yes
monday board delete <bid> --yes
monday board duplicate <bid> [--name <n>] [--workspace <wid>]
monday board subscribers <bid>
monday board add-users <bid> --users <id|email>,...

# Columns (board-scoped)
monday board columns <bid>                 # list columns
monday board column-create <bid> --type <type> --title <t> [--description <d>]
monday board column-update <bid> <cid> [--title <t>] [--description <d>]
monday board column-delete <bid> <cid> --yes

# Groups (board-scoped)
monday board groups <bid>
monday board group-create <bid> --name <n> [--position top|bottom]
monday board group-update <bid> <gid> [--name <n>] [--color <c>]
monday board group-archive <bid> <gid>
monday board group-duplicate <bid> <gid>
monday board group-delete <bid> <gid> --yes

# === ITEM ===
monday item list <bid> [--group <gid>] [--filter <expr>] [--state active|archived|all] [--all]
monday item get <iid>                      # single item with column values
monday item find <name> --board <bid> [--first]
monday item search --board <bid> --where <col>=<val> [...]
                                           # uses items_page_by_column_values
monday item create <bid> --name <n> [--group <gid>] [--set <col>=<val>]... [--parent <iid>] [--position before|after --relative-to <iid>]
monday item update <iid> [--name <n>] [--set <col>=<val>]... [--create-labels-if-missing]
monday item set <iid> <col>=<val>          # shorthand: single column update
monday item clear <iid> <col>              # clear a column's value
monday item move <iid> --to-group <gid> | --to-board <bid> [--columns-mapping <json>]
monday item duplicate <iid> [--with-updates]
monday item archive <iid>
monday item delete <iid> --yes
                                           # No `restore` — Monday has no unarchive mutation.
                                           # Recreating from archive is lossy (new ID, no
                                           # updates/assets/automation history). See §5.4.
monday item watch <iid> [--interval 30s] [--until-status <label>]
                                           # polls; emits NDJSON change events. Deferred to v0.4.

# Subitems
monday item subitems <iid>                 # list children
                                           # subitem creation = item create --parent <iid>

# === UPDATE (comments) ===
monday update list <iid>                   # comments on an item
monday update get <uid>
monday update create <iid> --body <md>     # markdown rendered to HTML
                                           # also: --body-file <path> | --body-file -
monday update reply <uid> --body <md>      # also accepts --body-file
monday update edit <uid> --body <md>       # also accepts --body-file
monday update delete <uid> --yes
monday update like <uid>
monday update unlike <uid>
monday update pin <uid>
monday update unpin <uid>
monday update clear-all <iid> --yes        # delete all updates on an item

# === USER ===
monday user list [--name <n>] [--email <e>] [--kind all|guests|non_guests]
monday user get <uid>
monday user me                             # alias for `account whoami`

# Teams (nested under user)
monday user team-list
monday user team-get <tid>
monday user team-create --name <n> [--description <d>] [--users <id>,...]
monday user team-delete <tid> --yes
monday user team-add-members <tid> --users <id|email>,...
monday user team-remove-members <tid> --users <id|email>,...

# === WEBHOOK ===
monday webhook list <bid>
monday webhook create <bid> --url <u> --event <e> [--config <json>]
monday webhook delete <wid> --yes

# === DOC ===
monday doc list [--workspace <wid>]
monday doc get <did>

# === NOTIFICATION ===
monday notification send --user <uid> --target <iid|bid> --target-type item|board --text <t>

# === DEV (convenience over standard boards) ===
monday dev sprint current                  # active sprint per profile config
monday dev sprint list [--state active|past|future]
monday dev sprint items <sid>              # items in this sprint
monday dev epic list [--state active|done]
monday dev epic items <eid>                # items linked to this epic
monday dev release list
monday dev task list [--mine] [--status not_done] [--sprint current]
monday dev task start <iid>                # status → "Working on it"
monday dev task done <iid> [--message <m>] # status → "Done", optional update
monday dev task block <iid> --reason <r>   # status → "Stuck" + post update

# === RAW ===
monday raw <query> [--vars <json>]         # arbitrary GraphQL escape hatch
                                           # also: --query-file <path> | --query-file -
                                           #       --vars-file <path>  | --vars-file -

# === SCHEMA ===
monday schema                              # full CLI schema as JSON
monday schema <command>                    # schema for a single command

# === CACHE ===
monday cache list                          # what's cached
monday cache clear [--board <bid>]
monday cache stats

# === CONFIG ===
monday config show                         # resolved config (token redacted)
monday config path                         # location(s) considered

# === HELP / VERSION (commander defaults) ===
monday --help
monday --version
monday <noun> --help
```

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
| `--api-version <v>` | `2026-04` (pinned; from env to override) | Sets `API-Version` request header. |
| `--timeout <ms>` | from env / 30000 | Per-request timeout. |
| `--retry <n>` | 3 | Max retries on transient errors (with backoff + jitter). |
| `--dry-run` | off | Mutations: print planned change, don't execute. |
| `--yes` / `-y` | off | Skip confirmation gate on destructive ops. |
| `--body-file <path>` | — | Where a command takes a `--body` (long-form text), read it from this file. `--body-file -` reads stdin. Avoids shell-quoting hell for multi-line markdown. |
| `--query-file <path>` | — | For `monday raw`: read the GraphQL document from a file (or `-` for stdin). |
| `--vars-file <path>` | — | For `monday raw`: read GraphQL variables JSON from a file (or `-` for stdin). |

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
     authoritative.
   - **Implicit:** the CLI calls `items(ids: [<iid>])` to get
     `board.id`, then proceeds. Caches the item→board mapping for the
     lifetime of the process.
   When ambiguity is impossible (the agent already passed `--board`),
   the implicit lookup is skipped entirely. Raw mode (`--set-raw`)
   without `--board` is a `usage_error`.
2. **Resolves `<col>` to a column ID.** Resolution order:
   1. Exact match against column IDs on the board.
   2. Exact match against column titles (case-insensitive).
   3. Ambiguous title (multiple columns share the title) → emit
      `error.code = "ambiguous_column"` with `details.candidates: [...]`.
   4. No match → `error.code = "column_not_found"`.
   The resolved `column_id` is **echoed in mutation output**
   (§6.3) so agents can capture it for future calls.
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
4. **All other column types in v0.1 → `unsupported_column_type`.**
   The error includes `column_id`, `type`, the literal Monday-style
   JSON shape the type expects, and a `--set-raw` example. v0.2+
   may extend the allowlist; the contract here is "we either know
   how to translate it, or we tell you exactly how to write it
   yourself". No silent partial support.
5. **Picks the right mutation.** `change_simple_column_value` (plain
   string) for `text`, `numbers`, `phone`, `email`, `link.text-only`,
   `country`, `hour`. `change_column_value` (JSON) for everything
   else. `change_multiple_column_values` when the same item has 2+
   `--set` flags — saves a network round-trip and is atomic on
   Monday's side.

**Multi-column update:** `monday item update <iid> --set status=Done
--set owner=alice@x.com --set due=2026-05-01` consolidates into one
`change_multiple_column_values` call.

**Escape hatch:** `--set-raw <col>=<json>` skips the friendly
translation and writes the literal Monday-shape JSON. Required for
column types not in the v0.1 allowlist; available always for power
users / agents that already know the shape.

**Relative dates and timezone.** `today`, `tomorrow`, `+3d`, `-1w`,
`+2h` are resolved against the active **profile timezone**, set in
config (`MONDAY_TIMEZONE` env or `[profiles.<n>] timezone = "..."`),
defaulting to the system timezone. The resolved absolute date is
echoed in the dry-run output as `details.resolved_from` so agents
can verify before applying:

```json
{ "ok": true, "dry_run": true,
  "planned_change": {
    "operation": "change_simple_column_value",
    "item_id": "12345",
    "column_id": "date_4",
    "diff": { "due": { "from": "2026-04-25", "to": "2026-05-02" } },
    "details": { "resolved_from": { "input": "+1w",
                                    "timezone": "Europe/London",
                                    "now": "2026-04-25T14:00:00+01:00" } }
  } }
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
  start processing without waiting for the whole walk.

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
Both are silent corruption. The agent restarts pagination explicitly,
ideally with a filter that excludes already-processed IDs:

```
monday item list <bid> --where 'created>=<last_processed_created_at>'
```

Deterministic resume (server-side cursor checkpointing) is in §14
as an open question; until then, fail-fast.

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

Mutation outputs **always echo** the resolved IDs (item, board,
column, group, etc.) under `data` and `data.resolved_ids`, so an
agent doing a `find` followed by an action captures the stable ID
once and reuses it.

### 5.8 Idempotency for `create_item`

`create_item` is not idempotent — calling it twice creates two items.
Pattern:

```
monday item upsert <bid> --name "Refactor login" --match-by name --set status=Backlog
```

The CLI:
1. Searches for an item matching the `--match-by` field(s).
2. If found: updates it (idempotent).
3. If not: creates it.
4. Returns `{ "item": ..., "created": true|false }` so agents know
   what happened.

`--match-by` accepts column IDs/names. Multiple match keys are AND'd.
For uniqueness across runs, agents can use a hidden text column as a
synthetic key.

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
requires a major version bump. The rules below are normative; per-
command shapes live in `docs/output-shapes.md` (to be added per
command implementation).

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
| `api_version` | string | The pinned Monday API version, e.g. `"2026-04"`. |
| `cli_version` | string | The CLI's own SemVer. |
| `request_id` | string | UUID generated per CLI invocation. Echoed in errors so users can correlate logs. |
| `source` | `"live"` \| `"cache"` \| `"mixed"` | Whether the data is from a live API call, the local cache, or both. |
| `cache_age_seconds` | number \| null | Age of the cached portion. `null` when `source === "live"`. |
| `retrieved_at` | string | ISO 8601 UTC timestamp. |
| `complexity` | object \| null | When `--verbose`: `{ used, remaining, reset_in_seconds }` from Monday's `complexity` field. Always null without `--verbose` to avoid an extra GraphQL field on every query. |

`warnings` is an array of `{ code, message, details? }`. Used for
non-fatal degradations (e.g. one column in a multi-column update
failed but the others succeeded).

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
    typed shape isn't writable). Mirror, formula, and dependency
    columns rely on this.
  - typed fields — type-specific keys like `label`/`index` (status),
    `date`/`time` (date), `people: [...]` (people), `from`/`to`
    (timeline), etc. See `docs/output-shapes.md` per type.
- **Read-only columns** (mirror, formula, dependency, battery,
  formula, item_assignees, time_tracking, etc.) include `text` and
  whatever typed payload Monday exposes; consumers should not pass
  `--set` against them (`unsupported_column_type`).

### 6.3 Collection (`data` shape)

```json
{
  "ok": true,
  "data": [ <resource>, <resource>, ... ],
  "meta": {
    "schema_version": "1",
    "api_version": "2026-04",
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
  "side_effects": [ ... ]
}
```

`side_effects` (optional) lists secondary operations the CLI
performed implicitly — e.g. `monday dev task done --message "..."`
posts an update; that's a side-effect:

```json
"side_effects": [
  { "kind": "update_created", "id": "u_77", "item_id": "5001", "body": "..." }
]
```

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
a one-element array. Bulk mutations (via `--filter`) populate it
fully. `data` is `null` for dry-runs.

For upsert-style commands, `data.created: true | false` indicates
which path ran:

```json
{ "ok": true, "data": { "id": "5001", "created": true, ... }, ... }
```

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
| `details` | object | Code-specific extra context. Schema per code documented in `docs/output-shapes.md`. |

**Stable error codes (v0.1).** The full list grows over time;
removals are major bumps.

| Code | Origin | Retryable? |
|------|--------|------------|
| `usage_error` | CLI parsing | No |
| `confirmation_required` | Destructive op without `--yes` | No |
| `not_found` | Item/board/etc. doesn't exist | No |
| `ambiguous_name` | `find` matched multiple | No |
| `ambiguous_column` | `--set` resolved to multiple columns | No |
| `column_not_found` | `--set` matched no column | No |
| `user_not_found` | Email lookup failed | No |
| `unsupported_column_type` | Tried `--set` on a type not in v0.1 allowlist | No |
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
api_version = "2026-04"
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
- Per-profile, namespaced under the profile name in v2.
- File mode 0600. Never contains tokens.

## 9. Idempotency, dry-run, and concurrency

### 9.1 Idempotency

| Operation | Idempotent? | Notes |
|-----------|-------------|-------|
| `change_column_value(s)` | Yes | Same input → same state |
| `archive_item`, `archive_board` | Yes | Re-archiving is a no-op |
| `move_item_to_group` | Yes | If already in target group, no-op |
| `create_item`, `create_board`, `create_column`, `create_group` | **No** | Use `upsert` variants |
| `delete_*` | Yes (after first call) | Item already deleted → returns `not_found` |
| `add_users_to_*` | Yes | Adding a user already a member is a no-op |
| `create_update` (comment) | **No** | Two calls = two comments |

### 9.2 Dry-run

Every mutating command supports `--dry-run`. Output schema includes a
`planned_change` object (§6.3). Implementation: the command runs all
the read-side resolution (column lookups, ID resolution) and constructs
the GraphQL request, then prints the request body instead of sending
it.

### 9.3 Concurrency

The CLI is single-process and makes one outbound request at a time per
command by default. `--concurrency <n>` on bulk operations enables
parallel mutations (capped at Monday's per-account concurrency limit
which the CLI probes on first use).

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

`--dry-run` returns `planned_changes: [...]` (see §6.4) — the agent
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
    (true if the type is in the v0.1 allowlist or `--set-raw` works).
  - For `status` columns: the full label/index map with style.
  - For `dropdown` columns: the option list with IDs and labels.
  - For `board_relation` columns: the `linked_board_id`(s).
  - For `mirror` / `formula` / `dependency` / battery (rollup):
    the source column, formula text, or dependency rules.
  - Groups (id, title, color, position).
  - `hierarchy_type` and `is_leaf` (multi-level boards; via raw
    GraphQL — see §2.8).
  - For each writable column type, an **example `--set` value** in
    the response so an agent reading `describe` once has everything
    it needs to write.
- `monday board doctor <bid>` — diagnostics. Surfaces:
  - Duplicate column titles (would cause `ambiguous_column` on
    title-based `--set`).
  - Columns of types not in the v0.1 allowlist (would need
    `--set-raw`).
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

**Goal: an agent can read everything the CLI surfaces and make
small, scoped, idempotent changes.**

- `account whoami`, `account info`, `account version`,
  `account complexity`
- `board list/get/find/describe/doctor`
- `board columns` / `board groups`
- `item list/get/find/search` (with **narrow** `--where` filter +
  `--filter-json` escape; no boolean DSL yet, see §5.5)
- `item set` and `item update --set` with **only** the v0.1 column
  allowlist (`status`, `text`, `long_text`, `numbers`, `dropdown`,
  `date`, `people`). Other types via `--set-raw`.
- `update list/get`
- `cache list/clear/stats`
- `config show/path`
- `schema` (with full JSON Schema), `raw` (with `--query-file`)
- All global flags from §4.4
- Stable JSON envelope (§6) and full v0.1 error code set
- **Test fixtures + recorded GraphQL responses** before any v0.2
  command lands

### v0.2 (mutating core — "agents can drive a backlog")

- `item create/move/archive/delete/duplicate`
- `item upsert` (idempotency via `--match-by`; see §5.8)
- `update create/reply/edit/delete/like/pin` (with `--body-file`)
- `board create/archive/delete/duplicate`
- `board column-create/column-update/column-delete`
- `board group-create/group-update/group-archive/group-duplicate/group-delete`
- Boolean filter DSL — superset of v0.1's `--where`, only after
  fixtures show clear demand

### v0.3 (Monday Dev + multi-profile)

- `dev sprint/epic/release/task` workflow shortcuts
- `dev discover/configure/doctor`
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
- Broad column-type write support (allowlist grows in v0.2+).
- `item recreate-from-archive` — undecided; explicitly *not*
  shipping a misleading `restore` (see §5.4).

### Permanent non-goals

- Hosting webhooks (CLIs can't expose public HTTP — out of model).
- App framework / installable monday apps (different surface area).
- Real-time GraphQL subscriptions (Monday's endpoint doesn't support
  them).
- Telemetry, update-notifier, analytics — ever.

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

JSON examples below show the envelope shape from §6 — every command
returns `{ ok, data, meta, ... }`. Examples are abbreviated for
readability (`...` indicates omitted `meta` fields).

### A.1 An agent picks up a task and finishes it

```bash
$ monday dev task list --mine --status not_done --json
{
  "ok": true,
  "data": [
    { "id": "5001", "name": "Refactor login", "board_id": "111",
      "url": "https://...",
      "columns": {
        "status_4": { "id": "status_4", "type": "status", "label": "Backlog", "index": 0 },
        "date4":    { "id": "date4", "type": "date", "date": "2026-05-01" }
      } }
  ],
  "meta": {
    "schema_version": "1", "api_version": "2026-04",
    "source": "live", "request_id": "...",
    "next_cursor": null, "has_more": false, "total_returned": 7,
    "columns": {
      "status_4": { "id": "status_4", "type": "status", "title": "Status" },
      "date4":    { "id": "date4",    "type": "date",   "title": "Due date" }
    }
  },
  "warnings": []
}

$ monday dev task start 5001 --json
{
  "ok": true,
  "data": { "id": "5001", "name": "Refactor login",
            "columns": { "status_4": { "id": "status_4", "type": "status",
                                       "title": "Status", "label": "Working on it",
                                       "index": 1 } } },
  "meta": { ... }
}

# ... agent edits code, opens PR ...

$ monday dev task done 5001 --message "Shipped in PR #1234" --json
{
  "ok": true,
  "data": { "id": "5001",
            "columns": { "status_4": { "id": "status_4", "type": "status",
                                       "title": "Status", "label": "Done",
                                       "index": 2 } } },
  "meta": { ... },
  "side_effects": [
    { "kind": "update_created", "id": "u_77", "item_id": "5001",
      "body": "Shipped in PR #1234" }
  ]
}
```

### A.2 Bulk re-triage (dry-run then apply)

```bash
$ monday item update --board 12345 \
    --where status=Backlog --where owner=me \
    --set status=Working --dry-run --json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "schema_version": "1", ... },
  "planned_changes": [
    { "operation": "change_simple_column_value",
      "board_id": "12345", "item_id": "5001",
      "resolved_ids": { "status": "status_4" },
      "diff": { "status_4": { "from": { "label": "Backlog", "index": 0 },
                              "to":   { "label": "Working on it", "index": 1 } } } },
    { "operation": "change_simple_column_value",
      "board_id": "12345", "item_id": "5002",
      "resolved_ids": { "status": "status_4" },
      "diff": { "status_4": { "from": { "label": "Backlog", "index": 0 },
                              "to":   { "label": "Working on it", "index": 1 } } } }
  ],
  "warnings": []
}

$ monday item update --board 12345 \
    --where status=Backlog --where owner=me \
    --set status=Working --yes --json
{ "ok": true,
  "data": { "applied": 2, "failed": 0, "items": ["5001", "5002"] },
  "meta": { ... }, "warnings": [] }
```

### A.3 Discovery for a fresh agent

```bash
$ monday board list --json
{ "ok": true,
  "data": [
    { "id": "111", "name": "Tasks", "workspace_id": "1", "state": "active" },
    { "id": "112", "name": "Bugs",  "workspace_id": "1", "state": "active" }
  ],
  "meta": { ... } }

$ monday board describe 111 --json
{ "ok": true,
  "data": {
    "id": "111", "name": "Tasks", "hierarchy_type": "parent", "is_leaf": false,
    "columns": [
      { "id": "status_4", "type": "status", "title": "Status", "writable": true,
        "labels": [
          { "index": 0, "label": "Backlog",        "style": "grey"   },
          { "index": 1, "label": "Working on it",  "style": "yellow" },
          { "index": 2, "label": "Done",           "style": "green"  }
        ],
        "example_set": "--set Status=Done   # or --set status_4=Done" },
      { "id": "person", "type": "people", "title": "Owner", "writable": true,
        "example_set": "--set Owner=alice@example.com" },
      { "id": "date4",  "type": "date",   "title": "Due date", "writable": true,
        "example_set": "--set 'Due date'=+1w" },
      { "id": "epic",   "type": "board_relation", "title": "Epic",
        "writable": false, "linked_board_id": "115" }
    ],
    "groups": [{ "id": "topics", "title": "Backlog", "color": "grey" }, ...]
  },
  "meta": { ... } }
```

### A.4 Pipelining

```bash
# All items not updated in 30 days, archive them.
# `monday item list` writes JSON (stdout is piped).
# `jq` filters; xargs feeds IDs back into the CLI.
monday item list --board 111 --filter-json '{"rules":[{
    "column_id":"updated_at",
    "compare_value":["EXACT","-30d"],
    "operator":"lower_than"
  }]}' --all --output ndjson \
  | jq -r '.id' \
  | xargs -n1 monday item archive --yes
```

### A.5 Cursor-expiry handling

```bash
$ monday item list --board 12345 --all --output ndjson > items.ndjson
# ... 90 minutes of network problems mid-walk ...
{
  "ok": false,
  "error": {
    "code": "stale_cursor",
    "message": "Cursor expired (60 min lifetime). Restart pagination.",
    "retryable": false,
    "details": {
      "cursor_age_seconds": 5400, "items_returned_so_far": 1500,
      "last_item_id": "5042"
    }
  },
  "meta": { ... }
}

# Agent reads the trailer from items.ndjson, restarts with a filter:
$ tail -n1 items.ndjson | jq -r '._meta.last_item_id'
5042
$ monday item list --board 12345 --where 'id>5042' --all --output ndjson \
    >> items.ndjson
```

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
