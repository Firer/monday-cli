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
| [workspace](#workspace) | list, get, folders, create (M14), update (M14), delete (M14), add-users (M14), remove-users (M14) |
| [board](#board) | list, get, find, describe, columns, groups, subscribers, doctor, create (M15), update (M15), archive (M15), delete (M15), duplicate (M15), add-users (M15), column-create (M16), column-update (M16), column-delete (M16), group-create (M17), group-update (M17), group-archive (M17), group-duplicate (M17), group-delete (M17) |
| [user](#user) | list, get, me |
| [update](#update) | list, get, create, reply (M13), edit (M13), delete (M13), like / unlike / pin / unpin (M13), clear-all (M13) |
| [item (reads)](#item-reads) | list, get, find, search, subitems |
| [item (mutations)](#item-mutations) | set, clear (single + bulk), update (single + bulk), create, archive, delete, duplicate, move, upsert (M12) |
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

### `workspace create --name <n> [--kind open|closed] [--description <d>] [--dry-run]` (M14)

Live envelope's `data` is the projected `Workspace` shape (same as
`workspace get`). `--kind` defaults to `open` when omitted (Monday's
GraphQL signature pins `kind: WorkspaceKind!`; the CLI fills the
default rather than letting the wire reject).

```json
{
  "id": "12345", "name": "Marketing", "description": "EU campaigns",
  "kind": "open", "state": "active", "is_default_workspace": false,
  "created_at": "2026-05-07T11:00:00Z",
  "settings": { "icon": { "color": "#0000FF", "image": null } }
}
```

Dry-run shape per cli-design §6.4 workspace-create variant —
`{operation: "create_workspace", name, kind, description?}` with
`data: null` and `meta.source: "none"`. Idempotent: false (re-running
creates a duplicate workspace; agents needing dedupe call
`workspace list` first).

### `workspace update <wid> [--name <n>] [--kind open|closed] [--description <d>] [--dry-run]` (M14)

Live envelope's `data` is the projected `Workspace` shape post-update.
At least one of `--name` / `--kind` / `--description` is required;
zero-flag invocation surfaces as `usage_error` at argv-parse.

Dry-run shape per cli-design §6.4 workspace-update variant — a field-
level `from → to` diff over the provided fields:

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

Preflight `WorkspaceUpdatePreflight` read fires for the `from` state
(workspace metadata isn't cached in v0.2) — `meta.source: "live"`. When
the preflight returns `[]`, surfaces `not_found` (exit 2) rather than
emitting a would-fail dry-run shape. Idempotent: yes.

### `workspace delete <wid> --yes [--dry-run]` (M14)

Live envelope's `data` is the projected (now-deleted) `Workspace`
shape. `--yes` mandatory (without it the gate fires
`confirmation_required`, exit 1). Dry-run shape per cli-design §6.4
workspace-delete variant — minimal `{operation: "delete_workspace",
workspace_id}` with `meta.source: "none"`.

```json
{
  "id": "12345", "name": "Marketing", "description": "EU campaigns",
  "kind": "open", "state": "deleted", "is_default_workspace": false,
  "created_at": "2026-05-07T11:00:00Z",
  "settings": { "icon": { "color": "#0000FF", "image": null } }
}
```

Re-deleting an already-deleted workspace surfaces `not_found` (the
`delete_workspace: null` payload maps to a typed `not_found`). Missing
mutation root key (schema drift) surfaces as `internal_error`,
distinct from `not_found`. Admin-permission-sensitive — non-admin
callers surface `forbidden` carrying Monday's PERMISSION_DENIED
extension. Idempotent: false.

### `workspace add-users <wid> --users <id|email>,... [--dry-run]` (M14)

**Partial-success envelope** — one wire call per user via
`dispatchSequential`. `--users` accepts numeric IDs and emails mixed
in one comma-separated list; numeric IDs are argv-derived (skip the
resolver), emails flow through M5a's `userByEmail`. M14 omits the
SDK's `kind?: WorkspaceSubscriberKind` argument; relies on Monday's
server-side default (subscriber).

Live envelope shape (cli-design §6.4 partial-success-envelope):

```json
{
  "ok": true,
  "data": {
    "operation": "add_users_to_workspace",
    "results": [
      { "user_id": "67890", "ok": true },
      { "user_id": "67891", "ok": true },
      { "user_id": "ghost@example.test", "ok": false,
        "error": { "code": "user_not_found",
                   "message": "No Monday user matches email \"ghost@example.test\"" } }
    ]
  },
  "meta": { ..., "source": "mixed" },
  "warnings": []
}
```

`data.operation` lives on `data` (not `meta`) per the upsert
precedent; agents key off it to identify the verb. Per-user records:
`user_id` is plain string (not branded `UserId`) because resolution
failures preserve the input token verbatim — emails aren't valid
`UserId` values. `data.results` always present even when every per-
user dispatch failed (envelope is `ok: true` whenever dispatch ran).

Dry-run shape — same per-record array under
`planned_changes[0].results` with `would_apply` substituted for `ok`:

```json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "source": "mixed", ... },
  "planned_changes": [
    {
      "operation": "add_users_to_workspace",
      "workspace_id": "12345",
      "results": [
        { "user_id": "67890", "would_apply": true },
        { "user_id": "ghost@example.test", "would_apply": false,
          "error": { "code": "user_not_found", "message": "..." } }
      ]
    }
  ],
  "warnings": []
}
```

**`meta.source` aggregation** splits dry-run vs live (cli-design §6.4):

- Dry-run sees only resolver legs: all-numeric → `none`; all-email
  cache hits → `cache`; live `users(emails:)` → `live`; combinations
  → `mixed`.
- Live folds in every per-target mutation dispatch leg too (always
  `live`): all-numeric → `live` (dispatch is the only source-bearing
  leg); all-email cache + dispatch → `mixed`; live + dispatch →
  `live`; mixed cache/live + dispatch → `mixed`.

**Whole-call error boundaries:**

- All email `--users` tokens fail resolution AND no numeric remains →
  top-level `user_not_found` (exit 2) carrying
  `details.failed_tokens: [...]`. Mixed calls (numeric + ghost email)
  stay partial-success.
- Malformed `--users` syntax (blank token, non-numeric AND non-email)
  → top-level `usage_error` (exit 1) with
  `details.malformed_tokens: [...]`.
- Missing mutation root key (schema drift) → `internal_error`
  whole-call (`dispatchSequential` re-throws this code so it
  doesn't get papered over per-record).

Idempotent: yes (re-adding an existing member is a Monday-side
no-op). Admin-permission-sensitive.

### `workspace remove-users <wid> --users <id|email>,... [--dry-run]` (M14)

Mirrors `add-users` exactly modulo the operation name —
`delete_users_from_workspace` instead of `add_users_to_workspace` in
both `data.operation` and the dry-run `planned_changes[0].operation`
slot. Same `--users` parser, same partial-success envelope, same
`meta.source` aggregation rule, same whole-call error boundaries.
Idempotent: yes (re-removing a non-member is a no-op). Admin-
permission-sensitive.

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

### `board create --name <n> [--workspace <wid>] [--kind public|private|share] [--template <bid>] [--description <d>] [--dry-run]` (M15)

Live envelope's `data` is the projected `Board` shape (same as
`board get` post-M15 — the cluster shares `boardProjectionSchema`).
`--kind` defaults to `public` when omitted (Monday's GraphQL signature
pins `board_kind: BoardKind!`; the CLI fills the default rather than
letting the wire reject). `--template <bid>` passes Monday's
`template_id` arg — the CLI does NOT pre-validate template-ness
(BoardKind has no `template` value; templates are managed via
Monday's UI, and non-template IDs surface a wire `validation_failed`
re-mapped per cli-design §6.5).

```json
{
  "id": "67890", "name": "Engineering", "description": "Eng team board",
  "state": "active", "board_kind": "public", "board_folder_id": null,
  "workspace_id": "5", "url": "https://x.monday.com/boards/67890",
  "items_count": 0, "updated_at": "2026-05-07T11:00:00Z",
  "permissions": "everyone"
}
```

Dry-run shape per cli-design §6.4 board-create variant —
`{operation: "create_board", name, workspace_id?, kind, description?,
template_id?}` with `data: null` and `meta.source: "none"`. Idempotent:
false (re-running creates a duplicate board; agents needing dedupe
call `board list` first).

### `board update <bid> [--name <n>] [--description <d>] [--dry-run]` (M15)

Live envelope's `data` is the projected `Board` shape post-update.
At least one of `--name` / `--description` is required; zero-flag
invocation surfaces as `usage_error` at argv-parse.

**Wire shape divergence** from `update_workspace`: Monday's
`update_board(board_id, board_attribute: BoardAttributes!,
new_value: String!)` is **per-attribute**, so multi-flag invocation
fans out N sequential `BoardUpdate` calls. The CLI keeps a single
`ok: true` envelope on whole-call success and a single `ok: false`
envelope on any per-field failure — the multi-call wire shape
doesn't leak as partial-success. **Server-side state is NOT
transactional**: per-field calls earlier in the sequence stay
committed when a later call fails.

**Force-live final read.** The post-mutation `boards(ids:)` read
MUST bypass the v0.1 board-metadata cache so the success envelope
reflects post-update state. The CLI fires the final read via
`client.raw` directly rather than `loadBoardMetadata`;
`meta.source: "live"` for the success path. M16's eager-
invalidation contract additionally invalidates the cache entry
post-success so downstream commands see fresh state too (see §3
M16 retrofit clause).

Dry-run shape per cli-design §6.4 board-update variant — a field-
level `from → to` diff over the provided fields:

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
        "description": { "from": "Eng team board", "to": "EU region" }
      }
    }
  ],
  "warnings": []
}
```

Preflight `BoardMetadata` read goes through `loadBoardMetadata` so
cache hits are observable; `meta.source: 'live' | 'cache'`. Cache-
staleness caveat applies — agents pass `--no-cache` for force-live
preview when freshness is critical. When the preflight returns no
board, surfaces `not_found` (exit 2). Idempotent: yes.

### `board archive <bid> --yes [--dry-run]` (M15)

Live envelope's `data` is the projected (now-archived) `Board`
shape. `--yes` mandatory (without it the gate fires
`confirmation_required`, exit 1; gate fires BEFORE `resolveClient`
so a missing token still surfaces `confirmation_required`, not
`config_error`).

```json
{
  "id": "12345", "name": "Engineering", "description": "Eng team",
  "state": "archived", "board_kind": "public", "board_folder_id": null,
  "workspace_id": "5", "url": "https://x.monday.com/boards/12345",
  "items_count": 0, "updated_at": "2026-05-07T11:00:00Z",
  "permissions": "everyone"
}
```

Dry-run shape per cli-design §6.4 board-archive variant — carries
the source snapshot via preflight `BoardMetadata` read (cache-able):

```json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "source": "cache", "cache_age_seconds": 42, ... },
  "planned_changes": [
    {
      "operation": "archive_board",
      "board_id": "12345",
      "board": {
        "id": "12345", "name": "Engineering", "description": "Eng team",
        "state": "active", "board_kind": "public", "board_folder_id": null,
        "workspace_id": "5", "url": "https://x.monday.com/boards/12345",
        "items_count": null, "updated_at": "2026-05-07T11:00:00Z",
        "permissions": null
      }
    }
  ],
  "warnings": []
}
```

`items_count` and `permissions` may be `null` in the dry-run
snapshot when the underlying cassette doesn't carry them (the
live BOARD_METADATA_QUERY selection includes them post-M15;
older cache entries serve null until refresh). Cache-staleness
caveat applies — agents pass `--no-cache` for force-live
preflight when freshness is critical (e.g. archiving after a
recent rename).

Re-archiving an already-archived board is a Monday-side no-op
(idempotent: yes per cli-design §9.1). Missing mutation root key
(schema drift) surfaces as `internal_error`, distinct from
`not_found` (board missing).

### `board delete <bid> --yes [--dry-run]` (M15)

Live envelope's `data` is the projected (now-deleted) `Board` shape.
Same gate ordering as `board archive`. **Note the deliberate
divergence from `board archive`**: archive carries the source
snapshot in dry-run (item-archive precedent — soft, reversible-
via-30-day-window), delete is minimal in dry-run (workspace-delete
precedent — hard, irrecoverable past Monday's 30-day window). Both
patterns preserved.

Dry-run shape per cli-design §6.4 board-delete variant — minimal
`{operation: "delete_board", board_id}` with `data: null` and
`meta.source: "none"`. No preflight read fires.

```json
{
  "id": "12345", "name": "Engineering", "description": "Eng team",
  "state": "deleted", "board_kind": "public", "board_folder_id": null,
  "workspace_id": "5", "url": "https://x.monday.com/boards/12345",
  "items_count": 0, "updated_at": "2026-05-07T11:00:00Z",
  "permissions": "everyone"
}
```

Re-deleting an already-deleted board surfaces `not_found` (the
`delete_board: null` payload maps to a typed `not_found`). Missing
mutation root key (schema drift) surfaces as `internal_error`,
distinct from `not_found`. Idempotent: false.

### `board duplicate <bid> [--name <n>] [--workspace <wid>] [--with-updates] [--dry-run]` (M15)

**The M15-unique wrapped envelope shape.** Live envelope's `data`
wraps because Monday's `duplicate_board` returns
`BoardDuplication { board, is_async }` (SDK 14.0.0 type) — both
fields are load-bearing for agents. cli-design §6.1 universal
envelope widening (round-2 F3) acknowledged this case; the
wrapper is M15's documented example.

```json
{
  "ok": true,
  "data": {
    "board": {
      "id": "67890", "name": "Engineering (Copy)", "description": "Eng team",
      "state": "active", "board_kind": "public", "board_folder_id": null,
      "workspace_id": "5", "url": "https://x.monday.com/boards/67890",
      "items_count": 7, "updated_at": "2026-05-07T11:00:00Z",
      "permissions": "everyone"
    },
    "is_async": false
  },
  "meta": { ..., "source": "live" },
  "warnings": []
}
```

When `is_async: true`, Monday has queued the duplication server-
side and the new board may not be fully populated by envelope
time; agents needing to operate on the duplicated items / updates
poll `boards(ids: [<new_id>]) { state }` until terminal state.
When `is_async: false`, the duplication has fully landed and
immediate follow-up reads are safe.

`--with-updates` flag mapping (cli-design §4.3): false →
`duplicate_board_with_pulses` (items WITHOUT updates); true →
`duplicate_board_with_pulses_and_updates` (items WITH updates).
The third DuplicateBoardType arm
(`duplicate_board_with_structure` — skeleton without items) is
deferred; `dev mutate` is the v0.2 escape hatch.

`--name` and `--workspace` are optional; defaults to `<source
name> (Copy)` and source's workspace respectively. Both filter
undefined out of the variables map rather than send null.

Dry-run shape per cli-design §6.4 board-duplicate variant —
single-leg with preflight `BoardMetadata` read for the source-
board snapshot:

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
      "target_workspace_id": "99",
      "target_name": "Engineering — EU",
      "board": { "id": "12345", "name": "Engineering", ... }
    }
  ],
  "warnings": []
}
```

