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

- **Stable, machine-parseable output by default.** JSON is the default
  format. Pretty tables exist but are an opt-in for TTYs.
- **Deterministic shapes.** Field names don't change between releases
  except via SemVer-major. Adding a field is minor; removing or
  renaming is breaking.
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
get colour, tables, spinners — but only when stdout is a TTY.

## 2. Monday's API in one page

Monday's GraphQL schema (queries below pulled from the live SDK types
in `node_modules/@mondaydotcomorg/api`):

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

Three distinct limits, all reported with a `retry_in_seconds` field:

- **Per-minute query count:** 1k–5k depending on plan tier (Pro 2.5k,
  Enterprise 5k). Specific endpoints stricter (e.g. board create: 40/min).
- **Complexity points:** 5M–10M points/min depending on auth method.
  Each field has a cost; large item-list queries can exhaust this fast.
  You can probe via the `complexity` field on any query.
- **Daily call cap, concurrency cap, IP cap** — additional ceilings.

Errors: `ComplexityException`, `Minute limit rate exceeded`,
`DAILY_LIMIT_EXCEEDED`, `Concurrency limit exceeded` — all carry
`retry_in_seconds`.

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

## 3. Design principles

### 3.1 Agent-first ergonomics — the load-bearing rules

1. **stdout is the result; everything else is stderr.** Spinners,
   progress, debug logs, warnings → stderr. `monday item list | jq`
   must always work.
2. **Default output is JSON when stdout is non-TTY** (i.e. piped or
   redirected). Tables are the default only on a TTY. Pretty output
   never goes to a pipe.
3. **Single canonical schema per command.** The shape of `monday item
   get`'s output doesn't change based on flags. `--minimal` may omit
   fields, `--include-updates` adds them — but field names and types
   stay stable.
4. **Errors are a JSON object on stderr with a stable `code`:**
   ```json
   { "error": { "code": "rate_limited", "message": "...",
                "retry_in_seconds": 30 } }
   ```
