# Example sessions

> Instructional reference, not contract. The binding contract — command
> surface, output envelope, error codes, divergences from Monday's API —
> lives in [`cli-design.md`](./cli-design.md). The examples below show
> what the contract looks like in practice for common agent workflows.

JSON examples show the envelope shape from `cli-design.md` §6 — every
command returns `{ ok, data, meta, ... }`. Examples are abbreviated for
readability (`...` indicates omitted `meta` fields).

## 1. An agent picks up a task and finishes it

> Note: `monday dev …` is a v0.3 namespace. In v0.1 / v0.2 the same
> flow uses the underlying CRUD commands directly:
> `monday item list --board <tasks-bid> --where status=Backlog --where owner=me`,
> `monday item set <iid> status='Working on it'`,
> `monday item set <iid> status=Done` + `monday update create <iid> --body "..."`.

```bash
$ monday dev task list --mine --status not_done --json
{
  "ok": true,
  "data": [
    { "id": "5001", "name": "Refactor login", "board_id": "111",
      "url": "https://...",
      "columns": {
        "status_4": { "id": "status_4", "type": "status", "text": "Backlog",      "label": "Backlog",      "index": 0 },
        "date4":    { "id": "date4",    "type": "date",   "text": "2026-05-01",   "date": "2026-05-01", "time": null }
      } }
  ],
  "meta": {
    "schema_version": "1", "api_version": "2026-01",
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
                                       "title": "Status", "text": "Working on it",
                                       "label": "Working on it", "index": 1 } } },
  "meta": { ... },
  "warnings": []
}

# ... agent edits code, opens PR ...

$ monday dev task done 5001 --message "Shipped in PR #1234" --json
{
  "ok": true,
  "data": { "id": "5001",
            "columns": { "status_4": { "id": "status_4", "type": "status",
                                       "title": "Status", "text": "Done",
                                       "label": "Done", "index": 2 } } },
  "meta": { ... },
  "warnings": [],
  "side_effects": [
    { "kind": "update_created", "id": "u_77", "item_id": "5001",
      "body": "Shipped in PR #1234" }
  ]
}
```

## 2. Bulk re-triage (dry-run then apply)

> The `me` token in `--where owner=me` resolves to the connected user's
> ID (the same value `monday account whoami` returns). It's a special
> token recognized by people-column resolution; ordinary email/ID input
> is also accepted (see `cli-design.md` §5.3).

```bash
$ monday item update --board 12345 \
    --where status=Backlog --where owner=me \
    --set status=Working --dry-run --json
{
  "ok": true,
  "data": null,
  "meta": { "dry_run": true, "schema_version": "1", "api_version": "2026-01", ... },
  "planned_changes": [
    { "operation": "change_column_value",
      "board_id": "12345", "item_id": "5001",
      "resolved_ids": { "status": "status_4" },
      "diff": { "status_4": { "from": { "label": "Backlog", "index": 0 },
                              "to":   { "label": "Working on it", "index": 1 } } } },
    { "operation": "change_column_value",
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
{
  "ok": true,
  "data": {
    "applied": 2, "failed": 0,
    "successes": [{ "item_id": "5001" }, { "item_id": "5002" }],
    "failures": []
  },
  "meta": { ... },
  "warnings": []
}
```

## 3. Discovery for a fresh agent

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

## 4. Pipelining

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

## 5. Cursor-expiry handling (no safe deterministic resume in v0.1)

```bash
# Capture data on stdout, errors on stderr separately.
$ monday item list --board 12345 --all --output ndjson \
    > items.ndjson 2> items.err

# ... 90 minutes of network problems mid-walk ...

# The error envelope is on stderr (never mixed into the data stream).
$ cat items.err
{
  "ok": false,
  "error": {
    "code": "stale_cursor",
    "message": "Cursor expired (60 min lifetime). Restart pagination.",
    "retryable": false,
    "details": {
      "cursor_age_seconds": 5400,
      "items_returned_so_far": 1500,
      "last_item_id": "5042"
    },
    "request_id": "..."
  },
  "meta": { "schema_version": "1", "api_version": "2026-01", "source": "mixed", ... }
}

# v0.1 has no safe deterministic resume (see `cli-design.md` §5.6).
# Recovery options:
#
# Option 1 — Restart from scratch with idempotent downstream ops.
#   The agent's downstream code must tolerate seeing already-processed
#   items again (i.e. status changes are idempotent; comment posting is not).
$ monday item list --board 12345 --all --output ndjson > items.ndjson 2> items.err

# Option 2 — Restart with a filter that's known-stable for THIS walk's purpose.
#   E.g. if the agent only cares about Backlog items, the filter is the
#   stability guarantee.
$ monday item list --board 12345 --where status=Backlog --all \
    --output ndjson > items.ndjson 2> items.err

# Option 3 — Use --filter-json with explicit order_by and dedupe client-side.
#   For agents that need an exhaustive walk and can dedupe on item ID.
$ monday item list --board 12345 \
    --filter-json '{"order_by":[{"column_id":"__creation_log__","direction":"asc"}]}' \
    --all --output ndjson \
  | jq -s 'unique_by(.id) | .[]' > items.ndjson
```