`target_workspace_id` and `target_name` slots appear only when the
agent provided `--workspace` / `--name`. Cache-staleness caveat
applies. Idempotent: false (re-running creates a second copy).

### `board add-users <bid> --users <id|email>,... [--dry-run]` (M15)

Mirrors `workspace add-users` exactly modulo the operation name —
`add_users_to_board` instead of `add_users_to_workspace` in both
`data.operation` and the dry-run `planned_changes[0].operation`
slot, and `board_id` instead of `workspace_id` in
`planned_changes[0]`. Same `--users` parser, same partial-success
envelope, same `meta.source` aggregation rule, same whole-call
error boundaries (top-level `user_not_found` when no dispatchable
id remains; `usage_error` for malformed --users syntax;
`internal_error` for missing mutation root key).

Live envelope shape:

```json
{
  "ok": true,
  "data": {
    "operation": "add_users_to_board",
    "results": [
      { "user_id": "67890", "ok": true },
      { "user_id": "67891", "ok": true },
      { "user_id": "ghost@example.test", "ok": false,
        "error": { "code": "user_not_found",
                   "message": "No Monday user matches email \"ghost@example.test\"" } }
    ]
  },
  "meta": { ..., "source": "mixed" },
  "warnings": []
}
```

M15 omits the SDK's `kind?: BoardSubscriberKind` argument; relies
on Monday's server-side default (subscriber). Owner-tier and
explicit subscriber-kind selection deferred to a later milestone.
Idempotent: yes (re-adding an existing member is a Monday-side
no-op).

