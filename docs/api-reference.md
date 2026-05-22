# Monday API — concepts cheat sheet

> **Supplementary reference, not contract.** The canonical schema view
> for the CLI is [`cli-design.md`](./cli-design.md) §2 (which was
> generated from the live SDK types and verified against the docs).
> This file is a quick orientation cheat sheet — keep in sync, but
> don't treat it as authoritative for design decisions.

This is a quick reference for the entities the CLI cares about. The
canonical Monday docs are at https://developer.monday.com/api-reference/ —
this file exists so an agent reading the repo can get oriented without
leaving the working directory.

## Endpoint & auth

- **URL:** `https://api.monday.com/v2`
- **Method:** `POST`
- **Auth header:** `Authorization: <token>` (no `Bearer ` prefix)
- **API version header:** `API-Version: YYYY-MM` (optional — omit to track
  current stable; pin for reproducibility)
- **Content-Type:** `application/json` (or `multipart/form-data` for file
  uploads)

## Core hierarchy

```
Account
└── Workspace                  (groups boards by team/project)
    └── Board                   (the spreadsheet-like primary object)
        ├── Group               (a section of rows on a board)
        │   └── Item            (a row — a task, ticket, etc.)
        │       ├── Column value (typed cell — text, status, person, …)
        │       ├── Subitem     (nested item — board has its own subitems board)
        │       └── Update      (comment thread on the item)
        └── Column              (column definition: id, type, settings)
```

## Items

Items are the primary object an agent will create / read / update.

- **Read one:** `items(ids: [ID!])` — accepts an array, returns full items.
- **Read many (paginated):** `boards(ids: [ID!]) { items_page(limit: 500) {
  cursor items { ... } } }` — then `next_items_page(cursor: ...)` to
  paginate. The flat `items` query without `ids` is deprecated.
- **Create:** `create_item(board_id, item_name, group_id?,
  column_values?, position_relative_method?, relative_to?,
  create_labels_if_missing?)`. `column_values` is a JSON object
  keyed by column ID (the SDK's `JSON` scalar handles wire
  stringification — the CLI never `JSON.stringify`s). The CLI
  surfaces this as `monday item create --board <bid> --name <n>`
  with optional `--set` / `--set-raw` / `--group` / `--position
  before|after --relative-to <iid>`. M9 ships single-round-trip
  (every `--set` value bundles into `column_values` — no
  fallback two-call pattern; partial-state risk by design per
  cli-design §5.8).
- **Create subitem:** `create_subitem(parent_item_id, item_name,
  column_values?, create_labels_if_missing?)`. Surfaced as
  `monday item create --parent <iid> --name <n>` (v0.9-M50 unified
  dispatch — both classic and multi-level boards, no
  `hierarchy_type`-keyed rejection). The column-resolution target
  board's ID is derived server-side from the parent; the CLI also
  derives it client-side (parent's `subtasks` column's
  `settings_str.boardIds[0]`) for column-token resolution — a
  separate auto-generated sub_items_board on classic boards, the
  self-referenced host board on multi-level boards.
- **Update column value:** `change_column_value` (single column, typed
  per column kind) or `change_multiple_column_values` (bulk).
- **Move:** `move_item_to_group(item_id, group_id)`,
  `move_item_to_board(item_id, board_id: ID!, group_id: ID!,
  columns_mapping?: [ColumnMappingInput!])` (M11). Both return
  the post-mutation `Item`. `move_item_to_board` requires
  `group_id` — Monday picks no default destination group on the
  target board, so the CLI's `monday item move` requires
  `--to-group` for both same-board AND cross-board forms.
  `columns_mapping` is `[{source: ID!, target?: ID}]` —
  strictly source-to-target ID mapping with no value slot, so
  the CLI ships only the simple `--columns-mapping
  '{<src>: <target>}'` form; value-overrides are deferred to
  v0.3. Same-board `move_item_to_group` is wire-level no-op
  when the item is already in the target group (idempotent);
  cross-board `move_item_to_board` re-running on the target
  board is undefined SDK behaviour, so the verb-level
  `idempotent: false` is the conservative bound. Neither
  accepts a position — Monday's 2026-01 API does NOT expose a
  way to reorder existing items via the public GraphQL surface
  (`position_relative_method` is only on `create_item` and
  `create_group`). Post-create reordering is deferred until
  Monday adds the mutation.
