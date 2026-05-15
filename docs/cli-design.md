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

User, Team, Tag, Webhook, Document, Notification — global, not nested under boards.
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

   **Raw-bytes carve-out (v0.4-M33).** A narrow class of verbs emits
   content where the bytes themselves ARE the agent- / human-meaningful
   payload — destined for `eval`, `source`, or direct write to a
   file consumed by another tool. `monday completion <bash|zsh|fish>`
   is the canonical case: the standard install flow is
   `monday completion bash >> ~/.bashrc`, a pipe context where
   wrapping the bytes in a §6 envelope would defeat the purpose. For
   this class:

   - Default behaviour (no `--json` / no `--output` / no `MONDAY_OUTPUT`):
     RAW bytes on stdout with NO envelope, regardless of TTY / pipe
     context.
   - `--json` / `--output json` / `MONDAY_OUTPUT=json`: explicitly
     opts INTO the standard §6 envelope, wrapping the bytes as a
     string field under `data`. Useful for agent introspection.
   - `--table` / `--output table` / `--output text` / `--output
     ndjson`: rejected as `usage_error` ("output format not
     applicable to <verb>") — there is no sensible non-JSON envelope
     rendering of an opaque byte blob. Only `--json` and `--table`
     are global shorthand flags per §4.4; `text` and `ndjson` are
     accessible only via the long-form `--output <fmt>` value.

   The verb's `--help` and the §4.3 entry MUST make the carve-out
   explicit. This is the only documented exception to rule #2.
   New verbs MUST NOT extend this carve-out without an explicit
   contract amendment (it weakens the §3.1 #2 invariant agents key
   off of).
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
   short-circuit any "are you sure?" path. Live destructive
   commands without `--yes` AND without `--dry-run` fail fast
   with `code: "confirmation_required"`. `--dry-run` bypasses the
   gate entirely (dry-run is non-executing — no wire mutation
   fires, so there's nothing to confirm); the dry-run envelope
   emits `meta.dry_run: true` regardless of `--yes` presence.
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
deep is the default cap — agents lose track of three-level trees. Two
explicit carve-outs at three levels exist (the `dev` workflow
namespace and `item time-track <verb>` for verb-shaped column-type
extensions); see §5.2 for the rule and §5.9 / §4.3 for the surfaces.

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
| `auth` | OAuth-issued credentials cache | `login` / `logout` per profile (v0.3-M21; see §7.3 / §7.4). |
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
monday account tags                       # per-account tag directory (cache-aware) v0.3

# === WORKSPACE ===
monday workspace list                     # all visible workspaces           v0.1
monday workspace get <wid>                                                   v0.1
monday workspace folders <wid>            # folders inside workspace         v0.1
monday workspace create --name <n> [--kind open|closed] [--description <d>] [--dry-run]   v0.2
                                          # `create_workspace(name, kind, description?)`.
                                          # Monday's GraphQL signature pins `kind:
                                          # WorkspaceKind!` (required at the wire);
                                          # the CLI defaults to `open` when --kind is
                                          # omitted so agents don't have to remember
                                          # the wire constraint. `--description <d>`
                                          # is optional; omitting it sends no
                                          # `description` argument so Monday's server-
                                          # side default applies. Idempotent: NO —
                                          # re-running creates a second workspace
                                          # with the same name. Agents needing dedupe
                                          # call `workspace list` first. NOT
                                          # destructive (no --yes gate). Dry-run shape
                                          # per §6.4 workspace-create variant:
                                          # `{operation: "create_workspace", name,
                                          # kind, description?}`. `meta.source:
                                          # "none"` (no API call fires).
monday workspace update <wid> [--name <n>] [--kind open|closed] [--description <d>] [--dry-run]   v0.2
                                          # `update_workspace(id, attributes: {name?,
                                          # kind?, description?})`. At least one of
                                          # --name / --kind / --description required —
                                          # zero-flag invocation → `usage_error` at
                                          # argv-parse (no point firing a no-op
                                          # mutation). Idempotent: yes — re-applying
                                          # the same field values is a no-op on
                                          # Monday's side. Dry-run shape per §6.4
                                          # workspace-update variant: a field-level
                                          # diff with `from → to` per provided field
                                          # (mirrors the column-mutation shape with
                                          # workspace fields substituted for column
                                          # IDs). The `from` state requires a
                                          # preflight `workspace get` read leg —
                                          # `meta.source: "live"` (workspace
                                          # metadata isn't cached in v0.2; M16's
                                          # board-metadata cache doesn't extend to
                                          # workspaces).
monday workspace delete <wid> --yes [--dry-run]                              v0.2
                                          # `delete_workspace(workspace_id)`.
                                          # Destructive: --yes mandatory for
                                          # live deletion. Live without --yes
                                          # AND without --dry-run →
                                          # confirmation_required (exit 1)
                                          # per §3.1 #7; --dry-run bypasses
                                          # the gate.
                                          # Re-deleting an already-deleted workspace
                                          # surfaces `not_found`, so the CLI marks
                                          # `idempotent: false` (mirrors `item
                                          # delete` / `update delete` rationale).
                                          # **Admin-permission-sensitive** — non-
                                          # admin callers surface `forbidden` (§6.5)
                                          # carrying Monday's PERMISSION_DENIED
                                          # extension. Dry-run shape per §6.4
                                          # workspace-delete variant: minimal
                                          # `{operation: "delete_workspace",
                                          # workspace_id}`. No preflight read fires;
                                          # the dry-run is purely argv-derived.
                                          # `meta.source: "none"`.
monday workspace add-users <wid> --users <id|email>,... [--dry-run]          v0.2
                                          # `add_users_to_workspace(workspace_id,
                                          # user_ids)` fanned out one wire call per
                                          # user. The wire mutation also accepts an
                                          # optional `kind: WorkspaceSubscriberKind`
                                          # argument; M14 deliberately OMITS it and
                                          # relies on Monday's server-side default
                                          # (subscriber). Owner-tier and explicit
                                          # subscriber-kind selection are deferred
                                          # to a later milestone (no v0.2 surface
                                          # decision blocking M14). `--users`
                                          # accepts numeric IDs and emails mixed in
                                          # one comma-separated list. Numeric IDs
                                          # are argv-derived (no resolution leg
                                          # fires); only email tokens flow through
                                          # M5a's `userByEmail` (directory cache +
                                          # `users(emails:)` fallback). **Partial-
                                          # success envelope** per §6.4 — emits one
                                          # `ok: true` envelope with `data: {
                                          # operation: "add_users_to_workspace",
                                          # results: [{user_id, ok, error?}] }`
                                          # (`data.operation` per v0.2-plan §3 M14
                                          # decision; `data.operation` lives on
                                          # `data` not `meta` per the upsert
                                          # precedent in §6.4 line 2331). Per-user
                                          # resolution failures (`user_not_found`)
                                          # AND per-user dispatch failures land in
                                          # the per-record `error` slot rather than
                                          # aborting the loop; on a resolution
                                          # failure `user_id` carries the input
                                          # token verbatim so agents can correlate.
                                          # Top-level `error` reserved for whole-
                                          # call failure (couldn't reach API; OR
                                          # **no dispatchable user_id remains
                                          # after parsing/resolution** — every
                                          # `--users` token was an email AND
                                          # every email failed `userByEmail`
                                          # lookup → top-level `user_not_found`,
                                          # exit 2; carries `details.failed_tokens:
                                          # [...]`). A mixed call where some
                                          # numeric IDs OR some emails resolve
                                          # successfully still gets the partial-
                                          # success envelope — failed-resolution
                                          # records land per-`results` slot, not
                                          # whole-call. Malformed `--users` syntax
                                          # (blank token, non-numeric AND non-
                                          # email) → top-level `usage_error`,
                                          # exit 1.
                                          # Sequential per §8 decision 8 — parallel
                                          # waits for v0.4 `--concurrency`.
                                          # Idempotent: yes — re-adding an existing
                                          # member is a no-op on Monday's side.
                                          # **Admin-permission-sensitive**. Dry-run
                                          # resolves every email `--users` token
                                          # (numeric IDs skip resolution) so
                                          # `user_not_found` surfaces ahead of the
                                          # live call; emits the same per-user
                                          # record shape with `would_apply`
                                          # substituted for `ok` (§6.4 workspace-
                                          # add-users variant). `meta.source`
                                          # aggregates DIFFERENTLY between dry-run
                                          # and live — dry-run sees only resolver
                                          # legs (all-numeric → `none`; cache →
                                          # `cache`; live `users(emails:)` →
                                          # `live`; combos → `mixed`); live also
                                          # folds in every per-target mutation
                                          # dispatch leg (always `live`), so
                                          # all-numeric live aggregates to `live`
                                          # (not `none`), all-email-cache live
                                          # aggregates to `mixed` (cache
                                          # resolver + live dispatch). See §6.4
                                          # `meta.source` aggregation rule.
monday workspace remove-users <wid> --users <id|email>,... [--dry-run]       v0.2
                                          # `delete_users_from_workspace(workspace_id,
                                          # user_ids)`. Mirrors `add-users` shape
                                          # exactly: same fan-out (one wire call
                                          # per user); same partial-success
                                          # envelope including `data.operation:
                                          # "delete_users_from_workspace"`; same
                                          # `--users` parser (numeric argv-derived,
                                          # email through `userByEmail`); same
                                          # `meta.source` aggregation rule; same
                                          # dry-run per-record shape with
                                          # `would_apply`; same `usage_error` /
                                          # `user_not_found` whole-call boundaries.
                                          # Idempotent: yes — re-removing a non-
                                          # member is a no-op. **Admin-permission-
                                          # sensitive**. Dry-run shape per §6.4
                                          # workspace-remove-users variant:
                                          # `{operation: "delete_users_from_workspace",
                                          # workspace_id, results: [...]}`.

# === BOARD ===
monday board list [--workspace <wid>] [--state active|archived|all]          v0.1
monday board get <bid>                                                       v0.1
monday board find <name> [--workspace <wid>] [--first]                       v0.1
monday board describe <bid>               # full schema; see §11.2           v0.1
monday board doctor <bid>                 # diagnostics; see §11.2           v0.1
monday board subscribers <bid>                                               v0.1
monday board favorites                    # current user's starred boards   v0.3
                                          # natural scoping lever for v0.3
                                          # cross-board `item search`.
                                          # 2-stage GraphQL op: (a) `Query.
                                          # favorites { object { id type } }`
                                          # filtered to `type=Board`, then
                                          # (b) `boards(ids:[...])` to hydrate
                                          # name + state + workspace_id + url.
                                          # Output sorted by Monday's UI
                                          # position (Float). Read-only —
                                          # writes (favoriting/unfavoriting)
                                          # are NOT in v0.3 scope. Surfaces
                                          # `board_favorites_stale` warning
                                          # when Stage-1 yielded N boards
                                          # but Stage-2 hydrated fewer
                                          # (revoked access, deleted, or
                                          # archived to private workspace).
monday board create --name <n> [--workspace <wid>] [--kind public|private|share] [--template <bid>] [--description <d>] [--dry-run]   v0.2
                                          # `create_board(board_name, board_kind,
                                          # workspace_id?, template_id?,
                                          # description?, ...)`. Monday's signature
                                          # additionally accepts owner / subscriber
                                          # lists at creation; M15 defers those to
                                          # a follow-up `add-users` call so the
                                          # creation surface stays narrow. Monday's
                                          # GraphQL signature pins `board_kind:
                                          # BoardKind!` (required at the wire); the
                                          # CLI defaults to `public` when --kind is
                                          # omitted so agents don't have to remember
                                          # the wire constraint. `--workspace <wid>`
                                          # is optional — Monday creates the board
                                          # in the user's main workspace when the
                                          # flag is omitted. `--template <bid>`
                                          # clones from a Monday template — `<bid>`
                                          # is the template board's ID. Templates
                                          # are managed via Monday's UI; the
                                          # `BoardKind` enum has no `template`
                                          # value (only `public` / `private` /
                                          # `share`), so the CLI doesn't validate
                                          # template-ness ahead of the wire call.
                                          # When the ID isn't a valid template,
                                          # Monday surfaces a wire error which the
                                          # CLI re-maps per §6.5
                                          # (`validation_failed` typically). The
                                          # new board's structure mirrors the
                                          # template's columns and groups.
                                          # `--description <d>` is optional;
                                          # omitting it sends no `description`
                                          # argument so Monday's server-side default
                                          # applies. Idempotent: NO — re-running
                                          # creates a second board with the same
                                          # name. NOT destructive (no --yes gate).
                                          # Dry-run shape per §6.4 board-create
                                          # variant: `{operation: "create_board",
                                          # name, workspace_id?, kind, description?,
                                          # template_id?}`. `meta.source: "none"`
                                          # (no API call fires).
monday board update <bid> [--name <n>] [--description <d>] [--dry-run]       v0.2
                                          # `update_board(board_id, board_attribute:
                                          # BoardAttributes!, new_value: String!)`.
                                          # Unlike `update_workspace`, Monday's
                                          # `update_board` is **per-attribute** —
                                          # each wire call updates exactly one of
                                          # `name` / `description` / `communication`.
                                          # The CLI fans out one wire call per
                                          # provided flag: `board update <bid>
                                          # --name X --description Y` fires two
                                          # sequential `update_board` calls.
                                          # Sequential per §8 decision 8 (parallel
                                          # waits for v0.4 `--concurrency`). At
                                          # least one of --name / --description
                                          # required — zero-flag invocation →
                                          # `usage_error` at argv-parse. Whole-call
                                          # shape: single envelope on success
                                          # (`data` = full board projection from a
                                          # final `boards(ids:)` read leg — this
                                          # post-mutation read MUST bypass the
                                          # board-metadata cache (force-live) so
                                          # the success envelope reflects the
                                          # post-update state, not stale cached
                                          # metadata. `meta.source: "live"` for the
                                          # success path. Cache-sourced reads are
                                          # allowed only for the dry-run preflight
                                          # preview, not the live-success final
                                          # read);
                                          # whole-call error envelope on any per-
                                          # field failure (the multi-call wire
                                          # shape doesn't leak as partial-success —
                                          # the envelope is `ok: true` only when
                                          # every per-field call succeeded; on any
                                          # per-field failure the envelope is
                                          # `ok: false`). **Server-side state is
                                          # NOT transactional** — per-field calls
                                          # earlier in the sequence may have
                                          # already committed when a later call
                                          # fails. This matches Monday's wire
                                          # constraint (no transaction across
                                          # per-attribute mutations) and is the
                                          # strongest guarantee compatible with
                                          # the wire shape; agents re-issuing
                                          # after a failure should re-read the
                                          # board to see what landed before
                                          # retrying the unapplied tail. See
                                          # §6.4 board-update partial-application
                                          # caveat. Idempotent: yes — re-applying
                                          # the same field values is a no-op on
                                          # Monday's side. Dry-run shape
                                          # per §6.4 board-update variant: a field-
                                          # level `from → to` diff per provided
                                          # flag (mirrors workspace-update shape
                                          # with board fields substituted). The
                                          # `from` state requires a preflight
                                          # `board get` read — `meta.source: "live"`
                                          # or `"cache"` (board metadata is cached
                                          # per v0.1's board-metadata cache; M16
                                          # adds the eager-invalidation contract
                                          # so successful `board update` calls
                                          # invalidate the cache entry).
monday board archive <bid> --yes [--dry-run]                                 v0.2
                                          # `archive_board(board_id)`. Destructive
                                          # — --yes mandatory for live archive.
                                          # Live without --yes AND without
                                          # --dry-run → `confirmation_required`
                                          # (exit 1) per §3.1 #7 + §8 decision
                                          # 9 (archive is consistently --yes-
                                          # gated across nouns); --dry-run
                                          # bypasses the gate. Idempotent:
                                          # yes — re-archiving an already-archived
                                          # board is a no-op (per §9.1). Dry-run
                                          # shape per §6.4 board-archive variant:
                                          # `{operation: "archive_board",
                                          # board_id, board: <projected source
                                          # snapshot>}` — mirrors item-archive's
                                          # preflight-read-for-snapshot pattern so
                                          # the agent can verify the ID before re-
                                          # running with --yes. `meta.source: "live"`
                                          # or `"cache"` (preflight read leg can hit
                                          # the v0.1 board-metadata cache). Calls
                                          # `invalidateBoard(boardId)` post-success
                                          # per §8 eager-invalidation contract — the
                                          # board's `state` flips from `active` to
                                          # `archived` at the wire and the cached
                                          # `state` field would otherwise lag until
                                          # TTL eviction. Lifted into the M16
                                          # retrofit cluster alongside `board
                                          # update` + `board delete`.
monday board delete <bid> --yes [--dry-run]                                  v0.2
                                          # `delete_board(board_id)`. Destructive
                                          # — --yes mandatory for live deletion.
                                          # Live without --yes AND without
                                          # --dry-run → `confirmation_required`
                                          # (exit 1) per §3.1 #7; --dry-run
                                          # bypasses the gate. Re-deleting an
                                          # already-deleted board surfaces
                                          # `not_found`, so the CLI marks
                                          # `idempotent: false` (mirrors `item
                                          # delete` / `update delete` /
                                          # `workspace delete` rationale). Dry-run
                                          # shape per §6.4 board-delete variant:
                                          # minimal `{operation: "delete_board",
                                          # board_id}`. No preflight read fires;
                                          # the dry-run is purely argv-derived
                                          # (Monday's `delete_board(board_id)`
                                          # reports `not_found` if the id is
                                          # bogus). `meta.source: "none"`. Mirrors
                                          # the destructive-no-read pattern uniform
                                          # across `item delete`, `update delete`,
                                          # `workspace delete`. Note the deliberate
                                          # divergence from `board archive`: archive
                                          # carries the source snapshot (item-
                                          # archive precedent), delete is minimal
                                          # (workspace-delete precedent). Calls
                                          # `invalidateBoard(boardId)` post-success
                                          # per §8 eager-invalidation contract —
                                          # the board no longer exists wire-side
                                          # and the cached entry would otherwise
                                          # serve a phantom board until TTL
                                          # eviction (a same-process `board
                                          # describe` reading right after the
                                          # delete would surface stale metadata
                                          # rather than `not_found`). Lifted into
                                          # the M16 retrofit cluster alongside
                                          # `board update` + `board archive`.
monday board duplicate <bid> [--name <n>] [--workspace <wid>] [--with-updates] [--dry-run]   v0.2
                                          # `duplicate_board(board_id,
                                          # duplicate_type: DuplicateBoardType!,
                                          # board_name?, workspace_id?,
                                          # folder_id?, keep_subscribers?)`. The
                                          # DuplicateBoardType enum carries three
                                          # values (`duplicate_board_with_structure`,
                                          # `duplicate_board_with_pulses`,
                                          # `duplicate_board_with_pulses_and_updates`);
                                          # the CLI surfaces only the items-included
                                          # branch. Without --with-updates, the wire
                                          # call uses `duplicate_board_with_pulses`
                                          # (items WITHOUT updates). With
                                          # --with-updates, the wire call uses
                                          # `duplicate_board_with_pulses_and_updates`
                                          # (items WITH updates). Skeleton-only
                                          # duplication (the `with_structure` arm)
                                          # is deferred to a later v0.x surface;
                                          # agents needing it call the wire mutation
                                          # via M9's `dev mutate` escape hatch.
                                          # `--workspace <wid>` is optional —
                                          # defaults to the source board's
                                          # workspace. `--name <n>` is optional;
                                          # Monday's server-side default is "<source
                                          # name> (Copy)" when omitted. Idempotent:
                                          # NO — re-running creates a second copy.
                                          # NOT destructive (no --yes gate). Dry-run
                                          # shape per §6.4 board-duplicate variant:
                                          # `{operation: "duplicate_board",
                                          # board_id, with_updates,
                                          # target_workspace_id?, target_name?,
                                          # board: <projected source snapshot>}`.
                                          # `meta.source: "live"` or `"cache"`
                                          # (preflight read leg).
monday board add-users <bid> --users <id|email>,... [--dry-run]              v0.2
                                          # `add_users_to_board(board_id, user_ids,
                                          # kind?: BoardSubscriberKind)` fanned out
                                          # one wire call per user. The wire
                                          # mutation also accepts an optional
                                          # `kind: BoardSubscriberKind` argument;
                                          # M15 deliberately OMITS it and relies
                                          # on Monday's server-side default
                                          # (subscriber). Owner-tier and explicit
                                          # subscriber-kind selection are deferred
                                          # to a later milestone (no v0.2 surface
                                          # decision blocking M15). `--users`
                                          # accepts numeric IDs and emails mixed in
                                          # one comma-separated list. Numeric IDs
                                          # are argv-derived (no resolution leg
                                          # fires); only email tokens flow through
                                          # M5a's `userByEmail` (directory cache +
                                          # `users(emails:)` fallback). **Partial-
                                          # success envelope** per §6.4 — emits one
                                          # `ok: true` envelope with `data: {
                                          # operation: "add_users_to_board",
                                          # results: [{user_id, ok, error?}] }`
                                          # (`data.operation` per the M14
                                          # workspace-add-users / remove-users
                                          # precedent; `data.operation` lives on
                                          # `data` not `meta`). Per-user resolution
                                          # failures (`user_not_found`) AND per-
                                          # user dispatch failures land in the per-
                                          # record `error` slot rather than aborting
                                          # the loop; on a resolution failure
                                          # `user_id` carries the input token
                                          # verbatim so agents can correlate.
                                          # Top-level `error` reserved for whole-
                                          # call failure (couldn't reach API; OR
                                          # **no dispatchable user_id remains
                                          # after parsing/resolution** — every
                                          # `--users` token was an email AND
                                          # every email failed `userByEmail`
                                          # lookup → top-level `user_not_found`,
                                          # exit 2; carries `details.failed_tokens:
                                          # [...]`). A mixed call where some
                                          # numeric IDs OR some emails resolve
                                          # successfully still gets the partial-
                                          # success envelope. Malformed `--users`
                                          # syntax (blank token, non-numeric AND
                                          # non-email) → top-level `usage_error`,
                                          # exit 1. Sequential per §8 decision 8.
                                          # Idempotent: yes — re-adding an
                                          # existing member is a no-op. Dry-run
                                          # resolves every email `--users` token
                                          # (numeric IDs skip resolution) so
                                          # `user_not_found` surfaces ahead of the
                                          # live call; emits the same per-user
                                          # record shape with `would_apply`
                                          # substituted for `ok` (§6.4 board-add-
                                          # users variant). `meta.source` aggregates
                                          # DIFFERENTLY between dry-run and live —
                                          # see §6.4 `meta.source` aggregation rule
                                          # under workspace-add-users for the table.
                                          # `board add-users` is the third
                                          # partial-success-fan-out consumer (after
                                          # M14's workspace add-users / remove-
                                          # users), triggering the R40 lift at M15
                                          # close per v0.2-plan §22 R40.

# Columns (board-scoped)
monday board columns <bid>                # list columns                     v0.1
monday board column-create <bid> --type <type> --title <t> [--description <d>] [--settings <json>] [--dry-run]   v0.2
                                          # `create_column(board_id,
                                          # column_type, title, description?,
                                          # defaults?, after_column_id?, id?)`.
                                          # The wire mutation also accepts an
                                          # optional `id: String` (agent-supplied
                                          # custom column ID) and `after_column_id:
                                          # ID` (placement); M16 deliberately OMITS
                                          # both — no v0.2 surface decision blocks
                                          # M16, and agents needing them call the
                                          # wire mutation via M9's `dev mutate`
                                          # escape hatch. Returns `Maybe<Column>`.
                                          # `--type <type>` validates against the
                                          # full ColumnType enum (~40 values per
                                          # SDK 14.0.0; see §2.3). The set
                                          # exceeds v0.2's writable allowlist
                                          # (§5.3) — a warning fires when the
                                          # requested type isn't in
                                          # `WRITABLE_COLUMN_TYPES`, branched by
                                          # category per the §5.3 escape-hatch
                                          # contract:
                                          #   - Raw-writable types (anything that
                                          #     accepts `change_column_value` —
                                          #     e.g. `country`, `hour`, `timeline`
                                          #     in v0.2) → warning suggests
                                          #     `--set-raw <col>=<json>` for
                                          #     subsequent writes.
                                          #   - Read-only-forever types (`mirror`,
                                          #     `formula`, `auto_number`,
                                          #     `creation_log`, `last_updated`,
                                          #     `item_id`, `item_assignees`) →
                                          #     warning notes there's no write
                                          #     path; the column exists but
                                          #     `--set` / `--set-raw` against it
                                          #     surfaces `unsupported_column_type`.
                                          #   - `files`-shaped (`file`) → warning
                                          #     notes write path is
                                          #     `add_file_to_column`, deferred to
                                          #     v0.4 (asset upload).
                                          # The command still proceeds in all
                                          # cases — Monday accepts non-writable
                                          # types and agents may legitimately want
                                          # them for read-only display, mirror
                                          # sources, etc. The warning surfaces in
                                          # `warnings: [{ code:
                                          # "noncanonical_column_type",
                                          # message, details: {column_type,
                                          # category, suggested_write_path}
                                          # }]` so JSON consumers can branch
                                          # on it. `category` is one of
                                          # `"raw_writable"` (suggests
                                          # `--set-raw <col>=<json>`) /
                                          # `"read_only_forever"` (no write
                                          # path; `suggested_write_path: null`)
                                          # / `"files_shaped"` (suggests
                                          # `add_file_to_column` deferred to
                                          # v0.4). `category` is a stable
                                          # enum — adding a value is
                                          # SemVer-minor; removing is
                                          # SemVer-major.
                                          # `--title <t>` is required; empty
                                          # after trim → `usage_error` at argv-
                                          # parse. `--description <d>` is
                                          # optional. `--settings <json>` is
                                          # type-specific JSON for column config
                                          # (status labels, dropdown options,
                                          # date formats, etc.) — passes through
                                          # as the wire `defaults: JSON`
                                          # argument (NOT `settings_str` —
                                          # `settings_str` is the READ-side
                                          # serialisation of column settings;
                                          # `defaults` is the WRITE-side input
                                          # parameter). `--settings <json>` is
                                          # parsed as JSON at argv-parse-time
                                          # (malformed JSON → `usage_error`,
                                          # exit 1, before any network call) and
                                          # validated against a per-type zod
                                          # schema for types in
                                          # `WRITABLE_COLUMN_TYPES`. The
                                          # contract pins the SHAPE
                                          # (`--settings` is per-type JSON,
                                          # validated at argv-parse against a
                                          # per-type schema, before any
                                          # network call); M16's
                                          # implementation owns the per-
                                          # schema field set (status's
                                          # `labels`, dropdown's `labels`,
                                          # date's `{}`, numbers' `{unit:
                                          # ...}`, etc. — pre-flight doesn't
                                          # enumerate them exhaustively
                                          # because Monday's accepted shapes
                                          # are documented outside the SDK's
                                          # typed surface and evolve over
                                          # time, and over-pinning here
                                          # would force docs revisions every
                                          # time Monday adds a setting key).
                                          # Type-mismatched settings (e.g.
                                          # `--type text --settings
                                          # '{"labels":[]}'`) → `usage_error`
                                          # with `details: {column_type,
                                          # expected_keys?, actual_keys?,
                                          # hint}` (the optional fields are
                                          # populated when the per-type
                                          # schema's expected key set is
                                          # known; absent for raw-writable /
                                          # read-only-forever / files-shaped
                                          # types where validation is JSON-
                                          # only). Raw-writable + read-only-
                                          # forever + files-shaped types
                                          # skip type-specific validation —
                                          # `--settings` for these types
                                          # only requires well-formed JSON
                                          # (Monday validates server-side;
                                          # the CLI can't model every type's
                                          # settings exhaustively).
                                          # Idempotent: NO — re-running creates
                                          # a second column with the same title
                                          # (Monday auto-generates a fresh
                                          # column ID per call). NOT
                                          # destructive (no --yes gate). Calls
                                          # `invalidateBoard(boardId)` post-
                                          # success per §8 eager-invalidation
                                          # contract — the cached `columns:
                                          # [...]` list is now stale.
                                          # Dry-run shape per §6.4 column-create
                                          # variant: `{operation: "create_column",
                                          # board_id, type, title, description?,
                                          # settings?}`. `meta.source: "none"`
                                          # (no API call fires).
monday board column-update <bid> <cid> [--title <t>] [--description <d>] [--dry-run]   v0.2
                                          # Per-attribute fan-out across two
                                          # wire mutations: `--title` calls
                                          # `change_column_title(board_id,
                                          # column_id, title)`; `--description`
                                          # calls
                                          # `change_column_metadata(board_id,
                                          # column_id, column_property?:
                                          # ColumnProperty, value?: String)`
                                          # — both `column_property` and
                                          # `value` are optional at the wire
                                          # (SDK 14.0.0 `MutationChange_
                                          # Column_MetadataArgs`); the CLI
                                          # always supplies both whenever
                                          # `--description` is provided
                                          # (`column_property: description`,
                                          # `value: <description>`). The
                                          # `ColumnProperty` enum (SDK 14.0.0)
                                          # carries only two values
                                          # (`title` / `description`), so
                                          # `change_column_metadata` could
                                          # equivalently set the title; the CLI
                                          # routes `--title` to
                                          # `change_column_title` (the more
                                          # specific Monday surface) and
                                          # `--description` to
                                          # `change_column_metadata`. Multi-
                                          # flag invocations (`--title X
                                          # --description Y`) fan out N
                                          # sequential wire calls, sequential
                                          # per §8 decision 8 (parallel waits
                                          # for v0.4 `--concurrency`). At
                                          # least one of --title /
                                          # --description required — zero-flag
                                          # invocation → `usage_error` at
                                          # argv-parse. **Whole-call shape**
                                          # mirrors `board update`'s contract:
                                          # single envelope on success
                                          # (`data` = the column projection
                                          # from the last successful per-
                                          # attribute call's wire response
                                          # — Monday's column-mutation
                                          # responses return `Maybe<Column>`
                                          # post-mutation, so the trailing
                                          # call's response is authoritative
                                          # for both fields and no separate
                                          # force-live read leg fires);
                                          # whole-call error envelope on any
                                          # per-field failure. **Server-
                                          # side state is NOT transactional**
                                          # — per-field calls earlier in the
                                          # sequence may have already
                                          # committed when a later call
                                          # fails. This matches Monday's wire
                                          # constraint (no transaction across
                                          # column-mutation calls) and
                                          # mirrors `board update`'s
                                          # partial-application caveat. See
                                          # §6.4 column-update variant for
                                          # the partial-application contract.
                                          # Idempotent: yes — re-applying
                                          # the same field values is a no-op
                                          # on Monday's side. Dry-run shape
                                          # per §6.4 column-update variant:
                                          # field-level `from → to` diff
                                          # per provided flag. The `from`
                                          # state requires a preflight
                                          # `board describe`-shaped read to
                                          # locate the column by ID inside
                                          # `boardMetadataSchema.columns:
                                          # [...]`; that read can hit the
                                          # v0.1 board-metadata cache —
                                          # `meta.source: "live"` or
                                          # `"cache"`. Calls
                                          # `invalidateBoard(boardId)`
                                          # post-success per §8 eager-
                                          # invalidation contract. On
                                          # partial-application failure
                                          # (call N+1 fails after call N
                                          # succeeded), invalidation tracks
                                          # the wire-state high-water mark
                                          # — the cache is invalidated as
                                          # far as the successful legs
                                          # reached, never further (§8
                                          # call-site contract). Note the
                                          # success-path `data` projection
                                          # CAN source from the wire
                                          # response directly (no force-
                                          # live read leg), distinguishing
                                          # column-update from board-update
                                          # (which forces-live because its
                                          # wire response is per-attribute
                                          # and a final whole-board read is
                                          # needed for the projection).
monday board column-delete <bid> <cid> --yes [--dry-run]                     v0.2
                                          # `delete_column(board_id,
                                          # column_id)`. Returns
                                          # `Maybe<Column>` (the column's
                                          # last-look projection before
                                          # deletion — Monday convention).
                                          # Destructive — --yes mandatory
                                          # for live deletion (without
                                          # --yes AND without --dry-run →
                                          # `confirmation_required`, exit
                                          # 1) per §3.1 #7 + §8 decision
                                          # 9; the confirmation gate fires
                                          # BEFORE `resolveClient()` so a
                                          # missing-token call still
                                          # surfaces `confirmation_required`
                                          # (the M10 round-1 P2 ordering
                                          # invariant; R29's
                                          # `assertConfirmation` helper
                                          # preserves it via already-parsed
                                          # `globalFlags`). The
                                          # `confirmation_required` envelope
                                          # carries the single-target
                                          # destructive-gate `details`
                                          # shape per §6.5: `{board_id,
                                          # column_id, hint}` (the column-
                                          # delete wire signature is two-
                                          # tuple, so both IDs echo).
                                          # `--dry-run` bypasses the
                                          # confirmation gate entirely
                                          # (mirrors `item
                                          # archive` / `item delete` /
                                          # `board archive` / `board
                                          # delete` precedent — dry-run is
                                          # non-executing and the gate is
                                          # for live destructive writes
                                          # only); `column-delete <bid>
                                          # <cid> --dry-run` without
                                          # `--yes` emits the dry-run
                                          # envelope with `meta.source:
                                          # "none"`. Re-deleting an
                                          # already-deleted column
                                          # surfaces `not_found` past the
                                          # mutation; the CLI marks
                                          # `idempotent: false` (mirrors
                                          # `item delete` / `update
                                          # delete` / `workspace delete` /
                                          # `board delete` rationale —
                                          # wire-level converges, CLI-level
                                          # surfaces a different envelope).
                                          # Calls `invalidateBoard
                                          # (boardId)` post-success per
                                          # §8 eager-invalidation contract.
                                          # Dry-run shape per §6.4
                                          # column-delete variant: minimal
                                          # `{operation: "delete_column",
                                          # board_id, column_id}`. No
                                          # preflight read leg fires; the
                                          # dry-run is purely argv-derived
                                          # (Monday's `delete_column
                                          # (board_id, column_id)` reports
                                          # `not_found` if the ids are
                                          # bogus). `meta.source: "none"`.
                                          # Mirrors the destructive-no-read
                                          # pattern uniform across `item
                                          # delete`, `update delete`,
                                          # `workspace delete`, `board
                                          # delete`. Note the deliberate
                                          # divergence from a column-
                                          # archive variant: Monday has no
                                          # `archive_column` mutation —
                                          # column lifecycle is delete-
                                          # only, mirroring the underlying
                                          # API surface.

# Groups (board-scoped)
monday board groups <bid>                                                    v0.1
monday board group-create <bid> --name <n> [--color <c>] [--dry-run]         v0.2
                                          # `create_group(board_id, group_name,
                                          # position?, position_relative_method?,
                                          # relative_to?, group_color?)` per SDK
                                          # 14.0.0 `MutationCreate_GroupArgs`.
                                          # Returns `Maybe<Group>`. The wire
                                          # mutation accepts three placement
                                          # arguments — `position: String?`
                                          # (Monday's per-changelog deprecated
                                          # numeric-string position; literal
                                          # `top` / `bottom` strings have
                                          # ambiguous wire semantics — non-
                                          # numeric values historically default
                                          # to top placement, and Monday's
                                          # changelog flags this surface for
                                          # removal), and the relative-position
                                          # pair (`position_relative_method:
                                          # PositionRelative` ∈ `after_at` |
                                          # `before_at`, paired with `relative_
                                          # to: String` naming the anchor group
                                          # by ID). M17 deliberately OMITS all
                                          # three placement surfaces — the v0.2
                                          # CLI ships `group-create` without a
                                          # `--position` flag, deferring
                                          # placement control to v0.3 (where the
                                          # CLI may surface `--before <gid>` /
                                          # `--after <gid>` flags mapping to the
                                          # non-deprecated `position_relative_
                                          # method` + `relative_to` pair).
                                          # Agents needing placement today call
                                          # the wire mutation via M9's `dev
                                          # mutate` escape hatch (mirrors M16
                                          # column-create's omission of `id` +
                                          # `after_column_id`). `--name <n>` is
                                          # required; empty after trim →
                                          # `usage_error` at argv-parse.
                                          # `--color <c>` maps to wire
                                          # `group_color`; validated at
                                          # argv-parse against Monday's
                                          # supported group-color names (M17
                                          # implementation owns the specific
                                          # zod string-enum field set — Monday's
                                          # accepted colour names are documented
                                          # outside the SDK's typed surface and
                                          # evolve over time, so over-pinning
                                          # them in the contract would force
                                          # docs revisions on every Monday
                                          # palette tweak; same rationale as
                                          # M16 column-create's per-type
                                          # `--settings` schema field-set
                                          # ownership).
                                          # Idempotent: NO — re-running creates
                                          # a second group with the same name
                                          # (Monday auto-generates a fresh group
                                          # ID per call). NOT destructive (no
                                          # --yes gate). Calls
                                          # `invalidateBoard(boardId)` post-
                                          # success per §8 eager-invalidation
                                          # contract — the cached `groups: [...]`
                                          # list is now stale. Single-leg per
                                          # §8 call-site contract; M17 adopts
                                          # M16's R46 `withBoardInvalidation
                                          # SingleLeg` post-success projection
                                          # wrapper from day one (mirrors
                                          # R29's M14-close-then-M15-adopts
                                          # pattern).
                                          # Dry-run shape per §6.4 group-create
                                          # variant: `{operation: "create_group",
                                          # board_id, name, color?}`.
                                          # `meta.source: "none"` (no API call
                                          # fires).
monday board group-update <bid> <gid> [--name <n>] [--color <c>] [--dry-run]                          v0.2
                                          # Per-attribute fan-out across a single
                                          # wire surface: `update_group(board_id,
                                          # group_id, group_attribute:
                                          # GroupAttributes!, new_value: String!)`
                                          # per SDK 14.0.0
                                          # `MutationUpdate_GroupArgs`. Returns
                                          # `Maybe<Group>`. Both `group_attribute`
                                          # and `new_value` are required at the
                                          # wire (unlike column-update's
                                          # `change_column_metadata` whose
                                          # arguments are both optional). The
                                          # `GroupAttributes` enum (SDK 14.0.0)
                                          # carries five values: `title` /
                                          # `color` / `position` (deprecated —
                                          # Monday flagged for removal in
                                          # favour of the relative-position
                                          # pair) / `relative_position_after` /
                                          # `relative_position_before`. CLI
                                          # flag mapping: `--name` →
                                          # `group_attribute: title`, `--color`
                                          # → `group_attribute: color`. M17
                                          # deliberately OMITS the position-
                                          # related flags (the `--position
                                          # top|bottom` projection from the
                                          # pre-pre-flight v0.2-plan was wire-
                                          # ambiguous — Monday's `position`
                                          # attribute is per-changelog
                                          # deprecated and the literal
                                          # `top|bottom` semantics through
                                          # `update_group` are unreliable);
                                          # repositioning is deferred to v0.3
                                          # where the CLI may surface
                                          # `--before <gid>` / `--after <gid>`
                                          # flags mapping to the non-
                                          # deprecated `relative_position_
                                          # after` / `relative_position_before`
                                          # GroupAttributes values. Multi-flag
                                          # invocations (`--name X --color Y`)
                                          # fan out N sequential wire calls,
                                          # sequential per §8 decision 8
                                          # (parallel waits for v0.4
                                          # `--concurrency`). At least one of
                                          # --name / --color required — zero-
                                          # flag invocation → `usage_error` at
                                          # argv-parse.
                                          # **Whole-call shape** mirrors
                                          # `column-update`'s contract: single
                                          # envelope on success (`data` = the
                                          # group projection from the last
                                          # successful per-attribute call's wire
                                          # response — Monday's `update_group`
                                          # returns `Maybe<Group>` post-mutation,
                                          # so the trailing call's response is
                                          # authoritative for every field and no
                                          # separate force-live read leg fires);
                                          # whole-call error envelope on any
                                          # per-attribute failure. **Server-side
                                          # state is NOT transactional** — per-
                                          # attribute calls earlier in the
                                          # sequence may have already committed
                                          # when a later call fails. Shares
                                          # `column-update`'s partial-application
                                          # caveat (no transaction across
                                          # `update_group` calls); diverges
                                          # from `board update`'s force-live
                                          # final read (board-update's per-
                                          # attribute calls return the changed
                                          # slice only, requiring a final
                                          # whole-board read; group-update's
                                          # per-attribute calls return a full
                                          # `Group` projection so the trailing
                                          # response is authoritative).
                                          # Idempotent: yes — re-applying the
                                          # same field values is a no-op on
                                          # Monday's side (same input leaves
                                          # same group metadata; per §9.1
                                          # idempotency table). Dry-run shape
                                          # per §6.4 group-update variant:
                                          # field-level `from → to` diff per
                                          # provided flag. The `from` state
                                          # requires a preflight `board
                                          # describe`-shaped read to locate the
                                          # group by ID inside
                                          # `boardMetadataSchema.groups: [...]`;
                                          # that read can hit the v0.1 board-
                                          # metadata cache — `meta.source:
                                          # "live"` or `"cache"`. Calls
                                          # `invalidateBoard(boardId)` post-
                                          # success per §8 eager-invalidation
                                          # contract. On partial-application
                                          # failure (call N+1 fails after call
                                          # N succeeded), invalidation tracks
                                          # the wire-state high-water mark —
                                          # the cache is invalidated as far as
                                          # the successful legs reached, never
                                          # further (§8 fan-out call-site
                                          # contract). Fan-out per §8; M17
                                          # adopts M16's R46
                                          # `withBoardInvalidationFanOut`
                                          # post-success projection wrapper
                                          # (high-water-mark counter via
                                          # `BoardFanOutTracker.recordLeg
                                          # Success()` callback) from day one.
                                          # Note the success-path `data`
                                          # projection sources from the wire
                                          # response directly (no force-live
                                          # read leg), distinguishing group-
                                          # update from board-update — this is
                                          # the load-bearing M17-pre-flight
                                          # finding (Monday's `update_group`
                                          # returns the full Group projection,
                                          # whereas `update_board` returns
                                          # only the slice that changed).
monday board group-archive <bid> <gid> --yes [--dry-run]                     v0.2
                                          # `archive_group(board_id, group_id)`
                                          # per SDK 14.0.0
                                          # `MutationArchive_GroupArgs`. Returns
                                          # `Maybe<Group>` (the group's last-
                                          # look projection before archive —
                                          # Monday convention). Destructive —
                                          # --yes mandatory for live archive
                                          # (without --yes AND without --dry-run
                                          # → `confirmation_required`, exit 1)
                                          # per §3.1 #7 + §8 decision 9
                                          # (archive is consistently --yes-gated
                                          # across nouns: item / board / M17
                                          # group); the confirmation gate fires
                                          # BEFORE `resolveClient()` so a
                                          # missing-token call still surfaces
                                          # `confirmation_required` (the M10
                                          # round-1 P2 ordering invariant;
                                          # R29's `assertConfirmation` helper
                                          # preserves it via already-parsed
                                          # `globalFlags`). The
                                          # `confirmation_required` envelope
                                          # carries the single-target
                                          # destructive-gate `details` shape
                                          # per §6.5: `{board_id, group_id,
                                          # hint}` (the group-archive wire
                                          # signature is two-tuple, so both
                                          # IDs echo via R29's `extraDetails`
                                          # slot — group-archive is the 9th
                                          # destructive-gate helper consumer
                                          # overall AND the 2nd two-tuple
                                          # `extraDetails` consumer after M16
                                          # column-delete's 1st). `--dry-run`
                                          # bypasses
                                          # the confirmation gate entirely
                                          # (mirrors `item archive` / `item
                                          # delete` / `board archive` / `board
                                          # delete` / M16 column-delete
                                          # precedent — dry-run is non-
                                          # executing); `group-archive <bid>
                                          # <gid> --dry-run` without --yes
                                          # emits the dry-run envelope. Re-
                                          # archiving an already-archived group
                                          # is a no-op on Monday's side; CLI
                                          # marks `idempotent: true` (per §9.1
                                          # idempotency table — same row that
                                          # covers `archive_item` / `archive_
                                          # board`). Calls
                                          # `invalidateBoard(boardId)` post-
                                          # success per §8 eager-invalidation
                                          # contract — the cached `groups[*]
                                          # .archived` field flips false →
                                          # true; without invalidation a same-
                                          # process `board describe` /
                                          # `monday board groups <bid>` would
                                          # surface stale archived state until
                                          # TTL eviction. Single-leg per §8
                                          # call-site contract; adopts M16's
                                          # R46 `withBoardInvalidationSingleLeg`
                                          # post-success projection wrapper
                                          # from day one. Dry-run shape per
                                          # §6.4 group-archive variant: a
                                          # source snapshot of the target
                                          # group from a preflight
                                          # `loadBoardMetadata` read (cache-
                                          # allowed; `meta.source: "live"` |
                                          # `"cache"`) plus the operation
                                          # marker — mirrors `board archive`'s
                                          # snapshot-bearing shape because the
                                          # cached `boardMetadataSchema.groups
                                          # [*]` projection covers the full
                                          # Group metadata field set (`{id,
                                          # title, color, position, archived,
                                          # deleted}`); diverges from
                                          # `board delete` / `column-delete` /
                                          # `group-delete` which are
                                          # destructive-no-read. Dry-run
                                          # cache-staleness caveat: when
                                          # preview freshness is critical
                                          # (e.g. archiving after a recent
                                          # rename), pass `--no-cache` to
                                          # force a live preflight read.
monday board group-duplicate <bid> <gid> [--name <n>] [--dry-run]            v0.2
                                          # `duplicate_group(board_id, group_id,
                                          # add_to_top?, group_title?)` per SDK
                                          # 14.0.0 `MutationDuplicate_GroupArgs`.
                                          # Returns `Maybe<Group>`. The wire
                                          # mutation also accepts an optional
                                          # `add_to_top: Boolean` (placement);
                                          # M17 deliberately OMITS it — agents
                                          # needing placement control call the
                                          # wire mutation via M9's `dev mutate`
                                          # escape hatch (mirrors M16 column-
                                          # create's omission of `after_
                                          # column_id`). **NOTE — load-bearing
                                          # divergence from sibling duplicate
                                          # verbs**: `monday item duplicate`
                                          # and `monday board duplicate` both
                                          # surface `--with-updates` (mapping
                                          # to wire `with_updates: Boolean` on
                                          # `duplicate_item` / `duplicate_
                                          # board`); `monday board group-
                                          # duplicate` does NOT, because
                                          # Monday's `duplicate_group` wire
                                          # signature has no equivalent
                                          # argument. The v0.2-plan §3 M17
                                          # entry's pre-pre-flight draft
                                          # listed `[--with-updates]`; the
                                          # M17 pre-flight pinned the wire
                                          # truth and dropped the flag from
                                          # both surfaces (cli-design §4.3 +
                                          # v0.2-plan §3). `--name <n>` maps
                                          # to wire `group_title`; when
                                          # omitted, Monday's wire-side
                                          # default naming applies (typically
                                          # "<source name> (copy)" — the
                                          # exact convention is server-side,
                                          # not pinned by the CLI). Empty
                                          # `--name` after trim → `usage_
                                          # error` at argv-parse. Idempotent:
                                          # NO — every call creates a new
                                          # group with a fresh ID (mirrors
                                          # `item duplicate` / `board
                                          # duplicate`). NOT destructive (no
                                          # --yes gate). Calls
                                          # `invalidateBoard(boardId)` post-
                                          # success per §8 eager-invalidation
                                          # contract — the cached `groups:
                                          # [...]` list grew by one entry.
                                          # Single-leg per §8 call-site
                                          # contract; adopts R46's
                                          # `withBoardInvalidationSingleLeg`
                                          # from day one. Dry-run shape per
                                          # §6.4 group-duplicate variant:
                                          # minimal `{operation:
                                          # "duplicate_group", board_id,
                                          # group_id, name?}`. No preflight
                                          # read leg fires (Monday's
                                          # `duplicate_group(board_id,
                                          # group_id)` reports `not_found`
                                          # if the IDs are bogus and the
                                          # dry-run is purely argv-derived —
                                          # mirrors `column-delete`'s no-
                                          # read pattern, even though
                                          # group-duplicate is non-
                                          # destructive). `meta.source:
                                          # "none"` (no API call fires).
monday board group-delete <bid> <gid> --yes [--dry-run]                      v0.2
                                          # `delete_group(board_id, group_id)`
                                          # per SDK 14.0.0
                                          # `MutationDelete_GroupArgs`. Returns
                                          # `Maybe<Group>` (the group's last-
                                          # look projection before deletion —
                                          # Monday convention; mirrors
                                          # `delete_column` / `delete_board` /
                                          # `delete_item`). Destructive — --yes
                                          # mandatory for live deletion
                                          # (without --yes AND without --dry-
                                          # run → `confirmation_required`,
                                          # exit 1) per §3.1 #7 + §8 decision
                                          # 9; the confirmation gate fires
                                          # BEFORE `resolveClient()` (the M10
                                          # round-1 P2 ordering invariant; R29
                                          # `assertConfirmation` helper). The
                                          # `confirmation_required` envelope
                                          # carries the single-target
                                          # destructive-gate `details` shape
                                          # per §6.5: `{board_id, group_id,
                                          # hint}` (group-delete's wire
                                          # signature is two-tuple; both IDs
                                          # echo via R29's `extraDetails`
                                          # slot — group-delete is the 10th
                                          # destructive-gate helper consumer
                                          # overall AND the 3rd two-tuple
                                          # `extraDetails` consumer after
                                          # column-delete + group-archive).
                                          # `--dry-run` bypasses the
                                          # confirmation gate entirely
                                          # (mirrors `item archive` / `item
                                          # delete` / `board archive` /
                                          # `board delete` / M16 column-
                                          # delete / M17 group-archive
                                          # precedent). Re-deleting an
                                          # already-deleted group surfaces
                                          # `not_found` past the mutation;
                                          # the CLI marks `idempotent:
                                          # false` (mirrors `item delete` /
                                          # `update delete` / `workspace
                                          # delete` / `board delete` /
                                          # `column-delete` rationale —
                                          # wire-level converges, CLI-level
                                          # surfaces a different envelope).
                                          # Calls `invalidateBoard(boardId)`
                                          # post-success per §8 eager-
                                          # invalidation contract — the
                                          # group entry must drop from the
                                          # cached `groups: [...]` list;
                                          # without invalidation a same-
                                          # process `board describe` /
                                          # `monday board groups <bid>`
                                          # would surface a phantom group
                                          # until TTL eviction. Single-leg
                                          # per §8 call-site contract;
                                          # adopts R46's
                                          # `withBoardInvalidationSingleLeg`
                                          # from day one. Dry-run shape per
                                          # §6.4 group-delete variant:
                                          # minimal `{operation:
                                          # "delete_group", board_id,
                                          # group_id}`. No preflight read
                                          # leg fires; the dry-run is
                                          # purely argv-derived (Monday's
                                          # `delete_group(board_id,
                                          # group_id)` reports `not_found`
                                          # if the IDs are bogus).
                                          # `meta.source: "none"`. Mirrors
                                          # the destructive-no-read pattern
                                          # uniform across `item delete`,
                                          # `update delete`, `workspace
                                          # delete`, `board delete`, M16
                                          # `column-delete`. Note the
                                          # deliberate divergence from
                                          # `group-archive`'s snapshot-
                                          # bearing dry-run shape: archive
                                          # carries the source snapshot
                                          # (item-archive / board-archive
                                          # precedent — recoverable
                                          # destructive; preview shows what
                                          # will be hidden), delete is
                                          # minimal (workspace-delete /
                                          # board-delete / column-delete
                                          # precedent — irrecoverable
                                          # destructive past Monday's
                                          # retention window; the agent
                                          # already knows what they're
                                          # deleting via the positional).

# === ITEM ===
# All item commands take EITHER a positional <iid> OR can resolve the board
# via --board <bid>. Some operations (item set/update with --set) require
# board context — when not derivable from <iid>, --board is required.
# See §5.3 for board_id resolution and §5.5 for --where filter rules.
monday item list --board <bid> [--group <gid>] [--where <expr>]... [--filter-json <json>] [--state active|archived|all] [--all] [--limit <N>]   v0.1
monday item get <iid>                     # single item with column values   v0.1
monday item find <name> --board <bid> [--first]                              v0.1
monday item search [--board <bid>] [--workspace <wid>] [--favorites] [--max-boards <n>] --where <col>=<val>...   v0.1 (--board, --where); v0.3 (cross-board)
                                          # single-board (v0.1, --board <bid>):
                                          # uses items_page_by_column_values.
                                          # cross-board (v0.3, omit --board):
                                          # uses boards(ids:[...]) { items_page
                                          # (query_params: { rules }) }; fan-out
                                          # walker maintains per-board cursors.
                                          # `--workspace <wid>` narrows the
                                          # board set to one workspace before
                                          # fan-out; `--favorites` uses the
                                          # current user's `board favorites`
                                          # list as the cross-board set.
                                          # `--max-boards <n>` caps fan-out
                                          # cardinality (default 25, hard cap
                                          # 100 — Decision 5; above-cap surfaces
                                          # `usage_error`). At most ONE of
                                          # `--board` / `--workspace` /
                                          # `--favorites` may be supplied.
                                          # Per-board columns resolve
                                          # independently — boards lacking the
                                          # requested column emit a
                                          # `column_not_found_on_board` warning
                                          # and are skipped (not fatal).
                                          # Inaccessible board IDs emit an
                                          # `inaccessible_boards` warning.
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
monday item update --board <bid> (--where <c>=<v>... | --filter-json <json>) [--name <n>] [--set <col>=<val>]... [--set-raw <col>=<json>]... [--create-labels-if-missing] [--continue-on-error [--concurrency <n>]] [--yes] [--dry-run]   v0.1 (--set-raw v0.2; --continue-on-error v0.3-M25; --concurrency v0.4-M30)
                                          # bulk update — at least one of --name / --set / --set-raw required
                                          # live (non-empty match): requires --yes unless --dry-run is set
                                          # --dry-run takes precedence over --yes when both are passed
                                          # --continue-on-error (v0.3-M25): opt-in to the per-item
                                          # partial-success envelope per §6.4 "Bulk per-item partial-
                                          # success". Default (flag absent) keeps the v0.2 fail-fast
                                          # behaviour — first per-item error aborts the loop with
                                          # `details.applied_to` decoration per §6.5. With the flag,
                                          # every matched item is attempted regardless and the success
                                          # envelope carries `data.results[]` with per-item
                                          # `{item_id, ok, error?}` records. Always emits `ok: true`
                                          # at the top level (universal partial-success rule); the
                                          # agent reads `data.results[]` for per-item outcomes.
                                          # --concurrency <n> (v0.4-M30): opt-in to bounded parallel
                                          # per-item dispatch under --continue-on-error. Range 1..32;
                                          # default 1 (sequential, identical to the M25 path). Requires
                                          # --continue-on-error (rejected with `usage_error` otherwise —
                                          # fail-fast bulk has no defined "abort N in-flight" semantic;
                                          # v0.4-plan M30 D2). Envelope shape is byte-equivalent to
                                          # M25 — same `data.results[]` per-item records, same
                                          # `data.summary.{matched,applied,failed}_count` invariant.
                                          # Monday's `concurrency_exceeded` retries via the existing
                                          # retry layer (§2.5) — no new error code surfaces.
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
                                          # value-overrides is deferred to v0.5 (was
                                          # originally v0.3-targeted at M11 close; slipped
                                          # to v0.4 at v0.3-M28 audit, then to v0.5 at v0.4
                                          # release-prep — no v0.3 or v0.4 milestone picked
                                          # up the extension. Monday's `ColumnMappingInput`
                                          # carries no value slot; supporting it requires a
                                          # non-atomic post-move `change_multiple_column_
                                          # values` with cross-leg partial-failure envelope
                                          # shapes that have no precedent at v0.4 close).
                                          # Agents needing overrides fire `monday item set
                                          # <iid> <target>=<value>` post-move.
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
monday item archive <iid> --yes [--dry-run]                                  v0.2
                                          # --yes mandatory for live archive
                                          # (destructive — Monday's 30-day
                                          # recovery window is the only way
                                          # back; no `unarchive` mutation
                                          # exists, see §5.4). Live without
                                          # --yes AND without --dry-run →
                                          # confirmation_required (exit 1)
                                          # per §3.1 #7. --dry-run bypasses
                                          # the gate (non-executing) and
                                          # previews the would-archive
                                          # item without --yes.
                                          # Idempotent: re-archiving an
                                          # already-archived item is a no-op
                                          # on Monday's side (§9.1 table).
monday item delete <iid> --yes [--dry-run]                                   v0.2
                                          # --yes mandatory for live delete.
                                          # Live without --yes AND without
                                          # --dry-run → confirmation_required
                                          # (exit 1) per §3.1 #7. --dry-run
                                          # bypasses the gate (non-executing)
                                          # and previews the would-delete
                                          # item without --yes.
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
monday item watch <iid> [--interval <ms>] [--since <event-id>] [--once] [--max-events <n>] [--max-duration <seconds>] [--include <kind1>,<kind2>]   v0.4
                                          # polls Monday's
                                          # `boards(ids:){activity_logs(item_ids:,
                                          # from:, limit:)}` surface on each tick,
                                          # projects through M24's
                                          # `item-history-projection.ts` projector,
                                          # emits one NDJSON event record per new
                                          # `activity_logs` entry plus a session-
                                          # summary trailer on exit. `--interval`
                                          # default 30000ms (30s) per §14.4 closure;
                                          # range 1000ms–3600000ms (faster than 1s
                                          # would generate Monday request-rate
                                          # concerns; slower than 1h crosses the
                                          # "no longer a watch" boundary — use
                                          # `cron + item history` for hourly+
                                          # cadences). `--since <event-id>` resumes
                                          # from the last-seen-event-id reported in
                                          # a prior session's trailer-meta (NOT a
                                          # full state-machine resume; just an
                                          # event-id filter against the M24
                                          # projector). `--once` emits the current
                                          # backlog from `--since` (or the most-
                                          # recent 100 events per §14.4's
                                          # DEFAULT_ONCE_BACKLOG_LIMIT if no
                                          # `--since`) and
                                          # exits without polling — distinct from
                                          # `--max-events 1` which waits for the
                                          # NEXT event. `--max-events <n>` /
                                          # `--max-duration <seconds>` cap the
                                          # session length; exit-0 with the
                                          # session-summary trailer when either
                                          # limit fires (NOT a failure envelope).
                                          # `--include <kind1>,<kind2>` filters by
                                          # the M24 event-kind enum (closed at 9
                                          # kinds: update_column_value /
                                          # create_column / create_group /
                                          # update_board_name /
                                          # update_board_nickname /
                                          # board_workspace_id_changed /
                                          # update_posted / update_replied /
                                          # unknown — see `item history` row);
                                          # applied at projection time, not poll
                                          # time (Monday doesn't expose a server-
                                          # side filter). Circuit-breaker per §14.4
                                          # closure: reactive on Monday's wire
                                          # errors (complexity_exceeded /
                                          # concurrency_exceeded / rate_limited);
                                          # trip after 5 consecutive failed polls
                                          # → failure envelope carrying
                                          # `circuit_broken_at` + `failed_polls`
                                          # in trailer-meta. SIGINT graceful drain:
                                          # in-flight poll completes or aborts
                                          # cleanly, trailer-meta emits as a final
                                          # NDJSON line, exit 130 per §7.
                                          # Trailer-meta carries seven M29-specific
                                          # slots on top of the §6.3 standard
                                          # streaming trailer: `events_emitted` +
                                          # `polls_made` + `watch_duration_seconds`
                                          # + `last_seen_event_id` (for restart) +
                                          # `failed_polls` + `circuit_broken_at`
                                          # (null on clean exits; ISO timestamp on
                                          # circuit-break) + `exit_reason` (the
                                          # discriminator: max_events | max_duration
                                          # | once_complete | signal | circuit_broken
                                          # — agents key off this slot rather than
                                          # interpreting `circuit_broken_at` alone).
                                          # Per-failure warnings collect under
                                          # `_meta.warnings` (NOT interleaved with
                                          # event lines per §6.3); see §14.4 closure
                                          # for the circuit-breaker progression.
monday item history <iid> [--since <iso>] [--until <iso>] [--activity-logs-page <n>] [--updates-page <n>] [--limit <n>] [--kinds <list>] [--stream]   v0.3
                                          # activity log: status / column / group /
                                          # board edits + comment thread, merged
                                          # chronologically by created_at ascending
                                          # (ties broken by id lexicographic). Two-
                                          # source GraphQL merge:
                                          # `boards.activity_logs(item_ids:, from:,
                                          # to:, page:, limit:)` for board-stored
                                          # events + `items.updates(page:, limit:)
                                          # { replies { ... } }` for comment thread.
                                          # Walker filters `entity = 'pulse'` to
                                          # drop board-scoped events (the `item_ids`
                                          # filter alone is INSUFFICIENT — empirical
                                          # probe finding 2026-05-11). Discriminated-
                                          # union event-objects per Decision 2
                                          # closure (`a1f3025`): variants
                                          # `update_column_value` (dominant item-
                                          # scoped), `update_posted` /
                                          # `update_replied` (synthesized from
                                          # Update + Reply sources), board-scoped
                                          # variants (filtered out at walker, kept
                                          # as defensive parser-roundtrip targets),
                                          # `unknown` fallback (before: null +
                                          # after: <raw parsed data> + raw wire
                                          # `event` + `entity` slots so agents
                                          # route on the unrecognised kind).
                                          # Unknown wire events surface a
                                          # `unknown_event_kind`
                                          # warning (§6.1 warnings[]; NOT a new
                                          # error.code — registry stays at 29).
                                          # **Eventual-consistency caveat**:
                                          # Monday's `activity_logs` has an
                                          # empirically-measured propagation lag
                                          # >30s on freshly-edited boards; agents
                                          # polling history after a write should
                                          # wait at least 30s before expecting the
                                          # new event to surface. `--stream` emits
                                          # NDJSON via `startNdjsonStream` (R52);
                                          # merge is non-incremental (full slice
                                          # must be resident to order), trailer
                                          # meta carries per-source `last_page`
                                          # for resumption.

# Time tracking — verb-shaped column-type extension (§5.2 carve-out 2)
# DOCUMENTATION-ONLY at v0.3-M20: an empirical probe (2026-05-10,
# API version 2026-01) confirmed Monday's public GraphQL API does
# not currently support writing to time_tracking columns —
# `change_simple_column_value` rejects with CorrectedValueException
# ("DurationColumn does not support simple column value writes"),
# `change_column_value` rejects with InvalidColumnTypeException
# ("This column type is not supported yet in the API"), and the
# mutation root has no time-tracking-related mutation. The verbs
# below are registered for forward-compatibility so agent scripts
# targeting `monday item time-track start/stop` are stable across
# the eventual swap; today they reject every invocation with a
# `usage_error` carrying the empirical-probe hint pointing at
# Monday's UI as the only write path. The argv shapes pin the
# future behaviour — when Monday ships API support, the CLI swap
# is one-sided in `src/api/time-tracking.ts`.
monday item time-track start <iid> [--column <col>] [--board <bid>] [--dry-run]   v0.3
                                          # FUTURE behaviour: flips the time_tracking
                                          # column on the named item from stopped →
                                          # running, opening a new history session
                                          # whose `started_at` is Monday's wall-clock.
                                          # --column <col> selects the time_tracking
                                          # column when an item carries more than one;
                                          # omitted when the item has exactly one
                                          # (resolved via board metadata). --board
                                          # <bid> follows the standard §5.3 step-1
                                          # contract — explicit is authoritative,
                                          # implicit looks up the item's board and
                                          # caches for the process. Future error
                                          # surface: `usage_error` (exit 1) when the
                                          # column is already running per Decision 4.1
                                          # (`details.running: true` discriminates;
                                          # hint points at `monday item time-track
                                          # stop`). Idempotent: NO — each successful
                                          # call against a stopped column appends a
                                          # new history session. NOT destructive
                                          # (no --yes gate).
                                          # CURRENT behaviour (v0.3): every invocation
                                          # rejects with `usage_error` carrying the
                                          # empirical-probe hint; the --board lookup
                                          # still fires (so invalid item IDs surface
                                          # as `not_found` for agent UX consistency
                                          # across item verbs); --column resolution
                                          # is intentionally skipped (the api
                                          # primitive throws regardless).
monday item time-track stop <iid> [--column <col>] [--board <bid>] [--dry-run]    v0.3
                                          # FUTURE behaviour: flips the time_tracking
                                          # column from running → stopped, closing
                                          # the open history session with `ended_at`
                                          # = Monday's wall-clock + `duration_seconds`
                                          # for the just-stopped session
                                          # (`duration_seconds: null` when Monday
                                          # omits `started_at` per
                                          # `TimeTrackingHistoryItem.started_at:
                                          # Maybe<Date>` — per-session duration is
                                          # uncomputable without a start). Same
                                          # --column / --board semantics as `start`.
                                          # Future error surface: `usage_error`
                                          # (exit 1) when the column is not running
                                          # per Decision 4.2 (`details.running:
                                          # false` discriminates; hint points at
                                          # `monday item time-track start`).
                                          # Idempotent: NO per Decision 4.3 — agents
                                          # needing best-effort stop swallow the
                                          # typed envelope.
                                          # CURRENT behaviour (v0.3): mirrors
                                          # `start` — rejects with `usage_error`
                                          # carrying the same `API_UNSUPPORTED_HINT`
                                          # (single source-of-truth in
                                          # `src/api/time-tracking.ts`).

# Subitems
monday item subitems <iid>                # list children                    v0.1
                                          # subitem creation = item create --parent <iid> (v0.2)

# Asset upload — first v0.4 verb crossing the wire via multipart/form-data
# rather than the JSON-only `client.request` seam. See §6.4 asset-upload
# sub-section + `docs/architecture.md` "Wire-vs-CLI semantics" for the
# transport-asymmetry context (R-NEW-41 3rd consumer fired at M31).
monday item upload <iid> --column <col> <file>                                v0.4
                                          # attaches a local file to a
                                          # `file`-typed column on an item
                                          # via Monday's `add_file_to_column`
                                          # multipart mutation. `<file>` is
                                          # a local file path resolved
                                          # relative to cwd; stdin (`-`) is
                                          # NOT supported in v0.4-M31 (a
                                          # future contract extension may
                                          # add stdin support once a
                                          # `--filename <name>` companion
                                          # flag is pinned). Column must
                                          # resolve to `type === 'file'` at
                                          # runtime — non-`file` columns
                                          # surface `unsupported_column_type`
                                          # per §5.3 writer-expansion
                                          # roadmap, hint points at this
                                          # verb. Local file failures
                                          # route through `usage_error`
                                          # with `details.reason` ∈
                                          # {`file_not_readable` (ENOENT
                                          # / EACCES / directory),
                                          # `file_empty` (zero bytes),
                                          # `file_too_large` (server-side
                                          # rejection rewrap; carries
                                          # `details.file_size_bytes`)};
                                          # no CLI-side hardcoded
                                          # file-size pre-check —
                                          # Monday's per-file cap is
                                          # plan-tier-dependent and not
                                          # exposed via the schema
                                          # (empirical probe
                                          # `scripts/probe/m31-asset-
                                          # upload.ts` 2026-05-13). See
                                          # §6.4 asset-upload sub-section
                                          # for the full constraint list.
                                          # Idempotent: NO — each successful
                                          # upload mints a new `Asset` with
                                          # a new ID. Agents needing
                                          # register-once dedupe on a
                                          # `Item.assets` pre-read
                                          # (read-side `monday item assets`
                                          # verb deferred to v0.4.x per
                                          # M31 Decision D6 closure).
                                          # Cache invalidation: successful
                                          # upload invalidates the parent
                                          # item's board metadata cache
                                          # (single-leg per §8). Dry-run
                                          # shape per §6.4 asset-upload
                                          # variant; `meta.source: "none"`.

# === UPDATE (comments) ===
monday update list <iid> [--with-replies]                                    v0.1 (--with-replies: v0.2)
                                          # **Default-shape change in v0.2** (M13):
                                          # without --with-replies, every update's
                                          # `replies: []` is empty in the projection.
                                          # v0.1 silently populated replies on every
                                          # call; v0.2 makes the second leg opt-in
                                          # because Monday charges complexity for the
                                          # nested selection. Tagged as the only
                                          # output-shape breaking change in v0.2 →
                                          # CHANGELOG breaking-changes block + §13
                                          # release upgrade notes. Agents that want
                                          # the v0.1 behaviour pass --with-replies.
monday update list --board <bid> [--with-replies]                            v0.2
                                          # board-wide updates; mutually exclusive
                                          # with positional <iid>. Same --with-
                                          # replies opt-in semantics.
monday update get <uid>                                                      v0.1
monday update create <iid> --body <md> | --body-file <path> [--dry-run]      v0.1
                                          # markdown rendered to HTML;
                                          # in v0.1 because workflow shortcuts depend on it
monday update reply <uid> --body <md> | --body-file <path> [--dry-run]       v0.2
                                          # `create_update(parent_id: <uid>)`. Reuses
                                          # `update create`'s body-source plumbing
                                          # (--body / --body-file / `--body-file -`
                                          # for stdin) verbatim. Idempotent: NO
                                          # (each call posts a fresh reply; Monday
                                          # has no idempotency-key surface on
                                          # create_update). Dry-run shape per §6.4
                                          # comment-create variant: operation:
                                          # "create_update", parent_id, body,
                                          # body_length.
monday update edit <uid> --body <md> | --body-file <path> [--dry-run]        v0.2
                                          # `edit_update`. Idempotent: yes (re-
                                          # editing with the same body is a no-op
                                          # on Monday's side).
monday update delete <uid> --yes [--dry-run]                                 v0.2
                                          # `delete_update`. Destructive: --yes
                                          # mandatory for live deletion. Live
                                          # without --yes AND without --dry-run
                                          # → confirmation_required (exit 1)
                                          # per §3.1 #7; --dry-run bypasses
                                          # the gate. Re-
                                          # deleting an already-deleted update
                                          # surfaces `not_found` so the CLI marks
                                          # `idempotent: false` (mirrors `item
                                          # delete`'s rationale).
monday update like <uid> [--dry-run]                                         v0.2
                                          # `like_update`. Idempotent (Monday's
                                          # like is a toggle keyed off the caller;
                                          # re-running is a no-op).
monday update unlike <uid> [--dry-run]                                       v0.2
                                          # `unlike_update`. Idempotent.
monday update pin <uid> [--dry-run]                                          v0.2
                                          # `pin_to_top`. Idempotent.
monday update unpin <uid> [--dry-run]                                        v0.2
                                          # `unpin_from_top`. Idempotent.
monday update clear-all <iid> --yes [--limit-pages <n>] [--dry-run]          v0.2
                                          # delete all updates on item.
                                          # Destructive: --yes mandatory for
                                          # live deletion. Live without --yes
                                          # AND without --dry-run →
                                          # confirmation_required (exit 1)
                                          # per §3.1 #7; --dry-run bypasses
                                          # the gate. Page-walks
                                          # `updates(item_id)` via walkPages to
                                          # collect IDs, then sequential
                                          # `delete_update` per ID. **Partial-
                                          # success envelope** per §6.4 — emits
                                          # `ok: true` (one success envelope) with
                                          # per-update results in `data.results:
                                          # [{update_id, ok, error?}]`. The
                                          # envelope is `ok: true` even when every
                                          # per-update delete fails (whole-call
                                          # success means dispatch ran). Top-level
                                          # `error` reserved for whole-call failure
                                          # (couldn't reach API, item lookup
                                          # failed, etc.). Sequential per §8
                                          # decision 8 — parallel waits for v0.4
                                          # `--concurrency`. `--limit-pages <n>`
                                          # extends the page-walk cap (1-500,
                                          # default 50, 100 updates per page); on
                                          # threads bigger than `n × 100` updates
                                          # the page-walker truncates and the CLI
                                          # surfaces `pagination_cap_reached` in
                                          # `warnings`. The live + dry-run envelopes
                                          # then cover the collected prefix only —
                                          # agents re-run after the prefix clears
                                          # (per-call idempotency holds).

# Asset upload — Update-scoped sibling of `item upload`. Same multipart
# transport seam; no column-id (Updates carry attachments via
# `Update.assets` directly).
monday update upload <uid> <file>                                            v0.4
                                          # attaches a local file to an
                                          # Update (comment) via Monday's
                                          # `add_file_to_update` multipart
                                          # mutation. `<file>` same shape
                                          # as `item upload` — local path
                                          # only, no stdin at v0.4-M31. No
                                          # column-type validation
                                          # (Updates accept any file type
                                          # Monday supports). Server-side
                                          # validation handles size cap +
                                          # filename + virus scan. Local
                                          # file failures route through
                                          # `usage_error` with
                                          # `details.reason` ∈
                                          # {`file_not_readable`,
                                          # `file_empty`, `file_too_large`}
                                          # (server-side size rejection
                                          # rewrap). Idempotent: NO —
                                          # re-running mints a new Asset.
                                          # No cache invalidation
                                          # (Updates aren't part of the
                                          # §8 cache scope). Dry-run
                                          # shape per §6.4 asset-upload
                                          # variant; `meta.source:
                                          # "none"`.

# === USER ===
monday user list [--name <n>] [--email <e>] [--kind all|guests|non_guests]   v0.1
monday user get <uid>                                                        v0.1
monday user me                            # alias for `account whoami`       v0.1

# Teams (nested under user). v0.5-M34 pre-flight stubs at this
# commit; runtime bodies land at M34 IMPL. Empirical probe
# `scripts/probe/v0.5-team-mutations.ts` (2026-05-15, API
# `2026-01`) pinned the wire shape: `Team` is 6 fields (id,
# name, picture_url, is_guest, users, owners; NO `description`
# field — D1 drops the --description flag the v0.4 row
# speculatively pencilled), `create_team(input:
# CreateTeamAttributesInput!, options: CreateTeamOptionsInput)
# → Team`, `delete_team(team_id) → Team`,
# `add_users_to_team(team_id, user_ids: [ID!]!) →
# ChangeTeamMembershipsResult {failed_users, successful_users}`
# (per-user partial-success wire envelope; CLI wraps into §6.1
# `data.results: [{user_id, ok, ...}]` per D5),
# `remove_users_from_team(...)` same shape.
# **No `update_team` mutation exists** on Monday's wire at API
# `2026-01` — D2 drops a `team-update` verb from v0.5 scope; no
# rename / re-describe surface. `Query.teams` exposes neither
# pagination (no `limit:` / `page:` / cursor — D6) nor a search
# slot; account-size natural cap is the only limit.
# Six tangential team-shaped mutations beyond the 4 core
# (`assign_team_owners` / `remove_team_owners` /
# `add_teams_to_board` / `delete_teams_from_board` /
# `add_teams_to_workspace` / `delete_teams_from_workspace`)
# defer per D4 to a v0.5.x candidate-selection round.
# Hierarchical-team `--parent <ptid>` flag deferred per D3
# (wire slot exists via `CreateTeamAttributesInput.parent_
# team_id` but agent-UX semantics unclear today).
# `--users <id,...>` is **numeric user IDs only** for the team
# verbs (numeric brand via `UserIdSchema`); email tokens are
# NOT resolved through `userByEmail` here (Monday's team
# mutations take wire IDs directly, and the fan-out resolver
# path lifts into the multi-target dispatch helper at IMPL).
# Distinct from `workspace add-users` / `workspace remove-
# users` / `board add-users` which accept mixed numeric-or-
# email tokens via `parseUsersArg`.
monday user team-list                                                        v0.5
                                          # `Query.teams { id name picture_url
                                          # is_guest users { id name email }
                                          # owners { id name email } }`. No
                                          # pagination at the wire — every
                                          # visible team in one shot.
                                          # `operationName: 'ListTeams'`
                                          # pinned literally. Idempotent: yes.
                                          # `meta.source: 'live'`; no cache.
monday user team-get <tid>                                                   v0.5
                                          # `Query.teams(ids: [<tid>])`;
                                          # empty array → `not_found` with
                                          # `details.team_id` (Monday wire
                                          # collapses doesn't-exist + not-
                                          # accessible). `operationName:
                                          # 'GetTeam'` pinned. Idempotent: yes.
monday user team-create --name <n> [--users <id>,...] [--guest-team] [--allow-empty] [--dry-run]   v0.5
                                          # `create_team(input:
                                          # CreateTeamAttributesInput!,
                                          # options: CreateTeamOptionsInput)
                                          # → Team`. `--name <n>` required
                                          # (wire `name: String!`). `--users`
                                          # optional, comma-separated numeric
                                          # IDs (wire `subscriber_ids: [ID!]`
                                          # — "must not be empty unless
                                          # allow_empty_team is set").
                                          # `--guest-team` maps to wire
                                          # `is_guest_team: true`;
                                          # `--allow-empty` maps to wire
                                          # `options.allow_empty_team: true`.
                                          # `operationName: 'CreateTeam'`
                                          # pinned. Idempotent: NO —
                                          # Monday allows duplicate names.
                                          # Dry-run per §6.4 mutation-
                                          # dry-run variant: minimal
                                          # `{operation: "create_team",
                                          # name, is_guest_team?,
                                          # subscriber_ids?,
                                          # allow_empty_team?}`. No
                                          # preflight read fires; the dry-
                                          # run is purely argv-derived.
                                          # `meta.source: 'none'`.
                                          # Admin-permission-sensitive.
                                          # `meta.source: 'live'` on the
                                          # live path.
monday user team-delete <tid> --yes [--dry-run]                              v0.5
                                          # `delete_team(team_id) → Team`.
                                          # Destructive gate per §3.1 #7 —
                                          # `--yes` mandatory outside CI;
                                          # missing surfaces
                                          # `confirmation_required` with
                                          # `details.team_id`. Gate fires
                                          # BEFORE `resolveClient` per M10
                                          # round-1 P2 invariant.
                                          # `operationName: 'DeleteTeam'`
                                          # pinned. Idempotent: NO —
                                          # re-running surfaces `not_found`
                                          # past first call. Dry-run per §6.4
                                          # mutation variant; `meta.source:
                                          # 'none'`. Admin-permission-
                                          # sensitive.
monday user team-add-members <tid> --users <id>,... [--dry-run]              v0.5
                                          # `add_users_to_team(team_id,
                                          # user_ids: [ID!]!) →
                                          # ChangeTeamMembershipsResult
                                          # {failed_users, successful_users}`.
                                          # `--users` required numeric brand
                                          # list. Universal partial-success
                                          # envelope per §6.1: `data:
                                          # {operation: "add_users_to_team",
                                          # team_id, results: [{user_id, ok,
                                          # user?, error?}]}`. Wire-vs-CLI
                                          # asymmetry: Monday's
                                          # `failed_users[]` carries User
                                          # objects but NO per-user reason on
                                          # the wire — CLI emits generic
                                          # `membership_failed` error.code
                                          # per failed-user (R-NEW-41 4th
                                          # consumer; documented in
                                          # `docs/architecture.md`).
                                          # `operationName: 'AddUsersToTeam'`
                                          # pinned. Idempotent: yes — re-add
                                          # is wire-side no-op. Admin-
                                          # permission-sensitive.
monday user team-remove-members <tid> --users <id>,... [--dry-run]           v0.5
                                          # `remove_users_from_team(...) →
                                          # ChangeTeamMembershipsResult`.
                                          # Same envelope shape as team-add-
                                          # members with `operation:
                                          # "remove_users_from_team"`.
                                          # Same wire-vs-CLI asymmetry as
                                          # team-add-members (Monday's
                                          # `failed_users[]` carries User
                                          # objects but NO per-user reason —
                                          # CLI emits generic
                                          # `membership_failed` error.code
                                          # per failed-user); canonical note
                                          # at `teamMembershipResultSchema`
                                          # JSDoc in `src/api/teams.ts` +
                                          # `docs/architecture.md`.
                                          # `operationName:
                                          # 'RemoveUsersFromTeam'` pinned.
                                          # Idempotent: yes.

# === WEBHOOK (board-scoped; CLI never *receives*) ===
monday webhook list <bid>                                                    v0.3
monday webhook create <bid> --url <u> --event <e> [--config <json>] [--dry-run]   v0.3
monday webhook delete <wid> --yes [--dry-run]                                v0.3

# === DOC (read + create/rename/delete/duplicate; v0.4 reads + v0.5 CRUD) ===
# Workdocs read + doc-level CRUD surface. v0.4-M32 shipped the
# `list` + `get` reads; v0.5-M35 ships 5 mutation verbs covering
# `create_doc` (mutually-exclusive workspace vs board placement,
# split into 2 CLI verbs per D7) + `update_doc_name` +
# `delete_doc` + `duplicate_doc`. Per-block CRUD (`create_doc_block`
# / `update_doc_block` / `delete_doc_block`) defers to v0.5-M36;
# doc-content import (`import_doc_from_html` /
# `add_content_to_doc_from_markdown`) defers to v0.5-M37 — each
# milestone carries enough surface area to warrant its own
# dedicated cluster rather than a bundled "doc CRUD" sweep.
# Empirical probe at v0.5 kickoff
# (`scripts/probe/v0.5-doc-mutations.ts` + `v0.5-inputs-and-results.ts`
# + `v0.5-nested-inputs.ts`, 2026-05-15, API `2026-01`) pinned the
# 9 mutation operationNames + return-shape heterogeneity (full
# Document on create; opaque JSON scalar on rename/delete/
# duplicate; DocumentBlock on per-block ops; custom success/error
# OBJECTs on the imports).
monday doc list [--workspace <wid>,...] [--order-by <created_at|used_at>] [--limit <n>] [--page <n>]   v0.4
                                          # `Query.docs(workspace_ids: [ID],
                                          # order_by: DocsOrderBy, limit: Int,
                                          # page: Int) → [Document]`. Pinned at
                                          # M32 pre-flight via empirical probe
                                          # (2026-05-14, API `2026-01`) —
                                          # `Query.docs` returns `[Document]`
                                          # (NOT `[Doc]` — the wire type is
                                          # `Document` per the probe; the CLI
                                          # verb namespace is `doc` per §4.1).
                                          # `--workspace` is comma-separated
                                          # numeric workspace IDs (e.g. "12345,
                                          # 67890"); brand-validated per
                                          # entry at the boundary. Inaccessible
                                          # workspace IDs surface as empty
                                          # filter results (Monday's wire
                                          # silently drops unknown IDs — no
                                          # resolver warning fires for
                                          # inaccessibility because the wire
                                          # doesn't distinguish "no docs in
                                          # workspace X" from "X not
                                          # accessible"). `--order-by` is the
                                          # closed 2-value enum `created_at` /
                                          # `used_at` (per the `DocsOrderBy`
                                          # introspection); default
                                          # `created_at`; both sort `desc`
                                          # server-side (no ASC variant on
                                          # Monday's wire). `--limit` is the
                                          # page size, range `[1, 100]`,
                                          # default `25` (matches Monday's
                                          # wire-side default); ceiling pins
                                          # worst-case payload size for
                                          # doc-heavy accounts. `--page` is
                                          # 1-based, default `1`. Page/limit
                                          # pagination — Monday's workdocs
                                          # surface has no cursor. Envelope
                                          # carries `data: { documents:
                                          # [Document], page, limit,
                                          # returned_count, has_more }`;
                                          # `has_more` is the `returned_count
                                          # === limit` heuristic (Monday
                                          # doesn't surface a total count).
                                          # List-row projection ships the
                                          # 13-field base Document WITHOUT the
                                          # `blocks` selection — `blocks`
                                          # belongs to `doc get` (rich-text
                                          # bodies in a list would multiply
                                          # payload across the page). Live-
                                          # only (no cache per §8 cache
                                          # scope); `meta.source: "live"`.
                                          # Idempotent: yes (pure read).
monday doc get <did>                                                         v0.4
                                          # `Query.docs(ids: [<did>]) →
                                          # [Document]` with the per-doc
                                          # `blocks` selection hydrated.
                                          # Returns at most one Document; the
                                          # fetcher extracts index 0. Empty
                                          # wire result (Monday's shape for
                                          # "doc doesn't exist" OR "doc not
                                          # visible to token") surfaces
                                          # `not_found` with `details.doc_id`
                                          # — Monday collapses the two cases
                                          # into the same wire shape so the
                                          # CLI can't distinguish them (no
                                          # `forbidden` rewrap). A null `docs`
                                          # root (distinct from empty-array)
                                          # surfaces `internal_error` with a
                                          # drift hint — Monday's documented
                                          # shape is `[Document]` (possibly
                                          # empty, never null), so null
                                          # indicates wire-shape regression
                                          # worth surfacing loudly rather than
                                          # masquerading as a missing doc
                                          # (M32 IMPL round-1 P2-1 closure).
                                          # Envelope
                                          # `data: <Document with blocks>` —
                                          # direct unwrap matching the read-
                                          # one-verb convention (`board get`,
                                          # `user get`). The Document's own
                                          # `id` field is the echoed input;
                                          # no separate `doc_id` echo slot.
                                          # `data.blocks: [DocumentBlock]`
                                          # carries Monday's 9-field block
                                          # projection — `id` / `type` /
                                          # `content` (JSON, opaque to the
                                          # CLI) / `position` / `parent_block_
                                          # id` / `doc_id` / `created_at` /
                                          # `created_by {id, name}` /
                                          # `updated_at`. Block-content
                                          # schema validity is NOT cross-
                                          # checked by the CLI; Monday's wire
                                          # is the source of truth for the
                                          # per-block-type payload shape.
                                          # Live-only (no cache); `meta.source:
                                          # "live"`. Idempotent: yes.
monday doc create-in-workspace --workspace <wid> --name <n> [--folder <fid>] [--kind public|private|share] [--dry-run]   v0.5
                                          # `Mutation.create_doc(location:
                                          # CreateDocInput!) → Document` with
                                          # `location: { workspace:
                                          # CreateDocWorkspaceInput }`. Pinned
                                          # at M35 pre-flight via empirical
                                          # probe (2026-05-15, API `2026-01`).
                                          # Monday's `CreateDocInput` is
                                          # mutually-exclusive between `board`
                                          # (item-scoped) and `workspace`
                                          # (workspace-scoped); the CLI splits
                                          # into two verbs per D7 closure so
                                          # the mutual-exclusion lives at the
                                          # argv boundary rather than as
                                          # `--workspace`/`--board` choosers
                                          # on one verb. `--workspace <wid>`
                                          # required (maps to wire
                                          # `workspace_id: ID!`); brand-
                                          # validated via WorkspaceIdSchema.
                                          # `--name <n>` required (maps to
                                          # wire `name: String!`); empty
                                          # string rejects at parse.
                                          # `--folder <fid>` optional (maps
                                          # to wire `folder_id: ID`); absent
                                          # → doc lands at workspace root;
                                          # brand-validated via the new
                                          # DocFolderIdSchema brand (11th
                                          # numeric-ID kind). `--kind <k>`
                                          # optional 3-value closed enum
                                          # (`public`/`private`/`share`);
                                          # maps to wire `kind: BoardKind`;
                                          # absent → Monday's workspace-
                                          # default kind applies. Envelope
                                          # `data: <Document>` — direct
                                          # unwrap (mirrors `doc get` shape
                                          # sans `blocks` — Monday returns
                                          # `blocks: null` on a fresh create;
                                          # agents call `doc get <new-id>`
                                          # if they need them).
                                          # `operationName:
                                          # 'CreateDocInWorkspace'` pinned
                                          # at the fetcher boundary
                                          # (R-NEW-37 W2). Live-only (no
                                          # cache; mutations never cache);
                                          # `meta.source: "live"`. Dry-run
                                          # emits the planned `create_doc`
                                          # operation + resolved input
                                          # fields (`meta.source: "none"`).
                                          # Permission-sensitive — tokens
                                          # lacking workdoc-create scope
                                          # surface `forbidden`.
                                          # Idempotent: no (Monday allows
                                          # duplicate doc names within a
                                          # workspace).
monday doc create-on-column --item <iid> --column <cid> [--dry-run]                                          v0.5
                                          # `Mutation.create_doc(location:
                                          # CreateDocInput!) → Document` with
                                          # `location: { board:
                                          # CreateDocBoardInput }`. Mirror of
                                          # `create-in-workspace` for the
                                          # item-scoped placement variant
                                          # per D7 closure. `--item <iid>`
                                          # + `--column <cid>` both required
                                          # (Monday's `CreateDocBoardInput.
                                          # item_id` + `column_id` are both
                                          # `ID!`). The column must be a
                                          # doc-typed column on the item's
                                          # board; CLI does not pre-check
                                          # column-type compatibility
                                          # (mirrors M8's
                                          # `change_column_value` cadence);
                                          # incompatible columns surface
                                          # `validation_failed` at the wire.
                                          # Envelope `data: <Document>` —
                                          # same shape as `create-in-
                                          # workspace`. `operationName:
                                          # 'CreateDocOnColumn'` pinned at
                                          # the fetcher boundary (R-NEW-37
                                          # W2). Live-only; dry-run emits
                                          # planned operation + resolved
                                          # input fields. Idempotent: no.
monday doc rename <did> --name <n> [--dry-run]                                                               v0.5
                                          # `Mutation.update_doc_name(docId:
                                          # ID!, name: String!) → JSON`
                                          # (opaque scalar). Pinned at M35
                                          # pre-flight via empirical probe.
                                          # **camelCase vs snake_case wire-
                                          # arg asymmetry (Finding 7):**
                                          # `update_doc_name` uses camelCase
                                          # `docId` on the wire (distinct
                                          # from snake_case `doc_id` Monday
                                          # uses for `Document` field names
                                          # elsewhere on the schema);
                                          # fetcher boundary mirrors the
                                          # wire verbatim; CLI argv stays
                                          # kebab-case (`<did>` positional +
                                          # `--name <n>`); error envelope
                                          # `details.*` keys stay
                                          # snake_case (`details.doc_id`).
                                          # 4th supporting site for
                                          # R-NEW-41; canonical asymmetry
                                          # note at `src/api/documents.ts`
                                          # module header. Envelope projects
                                          # Monday's opaque JSON return
                                          # into `data: { doc_id: <echoed>,
                                          # success: true }` per D9
                                          # closure. `operationName:
                                          # 'UpdateDocName'` pinned
                                          # (R-NEW-37 W2). Live-only;
                                          # dry-run emits planned operation
                                          # + resolved input fields.
                                          # Idempotent: yes (rename
                                          # converges to a stable name;
                                          # Monday's wire is no-op when
                                          # name matches current value).
monday doc delete <did> --yes [--dry-run]                                                                    v0.5
                                          # `Mutation.delete_doc(docId: ID!)
                                          # → JSON` (opaque scalar). Pinned
                                          # at M35 pre-flight via empirical
                                          # probe. Destructive — `--yes`
                                          # required outside `--dry-run`
                                          # per §3.1 #7; gate fires BEFORE
                                          # `resolveClient` per M10 round-1
                                          # P2 invariant (a missing token
                                          # never masks
                                          # `confirmation_required` as
                                          # `config_error`). Envelope
                                          # projects Monday's opaque JSON
                                          # return into `data: { doc_id:
                                          # <echoed>, success: true }` per
                                          # D9. Null wire payload surfaces
                                          # `not_found` (mirrors M14
                                          # `workspace delete` / M34 `team
                                          # delete` cadence — id was bogus
                                          # or doc already deleted by a
                                          # concurrent caller). camelCase
                                          # wire-arg note (`docId`) carries
                                          # over from `rename`.
                                          # `operationName: 'DeleteDoc'`
                                          # pinned (R-NEW-37 W2). Live-only;
                                          # dry-run emits `{operation:
                                          # "delete_doc", doc_id}` (mirrors
                                          # destructive-no-read pattern of
                                          # `workspace delete` / `team
                                          # delete`). Idempotent: no
                                          # (re-running surfaces
                                          # `not_found` past the first
                                          # call).
monday doc duplicate <did> [--with-updates] [--dry-run]                                                      v0.5
                                          # `Mutation.duplicate_doc(docId:
                                          # ID!, duplicateType?:
                                          # DuplicateType) → JSON` (opaque
                                          # scalar). Pinned at M35 pre-
                                          # flight via empirical probe.
                                          # `duplicateType` is the closed
                                          # 2-value enum
                                          # (`duplicate_doc_with_content` /
                                          # `duplicate_doc_with_content_
                                          # and_updates`); the CLI surfaces
                                          # a boolean `--with-updates`
                                          # opt-in: absent → wire-side
                                          # default
                                          # `duplicate_doc_with_content`
                                          # (content-only); present → wire
                                          # `duplicate_doc_with_content_
                                          # and_updates` (clone body +
                                          # every comment / update thread).
                                          # The 2-value enum stays
                                          # internal to the fetcher.
                                          # **No `--name <n>` slot per D8
                                          # closure** — Monday's
                                          # `duplicate_doc` mutation
                                          # carries no rename-on-duplicate
                                          # arg; the duplicate inherits
                                          # Monday's auto-generated copy
                                          # name. Agents needing a renamed
                                          # duplicate pair with a follow-up
                                          # `monday doc rename <new-id>
                                          # --name <n>` call. Envelope
                                          # projects Monday's opaque JSON
                                          # return into `data: { doc_id:
                                          # <NEW>, success: true }` per D9
                                          # — the `doc_id` slot carries
                                          # the **NEWLY-CREATED**
                                          # duplicate's id, NOT the source-
                                          # doc positional. camelCase wire-
                                          # arg note (`docId`,
                                          # `duplicateType`) carries over
                                          # from `rename`/`delete`.
                                          # `operationName: 'DuplicateDoc'`
                                          # pinned (R-NEW-37 W2). Live-
                                          # only; dry-run emits planned
                                          # operation + resolved input
                                          # fields (source `doc_id`
                                          # echoed; new-id available only
                                          # on live). Idempotent: no (each
                                          # call mints a new DocId).

# === NOTIFICATION ===
monday notification send --user <uid> --target <iid|bid> --target-type item|board --text <t> [--dry-run]   v0.3

# === DEV (workflow shortcuts; see §5.2 carve-out 1, §5.9) ===
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

# === AUTH (per-profile OAuth credentials cache; see §7.3 / §7.4) ===
monday auth login --profile <name>        # OAuth dance + writes credentials v0.3
                                          # cache entry (mode 0600). Headless-
                                          # friendly URL-print fallback when
                                          # no browser opener is found
monday auth logout --profile <name>       # delete the named profile's        v0.3
                                          # credentials cache entry; idempotent
                                          # on missing entry

# === RAW (escape hatch) ===
monday raw <query> [--vars <json>] [--allow-mutation] [--operation-name <n>] v0.1
monday raw --query-file <path> [--vars-file <path>] [--allow-mutation]       v0.1
                                                    [--operation-name <n>]

# === COMPLETION (shell-completion script emitter; see §3.1 #2
#                 raw-bytes carve-out) ===
# Hand-rolled per-shell templates (commander 14.0.3 ships no built-in
# completion machinery — empirical probe at M33 pre-flight:
# `grep -rn 'completion\|complete' node_modules/commander/lib/
# node_modules/commander/typings/` returned zero hits). No runtime
# dep added; the templates enumerate `program.commands` + per-command
# options at emit time so completions stay in sync with the registry.
monday completion <bash|zsh|fish>                                            v0.4
                                          # Emit a shell-completion
                                          # script for the named shell
                                          # flavour. Single positional
                                          # against a CLOSED 3-value
                                          # enum (`bash` / `zsh` /
                                          # `fish`); unknown values
                                          # reject at the parse
                                          # boundary with `usage_error.
                                          # details.issues[]` carrying
                                          # a `{path: 'shell',
                                          # message}` entry per
                                          # `parseArgv`'s
                                          # `SummarisedIssue` shape
                                          # (NOT a completion-specific
                                          # `details.shell` slot; the
                                          # boundary's issue records
                                          # carry only `path` +
                                          # `message` + optional
                                          # `params`, NOT a Zod `code`
                                          # field).
                                          # Standard install flow:
                                          #
                                          #   monday completion bash \
                                          #     >> ~/.bashrc
                                          #   monday completion zsh \
                                          #     >> ~/.zshrc
                                          #   monday completion fish \
                                          #     > ~/.config/fish/\
                                          #       completions/monday.fish
                                          #
                                          # Output discipline (§3.1 #2
                                          # raw-bytes carve-out):
                                          #
                                          # - **Default** (no `--json`
                                          #   / no `--output`): RAW
                                          #   script bytes on stdout,
                                          #   NO envelope, regardless
                                          #   of TTY / pipe context.
                                          # - **`--json` / `--output
                                          #   json` / `MONDAY_OUTPUT=
                                          #   json`**: standard §6
                                          #   envelope with `data: {
                                          #   shell, script }`. Useful
                                          #   for agent introspection
                                          #   (e.g., `monday completion
                                          #   bash --json | jq -r '.data
                                          #   .script'`).
                                          # - **`--table` / `--output
                                          #   table` / `--output text` /
                                          #   `--output ndjson`**:
                                          #   rejected as `usage_error`
                                          #   (no sensible non-JSON
                                          #   envelope view of a multi-
                                          #   line script blob). Only
                                          #   `--json` and `--table` are
                                          #   global shorthand flags per
                                          #   §4.4; `text` and `ndjson`
                                          #   are accessible only via
                                          #   the long-form `--output
                                          #   <fmt>` value.
                                          #
                                          # No wire surface — verb is
                                          # CLI-internal (no Monday API
                                          # call, no auth requirement,
                                          # no cache). `meta.source:
                                          # "none"` on the `--json`
                                          # envelope path. No `--dry-
                                          # run` (not a mutation). No
                                          # GraphQL operation (R-NEW-37
                                          # W2 audit returns "nothing
                                          # flagged" at M33). Adding a
                                          # 4th shell flavour (e.g.
                                          # `powershell`, `nushell`) is
                                          # a SemVer-minor expansion at
                                          # the contract + a matching
                                          # hand-rolled template in
                                          # `src/commands/completion.ts`.
                                          # Idempotent: yes (deterministic
                                          # per shell flavour).

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

# === DIAGNOSTICS (see §11.5) ===
monday status [--no-probe]                # connectivity + auth + local-state v0.3
                                          # probe matrix (DNS / TCP / TLS /
                                          # auth + cache writability +
                                          # redaction self-test + env-var
                                          # pickup). --no-probe skips the
                                          # four network probes; local-only
                                          # probes still run. Decision 7
                                          # closure (M22 pre-flight).
monday usage                              # daily operation-budget remaining  v0.3
                                          # via `platform_api.daily_limit`
                                          # + `daily_analytics.by_day`
                                          # (operations per day, NOT
                                          # complexity points — see §11.5).
                                          # Complements per-call `account
                                          # complexity` so agents self-
                                          # throttle ahead of bulk ops.

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

### 5.2 Two-level depth, not three (with carve-outs)

Monday models things like "the column values of an item of a board".
That's three levels deep. The CLI flattens:
- `monday item set <iid> <col>=<val>` not `monday item column-value
  change <iid> <cid> <val>`.
- `monday item move <iid> --to-group <gid>` not `monday item move-to-
  group <iid> <gid>`.

Cost: a few flags carry information that's structural in GraphQL.
Benefit: every CRUD command stays under ~3 positional args.

**Carve-out 1: workflow namespaces may be three levels deep.** The
`dev` namespace (and any future workflow shortcuts like `service` or
`crm`) explicitly opts into a third level — `monday dev sprint
current`, `monday dev task done <iid>`. The reasoning: workflow
shortcuts are *purpose-built compositions* over the standard CRUD
surface, and their value comes from naming a workflow concept
(`sprint`, `epic`, `release`, `task`) that doesn't exist as a Monday
entity. Flattening them to `monday dev-sprint current` would lose the
hierarchy that makes them discoverable. The two-level rule applies to
the CRUD surface (`account`, `board`, `item`, `update`, `user`,
`webhook`, `doc`, etc.); workflow namespaces are an explicit
exception, not the default.

**Carve-out 2: verb-shaped column-type extensions surface as
`<noun> <subnoun> <verb>`.** Some Monday column types model state
machines rather than settable values — `time_tracking` is the
canonical case (start a timer, stop a timer; the column has no
single "value" the `--set` grammar can model). The CLI exposes these
as a third-level verb on the column-type subnoun: `monday item
time-track start <iid>`, `monday item time-track stop <iid>`. The
reasoning: collapsing to `monday item time-track-start <iid>` would
compose two verbs into one hyphenated noun, hiding the start/stop
pair from `--help` output and tab completion; keeping the verb at
the third level preserves the discoverable pair and reserves the
slot for future verb-shaped column types. This carve-out differs in
shape from carve-out 1: workflow namespaces compose a *workflow
vocabulary* over CRUD; verb-shaped extensions surface a *column-
type's state machine* that the standard `--set` grammar can't model.

**The general rule.** A third level is permitted only when the
three-token shape names something the two-level surface structurally
can't: a workflow namespace plus a workflow concept that isn't a
Monday entity (carve-out 1 — `dev <concept> <verb>` shape), or a
column-type subnoun plus a verb for a column-type with no single
settable value (carve-out 2 — `<noun> <subnoun> <verb>` shape). Two
levels remains the default for everything else; new carve-outs land
via a §5.2 amendment PR with the structural justification spelled
out, not by precedent alone.

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
   **Tentative row — slipped to v0.3 at M18 close.** Three types
   stayed outside the M8 firm row pending design clearance (per-
   account directory + linked-board enumeration). At M18 close (the
   v0.2 release tag), the design work hadn't converged enough to
   ship friendly translators safely; the row slipped to v0.3.
   Until then, they surface `unsupported_column_type` with
   `deferred_to: "v0.3"` and the `--set-raw` escape hatch accepts
   them with the documented Monday wire shape:

   - `tags` (slipped to v0.3) — friendly form will be comma-split
     tag names → `{"tag_ids":[N1,N2]}` via account-tag directory
     lookup. Slip rationale: per-account `tags` query may be too
     expensive to cache cleanly; v0.3's writer-expansion design
     decides the caching strategy. `--set-raw <col>='{"tag_ids":
     [N1,N2]}'` in v0.2.
   - `board_relation` (slipped to v0.3) — friendly form will be
     comma-split item IDs → `{"item_ids":[N1,N2]}` with cross-
     board validation against the source column's allowed boards
     (Monday's `board_relation` settings expose `boardIds` /
     `boardId`). Slip rationale: linked-board enumeration may
     require a per-call complexity-budget design pass v0.2 didn't
     have time to land. `--set-raw <col>='{"item_ids":[N1,N2]}'`
     in v0.2.
   - `dependency` (slipped to v0.3) — same friendly shape as
     `board_relation` but uses Monday's separate `dependency`
     column payload. Same slip rationale. `--set-raw` in v0.2.

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
     carry `deferred_to: "v0.5"`. The verb-shaped path
     (`monday item upload`) shipped at v0.4-M31 — that's the
     alternative agents should use today; the friendly `--set`
     form for file columns (which would need a dispatch from the
     translator boundary into the multipart wire) slipped to v0.5
     at v0.4 release-prep. `--set-raw` rejects these too —
     the underlying mutation isn't `change_column_value` so a raw
     payload can't reach the right wire surface; hint points at
     `monday item upload`.
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
    with `deferred_to: "v0.5"`. The friendly translator and
    `--set-raw` both go through column-value mutations
    (`change_column_value` / `change_multiple_column_values`
    on `item set` / `item update`; `create_item` /
    `create_subitem.column_values` on `item create` per the
    M9 carve-in above) — none of these wire surfaces accept
    `add_file_to_column`-style payloads, so a `--set-raw` raw
    payload can't reach the right wire surface for these
    types. Asset upload itself shipped at v0.4-M31 as the
    verb-shaped `monday item upload`; the friendly `--set` /
    `--set-raw` forms for files slipped to v0.5 at v0.4
    release-prep.
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

The friendly translator covers ten types as of v0.2: `text`,
`long_text`, `numbers`, `status`, `dropdown`, `date`, `people`
(v0.1) plus `link`, `email`, `phone` (M8 firm row).
Anything outside that allowlist has two escape paths: `--set-raw`
for the per-column write (provided the type accepts
`change_column_value` — read-only-forever and `files`-shaped
types are excluded), or the `monday raw` GraphQL escape (§4.3)
for the whole-mutation write (file upload via
`add_file_to_column` falls here until v0.4).

**Writer-expansion roadmap.** Per-type slots for the friendly
translator (`--set <col>=<val>`). v0.1 had no escape hatch — types
outside the allowlist waited on the next version. v0.2 shipped
`--set-raw <col>=<json>` alongside the firm friendly-type batch
(M8 — see "Escape hatch" above), so v0.2+ agents have a write
path for any type the API accepts via column-value mutations
(`change_column_value` / `change_multiple_column_values` for
`item set` / `item update`; `create_item` /
`create_subitem.column_values` for `item create`) even when
the friendly translator hasn't landed for it yet. Read-only-forever types and
`files`-shaped types (which use `add_file_to_column`) remain
unreachable through `--set-raw`; file upload waits for v0.4.
The v0.2-tentative row (`tags`, `board_relation`, `dependency`)
**slipped to v0.3 at M18 close** — design clearance (per-account
directory + linked-board enumeration) didn't converge in v0.2's
window. Their `unsupported_column_type` errors carry
`deferred_to: "v0.3"`; `--set-raw` accepts them today.

| Type | Target version | Notes |
|------|----------------|-------|
| `text`, `long_text`, `numbers`, `status`, `dropdown`, `date`, `people` | **v0.1** (shipped) | Initial allowlist (M5a). |
| `link`, `email`, `phone` | **v0.2** (shipped — M8) | Pipe-form translator + URL/email/E.164 validation. |
| `tags`, `board_relation`, `dependency` | **v0.3** (slipped from v0.2 tentative at M18 close) | Tentative friendly translators planned for v0.3 — need account-tag directory lookup (`tags`) and linked-board enumeration with complexity-budget design (`board_relation` / `dependency`). `--set-raw` accepts these today. |
| `time_tracking` | v0.3 (verbs registered as documentation-only) | Start/stop semantics — verbs, not value writes. `monday item time-track start/stop` shipped at M20 (`b7690b2`) but reject every invocation today: empirical probe (2026-05-10) confirmed Monday's API does not currently support time_tracking writes via `change_simple_column_value` or `change_column_value`; the verbs are registered for forward-compatibility so agent scripts are stable across the eventual swap when Monday ships API support. |
| `files` | **v0.4** (shipped — M31) | **NOT via `--set`** — files cross the wire as `multipart/form-data` (NOT `change_column_value`). Use the dedicated verbs `monday item upload <iid> --column <col> <file>` + `monday update upload <uid> <file>` (§4.3). Non-`file` columns passed to `--column` surface `unsupported_column_type` with a hint pointing back at this row. |
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

**Match-value resolution caveats (per column kind).** The upsert
lookup routes column-token entries through `buildQueryParams` —
the same path `item list --where` and bulk `item update --where`
use against Monday's `items_page(query_params)` endpoint. (`item
search` parses identical syntax via `buildColumnQueries` but
targets `items_page_by_column_values`, a different filter shape;
the v0.2 cross-surface lifts below would also touch that path.)
The lookup pipeline resolves the `me` token to the current user's
ID for people columns and passes everything else verbatim to
Monday's filter. The mutation translator on the
create / update legs has its own grammar — defined by §5.3 — and
the two grammars only overlap cleanly on a subset of column
kinds. The v0.2 contract for `--match-by` is:

- **Always safe (verbatim pass-through on both legs):**
  - `name` (the item-name pseudo-token; Monday's `query_params.
    rules` accepts `column_id: "name"` as a built-in filter
    against the item's name field).
  - `text` / `long_text` — values pass through both legs as raw
    strings.
  - `numbers` — Monday's items_page filter accepts both string
    and number forms when the value parses as a number.
  - External_id-shaped hidden text columns (the recommended
    canonical pattern — see end of this section).
- **Safe via label-text:**
  - `status` / `dropdown` — pass the label name (e.g. `Backlog`,
    not the index). Both translators map label-to-stored-value
    consistently — the `--set` translator resolves `status=Backlog`
    to `{label: "Backlog", index: N}` for the mutation, and the
    lookup leg sends `compare_value: ["Backlog"]` which Monday
    matches against the stored label.
- **Restricted to one value:**
  - `people` — only `me` round-trips. `--match-by owner --set
    owner=me` works on both legs because `me` resolves to the
    current user-ID symmetrically. `--set owner=alice@example.com`
    resolves to a user ID on the mutation leg but the next lookup
    queries for the email string → 0 matches → duplicate. `--set
    owner=12345678` (raw numeric user ID) is rejected by the
    people `--set` grammar (`numericPeopleTokenError`, M5b
    deferral) so the create / update leg fails outright with
    `usage_error`.
- **Not v0.2-safe:**
  - `date` — Monday's items_page filter requires the
    `compare_value: ["EXACT", "YYYY-MM-DD"]` shape for
    date-equals comparisons (per Monday's date-filter changelog),
    but `buildQueryParams` emits a bare `["YYYY-MM-DD"]` (the
    same shape `item search` and `item update --where` ship
    today). Bare ISO does not match Monday's stored date, so an
    upsert with `--match-by due_date` will duplicate on rerun.
    Relative tokens (`+1w`, `tomorrow`) compound the problem —
    they resolve to ISO on the mutation leg but pass verbatim
    on the lookup leg, breaking the round-trip even with the
    EXACT-marker.
  - `link` / `email` / `phone` — the friendly `scalar|text`
    write grammar produces a `{url, text}` / `{email, text}` /
    `{phone, country}` payload, but the lookup leg sends the
    literal pipe string. Monday's filter compares against the
    stored rich shape, not the pipe string, so the round-trip
    breaks. The bare-scalar form (no pipe) might work for some
    operators (e.g. `contains_text`) but is not pinned by tests
    and not part of the v0.2 contract.

**Recommended canonical pattern.** Use a stable hidden text /
`external_id`-shaped column as the synthetic key. Two-token
match-by (`--match-by external_id,name`) lets the agent use the
hidden key for idempotency and `name` for human-readable
disambiguation. The help text reproduces this caveat so an agent
reading `monday item upsert --help` sees the limitations without
having to check this section first.

**v0.3 cross-surface follow-ups.** Email→ID resolution, numeric-
user-ID acceptance in the people `--set` grammar, relative-date
resolution in filters, and the date EXACT-marker lift are all
cross-surface candidates — each would lift `item search`, `item
update --where`, and `item upsert` simultaneously so the three
surfaces stay in lockstep. Lifting any of them in upsert alone
would create inconsistent filter semantics across the surfaces.

### 5.9 The `dev` namespace

Monday Dev's "sprint", "epic", "release", "bug", "task" concepts
are board conventions, not API entities. The CLI's `dev` namespace
is the workflow-namespace three-level carve-out called out in §5.2
(carve-out 1).

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

**v0.3-M26 pre-flight contract diff** lands at `1620220`
— the canonical helper module is `src/api/dev-conventions.ts`
(DevMapping alias over `profiles.ts:profileDevBlockSchema`, the
pure-helper `matchBoardByConvention` + `groupCandidatesByDevNoun`
+ `buildDiscoverMappingFromMatches` for the discover heuristic,
and the 4 runtime fetchers `discoverDevBoards` / `runDevDoctor`
/ `loadDevMapping` / `saveDevMapping`).
**M26a IMPL** landed the 4 fetchers' runtime bodies + the 3
setup verbs (`dev discover` / `dev configure` / `dev doctor`)
at `19755e3` + Codex impl review fix-ups across 3 rounds
(`2be9021` / `c70deb3` / `2a3c06c`). The empirical-probe
finding driving the `Board.type === 'board'` walker filter
(drops `sub_items_board` virtual entries that pollute the
substring heuristic) is pinned in the module docstring +
v0.3-plan §18 M26a post-mortem. The
{@link DEV_DOCTOR_REASONS} 11-value enum + per-status
discriminated-union detail schemas surfaced via
`z.toJSONSchema` so `monday schema dev.doctor` agents can
introspect the closed reason vocabulary.
**M26b IMPL** landed the 10 workflow verbs
(`dev sprint current/list/items` + `dev epic list/items` +
`dev release list` + `dev task list/start/done/block`) at
`10cd1c5` + Codex impl review fix-ups across 3 rounds
(`34a5bc1` / `078dae3` / `8ea66c4`). R-NEW-35
(`_shared.ts:requireDevBoard`, 10-consumer slot-check
helper) + R-NEW-36 (`dev-conventions.ts` workflow-verb
helpers cluster — `walkDevBoardItems` / `hydrateDevBoardColumns`
/ `findRelationColumnIdToBoard` / `extractLinkedItemIds` /
`resolveStatusColumn` / `resolveCanonicalLabel` /
`flipTaskStatus` / `fireDevCreateUpdate`) lifted inline
with the M26b feat to share wire-call discipline across the
10 verbs. Task mutation verbs (`dev task start/done/block`)
flip a tasks-board status column via the canonical labels
"Working on it" / "Done" / "Stuck" + emit `resolved_ids:
{ status: <columnId> }` per §5.3 step 2; `dev task done
--message` and `dev task block --reason` additionally fire
a `create_update` mutation whose result lands in the
top-level `side_effects` slot per §6.4 (M26 round-1 P1-2
closure). All 13 stubs in the dev namespace are now
filled; M26 closed end-to-end. Per-verb output shapes pinned
in [`output-shapes.md`](./output-shapes.md) §M26 entries +
v0.3-plan §19 M26b post-mortem.

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
  "data": <resource | array | verb-specific JSON>,
  "meta": { ... },
  "warnings": [ ... ]
}
```

`data` is most commonly a single-resource projection (§6.2) or
an array of projections (§6.3), but a few mutation verbs return
verb-specific JSON when Monday's wire shape carries fields the
projection schema doesn't model. The current cases (M15) are
`board duplicate` (`data: { board: <projection>, is_async }` —
§6.4 wraps because `BoardDuplication` returns `is_async`) and
the partial-success consumers `update clear-all` / `workspace
add-users` / `workspace remove-users` / `board add-users`
(`data: { operation?, results: [...] }` — §6.4 partial-success
shape). Agents should switch on the verb's `data` schema as
documented per-verb in §6.4 rather than assume `data` is always
a §6.2 / §6.3 projection.

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
degradations — see the stable warning-code registry below.

**Stable warning codes** — agents key off these verbatim; same
SemVer rules as error codes (adding a code is minor; removing or
renaming is major). The table documents producer + `details`
shape per code; some codes have multiple producers, in which
case `details` is a per-producer union (the producer determines
the shape, not the code alone — agents that switch on the code
should accept any documented union member):

| Code | Producer | `details` shape |
|------|----------|-----------------|
| `stale_cache_refreshed` | Cache-miss-refresh backstop fired (cache served the first attempt, then a refresh produced the resolution); see §8 backstop layer. Emitted by `src/api/columns.ts` resolvers | `{ board_id, token }` |
| `column_token_collision` | A `--set` token matched a column ID *and* another column's title; the ID match wins deterministically and the warning surfaces the collision (§5.3 step 3). Emitted by `src/api/columns.ts` resolver | `{ via, resolved_id, candidates: [{id, title, type}] }` |
| `pagination_cap_reached` | A walker stopped at the per-command page cap; more results may exist. Two producers: `src/api/walk-pages.ts`'s `buildCapWarning` (any verb that page-walks via the shared walker — list `--all` verbs AND `update clear-all` collecting IDs to delete) emits `{ pages_walked, hint }`; `src/commands/item/find.ts` (the find-by-name scan — uniqueness check truncated) emits `{ pages_scanned, items_scanned, cap_pages, hint }`. Agents switch on the code, accept either shape | `{ pages_walked, hint }` \| `{ pages_scanned, items_scanned, cap_pages, hint }` |
| `first_of_many` | `find` matched multiple candidates and `--first` picked the lowest-ID one. Emitted by `src/commands/board/find.ts` / `src/commands/item/find.ts` | `{ candidates: [{id, name}] }` |
| `noncanonical_column_type` | M16 `column-create --type` resolved to a column type outside `WRITABLE_COLUMN_TYPES`; agents pick the right write path from `category` (M16 forward-pin — implementation lands at M16 close) | `{ column_type, category: "raw_writable" \| "read_only_forever" \| "files_shaped", suggested_write_path: string \| null }` |
| `inaccessible_boards` | v0.3-M23 cross-board `monday item search` walker detected that Monday's `boards(ids:)` silently omitted N of the requested board IDs (no access, deleted, or never existed — per the empirical-probe finding at 2026-05-11). Emitted by `src/api/cross-board-search.ts`'s `buildInaccessibleBoardsWarning`. Forbids silent partial cross-board results | `{ requested_count: number, returned_count: number, missing_board_ids: string[], hint: string }` |
| `column_not_found_on_board` | v0.3-M23 cross-board `monday item search` walker detected that the `--where` column token didn't resolve on a specific board (different boards have different column IDs; the cross-board fan-out skips boards lacking the column rather than failing the whole call). Emitted by `src/api/cross-board-search.ts`'s `buildColumnNotFoundOnBoardWarning`. One warning per skipped board (so a `--where status=Done` across 25 boards where 3 lack `status` surfaces 3 of these warnings) | `{ board_id, column, hint }` (the `column` key carries the user's `--where` column token; renamed from `column_token` → `column` at M23 implementation (`1f09a25`) per the v0.3-plan §15 contract drift finding — the redactor's `(token\|secret\|password\|api[-_]?key)` pattern would scrub the value otherwise) |
| `cross_board_truncated` | v0.3-M23 cross-board `monday item search` walker stopped before draining every board — either `--limit` short-circuited the aggregate walk, or at least one board still had more items after the v0.3 single-call surface ran. Emitted by `src/api/cross-board-search.ts`'s `buildCrossBoardTruncatedWarning`. The per-board `state` slot lets agents introspect partial completion without a resumable cross-board cursor (deferred to v0.5 per Decision 5 closure rationale — v0.4 didn't pick the resumable-cursor surface up) | `{ reason: "limit_hit" \| "board_has_more", total_returned: number, limit: number \| null, per_board_state: Record<board_id, "exhausted" \| "has_more" \| "not_started">, hint: string }` |
| `board_favorites_stale` | v0.3-M23 `monday board favorites` 2-stage resolver detected that Stage 2 (`boards(ids:)` hydrate) returned fewer boards than Stage 1 (`Query.favorites`) yielded — the user lost access to a favorited board, the board was deleted, or it moved to a closed workspace. Emitted by `src/api/board-favorites.ts`'s `buildStaleFavoritesWarning`. Not fatal: the verb still returns the boards Stage 2 hydrated | `{ favorited_count: number, hydrated_count: number, missing_board_ids: string[], hint: string }` |

Adding a new warning code, a new producer to an existing code
(union extension), or a new field to a `details` shape is
SemVer-minor; removing either, or removing a producer-shape
union member, is SemVer-major. Adding a value to a stable enum
field (`category`, etc.) is SemVer-minor.

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
  "data": <resource | verb-specific JSON>,
  "meta": { ... },
  "warnings": [],
  "side_effects": [ ... ],
  "resolved_ids": { "status": "status_4", "due": "date4" }
}
```

`data` is a single-resource projection (§6.2) for most mutations,
but verb-specific wrappers exist where Monday's wire shape carries
fields the projection schema doesn't model. Current wrappers:
- `board duplicate` → `data: { board: <projection>, is_async }`
  (the `BoardDuplication` SDK type carries `is_async`).
- Partial-success consumers (`update clear-all` / `workspace
  add-users` / `workspace remove-users` / `board add-users`) →
  `data: { operation?, results: [...] }` per the partial-success
  shape below.

Per-verb shapes are documented in their dedicated subsections; the
above is a generic template.

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

- **Update-edit shape** (`update edit`; v0.2 M13). Single-leg
  dry-run, no source read (Monday's `edit_update(id, body)` doesn't
  need anything beyond the update id; the live mutation surfaces
  `not_found` if the id is bogus). Carries `operation:
  "edit_update"`, `update_id`, `body`, and `body_length`. Same
  shape (modulo `parent_id` vs `item_id` vs `update_id` and the
  `body` slot's absence) as the comment-create shape — `update
  reply` reuses the `create_update` shape verbatim, replacing
  `item_id` with `parent_id: <uid>`. `meta.source: "none"` (no
  API call fires).

- **Update-reply shape** (`update reply`; v0.2 M13). The
  comment-create shape with `parent_id: <uid>` substituted for
  `item_id: <iid>`. Carries `operation: "create_update"`,
  `parent_id`, `body`, `body_length`. `meta.source: "none"`.

- **Update-delete shape** (`update delete`; v0.2 M13). Minimal:
  `operation: "delete_update"`, `update_id`. No diff section —
  delete has no per-column changes, no read leg fires (the live
  `delete_update` mutation reports `not_found` if the id is bogus
  and the dry-run is purely argv-derived). `meta.source: "none"`.

- **Update-toggle shape** (`update like` / `unlike` / `pin` /
  `unpin`; v0.2 M13). Same minimal shape — `operation:
  "like_update" | "unlike_update" | "pin_to_top" |
  "unpin_from_top"`, `update_id`, no other slots. `meta.source:
  "none"`. The four toggle verbs share the shape because their
  contract is "flip a single boolean keyed off the caller" — the
  dry-run echoes the operation that would fire and that's the
  whole preview.

- **Update-clear-all shape** (`update clear-all <iid>`; v0.2
  M13). Single-leg dry-run that page-walks
  `updates(item_id: <iid>)` via `walkPages` to enumerate the
  would-delete IDs without firing any `delete_update`. Carries
  `operation: "clear_all_updates"`, `item_id`, and `update_ids:
  ["<u1>", "<u2>", ...]` listing every collected ID. `meta.source:
  "live"` because the page-walk fires real reads (the dry-run is
  a preview-of-state-change, not a preview-of-payload). When the
  item has no updates, `update_ids: []` and the `ok: true` envelope
  with `data: null` reports zero work to do — agents can skip the
  follow-up live call:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "live", ... },
    "planned_changes": [
      {
        "operation": "clear_all_updates",
        "item_id": "12345",
        "update_ids": ["77", "78", "82"]
      }
    ],
    "warnings": []
  }
  ```

