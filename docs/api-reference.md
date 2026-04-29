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
- **Create:** `create_item(board_id, group_id, item_name, column_values)`.
  `column_values` is a JSON-stringified object keyed by column ID.
- **Update column value:** `change_column_value` (single column, typed
  per column kind) or `change_multiple_column_values` (bulk).
- **Move:** `move_item_to_group`, `move_item_to_board`.
- **Reorder within group:** `change_item_position` (relative to another
  item).
- **Archive / delete:** `archive_item`, `delete_item`.

## Column values

Each column type has its own JSON shape. Common ones:

| Type | Example value (JSON-stringified) |
|------|----------------------------------|
| `text` | `"some text"` |
| `long_text` | `{"text": "..."}` |
| `status` | `{"label": "Done"}` or `{"index": 1}` |
| `person` | `{"personsAndTeams": [{"id": 12345, "kind": "person"}]}` |
| `date` | `{"date": "2026-04-29", "time": "14:30:00"}` |
| `dropdown` | `{"labels": ["Backend", "Frontend"]}` |
| `link` | `{"url": "...", "text": "..."}` |
| `numbers` | `"42"` |

Use `change_simple_column_value` for the simple text/number case to skip
the JSON-string layer.

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