- **Archive / delete:** `archive_item(item_id)`,
  `delete_item(item_id)` (M10). Both return the post-mutation
  `Item`; `archive_item` is wire-level idempotent (re-archive is a
  no-op), `delete_item` returns `not_found` past the first call
  (the CLI marks `idempotent: false` because re-running with the
  same `<iid>` after an interim `create` would delete the new
  item).
- **Duplicate:** `duplicate_item(item_id, board_id: ID!,
  with_updates?: Boolean)` (M10). Note the required `board_id`
  parameter — the CLI looks it up via a separate
  `ItemBoardLookup` round-trip before firing the mutation, so
  duplicate's live path is two-leg unlike archive + delete's
  single-leg paths. `with_updates: true` copies the source item's
  updates (Monday "comments") onto the duplicate. Not idempotent
  — every call creates a new item.
- **Upsert:** `monday item upsert --board <bid> --name <n>
  --match-by <col>[,...] [--set ...]` (M12) — three-state branch
  decision (`decideBranch`): 0 matches → `create_item`; 1 match
  → `change_multiple_column_values` with synthetic `name`; 2+
  matches → `ambiguous_match` (the 27th stable error code) with
  `details.candidates: [{id, name}]` (up to 10) so the agent
  tightens `--match-by` and retries. v0.2 match-by safe-list:
  always-safe (`name` / `text` / `long_text` / `numbers` /
  external_id-shaped hidden text), safe-via-label-text (`status`
  / `dropdown`), restricted (`people` → `me` only). Sequential-
  retry idempotent; concurrent agents are not a uniqueness
  guarantee — see cli-design §5.8 + §9.1 + §9.3.

## Updates (Monday "comments") — full mutation surface (M13)

"Updates" in Monday lingo are item-scoped comments. M13 ships
the full mutation surface around them.

- **Create:** `create_update(item_id, body, parent_id?)` — M5b
  ships the create surface. M13 adds the rest:
- **Reply:** `create_update(item_id?, body, parent_id)` —
  threaded reply, surfaced as `monday update reply <parent-id>
  --body <md>`. Note `parent_id` IS the parent update's ID;
  Monday derives `item_id` server-side from the parent.
- **Edit:** `edit_update(id, body)` — `monday update edit
  <update-id> --body <md>`. `idempotent: true`.
- **Delete:** `delete_update(id)` — `monday update delete <id>
  --yes`. Destructive; `--yes` mandatory.
- **Like / unlike / pin / unpin:** `like_update` / `unlike_update`
  / `pin_to_top` / `unpin_from_top`, all keyed by the update id.
  The CLI ships them as four matching verbs.
- **Clear-all:** `clear_all_updates(item_id)` — `monday update
  clear-all <item-id> --yes`. **First partial-success consumer**
  — returns `data.results: [{update_id, ok, error?}]`. Envelope
  is `ok: true` whenever the dispatch ran (even if every per-
  target call failed); per-target failures land in
  `data.results[i].error`, not the top-level `error` slot. This
  is the §6.4 partial-success contract M13 introduced; M14's
  workspace add/remove-users + M15's board add-users reuse it.

**Default-replies behaviour change** (M13's one breaking
change): `monday update list` no longer populates `replies` by
default — pass `--with-replies` to opt in. The pre-M13 default
populated `replies`; agents relying on the old behaviour pin
the flag explicitly.

## Workspaces — full lifecycle (M14)

`Workspace` is the top-level container for boards. M14 ships
the full mutation surface:

- **Create:** `create_workspace(name, kind, description?)` —
  `monday workspace create --name <n> --kind <open|closed> [--description <d>]`.
- **Update:** `update_workspace(id, attributes: {name? /
  description?})` — per-attribute fan-out via the
  `attributes` input object.
- **Delete:** `delete_workspace(workspace_id)` — destructive,
  `--yes` mandatory.