- **Workspace-create shape** (`workspace create`; v0.2 M14).
  Minimal: `operation: "create_workspace"`, `name`, `kind`, and
  optional `description`. No diff section (the workspace doesn't
  exist yet, so there's no prior state to render). No read leg
  fires; the dry-run is purely argv-derived. `meta.source:
  "none"`. Mirrors the comment-create shape's preference for
  agent-scannable surface fields rather than burying values
  inside `diff`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "create_workspace",
        "name": "Marketing",
        "kind": "open"
      }
    ],
    "warnings": []
  }
  ```

  When `--description` is provided, the planned change carries an
  additional `description` slot. When `--kind` is omitted, the
  CLI's default (`"open"`) appears in the dry-run shape so the
  agent sees exactly what the live mutation would send (Monday's
  signature pins `kind: WorkspaceKind!`; the CLI fills the
  default rather than letting the wire reject).

- **Workspace-update shape** (`workspace update`; v0.2 M14).
  Single-leg dry-run with a preflight `workspace get` read to
  surface the `from` state per provided field. Carries
  `operation: "update_workspace"`, `workspace_id`, and `diff: {
  <field>: { from, to }, ... }` keyed by the workspace fields
  the agent is changing (`name`, `kind`, `description`). Only
  fields present in the agent's flags appear in `diff` (omitting
  a flag means "leave unchanged"; the wire mutation accepts
  partial `UpdateWorkspaceAttributesInput`). `meta.source: "live"`
  because the preflight read fires a real `workspaces(ids:)`
  query (workspace metadata isn't cached in v0.2; the cache layer
  may extend to it in v0.3 alongside §8's eager-invalidation
  contract):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "live", ... },
    "planned_changes": [
      {
        "operation": "update_workspace",
        "workspace_id": "12345",
        "diff": {
          "name": { "from": "Marketing", "to": "Marketing — EU" },
          "kind": { "from": "open", "to": "closed" }
        }
      }
    ],
    "warnings": []
  }
  ```

  When the preflight read returns `not_found`, the dry-run
  surfaces `not_found` (exit 2) rather than emitting a
  preview-of-failure — agents shouldn't have to interpret a
  would-fail dry-run shape (mirrors the `item move --to-board`
  unmatched-columns rule above).