5. **Exit codes are part of the contract:** 0 success, 1 usage,
   2 API/network, 3 config, 130 SIGINT. (Already documented in
   `architecture.md`; this design doesn't change them.)
6. **Idempotency is documented per command.** Output schema includes a
   `created` boolean for upsert-style commands. Mutations carry a
   `--dry-run` that prints the planned change without executing.
7. **No interactive prompts. Ever.** Confirmation flags (`--yes`)
   short-circuit any "are you sure?" path. Without `--yes`, destructive
   commands fail with `code: "confirmation_required"`.
8. **Deterministic ordering.** Lists default to ordered output (by ID,
   ascending) regardless of Monday's response order, unless
   `--order-by` is set.
9. **Self-documenting.** `--help --output json` returns a machine
   description of the command (flags, types, exit codes, examples).
10. **Telemetry-free.** No analytics calls. No update checks (defer
    `update-notifier` until requested).

### 3.2 Human ergonomics (TTY only)

When stdout is a TTY and `--output` is unset:
- Tables for collections (cli-table3)
- Progress spinners on long ops (ora)
- Colour for status/severity (chalk; respects `NO_COLOR`)
- Helpful follow-up hints ("did you mean …?", "next: monday item get …")

Switching to a pipe disables all of the above silently. No flags needed.

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
- `restore` — un-archive
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
monday board restore <bid>
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
monday item restore <iid>                  # via items query with state=archived → re-archive=false (no direct API; see §5.4)
monday item delete <iid> --yes
monday item watch <iid> [--interval 30s] [--until-status <label>]
                                           # polls; emits NDJSON change events

# Subitems
monday item subitems <iid>                 # list children
                                           # subitem creation = item create --parent <iid>

# === UPDATE (comments) ===
monday update list <iid>                   # comments on an item
monday update get <uid>
monday update create <iid> --body <md>     # markdown rendered to HTML
monday update reply <uid> --body <md>
monday update edit <uid> --body <md>
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
monday raw <query> [--vars <json>]         # arbitrary GraphQL; --vars from stdin if "-"

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
| `--output <fmt>` | `json` (non-TTY) / `table` (TTY) | `json`, `table`, `text`, `ndjson` |
| `--quiet` / `-q` | off | Suppress stderr progress; errors still go to stderr |
| `--verbose` / `-v` | off | Debug logs to stderr (request bodies, complexity costs) — token redacted |
| `--no-color` | auto (respects `NO_COLOR`, `FORCE_COLOR`, `CI`) | Disable colour |
| `--no-cache` | off | Skip the local board-metadata cache |
| `--profile <name>` | from `MONDAY_PROFILE` | Selects credentials/config block (deferred to v2) |
| `--api-version <v>` | from env / unset | Sets `API-Version` request header |
| `--timeout <ms>` | from env / 30000 | Per-request timeout |
| `--retry <n>` | 3 | Max retries on transient errors (with backoff + jitter) |
| `--dry-run` | off | Mutations: print planned change, don't execute |
| `--yes` / `-y` | off | Skip confirmation gate on destructive ops |

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

### 5.2 Two-level depth, not three

Monday models things like "the column values of an item of a board".
That's three levels deep. The CLI flattens:
- `monday item set <iid> <col>=<val>` not `monday item column-value
  change <iid> <cid> <val>`.
- `monday item move <iid> --to-group <gid>` not `monday item move-to-
  group <iid> <gid>`.

Cost: a few flags carry information that's structural in GraphQL.
Benefit: every command stays under ~3 args.

### 5.3 The column-value abstraction (the big one)

Raw API: `change_column_value(board_id, item_id, column_id, value: JSON)`,
where `value` is a column-type-specific JSON blob the user must
construct correctly.

CLI: `monday item set <iid> <col>=<val>`. The CLI:
1. Looks up the board (from cache or live) to determine the column's
   type.
2. Translates `<val>` to the right JSON shape:
   - `status` column: `Done` → `{"label":"Done"}` (or `{"index":1}` if
     numeric).
   - `date` column: `2026-04-29` → `{"date":"2026-04-29"}`,
     `2026-04-29T14:30` → `{"date":"2026-04-29","time":"14:30:00"}`,
     `today`/`tomorrow`/`+3d` → resolved relative date.
   - `people` column: `alice@example.com,bob@example.com` →
     `{"personsAndTeams":[{"id":N,"kind":"person"},...]}` (looks up
     IDs from emails).
   - `dropdown` column: `Backend,Frontend` →
     `{"labels":["Backend","Frontend"]}`.
   - `text`, `numbers`, `email`, etc.: passed through.
3. Issues `change_simple_column_value` for simple types (no JSON wrap),
   `change_column_value` otherwise.

Multi-column update: `monday item update <iid> --set status=Done --set
owner=alice@x.com --set due=2026-05-01` consolidates into one
`change_multiple_column_values` call.

Escape hatch: `--set-raw <col>=<json>` skips the abstraction and writes
the literal JSON. Power users / agents that already know the shape can
bypass the lookup.

### 5.4 Restore vs archive

Monday has `archive_item` and `delete_item` but no `unarchive` mutation.
"Restoring" is implemented client-side by reading the archived item then
recreating it (Monday's official suggestion). The CLI exposes `monday
item restore <iid>` and documents the recreation behaviour — the
returned item will have a new ID. Agents that depend on stable IDs need
to handle that.

### 5.5 Filter expression DSL

Monday's `query_params.rules` is verbose JSON. The CLI accepts a
compact expression for the common case:

```
--filter 'status:Done'                  # single equality
--filter 'status:any_of(Done,Review)'   # operator
--filter 'status:not(Done)'             # negation
--filter 'status:Done AND owner:me'     # AND/OR
--filter 'created:within_last(7d)'      # date helpers
```

The CLI parses this into the GraphQL rules structure. For complex
filters that don't fit the DSL, accept `--filter-json <json>` as the
escape hatch.

### 5.6 Pagination

Monday pages at 500 items max with a 60-min cursor. The CLI exposes
both layers:

- Default `monday item list <bid>` returns one page (500) with the
  cursor in the output envelope.
- `--all` auto-paginates. The CLI manages cursor lifetime (re-issues
  the initial query if 60 min elapses mid-walk, with a warning).
- `--limit <N>` caps total returned items across pages.
- For `ndjson` output, items stream as they arrive — agents can start
  processing without waiting for the whole walk.

### 5.7 ID-or-name resolution

Most commands accept a positional ID. To accept a name instead, use
the `name:` prefix or the `find` verb:

- `monday item get 12345` — by ID
- `monday item get name:"Refactor login"` — by name (errors if
  ambiguous)
- `monday item find "Refactor login" --board <bid>` — explicit

Names are looked up; IDs are used directly. JSON output always echoes
the resolved ID, so an agent can capture and reuse it.

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

Monday Dev's "sprint", "epic", "release" concepts are board
conventions, not API entities. The CLI:

1. Looks up board IDs from per-profile config (`monday config dev set
   --tasks-board <bid> --sprints-board <bid> --epics-board <bid>`).
2. Translates `monday dev task done <iid>` into a `change_column_value`
   on the configured tasks board's status column.
3. Surfaces shortcuts (`current sprint`, `tasks assigned to me`)
   that would otherwise be multi-step pipelines.

If a user hasn't configured the dev mappings, `monday dev …` returns
`code: "dev_not_configured"` with a structured hint pointing at the
config command.

## 6. Output schema (JSON contract)

The output contract is part of the CLI's public surface. Breaking it
requires a major version bump. The rules are below; specific shapes
live in `docs/output-shapes.md` (to be added per command).

### 6.1 Single resource

```json
{
  "id": "12345",
  "name": "Refactor login",
  "board_id": "67890",
  "group_id": "topics",
  "state": "active",
  "url": "https://...",
  "created_at": "2026-04-29T10:00:00Z",
  "updated_at": "2026-04-29T11:00:00Z",
  "columns": {
    "status_4": { "type": "status", "title": "Status",   "label": "Working on it", "index": 1 },
    "person":   { "type": "people", "title": "Owner",    "people": [{ "id": "1", "name": "Alice", "email": "..." }] },
    "date4":    { "type": "date",   "title": "Due date", "date": "2026-05-01", "time": null }
  }
}
```

Notes:
- IDs are always strings (Monday returns numeric IDs but they exceed
  JS-safe integer range). Always quote.
- Timestamps are ISO 8601 in UTC.
- `columns` is keyed by **column ID** (Monday's stable identifier — does
  not change when the user renames the column). Each value also carries
  `title` as descriptive metadata so a single response is
  self-interpretable for an LLM agent without an extra
  `board describe` round-trip. The title rides along as a *value*, not
  a key, so it can change freely without breaking caller logic that
  keys off the ID.
- Each column value carries `type` so consumers know how to interpret it.
- Read-only columns (mirror, formula, dependency) include the resolved
  display value as `text` and a typed payload where possible.
- `--minimal` drops `title` (and other non-essential descriptive fields)
  for callers that genuinely need to minimise bytes — e.g. NDJSON
  streaming over very large item sets. The default keeps the title.

### 6.2 Collection

```json
{
  "data": [ <resource>, <resource>, ... ],
  "next_cursor": "abc123" | null,
  "has_more": true | false,
  "total_returned": 42
}
```

For `--output ndjson`, each resource is one JSON object per line; the
final line is `{"_end": {"next_cursor": "...", "has_more": false}}`.

### 6.3 Mutation result

```json
{
  "ok": true,
  "data": <resource>,
  "warnings": []
}
```

`--dry-run`:
```json
{
  "ok": true,
  "dry_run": true,
  "planned_change": {
    "operation": "change_multiple_column_values",
    "item_id": "12345",
    "diff": { "status": { "from": "Backlog", "to": "Working on it" } }
  }
}
```

### 6.4 Error

To stderr:
```json
{
  "error": {
    "code": "rate_limited",
    "message": "Complexity budget exceeded",
    "retry_in_seconds": 30,
    "details": { "complexity_used": 9_500_000, "complexity_remaining": 500_000 }
  }
}
```

Stable error codes (initial set, will grow):
- `usage_error` — bad CLI args
- `confirmation_required` — destructive op without `--yes`
- `not_found`, `ambiguous_name`
- `unauthorized`, `forbidden`
- `rate_limited`, `complexity_exceeded`, `daily_limit_exceeded`,
  `concurrency_exceeded`
- `validation_failed` — Monday rejected the payload (e.g. invalid
  status label)
- `config_error`, `cache_error`, `network_error`, `timeout`
- `internal_error` — unexpected; bug if seen

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
monday item list <bid> --filter 'status:Backlog' --output ndjson \
  | jq -r '.id' \
  | monday item set - status=Working
```

### 10.2 Built-in bulk via filter

Bulk commands accept `--filter` instead of a positional and apply the
mutation to every match:

```
monday item update --board <bid> --filter 'status:Backlog' \
  --set status=Working --dry-run
```

`--dry-run` returns `planned_changes: [...]` — the agent can review
before re-running without `--dry-run`.

## 11. Discovery and introspection

For agents new to a Monday workspace, three commands cover everything:

- `monday board list` — what boards can I see?
- `monday board describe <bid>` — full board schema (columns, group
  IDs, status labels, dropdown options). Output is the source of truth
  for what `--set` accepts on items in that board.
- `monday schema` — the CLI's own command schema as JSON. Includes
  every command, its flags (with types), exit codes, and example
  outputs. Agents can ingest this once and never need `--help` again.

`monday schema` also embeds the current set of stable error codes and
the version of the output contract — agents can detect breaking
changes by version-pinning.

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

### v0.1 (alpha — "the core read path")

- `account whoami`, `account info`, `account version`
- `board list/get/describe/find`
- `item list/get/find/search` (incl. `--filter` DSL, `--all` paginate)
- `item set` / `update` with column-value abstraction (status, text,
  numbers, dropdown, date, people)
- `update list/get`
- `cache` and `config`
- `schema`, `raw`
- `--dry-run`, `--output json|ndjson|table`, all global flags

### v0.2 (mutating core)

- `item create/update/move/archive/delete/duplicate`
- `item upsert` (idempotency-key pattern)
- `update create/reply/edit/delete`
- `board create/archive/delete/duplicate`, column + group ops
- `webhook` (CRUD)
- `notification send`

### v0.3 (Monday Dev)

- `dev sprint/epic/release/task`
- `monday auth login --profile` (OAuth + credentials cache)
- Profiles in `~/.monday-cli/config.toml`

### v0.4 (polish)

- `item watch` (polling)
- Shell completion (bash / zsh / fish)
- Bulk operations with `--concurrency`
- Asset upload (`add-file-to-column`, `add-file-to-update`)

### Deferred / non-goals

- Hosting webhooks (CLIs can't expose public HTTP)
- App framework / installable monday apps (out of scope)
- Real-time subscriptions (Monday's GraphQL doesn't support them on
  this endpoint)
- Telemetry, update-notifier, analytics

## 14. Open questions

1. **Published name on npm.** `monday-cli` is taken. Likely
   `@nick-webster/monday-cli` or similar scope. Decide before publish.
2. **Default `--output` behaviour for an agent invoking with stdin
   piped but stdout going to a TTY.** Currently: `json` if non-TTY.
   What if both? Probably still `json` — the presence of stdin input
   is a stronger agent signal. Validate with a test fixture once we
   build it.
3. **Should `monday item upsert` write a hidden tracking column to
   make idempotency robust across rename?** Pros: actually idempotent.
   Cons: pollutes the user's board schema. Default off; opt-in via
   `--write-tracking-column`.
4. **Watch-via-polling cadence and circuit breaker.** Polling at 30s
   is fine for one watcher; if an agent spawns 50 in parallel that's
   100 req/min just from polling. Cap concurrent watches per profile?
5. **Auth caching format.** `monday auth login` should produce a file
   compatible with `gh`/`aws`-style credentials helpers, or use our
   own format? Lean toward our own JSON for simplicity.
6. **GraphQL schema drift.** Monday bumps the API quarterly. Should
   the CLI pin to a version (matching `@mondaydotcomorg/api`'s
   release) or float on current stable? Lean: pin in code, expose
   `--api-version` to override.

---

## Appendix A — example sessions

### A.1 An agent picks up a task and finishes it

```bash
$ monday dev task list --mine --status not_done --output json
{ "data": [
    {"id": "5001", "name": "Refactor login", "status": "Backlog",
     "due": "2026-05-01", "url": "https://..."},
    ...
  ],
  "next_cursor": null, "has_more": false, "total_returned": 7 }

$ monday dev task start 5001
{ "ok": true,
  "data": { "id": "5001", "name": "Refactor login",
            "columns": { "status": { "label": "Working on it" } } } }

# ... agent edits code, opens PR ...

$ monday dev task done 5001 --message "Shipped in PR #1234"
{ "ok": true,
  "data": { "id": "5001",
            "columns": { "status": { "label": "Done" } } },
  "side_effects": [
    { "kind": "update_created", "update_id": "u_77",
      "body": "Shipped in PR #1234" }
  ] }
```

### A.2 Bulk re-triage (dry-run then apply)

```bash
$ monday item update --board 12345 --filter 'status:Backlog AND owner:me' \
    --set status=Working --dry-run --output json
{ "ok": true, "dry_run": true,
  "planned_changes": [
    { "item_id": "5001", "diff": { "status": "Backlog → Working on it" } },
    { "item_id": "5002", "diff": { "status": "Backlog → Working on it" } }
  ],
  "total": 2 }

$ monday item update --board 12345 --filter 'status:Backlog AND owner:me' \
    --set status=Working --yes
{ "ok": true, "applied": 2, "failed": 0 }
```

### A.3 Discovery for a fresh agent

```bash
$ monday board list --output json
{ "data": [
    {"id": "111", "name": "Tasks", "workspace_id": "1"},
    {"id": "112", "name": "Bugs",  "workspace_id": "1"}
  ], ... }

$ monday board describe 111 --output json
{ "id": "111", "name": "Tasks",
  "columns": [
    { "id": "status",  "type": "status",
      "labels": [{"index":0,"label":"Backlog"},
                 {"index":1,"label":"Working on it"},
                 {"index":2,"label":"Done"}] },
    { "id": "owner",   "type": "people" },
    { "id": "due",     "type": "date" },
    { "id": "epic",    "type": "board_relation",
      "linked_board_id": "115" },
    ...
  ],
  "groups": [{"id": "topics", "title": "Backlog"}, ...] }
```

### A.4 Pipelining

```bash
# All items I haven't updated in 30 days, archive them
monday item list --board 111 \
    --filter 'updated:not_within_last(30d)' \
    --output ndjson --all \
  | jq -r '.id' \
  | monday item archive - --yes
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