- **Add / remove users:** `add_users_to_workspace` /
  `delete_users_from_workspace` with `[user_ids: [ID!]!,
  kind: 'subscriber' | 'owner']`. M14's first **resolver-fronted
  partial-success** consumer — `--users` accepts mixed numeric
  IDs + emails; emails resolve through `userByEmail` per-token,
  and per-token resolution failures land as
  `data.results[i]: { user_id: <input-token>, ok: false, error:
  { code: 'user_not_found', message } }` records (the input
  token echoed verbatim because the resolved Monday ID isn't
  known on a failure). Whole-call `ok: false` with code
  `user_not_found` fires only when no dispatchable user_id
  remains after parsing/resolution.

## Boards — full lifecycle (M15)

`Board` is the central organising entity. M15 ships the full
mutation surface:

- **Create:** `create_board(board_name, board_kind, workspace_id?,
  description?, folder_id?, template_id?, board_owner_ids?,
  board_owner_team_ids?, board_subscriber_ids?,
  board_subscriber_team_ids?)` —
  `monday board create --name <n> --kind <public|private|share>`
  with optional `--workspace <id>` / `--folder <id>` /
  `--template <bid>`.
- **Update:** `update_board(board_id, board_attribute,
  new_value)` — per-attribute fan-out across the single
  `update_board` wire surface. CLI flag mapping: `--name` →
  `board_attribute: name`, `--description` →
  `board_attribute: description`. The success-envelope `data`
  projects from a **force-live final read leg** because Monday's
  per-attribute calls return only the changed slice (distinguishes
  board-update from M16 column-update + M17 group-update which
  both project from the trailing per-attribute response).
- **Archive / delete:** `archive_board(board_id)` /
  `delete_board(board_id)`. Both destructive, `--yes` mandatory.
- **Duplicate:** `duplicate_board(board_id, board_name,
  duplicate_type: DuplicateBoardType, folder_id?, workspace_id?,
  keep_subscribers?)`. **Wrapped envelope** —
  `data: { board: <projection>, is_async }` because Monday's
  `BoardDuplication` carries an `is_async` slot the projection
  doesn't model. When `is_async: true` agents poll the new board
  for readiness rather than treating the response as the final
  state.
- **Add users:** `add_subscribers_to_board(board_id, user_ids,
  kind)` — partial-success consumer (M14 add/remove-users
  reused).

## Board structure — columns + groups (M16, M17)

M16 and M17 ship the full board-structure mutation surface plus
introduce the **§8 eager-invalidation contract**: every board-
structure mutation calls `invalidateBoard(boardId)` post-success
so a same-process `board describe` / `board groups` / `board
columns` sees fresh state without TTL eviction.

### Columns (M16)

- **Create:** `create_column(board_id, column_type, title,
  description?, defaults?)`. Note the wire arg is `defaults: JSON`,
  NOT `settings_str` (which is the read-side serialisation).
  M16 omits `id` (agent-supplied custom column id) +
  `after_column_id` (placement) — agents needing them use M9's
  `dev mutate` escape hatch. The CLI emits a
  `noncanonical_column_type` warning for non-allowlisted types
  with per-category `suggested_write_path`
  (`raw_writable` / `read_only_forever` / `files_shaped`).
- **Update:** per-attribute fan-out across **two** wire surfaces.
  `--title` routes to `change_column_title(board_id, column_id,
  title)` (the more-specific surface); `--description` routes to
  `change_column_metadata(board_id, column_id,
  column_property: description, value)`. `column-update`'s
  success-envelope `data` projects from the trailing per-
  attribute call's response (no force-live read leg —
  distinguishes column-update from board-update).
- **Delete:** `delete_column(board_id, column_id)`. Destructive,
  `--yes` mandatory. **First two-tuple destructive verb** —
  `confirmation_required` envelope echoes `{board_id, column_id,
  hint}` per cli-design §6.5 (the wire signature is two-tuple,
  so both ids ride in `details`). Note: Monday has NO
  `archive_column` mutation — column lifecycle is delete-only.

### Groups (M17)