`board add-users` is the **third partial-success-fan-out
consumer** (after M14's workspace add-users + remove-users); the
shared null-payload guard `assertResponseFieldPresent`
(`src/api/response-root.ts`) lifted at M15 close per §22 R41. The
larger §22 R40 lift (`dispatchUsersFanOut` factory) stays
deferred to the M15 → M16 cleanup window.

### `board column-create <bid> --type <type> --title <t> [--description <d>] [--settings <json>] [--dry-run]` (M16)

Live envelope's `data` is the projected `Column` shape (`{id,
title, type, description, archived, settings_str, width}` —
matches `boardMetadataSchema.columns[*]` so a follow-up `board
describe` returns the same shape).

```json
{
  "id": "status_4", "title": "Priority", "type": "status",
  "description": "Owner-set urgency", "archived": false,
  "settings_str": "{\"labels\":[\"Low\",\"Med\",\"High\"]}",
  "width": 120
}
```

**Wire shape pin**: `--settings <json>` maps to the wire's
`defaults: JSON` argument (NOT `settings_str: String!` —
`settings_str` is the read-side serialisation on `Column`;
`defaults` is the write-side input on `create_column`). The CLI
flag stays `--settings` for agent ergonomics.

**`--type` validation**: argv-parses against the full Monday
`ColumnType` enum (~40 values per SDK 14.0.0). Types outside
`WRITABLE_COLUMN_TYPES` proceed (Monday accepts them) but emit a
`noncanonical_column_type` warning per cli-design §6 stable
warning-code registry:

```json
{
  "code": "noncanonical_column_type",
  "message": "Column type \"country\" was created successfully but is not in the v0.2 writable allowlist...",
  "details": {
    "column_type": "country",
    "category": "raw_writable",
    "suggested_write_path": "--set-raw <col>=<json>"
  }
}
```

`category` is a stable enum: `"raw_writable"` (suggests
`--set-raw <col>=<json>`), `"read_only_forever"` (`suggested_
write_path: null` — no write path; covers mirror / formula /
auto_number / creation_log / last_updated / item_id /
item_assignees), `"files_shaped"` (suggests `add_file_to_column`
deferred to v0.4 — currently `file` only). Adding a category
value is SemVer-minor; removing/renaming is SemVer-major. The
warning fires on dry-run too so the live call's behaviour is
predictable.

**`--settings` per-type validation**: parsed at argv-parse-time
(malformed JSON → `usage_error`, exit 1, before any network
call). For types in `WRITABLE_COLUMN_TYPES`, validated against
a per-type zod schema (status: `{labels?}`; dropdown:
`{labels?}`; numbers: `{unit?}`; text / long_text / date /
people / link / email / phone: empty `{}`). Type-mismatched
settings (e.g. `--type text --settings '{"labels":[]}'`) →
`usage_error` with `details: {column_type, expected_keys,
actual_keys, hint}`. Raw-writable / read-only-forever / files-
shaped types skip type-specific validation (well-formed JSON
only; Monday validates server-side).

Dry-run shape per cli-design §6.4 column-create variant —
minimal `{operation: "create_column", board_id, type, title,
description?, settings?}` with `data: null` and `meta.source:
"none"`. No preflight read fires.

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

**Eager invalidation** per cli-design §8 single-leg call-site
contract: `invalidateBoard(boardId)` fires AFTER the success
envelope's `data` projection completes, BEFORE emitMutation
returns. Subsequent same-process reads see fresh state without
waiting for TTL eviction.

Re-running creates a SECOND column with the same title (Monday
auto-generates a fresh column id per call). Idempotent: false.

### `board column-update <bid> <cid> [--title <t>] [--description <d>] [--dry-run]` (M16)

Live envelope's `data` is the projected `Column` shape — same
fields as `column-create`, sourced from the **trailing per-
attribute wire-call's response** (no force-live final read leg
fires; Monday's column mutations return `Maybe<Column>` post-
mutation, so the trailing call's response is authoritative for
both fields).

**Wire shape — per-attribute fan-out across two surfaces**:
`--title` routes to `change_column_title(board_id, column_id,
title)`; `--description` routes to `change_column_metadata(
board_id, column_id, column_property: "description", value)`.
The `ColumnProperty` enum (SDK 14.0.0) carries only `title` /
`description`; the CLI routes `--title` to the more specific
`change_column_title` surface (NOT
`change_column_metadata({column_property: "title"})`). Multi-
flag invocations fan out N sequential calls per cli-design §8
decision 8.

**Whole-call envelope — no partial-success leak.** `ok: true`
only when EVERY per-field call succeeds; on any per-field
failure the envelope is `ok: false` with the failed call's
mapped error code. **Server-side state is NOT transactional**:
per-field calls earlier in the sequence stay committed when a
later call fails.

At least one of `--title` / `--description` is required; zero-
flag invocation surfaces as `usage_error` at argv-parse.

Dry-run shape per cli-design §6.4 column-update variant — a
field-level `from → to` diff per provided field. The `from`
state requires a preflight `boards(ids:)` read (cache-able):

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

When the preflight read returns no board → `not_found` (exit 2).
When the column ID is missing on the board → `not_found` with
`details: {board_id, column_id}`.

**Eager invalidation** per cli-design §8 fan-out call-site
contract: `invalidateBoard(boardId)` fires ONCE after the per-
attribute loop settles iff at least one leg succeeded
(`succeededLegs > 0` high-water-mark counter). Whole-call
success path AND partial-application failure path both
invalidate; zero-legs-succeeded skips. Idempotent: yes.

### `board column-delete <bid> <cid> --yes [--dry-run]` (M16)

Live envelope's `data` is the projected (now-deleted) `Column`
shape — Monday's `delete_column(board_id, column_id)` returns
`Maybe<Column>` carrying the column's last-look projection.

**Confirmation gate** per cli-design §3.1 #7: `--yes` is
mandatory for the live path. Without `--yes` AND without
`--dry-run` the command fails fast with `confirmation_required`
(exit 1). The envelope carries the **two-tuple** `details`
shape per cli-design §6.5 single-target destructive-gate (the
wire signature is two-tuple):

```json
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "message": "monday board column-delete status_4 would delete column status_4 from board 12345...",
    "details": {
      "board_id": "12345",
      "column_id": "status_4",
      "hint": "delete is destructive — Monday has no archive_column / restore_column mutation..."
    }
  },
  "meta": { ..., "source": "none" }
}
```

Gate fires BEFORE `resolveClient` so a missing token still
surfaces `confirmation_required`, not `config_error` (M10
round-1 P2 ordering invariant; R29 helper preserves it via
already-parsed `globalFlags`). `--dry-run` bypasses the gate
entirely (per §3.1 #7 — dry-run is non-executing).

Dry-run shape per cli-design §6.4 column-delete variant —
minimal `{operation: "delete_column", board_id, column_id}` with
`data: null` and `meta.source: "none"`. No preflight read; same
destructive-no-read pattern as `item delete` / `update delete` /
`workspace delete` / `board delete`.

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

**Eager invalidation** per cli-design §8 single-leg call-site
contract: `invalidateBoard(boardId)` fires AFTER `data`
projection on success. Skipped on the error path (a failed
delete didn't change board state).

Re-deleting an already-deleted column surfaces `not_found` (the
`delete_column: null` payload maps to a typed `not_found`).
Missing mutation root key (schema drift) surfaces as
`internal_error`, distinct from `not_found`. Idempotent: false.
**Note**: Monday has no `archive_column` mutation — column
lifecycle is delete-only; the CLI doesn't surface a `column-
archive` verb.

`board column-delete` is the first **two-tuple destructive
verb** — R29's `enforceDestructiveGate` helper grew an
`extraDetails` slot in M16 to support it (carrying `board_id`
alongside the canonical `column_id` detailKey). The existing
seven single-id consumers stay byte-identical post-extension;
M17's group-archive + group-delete reuse the same slot.

### `board group-create <bid> --name <n> [--color <c>] [--dry-run]` (M17)

Single round-trip via `create_group(board_id, group_name,
group_color?)`. Returns the projected new group; `data` shape
mirrors `boardMetadataSchema.groups[*]` for byte-identical
read-side / write-side projections.

```json
{
  "ok": true,
  "data": {
    "id": "sprint_42",
    "title": "Sprint 42",
    "color": "blue",
    "position": "1.0",
    "archived": false,
    "deleted": false
  },
  "meta": { "source": "live", ... },
  "warnings": []
}
```

`--color` is argv-parse validated against `GROUP_COLOR_VALUES`
in `src/api/group-color.ts` (41-name palette covering Monday's
documented group colours); bogus colour names surface as
`usage_error` (exit 1) BEFORE any network call. Both `group-
create` and `group-update` consume the same constant via
`z.enum(GROUP_COLOR_VALUES)` so a colour accepted by create
round-trips through update without surprise rejections.

`--position top|bottom` and the relative-position pair
(`position_relative_method` + `relative_to`) are deferred to
v0.3 — the v0.2 surface omits all three placement arguments;
agents needing placement use M9's `dev mutate` escape hatch.

Calls `invalidateBoard(boardId)` post-success per cli-design §8
single-leg call-site contract via R46's
`withBoardInvalidationSingleLeg`.

Dry-run shape (purely argv-derived; `meta.source: "none"`):

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

`color` is omitted from the planned change when `--color` is
absent.

### `board group-update <bid> <gid> [--name <n>] [--color <c>] [--dry-run]` (M17)

Per-attribute fan-out across the **single** `update_group(
board_id, group_id, group_attribute: GroupAttributes!,
new_value: String!)` wire surface. CLI flag mapping: `--name` →
`group_attribute: title`, `--color` → `group_attribute: color`.
At least one of `--name` / `--color` required.

**Trailing per-attribute call's response is authoritative for
data — NO force-live read leg fires.** Distinguishes group-update
from board-update; this is the load-bearing M17-pre-flight
finding. Monday's `update_group` returns the FULL `Maybe<Group>`
post-mutation, so the trailing call's response covers every
group-metadata field. Mirrors column-update's no-force-live shape;
diverges from board-update (whose per-attribute calls return only
the changed slice, requiring a final whole-board read leg).

```json
{
  "ok": true,
  "data": { "id": "topics", "title": "Sprint 42", "color": "red",
            "position": "1.0", "archived": false, "deleted": false },
  "meta": { "source": "live", ... },
  "warnings": []
}
```

Whole-call envelope is `ok: true` only when EVERY per-attribute
call succeeded; on any per-field failure, the envelope is
`ok: false` with the failed call's error code. Server-side state
is NOT transactional across per-attribute calls.

Calls `invalidateBoard(boardId)` ONCE after the per-attribute
loop settles via R46's `withBoardInvalidationFanOut`, conditional
on at least one per-attribute call having succeeded (the wire-
state high-water mark per cli-design §8 fan-out call-site
contract).

Dry-run shape: field-level `from → to` diff per provided field,
sourced from a preflight `loadBoardMetadata` read (`meta.source:
"live" | "cache"`). Diff keys are `name` / `color` (the CLI-flag-
side names; the wire-level `title` rename happens at the dispatch
layer):

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
        "color": { "from": "blue", "to": "red" }
      }
    }
  ],
  "warnings": []
}
```