- **Workspace-delete shape** (`workspace delete`; v0.2 M14).
  Minimal: `operation: "delete_workspace"`, `workspace_id`. No
  diff, no preflight read leg (Monday's `delete_workspace
  (workspace_id)` reports `not_found` if the id is bogus and
  the dry-run is purely argv-derived). `meta.source: "none"`.
  Same shape (modulo `workspace_id` vs `update_id`) as the
  update-delete variant — the destructive-no-read pattern is
  uniform across `item delete`, `update delete`, and
  `workspace delete`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "delete_workspace",
        "workspace_id": "12345"
      }
    ],
    "warnings": []
  }
  ```

- **Workspace-add-users shape** (`workspace add-users`; v0.2
  M14). Single-leg dry-run that resolves every email `--users`
  token through `userByEmail` (numeric IDs skip the resolver
  entirely — they're argv-derived) so resolution failures
  (`user_not_found`) surface ahead of the live call. Carries
  `operation: "add_users_to_workspace"`, `workspace_id`, and
  `results: [...]` — a per-user array mirroring the live
  envelope's `data.results` shape with `would_apply` substituted
  for `ok`. Each record carries `user_id: string` (the resolved
  Monday user ID for resolved tokens; the input token verbatim
  when resolution failed — agents correlate retries against the
  input string), `would_apply: boolean` (true iff the live call
  would dispatch for this user), and an optional `error: { code,
  message }` populated on resolution failure. `meta.source` for
  the dry-run aggregates ONLY the resolver legs: all-numeric
  `--users` → `"none"` (no resolver fires); all-email cache hits
  → `"cache"`; live `users(emails:)` → `"live"`; combinations →
  `"mixed"`. The live envelope folds in every per-target
  mutation dispatch leg too — see the `meta.source` aggregation
  rule under "Per-token resolution failures" below for the
  live-path table:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "add_users_to_workspace",
        "workspace_id": "12345",
        "results": [
          { "user_id": "67890", "would_apply": true },
          { "user_id": "67891", "would_apply": true },
          { "user_id": "ghost@example.com", "would_apply": false,
            "error": { "code": "user_not_found",
                       "message": "No Monday user matches email \"ghost@example.com\"" } }
        ]
      }
    ],
    "warnings": []
  }
  ```

  The corresponding **live envelope** carries `data.operation`
  alongside `data.results` (per v0.2-plan §3 M14 line 399 and
  the upsert precedent that places verb-shape signals on `data`
  rather than `meta`):

  ```json
  {
    "ok": true,
    "data": {
      "operation": "add_users_to_workspace",
      "results": [
        { "user_id": "67890", "ok": true },
        { "user_id": "67891", "ok": true },
        { "user_id": "ghost@example.com", "ok": false,
          "error": { "code": "user_not_found",
                     "message": "No Monday user matches email \"ghost@example.com\"" } }
      ]
    },
    "meta": { ..., "source": "mixed" },
    "warnings": []
  }
  ```

  When **no dispatchable user_id remains after parsing /
  resolution** (every `--users` token was an email AND every
  email failed `userByEmail` lookup), the call surfaces top-
  level `user_not_found` (exit 2) — both for live and dry-run.
  A mixed call where some numeric IDs OR some emails resolved
  successfully still gets the partial-success envelope — failed-
  resolution records land in the per-record `error` slot, not
  whole-call (the partial-success contract holds whenever there
  is at least one user to dispatch against). The whole-call code
  is `user_not_found` (the actionable directory-miss case), NOT
  `usage_error` (which is reserved for malformed `--users`
  syntax — blank tokens, tokens that aren't numeric AND aren't
  email-shaped). This matches §6.5's existing `user_not_found`
  semantics and lets agents distinguish "your argv was wrong"
  (exit 1) from "the directory doesn't have these users" (exit
  2). The error carries `details.failed_tokens: [...]` listing
  every unresolved input (per the §6.5 schema below).

- **Workspace-remove-users shape** (`workspace remove-users`;
  v0.2 M14). Identical shape to workspace-add-users with
  `operation` flipped to `"delete_users_from_workspace"` in
  both the dry-run `planned_changes[]` and the live
  `data.operation`. Same per-user `results` array, same
  `would_apply` / `ok` semantics, same `meta.source`
  aggregation, same `user_not_found` / `usage_error` whole-call
  boundary rules. The two verbs share their envelope shape
  because their contract is symmetric — fan out one wire call
  per user and capture per-user outcomes.

- **Board-create shape** (`board create`; v0.2 M15). Minimal:
  `operation: "create_board"`, `name`, `kind`, and optional
  `workspace_id`, `description`, `template_id`. No diff
  section (the board doesn't exist yet, so there's no prior
  state to render). No read leg fires; the dry-run is purely
  argv-derived. `meta.source: "none"`. Mirrors the workspace-
  create shape's preference for agent-scannable surface fields
  rather than burying values inside `diff`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "create_board",
        "name": "Engineering",
        "kind": "public"
      }
    ],
    "warnings": []
  }
  ```

  When `--workspace` / `--description` / `--template` are
  provided, the planned change carries the corresponding
  `workspace_id` / `description` / `template_id` slot. When
  `--kind` is omitted, the CLI's default (`"public"`) appears
  in the dry-run shape so the agent sees exactly what the live
  mutation would send (Monday's signature pins `board_kind:
  BoardKind!`; the CLI fills the default rather than letting
  the wire reject).

- **Board-update shape** (`board update`; v0.2 M15). Single-
  leg dry-run with a preflight `board get` read to surface the
  `from` state per provided field. Carries `operation:
  "update_board"`, `board_id`, and `diff: { <field>: { from,
  to }, ... }` keyed by the board fields the agent is changing
  (`name`, `description`). Only fields present in the agent's
  flags appear in `diff` (omitting a flag means "leave
  unchanged"). The wire-shape contract differs from
  `update_workspace`: Monday's `update_board(board_id,
  board_attribute, new_value)` updates exactly one attribute
  per call, so a multi-flag invocation fans out N sequential
  wire calls. The dry-run shape stays single-envelope (no
  partial-success leak) — every provided flag's `from → to`
  pair appears as one diff entry, regardless of the per-call
  fan-out. `meta.source: "live"` or `"cache"` (preflight read
  hits the v0.1 board-metadata cache when fresh; M16 adds the
  eager-invalidation contract so post-mutation cache entries
  invalidate immediately):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "update_board",
        "board_id": "12345",
        "diff": {
          "name": { "from": "Engineering", "to": "Engineering — EU" },
          "description": { "from": "Eng team board", "to": "Eng team board, EU region" }
        }
      }
    ],
    "warnings": []
  }
  ```

  When the preflight read returns `not_found`, the dry-run
  surfaces `not_found` (exit 2) rather than emitting a
  preview-of-failure (mirrors the workspace-update rule).

  **Live-path partial-application caveat.** The multi-call
  wire shape produces a single success envelope with `data:
  <full board projection>` from a final `boards(ids:)` read
  leg when every per-field call succeeds. **The post-mutation
  read MUST bypass the board-metadata cache (force-live)** so
  the success envelope reflects post-update state, not stale
  cached metadata; success-path `meta.source: "live"` for that
  reason. Cache-sourced reads are allowed only for the dry-run
  preflight preview, never for the live-success final read. If
  any per-field call fails, the whole-call surfaces an error
  envelope with the failed call's code; Monday has no
  transaction across per-attribute mutations, so per-field
  calls earlier in the sequence have already committed
  server-side and **are not rolled back**. This is the
  strongest guarantee compatible with Monday's wire shape —
  agents re-issuing after a partial-application failure should
  re-read the board to see what landed before retrying the
  unapplied tail.

  **Dry-run cache-staleness caveat.** The preflight `board
  get` read can hit the v0.1 board-metadata cache; `from`
  values in the diff may lag live state up to the cache TTL.
  `cache_age_seconds` reflects cache age and is truthful, but
  the `from` snapshot reflects cache-write time, not "now". When
  preview freshness is critical (e.g. updating after a recent
  rename), pass `--no-cache` to force a live preflight read.

- **Board-archive shape** (`board archive`; v0.2 M15). Mirrors
  item-archive's preflight-read-for-snapshot pattern. Carries
  `operation: "archive_board"`, `board_id`, and `board:
  <projected source snapshot>` (the §6.2 single-resource shape
  the source board would have *before* archive — so an agent
  can verify the ID before re-running with `--yes`). *Omits*
  `diff` (no per-field changes). `meta.source: "live"` or
  `"cache"` because the source-board read can hit the v0.1
  board-metadata cache:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "archive_board",
        "board_id": "12345",
        "board": { "id": "12345", "name": "Engineering", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

  **Cache-staleness caveat.** Cache-sourced snapshots may lag
  live board metadata up to the cache TTL — the board's `name`
  / `description` / `state` shown in the dry-run preview can
  differ from current Monday state. `cache_age_seconds`
  reflects the cache's age and is truthful, but the snapshot
  itself reflects the cache-write moment, not "now". When
  preview freshness is critical (e.g. archiving as part of a
  workflow that just renamed the board), agents should pass
  `--no-cache` to force a live preflight read.

- **Board-delete shape** (`board delete`; v0.2 M15). Minimal:
  `operation: "delete_board"`, `board_id`. No diff, no
  preflight read leg (Monday's `delete_board(board_id)`
  reports `not_found` if the id is bogus and the dry-run is
  purely argv-derived). `meta.source: "none"`. Same shape
  (modulo `board_id` vs `workspace_id`) as the workspace-
  delete variant — the destructive-no-read pattern is uniform
  across `item delete`, `update delete`, `workspace delete`,
  `board delete`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "delete_board",
        "board_id": "12345"
      }
    ],
    "warnings": []
  }
  ```

  Note the deliberate divergence from `board archive`:
  archive carries the source snapshot (mirroring item-
  archive's recoverability-aware shape; archive is soft and
  reversible), delete is minimal (mirroring workspace-
  delete's destructive-no-read shape; delete is hard and
  irrecoverable past Monday's 30-day window). Both patterns
  are preserved rather than forcing one onto the other.

- **Board-duplicate shape** (`board duplicate`; v0.2 M15).
  Single-leg dry-run with a preflight `board get` read for
  the source-board snapshot. Carries `operation:
  "duplicate_board"`, `board_id`, `with_updates: true | false`
  (echoes the agent's `--with-updates` flag; defaults
  `false`), optional `target_workspace_id` (echoes
  `--workspace <wid>`; absent when defaulting to source's
  workspace), optional `target_name` (echoes `--name <n>`;
  absent when defaulting to Monday's server-side `<source
  name> (Copy)`), and `board: <projected source snapshot>`.
  *Omits* `diff` (no per-field changes). `meta.source: "live"`
  or `"cache"` (preflight read leg):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "duplicate_board",
        "board_id": "12345",
        "with_updates": true,
        "target_name": "Engineering — EU",
        "board": { "id": "12345", "name": "Engineering", "state": "active", ... }
      }
    ],
    "warnings": []
  }
  ```

  **Cache-staleness caveat.** Same rule as `board archive` —
  cache-sourced snapshots may lag live board metadata up to
  the cache TTL. Pass `--no-cache` to force a live preflight
  read when preview freshness is critical (e.g. duplicating
  as part of a workflow that just renamed or restructured the
  source board).

  The `--with-updates` flag selects between Monday's
  `duplicate_board_with_pulses` (false; items without
  updates) and `duplicate_board_with_pulses_and_updates`
  (true; items with updates) DuplicateBoardType enum values.
  The third arm (`duplicate_board_with_structure` — skeleton
  without items) is deferred; agents needing it call the wire
  mutation via M9's `dev mutate` escape hatch.

  **Live envelope.** Unlike the other M15 mutation verbs whose
  `data` is the full board projection directly, `board
  duplicate`'s `data` slot wraps because Monday's
  `duplicate_board` returns `BoardDuplication { board,
  is_async }` (SDK 14.0.0 / `BoardDuplication` type) — both
  fields are load-bearing for agents:

  ```json
  {
    "ok": true,
    "data": {
      "board": { "id": "67890", "name": "Engineering — EU", "state": "active", ... },
      "is_async": false
    },
    "meta": { ..., "source": "live" },
    "warnings": []
  }
  ```

  When `is_async: true`, Monday has queued the duplication
  server-side and the new board may not be fully populated by
  the time the envelope returns; immediately following reads
  against `data.board.id` may race completion. Agents needing
  to operate on the duplicated items / updates should poll
  `boards(ids: [<new_id>]) { state }` (or a similar readiness
  check) until the board reports its terminal state, or use
  workflows that tolerate partial-completion. When `is_async:
  false`, the duplication has fully landed by envelope time
  and immediate follow-up reads are safe.