- **Create:** `create_group(board_id, group_name, group_color?)`.
  `--name` is required; `--color` validates against the pinned
  `GROUP_COLOR_VALUES` palette in `src/api/group-color.ts` (41-
  name set covering Monday's documented group colours). M17
  omits all three placement arguments (`position` deprecated,
  `position_relative_method` + `relative_to` deferred to v0.3
  with `--before <gid>` / `--after <gid>` flags).
- **Update:** `update_group(board_id, group_id,
  group_attribute: GroupAttributes!, new_value: String!)` — per-
  attribute fan-out across a **single** wire surface (simpler
  than column-update's two-surface fan-out). `--name` →
  `group_attribute: title`, `--color` → `group_attribute: color`.
  v0.2 surfaces only `title` + `color`; the position-related
  enum values (`position` deprecated, `relative_position_after`
  / `relative_position_before` non-deprecated) are deferred to
  v0.3. **No force-live read leg** — Monday's `update_group`
  returns the full Group projection post-mutation, so the
  trailing per-attribute call's response is authoritative
  (mirrors column-update; diverges from board-update's force-
  live shape). This is the load-bearing M17-pre-flight finding.
- **Archive:** `archive_group(board_id, group_id)`. Destructive,
  `--yes` mandatory. **2nd two-tuple destructive verb** after
  M16 column-delete; `confirmation_required` envelope echoes
  `{board_id, group_id, hint}`. Idempotent — re-archiving an
  already-archived group is a no-op. Dry-run is **snapshot-
  bearing** (mirrors `board archive` — recoverable destructive,
  preview shows what will be hidden).
- **Duplicate:** `duplicate_group(board_id, group_id,
  add_to_top?, group_title?)`. **Load-bearing divergence from
  sibling duplicate verbs** — Monday's `duplicate_group` wire
  signature has NO `with_updates` argument, unlike
  `duplicate_item` and `duplicate_board`. The M17 pre-flight
  pinned the wire truth and dropped the flag. `--name` maps to
  wire `group_title?`.
- **Delete:** `delete_group(board_id, group_id)`. Destructive,
  `--yes` mandatory. **3rd two-tuple destructive verb** after
  column-delete + group-archive. Dry-run is minimal destructive-
  no-read (mirrors `column-delete` / `board delete`).

## Column values

Each column type has its own JSON shape. The 10 types the CLI's
friendly translator surfaces (writable allowlist post-M8):

| Type | Example wire value | CLI translator |
|------|--------------------|----------------|
| `text` | `"some text"` | bare string |
| `long_text` | `{"text": "..."}` (multi) / `"..."` (simple) | bare string + multi re-wrap |
| `numbers` | `"42"` | bare string |
| `status` | `{"label": "Done"}` or `{"index": 1}` | label-first / `{index:N}` for non-negative integer |
| `dropdown` | `{"labels": ["Backend"]}` or `{"ids": [1,2]}` | comma-split, all-numeric → ids, else labels |
| `date` | `{"date": "2026-04-29", "time": "14:30:00"}` | ISO + relative tokens (`+1w` / `today` / `tomorrow`) resolved against `MONDAY_TIMEZONE` |
| `people` | `{"personsAndTeams": [{"id": 12345, "kind": "person"}]}` | comma-split emails / `me` token, resolved via `userByEmail` |
| `link` (M8) | `{"url": "https://example.com", "text": "Example"}` | pipe-form `url|text` |
| `email` (M8) | `{"email": "alice@example.test", "text": "Alice"}` | pipe-form `email|text` or bare email |
| `phone` (M8) | `{"phone": "+14155550100", "countryShortName": "US"}` | E.164 with explicit `phone:countryCode` |
| `tags` (M19) | `{"tag_ids": [101, 202]}` | comma-split tag names, resolved via per-account directory cache |
| `board_relation` (M19) | `{"item_ids": [12345, 67890]}` | comma-split item IDs, validated against `column.settings.boardIds` |
| `dependency` (M19) | `{"item_ids": [12345, 67890]}` | sibling of `board_relation`; reads `column.settings.dependencyBoards` |

Other types (`creation_log`, `mirror`, `formula`, `auto_number`,
`last_updated`, `item_id`, `files`, `battery`, etc.) surface
`unsupported_column_type` from the friendly path. The M8
`--set-raw <col>=<json>` escape hatch accepts the wire JSON
verbatim; it's gated against read-only-forever and files-shaped
types. For file columns, use the dedicated
`monday item upload <iid> --column <col> <file>` verb (v0.4-M31,
multipart wire) — the underlying Monday mutation is
`add_file_to_column`, a separate multipart endpoint that
neither the friendly translator nor `--set-raw` can reach.

> The `person` column type is deprecated in Monday's schema — use
> `people` (plural) for both single-assignee and multi-assignee
> values. SDK 14.0.0 still types both, but new boards always
> create the `people` form.

Use `change_simple_column_value` for the simple text/number case to skip
the JSON-string layer.

## Column resolution (the CLI's `<col>` token)

The CLI accepts a column ID *or* a column title in `--set`,
`--where`, and `--columns` flags. Resolution rules are normative —
agents key off them. The full implementation is in
`src/api/columns.ts`; the canonical contract is `cli-design.md` §5.3.

Order of resolution:

1. **Exact ID match** — Monday IDs are stable lowercase snake_case
   strings (`status_4`, `date_1`). Case-sensitive.
2. **NFC-normalised exact title match** — titles are NFC-normalised,
   trimmed, internal whitespace collapsed to single spaces. So
   `Café` (composed) and `Café` (decomposed) resolve identically;
   `Plan A` and `Plan   A` (multiple spaces) match the same target.
3. **NFC + case-fold fallback** — locale-independent
   (`toLocaleLowerCase('und')`). Picks up `STATUS` matching `Status`
   when no NFC-exact match exists.
4. **Multi-match** at any level → `ambiguous_column` with
   `details.candidates`.
5. **No match** → `column_not_found`. Read-paths that hit a missing
   column on a cache hit auto-refresh the metadata once before
   surfacing.

**Explicit prefix syntax:** `id:status_4` forces the ID path,
`title:Status` forces the title path. Useful when an ID and a title
collide. The `id:` form still emits a `column_token_collision`
warning when the value also matches a different column's title —
informational so agents auditing data shape see the overlap.

**Archived columns** are filtered out by default; they surface as
`column_not_found` for read paths. Pass `--include-archived` on read
commands to see them. Mutations against an archived column return
`column_archived` regardless.

## Board describe (the introspection seam)

`monday board describe <bid>` is the single richest read in v0.1 —
columns + groups + `hierarchy_type` + `is_leaf` + per-column
`example_set` of suggested `--set` invocations for every writable
column type. Agents that have run `board describe` once can
construct a mutation against any M5b-writable column without
consulting Monday's docs. Ships live for v0.1 reads; M5b mutations
read it through the cached `loadBoardMetadata` helper.

`monday board doctor <bid>` (M6) layers diagnostics on top of the
same metadata: duplicate column titles (would cause
`ambiguous_column` at write time), columns with non-writable types
(per the v0.1 / v0.2 / read-only-forever roadmap split), and
broken `board_relation` targets. Run it before a bulk update
session to catch problems up front.

## Monday Dev specifics

Monday Dev is built on top of normal boards/items with conventions:

- **Tasks board** — items are tasks; usually has `Sprint`, `Epic`,
  `Status`, `Owner`, `Priority`, `Effort` columns.
- **Epics board** — connected to the tasks board via a `connect_boards`
  column (the "Epic" column on tasks links to a row on the epics board).
- **Sprints board** — current/next/past sprints; tasks reference a sprint
  via a connect-boards column.
- **Bugs board** — same shape as tasks, separate board.

There is no separate Dev API — everything goes through the standard
GraphQL items/boards endpoints. The CLI surfaces these as `monday dev …`
subcommands for ergonomic shortcuts (e.g. `monday dev sprint current`)
that resolve the right board IDs from config.

## Rate limits & complexity

Monday charges a "complexity budget" per minute (10M points / minute by
default). Each field has a complexity cost that scales with the number
of objects returned. A query that returns 500 items × 20 columns costs
substantially more than the same query for 10 items.

The API wrapper in `src/api/` should:

1. Surface `429` (rate limit) and complexity errors with the
   `retry_in_seconds` field from Monday's response.
2. Apply exponential backoff with jitter for transient errors.
3. Log query complexity at `--verbose` so users can spot expensive calls.

## File uploads

`add_file_to_column` and `add_file_to_update` use `multipart/form-data`
(GraphQL multipart-request specification — jaydenseric). The CLI ships
its own multipart transport at `src/api/multipart-transport.ts`
(separate from the JSON-only `Transport` in `transport.ts`); the
spec-compliant `operations` + `map` + file parts live there.
Agent-facing verbs:

- `monday item upload <iid> --column <col> <file>` (v0.4-M31; file
  column only).
- `monday update upload <uid> <file>` (v0.4-M31; attaches to
  Updates).