When the preflight read returns `not_found` for the board OR
doesn't contain a group with the requested ID, the dry-run
surfaces `not_found` (exit 2) with `details.group_id` pinned
(distinguishing "wrong board id" from "wrong group id").

### `board group-archive <bid> <gid> --yes [--dry-run]` (M17)

Destructive verb — `--yes` mandatory for live archive.
**Two-tuple `confirmation_required` envelope** carries
`{board_id, group_id, hint}` per cli-design §6.5 single-target
shape (R29's `extraDetails` slot; group-archive is the 2nd
two-tuple consumer after M16 column-delete). The gate fires
BEFORE `resolveClient()` so a missing token still surfaces
`confirmation_required` (M10 round-1 P2 ordering invariant).

```json
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "message": "monday board group-archive topics would archive group topics on board 12345...",
    "details": {
      "board_id": "12345",
      "group_id": "topics",
      "hint": "archive is destructive — Monday retains archived groups but exposes no unarchive_group mutation..."
    }
  },
  "meta": { "source": "none", ... }
}
```

Idempotent: re-archiving an already-archived group is a no-op on
Monday's side per §9.1. Calls `invalidateBoard(boardId)` post-
success via R46's `withBoardInvalidationSingleLeg`. Live envelope
returns the projected (archived) group.

