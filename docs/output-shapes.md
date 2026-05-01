# Output shapes — per-command reference

> Reference, not contract. The binding contract lives in
> [`cli-design.md`](./cli-design.md) §6 (universal envelope, error codes,
> versioning rules). This doc is a per-command index that says
> "here's what `data` looks like" for each shipped command, so an
> agent can grep one place to learn what to expect from
> `monday <noun> <verb> --json` without running it.
>
> The byte-shape of every example here is pinned by
> [`tests/integration/envelope-snapshots.test.ts`](../tests/integration/envelope-snapshots.test.ts) — if a v0.2 change drifts the
> shape, that suite fails loud and this doc updates in lockstep.

## How to read this doc

Every command returns the same envelope skeleton:

```json
{
  "ok": true,
  "data": <command-specific>,
  "meta": { "schema_version": "1", "api_version": "2026-01",
            "cli_version": "0.1.0", "request_id": "...",
            "source": "live", "cache_age_seconds": null,
            "retrieved_at": "...", "complexity": null },
  "warnings": []
}
```

The `meta` skeleton is constant across commands; full key list in
[cli-design.md §6.1](./cli-design.md#61-universal-envelope). Each
section below shows just the **`data`** payload and any
command-specific `meta` slot. Examples use deterministic test
fixtures (`request_id: fixed-req-id`,
`retrieved_at: 2026-04-30T10:00:00.000Z`,
`cli_version: 0.0.0-test`) — substitute real values at runtime.

Collection responses also surface §6.3 collection-meta keys
(`has_more`, `total_returned`, `next_cursor`); shown inline when
non-default.

Mutation responses additionally carry §6.4 keys
(`resolved_ids`, optional `side_effects`); shown inline.

Error envelopes follow §6.5 (`{ ok: false, error, meta }` —
no `data`); see the **Errors** section at the bottom.

---

## Table of contents

| Noun | Verbs |
|------|-------|
| [account](#account) | whoami, info, version, complexity |
| [workspace](#workspace) | list, get, folders |
| [board](#board) | list, get, find, describe, columns, groups, subscribers, doctor |
| [user](#user) | list, get, me |
| [update](#update) | list, get, create |
| [item (reads)](#item-reads) | list, get, find, search, subitems |
| [item (mutations)](#item-mutations) | set, clear, update (single + bulk) |
| [raw](#raw) | (escape hatch) |
| [cache](#cache) | list, stats, clear |
| [config](#config) | show, path |
| [schema](#schema) | (no verb) |
| [Errors](#errors) | error envelope shape |

---

## account

### `account whoami`

The connected user + their account.

```json
{
  "me": {
    "id": "1",
    "name": "Alice",
    "email": "alice@example.test",
    "account": { "id": "99", "name": "Org", "slug": "org" }
  }
}
```

Idempotent: yes. `meta.source: "live"`.

### `account info`

The account itself — plan, country, members count.

```json
{
  "id": "99", "name": "Org", "slug": "org",
  "country_code": "GB", "first_day_of_the_week": "monday",
  "active_members_count": 7, "logo": null,
  "plan": { "version": 1, "tier": "pro", "max_users": 100, "period": "annual" }
}
```

### `account version`

The pinned API version + Monday's reported available versions.
The CLI pins `2026-01` (matches `@mondaydotcomorg/api@14.0.0`'s
`CURRENT_VERSION`); `--api-version` overrides per-call.

```json
{
  "pinned": { "value": "2026-01", "sdk_default": "2026-01", "source": "sdk_default" },
  "available": [
    { "display_name": "2026-01", "kind": "current", "value": "2026-01" },
    { "display_name": "2025-10", "kind": "maintenance", "value": "2025-10" }
  ]
}
```

### `account complexity`

A complexity-budget snapshot (Monday rate-limits at 5M complexity
points per minute).

```json
{ "before": 5000000, "used": 1, "remaining": 4999999, "reset_in_seconds": 30 }
```

---

## workspace

### `workspace list`

Collection. Page-based pagination (`--limit-pages` caps the walk).

```json
[
  { "id": "5", "name": "Engineering", "description": "Platform team",
    "kind": "open", "state": "active", "is_default_workspace": false,
    "created_at": "2026-04-01T00:00:00Z" }
]
```

`meta` adds `total_returned`, `has_more`.

### `workspace get <id>`

Single resource. Includes `settings.icon`.

```json
{
  "id": "5", "name": "Engineering", "description": "Platform team",
  "kind": "open", "state": "active", "is_default_workspace": false,
  "created_at": "2026-04-01T00:00:00Z",
  "settings": { "icon": { "color": "#0000FF", "image": null } }
}
```

### `workspace folders <workspace-id>`

Collection of folders within the given workspace.

```json
[
  { "id": "101", "name": "Roadmap", "color": "aquamarine",
    "created_at": "2026-04-01T00:00:00Z", "owner_id": "1",
    "parent": null,
    "children": [{ "id": "500", "name": "Q2 plan" }] }
]
```

---

## board

### `board list`

Collection. `--workspace`, `--state` thread into Monday's `boards()`
arguments.

```json
[
  { "id": "111", "name": "Tasks", "description": null,
    "state": "active", "board_kind": "public",
    "board_folder_id": null, "workspace_id": "5",
    "url": "https://x.monday.com/boards/111",
    "items_count": 7, "updated_at": "2026-04-30T10:00:00Z" }
]
```

`meta` adds `total_returned`, `has_more`.

### `board get <id>`

Single resource. Includes `permissions`.

```json
{
  "id": "111", "name": "Tasks", "description": null,
  "state": "active", "board_kind": "public", "board_folder_id": null,
  "workspace_id": "5", "url": "https://x.monday.com/boards/111",
  "items_count": 7, "permissions": "collaborators",
  "updated_at": "2026-04-30T10:00:00Z"
}
```

### `board find <name>`

Single resource on unique match (after NFC + case-fold). Multi-match
without `--first` raises `ambiguous_name`. Narrow projection — no
`url` / `items_count` (BoardFind GraphQL doc selects less).

```json
{ "id": "111", "name": "Tasks", "description": null,
  "state": "active", "board_kind": "public",
  "workspace_id": "5", "url": null }
```

### `board describe <id>`

Single resource. The agent's discovery hammer for a board. Each
column carries `writable` + (when writable) `example_set` — concrete
`--set <token>=<value>` strings the agent can paste into `item set`.
`writable` is `true` for the ten friendly-translator types (text /
long_text / numbers / status / dropdown / date / people / link /
email / phone) and `false` for everything else; `example_set` is
populated for every writable column. M8 firm-row examples include
the pipe-form shapes for `link` / `email` / `phone`.

```json
{
  "id": "111", "name": "Tasks", "description": null,
  "state": "active", "board_kind": "public", "workspace_id": "5",
  "url": null, "hierarchy_type": null, "is_leaf": true,
  "groups": [],
  "columns": [
    { "id": "status_4", "title": "Status", "type": "status",
      "writable": true,
      "example_set": ["--set status_4='Backlog'",
                      "--set status_4=0   # by index"] },
    { "id": "site", "title": "Site", "type": "link",
      "writable": true,
      "example_set": ["--set site=https://example.com",
                      "--set site='https://example.com|Site'"] },
    { "id": "mobile", "title": "Mobile", "type": "phone",
      "writable": true,
      "example_set": ["--set mobile='+15551234567|US'"] },
    { "id": "mirror_x", "title": "Mirror", "type": "mirror",
      "writable": false, "example_set": null }
  ]
}
```

`meta.source` flips to `"cache"` on the second call (XDG_CACHE_HOME
serves a cached snapshot up to the cache TTL — see
[cli-design.md §8](./cli-design.md#8-caching) for the cache-aware
`loadBoardMetadata` contract).

### `board columns <id>`

Collection of columns (the projection from `describe.columns`).
`--include-archived` reveals archived ones.

### `board groups <id>`

Collection of groups.

```json
[
  { "id": "topics", "title": "Topics", "color": "red",
    "position": "1.000", "archived": false, "deleted": false }
]
```

### `board subscribers <id>`

Collection of users subscribed to the board.

```json
[
  { "id": "1", "name": "Alice", "email": "alice@example.test",
    "is_guest": false, "enabled": true }
]
```

### `board doctor <id>`

Diagnostic envelope. Three diagnostic kinds — `duplicate_column_title`
(NFC + case-fold collisions), `unsupported_column_type` (per
roadmap category: `v0.2_writer_expansion` / `read_only_forever` /
`future`), `broken_board_relation` (archived or unreachable linked
boards).

```json
{
  "board_id": "111", "board_name": "Tasks",
  "total": 0, "diagnostics": []
}
```

A populated diagnostic looks like:

```json
{ "kind": "duplicate_column_title", "severity": "warn",
  "normalised_title": "status",
  "columns": [{ "id": "status_a", "title": "Status" },
              { "id": "status_b", "title": "STATUS" }] }
```

---

## user

### `user list`

Collection. `--name`, `--email`, `--kind` (`all` / `guests` /
`members` / `view_only`) thread into Monday's `users()` arguments.

```json
[
  { "id": "1", "name": "Alice", "email": "alice@example.test",
    "enabled": true, "is_guest": false, "is_admin": false,
    "is_view_only": false, "is_pending": false, "is_verified": true,
    "title": null, "time_zone_identifier": "Europe/London",
    "join_date": "2026-01-01", "last_activity": "2026-04-30T09:00:00Z" }
]
```

### `user get <id>`

Single resource. Adds `url` + `country_code`.

### `user me`

Alias for `account whoami`. Same envelope.

---

## update

"Updates" in Monday lingo are comments on items.

### `update list <item-id>`

Collection of comments on the given item.

```json
[
  { "id": "77", "body": "<p>Looks good</p>", "text_body": "Looks good",
    "creator_id": "1",
    "creator": { "id": "1", "name": "Alice", "email": "alice@example.test" },
    "created_at": "2026-04-30T09:00:00Z",
    "updated_at": "2026-04-30T09:01:00Z",
    "edited_at": "2026-04-30T09:01:00Z",
    "replies": [] }
]
```

### `update get <update-id>`

Single resource — the same shape with `item_id` added.

### `update create <item-id> --body <md>`

Posts a new comment. Mutation result envelope (cli-design §6.4).
Body sources: `--body <md>`, `--body-file <path>`, `--body-file -` (stdin).
**Not idempotent** — re-running creates a duplicate. `--dry-run`
supported (no `resolved_ids` because no column tokens).

```json
{
  "data": { "id": "88", "body": "<p>Done — moved to QA.</p>",
            "text_body": "Done — moved to QA.",
            "creator_id": "1",
            "creator": { "id": "1", "name": "Alice", "email": "alice@example.test" },
            "item_id": "12345",
            "created_at": "2026-04-30T11:00:00Z",
            "updated_at": "2026-04-30T11:00:00Z" }
}
```

`--dry-run` shape:

```json
{
  "ok": true, "data": null,
  "meta": { ..., "dry_run": true, "source": "none" },
  "planned_changes": [
    { "operation": "create_update", "item_id": "12345",
      "body": "Done — moved to QA.", "body_length": 18 }
  ]
}
```

---

## item (reads)

Item responses use the §6.2 / §6.3 column-projection. Each cell
under `columns` keys off the column ID and carries
`{ id, type, title, text, ...typedFields }`. The exact typed shape
depends on the column type — `status` carries `label` + `index`,
`date` carries `date` + `time`, `people` carries `people: [...]`,
unknown types carry just `text` + `value`.

### `item list --board <bid>`

Collection. Cursor-paginated (`items_page` → `next_items_page`).
`--where`, `--filter-json`, `--columns`, `--sort`, `--all`,
`--limit-pages` all supported. NDJSON streaming via
`--output ndjson`.

```json
{
  "ok": true,
  "data": [
    { "id": "12345", "name": "Refactor login", "state": "active",
      "url": "https://example.monday.com/items/12345",
      "board_id": "111", "group_id": "topics", "parent_item_id": null,
      "created_at": "2026-04-29T10:00:00Z",
      "updated_at": "2026-04-29T11:00:00Z",
      "columns": {
        "status_4": { "id": "status_4", "type": "status",
                      "text": "Done", "label": "Done", "index": 1,
                      "value": { "label": "Done", "index": 1 } },
        "date4":    { "id": "date4", "type": "date",
                      "text": "2026-05-01",
                      "date": "2026-05-01", "time": null,
                      "value": { "date": "2026-05-01", "time": null } }
      } }
  ],
  "meta": {
    ..., "has_more": false, "next_cursor": null, "total_returned": 1,
    "columns": {
      "status_4": { "id": "status_4", "type": "status", "title": "Status" },
      "date4":    { "id": "date4",    "type": "date",   "title": "Due date" }
    }
  },
  "warnings": []
}
```

Note the **title de-duplication**: per-cell `title` is dropped from
each row's `columns` and consolidated into `meta.columns` when
all rows share a single board (cli-design §6.3). Single-resource
calls (`item get`, `item find`) keep titles inline.

### `item get <id>`

Single resource. Same column-projection as `item list`, but with
inline `title` per cell:

```json
{
  "id": "12345", "name": "Refactor login", "state": "active",
  "url": "https://example.monday.com/items/12345",
  "board_id": "111", "group_id": "topics", "parent_item_id": null,
  "created_at": "...", "updated_at": "...",
  "columns": {
    "status_4": { "id": "status_4", "type": "status", "title": "Status",
                  "text": "Done", "label": "Done", "index": 1,
                  "value": { "label": "Done", "index": 1 } }
  }
}
```

### `item find <name> --board <bid>`

Single resource on unique match. NFC + case-fold matching like
`board find`. Multi-match without `--first` raises `ambiguous_name`.
Cap-bounded scan: a `pagination_cap_reached` warning surfaces if
the scan was truncated and uniqueness can't be verified.

### `item search --board <bid> --where ...`

Collection. Like `item list` but routed through Monday's
`items_page_by_column_values` (server-side filter).

### `item subitems <item-id>`

Collection of direct subitems. Sorted by ID asc per page.

---

## item (mutations)

Mutation envelope (cli-design §6.4). Carries `data` (the post-mutation
item, projected through the same shape as `item get`),
`resolved_ids` (token → column-ID echo, §5.3 step 2), and
`meta.source: "live"` (or `"mixed"` when board metadata came from
cache and the mutation hit live).

### `item set <id> (<token>=<value> | --set-raw <token>=<json>)`

Single-column write. `--board <bid>` is optional; without it, the
item's board is looked up via `ItemBoardLookup`. Implicit lookup
adds one round-trip; agents that already know the board should
pass `--board`.

Two shapes (mutually exclusive — exactly one per call):
- **Friendly** — positional `<token>=<value>`. Goes through the
  10-type translator (text / long_text / numbers / status /
  dropdown / date / people / link / email / phone). Pipe-form
  shapes for the M8 firm row: `link=<url>|<text>`,
  `email=<email>|<text>`, `phone=<phone>|<country>` (country code
  is uppercase ISO 3166-1 alpha-2).
- **Raw** — `--set-raw <token>=<json>` (M8 escape hatch). The CLI
  parses `<json>` as a JsonObject, runs the read-only-forever /
  files-shaped reject lists, and dispatches via
  `change_column_value` (always — never the simple variant per
  cli-design §5.3). Read-only-forever (mirror / formula /
  auto_number / creation_log / last_updated / item_id) →
  `unsupported_column_type` with `read_only: true`. Files-shaped
  (file) → `unsupported_column_type` with `deferred_to: "v0.4"`.

`--dry-run` returns a planned-change envelope (no API write):

```json
{
  "ok": true, "data": null,
  "meta": { ..., "dry_run": true },
  "planned_changes": [
    { "board_id": "111", "item_id": "12345",
      "operation": "change_column_value",
      "resolved_ids": { "status": "status_4" },
      "diff": {
        "status_4": { "from": { "label": "Done", "index": 1 },
                      "to":   { "label": "Done" } }
      } }
  ],
  "warnings": []
}
```

**M8 firm-row wire shapes** (per `change_column_value(value: JSON!)`):

| Type | Friendly input | Wire `value` |
|------|----------------|--------------|
| `link` | `https://example.com` | `{"url":"https://example.com","text":"https://example.com"}` |
| `link` | `https://example.com\|Site` | `{"url":"https://example.com","text":"Site"}` |
| `email` | `alice@example.com` | `{"email":"alice@example.com","text":"alice@example.com"}` |
| `email` | `alice@example.com\|Alice` | `{"email":"alice@example.com","text":"Alice"}` |
| `phone` | `+15551234567\|US` | `{"phone":"+15551234567","countryShortName":"US"}` |

`--set-raw` echoes the parsed JsonObject verbatim — agents own
wire-shape correctness; Monday's server-side validation surfaces
as `validation_failed` with Monday's message.

### `item clear <id> <token>`

Per-column clear. Per-type wire payload:
- simple (`text`, `long_text`, `numbers`) → `""`
- rich (`status`, `dropdown`, `date`, `people`, M8 firm row
  `link` / `email` / `phone`) → `{}`

Same envelope as `item set`. Cleared cell shows `text: ""` /
`value: null` (Monday's post-clear shape varies by type; the
projector handles both).

### `item update <id>`

Atomic multi-`--set` and/or `--set-raw`. `--name <new-name>` optional;
can combine with `--set` / `--set-raw` (synthetic `name` column
inside `change_multiple_column_values`). `--set` and `--set-raw`
against the same resolved column ID raise `usage_error` per
cli-design §5.3 mutual-exclusion contract (resolution-time
enforcement — argv-parse can't tell whether two distinct tokens
alias to the same column).

Single-target shape:

```json
{ "data": <projected-item>,
  "meta": { ..., "source": "mixed" },
  "resolved_ids": { "status": "status_4", "date4": "date4" },
  "warnings": [] }
```

### `item update --where ... --board <bid>` (bulk)

Bulk write across `--where` matches. Accepts `--set` and `--set-raw`
in any combination (M8 escape hatch). Without `--yes` or `--dry-run`,
returns `confirmation_required` (exit 1) with `matched_count`,
`where_clauses`, `board_id` in `error.details`.

Bulk live envelope on success aggregates `matched_count` +
per-item results in `data`. Per-item failure decorates the error
envelope with `applied_count` + `applied_to` + `failed_at_item` +
`matched_count` so agents can reconstruct partial progress.

Bulk dry-run aggregates per-item `planChanges` results into one
N-element `planned_changes` array. Both `--set` and `--set-raw`
column-resolution failures fail-fast before the items_page walk
fires (no metadata round-trip wasted on a malformed JSON or a
typo'd column token).

---

## raw

GraphQL escape hatch. `--allow-mutation` + `--operation-name <name>`
gate writes; AST analyser routes between simple-query / multi-op /
mutation paths.

```json
{
  "ok": true,
  "data": { "me": { "id": "7", "name": "Alice", "email": "alice@example.test" } },
  "meta": { ..., "source": "live", ... },
  "warnings": []
}
```

`--dry-run` for mutations returns a `raw_graphql` planned-change shape
per cli-design §6.4 / §9.2 — keys `operation: "raw_graphql"`,
`document_sha256`, `variables_sha256`, `operation_name`,
`document_size_bytes`, `variables_keys`. No bytes go on the wire.

---

## cache

### `cache list`

Lists every cached entry under `XDG_CACHE_HOME/monday-cli`.

```json
{
  "root": "/home/alice/.cache/monday-cli",
  "entries": [],
  "total_entries": 0,
  "total_bytes": 0
}
```

Populated entries carry `{ kind, id, relative_path, bytes, last_modified }`
per row. `meta.source: "none"` (local-only command).

### `cache stats`

Roll-up:

```json
{
  "root": "/home/alice/.cache/monday-cli",
  "exists": false,
  "total_entries": 0,
  "total_bytes": 0
}
```

### `cache clear`

Mutates the local cache.

```json
{
  "scope": "all", "board_id": null,
  "removed": 0, "bytes_freed": 0,
  "root": "/home/alice/.cache/monday-cli"
}
```

`--board <bid>` narrows scope to one board (`scope: "board"`);
`--no-cache` is irrelevant here (this command writes the cache).

---

## config

### `config show`

Snapshot of resolved config — sources, defaults, redaction state.

```json
{
  "auth": "set",
  "api_url": { "state": "explicit", "value": "https://api.monday.com/v2" },
  "api_version": { "state": "default", "value": "2026-01" },
  "profile": { ... },
  "cache": { ... }
}
```

`auth` is `"set"` / `"unset"` — never the literal token. The whole
output is redacted through `utils/redact.ts` (key + value-scanning
filters) before emit.

### `config path`

Where the CLI looks for `.env`. Read-only diagnostic.

```json
{
  "cwd": "/home/alice/code/something",
  "searched": [
    { "kind": "dotenv",
      "path": "/home/alice/code/something/.env",
      "exists": false,
      "description": ".env file in the working directory (loaded with override:false)" }
  ]
}
```

---

## schema

### `monday schema`

Emits JSON Schema 2020-12 for every shipped command. Two-level:
`data.commands` is a map of `<command-name>` →
`{ input: <JSON Schema>, output: <JSON Schema> }`.

```json
{
  "schema_version": "1",
  "commands": {
    "config.show": { "input": { ... }, "output": { ... } },
    "account.whoami": { "input": { ... }, "output": { ... } }
    // ... every shipped command
  }
}
```

`monday schema <command>` narrows to one. `meta.source: "none"`
(local-only). Use this as the agent-facing introspection surface;
no `--help` scraping needed.

---

## Errors

Every error envelope has the same shape (cli-design §6.5):

```json
{
  "ok": false,
  "error": {
    "code": "<stable-error-code>",
    "message": "<human-readable>",
    "http_status": <int|null>,
    "monday_code": "<from API|null>",
    "request_id": "<uuid>",
    "retryable": <bool>,
    "retry_after_seconds": <int|null>,
    "details": { ... }
  },
  "meta": { ... }
}
```

The 26 stable v0.1 error codes — `usage_error`,
`confirmation_required`, `not_found`, `ambiguous_name`,
`ambiguous_column`, `column_not_found`, `user_not_found`,
`unsupported_column_type`, `column_archived`, `unauthorized`,
`forbidden`, `rate_limited`, `complexity_exceeded`,
`daily_limit_exceeded`, `concurrency_exceeded`, `ip_rate_limited`,
`resource_locked`, `validation_failed`, `stale_cursor`,
`config_error`, `cache_error`, `network_error`, `timeout`,
`dev_not_configured`, `dev_board_misconfigured`, `internal_error`.
The two `dev_*` codes are reserved for the v0.3 `monday dev`
namespace — listed but inactive on the v0.1 surface. Warning
codes (`stale_cache_refreshed`, `pagination_cap_reached`,
`column_token_collision`, etc.) live in `warnings[]`, not
`error`. See [cli-design.md §6.5](./cli-design.md#65-error) for
the per-code contract (when it fires, retryable status, what
`details` carries, etc.).

Two representative error-envelope shapes pinned by snapshot:

`board get <missing-id>` → `not_found` (exit 2, stderr):

```json
{
  "ok": false,
  "error": { "code": "not_found", "message": "...",
             "http_status": null, "monday_code": null,
             "request_id": "fixed-req-id",
             "retryable": false, "retry_after_seconds": null,
             "details": { "id": "999", "kind": "board" } },
  "meta": { ..., "source": "live" }
}
```

`account whoami` with no `MONDAY_API_TOKEN` → `config_error` (exit 3,
stderr):

```json
{
  "ok": false,
  "error": { "code": "config_error", "message": "...",
             "http_status": null, "monday_code": null,
             "request_id": "fixed-req-id",
             "retryable": false, "retry_after_seconds": null,
             "details": { "issues": [...] } },
  "meta": { ..., "source": "none", "api_version": "2026-01" }
}
```

---

## Versioning

The output contract is part of the CLI's public surface. Schema
changes follow SemVer:

- **Adding a field** to `data` / `meta` / `warnings` — minor bump
  (no `schema_version` change).
- **Removing or renaming a field** — major bump (`schema_version: "2"`).
- **Retyping a field** (e.g. `string` → `number`) — major bump.

Agents should pin against `meta.schema_version` and treat unknown
fields as additive. The pinned envelope-snapshot suite
(`tests/integration/envelope-snapshots.test.ts`) ensures any
silent drift fails CI.