- **Board-add-users shape** (`board add-users`; v0.2 M15).
  Identical shape to workspace-add-users with `operation`
  flipped to `"add_users_to_board"` in both the dry-run
  `planned_changes[]` and the live `data.operation`, and
  `workspace_id` substituted with `board_id`. Same per-user
  `results` array, same `would_apply` / `ok` semantics, same
  `meta.source` aggregation, same `user_not_found` /
  `usage_error` whole-call boundary rules. The wire mutation
  is `add_users_to_board(board_id, user_ids, kind?:
  BoardSubscriberKind)` — M15 omits `kind` and relies on
  Monday's server-side default (subscriber), mirroring M14's
  workspace-add-users `kind?: WorkspaceSubscriberKind`
  decision. The shape repeats verbatim because the contract
  is symmetric across the workspace and board user-management
  surfaces — fan out one wire call per user and capture per-
  user outcomes:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "add_users_to_board",
        "board_id": "12345",
        "results": [
          { "user_id": "67890", "would_apply": true },
          { "user_id": "67891", "would_apply": true },
          { "user_id": "ghost@example.com", "would_apply": false,
            "error": { "code": "user_not_found",
                       "message": "No Monday user matches email \"ghost@example.com\"" } }
        ]
      }
    ],
    "warnings": []
  }
  ```

  `board add-users` is the third partial-success-fan-out
  consumer (after M14's workspace add-users and remove-
  users), triggering the R40 lift at M15 close per v0.2-plan
  §22 R40 — the resolver-fronted-fan-out helper factoring out
  the ~200 LOC shared by the three verbs.

- **Column-create shape** (`board column-create`; v0.2 M16).
  Minimal: `operation: "create_column"`, `board_id`, `type`,
  `title`, and optional `description`, `settings`. No diff
  section (the column doesn't exist yet, so there's no prior
  state to render). No read leg fires; the dry-run is purely
  argv-derived. `meta.source: "none"`. Mirrors the workspace-
  create / board-create shapes' preference for agent-scannable
  surface fields rather than burying values inside `diff`. The
  `settings` slot echoes the agent's `--settings <json>`
  argument verbatim — argv-parse already validated it as
  well-formed JSON and (where M16 ships a per-type schema)
  type-shape-correct, so the dry-run's `settings` is the same
  object the wire mutation would carry as its `defaults: JSON`
  argument:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "create_column",
        "board_id": "12345",
        "type": "status",
        "title": "Priority",
        "settings": { "labels": ["Low", "Med", "High"] }
      }
    ],
    "warnings": []
  }
  ```

  When `--description` / `--settings` are omitted, the
  corresponding planned-change slots are omitted (mirrors the
  workspace-create rule for `--description`). When `--type`
  resolves to a non-writable column type per the §5.3
  allowlist, the `warnings: [...]` array carries a
  `noncanonical_column_type` entry per the §4.3 column-create
  contract — agents see the warning shape on dry-run too so
  the live call's behaviour is predictable. The `type` slot
  carries the validated `ColumnType` enum value (string-
  encoded; see §2.3). The wire argument name is `defaults:
  JSON`, NOT `settings_str: String!` — `settings_str` is the
  read-side serialisation of column settings (returned on
  `Column.settings_str`); `defaults` is the write-side input
  parameter on `create_column`. The CLI surfaces the read-
  vs-write asymmetry as the flag-name choice (`--settings`)
  hiding the wire mismatch from agents; the dry-run's
  `settings` slot mirrors the input-side semantic, not the
  output-side string serialisation.