Dry-run shape: **snapshot-bearing** (mirrors `board archive`'s
shape; diverges from `column-delete` / `board-delete` /
`group-delete`'s minimal destructive-no-read shape). The cached
`boardMetadataSchema.groups[*]` projection covers the full Group
metadata field set, so the snapshot carries every field agents
need for "preview before archive" without a separate read query:

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

### `board group-duplicate <bid> <gid> [--name <n>] [--dry-run]` (M17)

Single round-trip via `duplicate_group(board_id, group_id,
group_title?)`. **Load-bearing divergence from sibling duplicate
verbs** — `monday item duplicate` and `monday board duplicate`
both surface `--with-updates` (mapping to wire `with_updates:
Boolean`); `monday board group-duplicate` does NOT, because
Monday's `duplicate_group` wire signature has no equivalent
argument. The M17 pre-flight pinned the wire truth and dropped
the flag.

`--name <n>` maps to wire `group_title?` (when omitted, Monday's
wire-side default naming applies — typically `"<source name>
(copy)"`, but the exact convention is server-side and not pinned
by the CLI). Returns the projected new (duplicated) group.

Idempotent: false (every call creates a new group with a fresh
ID). Calls `invalidateBoard(boardId)` post-success via R46's
`withBoardInvalidationSingleLeg`.

Dry-run shape: minimal `{operation: "duplicate_group", board_id,
group_id, name?}`. No preflight read leg fires (`meta.source:
"none"` — mirrors `column-delete`'s no-read pattern, even though
group-duplicate is non-destructive; the agent already knows what
they're duplicating via the positional, and the wire reports
`not_found` if the IDs are bogus).

### `board group-delete <bid> <gid> --yes [--dry-run]` (M17)

Destructive verb — `--yes` mandatory. **3rd two-tuple
`confirmation_required` consumer** after column-delete +
group-archive; envelope echoes `{board_id, group_id, hint}` per
cli-design §6.5 single-target shape.

```json
{
  "ok": false,
  "error": {
    "code": "confirmation_required",
    "message": "monday board group-delete topics would delete group topics from board 12345...",
    "details": {
      "board_id": "12345",
      "group_id": "topics",
      "hint": "delete is destructive — Monday retains deleted groups past their retention window; pass --dry-run first to preview, or use monday board group-archive for a recoverable hide..."
    }
  },
  "meta": { "source": "none", ... }
}
```

Idempotent: false (re-deleting surfaces `not_found` past the
first call). Calls `invalidateBoard(boardId)` post-success via
R46's `withBoardInvalidationSingleLeg`. Live envelope returns the
projected (last-look) group.

Dry-run shape: **minimal** `{operation: "delete_group", board_id,
group_id}` (mirrors `workspace-delete` / `board-delete` /
`column-delete`'s destructive-no-read pattern). Note the
deliberate divergence from `group-archive`'s snapshot-bearing
dry-run: archive carries the source snapshot (recoverable
destructive — preview shows what will be hidden); delete is
minimal (irrecoverable destructive past Monday's retention
window — the agent already knows what they're deleting).

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

### `update list <item-id>` / `update list --board <bid>` (M13)

Collection of comments. Per-item via positional `<iid>`; per-board via
`--board <bid>` (mutually exclusive). **v0.2 breaking change**:
`replies: [...]` is empty by default; pass `--with-replies` to populate.
v0.1 silently populated replies on every call; v0.2 makes the nested
selection opt-in because Monday charges complexity for it.

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

With `--with-replies`, each update's `replies: [...]` contains the
nested reply records (`id`, `body`, `text_body`, `creator_id`,
`created_at`).

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

### `update reply <parent-id> --body <md>` (M13)

Posts a reply to an existing update via Monday's `create_update(parent_
id, body)`. Same body-source plumbing as `update create`. **Not
idempotent** — each call creates a new reply. The envelope echoes
`parent_id` from argv into `data` so an agent has the lineage handy
without consulting `monday update get`.

```json
{
  "data": { "id": "88", "body": "<p>Acknowledged.</p>",
            "text_body": "Acknowledged.",
            "creator_id": "1",
            "creator": { "id": "1", "name": "Alice", "email": "alice@example.test" },
            "item_id": "12345",
            "parent_id": "77",
            "created_at": "2026-04-30T11:30:00Z",
            "updated_at": "2026-04-30T11:30:00Z" }
}
```

`--dry-run` carries `operation: "create_update"`, `parent_id`, `body`,
`body_length`. `meta.source: "none"`.

### `update edit <update-id> --body <md>` (M13)

Replaces the body of an existing update. Idempotent (re-editing with
the same body is a server-side no-op). Returns the projected update.
Null wire result → `not_found` carrying `details.update_id`.
`--dry-run` carries `operation: "edit_update"`, `update_id`, `body`,
`body_length`. `meta.source: "none"`.

### `update delete <update-id> --yes` (M13)

Deletes an update. **Destructive** — `--yes` mandatory; without it
exits 1 with `confirmation_required` (gate fires before
`resolveClient` per the M10 round-1 P2 ordering invariant). Returns
the projected deleted update. `--dry-run` is the minimal `{operation:
"delete_update", update_id}` shape with `meta.source: "none"` (no
preflight read fires).

### `update like` / `unlike` / `pin` / `unpin <update-id>` (M13)

Toggle verbs. Idempotent on Monday's side (re-running is a server-
side no-op). Each returns the projected update. Per-mutation SDK
divergence captured at the dispatch site: `like_update` /
`unlike_update` take `update_id`; `pin_to_top` / `unpin_from_top`
take `id`. `--dry-run` carries `{operation: "<mutation_name>",
update_id}` with `meta.source: "none"`.

### `update clear-all <item-id> --yes` (M13 — partial-success envelope)

Deletes every update on an item. **Destructive** — `--yes`
mandatory. **Partial-success envelope** per cli-design §6.4 / v0.2-
plan §1 universal rule. The CLI page-walks `updates(item_id)`, then
sequentially calls `delete_update` per collected ID. Per-update
failures land in `data.results[i].error` rather than aborting the
loop.

```json
{
  "ok": true,
  "data": {
    "results": [
      { "update_id": "77", "ok": true },
      { "update_id": "78", "ok": false,
        "error": { "code": "forbidden",
                   "message": "Permission denied" } },
      { "update_id": "82", "ok": true }
    ]
  },
  "meta": { ..., "source": "live" },
  "warnings": []
}
```

The envelope is **always `ok: true` when dispatch ran** — whole-call
success means the page-walk + dispatch loop completed; per-target
outcomes live in `data.results`. Top-level `error` (`ok: false`) is
reserved for whole-call failure (item not_found, couldn't reach
API). Re-running on an empty thread emits `results: []` (idempotent).

`--dry-run` page-walks for would-delete IDs without firing any
delete:

```json
{
  "ok": true, "data": null,
  "meta": { ..., "dry_run": true, "source": "live" },
  "planned_changes": [
    { "operation": "clear_all_updates",
      "item_id": "12345",
      "update_ids": ["77", "78", "82"] }
  ]
}
```

`meta.source: "live"` because the page-walk fired real reads.

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

### `item clear --board <bid> <col> --where ...` (bulk)

Bulk clear across `--where` matches (M12). Without `--yes` or
`--dry-run`, returns `confirmation_required` (exit 1) with
`matched_count`, `where_clauses`, `board_id` in `error.details` —
same shape bulk `item update --where` ships.

Bulk live envelope on success aggregates `matched_count` +
per-item results in `data` (mirrors bulk update's shape):

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
  "meta": { ..., "source": "mixed" },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

Per-item failure decorates the error envelope with `applied_count`
+ `applied_to` + `failed_at_item` + `matched_count` so agents can
reconstruct partial progress (same shape bulk update uses).

Bulk dry-run aggregates per-item `planClear` results into one
N-element `planned_changes` array, deduplicating resolver warnings
by code+message+token. Empty match set → clean no-op envelope (no
confirmation gate — `--yes` shouldn't be required to confirm "no
items matched"). The bulk path requires `--board <bid>`; mixing a
positional `<iid>` with `--where`/`--filter-json` raises
`usage_error`.

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

### `item create --board <bid> --name <n> [--set ...] [--set-raw ...] [--group ...] [--position ... --relative-to ...]`

Top-level item create (M9). All `--set` / `--set-raw` values bundle
into the single `create_item.column_values` parameter — single
round-trip per cli-design §5.8; partial-success fallback is
intentionally absent.

```json
{
  "ok": true,
  "data": {
    "id": "99001",
    "name": "Refactor login",
    "board_id": "67890",
    "group_id": "topics"
  },
  "meta": { ..., "source": "mixed", ... },
  "warnings": [],
  "resolved_ids": { "status": "status_4", "due": "date_4" }
}
```

`group_id` is `null` if Monday returned no group on the response
(rare; the projector tolerates the shape). `--position before|after
--relative-to <iid>` requires both flags; CLI verifies `--relative-to`
is on the same `--board` before the mutation fires (mirrors M5b's
wrong-board check).

### `item create --parent <iid> --name <n> [--set ...] [--set-raw ...]`

Subitem create (M9, classic boards only). The CLI looks up the parent
item to verify `hierarchy_type` and (when `--set` / `--set-raw` is
present) derive the auto-generated subitems board from the parent's
`subtasks` column's `settings_str.boardIds[0]`.

```json
{
  "ok": true,
  "data": {
    "id": "99100",
    "name": "Subtask 1",
    "board_id": "333",
    "group_id": "subitems_topic",
    "parent_id": "12345"
  },
  "meta": { ..., "source": "live", ... },
  "warnings": [],
  "resolved_ids": { "status": "sub_status_1" }
}
```

Multi-level boards (`hierarchy_type: "multi_level"`) are rejected
pre-mutation with `usage_error` carrying `details.hierarchy_type` +
`details.deferred_to: "v0.3"`. `--parent` is mutually exclusive with
`--board`, `--group`, and `--position` / `--relative-to`. `--set` /
`--set-raw` columns resolve against the **subitems board**, not the
parent's board.

`--dry-run` for both branches per cli-design §6.4 "Item-create shape".
Top-level emits `operation: "create_item"` with hoisted `board_id` /
`name` / `group_id` / `position` slots; subitem emits `operation:
"create_subitem"` with hoisted `parent_item_id` and **omits**
`board_id` (subitems-board derivation is server-side). `diff[<col>].
from` is always `null` (item doesn't exist yet).

### `item upsert --board <bid> --name <n> --match-by <col>[,<col>...] [--set ...] [--set-raw ...] [--dry-run]`

Idempotency-cluster verb (M12). Looks up items matching the
`--match-by` predicate and branches: 0 matches → `create_item`; 1
match → `change_multiple_column_values` with synthetic `name` (same
wire shape as `item update --name --set`); 2+ matches →
`ambiguous_match` (no mutation fires).

Live envelope (create branch — same projection as `item create` /
`item get` plus the `data.operation` discriminator):

```json
{
  "ok": true,
  "data": {
    "id": "99001",
    "name": "Refactor login",
    "board_id": "111",
    "group_id": "topics",
    "parent_item_id": null,
    "state": "active",
    "url": "https://example.monday.com/items/99001",
    "created_at": "2026-05-02T10:00:00Z",
    "updated_at": "2026-05-02T10:00:00Z",
    "columns": { "status_4": { ... } },
    "operation": "create_item"
  },
  "meta": { ..., "source": "mixed" },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

Live envelope (update branch — `data.operation: "update_item"`,
otherwise the same shape):

```json
{
  "ok": true,
  "data": {
    "id": "12345",
    ...,
    "operation": "update_item"
  },
  "meta": { ..., "source": "mixed" },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

`data.operation` is always present on the live envelope and is the
branch discriminator; agents key off `operation` to know whether
the call created a fresh item or updated an existing one. The slot
lives on `data` rather than `meta` because v0.1's mutation envelope
already keeps operation-shape signals in `data` (e.g.
`duplicated_from_id` for `item duplicate`); `meta` is reserved for
cross-verb cache / source / pagination state. `resolved_ids` echoes
the same token → column-ID map every column-mutation envelope
carries. `warnings` may include `column_token_collision` /
`stale_cache_refreshed` from the lookup-leg or update-leg column
resolver.

Dry-run envelope (verb-level operation rewrite — both branches):

```json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "source": "mixed", ... },
  "planned_changes": [
    {
      "operation": "create_item",
      "board_id": "111",
      "name": "Refactor login",
      "resolved_ids": { "status": "status_4" },
      "diff": { "status_4": { "from": null, "to": { "label": "Backlog" } } },
      "match_by": ["name"],
      "matched_count": 0
    }
  ],
  "warnings": []
}
```

Update branch dry-run carries `operation: "update_item"`,
`item_id`, the would-rename `name` slot (echoes `--name <n>`), and
the diff shape `change_multiple_column_values` would have produced.
The `match_by` and `matched_count` slots are M12-specific echoes —
agents reading the dry-run know exactly what the lookup found
without re-issuing the query.

Errors (M12-specific):

- `ambiguous_match` (exit 2) — 2+ matches. Carries
  `details.board_id`, `details.match_by`, `details.match_values`,
  `details.matched_count`, `details.candidates: [{id, name}, ...]`
  (capped at 10). Agents tighten the predicate (add another
  `--match-by` column or use a stable hidden-key column) and re-run.

`--match-by` accepts column tokens (resolved via the same column
resolver `--set` uses) plus the literal `name` pseudo-token, which
matches against the item's `name` field. Each non-`name` token
requires a corresponding `--set <token>=<value>` (the upsert pulls
the match value from `--set` so the create-branch wire payload and
the lookup share one source of truth). `--set-raw <col>=<json>`
participates in column updates but **cannot appear in `--match-by`**
(the JSON wire shape isn't a filter-comparable scalar — the parser
rejects with `usage_error`).

**Sequential-retry idempotent only.** Re-running with the same args
from the same agent yields one item — the second call sees the
just-created item and branches to `update_item`. Concurrent agents
observing zero matches at the same instant both branch to
`create_item`; the next call surfaces the duplicate as
`ambiguous_match`. Concurrent-write protection is a v0.4 candidate.

**Match-value caveats (per column kind).** The lookup pipeline
and the `--set` translator have asymmetric grammars in v0.2, so
`--match-by` only round-trips cleanly on a subset of column kinds:

- **Always safe:** `name` (item-name pseudo-token), `text` /
  `long_text`, `numbers`, external_id-shaped hidden text.
- **Safe via label-text:** `status` / `dropdown` (pass the label
  name).
- **Restricted to one value:** `people` — only `me` round-trips.
  Emails resolve in `--set` but pass verbatim in lookup (→
  duplicate); raw numeric user IDs are rejected by the people
  `--set` grammar (cli-design §5.3, M5b).
- **Not v0.2-safe:**
  - `date` — Monday's items_page filter requires `["EXACT",
    "YYYY-MM-DD"]` for date-equals; the lookup leg sends bare
    ISO, so upserts duplicate on rerun.
  - `link` / `email` / `phone` — the rich `scalar|text` write
    grammar produces a structured payload, but the lookup leg
    sends the literal pipe string, which doesn't match Monday's
    stored shape.

**Recommended canonical pattern.** Stable hidden text /
external_id-shaped column as the synthetic key. cli-design §5.8
covers the per-kind breakdown + v0.3 cross-surface follow-up
roadmap in long form.

### `item archive <iid> --yes [--dry-run]`

Archive an item via Monday's `archive_item` mutation (M10). `--yes`
mandatory for the live path; without `--yes` (and without
`--dry-run`) returns `confirmation_required` (exit 1) with
`details.item_id` + a recovery-window hint. `--dry-run` exempts the
gate per cli-design §10.2.

Live envelope (single-resource — same projection as `item get`,
state flips to `"archived"`):

```json
{
  "ok": true,
  "data": {
    "id": "12345",
    "name": "Refactor login",
    "board_id": "111",
    "group_id": "topics",
    "parent_item_id": null,
    "state": "archived",
    "url": "https://example.monday.com/items/12345",
    "created_at": "2026-04-29T10:00:00Z",
    "updated_at": "2026-04-29T11:00:00Z",
    "columns": { ... }
  },
  "meta": { ..., "source": "live", ... },
  "warnings": []
}
```

Dry-run envelope (`data: null`, `meta.dry_run: true`,
`planned_changes: [{operation: "archive_item", item_id, item:
<projected snapshot>}]`):

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "live", ... },
  "planned_changes": [
    {
      "operation": "archive_item",
      "item_id": "12345",
      "item": <projected snapshot — same shape as live data>
    }
  ],
  "warnings": []
}
```

`meta.source: "live"` for both paths because the dry-run still reads
the source item to verify the ID. Idempotent on the wire (cli-design
§9.1) — re-archiving an archived item is a no-op; the CLI marks
`idempotent: true`. `not_found` (exit 2) when the ID doesn't exist
or the token has no access (mirrors `item get`).

### `item delete <iid> --yes [--dry-run]`

Sibling of `item archive` — same argv, same projection, same
confirmation contract. The differences are the wire mutation
(`delete_item`), the post-mutation state (`"deleted"`), and the
idempotency knob (`idempotent: false` because re-running with the
same `<iid>` after an interim `monday item create` would delete the
new item — agents can't safely retry without verifying the ID still
names the same record).

Live envelope same shape as archive's, with `state: "deleted"`.
Dry-run envelope same shape with `operation: "delete_item"`.

The `confirmation_required` hint anchors at cli-design §5.4: Monday
retains deleted items in the trash for 30 days but exposes no
`unrestore` mutation; recreating is lossy (new ID, no updates /
assets / automation history). Agents needing reversal must recreate
from a prior snapshot.

### `item duplicate <iid> [--with-updates] [--dry-run]`

Third sibling of M10's lifecycle cluster (M10 Session B). Calls
Monday's `duplicate_item(item_id, board_id, with_updates)` mutation;
unlike its M10 siblings duplicate is **creative** (not destructive),
so it skips the `--yes` gate per cli-design §3.1 #7. `--with-updates`
copies the source item's updates to the new item.

Live envelope `data` extends the §6.2 single-resource projection
with one field — `duplicated_from_id` — echoing the source item's
ID so agents thread the lineage into subsequent operations without
having to remember the positional they passed. The new item's `id`
is fresh (Monday assigns it), `board_id` matches the source's
(Monday duplicates onto the source's board), and the rest mirrors
`item get`:

```json
{
  "ok": true,
  "data": {
    "id": "67890",
    "name": "Refactor login (copy)",
    "board_id": "111",
    "group_id": "topics",
    "parent_item_id": null,
    "state": "active",
    "url": "https://example.monday.com/items/12345",
    "created_at": "2026-04-29T10:00:00Z",
    "updated_at": "2026-04-29T11:00:00Z",
    "columns": { ... },
    "duplicated_from_id": "12345"
  },
  "meta": { ..., "source": "live", ... },
  "warnings": []
}
```

The `duplicated_from_id` extension mirrors upsert's `data.created`
flag (cli-design §6.4 line 1827-1831 precedent): per-verb business
signals extend `data`; top-level slots are reserved for cross-verb
shapes (`resolved_ids`, `side_effects`).

Dry-run envelope diverges from archive's + delete's only by the
`with_updates` slot inside `planned_changes[0]` — agents reading
the preview know whether re-running without `--dry-run` would copy
the source's updates:

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "live", ... },
  "planned_changes": [
    {
      "operation": "duplicate_item",
      "item_id": "12345",
      "with_updates": true,
      "item": <projected source snapshot — same shape as live data minus duplicated_from_id>
    }
  ],
  "warnings": []
}
```

The dry-run path is **single-leg** (only `ItemDuplicateRead` fires);
the live path is **two-leg** (`ItemBoardLookup` first, then
`duplicate_item` — Monday's mutation requires `board_id`, derived
from the source item's board). Both legs of the live path are
guaranteed live, so `meta.source: "live"` directly without source
aggregation.

`idempotent: false` — every call creates a new item, mirroring
`monday item create`'s semantics per cli-design §9.1
(`duplicate_item` shares `create_item`'s "every call creates a new
item" inheritance; the table doesn't list it separately). Agents
needing idempotent dup-or-update use `monday item upsert` (M12).

`not_found` (exit 2) on either leg of the live path (source missing
or null `duplicate_item` result — defence-in-depth for permission
edge cases) carries the same `details.item_id` shape archive +
delete + `item get` use, so agents key off one stable code
regardless of which leg failed.

### `item move <iid> --to-group <gid> [--to-board <bid>] [--columns-mapping <json>] [--dry-run]`

The fourth and final lifecycle verb closing the four-verb set
Monday's API exposes (M11). Two transports under one verb:
**same-board (group move)** with `--to-group <gid>` alone calls
Monday's `move_item_to_group(item_id, group_id)`; **cross-board
move** with `--to-group <gid> --to-board <bid>` calls
`move_item_to_board(item_id, board_id, group_id, columns_mapping)`.
`--to-group` is required for both forms because Monday's
`move_item_to_board(group_id: ID!)` is mandatory; `--to-board`
alone (no `--to-group`) is `usage_error`.

Live envelope `data` is the §6.2 single-resource projection of the
moved item — same shape as `item get` / archive / delete. For
same-board moves the projection's `board_id` is unchanged
(Monday's group move doesn't cross boards); for cross-board moves
`board_id` reflects the target. Cross-board's `meta.source` is
`'live'` or `'mixed'` — the source-item read leg + the mutation
leg are always live, so `'cache'` is impossible; the source +
target board metadata loads can hit cache, which collapses the
aggregate to `'mixed'` per §6.1 source-merge rules. Same-board is
unconditionally `'live'` (no metadata loads, no cache leg):

```json
{
  "ok": true,
  "data": {
    "id": "12345",
    "name": "Refactor login",
    "board_id": "222",
    "group_id": "topics",
    "parent_item_id": null,
    "state": "active",
    "url": "https://example.monday.com/items/12345",
    "created_at": "2026-04-29T10:00:00Z",
    "updated_at": "2026-04-30T11:00:00Z",
    "columns": { ... }
  },
  "meta": { ..., "source": "mixed", "cache_age_seconds": 42, ... },
  "warnings": []
}
```

Dry-run envelopes diverge by transport. **Same-board dry-run**
(single-leg `ItemMoveRead`) carries `operation:
"move_item_to_group"`, `item_id`, `to_group_id`, and `item:
<projected source snapshot>`:

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "live", ... },
  "planned_changes": [
    {
      "operation": "move_item_to_group",
      "item_id": "12345",
      "to_group_id": "new_group",
      "item": <projected source snapshot>
    }
  ],
  "warnings": []
}
```

