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
  `monday item create --parent <iid> --name <n>` (M9, classic
  boards only — `hierarchy_type: "multi_level"` rejected
  pre-mutation; deferred to v0.3). The auto-generated subitems
  board's ID is derived server-side from the parent; the CLI
  also derives it client-side (parent's `subtasks` column's
  `settings_str.boardIds[0]`) for column-token resolution.
- **Update column value:** `change_column_value` (single column, typed
  per column kind) or `change_multiple_column_values` (bulk).
- **Move:** `move_item_to_group`, `move_item_to_board`. Neither
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

Other types (`tags`, `board_relation`, `dependency`,
`creation_log`, `mirror`, `formula`, `auto_number`, `last_updated`,
`item_id`, `files`, `battery`, etc.) surface
`unsupported_column_type` from the friendly path. The M8
`--set-raw <col>=<json>` escape hatch accepts the wire JSON
verbatim; it's gated against read-only-forever and files-shaped
types (`add_file_to_column` is a separate multipart mutation
deferred to v0.4).

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

`add_file_to_column` and `add_file_to_update` use `multipart/form-data`.
The SDK's `request()` accepts `File`/`Blob` instances directly — see the
upstream README for the canonical pattern.