- **Column-update shape** (`board column-update`; v0.2 M16).
  Single-leg dry-run with a preflight `board describe`-shaped
  read to surface the `from` state per provided field — the
  CLI loads `boardMetadataSchema` for the target board, finds
  the column by ID inside `columns: [...]`, and projects the
  `title` / `description` slots as `from`. Carries
  `operation: "update_column"`, `board_id`, `column_id`, and
  `diff: { <field>: { from, to }, ... }` keyed by the column
  fields the agent is changing (`title`, `description`). Only
  fields present in the agent's flags appear in `diff`
  (omitting a flag means "leave unchanged"; the wire shape
  fans out one mutation per provided field). The wire-shape
  contract differs from `update_workspace` AND from
  `update_board`: Monday's column mutations split across two
  surfaces — `change_column_title(board_id, column_id, title)`
  for `--title`, and `change_column_metadata(board_id,
  column_id, column_property?: ColumnProperty, value?: String)`
  for `--description` — both `column_property` and `value` are
  optional at the wire (SDK 14.0.0); the CLI always supplies
  both for `--description` (`column_property: description`,
  `value: <description>`).
  The `ColumnProperty` enum (SDK 14.0.0) carries only `title`
  / `description` values; the CLI routes `--title` to
  `change_column_title` (the more specific Monday surface)
  rather than to `change_column_metadata({column_property:
  title})`. Multi-flag invocations fan out N sequential wire
  calls — same pattern as `update_board`. The dry-run shape
  stays single-envelope (no partial-success leak). `meta.source:
  "live"` or `"cache"` (preflight read hits the v0.1 board-
  metadata cache when fresh; M16 adds the eager-invalidation
  contract so post-mutation cache entries invalidate
  immediately, see §8):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "update_column",
        "board_id": "12345",
        "column_id": "status_4",
        "diff": {
          "title": { "from": "Status", "to": "Priority" },
          "description": { "from": null, "to": "Owner-set urgency" }
        }
      }
    ],
    "warnings": []
  }
  ```

  When the preflight read returns `not_found` for the board
  OR doesn't contain a column with the requested ID, the
  dry-run surfaces `not_found` (exit 2) rather than emitting
  a preview-of-failure (mirrors the workspace-update / board-
  update rules). The error carries `details.column_id` when
  the board-level read succeeded but the column ID was
  missing.

  **Live-path partial-application caveat.** The multi-call
  wire shape produces a single success envelope with `data:
  <column projection>` from the trailing wire-call's response
  when every per-field call succeeds. Unlike `board update`,
  no separate force-live final read leg fires — Monday's
  column-mutation responses return `Maybe<Column>` post-
  mutation, so the trailing call's response is authoritative
  for both fields. If any per-field call fails, the whole-
  call surfaces an error envelope with the failed call's
  code; Monday has no transaction across column-mutation
  calls, so per-field calls earlier in the sequence have
  already committed server-side and **are not rolled back**.
  The eager-invalidation contract (§8) tracks the wire-state
  high-water mark — `invalidateBoard(boardId)` fires once after
  the full per-attribute fan-out loop settles (whole-call
  success OR whole-call error after partial application),
  conditional on at least one per-attribute call having
  succeeded. When zero legs succeeded (the very first call
  failed before any state changed) invalidation is skipped.
  See §8 fan-out call-site contract for the full timing rule.

  **Dry-run cache-staleness caveat.** The preflight `board
  describe`-shaped read can hit the v0.1 board-metadata
  cache; `from` values in the diff may lag live state up to
  the cache TTL. `cache_age_seconds` reflects cache age and
  is truthful, but the `from` snapshot reflects cache-write
  time, not "now". When preview freshness is critical (e.g.
  updating after a recent column rename), pass `--no-cache`
  to force a live preflight read.

- **Column-delete shape** (`board column-delete`; v0.2 M16).
  Minimal: `operation: "delete_column"`, `board_id`,
  `column_id`. No diff, no preflight read leg (Monday's
  `delete_column(board_id, column_id)` reports `not_found`
  if the ids are bogus and the dry-run is purely argv-
  derived). `meta.source: "none"`. Same shape (modulo
  `column_id` vs `update_id` / `workspace_id` / `board_id`)
  as the destructive-no-read pattern uniform across `item
  delete`, `update delete`, `workspace delete`, `board
  delete`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "delete_column",
        "board_id": "12345",
        "column_id": "status_4"
      }
    ],
    "warnings": []
  }
  ```

  Note the deliberate divergence from `column-update`'s
  preflight-read-bearing dry-run: column-update needs the
  `from` state to render a meaningful diff; column-delete is
  a flag-bound operation where the agent already knows what
  they're deleting (the column ID is the positional). The
  destructive-no-read pattern matches the uniform shape
  across the delete cluster. There is no `column-archive`
  shape — Monday's API has no `archive_column` mutation
  (column lifecycle is delete-only); the CLI doesn't surface
  one.

- **Group-create shape** (`board group-create`; v0.2 M17).
  Minimal: `operation: "create_group"`, `board_id`, `name`,
  and optional `color`. No diff section (the group doesn't
  exist yet, so there's no prior state to render). No read
  leg fires; the dry-run is purely argv-derived.
  `meta.source: "none"`. Mirrors column-create / workspace-
  create / board-create shapes' preference for agent-
  scannable surface fields rather than burying values inside
  `diff`. The optional `color` slot mirrors the agent's
  `--color <c>` argv input verbatim and maps to wire
  `group_color: String?`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "create_group",
        "board_id": "12345",
        "name": "Sprint 42",
        "color": "blue"
      }
    ],
    "warnings": []
  }
  ```

  When `--color` is omitted, the `color` slot is omitted
  from the planned change (mirrors workspace-create's rule
  for `--description` and column-create's rule for
  `--description` / `--settings`). All three of Monday's
  placement surfaces (`position: String?` deprecated,
  `position_relative_method: PositionRelative` +
  `relative_to: String` non-deprecated pair) are not
  surfaced in v0.2 — agents needing placement control use
  M9's `dev mutate` escape hatch; v0.3 may surface
  `--before <gid>` / `--after <gid>` flags mapping to the
  non-deprecated relative-position pair.

- **Group-update shape** (`board group-update`; v0.2 M17).
  Single-leg dry-run with a preflight `board describe`-
  shaped read to surface the `from` state per provided
  field — the CLI loads `boardMetadataSchema` for the
  target board, finds the group by ID inside `groups: [...]`,
  and projects the `title` / `color` slots as `from` (the
  cached projection covers the full Group metadata field
  set, see §8). Carries `operation: "update_group"`,
  `board_id`, `group_id`, and `diff: { <field>: { from, to },
  ... }` keyed by the group fields the agent is changing
  (`name` mapping to wire `group_attribute: title`; `color`
  mapping to wire `group_attribute: color`). Only fields
  present in the agent's flags appear in `diff` (omitting a
  flag means "leave unchanged"; the wire shape fans out one
  mutation per provided field). The wire-shape contract
  differs from `update_workspace`, `update_board`, AND
  `column-update`: Monday's `update_group(board_id, group_id,
  group_attribute: GroupAttributes!, new_value: String!)` is
  per-attribute fan-out across **a single** wire surface —
  every per-attribute call routes through the same mutation
  with a different `group_attribute` enum value (`title` /
  `color`). The `GroupAttributes` enum carries five values
  total in SDK 14.0.0 (`title` / `color` / `position` (the
  `position` value is deprecated on Monday's roadmap) /
  `relative_position_after` / `relative_position_before`);
  v0.2 surfaces only the first two via `--name` / `--color`.
  Repositioning verbs are deferred to v0.3 — see the
  `--position` deferral in the §4.3 group-update annotation.
  Multi-flag invocations fan out N sequential wire calls —
  same pattern as `update_board` and `column-update`. The
  dry-run shape stays single-envelope (no partial-success
  leak). `meta.source: "live"` or `"cache"` (preflight read
  hits the v0.1 board-metadata cache when fresh; M16's
  eager-invalidation contract applies post-mutation, see §8):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 18, ... },
    "planned_changes": [
      {
        "operation": "update_group",
        "board_id": "12345",
        "group_id": "topics",
        "diff": {
          "name": { "from": "Topics", "to": "Sprint 42" },
          "color": { "from": "blue", "to": "purple" }
        }
      }
    ],
    "warnings": []
  }
  ```

  When the preflight read returns `not_found` for the board
  OR doesn't contain a group with the requested ID, the dry-
  run surfaces `not_found` (exit 2) rather than emitting a
  preview-of-failure (mirrors workspace-update / board-
  update / column-update rules). The error carries
  `details.group_id` when the board-level read succeeded
  but the group ID was missing.

  **Live-path partial-application caveat.** The multi-call
  wire shape produces a single success envelope with `data:
  <group projection>` from the trailing wire-call's
  response when every per-attribute call succeeds. Unlike
  `board update`, no separate force-live final read leg
  fires — Monday's `update_group` returns `Maybe<Group>`
  post-mutation, and the CLI's group-metadata projection
  selects the full set the cached `boardMetadataSchema.
  groups[*]` covers (`{id, title, color, position, archived,
  deleted}` — every Group field except `items_page`, which
  is the group's items rather than group metadata and is
  out of scope for the mutation envelope's `data` slot), so
  the trailing call's response is authoritative for every
  group-metadata field. This mirrors `column-update`'s no-force-live shape
  (Monday's column mutations also return `Maybe<Column>`)
  and diverges from `board update`'s force-live shape
  (board's per-attribute calls return only the changed
  slice). If any per-attribute call fails, the whole-call
  surfaces an error envelope with the failed call's code;
  Monday has no transaction across `update_group` calls,
  so per-attribute calls earlier in the sequence have
  already committed server-side and **are not rolled back**.
  The eager-invalidation contract (§8) tracks the wire-
  state high-water mark — `invalidateBoard(boardId)` fires
  once after the full per-attribute fan-out loop settles
  (whole-call success OR whole-call error after partial
  application), conditional on at least one per-attribute
  call having succeeded. When zero legs succeeded (the
  very first call failed before any state changed)
  invalidation is skipped. See §8 fan-out call-site
  contract for the full timing rule.

  **Dry-run cache-staleness caveat.** The preflight `board
  describe`-shaped read can hit the v0.1 board-metadata
  cache; `from` values in the diff may lag live state up to
  the cache TTL. `cache_age_seconds` reflects cache age and
  is truthful, but the `from` snapshot reflects cache-write
  time, not "now". When preview freshness is critical (e.g.
  updating after a recent group rename), pass `--no-cache`
  to force a live preflight read. Same caveat as
  column-update / board-update.

- **Group-archive shape** (`board group-archive`; v0.2 M17).
  Snapshot-bearing: `operation: "archive_group"`, `board_id`,
  `group_id`, plus `group: <projection>` carrying the source
  snapshot loaded via a preflight `loadBoardMetadata` read.
  The cached `boardMetadataSchema.groups[*]` projection
  covers the full Group metadata field set (`{id, title,
  color, position, archived, deleted}`), so the snapshot
  carries every field agents need for "preview before
  archive" without requiring a separate read query. Mirrors
  `board archive`'s snapshot-bearing shape (recoverable
  destructive; preview shows what will be hidden); diverges
  from `column-delete` / `board-delete` / `group-delete`'s
  destructive-no-read minimal shape. `meta.source: "live"`
  or `"cache"` (preflight read hits the v0.1 board-metadata
  cache when fresh):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 18, ... },
    "planned_changes": [
      {
        "operation": "archive_group",
        "board_id": "12345",
        "group_id": "topics",
        "group": {
          "id": "topics",
          "title": "Topics",
          "color": "blue",
          "position": "1.0",
          "archived": false,
          "deleted": false
        }
      }
    ],
    "warnings": []
  }
  ```

  When the preflight read returns `not_found` for the board
  OR doesn't contain a group with the requested ID, the
  dry-run surfaces `not_found` (exit 2) rather than emitting
  a preview-of-failure (mirrors `board archive`'s rule).
  The error carries `details.group_id` when the board-level
  read succeeded but the group ID was missing. Re-archiving
  an already-archived group is a no-op on Monday's side
  (per §9.1); the dry-run still emits the snapshot
  (showing `archived: true`) so agents see the current
  state before re-running idempotently.

  **Dry-run cache-staleness caveat.** Same shape as group-
  update / board-archive: cache-sourced snapshots may lag
  live state up to TTL; `--no-cache` forces a live
  preflight when freshness is critical (e.g. archiving
  after a recent rename or color change).

- **Group-duplicate shape** (`board group-duplicate`; v0.2
  M17). Minimal: `operation: "duplicate_group"`, `board_id`,
  `group_id`, and optional `name` (mapping to wire
  `group_title?`). No diff section, no preflight read leg.
  `meta.source: "none"`. Mirrors `column-delete`'s no-read
  pattern even though group-duplicate is non-destructive —
  the agent already knows what they're duplicating via the
  positional, and the wire mutation reports `not_found` if
  the IDs are bogus:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "duplicate_group",
        "board_id": "12345",
        "group_id": "topics",
        "name": "Topics (copy)"
      }
    ],
    "warnings": []
  }
  ```

  When `--name` is omitted, the `name` slot is omitted from
  the planned change and Monday's wire-side default naming
  applies at live time (typically `"<source name> (copy)"`,
  but the exact convention is server-side and not pinned by
  the CLI). The wire's optional `add_to_top: Boolean`
  argument is not surfaced in v0.2 — agents needing
  placement control use M9's `dev mutate` escape hatch.
  **NOTE — load-bearing divergence from sibling duplicate
  verbs**: `monday item duplicate` and `monday board
  duplicate` both surface `--with-updates` (mapping to wire
  `with_updates: Boolean`); `monday board group-duplicate`
  does NOT, because Monday's `duplicate_group` wire
  signature has no equivalent argument. The pre-pre-flight
  v0.2-plan §3 M17 draft listed `[--with-updates]` for
  group-duplicate; the M17 pre-flight pinned the wire truth
  and dropped the flag from both surfaces.

- **Group-delete shape** (`board group-delete`; v0.2 M17).
  Minimal: `operation: "delete_group"`, `board_id`,
  `group_id`. No diff, no preflight read leg (Monday's
  `delete_group(board_id, group_id)` reports `not_found`
  if the IDs are bogus and the dry-run is purely argv-
  derived). `meta.source: "none"`. Same shape (modulo
  `group_id` vs `column_id` / `update_id` / `workspace_id` /
  `board_id`) as the destructive-no-read pattern uniform
  across `item delete`, `update delete`, `workspace delete`,
  `board delete`, M16 `column-delete`:

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "none", ... },
    "planned_changes": [
      {
        "operation": "delete_group",
        "board_id": "12345",
        "group_id": "topics"
      }
    ],
    "warnings": []
  }
  ```

  Note the deliberate divergence from `group-archive`'s
  preflight-read-bearing dry-run: archive carries the
  source snapshot (item-archive / board-archive precedent
  — recoverable destructive; preview shows what will be
  hidden), delete is minimal (workspace-delete / board-
  delete / column-delete precedent — irrecoverable
  destructive past Monday's retention window; the agent
  already knows what they're deleting via the positional).
  The destructive-no-read pattern matches the uniform
  shape across the delete cluster.

- **Time-track shape** (`item time-track start` / `item
  time-track stop`; v0.3 M20). Verb-shaped column-type
  extension per §5.2 carve-out 2.
  **Documentation-only at v0.3** — empirical probe
  (2026-05-10, API version 2026-01) confirmed Monday's
  public API does not currently support writing to
  time_tracking columns; the verbs ship as forward-
  compatibility markers and reject every invocation with
  `usage_error`. The envelope shapes below describe the
  FUTURE behaviour that will materialise when Monday
  ships API support and the api primitive's rejection
  body is replaced with the real wire call.

  Future live envelope: `operation: "start_time_tracking"
  / "stop_time_tracking"`, `item_id`, `column_id`,
  `running` literal, plus `started_at` (start) or
  `started_at`/`ended_at`/`duration_seconds` (stop).
  `ended_at` is always populated on stop-success
  (Monday's wall-clock when the session closed);
  `started_at` and `duration_seconds` are nullable —
  Monday omits `started_at` on automation-added
  sessions per `TimeTrackingHistoryItem.started_at:
  Maybe<Date>`, and per-session duration is
  uncomputable without a start timestamp.

  Future dry-run envelope: carries a `current_state`
  slot echoing the column's pre-mutation state read
  from `TimeTrackingValue.{running, started_at}`. Both
  verbs surface both fields verbatim — `{running:
  false, started_at: null}` for `start` dry-run (the
  column was stopped, so `started_at` from the open
  session is by definition null);
  `{running: true, started_at: <iso>}` for `stop` dry-
  run (the column is running, so `started_at` is
  populated). Two-leg dry-run (item-read for state +
  column-metadata resolution); `meta.source` is
  `'live'` or `'mixed'` depending on cache hits in the
  column-metadata leg. The `current_state` shape
  mirrors `item-archive`'s `item: <projected source
  snapshot>` slot in role (preview the pre-mutation
  state) but ships a minimal verb-specific subset
  rather than a full single-resource projection —
  time_tracking state is a two-field discriminant.

  Future shape (will materialise when Monday ships
  API support):

  ```json
  {
    "ok": true,
    "data": null,
    "meta": { "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
    "planned_changes": [
      {
        "operation": "stop_time_tracking",
        "item_id": "12345",
        "column_id": "time_tracking_a",
        "current_state": { "running": true, "started_at": "2026-05-10T12:00:00Z" }
      }
    ],
    "warnings": []
  }
  ```

  Current shape (v0.3 — every invocation, including
  `--dry-run`, surfaces the same `usage_error`):

  ```json
  {
    "ok": false,
    "error": {
      "code": "usage_error",
      "message": "`monday item time-track start` is registered for forward-compatibility but cannot fire today — Monday's public API does not currently support writing to time_tracking columns.",
      "request_id": "...",
      "details": {
        "board_id": "111",
        "item_id": "12345",
        "column_id": "duration",
        "hint": "Monday's public GraphQL API does not currently expose a mutation for writing to time_tracking columns. Empirical probe (2026-05-10, API version 2026-01): change_simple_column_value rejects every candidate value with CorrectedValueException ...; change_column_value rejects every candidate JSON shape with InvalidColumnTypeException ...; the mutation root has no time-tracking-related mutation. Use Monday's UI to start/stop time-tracking sessions until Monday ships API support — the verb is registered for forward-compatibility so agent scripts targeting `monday item time-track start/stop` are stable across the eventual swap."
      }
    },
    "meta": { ..., "source": "live", ... }
  }
  ```

  See output-shapes.md `item (mutations)` § for the
  full live + dry-run envelopes (future) and the
  current-state error envelope.

Future mutation verbs may add new shapes; `operation` stays the
discriminator. Agents should switch on `operation` rather than
assume a fixed slot list.

**Partial-success envelope** (M13 `update clear-all`; M14
`workspace add-users` / `remove-users`; M15 `board add-users`).
Multi-target verbs that dispatch one wire call per target emit
**one success envelope** (`ok: true`) with per-target outcomes
in `data.results: [...]`. Each per-target record carries
`{<target_id_field>: string, ok: true | false, error?: { code,
message }}` where the id-field name is verb-specific
(`update_id` for `update clear-all`; `user_id` for the add/remove-
users family). The shared dispatch helper (`dispatchSequential`
in `src/api/partial-success-mutation.ts`) takes the field name
as a parameter so the per-verb shape is self-documenting in
JSON without forcing every consumer to adopt a generic
`target_id`.

```json
{
  "ok": true,
  "data": {
    "results": [
      { "update_id": "77", "ok": true },
      { "update_id": "78", "ok": false,
        "error": { "code": "not_found",
                   "message": "Monday returned no update for id 78" } },
      { "update_id": "82", "ok": true }
    ]
  },
  "meta": { ..., "source": "live" },
  "warnings": []
}
```

The envelope is **always `ok: true` when dispatch ran**, even
when every per-target call inside the loop failed — the call's
contract is "I ran the dispatch and here are the per-target
outcomes." Top-level `error` (`ok: false`) is reserved for
whole-call failure (couldn't reach the API at all, couldn't
resolve any target before the loop began, an unrecoverable
validation error). All-failed-but-each-call-attempted is still
`ok: true` — the agent reads `data.results` to determine
outcomes. This is the §6.1 universal rule applied uniformly
across multi-target verbs (v0.2-plan §8 decision 3).

The `data` slot reuses the existing `MutationEnvelope` (no §6.4
schema bump) — the slot widens to accept `{ results: [...] }`
or `{ operation, results: [...] }` for partial-success
consumers (the optional `operation` slot is verb-specific; M14
add-users / remove-users include it per §3 M14 decision, M13
clear-all does not); single-target verbs typically use the
`<resource>` projection directly, but verb-specific wrappers
are allowed when Monday's wire shape carries fields the
projection doesn't model. The current wrap is M15's `board
duplicate` (`data: { board: <projection>, is_async }` per §6.4
board-duplicate shape, because `BoardDuplication` carries
`is_async`); future verbs may add similar wrappers — agents
should switch on the verb's documented `data` schema rather
than assume `<resource>` projection. `resolved_ids` and `side_effects`
slots are absent on partial-success envelopes — when a verb
performs per-token resolution (e.g. M14 `--users` tokens
through `userByEmail`), the resolved IDs and any failed input
tokens are represented per record inside `data.results` rather
than as a top-level `resolved_ids` map. The implicit-side-
effects slot stays absent because the partial-success per-
target outcomes are themselves the work the call performed.

The corresponding dry-run shape inverts: the dry-run's
`planned_changes[]` lists the would-dispatch operations
(operation-shape per §6.4 above; e.g. `clear_all_updates` with
`update_ids: [...]`); the live envelope's `data.results` lists
the actual per-target outcomes after the loop ran.

**Per-token resolution failures** (M14 `workspace add-users` /
`remove-users`; M15 `board add-users`). Verbs whose targets
resolve through a runtime lookup (e.g. `--users` mixing numeric
IDs with emails, where each email needs `userByEmail`
resolution before the dispatch loop can fire) surface per-token
resolution failures inside the same `data.results` array — a
record with `ok: false` (live) / `would_apply: false` (dry-
run) and `error: { code: "user_not_found", message }` populated.
The id-field carries the **input token verbatim** when
resolution failed (agents need a string to correlate against
their `--users` argument; the resolved Monday ID isn't known).
Numeric IDs in `--users` skip the resolver entirely (they're
argv-derived); only email tokens fire the directory lookup. The
`meta.source` aggregation rule splits between dry-run and live
(see below). This widens the partial-success contract slightly
versus `update clear-all`'s "id-field always carries a Monday
ID" rule and is documented per-verb in §4.3 + §6.4. Whole-call
`error` (`ok: false`) fires with code **`user_not_found`**
(not `usage_error`) when **no dispatchable user_id remains
after parsing / resolution** — every `--users` token was an
email AND every email failed lookup. A mixed call with even
one numeric ID OR one resolved email still gets the partial-
success envelope; failed-resolution records land per-record.
Malformed `--users` syntax (blank tokens; tokens that aren't
numeric AND aren't email-shaped) surfaces as `usage_error`
(exit 1) at argv parse, before any resolution leg fires.

**`meta.source` aggregation for resolver-fronted partial-
success verbs.** The aggregation differs between dry-run and
live because dry-run has only resolver legs while live also
fires per-target mutation legs (each Monday mutation counts as
a `live` leg in `SourceAggregator`'s precedent at
`src/api/source-aggregator.ts`):

- **Dry-run** — aggregate only resolver legs:
  - all-numeric `--users` (no resolver fires) → `"none"`;
  - all-email cache hits → `"cache"`;
  - any live `users(emails:)` lookup → `"live"`;
  - cache + live combinations → `"mixed"`.
- **Live** — aggregate resolver legs + every per-target
  mutation dispatch leg (which is always `live`):
  - all-numeric `--users` (no resolver) + dispatch → `"live"`
    (dispatch is the only source-bearing leg);
  - all-email cache hits + dispatch → `"mixed"` (cache
    resolver + live dispatch);
  - all-email live lookup + dispatch → `"live"`;
  - mixed cache/live resolver + dispatch → `"mixed"`.

The split mirrors the M11 `item move` aggregation precedent
(read-leg + mutation-leg fold) — never collapse all-numeric
live to `"none"` (the dispatch leg already happened) and never
infer `"none"` for any live path that fired a mutation.

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

**Bulk per-item partial-success** (v0.3-M25 `item update
--continue-on-error`). The bulk `item update --where` shape ships
in v0.1 (M5b) with **fail-fast** semantics: the first per-item
error aborts the loop, surfaces as a top-level `error` envelope
with `code` from the per-item failure (`column_archived`,
`validation_failed`, `complexity_exceeded`, …), and decorates
`details` with `matched_count` / `applied_count` / `applied_to` /
`failed_at_item` per §6.5 "Bulk per-item failure". Agents
implement resume-on-rerun by narrowing the next call's filter
against `applied_to`.

M25 adds an **opt-in** partial-success bulk shape via
`--continue-on-error`. With the flag, every matched item is
attempted regardless of per-item failures; failures land per-
record inside `data.results[]` rather than aborting the loop.
The success envelope is **always `ok: true`** when dispatch ran
— per the §6.1 universal partial-success rule applied uniformly
across multi-target verbs (v0.2-plan §8 decision 3; M13 / M14 /
M15 / M25 family). The agent reads `data.results[]` to determine
per-item outcomes.

```json
{
  "ok": true,
  "data": {
    "operation": "item_update",
    "summary": {
      "matched_count": 12,
      "applied_count": 10,
      "failed_count": 2,
      "board_id": "67890"
    },
    "results": [
      { "item_id": "5001", "ok": true,
        "item": { "id": "5001", "name": "...", "columns": { ... } } },
      { "item_id": "5002", "ok": false,
        "error": { "code": "column_archived",
                   "message": "Column status_4 is archived" } },
      { "item_id": "5003", "ok": true,
        "item": { "id": "5003", "name": "...", "columns": { ... } } }
    ]
  },
  "meta": { ..., "source": "mixed" },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

Per-record shape:
- **Success** — `{ item_id: "<iid>", ok: true, item: <§6.2
  projection> }`. The `item` slot is the post-mutation
  projection (same shape as single-item `item update`'s `data`
  payload — agents reading `data.results[i].item` see the
  identical `ProjectedItem` shape they'd get from a single-item
  call).
- **Failure** — `{ item_id: "<iid>", ok: false, error: { code,
  message } }`. The `code` is whichever the per-item mutation
  produced — same codes that would surface as the top-level
  `error.code` under fail-fast (`column_archived` /
  `validation_failed` / `complexity_exceeded` / etc.). The
  `error` slot is non-`undefined` only on failure records; the
  `item` slot is absent.

`data.summary` extends the v0.1 fail-fast bulk-summary shape
(§6.4 above) with one new slot: **`failed_count: number`** —
items whose per-item dispatch failed under the
`--continue-on-error` path. The invariant
`matched_count === applied_count + failed_count` holds for every
M25 success envelope. The slot is absent on the v0.1 fail-fast
bulk envelope (zero failures by construction — the first
failure becomes the top-level `error`).

`data.operation` is the literal **`"item_update"`** (mirrors
M14's add-users / remove-users discriminator at
`data.operation`). M25 follows the M15 partial-success family
shape; the selected per-target dispatcher
(`dispatchSequential` by default / `dispatchParallel` when
`--concurrency > 1`) produces the per-item result rows, and
the action layer assembles `data.operation` + `data.summary`
alongside them. Agents switch on `data.operation` to confirm
which verb produced the envelope.

`resolved_ids` echoes the same token → column-ID mapping the
v0.1 bulk success envelope carries (one `--set` token resolves
once, applies to N items). Present on every `--continue-on-
error` envelope where at least one `--set` token resolved
through the friendly translator (M5b precedent); the slot is
identical to the v0.1 bulk success shape — partial-success
doesn't change what `resolved_ids` echoes.

**Top-level `ok: false` reserved for whole-call failure.** Same
boundary as the M13 / M14 / M15 partial-success envelopes —
`ok: false` fires when:
- the bulk path couldn't reach the API at all (network /
  config / auth failure);
- argv validation rejected the call (malformed `--set` /
  `--set-raw` / `--where` / `--filter-json`);
- the column-resolution pre-pass failed (e.g. token resolved
  to no column → the v0.1 fail-fast precedent applies; column
  resolution is whole-call, not per-item);
- a per-item wire call surfaces an `internal_error`
  (response missing the expected mutation root key, malformed
  payload, schema drift) — the selected dispatcher
  (`dispatchSequential` or `dispatchParallel`) re-throws
  these whole-call rather than papering over them as a
  per-record slot, since `internal_error` signals CLI bugs
  or Monday-side response drift that agents need to see
  directly (M14 round-2 F1 / round-3 F1 precedent at
  `src/api/partial-success-mutation.ts`; R-NEW-28 axis 2
  guarantees the two routes share this escape hatch);
- a programmer-bug exception (TypeError / RangeError / etc.)
  raised inside the per-item dispatch callback — non-
  `MondayCliError` throws propagate through the selected
  dispatcher's non-CliError branch unchanged, surfacing as
  whole-call `internal_error` via the runner's catch-all
  (mirrors `src/api/users-fan-out-mutation.ts`'s resolver-fan-
  out treatment; R-NEW-28 axis 3).

Recoverable per-item dispatch failures (every `MondayCliError`
EXCEPT `internal_error` — `column_archived`,
`validation_failed`, `complexity_exceeded`, `rate_limited`,
`ambiguous_column`, `unsupported_column_type`, `usage_error`,
`not_found`, etc.) DO NOT bubble to top-level under
`--continue-on-error` — they land per-record in
`data.results[]`. This widens the partial-success contract
uniformly: the M13 / M14 / M15 family captures resolver-leg +
dispatch-leg per-target failures; M25 captures dispatch-leg
per-item failures under an explicitly-opted-in flag. The opt-in
is critical for the v0.1 fail-fast default's preservation —
agents who haven't migrated to read `data.results[]` continue
to receive the v0.1 envelope shape.

**Confirmation gate (`--yes`).** The bulk-update confirmation
gate per §3.1 #7 still fires for `--continue-on-error` —
attempting N items without `--yes` (and without `--dry-run`)
returns `confirmation_required` (exit 1). The
`--continue-on-error` flag is **orthogonal** to the
confirmation gate; both must be acknowledged for the live
bulk-partial-success path to fire. The gate fires only when
`matched_count > 0`.

**Empty-match shape.** When the matched-item set is empty, the
bulk path emits the v0.1 fail-fast bulk empty-match envelope
unchanged — `data: {summary: {matched_count: 0, applied_count:
0, board_id}, items: []}` — REGARDLESS of `--continue-on-error`
(M5b Codex pass-1 F1 — `--yes` shouldn't be required to
confirm "no items matched"). The partial-success envelope shape
(`operation: "item_update"`, `data.summary.failed_count`,
`data.results[]`) only materialises when at least one per-item
dispatch fires. Agents reading the bulk envelope check
`data.summary.matched_count` first; zero matches means the
empty-match no-op path ran (v0.1 shape with `items: []`); a
non-zero matched count under `--continue-on-error` means the
partial-success shape ran (`data.summary.failed_count` +
`data.results[]` present).

**Dry-run shape.** `--continue-on-error --dry-run` emits the
v0.1 bulk dry-run shape unchanged (N-element
`planned_changes[]`). Dry-run can't preview per-item failures
because no per-item mutation fires — the partial-success
envelope only materialises when dispatch actually runs. Agents
who want to preview the partial-success shape run the dry-run,
confirm matched count + planned changes, then re-run with
`--yes --continue-on-error`.

**`meta.source` aggregation.** Same as the v0.1 fail-fast bulk
path — metadata load leg + items_page walk leg + N per-item
mutation legs all aggregate through `SourceAggregator`. The
partial-success envelope carries the same `meta.source` shape
the fail-fast envelope would have under identical resolution
inputs. Per-item dispatch failures still count as `'live'` legs
in the aggregator (the wire call did fire — Monday rejected it
but the leg was attempted), mirroring M14's per-target failure
treatment at `src/api/users-fan-out-mutation.ts`.

**Implementation.** The partial-success-bulk path lives in
`src/api/partial-success-bulk.ts` (new at v0.3-M25; thin wrapper
around the selected dispatcher — `dispatchSequential` from
`src/api/partial-success-mutation.ts` by default, or
`dispatchParallel` from `src/api/parallel-dispatch.ts` when
`--concurrency > 1` per the v0.4-M30 extension below). The
wrapper accepts the pre-resolved `SelectedMutation` + the
matched-item-ID list and fans out one wire call per item,
capturing per-item failures into the result records exactly
the way M14 / M15 capture per-target failures. The fail-fast
bulk path (`src/commands/item/update.ts:runBulk`) is unchanged;
the action body branches on `parsed.continueOnError` to choose
between the two paths after the confirmation gate.

**Parallel dispatch** (v0.4-M30 `--concurrency <n>`). M30 extends
the partial-success bulk path with bounded parallel per-item
dispatch via a new module `src/api/parallel-dispatch.ts`
(`dispatchParallel` helper). When the caller passes
`--concurrency <n>` with `n > 1`, the runtime fans out N
per-item mutations concurrently — at most N in-flight at any
moment — and captures per-item outcomes into `data.results[]`
exactly the way the sequential M25 path does. The envelope shape
is **byte-equivalent** to the M25 path: same per-record `{item_id,
ok, item|error}` shape, same `data.summary.{matched_count,
applied_count, failed_count, board_id}` slot, same `ok: true`
universal-partial-success rule at the top level. The result
array preserves **input order** (`results[i]` corresponds to
`matchedItemIds[i]`) regardless of completion order — downstream
consumers + table renderers don't observe per-call timing.

Constraints (v0.4-plan M30 D1–D5):

- **Range.** `--concurrency` accepts `[1, 32]`. `1` is a valid
  no-op that routes through the sequential path verbatim; `> 1`
  routes through the parallel helper. The `32` upper bound is
  conservative under any plausible Monday per-account concurrency
  cap (§2.5; empirical probe at v0.4-M30 pre-flight observed
  100+ in-flight trivial reads without triggering
  `concurrency_exceeded`). Out-of-range values reject at
  argv-parse time with `usage_error`.
- **Requires `--continue-on-error`.** `--concurrency` is rejected
  with `usage_error` when `--continue-on-error` is absent — the
  fail-fast bulk path doesn't have a defined "abort N in-flight"
  semantic (which in-flight calls to cancel? how to report
  `details.applied_to` against a non-sequential dispatch order?).
  Parallel fail-fast is explicitly deferred (no v0.x milestone
  scheduled). The universal partial-success rule makes "let every
  in-flight dispatch complete and capture per-record outcomes"
  unambiguous, so parallel only lands on the partial-success
  surface.
- **Rejected on single-item shape.** Single-item `monday item
  update <iid>` has no per-item dispatch loop to parallelise;
  `--concurrency` on a single-item invocation rejects at
  shape-validation time (`validateInputShape`, before any
  network call) with `usage_error` (mirrors the
  `--continue-on-error` single-item rejection). The argv parse
  boundary itself accepts the combination — the schema is
  shape-agnostic — and only the downstream
  `validateInputShape` check fires the rejection.
- **`concurrency_exceeded` handling.** When Monday returns
  `concurrency_exceeded` to a per-item dispatch (HTTP 200 with
  `errors[].extensions.code === 'CONCURRENCY_LIMIT_EXCEEDED'`),
  the existing retry layer (`src/api/retry.ts`) applies
  exponential backoff per §2.5 — no M30-specific logic.
  Persistent `concurrency_exceeded` after retries lands per-
  record in `data.results[]` like any other per-item failure
  (cli-design §6.4 partial-success-bulk failure path; agents
  key off `data.results[i].error.code === 'concurrency_exceeded'`
  to rerun a narrowed filter).
- **Behavioural-equivalence audit (R-NEW-28 6-axis).** The six
  axes — per-target error code semantics + `internal_error`
  whole-call re-throw + non-`MondayCliError` whole-call re-throw
  + empty-input no-dispatch + input-order preservation in
  `data.results[]` + AbortSignal threading — all mirror the M25
  sequential path verbatim. AbortSignal threading lands at M30
  IMPL as an optional `signal?: AbortSignal` parameter on both
  dispatchers (`dispatchSequential` + `dispatchParallel`); both
  check `signal.aborted` at iteration / worker-loop top and
  re-throw `signal.reason` whole-call. The dispatcher-level
  signal is the pool **scheduler** short-circuit (stops picking
  up new targets after abort); in-flight wire calls abort via
  the existing `MondayClient.signal` configured at construction
  time (the client threads its signal into every fetch). The
  two routes differ only in dispatch ordering; the per-target
  dispatch closure is shared between them at the wrapper layer.

`--concurrency 1` (the default) preserves the M25 envelope
byte-equivalence — agents who don't opt in continue to receive
identical envelopes. The empirical probe at M30 pre-flight
confirmed Monday's per-account cap exceeds 100 in-flight for
trivial reads at API `2026-01`; the `32` ceiling on
`--concurrency` leaves substantial headroom under any plausible
plan-tier cap.

**Asset upload** (v0.4-M31 `monday item upload` + `monday update
upload`). M31 lands the first v0.4 verbs crossing the wire via
`multipart/form-data` rather than the JSON-only `client.request`
seam — the envelope is structurally a single-resource mutation
result but with a verb-specific `data` shape echoing the upload
metadata + the wire `Asset` record. Two parallel envelope shapes:

- **`item upload`** — `data: {operation: 'add_file_to_column',
  item_id, column_id, filename, file_size_bytes, asset: {...}}`.
  `asset` carries Monday's full 10-field `Asset` projection
  (`id` / `name` / `url` / `public_url` / `file_extension` /
  `file_size` / `created_at` / `uploaded_by` / `original_geometry`
  / `url_thumbnail` — empirical probe `scripts/probe/m31-asset-
  upload.ts` 2026-05-13, API `2026-01`). `file_size_bytes`
  is the **CLI-measured size at upload time** (from `fs.stat()`);
  `asset.file_size` is Monday's server-stored size. Usually
  identical but preserved separately for asymmetric-storage-
  encoding fidelity.
- **`update upload`** — `data: {operation: 'add_file_to_update',
  update_id, filename, file_size_bytes, asset: {...}}`. Same
  `Asset` projection; no `column_id` (Updates carry attachments
  directly via `Update.assets`).

**Dry-run shape** — argv-derived, no wire mutation fires:

```json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "source": "none", ... },
  "planned_changes": [
    {
      "operation": "add_file_to_column",
      "item_id": "12345",
      "column_id": "files",
      "file_path": "./screenshot.png",
      "filename": "screenshot.png",
      "file_size_bytes": 41822
    }
  ],
  "warnings": []
}
```

`file_size_bytes` on the dry-run reads the file's local size via
`fs.stat()` so an agent can confirm the planned upload fits any
known plan-tier ceiling before issuing the live mutation. No file
bytes are actually transmitted on a dry-run. The
`update upload` dry-run variant carries `update_id` instead of
`item_id` + `column_id`; otherwise structurally identical.

**Wire transport.** Both verbs dispatch via a new
`src/api/multipart-transport.ts` seam — a `MultipartTransport`
interface mirroring the existing `Transport`'s shape but with a
`FormData`-driven multipart body assembly (operations + map + file
parts per the standard GraphQL multipart-request specification).
Header lockdown carries over from `transport.ts` —
`Authorization` + `API-Version` are transport-owned; `Content-
Type` is set by `fetch` from the FormData boundary (different from
the JSON transport's hard-coded `application/json`). See
`docs/architecture.md` "Wire-vs-CLI semantics documentation
conventions" for the asymmetry context (R-NEW-41 3rd consumer
fired at M31 pre-flight).

**Retry + signal threading (§2.5).** Asset upload honors the
global `--retry <n>` contract: the IMPL session wraps the
multipart wire dispatch in `withRetry(...)` using the same retry
layer the JSON transport uses (`src/api/retry.ts`). Re-readability
is safe — Web `Blob.stream()` returns a fresh `ReadableStream`
per call, so multipart payload assembly re-executes per attempt
without buffering. Retryable conditions match the JSON
transport's set (`rate_limited` / `complexity_exceeded` /
`concurrency_exceeded` / `ip_rate_limited` / `resource_locked`
/ `network_error`); `usage_error.file_too_large` and other
terminal failures surface immediately. The runner's combined
signal (`ctx.signal`) is threaded through to
`MultipartTransportRequest.signal` explicitly via the fetcher
inputs — the fetcher signatures REQUIRE a `signal` slot
(`MondayClient.signal` is private + multipart bypasses
`MondayClient.raw`, so no implicit fallback exists).