**Cross-board dry-run** (three legs: `ItemMoveRead` + source-board
+ target-board metadata) carries `operation: "move_item_to_board"`,
`item_id`, `to_board_id`, `to_group_id`, `column_mappings: [{source,
target}, ...]`, and `item: <projected source snapshot>`. The
`column_mappings` array enumerates every source-column-with-data —
verbatim ID matches surface explicitly so the array fully describes
what Monday would receive on the wire:

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
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
      "item": <projected source snapshot>
    }
  ],
  "warnings": []
}
```

**`--columns-mapping <json>` (cross-board only).** Accepts the
simple `{<source_col_id>: <target_col_id>}` form — string-to-string
— mapping directly to Monday's `columns_mapping: [ColumnMappingInput!]`
parameter where `ColumnMappingInput = { source: ID!, target?: ID }`.
The richer `{id, value?}` form for cross-board value-overrides is
deferred to v0.3 (Monday's wire shape carries no value slot;
supporting it requires a non-atomic post-move
`change_multiple_column_values` mutation with cross-leg partial-
failure envelope shapes that have no precedent). Agents needing
overrides fire `monday item set <iid> <target>=<value>` post-move
until v0.3 ships an atomic primitive.

**Strict default per cli-design §8 decision 5.** Source columns
with data whose IDs don't exist on target AND aren't bridged by
`--columns-mapping` raise `usage_error` (exit 1) even on
`--dry-run` — agents see the same shape the live mutation would
surface rather than a preview-of-failure. The error decoration
seeds the agent's next call:

```json
{
  "ok": false,
  "error": {
    "code": "usage_error",
    "message": "Cross-board move would drop 1 column value(s) ...",
    "details": {
      "unmatched": [
        {
          "source_col_id": "status_4",
          "source_title": "Status",
          "source_type": "status"
        }
      ],
      "example_mapping": { "status_4": "<target_col_id>" }
    }
  },
  "meta": { ... }
}
```

`--columns-mapping {}` (empty object) is the explicit "drop
everything (Monday's permissive default)" opt-in that bypasses
the unmatched check — Monday silently drops unmatched source
column values.

**Invalid mapping targets are also rejected pre-mutation.** When
an explicit `--columns-mapping` entry points at a target column
ID that doesn't exist on the destination board (e.g. typo'd
column ID), the planner raises `usage_error` (exit 1) with
`details.invalid_mappings: [{source_col_id, target_col_id}]` so
the agent's retry can correct the typo. Strict-default's
"reject before silent drop" guarantee covers typo'd mappings
too — pre-fix the wrong target ID would have reached Monday's
`columns_mapping` parameter and been silently dropped server-
side:

```json
{
  "ok": false,
  "error": {
    "code": "usage_error",
    "message": "Cross-board move's --columns-mapping points at 1 target column(s) that don't exist on the target board.",
    "details": {
      "invalid_mappings": [
        { "source_col_id": "status_4", "target_col_id": "typo_does_not_exist" }
      ],
      "hint": "verify the target column IDs against `monday board describe <target_bid>`; the source IDs map to target IDs that must already exist (move does not create columns)."
    }
  },
  "meta": { ... }
}
```

`idempotent: false` at the verb level. Same-board
(`move_item_to_group`) is wire-level no-op when already in target
group per cli-design §9.1, but cross-board (`move_item_to_board`)
re-running on the target board is undefined SDK behaviour;
conservative bound across all paths mirrors `monday item create`.
Agents needing idempotent dup-or-update use `monday item upsert`
(M12).

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

The 27 stable error codes (post-M12) — `usage_error`,
`confirmation_required`, `not_found`, `ambiguous_name`,
`ambiguous_column`, `ambiguous_match` (M12), `column_not_found`,
`user_not_found`, `unsupported_column_type`, `column_archived`,
`unauthorized`, `forbidden`, `rate_limited`, `complexity_exceeded`,
`daily_limit_exceeded`, `concurrency_exceeded`, `ip_rate_limited`,
`resource_locked`, `validation_failed`, `stale_cursor`,
`config_error`, `cache_error`, `network_error`, `timeout`,
`dev_not_configured`, `dev_board_misconfigured`, `internal_error`.
v0.1 shipped 26; M12's `item upsert` added `ambiguous_match` (27
total). Subsequent v0.2 milestones (M13–M17) reused the existing
codes without adding new ones. The two `dev_*` codes are reserved
for the v0.3 `monday dev` namespace — listed but inactive on the
v0.1/v0.2 surface. Warning
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
