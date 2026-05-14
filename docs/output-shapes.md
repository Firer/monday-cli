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
            "cli_version": "0.2.0", "request_id": "...",
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
| [account](#account) | whoami, info, version, complexity, tags (M19) |
| [auth](#auth) | login (M21), logout (M21) |
| [workspace](#workspace) | list, get, folders, create (M14), update (M14), delete (M14), add-users (M14), remove-users (M14) |
| [board](#board) | list, get, find, describe, columns, groups, subscribers, doctor, create (M15), update (M15), archive (M15), delete (M15), duplicate (M15), add-users (M15), column-create (M16), column-update (M16), column-delete (M16), group-create (M17), group-update (M17), group-archive (M17), group-duplicate (M17), group-delete (M17) |
| [user](#user) | list, get, me |
| [update](#update) | list, get, create, reply (M13), edit (M13), delete (M13), like / unlike / pin / unpin (M13), clear-all (M13), upload (v0.4-M31) |
| [item (reads)](#item-reads) | list, get, find, search, subitems, history (M24), watch (v0.4-M29) |
| [item (mutations)](#item-mutations) | set, clear (single + bulk), update (single + bulk + --continue-on-error M25 + --concurrency v0.4-M30), create, archive, delete, duplicate, move, upsert (M12), time-track start (M20), time-track stop (M20), upload (v0.4-M31) |
| [raw](#raw) | (escape hatch) |
| [cache](#cache) | list, stats, clear |
| [config](#config) | show, path |
| [schema](#schema) | (no verb) |
| [diagnostics](#diagnostics) | status (M22), usage (M22), board favorites (M23), item search cross-board (M23) |
| [dev](#dev) | discover, configure, doctor, sprint current/list/items, epic list/items, release list, task list/start/done/block (M26) |
| [webhook](#monday-webhook-list-bid-v03-m27) | list (M27), create (M27), delete (M27) |
| [notification](#monday-notification-send---user-uid---target-iidbid---target-type-itemboard---text-t---dry-run-v03-m27) | send (M27) |
| [doc](#monday-doc-list---workspace-wid---order-by-created_atused_at---limit-n---page-n-v04-m32) | list (v0.4-M32), get (v0.4-M32) |
| [completion](#monday-completion-bashzshfish-v04-m33) | completion (v0.4-M33) |
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

### `account tags` (M19)

The per-account tag directory. Cache-aware via `loadAccountTags`
(cache key `accountTags`, on-disk path `account_tags/index.json`).
The verb closes the §6.5 `tag_not_found.details.hint` forward-
reference — agents who hit an unknown tag have a self-fulfilling
next step.

```json
{
  "tags": [
    { "id": "101", "name": "launch" },
    { "id": "202", "name": "priority" }
  ],
  "total": 2
}
```

`meta.source` is `cache` for a cache hit, `live` for a cache miss
or `--no-cache`. `meta.cache_age_seconds` populates on the cache
path; `meta.complexity` populates on `--verbose`.

---

## auth

OAuth-issued credentials cache (cli-design §7.3 / §7.4 — shipped at
v0.3-M21 Part 1). Both verbs require `--profile <name>` (or
`MONDAY_PROFILE` env). The token itself **never** appears in the
envelope's `data` per §7.4.3 redaction discipline; it lives only
on disk at `~/.monday-cli/credentials` with mode `0600`.

### `auth login --profile <name>` (M21)

Runs the OAuth flow (consent URL → local listener on
`127.0.0.1:9876` → CSRF verify → code exchange → post-exchange
`account.id` query → atomic credentials-file write) and emits the
profile entry's contract surface.

```json
{
  "profile": "work",
  "account_id": "34900083",
  "scopes": [
    "boards:read",
    "boards:write",
    "me:read"
  ]
}
```

`scopes` echoes the granted-scope list from `/oauth2/token`'s
response (split on space). Agents self-audit ("does this profile
have `boards:write`?") without re-running the flow. `account_id`
pins the Monday account the profile authenticates against
(probe-confirmed string-typed numeric, e.g., `"34900083"`).

`meta.source` is `live` (the OAuth flow + post-exchange GraphQL
call both hit the wire). `meta.api_version` is the standard
resolution (flag > env > SDK pin).

**Error envelope.** `error.code = "oauth_failed"` with
`details.reason` discriminating per failure mode:

- `csrf_mismatch` — redirect's `state` ≠ per-attempt `state`
  (security signal; never auto-retry; no token-exchange call
  follows).
- `user_denied` — Monday's redirect returns
  `?error=access_denied&state=…`.
- `authorization_failed` — Monday's redirect returns
  `?error=<other>&state=…` (e.g., `invalid_scope`,
  `unauthorized_client`, `temporary_unavailable`).
  `details.monday_code` carries the redirect's `error` field;
  `details.monday_description` carries `error_description` if
  present.
- `code_exchange_failed` — `/oauth2/token` returns 4xx
  (probe-confirmed RFC 6749 standard shape).
  `details.monday_code` + optional `details.monday_description`
  populate from the response body.
- `timeout` — listener's 5-min timer fired before the redirect
  arrived. `retryable: true` (overrides the umbrella default).
- `port_in_use` — listener can't bind 9876 (concurrent
  `monday auth login` invocation OR an unrelated process holding
  the port). `details.port` carries the failed port.
- `browser_unavailable` — no opener AND the fallback URL print
  also failed (rare; e.g., closed stderr). `details.url` carries
  the consent URL so an agent can paste it back.

Reused codes: `network_error` (DNS / TCP / TLS reaching
`auth.monday.com`); `config_error` (post-exchange credentials-write
failure); `internal_error` (CLI-side bugs — CSRF-state generation
failure, malformed Monday response shape).

Exit code: `1` (oauth_failed treats as usage-shaped per cli-design
§6.5 — agents already branch on the verb invoked, plus
`details.reason` carries the discriminant).

### `auth logout --profile <name>` (M21)

Deletes the named profile's entry from `~/.monday-cli/credentials`.
Idempotent — no-op + `ok: true` on a missing profile (or a missing
file). When the post-delete profiles map is empty the file is
**still preserved** as `{schema_version: '1', profiles: {}}` rather
than deleted outright (cli-design §7.3.2 — keeps the schema-version
pin discoverable; avoids fresh-install-vs-all-logged-out ambiguity).

```json
{
  "profile": "work",
  "was_present": true
}
```

`was_present` distinguishes a real delete from a no-op (false →
no entry existed pre-delete). Re-running on the same profile name
flips `was_present` to `false` on the second invocation.

`meta.source` is `none` (local-only; no wire call). NOT under the
destructive-confirmation gate (§3.1) — credential rotation is a
routine agent operation, not data mutation requiring `--yes`.

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

### `update upload <uid> <file>` (v0.4-M31)

Attach a local file to an Update (comment) via Monday's
`add_file_to_update` multipart mutation. **First v0.4 verb
crossing the wire via `multipart/form-data`** (along with the
parallel `item upload`); see cli-design §6.4 asset-upload
sub-section + `docs/architecture.md` "Wire-vs-CLI semantics"
for the transport-asymmetry context.

```json
{
  "ok": true,
  "data": {
    "operation": "add_file_to_update",
    "update_id": "987654321",
    "filename": "screenshot.png",
    "file_size_bytes": 41822,
    "asset": {
      "id": "555000111",
      "name": "screenshot.png",
      "url": "https://files.monday.com/.../screenshot.png",
      "public_url": "https://share.monday.com/...",
      "file_extension": "png",
      "file_size": 41822,
      "created_at": "2026-05-13T22:55:00Z",
      "uploaded_by": { "id": "1", "name": "Alice" },
      "original_geometry": "1920x1080",
      "url_thumbnail": "https://files.monday.com/.../screenshot_thumb.png"
    }
  },
  "meta": { ..., "source": "live" },
  "warnings": []
}
```

`file_size_bytes` is the CLI-measured size at upload time (from
`fs.stat()`); `asset.file_size` is Monday's server-stored size.
Usually identical but preserved separately for asymmetric-storage-
encoding fidelity.

`asset.original_geometry` + `asset.url_thumbnail` are image-only —
non-image uploads carry `null` for both.

**Dry-run**:

```json
{
  "ok": true, "data": null,
  "meta": { ..., "dry_run": true, "source": "none" },
  "planned_changes": [
    { "operation": "add_file_to_update",
      "update_id": "987654321",
      "file_path": "./screenshot.png",
      "filename": "screenshot.png",
      "file_size_bytes": 41822 }
  ]
}
```

No wire mutation fires on dry-run; `meta.source: "none"`.

Idempotent: NO — re-running mints a new `Asset`. No cache
invalidation (Updates aren't in §8 cache scope).

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

### `item history <iid>` (v0.3-M24)

Per-item activity log + comment thread merged chronologically.
Pre-flight contract diff at `bad98ba` registered the argv shape
+ the typed event-object discriminated union; **runtime
two-source walker landed at `d058172`** (+ Codex impl review
round-1 fixes `5f10cda` + round-2 fixes `a024961`) —
`boards.activity_logs(item_ids:, ...)` + `items.updates(...)`
fan-out, walker-side `entity = 'pulse'` filter, chronological
merge via `mergeByCreatedAt`, unknown-event-kind aggregation
per cli-design §13 v0.3 entry.

The output is a flat array of typed event-objects discriminated
on `kind`. Variants (per Decision 2 closure `a1f3025`):

| `kind` | source | `before` | `after` |
|---|---|---|---|
| `update_column_value` | `activity_logs` (item-scoped) | `unknown` (raw `previous_value` JSON; typed at M24 impl) | `unknown` (raw `value` JSON) |
| `create_column` / `create_group` / `update_board_name` / `update_board_nickname` / `board_workspace_id_changed` | `activity_logs` (board-scoped — filtered out at walker via `entity = 'pulse'`; kept as defensive parser variants) | `unknown` | `unknown` |
| `update_posted` | `updates` (synthesized) | `null` | `{body, text_body, reply_count}` |
| `update_replied` | `updates.replies` (synthesized, one per Reply row) | `null` | `{body, text_body}` |
| `unknown` | `activity_logs` (fallback for unrecognised wire events) | `null` | raw parsed `data` JSON (the `after` slot IS the payload); raw `event` + `entity` slots additionally land on the event for agent introspection of the unrecognised kind |

Every variant carries `id` + `created_at` + `actor_id` + `kind`.
`update_column_value` additionally carries `column_id` +
`column_type` + `textual_value` + `pulse_id` + `pulse_name`.
`update_replied` additionally carries `parent_update_id` +
`reply_kind` (Reply's own taxonomy — separate from
`activity_logs.event`).

Sample envelope with a mixed-source merged stream (ordered by
`created_at` ascending):

```json
{
  "ok": true,
  "data": [
    {
      "id": "act-1001",
      "created_at": "2026-05-10T09:00:00Z",
      "actor_id": "12345",
      "kind": "update_column_value",
      "column_id": "status",
      "column_type": "status",
      "before": { "id": 0 },
      "after": { "id": 2 },
      "textual_value": "Working on it",
      "pulse_id": "2880477916",
      "pulse_name": "Refactor login"
    },
    {
      "id": "upd-5001",
      "created_at": "2026-05-10T09:15:00Z",
      "actor_id": "12345",
      "kind": "update_posted",
      "before": null,
      "after": {
        "body": "<p>Started the auth refactor</p>",
        "text_body": "Started the auth refactor",
        "reply_count": 1
      }
    },
    {
      "id": "rep-7001",
      "created_at": "2026-05-10T09:30:00Z",
      "actor_id": "67890",
      "kind": "update_replied",
      "parent_update_id": "upd-5001",
      "reply_kind": "reply",
      "before": null,
      "after": {
        "body": "<p>+1 — need this by Thursday</p>",
        "text_body": "+1 — need this by Thursday"
      }
    },
    {
      "id": "act-1042",
      "created_at": "2026-05-10T10:00:00Z",
      "actor_id": "12345",
      "kind": "unknown",
      "event": "future_kind_monday_might_ship",
      "entity": "pulse",
      "before": null,
      "after": { "raw_payload_passes_through": true }
    }
  ],
  "meta": { /* §6.1 */ },
  "warnings": [
    {
      "code": "unknown_event_kind",
      "message": "activity_logs returned 1 row with an unrecognised event kind \"future_kind_monday_might_ship\" (entity: \"pulse\"); surfaced under the `unknown` event variant",
      "details": {
        "event": "future_kind_monday_might_ship",
        "entity": "pulse",
        "occurrence_count": 1,
        "hint": "Monday may have extended `activity_logs.event` with a new kind; extend `historyEventSchema` in `src/api/item-history-projection.ts` with a typed variant to surface the before/after payload, or consume the raw parsed payload from the `unknown` variant's `after` slot"
      }
    }
  ]
}
```

Note the dual-field shape on `kind: "unknown"`: the variant
discriminator `kind: "unknown"` AND the raw wire `event:
"<unknown-kind>"` BOTH land on the projected event so agents can
route on the discriminator while ALSO introspecting the
unrecognised wire kind. `entity` carries the raw wire entity slot
(usually `pulse` when the row passed the walker's
`entity = 'pulse'` filter, but the slot is preserved for
forward-compat with future entity values). The full raw `data`
JSON payload lands under `after` (no separate `data` slot —
`after` IS the raw payload for `unknown` variants).

**Possible warnings:**
- `unknown_event_kind` — Monday's `activity_logs` returned an
  event value not in the typed-variant set. Surfaced as a typed
  fallback on the `data` array (kind: `unknown` carrying raw
  `event` + `entity` + `before: null` + `after: <raw parsed
  data>`) AND a `warnings[]` entry with `{event, entity,
  occurrence_count, hint}`. Aggregation: one warning per unique
  unrecognised event (NOT per occurrence) so the array stays
  bounded on degenerate inputs. **NOT an `error.code` registry
  entry** per Decision 2 closure — the 29-stable-error-code
  registry stays at 29.

**Eventual-consistency caveat (M24 pre-flight empirical probe
finding, 2026-05-11).** Monday's `activity_logs` has a
propagation lag empirically >30s on freshly-edited boards.
Agents polling `monday item history` after a write should wait
at least 30s before expecting the new event to surface.

**Pagination.** Per-source page-numbered: `--activity-logs-page
<n>` (1-indexed; Monday's `activity_logs(page:, limit:)`) +
`--updates-page <n>` (1-indexed; independent denominator).
`--limit <n>` is the per-source per-call slice (default 100,
hard cap 10000 per Monday's documented ceiling).

**Streaming (`--stream`).** NDJSON output via
`startNdjsonStream` (R52). The merge is NOT incremental (the
entire `--since`-bounded slice must be resident to order it);
the NDJSON path emits the merged array post-merge with the
trailer carrying per-source pagination state for resumption.

`meta.source: "live"` (both sources are pure live reads in v0.3;
M24 impl's action layer aggregates with the item-board lookup's
cache state via `SourceAggregator`).

### `item watch <iid>` (v0.4-M29)

Polling-based event stream over the M24 `item-history-projection.ts`
projector. Runtime body landed at M29 IMPL (`7b83a3a`). Pinned per
cli-design §13 v0.4 entry + §14.4 closure (`31713fb`) + the M29
pre-flight empirical probe (`scripts/probe/m29-polling-burn.ts`,
2026-05-13, API `2026-01`).

**NDJSON-only output.** Unlike every other verb, `item watch` emits
NDJSON regardless of `--json` / `--table` / `--output` globals.
Streaming is intrinsic to the verb: agents wait for events as they
arrive, not for a buffered envelope at session end. One event record
per stdout line (matching the M24 `historyEvent` shape verbatim
— see `item history` above for the 9-variant discriminated union)
plus a final trailer-meta record once the session exits.

Event record (one per emitted line; mirrors the M24 projector):

```json
{
  "id": "act-1042",
  "created_at": "2026-05-13T14:30:00Z",
  "actor_id": "12345",
  "kind": "update_column_value",
  "column_id": "status",
  "column_type": "status",
  "before": { "id": 0 },
  "after": { "id": 2 },
  "textual_value": "Working on it",
  "pulse_id": "1234567890",
  "pulse_name": "Refactor login"
}
```

Trailer-meta record (one per session, emitted on graceful exit):

```json
{
  "_meta": {
    "schema_version": "1",
    "api_version": "2026-01",
    "cli_version": "0.4.0",
    "request_id": "...",
    "source": "live",
    "cache_age_seconds": null,
    "retrieved_at": "2026-05-13T14:32:15Z",
    "complexity": null,
    "has_more": true,
    "total_returned": 7,
    "events_emitted": 7,
    "polls_made": 12,
    "failed_polls": 0,
    "watch_duration_seconds": 360.5,
    "last_seen_event_id": "act-1042",
    "circuit_broken_at": null,
    "exit_reason": "max_events",
    "warnings": []
  }
}
```

The trailer carries the M29-specific session counters
(`events_emitted` / `polls_made` / `failed_polls` /
`watch_duration_seconds` / `last_seen_event_id` /
`circuit_broken_at` / `exit_reason`) on top of the standard
§6.3 streaming trailer shape. `exit_reason` discriminates the
trailer interpretation:

| `exit_reason` | Trigger | Envelope |
|---|---|---|
| `max_events` | `--max-events <n>` ceiling reached | success (exit 0) |
| `max_duration` | `--max-duration <seconds>` ceiling reached | success (exit 0) |
| `once_complete` | `--once` backlog drained | success (exit 0) |
| `signal` | SIGINT / SIGTERM graceful drain | exit 130 per §7 |
| `circuit_broken` | N consecutive failed polls (default 5) | failure envelope; `circuit_broken_at` set to the trip-time ISO timestamp |

**Circuit breaker (cli-design §14.4 closure).** Reactive on Monday
wire errors (`complexity_exceeded` / `concurrency_exceeded` /
`rate_limited`). Per-failure `WatchSessionWarning` records (codes:
`poll_failed`, `circuit_breaker_armed`, plus the M24 projector's
`unknown_event_kind`) accumulate in-session and emit in the
trailer-meta's `warnings[]` slot — NOT interleaved with event records
(per cli-design §6.3's NDJSON contract: resource lines + final
`_meta`; warnings live under `_meta.warnings`). After 5 consecutive
failures (`CIRCUIT_BREAKER_CONSECUTIVE_FAILS`) the session trips with
`exit_reason: 'circuit_broken'` + a failure envelope carrying the
underlying Monday error code. The 29-stable-error-code registry stays
at 29 — no new ERROR_CODE for M29.

**Cadence (§14.4 closure).** Default 30s; range 1s–1h via
`--interval <ms>`. Per the empirical probe each poll costs 10
complexity points against Monday's 1,000,000/min budget (0.002%
burn at 30s cadence). Politeness + the documented >30s
`activity_logs` propagation lag (M24 finding) are the binding
constraints, NOT budget. Faster than 1s would trip Monday's
request-rate concerns; slower than 1h crosses the "no longer a
watch" line — agents should use `cron + monday item history` for
hourly+ cadences.

**Restartability.** `--since <event-id>` accepts the
`last_seen_event_id` slot from a prior session's trailer-meta;
the runtime resolves it to a `created_at` once at startup and
sets the initial poll-from timestamp. Distinct from a full
`--resume <token>` mechanism (still open per cli-design §14.6).

**Event-kind filter.** `--include <kind1>,<kind2>` accepts the
M24 closed 9-kind enum (forward-compat). v0.4-M29 polls
`activity_logs` only, so `--include update_posted` /
`--include update_replied` returns no events at v0.4 — those
synthesized kinds surface from the M24 `updates` source which
M29 doesn't poll. A `--include-comments` flag adding a slower-
cadence updates poll is a v0.4-stretch / v0.5 candidate.

**Multi-watcher policy (§14.4 closure).** Each invocation
independent. The last-seen-event-id watermark lives in-memory;
two concurrent watchers double the poll volume against Monday.
Agents needing N watchers spawn N processes per cli-design
§3.1 #5.

**SIGINT graceful drain (§14.4 closure clearance 5).** Ctrl-C
triggers an in-flight poll completion or abort, the trailer-
meta emits as a final NDJSON line, exit 130 per cli-design §7.
The drain MUST emit valid NDJSON (no partial JSON line); the
AbortController seam (`ctx.signal` threaded into the polling
loop) is the mechanism.

`meta.source: "live"` always — polling against Monday is the
source of truth; the local §8 cache is irrelevant during a
watch session (read-only over `activity_logs`; no per-call
cache hook).

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

### `item update --where ... --board <bid> --continue-on-error [--concurrency <n>]` (bulk, partial-success)

Opt-in partial-success bulk variant (M25; `--concurrency` extension at
v0.4-M30). Same matched-item walker + confirmation gate as the fail-fast
bulk path above; the `--continue-on-error` flag swaps the per-item dispatch
loop from fail-fast to attempt-every-match. Per-item failures land per-
record inside `data.results[]`; the top-level envelope is **always
`ok: true`** when dispatch ran (per cli-design §6.1 universal partial-
success rule applied uniformly across M13/M14/M15/M25 family).

`--concurrency <n>` (v0.4-M30; range 1..32; default 1) opts into bounded
parallel per-item dispatch. The envelope shape is **byte-equivalent** to
the sequential path — same per-record `{item_id, ok, item|error}` shape,
same `data.summary` slot, same `ok: true` universal-partial-success rule.
The result array preserves **input order** (`results[i]` corresponds to
`matchedItemIds[i]`) regardless of completion order. `--concurrency` is
rejected with `usage_error` on the single-item shape and on the fail-fast
bulk path (i.e., without `--continue-on-error`). Range out-of-bounds
rejects at argv-parse with `usage_error`.

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

Per-record shape: `{item_id, ok}` always present; `item: <§6.2
projection>` on `ok: true`, `error: {code, message}` on `ok: false`.
`data.summary.failed_count` is the new partial-success-only slot;
the invariant `matched_count === applied_count + failed_count`
holds for every M25 success envelope.

`data.operation: "item_update"` discriminates the partial-success
envelope from M14's `add_users_to_workspace` / `delete_users_from_workspace`
variants (same `data.operation` slot, different verbs). The thin
wrapper at `src/api/partial-success-bulk.ts` routes between
`dispatchSequential` (default — `concurrency` absent / `=== 1`) and
`dispatchParallel` (v0.4-M30 — `concurrency > 1`); both helpers live
next to each other under `src/api/` and produce byte-equivalent per-
target result rows (R-NEW-28 axis 1).

The `--continue-on-error` flag is **orthogonal** to `--yes` — both
must be acknowledged for the live partial-success path to fire.
`--continue-on-error --dry-run` emits the same dry-run envelope as
the fail-fast bulk path (N-element `planned_changes[]`); dry-run
can't preview per-item failures because no per-item mutation fires.

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
`details.deferred_to: "v0.4"` (M28 Decision 11 closure — Monday's
`sub_items_board` carries no `subtasks` column at API `2026-01`).
`--parent` is mutually exclusive with
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
deferred to v0.4 (was originally v0.3-targeted at M11 close; no v0.3
milestone picked up the extension — Monday's wire shape carries no
value slot, and supporting it requires a non-atomic post-move
`change_multiple_column_values` mutation with cross-leg partial-
failure envelope shapes that have no precedent at v0.3 close).
Agents needing overrides fire `monday item set <iid>
<target>=<value>` post-move until v0.4 ships an atomic primitive.

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

### `item time-track start <iid> [--column <col>] [--board <bid>] [--dry-run]` (M20)

Verb-shaped column-type extension per cli-design §5.2 carve-out 2.

**Documentation-only at v0.3.** An empirical probe (2026-05-10,
against API version 2026-01) confirmed Monday's public GraphQL
API does **not** currently expose any mutation that writes to
`time_tracking` columns:

- `change_simple_column_value` rejects every candidate value
  (`"true"`, `"false"`, `"start"`, `"stop"`) with
  `CorrectedValueException`. Verbatim Monday response: *"column
  type DurationColumn is not supporting changing the column value
  with simple column value, please check our API documentation
  for the correct data structure for this column."*
- `change_column_value` rejects every candidate JSON shape
  (`{running:true}`, `{running:false}`, `{started_at:...}`,
  `{ended_at:...}`, `{}`) with `InvalidColumnTypeException`.
  Verbatim Monday response: *"This column type is not supported
  yet in the API"* (`actual_type: "DurationColumn"`).
- Full mutation-root introspection (152 mutations) found zero
  time-tracking-related mutations.

The verb is registered for forward-compatibility — agent scripts
targeting `monday item time-track start` are stable across the
eventual swap when Monday ships API support; today every
invocation rejects with `usage_error` carrying the
`API_UNSUPPORTED_HINT` (named the empirical probe so an agent
reading `details.hint` can self-verify the limitation without
re-running it). The argv shape is pinned to the FUTURE behaviour
so the swap is one-sided in `src/api/time-tracking.ts`.

**Current envelope (every invocation — including `--dry-run`):**

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
      "hint": "Monday's public GraphQL API does not currently expose a mutation for writing to time_tracking columns. Empirical probe (2026-05-10, API version 2026-01): change_simple_column_value rejects every candidate value with CorrectedValueException; change_column_value rejects every candidate JSON shape with InvalidColumnTypeException; the mutation root has no time-tracking-related mutation. Use Monday's UI to start/stop time-tracking sessions until Monday ships API support — the verb is registered for forward-compatibility so agent scripts targeting `monday item time-track start/stop` are stable across the eventual swap."
    }
  },
  "meta": { ..., "source": "live", "cache_age_seconds": null, ... }
}
```

The verb still does the standard `--board` resolution (per
cli-design §5.3 step 1) before throwing, so:

- `not_found` (exit 2) — when `--board` is omitted and the
  item-board lookup returns no item (invalid ID or no token
  access). Mirrors `item get` / `item set` / `item clear`.
- `usage_error` (exit 1) — at the parse boundary when `<iid>` is
  non-numeric, AND on every successful argv parse + board
  resolution path (the `API_UNSUPPORTED_HINT` rejection).

`--column` resolution is intentionally skipped at v0.3 — the
api primitive throws regardless of column validity, so resolving
the column would be a second wasted network call. Tomorrow's
wire-supporting body will need column resolution; that lands at
the same time the rejection body does.

**Future envelope shapes (when Monday ships API support):**

Future live envelope (single-resource — `data` echoes the just-
started session; `meta.source` is `"live"` or `"mixed"`):

```json
{
  "ok": true,
  "data": {
    "operation": "start_time_tracking",
    "item_id": "12345",
    "column_id": "time_tracking_a",
    "running": true,
    "started_at": "2026-05-10T12:00:00Z"
  },
  "meta": { ..., "source": "mixed", "cache_age_seconds": 42, ... },
  "warnings": []
}
```

Future dry-run envelope (`data: null`, `meta.dry_run: true`,
`planned_changes` with `current_state` discriminant):

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
  "planned_changes": [
    {
      "operation": "start_time_tracking",
      "item_id": "12345",
      "column_id": "time_tracking_a",
      "current_state": { "running": false, "started_at": null }
    }
  ],
  "warnings": []
}
```

Future error surface (when wire support ships):

- `usage_error` (exit 1) when the column is already running per
  v0.3-plan §3 M20 Decision 4.1 — `details.running: true`
  discriminates; hint points at `monday item time-track stop`.
- `not_found` (exit 2) — invalid item.
- `column_not_found` / `column_archived` / `ambiguous_column` —
  standard column-resolver surface per cli-design §5.3 step 2.
- `usage_error` (exit 1) when `--column <col>` resolves to a
  non-`time_tracking` column.

Future idempotency: NO — each successful call against a stopped
column appends a new history session per Decision 4.3.

### `item time-track stop <iid> [--column <col>] [--board <bid>] [--dry-run]` (M20)

Sibling of `item time-track start` — same argv, same
documentation-only behavior at v0.3, same `API_UNSUPPORTED_HINT`
(single source-of-truth in `src/api/time-tracking.ts`). The only
difference vs `start` today is the verb name in the
`error.message` so agents grepping `error.message` can
disambiguate.

**Future envelope shapes (when Monday ships API support):**

Future live envelope:

```json
{
  "ok": true,
  "data": {
    "operation": "stop_time_tracking",
    "item_id": "12345",
    "column_id": "time_tracking_a",
    "running": false,
    "started_at": "2026-05-10T12:00:00Z",
    "ended_at": "2026-05-10T12:30:00Z",
    "duration_seconds": 1800
  },
  "meta": { ..., "source": "mixed", "cache_age_seconds": 42, ... },
  "warnings": []
}
```

`data.started_at` is `null` when Monday omits a `started_at` on
the just-closed session record (e.g. sessions added by
automation per the SDK's `TimeTrackingHistoryItem.started_at:
Maybe<Date>` shape); `data.duration_seconds` is `null` in that
case (per-session duration is uncomputable without a start —
SDK 14.0.0 exposes no per-history duration field).

Future dry-run envelope:

```json
{
  "ok": true,
  "data": null,
  "meta": { ..., "dry_run": true, "source": "mixed", "cache_age_seconds": 42, ... },
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

Future error surface (mirrors `start`'s set, with
state-discriminant flipped):

- `usage_error` (exit 1) when the column is not running per
  Decision 4.2 — `details.running: false` discriminates.
- Other surfaces same as `start`.

Future idempotency: NO per Decision 4.3.

### `item upload <iid> --column <col> <file>` (v0.4-M31)

Attach a local file to a `file`-typed column on an item via
Monday's `add_file_to_column` multipart mutation. **First v0.4 verb
crossing the wire via `multipart/form-data`** (along with the
parallel `update upload`); see cli-design §6.4 asset-upload
sub-section + `docs/architecture.md` "Wire-vs-CLI semantics" for
the transport-asymmetry context.

```json
{
  "ok": true,
  "data": {
    "operation": "add_file_to_column",
    "item_id": "12345",
    "column_id": "files",
    "filename": "screenshot.png",
    "file_size_bytes": 41822,
    "asset": {
      "id": "555000111",
      "name": "screenshot.png",
      "url": "https://files.monday.com/.../screenshot.png",
      "public_url": "https://share.monday.com/...",
      "file_extension": "png",
      "file_size": 41822,
      "created_at": "2026-05-13T22:55:00Z",
      "uploaded_by": { "id": "1", "name": "Alice" },
      "original_geometry": "1920x1080",
      "url_thumbnail": "https://files.monday.com/.../screenshot_thumb.png"
    }
  },
  "meta": { ..., "source": "live" },
  "warnings": []
}
```

`file_size_bytes` is the CLI-measured size at upload time (from
`fs.stat()`); `asset.file_size` is Monday's server-stored size.
Usually identical but preserved separately for asymmetric-storage-
encoding fidelity.

`asset.original_geometry` + `asset.url_thumbnail` are image-only.

**Dry-run**:

```json
{
  "ok": true, "data": null,
  "meta": { ..., "dry_run": true, "source": "none" },
  "planned_changes": [
    { "operation": "add_file_to_column",
      "item_id": "12345",
      "column_id": "files",
      "file_path": "./screenshot.png",
      "filename": "screenshot.png",
      "file_size_bytes": 41822 }
  ]
}
```

No wire mutation fires on dry-run; `meta.source: "none"`.

**Column-type validation.** Non-`file` columns passed to
`--column` surface `unsupported_column_type` per cli-design §5.3:

```json
{
  "ok": false,
  "error": {
    "code": "unsupported_column_type",
    "message": "Column \"status_1\" has type \"status\", which Monday writes via change_column_value not add_file_to_column ...",
    "details": {
      "column_id": "status_1",
      "type": "status",
      "hint": "use `monday item set` / `monday item update --set` against this column; `monday item upload` only accepts file-typed columns."
    }
  }
}
```

**File too large.** Monday's server-side rejection rewraps as
`usage_error` with `details.reason: 'file_too_large'`.
`details.file_size_bytes` is the local `fs.stat()` measurement
captured at upload time, NOT a Monday error-payload field —
Monday's wire rejection may not surface a size, but the CLI
already has the local size from the read leg and threads it
into the details slot for a stable agent-keyed envelope:

```json
{
  "ok": false,
  "error": {
    "code": "usage_error",
    "message": "Monday rejected the upload — file exceeds the per-file size limit ...",
    "details": {
      "reason": "file_too_large",
      "file_size_bytes": 524288000,
      "hint": "Monday's per-file cap is plan-tier-dependent (typically 500 MB at standard tiers, larger at enterprise); contact Monday support to confirm your account's exact ceiling."
    }
  }
}
```

Idempotent: NO — re-running mints a new `Asset`. Cache: successful
upload invalidates the parent item's board metadata (single-leg
per §8).

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

## diagnostics

The v0.3 diagnostics cluster (cli-design §11.5; pre-flight at
v0.3-M22 — `fbab6b0`; implementation shipped at `3a1b465`). Two
read-shape verbs that run live as of M22 close. The argv surface
+ the output envelope are pinned for forward-compatibility per the
M22 pre-flight contract diff.

### `monday status [--no-probe]`

Connectivity + auth + local-state probe matrix per cli-design
§11.5.1. Default invocation runs seven probes in
`STATUS_PROBE_ORDER` (DNS → TCP → TLS → auth → cache_writability →
redaction_self_test → env_var_pickup); `--no-probe` skips the four
network-touching probes (they surface as `ProbeSkipped` slots) but
local probes still run.

```json
{
  "probes": {
    "dns":                 { "kind": "ok",   "probe": "dns",   "elapsed_ms": 12,  "details": { "address": "1.2.3.4", "family": 4 } },
    "tcp":                 { "kind": "ok",   "probe": "tcp",   "elapsed_ms": 24,  "details": { "host": "api.monday.com", "port": 443 } },
    "tls":                 { "kind": "ok",   "probe": "tls",   "elapsed_ms": 67,  "details": { "subject": "*.monday.com", "valid_to": "2027-..." } },
    "auth":                { "kind": "ok",   "probe": "auth",  "elapsed_ms": 89,  "details": { "me_id": "102927371", "api_version": "2026-01" } },
    "cache_writability":   { "kind": "ok",   "probe": "cache_writability",   "elapsed_ms": 3, "details": { "path": "/home/.../.monday-cli", "mode": "0700" } },
    "redaction_self_test": { "kind": "ok",   "probe": "redaction_self_test", "elapsed_ms": 1, "details": { "fixture_count": 6 } },
    "env_var_pickup":      { "kind": "ok",   "probe": "env_var_pickup",      "elapsed_ms": 0, "details": { "set": { "MONDAY_API_TOKEN": true, "MONDAY_PROFILE": false, "MONDAY_API_VERSION": false, "MONDAY_API_URL": false, "MONDAY_OUTPUT": false, "MONDAY_REQUEST_TIMEOUT_MS": false } } }
  },
  "overall": "ok",
  "api_version": "2026-01"
}
```

Each probe slot is one of:
- `{ kind: 'ok', probe, elapsed_ms, details }` — probe-specific
  `details` shape; never carries a token value.
- `{ kind: 'fail', probe, elapsed_ms, reason, message, details }` —
  `reason` is a stable snake_case discriminant (e.g.,
  `unauthorized`, `cert_invalid`, `port_unreachable`); agents key
  off `reason`, never the English `message`.
- `{ kind: 'skipped', probe, reason }` — `--no-probe` invocations
  emit `reason: "no_probe_flag"` for the four network probes.

`overall` rules (cli-design §11.5.2):
- `"ok"` — every non-skipped probe returned `'ok'`.
- `"degraded"` — auth probe succeeded AND only **soft local probes**
  (`cache_writability` + `env_var_pickup`) failed. Verb exit 0.
- `"down"` — any network probe failed, `redaction_self_test`
  failed (NEVER degraded — CLI may leak secrets), or every network
  probe was skipped (via `--no-probe`) AND a local probe failed.
  Promotes the verb to the §11.5.1 mapping table's error code:
  - DNS / TCP / TLS / auth(5xx) → `network_error` (exit 2)
  - auth(401) → `unauthorized` (exit 2)
  - cache_writability → `config_error` (exit 3)
  - redaction_self_test → `internal_error` (exit 2)

`meta.source: "live"` for default runs; `"none"` for
`--no-probe` runs that don't touch the wire. **Empirical-probe
finding pinned (2026-05-10, API `2026-01`):** the 401 envelope shape
the auth probe maps against is `{"errors":[{"message":"Not
authenticated","extensions":{"code":"NOT_AUTHENTICATED"}}]}`
(status 401, content-type `application/json; charset=utf-8`);
same envelope for missing- and bad-`Authorization`. `Bearer
<token>` prefix also works alongside bare `<token>`.

### `monday usage`

Daily Monday API **operation** budget remaining per cli-design
§11.5.3 / §13 v0.3 entry. Complements v0.1's per-call
`account complexity` (which surfaces per-minute COMPLEXITY POINTS
— a separate Monday quota system). The empirical-probe finding at
M22 pre-flight (2026-05-10, API `2026-01`) confirmed Monday's
daily-budget GraphQL surface lives at `platform_api.daily_limit`
+ `platform_api.daily_analytics.by_day` (operations per day, 200
per day on free tier), NOT `account.complexity` (which doesn't
exist on the `Account` type).

```json
{
  "daily_limit": { "base": 200, "total": 200 },
  "usage_today": 17,
  "usage_remaining_today": 183,
  "last_updated": "2026-05-10T22:01:26.377Z"
}
```

- **`daily_limit.base`** — the plan's baseline daily allotment
  (200 ops on free tier; higher for paid tiers).
- **`daily_limit.total`** — `base` + account-specific upgrades.
  v0.3 surfaces both verbatim so paid-tier agents see the overage
  offset.
- **`usage_today`** — sum of `platform_api.daily_analytics
  .by_day[].usage` where `day` matches today.
- **`usage_remaining_today`** — derived `max(0, total -
  usage_today)`. Clamped at zero (Monday's reported `usage` is
  best-effort and may briefly exceed `total` on a near-cap
  account; the limit enforces server-side at request time, not
  per-day-boundary).
- **`last_updated`** — Monday's `daily_analytics.last_updated`
  field (`ISO8601DateTime` scalar). Lets agents detect stale
  analytics data without polling.

**Additive-only envelope per Decision 8 closure.** v0.4 may
extend with per-minute complexity headroom + concurrency-cap
fields (`per_minute_complexity`, `concurrency`) WITHOUT
breaking the v0.3 shape. Removing or renaming any v0.3 field is
the SemVer-major boundary.

`meta.source: "live"` (the `platform_api` GraphQL query hits the
wire each invocation; the daily-analytics surface is server-
authoritative).

### `monday board favorites` (v0.3-M23)

Runtime 2-stage favorites resolver landed at `1f09a25`. The
output shape (Stage-1 filter + Stage-2 hydrate, sorted by
`position` ascending):

```json
{
  "ok": true,
  "data": [
    {
      "id": "5095526240",
      "name": "Tasks",
      "state": "active",
      "workspace_id": "12345",
      "url": "https://example.monday.com/boards/5095526240",
      "position": 1.5
    }
  ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

Field semantics (per `src/api/board-favorites.ts`):

- `id` — the underlying Board ID (NOT the `Query.favorites[].id`
  hierarchy-item ID; the hierarchy-item ID is discarded after the
  Stage-1 filter).
- `name` / `state` / `workspace_id` / `url` — verbatim from
  Monday's `boards(ids:)` Stage-2 hydrate response.
- `position` — Monday's UI sort key (Float; lower = higher in the
  Monday sidebar). Output is sorted by `position` ascending so
  agents see the same order users see.

**Polymorphic Stage-1 source.** Monday's `Query.favorites:
[GraphqlHierarchyObjectItem!]` returns favorited resources of
every kind (Board | Folder | Dashboard | Workspace per the
`GraphqlMondayObject` enum). The verb filters client-side to
`object.type === Board`; non-Board entries are silently dropped
(forward-compat with future Monday enum extensions).

**Possible warnings:**
- `board_favorites_stale` — Stage-2 hydrate returned fewer boards
  than Stage-1 yielded (a favorited board was deleted, archived
  to a private workspace, or had access revoked). Not fatal:
  `data` still carries the boards Stage 2 hydrated. `details`
  carries `{ favorited_count, hydrated_count, missing_board_ids,
  hint }`.

`meta.source: "live"` (no per-call cache; both stages always hit
the wire). v0.3 scope is READ-ONLY — favorite/unfavorite writes
are a v0.4+ candidate.

### `monday item search` cross-board (v0.3-M23)

The v0.1 single-board path (`--board <bid>` set) is documented at
`### \`item search --board <bid> --where ...\`` above and is
UNCHANGED at M23. The cross-board extension adds three new flags
(`--workspace <wid>`, `--favorites`, `--max-boards <n>` per
Decision 5 closure `3a2f1db`) — at most ONE of `--board` /
`--workspace` / `--favorites` may be supplied (mutual-exclusion
at parse boundary surfaces `usage_error` with structured
`params.conflicting_flags`).

Runtime fan-out walker landed at `1f09a25`. The cross-board
output shape (each row carries its source board's id + name):

```json
{
  "ok": true,
  "data": [
    {
      "id": "2880477916",
      "name": "Task 1",
      "state": "active",
      "board": { "id": "5095526240", "name": "Tasks" },
      "column_values": { "status": "Working on it" }
    }
  ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

Distinct from the v0.1 single-board row shape — each cross-board
row carries its source `board: { id, name }` so agents can tell
which board each hit came from without a second round-trip.

**Possible warnings:**
- `inaccessible_boards` — Monday's `boards(ids:)` resolver
  silently omitted N of the requested board IDs (no access,
  deleted, or never existed). `details` carries
  `{ requested_count, returned_count, missing_board_ids, hint }`.
- `column_not_found_on_board` — a `--where` column token didn't
  resolve on a specific board; that board was skipped in the
  fan-out (rather than failing the whole call). One warning per
  skipped board. `details` carries
  `{ board_id, column, hint }` — the `column` key carries the
  user's `--where` column token. (The detail-key was renamed
  from `column_token` → `column` at M23 implementation per the
  v0.3-plan §15 contract drift finding — the redactor's
  `(token|secret|password|api[-_]?key)` pattern would scrub
  the value otherwise.)
- `cross_board_truncated` — the walker stopped before exhausting
  every board (either `--limit` short-circuit, or any board's
  per-board `items_page.cursor` was non-null at the v0.3
  single-call surface). v0.3 cross-board search is single-call-
  only; no resumable cross-board cursor (deferred to v0.4 per
  Decision 5 closure rationale). `details` carries `{ reason:
  "limit_hit" | "board_has_more", total_returned, limit,
  per_board_state: Record<board_id, "exhausted" | "has_more" |
  "not_started">, hint }`.

`meta.source: "live" | "cache" | "mixed"` — aggregated by the
command-action's `SourceAggregator` across the per-board column-
resolution pre-pass (cache-hits possible) and the cross-board
fan-out call itself (always live).

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

The 29 stable error codes (post-v0.3-M21 pre-flight) —
`usage_error`, `confirmation_required`, `not_found`,
`ambiguous_name`, `ambiguous_column`, `ambiguous_match` (M12),
`column_not_found`, `user_not_found`, `tag_not_found` (M19+),
`unsupported_column_type`, `column_archived`, `unauthorized`,
`forbidden`, `rate_limited`, `complexity_exceeded`,
`daily_limit_exceeded`, `concurrency_exceeded`, `ip_rate_limited`,
`resource_locked`, `validation_failed`, `stale_cursor`,
`oauth_failed` (M21+), `config_error`, `cache_error`,
`network_error`, `timeout`, `dev_not_configured`,
`dev_board_misconfigured`, `internal_error`. v0.1 shipped 26;
M12's `item upsert` added `ambiguous_match` (27 total).
Subsequent v0.2 milestones (M13–M18) reused the existing codes
without adding new ones. v0.3-M19 added `tag_not_found` (28
total) — registered pre-M19 as the writer-expansion close
prerequisite (the `tags` friendly translator's per-account
directory-miss surface; cli-design §6.5 entry landed at
`4c652d5`, runtime widening alongside the M19 pre-flight contract
diff). v0.3-M21 adds `oauth_failed` (29 total) — the umbrella
code for `monday auth login` flow failures, with `details.reason`
discriminating per failure mode (cli-design §7.3.3 row landed
alongside the M21 pre-flight contract diff). The two `dev_*`
codes are reserved for the v0.3 `monday dev` namespace — listed
but inactive on the v0.1/v0.2/v0.3-M21 surface. Warning
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

## dev

The `monday dev …` namespace is the **workflow-shortcut carve-out**
(cli-design §5.2 carve-out 1; §2.7 — Monday Dev is convention, not
API; §5.9 — board-mapping mechanics). Three setup verbs (`discover` /
`configure` / `doctor`) + ten workflow verbs (sprint /epic / release
/ task × their per-noun verbs).

All 13 verbs are **live at v0.3-M26**: 3 setup verbs shipped at
M26a IMPL (`19755e3`); 10 workflow verbs shipped at M26b IMPL
(`10cd1c5` + Codex round-1/2/3 fix-ups `34a5bc1` / `078dae3` /
`8ea66c4`). Argv `inputSchema` + output `outputSchema` were pinned
at the M26 pre-flight contract diff (`1620220`) so `monday schema`
introspection has been stable across both IMPL drops. The output
shapes below describe what `data` carries today; the namespace is
convention-not-API (every workflow verb translates to standard
board / item CRUD against per-profile `[profiles.<name>.dev]`
mappings — no new Monday GraphQL mutations).

### `monday dev discover [--apply]` (v0.3-M26)

Auto-detect Monday Dev board mappings via the heuristic in
`src/api/dev-conventions.ts:matchBoardByConvention` (case-
insensitive Unicode-NFC match against the stock English board
names: `Tasks` / `Sprints` / `Epics` / `Releases` / `Bugs`).
`--apply` writes the detected mapping to the active profile's
`[profiles.<name>.dev]` TOML block via `saveDevMapping`. Without
`--apply` the command is a pure read.

```json
{
  "ok": true,
  "data": {
    "profile": "work",
    "mapping": {
      "tasks_board": "987654",
      "sprints_board": "987655",
      "epics_board": "987656",
      "releases_board": "987657"
    },
    "matches": [
      { "noun": "tasks_board",
        "matched": [{ "id": "987654", "name": "Tasks",
                     "workspace_id": "12345" }] },
      { "noun": "bugs_board", "matched": [] }
    ],
    "applied": true
  },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**No-match + ambiguity semantics (Decision 1 closure;
round-1 Codex P2-4 clarification).** `dev discover` is the setup
verb and DOES NOT require existing dev config — zero-match and
ambiguous-match nouns are SUCCESS shapes, surfaced on the
output's `matches[]` array (`matched.length === 0` = unmapped;
`matched.length > 1` = ambiguous; the action emits each in
`matches[]` with that array length so agents can inspect both
modes uniformly). The `mapping` slot carries only the single-
match nouns (zero / ambiguous nouns are absent from the mapping).
A run against a workspace with NO accessible boards returns
`{ mapping: {}, matches: [<every noun with matched: []>],
applied: false }` — still success.

**Failure modes:** `unauthorized` / `network_error` / `timeout`
on the underlying `boards(...)` walk; `cache_error` (when
`--apply` set + the profile config write fails). `dev_not_configured`
does NOT fire from `dev discover` — that code is for verbs that
REQUIRE an existing mapping (sprint / epic / release / task
verbs + `dev doctor`).

### `monday dev configure --tasks-board <bid> [...]` (v0.3-M26)

Explicit per-board override of the Monday Dev mapping on the
active profile. At least one of `--tasks-board` / `--sprints-board`
/ `--epics-board` / `--bugs-board` / `--releases-board` must be
supplied. Idempotent on equal mappings.

```json
{
  "ok": true,
  "data": {
    "profile": "work",
    "mapping": {
      "tasks_board": "987654",
      "epics_board": "987656"
    }
  },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**Failure modes:** `usage_error` (no flags supplied — at least one
`--<noun>-board` is required); `not_found` (a supplied board ID
doesn't exist / no access); `cache_error` (profile config write
failed).

### `monday dev doctor` (v0.3-M26)

Validate the active profile's mapping against current board shape.
Runs every check in `DEV_DOCTOR_CHECK_NAMES` (pinned at M26 pre-
flight per Decision 2 closure) and emits per-check status. The
status taxonomy is `ok | warn | fail`; the verb's exit code is
`0` regardless of per-check status (the verb's success envelope
is the `data` itself; agents inspect `data.summary.fail_count`
for hard drift).

```json
{
  "ok": true,
  "data": {
    "profile": "work",
    "mapping": { "tasks_board": "987654",
                 "sprints_board": "987655" },
    "checks": [
      { "name": "tasks_board_exists", "status": "ok",
        "message": "Tasks board 987654 reachable",
        "details": null },
      { "name": "tasks_status_column_present", "status": "warn",
        "message": "Tasks board has no `status` column under the canonical name",
        "details": { "column_id_found": "status_v2" } }
    ],
    "summary": { "ok_count": 1, "warn_count": 1, "fail_count": 0 }
  },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**Failure modes:** `dev_not_configured` (no `[profiles.<name>.dev]`
block on the active profile); `dev_board_misconfigured` ONLY
surfaces if the doctor verb itself can't complete (e.g. all
configured boards inaccessible) — per-check drift is a `data`
slot, not an error.

### `monday dev sprint current` (v0.3-M26)

The active sprint on the configured `sprints_board`. Date-range
straddle against `ctx.clock()` resolves "current". Returns a
single-resource `ProjectedItem` (same shape `monday item get`
returns).

```json
{
  "ok": true,
  "data": { "id": "12345678", "name": "Sprint 42",
            "board_id": "987655", "group_id": "active",
            "parent_item_id": null, "state": "active",
            "url": "https://...", "created_at": "...",
            "updated_at": "...", "columns": { /* §6.2 */ } },
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**Failure modes:** `not_found` (no active sprint — hint points at
`dev sprint list --state future`); `dev_not_configured` (no
`sprints_board` in the active profile's mapping);
`dev_board_misconfigured` (sprint date columns missing).

### `monday dev sprint list [--state active|past|future]` (v0.3-M26)

List sprints on the configured `sprints_board`, optionally filtered
by date-range state against `ctx.clock()`. Returns a collection of
`ProjectedItem`. NaN-guard discipline applies to date parses per
M24 round-2 P3-1 precedent.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem */ }, { /* ProjectedItem */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**Bucketing of sprints with no resolvable date columns** falls
through to the `past` bucket — there is no separate warning code
introduced at M26 pre-flight (round-1 Codex P2-3 clarification:
warning-code registration is per cli-design §6.1; the M26 surface
intentionally does NOT introduce new warning codes since the
date-missing fallback is documented inline at cli-design §5.9
and surfaces inline via the verb's existing data shape). `dev
doctor`'s `sprints_date_columns_present` check is where date-
column drift is diagnosed as a structured `details` shape.

### `monday dev sprint items <sid>` (v0.3-M26)

List task items on the configured `tasks_board` linked to a named
sprint via the sprint→task `board_relation` column. Positional
`<sid>` is an item ID on the sprints board (sprints are items,
not first-class entities). Returns a collection of `ProjectedItem`.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem task row */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

**Failure modes:** `not_found` (`<sid>` doesn't exist on the
sprints board); `dev_board_misconfigured` (sprint→task
`board_relation` column not wired up — diagnose via `dev doctor`
check `tasks_to_sprints_relation`).

### `monday dev epic list [--state active|done]` (v0.3-M26)

List epics on the configured `epics_board`, optionally filtered by
the epic's status column (`done` = `Done | Cancelled`; `active` =
not in that set). Returns a collection of `ProjectedItem`.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem epic row */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

### `monday dev epic items <eid>` (v0.3-M26)

List task items linked to a named epic via the epic→task
`board_relation` column. Positional `<eid>` is an item ID on the
epics board. Returns a collection of `ProjectedItem`.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem task row */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

### `monday dev release list` (v0.3-M26)

List releases on the configured `releases_board`. v0.3 ships the
list verb without a per-release-state filter (the release date-
column conventions don't stabilise cleanly enough for a `--state`
flag at v0.3); a v0.3.x / v0.4 follow-up may add
`--state shipped|upcoming` once the date conventions firm up.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem release row */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

### `monday dev task list [--mine] [--status not_done] [--sprint current]` (v0.3-M26)

List tasks on the configured `tasks_board` filtered by the
supplied flags. `--mine` resolves through the `me` token resolver
(M3); `--status` accepts the canonical taxonomy
(`not_done | done | stuck | working_on_it`); `--sprint` accepts
either the literal `current` (resolves via `dev sprint current`)
or a numeric sprint item ID. Returns a collection of
`ProjectedItem`.

```json
{
  "ok": true,
  "data": [ { /* ProjectedItem task row */ } ],
  "meta": { /* §6.1 */ },
  "warnings": []
}
```

### `monday dev task start <iid>` (v0.3-M26)

Set a task's status to "Working on it" on the configured
`tasks_board`. Returns the post-mutation `ProjectedItem` (mutation
envelope per cli-design §6.4). Idempotent on equal status values.
The top-level `resolved_ids` echo (per cli-design §5.3 step 2) carries
the resolved status-column ID so an agent's "set then re-read" loop
can use the stable ID without a second metadata lookup (round-2 Codex
P3-1 — resolved_ids is a top-level mutation-envelope slot per
`src/utils/output/envelope.ts:99-117`).

```json
{
  "ok": true,
  "data": { /* ProjectedItem with columns.status.label = "Working on it" */ },
  "meta": { /* §6.1 */ },
  "warnings": [],
  "resolved_ids": { "status": "status_4" }
}
```

### `monday dev task done <iid> [--message <m>]` (v0.3-M26)

Set a task's status to "Done" + optionally post a completion
comment. Returns the post-mutation `ProjectedItem`. When
`--message` is supplied, the post-create surfaces on the
top-level `side_effects` slot per cli-design §6.4 (round-1
Codex P1-2 fix — `side_effects` is a mutation-envelope
top-level field per `src/utils/output/envelope.ts:99-117`, NOT
under `meta`):

```json
{
  "ok": true,
  "data": { /* ProjectedItem with columns.status.label = "Done" */ },
  "meta": { /* §6.1 */ },
  "warnings": [],
  "side_effects": [
    { "kind": "update_created", "update_id": "5678901" }
  ],
  "resolved_ids": { "status": "status_4" }
}
```

**Idempotency caveat.** The status flip is idempotent; the
optional `--message` post is NOT — a re-run with `--message`
posts a second comment. Help text reproduces this caveat.

### `monday dev task block <iid> --reason <r>` (v0.3-M26)

Set a task's status to "Stuck" + post the blocking reason as a
comment. `--reason` is REQUIRED (the audit-trail comment is the
load-bearing value of `task block` over a bare status flip).
Returns the post-mutation `ProjectedItem` + the post-create on
the top-level `side_effects` slot per cli-design §6.4 (round-1
Codex P1-2 fix):

```json
{
  "ok": true,
  "data": { /* ProjectedItem with columns.status.label = "Stuck" */ },
  "meta": { /* §6.1 */ },
  "warnings": [],
  "side_effects": [
    { "kind": "update_created", "update_id": "5678902" }
  ],
  "resolved_ids": { "status": "status_4" }
}
```

**Idempotency caveat.** As with `task done` — status flip
idempotent, `update create` is NOT.

### `monday webhook list <bid>` (v0.3-M27)

List webhooks configured on the supplied board. Pure read via
Monday's `webhooks(board_id:)` query (operationName `Webhooks`).
Live-only (cli-design §8 cache scope excludes webhooks).
Returns a flat collection of `Webhook { id, board_id, event,
config }` records — the asymmetric `config` field is a JSON-
encoded string on read (Monday's `Webhook.config` field is
typed `String`, even though the `create_webhook` input arg
accepts the `JSON` scalar).

**Runtime body shipped** at M27 IMPL `9cb6a74` (+ 4 Codex
rounds `6f59a83` / `2402a76` / `ff724fd` / `64d94d7`). A null
`webhooks` root surfaces `not_found` with `details.board_id`
(matches the M10/M15 lifecycle verbs).

```json
{
  "ok": true,
  "data": [
    {
      "id": "98765",
      "board_id": "12345678",
      "event": "create_item",
      "config": null
    }
  ],
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

### `monday webhook create <bid> --url <u> --event <e> [--config <json>] [--dry-run]` (v0.3-M27)

Register a new webhook on the supplied board via Monday's
`create_webhook` mutation (operationName `CreateWebhook`).
`--event` is validated at parse boundary against the closed
`WEBHOOK_EVENT_TYPES` 21-value enum (cli-design §13 v0.3 entry +
Decision 9 closure). `--config <json>` is parsed once at the
CLI parse boundary — the resulting JS value is threaded to
Monday's `JSON` scalar input arg (sending the raw string would
double-encode against the JSON scalar); malformed JSON surfaces
`usage_error` before any wire call fires. An absent `--config`
omits the wire variable entirely so Monday's per-event server-
side default applies. Per-event sub-shape validation lives
server-side at Monday. `--url` requires HTTPS at parse boundary
(Monday rejects non-HTTPS webhook endpoints server-side;
surfacing the rejection at the CLI boundary keeps the failure
mode local). Returns the freshly-minted `Webhook` record (with
the Monday-assigned `id`).

**Runtime body shipped** at M27 IMPL `9cb6a74` (+ 4 Codex
rounds). A null `create_webhook` payload surfaces
`internal_error` (the contract is "every successful create
returns a Webhook" — same shape M15 `board create` uses).

**Idempotency caveat.** `create_webhook` is NOT idempotent —
re-running with the same args mints a fresh webhook with a new
ID. Agents needing register-once semantics should `webhook list`
first and skip the create if a matching entry exists.

**Live success envelope:**

```json
{
  "ok": true,
  "data": {
    "id": "98765",
    "board_id": "12345678",
    "event": "create_item",
    "config": null
  },
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

**`--dry-run` envelope** (`meta.dry_run: true`; no wire mutation
fires — argv parse + URL/event validation only). Same shape as
M14/M15 create-verb dry-runs per the canonical `DryRunEnvelope`
contract (`src/utils/output/envelope.ts:119` — `data: null` plus
top-level `planned_changes[]` sibling); the planned-change
carries the intended `event` + `board_id` + `url` so an agent
verifies before running for real:

```json
{
  "ok": true,
  "data": null,
  "meta": { /* §6.1 — source: "none", dry_run: true */ },
  "planned_changes": [
    {
      "operation": "create_webhook",
      "board_id": "12345678",
      "url": "https://example.com/hook",
      "event": "create_item",
      "config": null
    }
  ],
  "warnings": []
}
```

### `monday webhook delete <wid> --yes [--dry-run]` (v0.3-M27)

Delete a webhook by ID via Monday's `delete_webhook` mutation
(operationName `DeleteWebhook`). `--yes` is mandatory for the
live path (cli-design §3.1 #7 confirmation gate); without
`--yes` AND without `--dry-run` the command fails fast with
`confirmation_required` carrying `details.webhook_id`. Returns
the deleted `Webhook` record (Monday echoes the deleted state).
Re-deleting an already-deleted webhook surfaces `not_found`
(matches the M10 `item delete` / M15 `board delete` shape so
agents key off one error code regardless of which delete verb
they ran).

**Runtime body shipped** at M27 IMPL `9cb6a74` (+ 4 Codex
rounds). Confirmation gate fires BEFORE `resolveClient` per the
M10 round-1 P2 invariant — missing token surfaces
`confirmation_required` (exit 1), not `config_error` (exit 3).

**Live success envelope:**

```json
{
  "ok": true,
  "data": {
    "id": "98765",
    "board_id": "12345678",
    "event": "create_item",
    "config": null
  },
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

**`--dry-run` envelope** (`meta.dry_run: true`; bypasses the
confirmation gate per §3.1 #7). Strictly argv-derived shape per
the canonical `DryRunEnvelope` contract
(`src/utils/output/envelope.ts:119` — `data: null` plus
top-level `planned_changes[]` sibling); the planned change
carries the `webhook_id` slot for agent verification before
re-running with `--yes`. **No pre-mutation read fires** —
Monday's `webhooks(board_id:)` query is board-scoped and the
`webhook delete <wid>` argv carries no board ID, so the dry-run
cannot enrich the planned change with the deleted webhook's
`event` / `board_id` / `config` without amending the §4.3 row.
Source is always `"none"`.

```json
{
  "ok": true,
  "data": null,
  "meta": { /* §6.1 — source: "none", dry_run: true */ },
  "planned_changes": [
    { "operation": "delete_webhook", "webhook_id": "98765" }
  ],
  "warnings": []
}
```

### `monday notification send --user <uid> --target <iid|bid> --target-type item|board --text <t> [--dry-run]` (v0.3-M27)

Fire a Monday notification to a single recipient about an item
or board via `create_notification` (operationName
`CreateNotification`). Single-recipient at v0.3 per cli-design
§4.3 (`--user` is singular; multi-recipient fan-out is a
v0.3.x / v0.4 contract-extension). The CLI's `--target-type
item|board` vocabulary maps to wire
`NotificationTargetType.Project` (which represents both items
and boards); Monday's wire enum has only two values (`Post` /
`Project`), and the `Post` value (Update-targeted
notifications) is unreachable at v0.3 — a v0.3.x / v0.4
contract-extension may add a CLI third target-type `update`
that dispatches to wire `Post`. **The item-vs-board pairing
of `--target-type` with `--target <id>` is trusted, not
verified** — the wire enum collapses both kinds, so neither
the CLI nor Monday cross-validates the declared kind against
the underlying record; Monday only validates target visibility
as a `Project`. Returns the minted `Notification { id, text }`
+ the CLI-side echo of the inputs (`user_id`, `target_id`,
`target_type`) for agent verification.

**Runtime body shipped** at M27 IMPL `9cb6a74` (+ 4 Codex
rounds). A null `create_notification` payload surfaces
`not_found` with `details.user_id` + `details.target_id` +
`details.target_type`.

**Idempotency caveat.** `create_notification` is NOT idempotent
— re-running mints a fresh notification with a new ID. Agents
needing send-once-semantics dedup on the CLI side.

**Live success envelope:**

```json
{
  "ok": true,
  "data": {
    "id": "55555",
    "text": "Please review",
    "user_id": "12345",
    "target_id": "67890",
    "target_type": "item"
  },
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

**`--dry-run` envelope** (`meta.dry_run: true`; no wire
mutation fires — argv parse + target-type validation only).
Per §3.1 #6 the verb supports `--dry-run` so an agent can
preview the planned send before committing. Canonical
`DryRunEnvelope` shape (`src/utils/output/envelope.ts:119` —
`data: null` plus top-level `planned_changes[]` sibling):

```json
{
  "ok": true,
  "data": null,
  "meta": { /* §6.1 — source: "none", dry_run: true */ },
  "planned_changes": [
    {
      "operation": "create_notification",
      "user_id": "12345",
      "target_id": "67890",
      "target_type": "item",
      "text": "Please review"
    }
  ],
  "warnings": []
}
```

### `monday doc list [--workspace <wid>,...] [--order-by <created_at|used_at>] [--limit <n>] [--page <n>]` (v0.4-M32)

List workdocs visible to the token via Monday's `Query.docs(...)`
(operationName `ListDocs`). Page/limit pagination — Monday's
workdocs surface has no `items_page`-style cursor. The list-row
projection ships every base Document field EXCEPT `blocks` (per
D6 closure — rich-text bodies belong to `doc get`; including
them in a list would multiply payload across the page). Live-
only (cli-design §8 cache scope excludes workdocs — content-
heavy + frequently human-edited; stale-cache risk outweighs
cache-hit value).

**Status: v0.4-M32 IMPL landed end-to-end.** Argv parsing + schema
+ wire query documents shipped at v0.4-M32 pre-flight
(`scripts/probe/m32-docs.ts` 2026-05-14 pinned
`Query.docs(workspace_ids: [ID], order_by: DocsOrderBy, limit: Int,
page: Int) → [Document]` + the 14-field `Document` shape + the
2-value `DocsOrderBy` closed enum (`created_at` / `used_at`)). The
runtime body landed at IMPL via {@link listDocuments} — single
`client.raw` round-trip with `operationName: 'ListDocs'` pinned at
the fetcher boundary, response-parse via `unwrapOrThrow`, schema
drift surfaces `internal_error` with `details.issues`.

Envelope `data` carries the wrapped record (NOT a bare array)
because page/limit pagination surfaces pagination context inline
rather than via `meta.cursor` (which is reserved for
`items_page`-style cursor surfaces per §6.1). `has_more` is the
`returned_count === limit` heuristic — Monday's wire doesn't
surface a total count, so "exactly `limit` rows returned" is the
only signal that a follow-up page may exist; agents that need
exhaustive listing loop until `has_more: false`.

**Live success envelope:**

```json
{
  "ok": true,
  "data": {
    "documents": [
      {
        "id": "12345678",
        "object_id": "98765",
        "name": "Q4 launch plan",
        "doc_kind": "private",
        "url": "https://example.monday.com/docs/12345678",
        "relative_url": "/docs/12345678",
        "workspace_id": "5555",
        "workspace": { "id": "5555", "name": "Marketing" },
        "doc_folder_id": null,
        "created_at": "2026-04-12T10:32:11Z",
        "created_by": { "id": "1", "name": "Alice" },
        "updated_at": "2026-05-01T14:22:09Z",
        "settings": null
      }
    ],
    "page": 1,
    "limit": 25,
    "returned_count": 1,
    "has_more": false
  },
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

Idempotent: yes (pure read).

### `monday doc get <did>` (v0.4-M32)

Read a single workdoc by ID, including its rich-text block body,
via Monday's `Query.docs(ids: [<did>])` (operationName `GetDoc`).
Monday returns `[Document]` (array even for a single-id query);
the fetcher extracts index 0. An empty wire result (Monday's
shape for "doc doesn't exist" OR "doc not visible to token")
surfaces `not_found` with `details.doc_id` — Monday's wire
collapses the two cases into the same shape so the CLI can't
distinguish them (no `forbidden` rewrap; D8 closure). A `null`
`docs` root surfaces `internal_error` with a drift hint (Monday's
documented shape is `[Document]`, possibly empty, never null —
null indicates wire-shape regression worth surfacing loudly per
the M32 IMPL round-1 P2-1 closure).

**Status: v0.4-M32 IMPL landed end-to-end.** Argv parsing + schema
+ wire query document shipped at v0.4-M32 pre-flight; the runtime
body landed at IMPL via {@link getDocument} — single `client.raw`
round-trip with `operationName: 'GetDoc'` pinned at the fetcher
boundary.

Envelope `data: <Document with blocks>` — direct unwrap matching
the read-one-verb convention (`board get` returns
`data: <Board>`, `user get` returns `data: <User>`). The
Document's own `id` field is the echoed input. `data.blocks:
[DocumentBlock]` carries Monday's 9-field block projection;
block-content `content` is a JSON payload opaque to the CLI
(Monday's wire is the source of truth for the per-block-type
shape).

**Live success envelope:**

```json
{
  "ok": true,
  "data": {
    "id": "12345678",
    "object_id": "98765",
    "name": "Q4 launch plan",
    "doc_kind": "private",
    "url": "https://example.monday.com/docs/12345678",
    "relative_url": "/docs/12345678",
    "workspace_id": "5555",
    "workspace": { "id": "5555", "name": "Marketing" },
    "doc_folder_id": null,
    "created_at": "2026-04-12T10:32:11Z",
    "created_by": { "id": "1", "name": "Alice" },
    "updated_at": "2026-05-01T14:22:09Z",
    "settings": null,
    "blocks": [
      {
        "id": "block-1",
        "type": "heading",
        "content": { "level": 1, "text": "Launch milestones" },
        "position": 1.0,
        "parent_block_id": null,
        "doc_id": "12345678",
        "created_at": "2026-04-12T10:32:11Z",
        "created_by": { "id": "1", "name": "Alice" },
        "updated_at": "2026-04-12T10:32:11Z"
      }
    ]
  },
  "meta": { /* §6.1 — source: "live", cache_age_seconds: null */ },
  "warnings": []
}
```

Idempotent: yes (pure read).

---

## completion

### `monday completion <bash|zsh|fish>` (v0.4-M33)

Emit a shell-completion script for the named shell flavour. **First
non-envelope stdout surface in the CLI** — see cli-design §3.1 #2
raw-bytes carve-out for the discipline. Standard install flow:

```bash
monday completion bash >> ~/.bashrc
monday completion zsh  >> ~/.zshrc
monday completion fish >  ~/.config/fish/completions/monday.fish
```

**Status: v0.4-M33 shipped end-to-end (pre-flight cluster
`c619425..affbf70`, 3 Codex rounds; IMPL cluster
`7cbb120..e651674`, 1 fix-up round + ratification).** The IMPL
feat ships the three-mode format-aware action body (raw-bytes
default / `--json` envelope / format-flag rejection) + three
hand-rolled per-shell template builders that walk
`program.commands` at emit time so completions stay in sync with
the registry. Empirical probe at pre-flight
(`grep -rn 'completion\|complete' node_modules/commander/lib/
node_modules/commander/typings/` 2026-05-14, commander 14.0.3)
confirmed commander ships NO built-in completion machinery — the
templates are hand-rolled (Decision 1 closure; no runtime dep
added).

**Three output modes:**

- **Default (no `--json` / no `--output`)**: RAW script bytes on
  stdout, NO envelope, regardless of TTY / pipe context. The standard
  install flow above relies on this — wrapping in a §6 envelope
  would defeat `>> ~/.bashrc`.
- **`--json` / `--output json` / `MONDAY_OUTPUT=json`**: standard §6
  envelope with `data: { shell, script }`. Agents introspect via
  `jq -r '.data.script'`.
- **`--table` / `--output table` / `--output text` / `--output
  ndjson`**: rejected as `usage_error` ("output format not applicable
  to monday completion") — no sensible non-JSON envelope view of a
  multi-line script blob. Only `--json` and `--table` are global
  shorthand flags per cli-design §4.4; `text` and `ndjson` are
  accessible only via the long-form `--output <fmt>` value.

**No wire surface.** CLI-internal verb (no Monday API call, no auth
requirement, no cache). The `--json` envelope's `meta.source` is
always `"none"`.

**`monday schema completion` introspection caveat.** The
`outputSchema` (`completionOutputSchema`) describes the `--json`
envelope shape ONLY — agents calling `monday schema completion`
see the `{ shell, script }` shape below. The default raw-bytes mode
is OUT-OF-BAND of the schema contract: there is no
schema-validatable envelope when the verb writes bare bytes to
stdout. Agents that need to introspect what bytes the default mode
will produce should call `monday completion <shell> --json` and
read `data.script` — the byte sequence is identical between the
default mode and the `--json` envelope's `script` field.

**`--json` envelope shape (M33 pre-flight pinned):**

```json
{
  "ok": true,
  "data": {
    "shell": "bash",
    "script": "# monday-cli bash completion\n_monday_completion() { ... }\ncomplete -F _monday_completion monday\n"
  },
  "meta": { /* §6.1 — source: "none", cache_age_seconds: null */ },
  "warnings": []
}
```

The `script` field is the EXACT same byte sequence the default mode
prints to stdout (the IMPL feat pins a byte-identity round-trip
integration assertion per shell flavour). The contract pins the
SHAPE (one script per closed-enum flavour, opaque string payload)
plus the per-shell directives the IMPL feat shipped: bash scripts
contain `_monday_completion()` + `complete -F _monday_completion
monday`; zsh scripts contain `#compdef monday` + `_monday()`; fish
scripts contain `complete -c monday -f` + per-depth
`__fish_seen_subcommand_from ...` predicate chains.

Idempotent: yes (deterministic per shell flavour). Adding a 4th
shell flavour (`powershell`, `nushell`, etc.) is a SemVer-minor
expansion at the contract + a matching hand-rolled template.

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