**Idempotency: NO.** Each successful upload mints a new `Asset`
with a new ID — re-running both verbs uploads the file a second
time. Agents needing register-once semantics dedupe on a
pre-read of `Item.assets` / `Update.assets` (read-side asset
verbs deferred to v0.4.x — see v0.4-plan §3 M31 Decision D6).

**Cache invalidation.** `item upload` invalidates the parent
item's board metadata cache on success (single-leg per §8 — the
file column's `FileValue` ColumnValue is part of the cached
board metadata projection). `update upload` does not invalidate
(Updates aren't part of the §8 cache scope).

**Constraints (v0.4-plan M31 D1–D11):**

- **Column type — `file` only.** Non-`file` columns passed to
  `--column` surface `unsupported_column_type` per §5.3 writer-
  expansion roadmap (matches the existing `files_shaped`
  rejection's hint — points at `monday item upload`). `doc`
  column upload is a future v0.4+ extension (separate mutation
  surface).
- **Local file failures + size cap — discriminated by
  `details.reason`.** Local file path failures rewrap as
  `usage_error` with one of three `details.reason` values:
  `'file_not_readable'` (ENOENT / EACCES / path is a directory),
  `'file_empty'` (zero-byte file — Monday rejects), or
  `'file_too_large'` (server-side size-cap rejection rewrap;
  carries `details.file_size_bytes` from the **local
  `fs.stat()` measurement at upload time**, NOT a Monday
  error-payload field — Monday's wire rejection may not surface
  a size, but the CLI already has the local size from the read
  leg and threads it for a stable agent-keyed envelope).
  Monday's per-file size cap is plan-tier-dependent and not
  exposed via the schema (empirical probe — `Plan` + `Account`
  carry no file-quota fields), so the CLI does NOT pre-check
  size against a hardcoded ceiling; the rewrap fires only on
  Monday's runtime rejection at IMPL.
- **File path — local file only.** Stdin (`<file>='-'`) is NOT
  supported in v0.4-M31. A future contract extension may add
  stdin once a `--filename <name>` companion flag is pinned.
- **No new ERROR_CODE** — failures route through existing
  `usage_error` (file path issues, oversize), `unsupported_
  column_type` (non-`file` column), `not_found` (item/update/
  column gone), `validation_failed` (Monday server-side reject),
  `forbidden` / `unauthorized` (token scope).

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

**Stable error codes.** The full list grows over time;
removals are major bumps. v0.1 shipped 26 codes; v0.2-M12 added
`ambiguous_match` (27 total). Subsequent v0.2 milestones (M13–
M18) reused the existing codes without adding new ones. v0.3-M19
adds `tag_not_found` (28 total) — registered pre-M19 as the
writer-expansion close requires it (the `tags` friendly translator's
per-account directory-miss surface), so the registry entry lands
ahead of the M19 implementation feat commits. v0.3-M21 adds
`oauth_failed` (29 total) — the umbrella code for the
`monday auth login` flow per §7.3.3, with `details.reason`
discriminating per failure mode (`csrf_mismatch`, `user_denied`,
`code_exchange_failed`, `timeout`, `port_in_use`,
`browser_unavailable`). The registry entry lands at the M21
pre-flight contract diff so M21 implementation feat commits throw
into a stable typed surface.

| Code | Origin | Retryable? |
|------|--------|------------|
| `usage_error` | CLI parsing | No |
| `confirmation_required` | Live destructive op without `--yes` (and without `--dry-run`); §3.1 #7 — dry-run bypasses the gate | No |
| `not_found` | Item/board/etc. doesn't exist | No |
| `ambiguous_name` | `find` matched multiple | No |
| `ambiguous_column` | `--set` resolved to multiple columns | No |
| `ambiguous_match` | `item upsert` matched 2+ items (M12) | No |
| `column_not_found` | `--set` matched no column | No |
| `user_not_found` | Email lookup failed | No |
| `tag_not_found` | `--set tags=...` named one or more tags not in the account directory (M19+) | No |
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
| `oauth_failed` | `monday auth login` failure (M21+ — see §7.3.3 reason discriminant) | No |
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

- `confirmation_required` — two producer shapes (per-producer
  union; agents switch on the code, accept either):
  - **Bulk filter-gated shape** (bulk mutations without
    `--yes` and without `--dry-run` — `item update --where`,
    `item clear --where`):
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
  - **Single-target destructive-gate shape** (single-target
    destructive verbs without `--yes` and without `--dry-run`
    — `item archive` / `item delete` / `update delete` /
    `workspace delete` / `board archive` / `board delete` /
    M16 `board column-delete` / M17 `board group-archive` /
    `group-delete`):
    - `<resource_id_field>: string` — verb-specific
      identifier echoing the positional the agent passed
      (`item_id` for `item archive` / `delete`; `update_id`
      for `update delete`; `workspace_id` for `workspace
      delete`; `board_id` for `board archive` / `delete`;
      `column_id` for M16 `column-delete` (paired with
      `board_id` since the wire signature is two-tuple); same
      pairing for M17 `group-archive` / `group-delete`).
    - `hint: string` — actionable guidance ("re-run with
      `--yes` to commit, or with `--dry-run` to preview").
- `column_archived`:
  - `column_id: string`, `column_title: string` — the archived
    column the agent targeted.
  - `details.remapped_from` (optional, see above).
  - `details.resolver_warnings` (optional, see above).
- `ambiguous_column`:
  - `candidates: [{ id, title, type }, ...]` — the matching
    columns. Agents retry with explicit `id:<column_id>` prefix.
- `user_not_found`:
  - `email: string` — present on single-lookup failures (M5a's
    `userByEmail` path: `--set people=<email>`, `--match-by`
    people resolution, etc.).
  - `failed_tokens: string[]` — present on multi-token whole-
    call failures (M14 `workspace add-users` / `remove-users`,
    M15 `board add-users`) when no dispatchable user_id remains
    after parsing/resolution. Carries every email `--users` token
    that failed lookup, in input order; numeric IDs that passed
    argv-parse don't appear here. Per-record per-target failures
    inside a partial-success envelope land in
    `data.results[i].error` instead — `failed_tokens` is reserved
    for the whole-call boundary.
- `tag_not_found` (M19+ — `--set tags=<name1>,<name2>` named one
  or more tags not in the account directory):
  - `tags: string[]` — every input tag that the per-account
    directory lookup missed, in input order. **Always an array,
    never a singular `tag` field**; a multi-miss `--set
    tags=foo,bar,baz` where two tags are absent surfaces a single
    error envelope with `tags: ["foo","bar"]` rather than two
    separate errors. The shape diverges intentionally from
    `user_not_found.details.email` (singular) — `resolveTags`
    detects every miss in one directory pass, so the array form
    avoids forcing agents to retry tag-by-tag. A future
    consolidation that unifies the two directory-miss shapes is a
    separate cli-design PR; until then, agents key off
    `tag_not_found` for the array shape and `user_not_found` for
    the singular shape.
  - `hint: string` — actionable guidance pointing at the discovery
    surface. Default text: ``Run `monday account tags` to list
    available tags.`` The hint commits to the `monday account
    tags` read verb as a v0.3 deliverable; whether it lands inside
    M19 implementation or as a v0.3.x fast-follow is decided at
    M19 implementation kickoff.
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
- `oauth_failed` (M21+ — `monday auth login` flow failure
  umbrella per §7.3.3):
  - `reason: "csrf_mismatch" | "user_denied" |
    "authorization_failed" | "code_exchange_failed" | "timeout" |
    "port_in_use" | "browser_unavailable"` — discriminator. Agents
    key off this rather than `error.message`.
  - `monday_code: string` — present on
    `reason: "code_exchange_failed"` (Monday's RFC 6749 `error`
    field from the `/oauth2/token` rejection response —
    probe-confirmed shape: `invalid_request`, `invalid_grant`,
    etc., HTTP 400, `application/json` body) AND on
    `reason: "authorization_failed"` (Monday's `error` field from
    the `/oauth2/authorize` redirect query — documented codes
    include `invalid_scope`, `unauthorized_client`,
    `server_error`, `temporary_unavailable`).
  - `monday_description: string` — present on the same two
    reasons as `monday_code`; carries Monday's `error_description`
    field verbatim.
  - `port: number` — present only on
    `reason: "port_in_use"`; carries the port the listener tried
    to bind (typically `9876` per §7.3.1 step 2).
  - `url: string` — present only on
    `reason: "browser_unavailable"`; carries the consent URL the
    user can paste into a browser on another machine (e.g., via
    SSH port forwarding) to complete the flow without the local
    listener.
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
name (`api_token_env`) or use the `monday auth login` flow (shipped
at v0.3-M21 Part 1) which writes a secrets file at
`~/.monday-cli/credentials` (mode 0600). **OAuth login is deferred
indefinitely at v0.3.0** (v0.3-plan §8 Decision 11 closure) — the
auth-login surface throws a clear `usage_error.details.reason:
oauth_unregistered` pointing at `MONDAY_API_TOKEN` until a future
version registers a canonical `monday-cli` OAuth app. See §7.3 for
the deferral block + revival steps.

### 7.3 v3 — `monday auth login`

The agent-facing UX for obtaining a Monday API token without ever
pasting one into a shell. `monday auth login --profile <name>` opens
the user's default browser to Monday's OAuth consent screen, listens
on `127.0.0.1:9876` for the redirect (fixed port per §7.3.1 step 2),
exchanges the authorisation code for an access token, and writes the
token to the credentials cache (§7.4).

The wire-level flow (state-CSRF expectations, redirect URI matching
exactness, scope strings, exact response shapes from
`/oauth2/authorize` and `/oauth2/token`) was **confirmed at M21
pre-flight contract diff via empirical probe** (`scripts/probe/
m21-oauth.ts` against `auth.monday.com`, 2026-05-10) per v0.3-plan
§22 R-watch-item — findings inline below at each
**Probe-time-confirmed:** callout. Findings the probe could not
empirically resolve (full token-exchange success — at probe time, no
monday-cli OAuth app was yet registered with Monday's developer portal)
carry **Probe-time deferred:** callouts that point at the docs-pinned
shape Part 1 shipped against. The TokenResponse success-body shape was
verified inline at Part 1 (`a4cb5b0`) against Monday's actual
`/oauth2/token` 200 response and matches Monday's docs verbatim
(`{access_token, token_type, scope}`, no `expires_in`); the
`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` constants ship as
`<UNREGISTERED_PENDING_OAUTH_APP>` placeholders, originally intended
for a pre-publish swap against a registered Monday OAuth app.

**OAuth deferred at v0.3.0 (v0.3-plan §8 Decision 11 closure).**
Registering a canonical `monday-cli` OAuth app + swapping the
placeholders was deferred indefinitely at the M28 pre-flight pending
clear user demand for browser-based login over the `MONDAY_API_TOKEN`
env-var path (which works fully today). To prevent users hitting the
cryptic upstream `oauth_failed.code_exchange_failed` when invoking
`monday auth login` against the placeholder values, the action body
ships a placeholder guard that throws a clear
`usage_error.details.reason: oauth_unregistered` pointing at
`MONDAY_API_TOKEN` (the `__test_oauth_helper` test seam bypasses the
guard so the M21 integration test surface stays green). If a future
v0.3.x or v0.4 picks OAuth back up, the steps are: register an app at
https://developer.monday.com/apps with redirect URI exactly
`http://127.0.0.1:9876/callback`, swap the two constants in
`src/api/oauth.ts`, and drop the placeholder guard in
`src/commands/auth/login.ts`.

**Sibling verb.** `monday auth logout --profile <name>` deletes the
named profile's entry from `~/.monday-cli/credentials` (§7.4) and is
idempotent on a missing entry (no-op, `ok: true`).

#### 7.3.1 Flow shape

1. **Generate per-attempt CSRF state.** A 32-byte
   cryptographically-random `state` token (`crypto.randomBytes`,
   base64url-encoded). Lives only in process memory; never written
   to disk. **Probe-time-confirmed (2026-05-10):** Monday's
   `/oauth2/authorize` accepts arbitrary query params and JWT-encodes
   them all into an `oauth_payload_token` redirect target — the
   `state` round-trips through verbatim (echoed back at the
   redirect step per RFC 6749). PKCE (`code_challenge` /
   `code_verifier`) is **not load-bearing for v0.3**: Monday's
   `/oauth2/token` rejects the public-client (PKCE-only) shape with
   `{"error":"invalid_request","error_description":"Missing client_secret param"}`
   (status 400) — `client_secret` is mandatory regardless. v0.3
   ships `client_secret`-only authentication of the token-exchange
   call, with the secret pinned in source per the public-OAuth-client
   convention (the secret authenticates the *app* — `monday-cli` —
   not the user; the user's flow is protected by `state` CSRF + the
   listener-bound `redirect_uri`). A future PKCE upgrade is a
   separate cli-design §7.3 amendment with its own Codex review.

2. **Bind the local listener.** Fixed port — `127.0.0.1:9876` by
   default (`OAUTH_DEFAULT_PORT` constant in `src/api/oauth.ts`).
   The OAuth app's redirect URI configuration pins this port.
   **Probe-time-confirmed (2026-05-10):** Monday's published OAuth
   docs require redirect URIs to match exactly ("must match the
   authorization request value") — wildcard / port-range patterns
   are not documented. v0.3 ships a fixed port; the
   parallel-invocation collision (two concurrent `monday auth login`
   invocations on the same machine) surfaces as
   `oauth_failed.reason: "port_in_use"` with `details.port: 9876`
   rather than `internal_error`, so an agent gets a clean recovery
   signal. **Probe-time deferred:** whether the OAuth app
   configuration accepts a *list* of redirect URIs (multiple ports)
   to escape the parallel-invocation collision is verifiable only
   after the OAuth app is registered at M21 implementation kickoff;
   the v0.3 design ships single-port-only and revisits the
   multi-port option as a v0.4+ amendment if the limitation proves
   load-bearing.

3. **Open the browser.** Build the consent URL:
   `https://auth.monday.com/oauth2/authorize?client_id=<cli_client_id>&redirect_uri=http://127.0.0.1:9876/callback&state=<state>&scope=<scopes>`.
   No `code_challenge` / `code_challenge_method` per §7.3.1 step 1.
   Open via `open` (macOS) / `xdg-open` (Linux) / `start` (Windows)
   through `node:child_process`'s `spawn` with `detached: true`.
   **Fallback:** if no opener is found OR the spawn fails, the CLI
   prints the consent URL to stderr (never stdout — stdout carries the
   final envelope) with the wording *"Open this URL in your browser to
   continue: <url>"* and **continues to listen** for the redirect; the
   listener is the source of truth, the browser-open is a convenience.
   This means `monday auth login` works on headless boxes (CI, agent
   runtimes, SSH sessions) — the user pastes the URL into a browser on
   another machine that can reach the listening host (typically via
   SSH port forwarding). Total stderr-print failure (no opener AND
   stderr is closed/erroring) surfaces
   `oauth_failed.reason: "browser_unavailable"` with `details.url`
   carrying the consent URL so an agent can paste it back through
   another channel.

4. **Wait for the redirect.** The listener accepts a single GET request
   matching `/callback?code=…&state=…` (or `?error=…&state=…` on user
   denial); reject every other path with `404` and every other state
   value with `403`. Default listener timeout: **5 minutes** (one
   in-process timer cancellable via `AbortController` so SIGINT closes
   the listener cleanly per cli.md "Signal handling"). The listener
   answers the browser with a static "*You can close this tab now.*"
   HTML page (no JS, no external resources, no token reflection); the
   CLI then closes the listener.

5. **Verify CSRF.** The redirect's `state` query param must equal the
   per-attempt `state` byte-for-byte (`crypto.timingSafeEqual` to avoid
   timing oracles). Length-mismatched buffers cause
   `crypto.timingSafeEqual` to throw, so the CSRF-verification path
   guards on `Buffer.byteLength` equality first AND returns `false`
   on length mismatch — a length-mismatched `state` routes to
   `oauth_failed.reason: "csrf_mismatch"` rather than
   `internal_error`, treating it as a CSRF signal not a CLI bug.
   The `verifyCsrf` helper in `src/api/oauth.ts` exports this
   discipline as a pure function (no I/O). Mismatch →
   `oauth_failed` with `details.reason: "csrf_mismatch"`; no
   token-exchange call follows. **Probe-time-confirmed
   (2026-05-10):** `state` round-trips as a query parameter
   (URL-encoded into the `oauth_payload_token` JWT and echoed back
   on the redirect) — confirms the §7.3.1 step 5 encoding
   assumption.

6. **Exchange the code.** `POST https://auth.monday.com/oauth2/token`
   with `application/x-www-form-urlencoded` body
   `grant_type=authorization_code&code=<code>&client_id=<cli_client_id>&client_secret=<cli_client_secret>&redirect_uri=http://127.0.0.1:9876/callback`.
   **Probe-time-confirmed (2026-05-10):** `client_secret` is
   mandatory; the PKCE-only shape (`code_verifier` instead of
   `client_secret`) is rejected with
   `{"error":"invalid_request","error_description":"Missing client_secret param"}`.
   Authorisation code TTL is **10 minutes** per Monday's published
   docs ("the generated authorization code. Valid for 10 minutes");
   the exchange is the immediate next step after CSRF verification,
   no user interaction in between. Rejection-response shape pinned
   to RFC 6749 standard:
   `{"error": "<code>", "error_description": "<text>"}` with status
   400, `application/json; charset=utf-8`. The `error` field maps to
   `oauth_failed.details.monday_code`; `error_description` maps to
   `oauth_failed.details.monday_description`. **Probe-time
   deferred (resolved at Part 1):** the *success* response body
   shape (200 OK) couldn't be empirically captured without a
   registered OAuth app + a real user-issued code at probe time;
   the design pinned the docs-documented shape
   `{access_token, token_type, scope}` (verbatim from Monday Apps
   OAuth docs) — `expires_in` intentionally absent per Monday's
   "tokens do not expire" wording. Part 1 (`a4cb5b0`) ships
   `RawTokenResponse` matching that shape via a `.loose()` zod
   schema (forward-compatible — a Monday-side extension field
   would parse cleanly without a `schema_version` bump); the
   normalized `TokenResponse` (camelCase) drops `expires_in`
   intentionally and the `expires_at` slot in the credentials
   cache (§7.4.1) stays pinned `null` for v0.3.

7. **Write credentials.** On a successful exchange, write the access
   token + obtained-at timestamp + scopes to
   `~/.monday-cli/credentials` per §7.4. The write is **silent
   overwrite** for the named profile — re-running
   `monday auth login --profile work` after a token rotation refreshes
   the entry without a confirmation gate; OAuth-token refresh is a
   normal lifecycle event, not a destructive operation per §3.1's
   confirmation rule.

8. **Emit the envelope.** Success envelope per §6.1 with
   `data: { profile: "<name>", account_id: "<id>", scopes: [...] }`.
   The token itself is **never** in `data` (per §7.4 redaction
   discipline + .claude/rules/security.md). The success envelope's
   `account_id` requires one post-exchange `account.id` query so the
   envelope reports *which* Monday account the OAuth flow authorised
   against — agents drive this back into a `--profile` selection
   without re-fetching.

#### 7.3.2 Idempotency

`monday auth login` is **idempotent at the credentials-write layer**
— re-running with the same `--profile` overwrites the entry. The
*OAuth flow itself* is non-idempotent (the `code` is single-use per
OAuth's spec), but agents key off the credentials file's post-write
state, not the flow's mid-execution state, so the contract-level
shape is "running this verb leaves the named profile authenticated."

`monday auth logout` is fully idempotent: deletes the named profile
entry; no-op + `ok: true` on a missing entry.

Both verbs are explicitly **not** under §3.1's destructive-confirmation
gate — credential rotation is a routine agent operation, not a
data-mutation that requires `--yes`.

#### 7.3.3 Error surface

Per the M20 Decision 4.1/4.2 reasoning ("agents already branch on the
verb invoked, plus discriminant in details"), the OAuth flow
introduces **one new error code** rather than a per-failure-mode
constellation:

- **`oauth_failed`** (registry row added at M21 pre-flight contract
  diff `5c07840` alongside the type-level widening; brings registry
  from 28 → 29). Umbrella for OAuth-flow-specific failures,
  discriminated by `details.reason`:

  | `details.reason` | When | `retryable` | Extra `details` |
  |---|---|---|---|
  | `csrf_mismatch` | Redirect's `state` ≠ per-attempt `state` (length-mismatched buffers also route here, NOT to `internal_error`) | `false` (security signal — never auto-retry) | — |
  | `user_denied` | Monday's redirect returns `?error=access_denied&state=…` | `false` | — |
  | `authorization_failed` | Monday's redirect returns `?error=<other>&state=…` (e.g., `invalid_scope`, `unauthorized_client`, `server_error`, `temporary_unavailable` per Monday's documented authorize-endpoint error codes) | `false` (operator fixes the OAuth-app config or retries on `temporary_unavailable`) | `monday_code` (Monday's `error` field from the redirect query), `monday_description` (Monday's `error_description` if present) |
  | `code_exchange_failed` | `/oauth2/token` returns 4xx (probe-confirmed RFC 6749 standard shape: `{"error", "error_description"}` body) | `false` (caller-driven retry of full flow only) | `monday_code` (Monday's `error` field), `monday_description` (Monday's `error_description` field) |
  | `timeout` | Listener's 5-min timer fired before redirect arrived | `true` (M21 implementation overrides the umbrella default — see footnote below) | — |
  | `port_in_use` | Listener can't bind the fixed port (typically `9876` per §7.3.1 step 2) — usually a concurrent `monday auth login` invocation OR an unrelated process holding the port | `false` (caller resolves the conflict before retry) | `port` (the port that failed to bind) |
  | `browser_unavailable` | No opener AND the fallback URL print also failed (rare; e.g., closed stderr) | `false` | `url` (the consent URL, so an agent can paste it back) |

The `error.retryable` field on the envelope reflects the per-reason
column above, not the umbrella `oauth_failed` default. The
`CODE_RETRYABLE_DEFAULT.oauth_failed = false` floor is what an agent
sees if it consumes a hand-constructed `oauth_failed` without a
specific reason — the M21 implementation overrides this at every
throw site. Specifically: `reason: "timeout"` constructs the
`ApiError` with `retryable: true` (mirrors the M2-era `cache_error`
override-at-throw-site precedent for the same pattern); every other
reason inherits the `false` default. Agents can still discriminate
on `details.reason` if they need finer-grained per-reason logic
than the boolean affords.

Reused codes (NOT new):

- **`network_error`** — DNS / TCP / TLS failures reaching
  `auth.monday.com`. Same retryable semantics as everywhere.
- **`timeout`** — HTTP-level request timeout on the `/oauth2/token`
  POST (distinct from `oauth_failed.reason: "timeout"` which is the
  listener-wait timeout).
- **`config_error`** — credentials cache write fails (disk full,
  permissions, etc.) AFTER a successful exchange. The exchange itself
  succeeded; the persistence didn't. Agents see exit 3.
- **`internal_error`** — CLI-side bugs (CSRF-state generation failure,
  JSON parse failure on Monday's response shape, etc.).

#### 7.3.4 Mock OAuth helper for tests

The `__test_oauth_helper` env var (lowercase with leading
double-underscore — the leading `_` discourages production use; tests
set it explicitly) opts the CLI into a **fixture-driven** flow that
bypasses the browser-open + listener steps:

- When set, its value is the path to a JSON fixture file containing
  `{ "code": "<fixture-code>", "force_csrf_mismatch"?: true, "force_user_denied"?: true, "force_authorization_failed"?: { "error": string; "error_description"?: string }, "force_listener_timeout"?: true }`.
  The fixture **does NOT** carry `state` — it's randomly generated
  per invocation (32-byte `state`), so tests cannot pre-know it; the
  helper simulates the redirect arriving with the CLI's *own*
  generated `state` echoed back, so CSRF verification passes by
  default. `redirect_uri` is the fixed `http://127.0.0.1:9876/callback`
  per §7.3.1 step 2 — known to both CLI and test, no per-invocation
  randomness.
- **Default fixture path** (no `force_*` keys set): the CLI generates
  `state` per §7.3.1 step 1, binds the listener per step 2, then
  short-circuits steps 3–4 (browser-open + listener wait) by directly
  invoking the same internal handler the real listener would have
  invoked, with the synthetic redirect carrying the fixture's `code`
  + the CLI's generated `state`. The flow then proceeds to CSRF
  verification (step 5, passes) + token exchange (step 6, hits the
  network boundary).
- **`force_csrf_mismatch: true`** — the helper substitutes a different
  random `state` for the simulated redirect, exercising the
  `oauth_failed.reason: "csrf_mismatch"` path. No token exchange
  follows.
- **`force_user_denied: true`** — the helper simulates a
  `?error=access_denied&state=<echoed-state>` redirect, exercising
  the `oauth_failed.reason: "user_denied"` path.
- **`force_authorization_failed: { error: <code>, error_description?: <text> }`**
  — the helper simulates a non-`access_denied` redirect error
  (e.g., `?error=invalid_scope&error_description=...&state=<echoed-state>`),
  exercising the `oauth_failed.reason: "authorization_failed"`
  path. The fixture's `error` field maps to
  `details.monday_code`; `error_description` maps to
  `details.monday_description`.
- **`force_listener_timeout: true`** — the helper does not simulate
  any redirect; the 5-min listener timer fires (test infra fast-
  forwards via `vi.useFakeTimers()` rather than waiting), exercising
  the `oauth_failed.reason: "timeout"` path.
- The token exchange itself still goes through the network boundary
  (so cassette-driven integration tests cover it via the same
  `FixtureTransport` discipline as every other API call;
  `oauth_failed.reason: "code_exchange_failed"` is exercised by a
  cassette returning the appropriate 4xx response, NOT by a
  `force_*` fixture key).
- The env var's *value* (the fixture path) is never echoed to the
  output envelope, never logged at any verbosity level, and is
  scrubbed from `--debug` output the same way `MONDAY_API_TOKEN` is.

Production users never set this env var; documenting it in §7.3 makes
its existence explicit + auditable rather than leaving it as an
undocumented test-only escape hatch.

#### 7.3.5 OAuth-only at v0.3 — no paste-in fallback

`monday auth login` is OAuth-only at v0.3. There is **no paste-in
fallback verb** (e.g., `monday auth login --token <value>`); the
existing `MONDAY_API_TOKEN` env var path (§7.1) is the no-OAuth route
for users who already have a token in another credential manager.
Adding paste-in to `auth login` would conflict with cli.md's "CLI
flags must NOT accept the token" rule (tokens-on-argv leak through
`ps` / shell history / crash dumps).

If the OAuth flow proves out-of-budget at M21 implementation, paste-in
becomes a **separate cli-design §7.3 amendment PR with Codex review
BEFORE M21's first feat commit** — never a quiet implementation
choice. v0.3-plan §3 M21 already pins this commitment.

### 7.4 Credentials cache

Closes v0.3-plan §8 Decision 3 (auth caching format). Stored as
plain JSON at `~/.monday-cli/credentials` with mode `0600`; not a
binary or `gh`/`aws`-style helper format.

#### 7.4.1 File format

```json
{
  "schema_version": "1",
  "profiles": {
    "work": {
      "access_token": "<opaque-monday-token>",
      "obtained_at": "2026-05-10T12:00:00Z",
      "expires_at": null,
      "scopes": ["boards:read", "boards:write", "users:read"],
      "account_id": "12345678"
    },
    "personal": {
      "access_token": "<opaque-monday-token>",
      "obtained_at": "2026-05-09T08:30:00Z",
      "expires_at": null,
      "scopes": ["boards:read"],
      "account_id": "98765432"
    }
  }
}
```

Field semantics:

- **`schema_version`** — pinned at `"1"` for v0.3. Reserved for a
  future migration if the per-profile shape grows incompatibly.
  Mirrors the `schema/version.json` cache discipline (§8).
- **`profiles`** — keyed by the profile name from
  `~/.monday-cli/config.toml`. The credentials file is the
  authoritative store for tokens; the config file references profiles
  by name + (optionally) per-profile env-var name (`api_token_env`)
  for users who prefer env-only credentials.
- **`profiles.<name>.access_token`** — Monday's opaque OAuth token
  (no documented internal structure; the CLI treats it as bytes).
- **`profiles.<name>.obtained_at`** — ISO-8601 UTC timestamp of the
  successful token exchange. Surfaced via `monday status` (§13 v0.3
  diagnostics cluster) so agents can self-check token freshness
  without parsing the credentials file.
- **`profiles.<name>.expires_at`** — `null` for v0.3.
  **Probe-time-confirmed (2026-05-10):** Monday's published OAuth
  docs explicitly state "tokens do not expire and are valid until
  the user uninstalls your app"; the documented success-response
  body shape carries no `expires_in` field. The slot is preserved
  as a `string | null` union so a future refresh-token flow
  doesn't bump `schema_version`. M21 implementation reaffirms
  the absence by inspecting the live `/oauth2/token` response (a
  Monday-specific extension field would only widen `TokenResponse`
  forward-compatibly).
- **`profiles.<name>.scopes`** — the granted scopes from
  `/oauth2/token`'s response. Agents can self-audit ("does this
  profile have `boards:write`?") without re-running the OAuth flow.
- **`profiles.<name>.account_id`** — pinned at write-time from the
  post-exchange `account { id }` query (§7.3.1 step 8). Decouples
  profile-name (user-chosen) from account-identity (Monday-assigned)
  so a `monday auth status` future verb can show "*profile `work`
  authenticates against account 12345678*" without an extra round-
  trip. **Probe-time-confirmed (2026-05-10):** the GraphQL
  `account.id` field returns a string-typed numeric ID
  (e.g., `"34900083"`) — not a JS `number`. The schema slot ships
  as `z.string().min(1)` to match.

**Per-profile token source order.** §7.2 pins the *profile selection*
order (`--profile` flag > `MONDAY_PROFILE` env > `default_profile` in
config > implicit v1 mode if no config file). Once a profile is
selected, the *token source* order within that profile is:

1. **Credentials cache entry** for the named profile in
   `~/.monday-cli/credentials`, if present + the read-time
   `fs.fstat`-against-open-descriptor permission check passes
   (§7.4.2).
2. **`api_token_env`** reference in the profile's `config.toml` entry,
   if the named env var is present + populated.
3. Otherwise → `config_error` with
   `details.hint: "no token for profile <name> — run \`monday auth login --profile <name>\` or set <api_token_env>"`.

The credentials cache wins over `api_token_env` because
`monday auth login` is the explicit user action that wrote the cache
entry; honouring it without requiring a `config.toml` edit is the
agent-ergonomic default. Users who prefer env-only credentials run
`monday auth logout --profile <name>` to delete the cache entry,
which restores the `api_token_env` fallback path. The reverse design
(env wins over cache) would surprise users who ran
`monday auth login` and saw their old `api_token_env` value still in
effect.

#### 7.4.2 Disk discipline

- **Path:** `~/.monday-cli/credentials` (the parent directory is
  created via `mkdir({ recursive: true, mode: 0o700 })` followed by
  an explicit `chmod(0o700)` if absent — `mkdir`'s `mode` is
  advisory under umask on some platforms; mirrors the
  `src/api/cache.ts` directory-creation pattern).
- **Mode + atomic write:** every write goes through the same
  atomic-replace pattern as `src/api/cache.ts`'s `writeJsonFile`:
  `writeFile(tmpPath, payload, { mode: 0o600 })` →
  `chmod(tmpPath, 0o600)` (re-applied explicitly because
  `writeFile`'s `mode` is advisory under umask on some platforms)
  → `rename(tmpPath, finalPath)` (atomic on the same filesystem).
  The final path is **never** opened or truncated directly; rename
  is the only way bytes appear at the final path. A crash mid-write
  leaves the on-disk credentials file in its prior state.
- **Read-time verification:** open the file with `fs.open`, then
  `fs.fstat(fd)` against the open descriptor (TOCTOU-safe — the
  stat is locked to the file we'll read, not racing a path-based
  check); if `mode & 0o077 !== 0` (group- or world-readable), the
  CLI refuses to use the file and surfaces `config_error` with
  `details.path: "~/.monday-cli/credentials"` +
  `details.hint: "permissions must be 0600 — run \`chmod 600 ~/.monday-cli/credentials\`"`.
  Mirrors the `.claude/rules/security.md` "File permissions" rule.
- **HOME-scoped, never repo-tracked.** The credentials file lives
  under the user's HOME, outside any project tree the CLI is
  invoked from — there is no path under which a normal `git add`
  or `git status` would surface it. Test fixtures that simulate
  the file (M21 leak-test discipline, §7.4.3) live in
  `tests/fixtures/` per project convention with synthetic
  canary tokens; the production credentials path is never
  shadowed into the repo.

#### 7.4.3 Redaction discipline

The credentials cache content **never** appears in any CLI output
path. Specifically:

- **`access_token`** values are scrubbed from `--debug` output, error
  envelopes (`error.details.*`, `error.message`, `error.cause.*`),
  `monday cache list` output, `monday config show` output, and any
  future diagnostic verb. Two scrubbing layers per
  `.claude/rules/security.md` "Redaction in output":
  1. Key-based filter — `access_token` joins the existing
     sensitive-key list (`apiToken`, `Authorization`,
     `MONDAY_API_TOKEN`, generic `(token|secret|password|api[-_]?key)`
     regex).
  2. Value-scanning filter — when the CLI has loaded credentials
     from the file at startup, every loaded `access_token` value is
     added to the runtime's secret-bag passed to
     `redact()`, so any unkeyed string occurrence (e.g., a token
     accidentally appearing in `Error.message`) is replaced with
     `[REDACTED]`.
- **Test coverage:** the M21 leak-test surface mirrors M2's discipline
  — a fixture credentials file with a canary token (`tok-cred-leak-
  xxxx`); every emission path of every command run against that
  fixture asserts the canary is absent from every emitted byte.
- **`monday config show`** displays per-profile metadata
  (`obtained_at`, `scopes`, `account_id`) but NEVER the
  `access_token` value — the resolved-config output reports
  `access_token: "<set>"` / `"<unset>"`, never bytes.

#### 7.4.4 Threat model

Mode `0600` + single-user-CLI ownership is the v0.3 threat model
floor. The CLI is a single-user tool running on the user's own
machine with their own UID; the threat model does **not** cover:

- **Shared-account / multi-user-machine attackers.** A second user
  on the same machine with `root` or the same UID can read the file.
  Mitigation belongs to the OS, not the CLI.
- **Disk imaging / backup leaks.** Backup tools that snapshot HOME
  capture the credentials file. Users who care should exclude
  `~/.monday-cli/credentials` from their backup tool, the same way
  they exclude `~/.aws/credentials` or `~/.npmrc`.
- **OS keyring integration (macOS Keychain, Windows Credential
  Manager, libsecret).** Deferred to v0.4+ if a multi-user / shared-
  machine threat model emerges. The keyring-vs-file decision is
  cleanly orthogonal to v0.3's contract surface — a future
  `keyring`-backed implementation reads + writes the same
  per-profile shape via different storage primitives without
  bumping `schema_version`.
- **Process-memory dumps.** Tokens live in process memory during
  any CLI invocation that calls a Monday API. Memory-dump attackers
  are out of scope for a CLI tool.

The threat model is deliberately documented so future Codex passes /
security reviews can challenge it explicitly; "we considered and
deferred OS-keyring" is a stronger contract than silence.

## 8. Caching

Some lookups are expensive and rarely change:
- **Board metadata** — columns, groups, status labels, dropdown options.
  Needed for every item create/update to translate friendly values.
- **User directory** — id ↔ email/name. Needed for `--set
  owner=alice@x.com`.
- **Account-tag directory** — id ↔ name (M19+). Needed for `--set
  tags=launch,priority` to translate tag names to numeric IDs
  before constructing the wire payload.

Cache lives at `$XDG_CACHE_HOME/monday-cli/` (falling back to
`~/.cache/monday-cli/`):

```
boards/<board-id>.json     # full board describe response
users/index.json           # email → id map
account_tags/index.json    # tag name → id map (M19+)
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

**Eager invalidation on board-structure mutations** (M16 / M17;
v0.2-plan §8 decision 6). The TTL + auto-refresh paths above are
backstops, not the primary freshness mechanism. When **this
process** mutates a board's structure — column shape (M16
`board column-create` / `column-update` / `column-delete`),
group shape (M17 `board group-create` / `group-update` /
`group-archive` / `group-duplicate` / `group-delete`), or board
metadata (the M15 retrofit cluster — `board update` / `board
archive` / `board delete` post-success) — the CLI
**eagerly invalidates** the affected board's cache entry so
**subsequent reads in the same process** see live state without
having to wait for TTL eviction or having to dead-end into the
cache-miss-refresh path.

**Helper API.** `invalidateBoard(boardId, env?)` is exported from
`src/api/cache.ts`. Implementation is a thin wrapper over
`clearEntry(root, { kind: 'board', boardId })` (the precedent is
the existing `evictBoardMetadata` helper in
`src/api/board-metadata.ts`; M16 lifts the export to `cache.ts`
under the `invalidateBoard` name so the call sites read as
"invalidate" rather than "evict cache" — eviction is the
mechanism, invalidation is the contract). The helper is
idempotent — invalidating an already-absent entry is a no-op
(matches `clearEntry`'s missing-file semantics).

**Call-site contract.** Every command that mutates board
structure calls `invalidateBoard(boardId)` **once**, AFTER the
full wire-call sequence has settled (whole-call success OR
whole-call error) and AFTER any success envelope's `data`
projection has run, but BEFORE the function returns. Two
ordering invariants split by leg-count:

- **Single-leg verbs** (`column-create` / `column-delete`; M17
  `group-create` / `group-archive` / `group-duplicate` /
  `group-delete`). Invalidate AFTER the success envelope's
  `data` is fully constructed — never before the wire mutation,
  never between the wire mutation and `data` projection.
  Pre-mutation invalidation would race with concurrent in-
  process reads that hit the cache between invalidation and
  mutation; between-mutation-and-projection invalidation would
  force the projection to re-fetch even though the wire
  response is authoritative. Skip invalidation on the error
  path — a failed single-leg call didn't change board state.
- **Fan-out verbs** (`column-update` per-attribute; M15
  retrofit's `board update`; M17 `group-update` per-attribute).
  Issue all per-attribute wire calls first; AFTER the loop
  ends, invalidate IF at least one per-attribute call
  succeeded. On whole-call success this is
  the same trigger as the single-leg case (every leg
  succeeded); on whole-call error after partial application
  (call N+1 fails after call N succeeded), invalidation still
  fires because the cache must reflect the partially-applied
  server state. The check is "did the wire-state change?" —
  cleanly generalised to N-leg fan-out by gating on the
  loop's high-water-mark counter rather than per-call timing.
  When zero legs succeeded (the very first call failed before
  any state changed), invalidation is skipped — Monday's
  per-attribute mutations are not transactional, but a
  failed-first-call is server-state-unchanged just like a
  single-leg error.

In every case invalidation runs once, after `data` projection
(or error projection) completes, before the function returns —
so concurrent in-process readers see either the pre-mutation
or post-mutation cache state, never an in-flight intermediate.

**M15 retrofit cluster — three verbs, one contract.** M16
retrofits **`board update`**, **`board archive`**, and **`board
delete`** to call `invalidateBoard(boardId)` post-success.
Background and rationale per verb:

- **`board update`.** M15's pre-flight pinned the success-
  envelope final read as **force-live** (cache-bypass,
  `meta.source: "live"` on success) so the immediate envelope's
  `data` reflects post-update state, not stale cache. Force-
  live protects the immediate envelope; it does **not**
  invalidate the cache entry, so subsequent reads in the same
  process would hit the now-stale cache until TTL eviction or
  auto-refresh kicked in. The retrofit fires invalidation
  alongside the force-live read.
- **`board archive`.** The mutation flips the board's `state`
  from `active` to `archived` at the wire; the cached
  `boardMetadataSchema.state` field would lag until TTL
  eviction. Without retrofit, a same-process `board describe`
  / `board list` reading after the archive returns
  `state: "active"` until the cache expires.
- **`board delete`.** The mutation removes the board entirely;
  the cache entry would otherwise serve a phantom board until
  TTL eviction (a same-process `board describe` would surface
  stale metadata rather than the expected `not_found`). The
  retrofit's invalidation deletes the cache file, so the next
  read cleanly cache-misses to the live `not_found`.

The other M15 verbs are excluded with explicit reasoning:

- **`board create`.** No pre-existing cache entry to invalidate
  — the new board's first `board describe` write seeds the
  cache fresh.
- **`board duplicate`.** The source board's metadata is not
  mutated (cache stays valid); the new board's cache doesn't
  exist yet (same as `board create`).
- **`board add-users`.** The cached `boardMetadataSchema`
  currently doesn't include `subscribers` — only `permissions`
  (a coarse string) and `updated_at` shift, neither of which
  agents key reads off. Marginal cache pressure deferred to a
  follow-up if subscribers join the cached projection in v0.3.

The two layers (force-live final read + eager invalidation)
serve different freshness windows for `board update`:

- **Force-live final read** — protects the immediate success
  envelope's `data`. Required because the wire shape is
  per-attribute fan-out and the envelope's projection cannot
  source from a single wire response.
- **Eager invalidation** — protects subsequent reads. Required
  because in-process callers don't pass `--no-cache` between
  commands; without invalidation the next `board describe` /
  `--set` against the same board would hit a cache entry
  written before the update committed.

`board archive` and `board delete` are simpler — single-leg wire
calls don't need force-live (the wire response IS authoritative
when present) but DO need invalidation to protect subsequent
reads.

The same retrofit applies to M14 if `workspaces` joins the cache
layer in v0.3 (no current cache pressure there — `workspaces(ids:)`
isn't cached in v0.2).

**Backstop layer.** The pre-existing TTL eviction +
cache-miss-refresh paths stay in place. Eager invalidation is
the **first** line of defence for in-process freshness; the TTL
+ refresh paths cover the cases eager invalidation misses:

- A future mutation verb that forgets to call
  `invalidateBoard` (the contract is documented per-verb in
  §4.3 + per-shape in §6.4; integration tests assert no
  refresh fires when invalidation fired correctly — the
  refresh path is the backstop, not the path under test).
- Out-of-band board structure changes — Monday's UI editing
  the board, another integration's wire calls, a different
  CLI process's mutation (see "cross-process" below).
- Server-side state changes the CLI doesn't model — Monday-
  driven retention sweeps, admin actions, etc.

The `meta.source: "mixed"` + `warnings: [{ code:
"stale_cache_refreshed" }]` surface is **only** the backstop
signal — it fires when the cache-miss-refresh path saved the
caller from a stale-cache dead-end. When eager invalidation
worked correctly, the next read sees a clean cache miss → live
fetch → write, so `meta.source: "live"` and no
`stale_cache_refreshed` warning appears. The two paths are
distinguishable from the agent's surface: invalidation success
looks like a normal cache miss (`source: "live"`, no warning);
backstop firing looks like a refresh-recovery (`source: "mixed"`,
`stale_cache_refreshed` warning). Integration tests assert the
"clean miss" shape on the eager-invalidation happy path so a
silent regression to "backstop saved us" doesn't pass for the
wrong reason.

**Cross-process coordination — explicitly deferred to v0.3.**
The on-disk cache file is **shared** between concurrent CLI
processes (same `$XDG_CACHE_HOME/monday-cli/boards/<bid>.json`
path); `invalidateBoard` deletes the shared file via
`clearEntry`'s `unlink`, so process A's invalidation **does**
remove process B's cache entry. The "process-local" framing is
about **coordination**, not about cache-file ownership: there
is **no inter-process locking** around the read / write /
invalidate boundaries, so concurrent processes race in a few
documented ways:

- **Stale-after-unlink reads.** Process B's `loadBoardMetadata`
  may have stat'd or opened the cache file before process A's
  `unlink`, and read the pre-invalidation bytes from an open
  handle even after process A's mutation committed. The
  read-handle's contents are whatever was on disk at open
  time, not at read time.
- **Stale-write-after-invalidate.** Process B may have started
  a cache-miss live read BEFORE process A's mutation and
  invalidation, then `writeEntry` (atomic `tmp + rename`) the
  pre-mutation snapshot AFTER process A's `unlink`. Process
  B's snapshot lands as the post-invalidation cache entry —
  semantically stale even though it was just written.
- **Concurrent-mutation reorder.** Two processes both mutating
  the same board's structure don't see each other's
  invalidations as ordered events; whichever process writes
  the cache last wins, regardless of wire-call ordering.

The race window is widest between `clearEntry`'s `unlink` and
the next live-fetch's `writeEntry` rename — typically
sub-second, but unbounded under contention. Without a shared
lock or version-stamp protocol, the CLI cannot guarantee
post-mutation freshness across processes.

Two reasons this is deferred rather than half-shipped:

- The right primitive is per-entry version stamping with
  inter-process coordination (advisory file-locking,
  mtime-driven invalidation, or a shared inotify watcher) —
  non-trivial and v0.4-shaped at minimum. v0.3 is the
  earliest reasonable target.
- Agent workflows the v0.2 surface targets are mostly
  single-process (one `monday` invocation drives the whole
  workflow); the multi-process case is a rare-enough
  ergonomic concern to wait until the contract surface is
  more settled.

Documented limitation, not a bug — agents writing parallel
scripts that share a Monday workspace should pass `--no-cache`
on read paths that are sensitive to recent mutations from
sibling processes (the `--no-cache` bypass skips both the
on-disk read and the post-fetch write, sidestepping every race
window above at the cost of one extra Monday round-trip per
read).

**Out of scope — Monday's server-side cache.** Eager
invalidation operates on the CLI's on-disk cache. Monday's
GraphQL API has its own internal caching layer beyond the
CLI's reach (per-account complexity budget, materialised view
freshness windows for board metadata, etc.). When a wire
mutation succeeds but a subsequent live read returns stale
state, the cause is server-side eventual consistency, not the
CLI's cache. The CLI's `meta.source: "live"` is truthful — the
read fired against Monday — but Monday's internal freshness is
not the CLI's contract.

## 9. Idempotency, dry-run, and concurrency

### 9.1 Idempotency

| Operation | Idempotent? | Notes |
|-----------|-------------|-------|
| `change_column_value(s)` | Yes | Same input → same state |
| `change_column_title`, `change_column_metadata` | Yes | Same input leaves same column metadata; the per-verb prose for `board column-update` marks `idempotent: yes` per this row |
| `update_group` | Yes | Same input leaves same group metadata; the per-verb prose for `board group-update` marks `idempotent: yes` per this row (M17) |
| `archive_item`, `archive_board`, `archive_group` | Yes | Re-archiving is a no-op (M17 adds `archive_group` to the row) |
| `move_item_to_group` | Yes | If already in target group, no-op |
| `move_item_to_board` | **No** | Re-running on an item already on the target board is undefined SDK behaviour; the `monday item move` verb's `idempotent: false` is the conservative bound across same-board (idempotent) + cross-board (not) paths |
| `create_item`, `create_board`, `create_column`, `create_group` | **No** | Use `upsert` variants |
| `item upsert` | Sequential-retry yes; concurrent no | Re-running with the same args from the same agent is safe (second call branches to `update_item`); two concurrent agents observing zero matches both branch to `create_item`. Recovery: the next call surfaces the duplicate as `ambiguous_match`. v0.4 candidate: lock-resource semantics (§9.3). |
| `delete_*` (wire) | Yes (after first call) | Wire-level: re-deleting converges (the thing is already gone). CLI-level the per-verb prose (`item delete` / `update delete` / `workspace delete` / `board delete`) marks `idempotent: false` because re-running surfaces a different envelope (`not_found`) instead of success — same end state, different envelope. Use the per-verb prose for retry semantics; this row is the wire-state classification. |
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

### 9.3 Concurrency (v0.4-M30)

In v0.1–v0.3 the CLI was single-process and made **one outbound
request at a time** per command. Sequential is correct under
Monday's complexity budget; a hot bulk loop with a tight
`--where` filter saturates a single connection just fine and avoids
hitting the per-account concurrency cap mid-walk.

**v0.4-M30 adds `--concurrency <n>`** for bounded parallel per-item
dispatch on the partial-success bulk path (`monday item update
--where ... --continue-on-error`). Range `[1, 32]`; default `1`
(sequential — byte-equivalent to the v0.3-M25 path). The flag
requires `--continue-on-error` (rejected on the fail-fast bulk
path; parallel fail-fast has no defined "abort N in-flight"
semantic and is explicitly deferred). Single-item invocations
reject `--concurrency` at `validateInputShape` (before any
network call). Envelope shape
unchanged from M25 — same `data.results[]` per-item records,
same `data.summary.{matched,applied,failed}_count` slot.
Monday's `concurrency_exceeded` signal retries via the existing
retry layer (§2.5); persistent failure after retries lands
per-record in `data.results[]` like any other per-item failure.

Full contract surface lives at §6.4 "Bulk per-item partial-
success — Parallel dispatch". The pre-flight stub module
`src/api/parallel-dispatch.ts` carries the bounded async-pool
runtime body at M30 IMPL.

Other bulk verbs (`item clear --where`, M13 `update clear-all`,
M14 `workspace add-users` / `remove-users`, M15 `board
add-users`) stay sequential at v0.4-M30; later milestones extend
`--concurrency` to those surfaces if user demand surfaces.

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
  - Groups (id, title, color, position, archived, deleted).
  - `hierarchy_type` and `is_leaf` (multi-level boards; via raw
    GraphQL — see §2.8).
  - For each writable column type, an **example `--set` value** in
    the response so an agent reading `describe` once has everything
    it needs to write.
- `monday board doctor <bid>` — diagnostics. Surfaces:
  - Duplicate column titles (would cause `ambiguous_column` on
    title-based `--set`).
  - Columns of types not in the friendly-translator allowlist
    (not writable via `--set` in v0.1; v0.2 added the M8 firm row —
    `link`, `email`, `phone` — and `--set-raw` for everything
    else the API will write to via `change_column_value`. The
    tentative writer-expansion row — `tags`, `board_relation`,
    `dependency` — slipped to v0.3 at the v0.2.0 release; doctor's
    diagnostic message names v0.3 for those types).
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

### 11.5 Diagnostics — `monday status` + `monday usage`

The v0.3 diagnostics cluster lands at M22. Two read-shape verbs that
answer the two questions agents ask before bulk runs:

1. **`monday status`** — *"is everything I need to talk to Monday
   working?"* A short, deterministic probe matrix that short-circuits
   on the first network failure without touching account state.
2. **`monday usage`** — *"have I burned through my daily budget?"*
   The rolling daily Monday API **operation budget** remaining, so
   an agent can self-throttle before fanning out a bulk operation.

The cluster is paired because each alone is low-value; together they
form a coherent "is everything working?" surface (cli-design §13 v0.3
entry).

#### 11.5.1 `monday status` probe matrix

Per Decision 7 closure: **probe by default; `--no-probe` opts out**.
The default run executes seven probe steps in {@link src/api/probes.ts
STATUS_PROBE_ORDER} (DNS → TCP → TLS → auth → cache writability →
redaction self-test → env-var pickup). The four network probes
short-circuit on the first failure — once DNS fails, TCP / TLS / auth
all surface as `'fail'` with `reason: "upstream_failed"` rather than
re-running. The three local probes always run regardless of the
network-probe outcome.

`--no-probe` skips the four network probes, surfacing them as
`ProbeSkipped` entries with `reason: "no_probe_flag"`. The local
probes (cache / redaction / env-var) still run because they don't
touch account state and are the v0.3 value of an offline
configuration check.

**Per-probe error-code mapping (Decision 7 closure — no new
ERROR_CODE for M22).** Each probe failure maps to an existing §6.5
code via the verb-level error envelope (the envelope itself is
emitted on the FIRST hard failure; subsequent probes surface as
`ProbeFail` slots in the `probes` map but don't change the verb's
exit code):

| Probe                  | Failure reason          | Maps to       |
|------------------------|-------------------------|---------------|
| `dns`                  | `EAI_NONAME` etc.       | `network_error` |
| `tcp`                  | `ECONNREFUSED` / timeout | `network_error` |
| `tls`                  | `cert_invalid` / handshake | `network_error` |
| `auth`                 | 401 (probe-confirmed)   | `unauthorized` |
| `auth`                 | 5xx / network mid-flight | `network_error` |
| `cache_writability`    | dir absent / no `W_OK`  | `config_error` |
| `redaction_self_test`  | canary leaked           | `internal_error` |
| `env_var_pickup`       | (cannot fail; pure read) | n/a |

**Why no new `probe_failed` umbrella code.** Each probe's failure mode
is best described by the existing semantic-domain code. An umbrella
would widen the 29-code registry for marginal benefit — agents
branching on `error.code` get useful information today (a
`network_error` from `monday status` means "Monday is unreachable",
identical to the meaning anywhere else in the CLI).

**Empirical-probe finding pinned (2026-05-10, API `2026-01`).** The
401 envelope shape `monday status`'s auth probe maps against:
status `401`, content-type `application/json; charset=utf-8`,
body `{"errors":[{"message":"Not authenticated","extensions":
{"code":"NOT_AUTHENTICATED"}}]}`. Identical envelope for missing
`Authorization` and bad `Authorization`. `Bearer <token>` prefix
also works alongside bare `<token>`; the
`.claude/rules/security.md` rule against the prefix is
precautionary, not API-enforced.

#### 11.5.2 `monday status` envelope shape

```json
{
  "ok": true,
  "data": {
    "probes": {
      "dns":                 { "kind": "ok",   "probe": "dns",   "elapsed_ms": 12,  "details": { "address": "1.2.3.4", "family": 4 } },
      "tcp":                 { "kind": "ok",   "probe": "tcp",   "elapsed_ms": 24,  "details": { "host": "api.monday.com", "port": 443 } },
      "tls":                 { "kind": "ok",   "probe": "tls",   "elapsed_ms": 67,  "details": { "subject": "*.monday.com", "issuer": "...", "valid_to": "2027-..." } },
      "auth":                { "kind": "ok",   "probe": "auth",  "elapsed_ms": 89,  "details": { "me_id": "102927371", "api_version": "2026-01" } },
      "cache_writability":   { "kind": "ok",   "probe": "cache_writability",   "elapsed_ms": 3, "details": { "path": "/home/.../.monday-cli", "mode": "0700" } },
      "redaction_self_test": { "kind": "ok",   "probe": "redaction_self_test", "elapsed_ms": 1, "details": { "fixture_count": 6 } },
      "env_var_pickup":      { "kind": "ok",   "probe": "env_var_pickup",      "elapsed_ms": 0, "details": { "set": { "MONDAY_API_TOKEN": true, "MONDAY_PROFILE": false, "MONDAY_API_VERSION": false, "MONDAY_API_URL": false, "MONDAY_OUTPUT": false, "MONDAY_REQUEST_TIMEOUT_MS": false } } }
    },
    "overall": "ok",
    "api_version": "2026-01"
  },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

`overall` rules:
- `"ok"` — every non-skipped probe returned `'ok'`.
- `"degraded"` — the auth probe succeeded AND only **soft local
  probes** failed (for v0.3, soft = `cache_writability` +
  `env_var_pickup` — the CLI can still talk to Monday, but a
  local check turned up something worth surfacing). Verb exit
  code: 0 (still success); the failed probes' slots carry the
  detail.
- `"down"` — any of the following:
  - A network probe failed (`dns` / `tcp` / `tls` / `auth`).
  - `redaction_self_test` failed (NEVER degraded — a
    redaction-layer regression means the CLI may leak
    secrets, which is a hard halt regardless of network state).
  - Every network probe was skipped (via `--no-probe`) AND a
    local probe failed (the network skip already removes the
    only signal that could have placed the run in `'degraded'`).

  Verb exit code per the §11.5.1 mapping table: 2 (API error)
  for auth + redaction failures, 3 (config error) for
  cache-writability failures, 2 (network/api) for DNS/TCP/TLS
  failures.

**The `'overall' → exit code` rule.** `'down'` promotes the
verb to the §11.5.1 mapping table's error code; the envelope is
emitted on stderr (per §6.5 error envelope) and the success-
shape `probes` map IS NOT emitted on stdout (an agent reading
`monday status` already gets the per-probe detail under
`error.details.probes`). `'ok'` / `'degraded'` keep the
success envelope on stdout and the per-probe details under
`data.probes`.

**The probe `details.*` payload NEVER contains a token.** Env-var
values are reported as `{set: boolean}` only; auth probe surfaces
`me_id` (a numeric account user ID, not a token); redaction self
test reports only the fixture canary count.

#### 11.5.3 `monday usage` envelope shape

Surfaces Monday's daily **operation** budget (NOT complexity points).
The empirical probe at M22 pre-flight (2026-05-10, API `2026-01`)
confirmed Monday's GraphQL schema exposes the daily-budget surface
under `platform_api.daily_limit` + `platform_api.daily_analytics`,
NOT `account.complexity` (which doesn't exist on the `Account`
type — the pre-M22 wording was loose).

```json
{
  "ok": true,
  "data": {
    "daily_limit": { "base": 200, "total": 200 },
    "usage_today": 17,
    "usage_remaining_today": 183,
    "last_updated": "2026-05-10T22:01:26.377Z"
  },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

Field semantics:
- **`daily_limit.base`** — the plan's baseline daily allotment
  (200 ops for free tier; higher for paid tiers).
- **`daily_limit.total`** — `base` + any account-specific upgrades.
  v0.3 surfaces both verbatim so agents on a paid tier see the
  overage offset; v0.4 may collapse if Monday deprecates the
  distinction.
- **`usage_today`** — sum of `platform_api.daily_analytics.by_day
  [].usage` where `day` matches today's date (timezone semantics
  confirmed against an account with live activity at M22
  implementation — pre-flight probe captured an empty list).
- **`usage_remaining_today`** — derived `max(0, total -
  usage_today)`. Clamped at zero because Monday's reported `usage`
  is best-effort and may briefly exceed `total` on a near-cap
  account (the limit gate enforces server-side at request time,
  not per-day-boundary).
- **`last_updated`** — Monday's `daily_analytics.last_updated`
  field (an `ISO8601DateTime` scalar). Lets agents detect stale
  analytics data without polling.

**Additive-only per Decision 8 closure.** v0.4 may extend with
per-minute complexity headroom + concurrency-cap headroom:

```json5
{
  "daily_limit": { "base": 200, "total": 200 },
  "usage_today": 17,
  "usage_remaining_today": 183,
  "last_updated": "...",
  // v0.4 additive extensions:
  "per_minute_complexity": { "remaining": 9998400, "reset_in_seconds": 47 },
  "concurrency": { "cap": 10, "in_flight": 2 }
}
```

The v0.3 shape is the floor; v0.4 amendments are purely additive.
Removing or renaming any v0.3 field is the SemVer-major boundary.

**Why not fold per-minute complexity into v0.3.** v0.1's
`account complexity` already surfaces it (`complexity { before
after query reset_in_x_seconds }`). The v0.3 `monday usage` verb
intentionally focuses on the daily-operations surface — the
distinct quota system Monday tracks. Combining both surfaces in
one envelope is a v0.4 extension that requires the
`--concurrency` flag to also land (per cli-design §13 v0.4
entry).

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

### v0.2 (mutating core — "agents can drive a backlog") — shipped

- **Writer expansion** — `--set-raw <col>=<json>` escape hatch
  (deferred from v0.1) on `item set` / `item update` / bulk
  `item update --where`, plus friendly-type expansion for
  the M8 firm row: `link`, `email`, `phone`. v0.1's
  `unsupported_column_type` `deferred_to: "v0.2"` resolved for
  the firm row (now writable through the friendly translator)
  and **slipped to `"v0.3"`** for the tentative row (`tags`,
  `board_relation`, `dependency` — design clearance didn't
  converge in v0.2's window; v0.3 picks them up). The
  `--set-raw` escape hatch accepts the tentative row today
  with the documented Monday wire shape.
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

- `monday item time-track start/stop` (M20, **documentation-only at
  v0.3**). Verb-shaped column-type extension per §5.2 carve-out 2.
  Empirical probe (2026-05-10, against API version `2026-01`)
  confirmed Monday's public API does not currently support writing
  to `time_tracking` columns: `change_simple_column_value` rejects
  with `CorrectedValueException`; `change_column_value` rejects
  with `InvalidColumnTypeException`; the mutation root has zero
  time-tracking-related mutations. The verbs are registered for
  forward-compatibility — agent scripts targeting `monday item
  time-track start/stop` are stable across the eventual swap when
  Monday ships API support — and reject every invocation today
  with `usage_error` carrying the empirical-probe context as the
  hint
- `dev sprint/epic/release/task` workflow shortcuts + `dev discover/
  configure/doctor` setup-and-diagnostic verbs (v0.3-M26). The
  `dev` namespace is the workflow-namespace three-level carve-out
  (§5.2 carve-out 1; §2.7 Monday Dev as convention, not API; §5.9
  mechanics). 13 verbs ship at M26: 3 setup verbs at `dev <verb>`
  shape (`dev discover [--apply]` / `dev configure --tasks-board
  <bid> [...]` / `dev doctor`) + 10 workflow verbs at three-level
  depth (`dev sprint current/list/items`, `dev epic list/items`,
  `dev release list`, `dev task list/start/done/block`). Every
  workflow verb translates to standard board / item CRUD against
  per-profile-configured board IDs in `[profiles.<name>.dev]` —
  no new Monday GraphQL mutations introduced. **M26 pre-flight
  decisions closed inline (`1620220`):** Decision 1
  (discover heuristic — name-based match against the stock
  English Monday Dev template board names: `Tasks` / `Sprints` /
  `Epics` / `Releases` / `Bugs`; localised-workspace alias
  support deferred to v0.4+); Decision 2 (`dev doctor` check-
  name vocabulary — 10 stable check names post-round-1 Codex
  fix-ups (P1-1 + P2-2) per
  `src/api/dev-conventions.ts:DEV_DOCTOR_CHECK_NAMES`; per-check
  `details` shape is per-check additive); Decision 3 (three-
  level naming reaffirmation against §5.2 carve-out 1 — already
  in force per Decision 4 closure pre-M20 at `1e81b2f`).
  ERROR_CODES registry unchanged at 29 — Decision 1 closure
  routes through existing `dev_not_configured` +
  `dev_board_misconfigured` codes already pre-registered in
  `src/utils/errors.ts` per §5.9
- `item search` cross-board (omit `--board`) — "find my open tasks
  anywhere I have access" without the agent iterating boards.
  Interacts with v0.3 `board favorites` and workspace scoping
  (`--workspace <wid>`). **Decision 5 closure (M23 pre-flight):**
  the per-call cap pinned at `--max-boards 25` default + hard cap
  100; above-cap surfaces `usage_error` with hint pointing the
  agent at `--workspace` / `--favorites` to narrow. **Empirical
  probe (2026-05-11, API `2026-01`, `scripts/probe/m23-cross-board.ts`
  + `scripts/probe/m23-cross-board-search-2.ts`):** Monday charges
  ~25–30 complexity points per board against a ~999_950 per-call
  budget — complexity is NOT the constraint (1M / 30 ≈ 33,000 boards
  would fit budget-wise). **The real constraint is wall-clock
  latency** — cross-board `boards(ids: [N]) { items_page(...) }`
  takes ~0.5–1.5s per call at N=2 against this account; scaling
  roughly linearly puts N=25 at ~12–18s (comfortable under the 30s
  `MONDAY_REQUEST_TIMEOUT_MS` default) and N=60+ at the timeout
  ceiling. The 25/100 cap is calibrated for this latency envelope,
  not the complexity budget. Additional load-bearing probe
  findings pinned for the M23 contract diff (with Codex
  round-1 P1-2 resolution amending the cursor shape):
  - **v0.3 cross-board search is single-call-only** (Codex
    round-1 P1-2 resolution; was originally pinned as a
    "per-board cursor walker maintains N cursors" shape but
    cross-board pagination is genuinely thorny: per-board
    cursors expire at 60min per §5.6, and an aggregate
    `--limit` mid-walk yields per-board state that doesn't
    compose into a single resumable token without an opaque-
    token scheme). The walker fans out across N boards in
    ONE GraphQL call and returns each board's first page.
    Boards with more items left OR an aggregate `--limit`
    short-circuit surface a `cross_board_truncated` warning
    with per-board `state` breakdown (`exhausted` /
    `has_more` / `not_started`) — no resumable cross-board
    cursor at v0.3. v0.4 may add an opaque-token resumable
    cursor envelope-additively (`meta.next_cursor` per §6.3
    stays compatible). Agents needing pagination today
    narrow with `--workspace` / `--favorites` or use the
    v0.1 `--board <bid>` single-board path (which has its
    own resumable cursor per §5.6).
  - **Inaccessible board IDs silently omitted.** `boards(ids:
    [<bad-id>])` returns `{"boards":[]}` (empty array, not null,
    not error). The walker MUST detect
    `response.boards.length < input_ids.length` and surface an
    `inaccessible_boards` warning ("X of N requested boards
    were inaccessible or do not exist") rather than silently
    delivering partial results.
  - **Per-board column resolution required for `--where`.** The
    `items_page(query_params: { rules })` shape uses each
    board's own column IDs; passing a column token (e.g.
    `status`) that doesn't resolve on ONE board errors the
    WHOLE cross-board query with `"Column not found"`. The
    cross-board walker MUST resolve column tokens per-board
    independently, build per-board `query_params`, and skip
    boards where the requested column doesn't resolve (with a
    `column_not_found_on_board` warning), rather than failing
    the entire fan-out.
  - **Order preservation.** Monday returns boards in input-ID
    order; the walker preserves this for stable agent diffs.
- `item history <iid>` — per-item activity log (status changes,
  column edits, assignments, comments interleaved chronologically).
  Introduces a new §6 envelope shape (event objects with
  `created_at`, `actor_id`, `kind`, `before` / `after`); distinct
  from the org-wide audit feed listed as a non-goal candidate in
  §13.5. **Decision 2 closure (M24 pre-flight; empirical probe
  2026-05-11, `a1f3025`; 19 activity_logs rows captured on a
  production board over 30 days; scripts/probe/m24-history-kinds.ts,
  local-only per the probe-script gitignore convention).** Six
  load-bearing findings reshape the M24 contract surface:
  - **Schema field name is `event`, NOT `kind`.** Monday's
    `ActivityLogType` exposes 7 NON_NULL String fields:
    `account_id`, `created_at`, `data`, `entity`, `event`, `id`,
    `user_id`. The CLI agent-facing discriminator stays `kind`
    (domain-neutral) but maps 1:1 from the wire's `event` slot
    inside the projector. Pre-flight pins the zod discriminated
    union over the observed event taxonomy.
  - **Observed item-scoped event taxonomy.** `update_column_value`
    is the dominant ITEM-SCOPED kind (4× of 19 rows; the only
    item-scoped event in the sample). Payload carries
    `column_id` + `column_type` + `value` + `previous_value` +
    `textual_value` + `pulse_id` + `pulse_name`;
    `previous_value` is sometimes `{}` for first-set events
    (decode defensively as "previously-unset"). Per-`column_type`
    typed `before` / `after` projection lands case-by-case at
    M24 implementation; pre-flight pins the discriminator +
    raw-shape fallback (`before` / `after` as `z.unknown()`
    slots).
  - **`entity` field discriminates item-scoped from board-scoped
    events.** Observed values: `pulse` (4×; item-scoped) and
    `board` (15×; board-scoped — `create_column`, `create_group`,
    `board_workspace_id_changed`, `update_board_name`,
    `update_board_nickname`). The walker filters
    `entity = 'pulse'` to drop board-level noise; **the
    `item_ids` filter on `activity_logs(...)` is INSUFFICIENT on
    its own** — passing it does NOT exclude board-scoped events
    from the response. Board-scoped event variants stay in the
    zod discriminated union as defensive parser-roundtrip
    targets (so a regression that bypasses the entity filter
    falls back to the typed variant rather than `unknown`).
  - **Unknown-event-kind shape is `warnings[]`, not `error.code`.**
    The 29-stable-error-code registry stays at 29. Unrecognised
    event values surface under the `kind: 'unknown'` fallback
    variant carrying `before: null` + `after: <raw parsed data>`
    (uniform shape with the synthesized comment-event variants;
    `after` is the raw payload — no separate `data` slot) +
    additional raw wire `event` + `entity` slots so agents can
    route on the unrecognised kind. Dual-field shape on
    `kind: 'unknown'`: the variant discriminator AND the raw wire
    `event` BOTH land on the projected event (the projector's
    routing aid). Alongside the typed `unknown` row, a
    `unknown_event_kind` `warnings[]` entry surfaces with
    `{event, entity, occurrence_count, hint}` details. One
    warning per unique unrecognised event observed (not per
    occurrence) so the warnings array stays bounded on
    degenerate inputs.
  - **Two-source merge.** The CLI merges
    `boards.activity_logs(item_ids:, ...)` with
    `items.updates(...)` chronologically by `created_at`
    ascending; ties break by `id` lexicographic for
    deterministic output across runs. Updates source
    contributes synthesized `update_posted` (Update→event) +
    `update_replied` (Reply→event, one per Reply row carrying
    `parent_update_id` for thread reconstruction) variants.
    `Reply.kind` is a SEPARATE taxonomy from
    `activity_logs.event` — surfaced under the
    `update_replied.reply_kind` slot for agent
    introspection.
  - **Eventual-consistency lag >30s.** Monday's `activity_logs`
    has an empirically-measured propagation lag exceeding 30s
    on freshly-edited boards. The verb's `--help` text + this
    cli-design entry pin the caveat: agents polling history
    after a write should wait at least 30s before expecting
    the new event to surface. M24 implementation MUST NOT
    promise immediate-history for newly-modified items.
  **Pagination shape (M24 pre-flight decision close).** Per-
  source page-numbered: `--activity-logs-page <n>` (1-indexed)
  for `activity_logs(page:, limit:)`; `--updates-page <n>`
  (1-indexed; independent denominator) for `updates(page:,
  limit:)`. The two sources paginate independently — merging
  them onto a single `--page <n>` flag would conflate two
  different denominators. `--limit <n>` is the per-source
  per-call slice (default 100; hard cap 10000 per Monday's
  documented ceiling).
  **Merge semantics (M24 pre-flight decision close).** Both
  sources drain to the `--since <iso>` / `--until <iso>`
  wall-clock cap (Monday's `activity_logs(from:, to:)` accepts
  ISO8601DateTime args server-side; the updates source filters
  client-side against `Update.created_at` since Monday's
  `updates` resolver doesn't expose a wall-clock filter as of
  API `2026-01`). The merge projector orders the unified
  stream by `created_at` ascending with `id` lexicographic
  tie-break.
  **`before` / `after` shape (M24 pre-flight decision close).**
  Per Decision 2: typed projection per `column_type` lands at
  M24 implementation (case-by-case for `update_column_value`'s
  `data.value` + `data.previous_value` JSON payloads); pre-
  flight pins each variant's `before` / `after` slots as
  `z.unknown()` carrying the raw parsed JSON payload. Comment-
  event `before` is always `null` (append-only events);
  `after` carries `{body, text_body, reply_count}` for
  `update_posted` and `{body, text_body}` for `update_replied`.
  **Streaming (M24 pre-flight decision close).** Reuses
  `startNdjsonStream` (R52) when `--stream` is on. The merge
  is NOT incremental (the entire `--since`-bounded slice must
  be resident to order it); the NDJSON path emits the merged
  array post-merge with the trailer carrying per-source
  pagination state (`activity_logs.last_page` +
  `updates.last_page`) + complexity + source. Agents
  resuming a partial walk re-issue with the trailer's
  `last_page` values bumped by 1 per source.
  **Implementation shipped at `d058172`** (+ Codex impl
  review fixes at `5f10cda` round 1 + `a024961` round 2):
  per-event projector with one-level nested-JSON unwrap on
  `update_column_value.value` / `previous_value` so agents
  see structured payloads (e.g. `{label, index}` for status,
  ISO string for date) rather than opaque JSON-string
  scalars; numeric `pulse_id` stringified via the
  `readNullableIdField` helper per the probe-confirmed
  unquoted-JSON-number wire shape; updates source filter
  uses `Date.parse` epoch comparison with explicit NaN
  guard (defence-in-depth against malformed wire timestamps
  + mixed-offset CLI inputs); `projectReplyRow` fallback
  chain `Reply.created_at → Reply.updated_at → parent
  Update's projected timestamp` ensures the event schema's
  `created_at.min(1)` invariant holds; `--stream` flag
  forces NDJSON regardless of `--json` / `--table` /
  `--output` flags.
- `board favorites` — current user's starred boards. Pairs with the
  v0.3 cross-board `item search` as a natural scoping lever
  (`item search --favorites`); shipping it in isolation buys little
  agent value, so the two land together. **M23 pre-flight empirical
  probe (2026-05-11, API `2026-01`, `scripts/probe/m23-favorites*.ts`
  + `scripts/probe/m23-hierarchy-*.ts`):** Monday surfaces favorites
  at the top-level `Query.favorites: [GraphqlHierarchyObjectItem!]`
  (NOT `User.favorites` or `Board.is_starred`). The element shape
  is **polymorphic** — each entry carries `id` (hierarchy-item ID),
  `accountId`, `object: { id: ID, type: GraphqlMondayObject }`
  (enum: `Board` | `Folder` | `Dashboard` | `Workspace`),
  `folderId`, `position` (Float — Monday's UI sort order),
  `createdAt`, `updatedAt`. **Implication: `board favorites` is
  a 2-stage GraphQL operation** — Stage 1 fetches the favorites
  list and filters to `object.type === "Board"`; Stage 2 hydrates
  via `boards(ids: [<board-typed-ids>]) { id name workspace_id
  state url }`. Output sorted by `position` for parity with
  Monday's UI sidebar order. The 2-stage shape is similar to M22's
  `monday usage` (which combines `platform_api.daily_limit` +
  `platform_api.daily_analytics`); per-call cost is one
  GraphQL request per stage
- `item update --continue-on-error` — partial-success bulk path
  (v0.3-M25). Today's bulk `item update --where` fails fast on
  the first per-item error (matched items before the failure
  surface in `details.applied_to` per §6.5). The flag attempts
  every matched item regardless and emits a partial-success
  envelope with per-item `{item_id, ok, error?}` records — a
  §6.4 sub-section ("Bulk per-item partial-success"), not just a
  flag. Inherits M15's `dispatchSequential` helper from
  `src/api/partial-success-mutation.ts` via a thin wrapper at
  `src/api/partial-success-bulk.ts` (new at M25), so the
  partial-success contract surface stays single-source-of-truth
  across the M13/M14/M15 family + M25's bulk-fail-mode
  extension. Per cli-design §6.1's universal partial-success
  rule, the top-level envelope is `ok: true` even when every
  per-item attempt failed — agents read `data.results[]` for
  per-item outcomes. `data.summary` extends the v0.1 fail-fast
  bulk-summary with a new `failed_count` slot
  (matched_count === applied_count + failed_count invariant).
  `data.operation` is the literal `"item_update"` (mirrors M14
  add-users' / remove-users' discriminator). The
  `--continue-on-error` flag is orthogonal to the `--yes`
  confirmation gate — both must be acknowledged for the live
  partial-success path to fire. ERROR_CODES registry unchanged
  at 29 — per-item failures route through existing codes
  (column_archived / validation_failed / complexity_exceeded /
  etc.); no new top-level error code joins the registry. The
  v0.1 fail-fast bulk path (`details.applied_to` decoration on
  the top-level error envelope per §6.5) is unchanged; an agent
  who hasn't migrated to read `data.results[]` continues to
  receive the v0.1 envelope shape
- `monday status` — connectivity + auth + local-state probe matrix
  (DNS / TCP / TLS / auth + cache writability + redaction self-test
  + env-var pickup summary) that short-circuits without touching
  account state. **Decision 7 closure (M22 pre-flight):** probe by
  default; `--no-probe` skips the four network probes (the
  local-only probes still run). The full probe matrix + per-probe
  error-code mapping + the empirical 401 envelope shape lives at
  §11.5. Lands with the v0.3 diagnostics cluster (`auth login`,
  `monday usage`) — solo it's low value once `account whoami`
  works, but together they form a coherent "is everything
  working?" surface
- `monday usage` — daily Monday API **operation** budget remaining.
  Complements v0.1's per-call `account complexity` (which surfaces
  per-minute COMPLEXITY POINTS, a separate Monday quota system)
  with the "have I burned through my daily operation budget?"
  shape, so an agent can self-throttle before a bulk run.
  **M22 pre-flight empirical-probe finding (2026-05-10, API
  `2026-01`):** Monday's daily-budget surface lives at
  `platform_api.daily_limit { base, total }` +
  `platform_api.daily_analytics.by_day [{ day, usage }]` — NOT
  `account.complexity` (the field doesn't exist on the `Account`
  type). The unit Monday tracks under `platform_api.daily_*` is
  operations per day (200/day on free tier), not complexity
  points; the M22 pre-flight reshape pins the accurate envelope
  shape (Decision 8 closure). Minimum-viable shape lands at
  v0.3 (`{daily_limit, usage_today, usage_remaining_today,
  last_updated}`); per-minute complexity headroom (from the
  v0.1 `complexity` surface) + concurrency-cap headroom can grow
  into the same envelope at v0.4 alongside `--concurrency`
  without re-pinning the v0.3 contract (envelope is additive-
  only per §6.1 + §11.5.3)
- Profiles in `~/.monday-cli/config.toml`
- `monday auth login` — OAuth flow + credentials cache (mode 0600)
- `notification send` + `webhook list/create/delete` — v0.3-M27
  outbound writes, bundled because both are write-only + low
  surface. `notification send` fires Monday's `create_notification`
  mutation (single-recipient at v0.3 per §4.3; `--user <uid>` is
  singular). `webhook list/create/delete` wraps Monday's
  `webhooks(board_id:)` query + `create_webhook` / `delete_webhook`
  mutations; the CLI never *receives* — webhooks land on the user's
  own HTTPS endpoint (§1 permanent non-goal: hosting webhooks).
  **Webhooks are live-only at v0.3** — outside §8's cache scope;
  the live `webhook list` read and the live `webhook create` /
  `webhook delete` mutation paths emit `meta.source: "live"` with
  `meta.cache_age_seconds: null`. `--dry-run` paths emit
  `meta.source: "none"` per the canonical `DryRunEnvelope`
  contract — all 3 write-verb dry-runs are strictly argv-derived
  (no pre-mutation read fires). Adding webhooks to §8 cache scope
  would be a contract extension (v0.3.x / v0.4 PR).
  **M27 pre-flight decisions closed inline
  (`af1c2f8`):** Decision 9 (webhook event-type
  validation) — closed via the 21-value `WEBHOOK_EVENT_TYPES`
  closed enum in `src/api/webhooks.ts` (empirical probe
  2026-05-12, API `2026-01`); `webhook create --event <type>`
  surfaces `usage_error` for unknown events at parse boundary.
  **Asymmetric `Webhook.config` typing pinned:** create input
  accepts the `JSON` scalar; read-side returns `String` (Monday
  echoes the stored JSON-encoded config as a string). **Monday's
  `NotificationTargetType` wire enum has only two values (`Post` /
  `Project`); the `Post` value (Update-targeted notifications) is
  unreachable at v0.3** — the documented `--target-type
  item|board` argv vocabulary maps to wire
  `NotificationTargetType.Project`; the wire `Post` value is
  deferred to a v0.3.x / v0.4 contract-extension that may add a
  CLI third target-type `update` dispatching to wire `Post`. ERROR_CODES registry unchanged
  at 29 — M27 wire failures route through existing codes
  (`not_found` / `usage_error` / `unauthorized` / `forbidden` /
  `validation_failed`).
  **Implementation shipped** at `9cb6a74` (feat — 4 runtime
  fetchers in `src/api/webhooks.ts` + `src/api/notifications.ts`
  + 4 verb action bodies + 34 new integration tests across
  `tests/integration/commands/{webhook,notification}.test.ts`)
  + 4 Codex impl review rounds: `6f59a83` (round 1 — 0 P1 + 1 P2
  + 1 P3; P2-1 pinned operationName literals on the 4 fetcher
  inputs to close the R-NEW-37 W2 audit-point safely-by-
  construction); `2402a76` (round 2 — 0 P1 + 0 P2 + 1 P3, W7
  + W8 doc/test prose drift across 3 sites); `ff724fd` (round 3
  — 0 P1 + 0 P2 + 1 P3', W8 prose precision across 4 sites);
  `64d94d7` (round 4 — 0 P1 + 0 P2 + 1 P3'', W8 prose
  precision across 2 final sites). Runtime behaviour converged
  at round 1; W8 wording took 4 passes to fully reflect that
  Monday validates target visibility as a `Project` but cannot
  verify the CLI-declared `--target-type` (item-vs-board)
  against the underlying record — the pairing is trusted, not
  enforced. Coverage 99.08 / 95.92 / 99.29 / 99.31 post-close
  (branches margin 0.47pp, up from 0.43pp at pre-flight). Test
  count 3183 → 3217.

### v0.4 (polish + nice-to-haves)

- `item watch <iid>` (polling at default 30s cadence; reactive circuit
  breaker on Monday wire errors per §14.4 closure) **— M29 shipped**
- Shell completion (bash / zsh / fish) via hand-rolled templates
  **— M33 shipped end-to-end (pre-flight cluster `c619425..affbf70`,
  3 rounds, 0 P1 + 3 P2 + 4 P3 cumulative; IMPL cluster
  `7cbb120..e651674`, 1 fix-up round + ratification, 0 P1 + 1 P2 +
  1 P3 cumulative — at the lower bound of the M22 / M27 / M32
  read-surface precedent for a CLI-internal milestone).**
  Empirical probe at
  pre-flight (`grep -rn 'completion\|complete' node_modules/commander/
  lib/ node_modules/commander/typings/` 2026-05-14, commander 14.0.3)
  returned zero hits — commander ships NO built-in completion
  machinery, so the verb hand-rolls per-shell templates at runtime
  (Decision 1 closure; no runtime dep added per the cli-design §1
  "minimum deps" principle). New top-level verb at §4.3 COMPLETION
  section: `monday completion <bash|zsh|fish>` (closed 3-value enum
  positional). First non-envelope stdout surface in the CLI — §3.1
  #2 raw-bytes carve-out documents the discipline. ERROR_CODES count
  stays at 29 (failures route through existing `usage_error` for
  invalid shell flavour + inapplicable `--table` / `--output
  table|text|ndjson` format flags — only `--json` and `--table` are
  global shorthand flags per §4.4; `text` and `ndjson` are
  accessible only via the long-form `--output <fmt>` value). No new
  transport seam (CLI-internal verb), no destructive gate, no
  GraphQL operation. The IMPL feat ships the three-mode format-
  aware action body (raw-bytes default / `--json` envelope /
  format-flag rejection) + three hand-rolled per-shell template
  builders walking `program.commands` at emit time so completions
  stay in sync with the registry.
- Bulk operations with `--concurrency` (probed against Monday's
  per-account concurrency cap; empirical probe at 2026-05-13
  observed cap > 100 in-flight for trivial reads, see §9.3)
  **— M30 shipped end-to-end on `item update --where
  --continue-on-error`** (pre-flight + IMPL clusters closed;
  `MIN_CONCURRENCY = 1` / `MAX_CONCURRENCY = 32` /
  `DEFAULT_CONCURRENCY = 1` per §9.3; envelope byte-equivalent
  to M25 sequential under `--concurrency 1`). Other bulk verbs
  (item clear, board update, workspace add-users, etc.) defer
  their `--concurrency` extension to later v0.4 milestones if
  user demand surfaces.
- Asset upload (`add_file_to_column`, `add_file_to_update`)
  **— M31 shipped end-to-end** (pre-flight + IMPL clusters
  closed). Two new verbs at §4.3:
  `monday item upload <iid> --column <col> <file>` (file column only;
  empirical probe `scripts/probe/m31-asset-upload.ts` 2026-05-13
  pinned `add_file_to_column(column_id: String!, file: File!,
  item_id: ID!) → Asset`) and `monday update upload <uid> <file>`
  (`add_file_to_update(file: File!, update_id: ID!) → Asset`). First
  v0.4 verbs crossing the wire via `multipart/form-data` (NOT the
  JSON-only `client.request` seam); new transport seam at
  `src/api/multipart-transport.ts` mirrors `transport.ts`'s
  `Transport` interface with FormData-driven body assembly. No new
  ERROR_CODE (29 stays); existing `usage_error` /
  `unsupported_column_type` / `not_found` / `validation_failed`
  cover the failure modes via `details.reason` discrimination
  (`'file_not_readable'` / `'file_empty'` / `'file_too_large'`).
  R-NEW-41 (asymmetric wire-vs-CLI semantics documentation pattern)
  fired its 3rd consumer here — the load-bearing lift is the new
  "Wire-vs-CLI semantics documentation conventions" section in
  `docs/architecture.md` (R-NEW-41 shipped).
- `doc list/get` (read-only workdocs; full docs CRUD deferred to
  v0.5) **— M32 shipped end-to-end** (pre-flight cluster
  `05c5988..a889eac`, 4 rounds; IMPL cluster `2ca8b97..a7d6771`,
  3 rounds; cumulative IMPL findings 0 P1 + 1 P2 + 2 P3 within
  the M22 / M27 read-surface precedent). Two new verbs at §4.3:
  `monday doc list [--workspace <wid>,...] [--order-by
  <created_at|used_at>] [--limit <n>] [--page <n>]` and `monday
  doc get <did>`. Empirical probe `scripts/probe/m32-docs.ts`
  (2026-05-14, API `2026-01`) pinned `Query.docs(workspace_ids:
  [ID], order_by: DocsOrderBy, limit: Int, page: Int) →
  [Document]`; the wire object is named `Document` (NOT `Doc` —
  the standalone `DocKind` enum exists but `Document.doc_kind`
  returns `BoardKind!` reusing the same `public`/`private`/
  `share` values used for boards); 14 fields including
  `blocks: [DocumentBlock]` (9-field block projection); `DocsOrderBy`
  closed 2-value enum (`created_at` / `used_at`, both `desc`).
  Page/limit pagination (no cursor on Monday's workdocs surface);
  CLI ceilings `--limit` at 100 (Monday's wire default is 25, no
  documented hard cap). Read-only — no cache (workdocs are
  content-heavy + frequently human-edited; mirrors `monday usage`
  / `monday status` / `webhook list` live-only cadence). No new
  ERROR_CODE (29 stays); failures route through existing
  `not_found` (non-existent or inaccessible doc), `usage_error`
  (argv parse rejection), `validation_failed` (Monday-side
  reject), `forbidden`/`unauthorized` (scope). Future v0.5 picks
  up the 9 doc-mutation surfaces Monday's wire exposes
  (`create_doc` / `update_doc_name` / `delete_doc` /
  `duplicate_doc` / `import_doc_from_html` /
  `add_content_to_doc_from_markdown` / `create_doc_block` /
  `update_doc_block` / `delete_doc_block`) — each substantial
  enough to warrant its own milestone.
- `team` create/manage **— deferred to v0.5 at the post-v0.4-M33
  candidate-selection session** (R-NEW-75 framework graduation
  session). Picked release-prep over `team` writers on three
  grounds: (a) the v0.4 shipped surface already exceeded v0.3's
  so 0.4.0 had earned a tag; (b) team writers fit cleanly with
  the v0.5 doc-CRUD-mutation backlog (9 doc mutations Monday
  exposes) for a "team + docs CRUD" v0.5 frame; (c) release-prep
  shipped in a single session vs 3-4 sessions for team writers
  (empirical probe + pre-flight + IMPL + close-docs). v0.5
  kickoff opens with the bundled team-writers + doc-CRUD-mutation
  backlog.

### v0.5 (next — team writers + workdocs CRUD mutations)

- `team` create / delete / add-members / remove-members + the
  two read complements (`team-list` / `team-get`) — Monday's
  `create_team` + `delete_team` + `add_users_to_team` +
  `remove_users_from_team` mutations + `Query.teams` reads.
  Deferred from v0.4-M34 at the post-v0.4-M33 candidate-
  selection session (see above). **No `update_team` mutation
  exists on Monday's wire at API `2026-01`** — empirical probe
  `scripts/probe/v0.5-team-mutations.ts` (2026-05-15) confirmed
  the gap; v0.5 ships no `team-update` verb. **No
  `--description` flag** — `Team` object carries no description
  field on the wire. Six tangential team-shaped mutations
  (`assign_team_owners` / `remove_team_owners` /
  `add_teams_to_board` / `delete_teams_from_board` /
  `add_teams_to_workspace` / `delete_teams_from_workspace`)
  defer to v0.5.x candidate-selection. v0.5-M34 pre-flight
  stubs at this commit; runtime bodies land at M34 IMPL.
- Workdocs CRUD mutations — 9 surfaces total split across 3 v0.5
  milestones per the M35/M36/M37 sequencing. **v0.5-M35 ships
  the doc-level CRUD surface (5 verbs)** at this pre-flight
  commit: `monday doc create-in-workspace` (Monday's
  `create_doc(location: {workspace: ...})`) + `monday doc
  create-on-column` (`create_doc(location: {board: ...})`) +
  `monday doc rename` (`update_doc_name`) + `monday doc delete
  --yes` (`delete_doc`) + `monday doc duplicate [--with-updates]`
  (`duplicate_doc`). D7 closure: two verbs over one with
  placement choosers (mirrors `monday item upload` /
  `monday update upload` split for the same multipart wire at
  v0.4-M31). D8 closure: drop `--name <n>` from duplicate
  (no wire-side rename slot on Monday's `duplicate_doc`). D9
  closure: project opaque JSON returns (rename / delete /
  duplicate) to flat `{ doc_id, success: true }` envelope at
  the fetcher boundary. Per-block CRUD (`create_doc_block` /
  `update_doc_block` / `delete_doc_block`) defers to v0.5-M36;
  doc-content import (`import_doc_from_html` /
  `add_content_to_doc_from_markdown`) defers to v0.5-M37.
  Empirical probe at v0.5 kickoff
  (`scripts/probe/v0.5-doc-mutations.ts` +
  `v0.5-inputs-and-results.ts` + `v0.5-nested-inputs.ts`,
  2026-05-15, API `2026-01`) pinned the 9 mutation signatures
  + return-shape heterogeneity (full Document on create; opaque
  JSON on rename/delete/duplicate; DocumentBlock on per-block
  ops; custom `{success, error?}` OBJECT on the imports).
  v0.5-M35 pre-flight stubs at this commit (argv schema + wire
  mutation documents + envelope projection only); runtime
  bodies land at M35 IMPL.
- Files-shaped friendly `--set` translator + `--set-raw` form —
  the `monday item upload` verb shipped at v0.4-M31 covers the
  multipart wire path; the inline `--set` / `--set-raw` form
  for file columns slipped at v0.4 release-prep (would need a
  separate dispatch from the translator boundary into the
  multipart wire).
- Cross-board `item move` value-overrides — slipped from v0.4
  release-prep; Monday's `ColumnMappingInput` carries no value
  slot at API `2026-01`, so the richer `{id, value?}` form
  requires a non-atomic post-move `change_multiple_column_values`
  with cross-leg partial-failure envelope shapes.
- Cross-board search resumable cursor — slipped from v0.4
  release-prep; per-board cursor-lifetime under aggregation
  remains the load-bearing design issue.
- Multi-level subitem creation — slipped from v0.4 release-prep;
  conditional on Monday's data model surfacing `subtasks` on
  `sub_items_board` at API `2026-01`+.

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
4. **Watch-via-polling cadence and circuit breaker (v0.4).**
   **Closed:** default cadence pinned at **30s** with
   `--interval <ms>` override (range 1000ms–3600000ms);
   circuit breaker is **reactive, not preemptive** (rely on
   Monday's `complexity_exceeded` / `concurrency_exceeded` /
   `rate_limited` wire responses; respect
   `reset_in_x_seconds` for backoff with a 60s default cap
   when absent and a **300s ceiling** on the per-failure
   backoff; trip to `failure_envelope` after **5
   consecutive failed polls**). Per-failure
   `WatchSessionWarning` records accumulate in-session and
   emit in the trailer's `_meta.warnings` slot per the §6.3
   NDJSON contract (resource lines + final `_meta`;
   warnings are NOT interleaved with event records). No new
   ERROR_CODE — `complexity_exceeded` /
   `concurrency_exceeded` / `rate_limited` already in §6.5's
   29-code registry cover the circuit-breaker exit; the
   trailer-meta's seven M29-specific slots
   (`events_emitted` / `polls_made` / `failed_polls` /
   `watch_duration_seconds` / `last_seen_event_id` /
   `circuit_broken_at` / `exit_reason`) discriminate the
   trip mode + drive restartability. **`--once` without
   `--since` drains the most-recent 100 events** by default
   (`DEFAULT_ONCE_BACKLOG_LIMIT`) so an agent invoking
   `monday item watch <iid> --once` against a long-lived
   item gets a bounded backlog without scrolling the entire
   history. Multi-watcher policy: each `monday item watch`
   invocation is independent (no shared registry); aligns
   with §3.1 #5 ("agents do their own parallelism"). Pinned
   at v0.4-M29 pre-flight empirical probe
   (`scripts/probe/m29-polling-burn.ts`, 2026-05-13, API
   `2026-01`): per-poll cost is stable at **10 complexity
   points** for the `boards(ids:){ activity_logs(item_ids:,
   from:, limit:) }` shape (no scaling with `limit:`); the
   per-minute complexity budget is **1,000,000** with a 60s
   reset window, so 30s cadence burns ~0.002% of the per-
   minute budget — politeness against Monday's servers +
   the documented >30s `activity_logs` propagation lag (see
   §13 v0.3 entry on `item history`) are the binding
   constraints, NOT budget. Closes v0.4-plan §3 M29
   Decisions D1–D5.
5. **Auth caching format (v0.3).** **Closed:** plain JSON at
   `~/.monday-cli/credentials` with mode `0600`; not
   `gh`/`aws`-style. File format pinned in §7.4 ahead of M21 with
   Codex-reviewed extension PR (closes v0.3-plan §8 Decision 3).
   OS-keyring integration deferred to v0.4+ if a multi-user
   threat model emerges; see §7.4.4 for the explicit threat-model
   commitment.
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
