# Architecture

> **Canonical contract:** the binding decisions about command surface,
> output envelope, error codes, and divergences from Monday's API live
> in [`cli-design.md`](./cli-design.md). This file describes the
> *internal* module structure that implements that contract.

## Goals (in priority order)

1. **AI-agent ergonomics.** Output should be predictable, parseable
   (default `--output json`), and stable across versions. Errors should
   carry enough structured context that an agent can recover or escalate
   without scraping prose. Side-effecting commands should be idempotent
   where the API allows.
2. **Type safety.** Every Monday entity that crosses a module boundary
   has an explicit type. Parsing is done at the edge (zod for env/argv,
   the SDK's generated types for GraphQL responses) so internal code
   only handles validated data.
3. **Composability.** A user (human or agent) should be able to chain
   commands with shell pipes — e.g. `monday items list ... | jq ... |
   xargs monday items update ...`. This shapes I/O design more than
   any single command.
4. **Human ergonomics, second.** Pretty tables, colour, spinners — but
   only when stdout is a TTY and `--output json` is not set.

## Module boundaries

```
   ┌──────────┐
   │ cli/     │   argv parsing, signal/abort plumbing, envelope emission
   └────┬─────┘
        │ resolves Config, dispatches to a command module via the registry
        ▼
   ┌──────────┐
   │ commands/│   one CommandModule per subcommand: parses argv, calls
   └────┬─────┘   api/, validates output, emits the §6 envelope
        │
        ▼
   ┌──────────┐
   │ api/     │   MondayClient over an injectable Transport: typed
   └────┬─────┘   errors, retries, abort threading, complexity surfacing
        │
        ▼
   ┌──────────┐
   │ Monday   │   network — never reached directly from commands/
   └──────────┘
```

### `cli/` (the runtime core)

- `cli/index.ts` — 5-line shebang entry; thin `runWithSignals` wrapper.
- `cli/run.ts` — testable runner: argv → commander parse → action body
  → envelope → exit code. Combines a caller-supplied abort signal with
  an internal one so SIGINT cancels in-flight work.
- `cli/program.ts` (M2.5) — commander wiring: program metadata, global
  flag declarations, command registration. Pulled out of `run.ts` so
  the runner stays focused on I/O plumbing.
- `cli/envelope-out.ts` (M2.5) — `MetaBuilder` + `writeErrorEnvelope`.
  The error path's source of truth for `meta.api_version` /
  `meta.source` so a thrown action error carries the same meta a
  success would.

### `commands/` (one CommandModule per verb)

- `commands/types.ts` — `CommandModule<I, O>` interface + the
  `ensureSubcommand` idempotent noun-creator.
- `commands/index.ts` — static registry. `cli/program.ts` walks it to
  attach commands; `commands/schema/index.ts` walks the same registry
  to emit JSON Schema 2020-12.
- `commands/emit.ts` — `emitSuccess` builds the §6 success envelope.
  Owns format selection (json / table / text / ndjson), the
  collection-meta passthrough (`nextCursor`, `hasMore`,
  `totalReturned`, `columns`), and final-byte token redaction.
- `commands/parse-argv.ts` (M3) — wraps `schema.safeParse` so
  positional/flag failures land as `usage_error` (exit 1), never the
  runner's catch-all `internal_error` (exit 2). Mandatory at every
  argv parse boundary per `validation.md`.
- `commands/<noun>/<verb>.ts` — the action. Parses argv via
  `parseArgv`, calls into `api/`, projects to the strict output
  schema, calls `emitSuccess({ ...toEmit(result) })`.
- `commands/run-by-id-lookup.ts` (M4 R7) — shared get-by-id action
  helper covering the `parseArgv → resolveClient → client.raw →
  not_found-on-empty → emit` shape used by `workspace get`,
  `board get`, `user get`, `update get`, `item get`. Optional
  `project` callback for shapes that need a parse-then-project step
  (item get uses it for the column-value projection).

### `api/` (network + cache)

- `api/transport.ts` — `Transport` interface + `FetchTransport`. Owns
  header lockdown (`Authorization`, `API-Version`, `Content-Type` are
  transport-controlled; caller headers can't override) and timeout +
  abort signal combination.
- `api/client.ts` — `MondayClient` over `Transport`. Typed wrappers
  for the M2 account queries; `client.raw<T>(query, vars, opts)` is
  the escape hatch for queries the SDK doesn't type
  (`hierarchy_type` / `is_leaf` in M3, future `BatteryValue` etc.).
- `api/resolve-client.ts` (M2.5) — `resolveClient(ctx, programOpts)`
  returns `{ client, globalFlags, apiVersion, toEmit }`. Every
  network command calls this once at the action's top.
- `api/errors.ts` — maps Monday HTTP / GraphQL responses to the 26
  stable CLI error codes from §6.5.
- `api/retry.ts` — exponential backoff + jitter, honours
  `retry_after_seconds` and the abort signal.
- `api/cache.ts` — disk-backed cache primitives: per-board metadata,
  per-account user directory, schema version pin. `0600` mode +
  atomic writes (tmp + rename) + permission verification on read.
- `api/board-metadata.ts` (M3) — cache-aware `loadBoardMetadata`
  shared by `board describe` / `columns` / `groups`. Returns
  `{ metadata, source, cacheAgeSeconds, complexity }` so verbose-mode
  complexity flows through cache-aware commands.
- `api/columns.ts` (M3) — read-side §5.3 column resolver:
  `resolveColumn(metadata, token, options) → ColumnMatch` (pure) +
  `resolveColumnWithRefresh({...})` (auto-refreshes once on
  `column_not_found` after a cache hit). M5a's value translator will
  reuse this for `--set <token>=<value>`.
- `api/resolvers.ts` (M3) — `findOne(haystack, query, project,
  options)` for the `find` verb (NFC + case-fold + `--first`); plus
  `userByEmail` with directory-cache + `users(emails:)` fallback for
  M5a's people-column writes.
- `api/walk-pages.ts` (M3) — page-based pagination walker with
  `--limit-pages` cap + `pagination_cap_reached` warning. Used by
  every page-based list command (`workspace` / `board` / `user` /
  `update`). Cursor-based pagination has a fundamentally different
  contract (§5.6 stale-cursor fail-fast, no silent re-issue) and
  ships in its own module — see `api/pagination.ts` below.
- `api/pagination.ts` (M4) — cursor-based pagination walker for
  `items_page` / `next_items_page`. `paginate({fetchInitial,
  fetchNext, extractPage, getId, all, limit, pageSize, onItem,
  now})` honours the §5.6 contract: 60-min cursor lifetime,
  fail-fast on `stale_cursor` with enriched
  `details.cursor_age_seconds / items_returned_so_far /
  last_item_id`, never silently re-issued. Per-call effective
  limit = `min(pageSize, remainingBudget)` so Monday's cursor
  advances over exactly the rows the walker emits — no silent skip
  on `--limit < pageSize` resume. `onItem` is the streaming hook
  for `item list --output ndjson`. Used by `item list / search /
  find`.
- `api/filters.ts` (M4) — `--where` parser + `--filter-json`
  passthrough. `parseWhereSyntax(raw)` is pure (testable without
  network); `buildFilterRules({metadata, resolveMe, clauses,
  onColumnNotFound})` resolves tokens via M3's column resolver and
  emits Monday's `query_params.rules`. `onColumnNotFound` fires
  once on a cache-miss to honour §5.3 step 5; the result's
  `refreshed` flag drives the caller's `meta.source: 'mixed'`
  decision. Operator allowlist: `=`, `!=`, `~=`, `<`, `<=`, `>`,
  `>=`, `:is_empty`, `:is_not_empty`. `--where` / `--filter-json`
  are mutually exclusive.
- `api/sort.ts` (M4) — per-page numeric-ID-asc sort
  (`compareNumericId` + `sortByIdAsc`). Length-then-lex tuple
  handles IDs past 2^53 correctly (string-lex sort fails: `"9" >
  "10"`; `Number.parseInt` loses precision on large IDs).
  Centralised here so the rule applies identically across `item
  list / search / find / subitems` per §3.1 #8.
- `api/item-projection.ts` (M4) — `rawItemSchema` (parse boundary
  for items_page item shapes) + `projectItem({raw, columnTitles?,
  omitColumnTitles?})` (canonical §6.2 single-item shape). Single-
  resource calls keep per-cell `title` inline (§6.2); collection
  calls drop per-cell `title` and let `meta.columns` carry the
  canonical view (§6.3). Typed inline fields (`label/index`,
  `date/time`, `people: [...]`) for the v0.1-allowlisted writable
  types; other types surface `text + value`. `idFromRawItem`
  exposes the defensive id-reader the cursor walker needs for the
  per-page sort.
- `api/column-types.ts` (M5a R8) — single source of truth for
  the v0.1 writable allowlist. Exports `WRITABLE_COLUMN_TYPES`
  (frozen `as const` array — order is part of the contract;
  tests iterate it), `isWritableColumnType` (type guard
  narrowing to the `WritableColumnType` union), and
  `parseColumnSettings` (defensive `settings_str` JSON parser
  that returns `null` on null/empty/malformed input). Two
  consumers: `commands/board/describe.ts` (writable +
  example_set) and `api/column-values.ts` (the writer). Adding
  a v0.2 type is one entry's worth of edit.
- `api/column-values.ts` (M5a) — write half of
  §5.3. **Two entry points**: the sync `translateColumnValue({
  column, value, dateResolution? }) → TranslatedColumnValue`
  covers the six locally-resolvable types; the async
  `translateColumnValueAsync({ column, value, dateResolution?,
  peopleResolution? }) → Promise<TranslatedColumnValue>` is the
  unified wrapper M5b's command layer always calls (delegates
  to sync for non-people; dispatches `parsePeopleInput` for
  `people`, which needs network/cache lookup for email→ID
  resolution). The result type returns `columnId`, `columnType`,
  `rawInput`, a discriminated `payload`, and parallel echo slots
  (`resolvedFrom: DateResolution | null` for relative dates;
  `peopleResolution: PeopleResolution | null` for people inputs).
  Payload variants: `{ format: 'simple', value: string }` for the
  bare-string form (`change_simple_column_value`) or `{ format:
  'rich', value: JsonObject }` for the JSON-object form
  (`change_column_value` / per-column entry of
  `change_multiple_column_values`). **All seven v0.1 types
  translate**: `text` / `long_text` / `numbers` (simple) and
  `status` / `dropdown` / `date` / `people` (rich).
  **`selectMutation`** dispatches per cli-design §5.3 step 5:
  1 simple → `change_simple_column_value`; 1 rich →
  `change_column_value`; N → `change_multiple_column_values`
  (atomic, with `long_text` re-wrapped to `{text:<value>}` for
  the multi mutation's per-column blob).
  **Monday `JSON` scalar discipline:** every payload is a plain
  JS value typed as `JsonObject` (R-JsonValue refactor —
  catches non-JSON shapes like `undefined` / symbols at compile
  time); the SDK / fetch layer stringifies at the wire
  boundary. The translator never `JSON.stringify`s — pinned by
  regression tests per (count × type) cell.

- `api/dates.ts` (M5a) — pure date helpers powering the date
  translator. `parseDateInput` accepts ISO date / ISO date+time
  / relative tokens (`today` / `tomorrow` / `+Nd` / `-Nw` /
  `+Nh`) and resolves relative inputs against an injected
  clock + IANA timezone (defaults to system clock + system tz;
  M5b's command layer plumbs `MONDAY_TIMEZONE`). `+Nd`/`+Nw`
  use calendar-component arithmetic in the resolution tz so
  DST is irrelevant; `+Nh` uses instant arithmetic so wall-
  clock hour shifts ±1 across a DST boundary day, matching
  industry-standard `Instant.add` semantics. Relative offsets
  are bounded to ±100 years magnitude (`MAX_RELATIVE_DAYS` /
  `MAX_RELATIVE_HOURS`) so unsafe inputs surface as typed
  `usage_error`. `formatNowInTimezone` builds the local-time
  ISO + longOffset string cli-design §5.3 line 786 pins
  (`2026-04-25T14:00:00+01:00`).

- `api/people.ts` (M5a) — pure people-resolution helpers
  powering the people translator. `parsePeopleInput` accepts
  comma-split tokens (emails or case-insensitive `me`),
  trim+filter empty segments, then resolves each through an
  injected `PeopleResolutionContext` carrying `resolveMe`
  (mirrors `filters.ts`'s slot — same `me` rule across
  `--where Owner=me` and `--set Owner=me`) and `resolveEmail`
  (M5b wires this to `resolvers.userByEmail`). Wire shape
  `{personsAndTeams:[{id:N,kind:'person'},...]}` with `id` as
  JS number; `kind` literal `'person'` only (teams deferred to
  v0.2). `me` resolution cached within a single call (input
  `me,me,me` resolves once). Defence-in-depth ID validation
  via the shared `DECIMAL_USER_ID_PATTERN` (R16, exported from
  `src/types/ids.ts`) matched against the same shape
  `userByEmail`'s schema enforces — malformed IDs surface as
  `internal_error` rather than silently corrupting the wire
  payload via `Number()`. Numeric tokens (`--set
  Owner=12345`) rejected with `usage_error` carrying
  `deferred_to: "v0.2"` (M5b post-mortem Path B — `--set-raw`
  itself was deferred to v0.2's writer-expansion milestone, so
  the original paste-ready hint pointed at a non-existent
  flag); unknown emails bubble `user_not_found` from the
  resolveEmail callback per cli-design §5.3 line 733. `parsePeopleInput`
  also returns a `resolution: PeopleResolution` echo (one
  `{input, resolved_id}` entry per non-empty input token) the
  dry-run engine renders as `details.resolved_from` on the diff
  cell.

- `api/me-token.ts` (M5a R15) — shared `isMeToken(token)`
  recogniser plus the frozen `ME_TOKENS` array. Three
  consumers: `filters.ts` (`--where Owner=me`),
  `commands/item/search.ts` (search filter), and `api/people.ts`
  (`--set Owner=me`). One rule across all three surfaces per
  cli-design §5.3 step 3 line 704-707; lifted out of three
  verbatim copies that had drifted across the people-session
  Codex passes. v0.2 grammar extensions (`i` / `@me`) land by
  adding to the array.

- `api/dry-run.ts` (M5a) — orchestrator the M5b mutation
  surfaces (`item set` / `item clear` / `item update`) call
  when `--dry-run` is set. Single export `planChanges({client,
  boardId, itemId, setEntries, dateResolution?,
  peopleResolution?, env?, noCache?})` ties together the M3
  cache-aware column resolver (with `includeArchived: true` so
  archived targets surface as `column_archived`, not
  `column_not_found`), `translateColumnValueAsync` +
  `selectMutation` for the wire shape, and a fresh item-state
  read for the diff `from` side. **Output matches cli-design
  §6.4's `planned_changes[]` shape byte-for-byte**, pinned via
  a `JSON.stringify(result.plannedChanges[0])` literal-byte
  snapshot test (the load-bearing M5a exit gate). **All-or-
  nothing**: any resolution failure (`column_not_found`,
  `ambiguous_column`, `column_archived`,
  `unsupported_column_type`, `user_not_found`, item `not_found`,
  item-on-wrong-board, duplicate token, duplicate resolved id)
  aborts the batch BEFORE the item read fires. The diff `to`
  side projects through `selectMutation`'s `columnValues` map
  for multi paths so the `long_text` re-wrap (`{text: <value>}`
  inside multi) surfaces verbatim. Resolver warnings on a
  `column_archived` throw fold into
  `error.details.resolver_warnings` so a stale-cache-then-
  archived flow keeps both signals. The engine's own
  `rawItemSchema.parse` boundary uses safeParse +
  `ApiError(internal_error)` per validation.md (mirrors R17 +
  the userByEmail wrap).

- `types/json.ts` (M5a R-JsonValue) — `JsonValue` /
  `JsonObject` types narrowing the rich-payload slot to
  JSON-shaped values. Replaces `Readonly<Record<string,
  unknown>>` for column-values' rich-payload type, the
  `selectMutation` discriminated union's rich variant, and
  `MultiColumnValue`. Catches non-JSON values (`undefined`,
  symbols, functions, class instances) at compile time;
  documented limitations include NaN/Infinity (silently
  become `null` via `JSON.stringify`), cycles, symbol keys,
  and BigInt (none of which TypeScript can structurally
  exclude).

- `api/item-helpers.ts` (M5b R9) — shared item-command
  helpers + GraphQL fragments. Exports:
  - `COLUMN_VALUES_FRAGMENT` — the §6.2 column-value
    selection (`id type text value column { title }`)
    used by every item-shape query.
  - `ITEM_FIELDS_FRAGMENT` — the full §6.2 item shape
    (id / name / state / url / created_at / updated_at /
    board { id } / group { id title } / parent_item { id } /
    column_values).
  - `collectColumnHeads(metadata)` — per-board column
    heads for `meta.columns` consolidation.
  - `titleMap(metadata)` — column-id → title `ReadonlyMap`.
  - `resolveMeFactory(client)` — closure-cached `me` token
    resolver via `client.whoami()`.
  - `parseRawItem(raw, details?)` — R18-wrapped raw item
    schema parser; safeParse + `ApiError(internal_error)`.
  - `projectFromRaw(raw, titles, options)` — parse + project
    + apply §6.3 same-board title de-dup.
  Six consumers: `item get / list / find / search /
  subitems` + the dry-run engine + `item set`. R9
  eliminated 10 verbatim fragment copies + 4 per-command
  scaffolding duplicates pre-M5b.

- `utils/parse-boundary.ts` (M5b R18) — `unwrapOrThrow`
  helper centralising the safeParse + `ApiError(internal_
  error, ..., { details: { issues } })` pattern per
  validation.md "Never bubble raw ZodError out of a parse
  boundary". Applied at `api/board-metadata.ts` (live-fetch
  responseSchema + projectBoard), `api/item-helpers.ts
  parseRawItem` (4 item commands + dry-run engine),
  `commands/emit.ts schema.parse` (drift catch),
  `commands/item/set.ts boardLookupResponseSchema` (the
  implicit board-lookup boundary). Cache-read parses
  (`board-metadata parseCacheEntry`, `resolvers.ts
  readDirectoryCache`) intentionally don't use this — the
  surrounding cache-miss try/catch swallows them as
  misses (corrupt cache → re-fetch live).

- `commands/item/set.ts` (M5b) — first M5b mutation
  surface. `monday item set <iid> <col>=<val> [--board
  <bid>]`. Two paths share resolution + translation: live
  goes through `resolveColumnWithRefresh` +
  `translateColumnValueAsync` + `selectMutation` + the
  Monday `change_*_column_value` mutation; `--dry-run`
  delegates to `api/dry-run.ts planChanges`. Live mutation
  envelope echoes `resolved_ids: { token: column_id }` per
  cli-design §5.3 step 2. Resolver-warning preservation via
  `foldResolverWarningsIntoError` covers every typed
  post-resolution failure (UsageError translators, ApiError
  `unsupported_column_type` / `user_not_found`, mutation-
  time `validation_failed`). `maybeRemapValidationFailedTo
  Archived` remaps `validation_failed` → `column_archived`
  on cache-sourced resolution if a forced refresh confirms
  the archived state.

- `commands/item/clear.ts` (M5b session 2) — dedicated
  per-column clear verb. `monday item clear <iid> <col>
  [--board <bid>]`. Reuses the resolution / mutation
  selection / projection pipeline; the only divergence from
  `item set` is the value source: `translateColumnClear` in
  `api/column-values.ts` returns the per-type clear payload
  (text → `""`, status → `{}`, etc.) rather than translating
  user input. Per-type table is the canonical "what's a
  clear" mapping and lives alongside the writer's
  set-payload table.

- `commands/item/update.ts` (M5b session 2) — multi-column
  atomic update + bulk path. `monday item update <iid>
  --set <col>=<val> [--set ...] [--name <n>]` for
  single-item; `monday item update --where <expr> --set
  ... --board <bid> --yes` for bulk. Single-item uses
  `selectMutation` to pick simple / rich / multi mutation;
  `--name` synthesises a `name` translated value that
  bundles into `change_multiple_column_values` alongside
  real columns (Monday's multi mutation accepts `name` as
  a key). Bulk walks `items_page` / `next_items_page`
  cursor pagination, fail-fast on `stale_cursor`. Bulk
  without `--yes` / `--dry-run` → `confirmation_required`
  with `matched_count` + filter shape. Bulk live: per-item
  sequential mutation; per-item failure decorates error
  with `applied_count` / `applied_to` / `failed_at_item`
  / `matched_count`. Bulk dry-run: aggregates per-item
  `planChanges` results into one N-element
  `planned_changes`; deduplicates resolver warnings by
  `code+message+token`. Cache-source aggregation across
  metadata + page walk + mutation legs (cli-design §6.1).

- `commands/update/create.ts` (M5b session 2) — posts a
  Monday update (comment) on an item via `create_update`.
  Body sources: `--body <md>` inline, `--body-file <path>`,
  or `--body-file -` for stdin (whitespace-only / empty
  input → `usage_error`). `idempotent: false` because
  re-running produces duplicate comments. `--dry-run` is
  supported despite that; the dry-run shape diverges from
  column-mutation shape (no `board_id` / `resolved_ids`
  / `diff` — instead `operation: "create_update"` +
  `body` + `body_length`); `meta.source: "none"` because
  no API call fires.

- `api/resolver-error-fold.ts` (M5b R19, session 2) —
  `foldResolverWarningsIntoError` + `mergeDetails` +
  `maybeRemapValidationFailedToArchived`. Six consumers:
  `item set` / `item clear` / `item update` single + bulk /
  the dry-run engine / `update create`. Centralises the
  resolver-warning preservation + cache-sourced remap
  pattern so each consumer is a one-line call rather than
  20-30 lines of inline fold + remap. Lifted on the third
  consumer per the §17 R-class timing rule (item set + dry-
  run engine → item clear was the third). M5b cleanup
  generalised the remap from a single `columnId` to a
  `columnIds: readonly string[]` array so multi-column
  updates probe every translated column for the archived
  flag, not just `translated[0]`.

- `commands/raw/index.ts` (M6) — generic GraphQL escape
  hatch. Six argv shapes (positional `<query>` /
  `--query-file <path|->` × `--vars <json>` /
  `--vars-file <path|->` / no vars), each with empty-after-
  trim rejection. `--query-file -` and `--vars-file -` are
  mutually exclusive (one stdin reader per call). Variables
  must parse to a plain JSON object — null / array /
  primitive surface as `usage_error`. Result wrapped in
  the §6 envelope; raw GraphQL/HTTP errors map via the
  existing `api/errors.ts` chain so error codes are stable
  even on raw queries. **M6 close-arc additions:**
  delegates to `api/raw-document.ts analyzeRawDocument`
  for the AST walk that drives the mutation gate
  (`--allow-mutation` required for any `mutation` op in
  the doc; subscriptions rejected unconditionally) and
  `operationName` selection (1 anon → omit; 1 named →
  pass; N → require `--operation-name <name>`). Honours
  cli-design §9.2's universal `--dry-run` binding when
  the *selected* op is a mutation — emits the §6.4
  raw-GraphQL planned-change shape (`operation:
  'raw_graphql'`, `operation_kind`, `operation_name`,
  `query`, `variables`) and skips the wire call;
  read-only selections ignore `--dry-run`. `resolveClient`
  is deferred until after the analyser succeeds so a
  pre-network `usage_error` reports `meta.source: 'none'`
  per §6.1.

- `api/raw-document.ts` (M6 close) —
  `analyzeRawDocument({query, explicitOperationName,
  allowMutation})` walks the parsed GraphQL AST via the
  `graphql` reference parser (a direct dep at 16.8.2 —
  was already a transitive via `@mondaydotcomorg/api`'s
  `graphql-request`). Returns `{operationName,
  selectedOperationKind, hasMutation, hasSubscription,
  operations[]}`. Two predicates ship side-by-side and
  must stay distinct: `hasMutation` (document-wide;
  drives the `--allow-mutation` opt-in gate) vs
  `selectedOperationKind === 'mutation'` (the op Monday
  will actually execute; drives the `--dry-run`
  short-circuit). The split is load-bearing — Codex M6
  pass-5 P2 caught a bug where dry-run was keyed off the
  document-wide check and mis-fired on mixed docs whose
  `--operation-name` selected a query.

- `commands/board/doctor.ts` (M6) — three diagnostic kinds:
  `duplicate_column_title` (NFC + case-fold + whitespace-
  collapse, same as the §5.3 column resolver, so doctor's
  "duplicate" matches runtime's "ambiguous"),
  `unsupported_column_type` (per non-allowlisted column,
  keyed by `column-types.ts getColumnRoadmapCategory`'s
  three-category split — agents reading doctor output get
  the same `read_only_forever` / `v0.2_writer_expansion` /
  `future` classification the runtime's
  `unsupportedColumnTypeError` ships), and
  `broken_board_relation` (parses `settings_str.boardIds`
  for every `board_relation` column, queries linked boards
  via `boards(ids:)` aggregated into one round-trip, flags
  any archived/deleted/unreachable target). Force-refreshes
  metadata so diagnostics describe live state.

### Hard rules

- `commands/` never imports the SDK directly — always goes through
  `api/`. Keeps the SDK upgrade surface small and lets the test stack
  swap `Transport` for a `FixtureTransport` without monkey-patching.
- `api/` is pure I/O — no console output, no exit codes. It throws
  typed errors; `commands/`'s action handler decides how to render
  them via `emit.ts` / the runner's catch-all.
- `utils/` has no knowledge of Monday — it's generic formatting,
  redaction, logging, output renderers.
- `config/` runs once per `run()` call. The resolved `Config` is
  passed explicitly to anything that needs it (no globals, no
  module-level singletons).

## Output contract

Every command must support:

- `--output json` (default for non-TTY, or when set): a single JSON
  envelope on stdout, nothing else. Errors go to stderr as a §6.5
  envelope with a stable `error.code`.
- `--output table` / `--output text` (default for TTY, single-resource
  only): human-friendly, may include colour. NDJSON is collection-only.
- Exit codes: `0` success, `1` usage error, `2` API/network error,
  `3` config error, `130` SIGINT, `>3` reserved.

The full envelope contract — `meta` skeleton, error fields, the 26
stable error codes — lives in `cli-design.md` §6 and is enforced by
the integration suite's envelope-contract assertion (`assertEnvelope
Contract`) on every M2+ command's output. Adding fields to `meta` or
`data` is non-breaking; removing or renaming is a major version bump.

## Error model

Thrown errors are instances of the typed family in `src/utils/errors.ts`,
all sharing a base class with a stable `code` from the v0.1 frozen
26-code set:

- `UsageError` — bad flags / missing required positionals / mutually
  exclusive inputs. Exit 1.
- `ConfirmationRequiredError` — destructive op without `--yes`. Exit 1
  (grouped with usage per §3.1 #5).
- `ConfigError` — invalid env / missing token / malformed config.
  Exit 3.
- `ApiError` — non-2xx GraphQL, network failure, timeout, validation.
  Most M3 cassette-driven failures land here. Exit 2.
- `CacheError` — local cache I/O failure. Auto-retried without cache;
  exit 2 if it surfaces.
- `InternalError` — last-resort code for unknown thrown values
  (signals a CLI bug). Exit 2.

The runner's catch-all in `cli/run.ts` converts any `unknown` thrown
into one of these via `toMondayError` (in `envelope-out.ts`) and emits
the §6.5 error envelope on stderr before exiting. Two layers of
redaction (key-based + value-scan over the live token) run on the
envelope before bytes hit the stream — see `.claude/rules/security.md`
for the canary discipline.

A raw `ZodError` reaching the catch-all becomes `internal_error` /
exit 2; argv schemas wrap with `parseArgv`, env / config schemas wrap
in `loadConfig`, response schemas wrap inside `api/` so a parse
failure at the right boundary surfaces as `usage_error` / `config_error`.

## Testing layers

| Layer | Lives in | What it tests | Network? |
|-------|----------|---------------|----------|
| Unit | `tests/unit/` | Pure logic — config parsing, error mapping, formatters, redaction, helper modules | No |
| Integration | `tests/integration/` | `run({ transport: FixtureTransport })` end-to-end — argv → commander → action → envelope, with a cassette replacing the network | No (mocked) |
| E2E | `tests/e2e/` | The compiled binary — spawn `node dist/cli/index.js`, assert stdout / stderr / exit code against an in-process HTTP fixture server | No (mocked) or yes (gated by `RUN_LIVE_TESTS=1`) |

### Test infrastructure

- **`tests/fixtures/load.ts`** — cassette format (`Cassette` =
  ordered `Interaction[]`, each with `operation_name` /
  `match_query` / `match_variables` / `expect_headers` / `response`
  / `repeat`) + the `FixtureTransport` integration tests inject via
  `run({ transport })`.
- **`tests/e2e/fixture-server.ts`** — an in-process HTTP server that
  replays the same cassette format over real HTTP, so spawned-binary
  E2E tests exercise the production `FetchTransport` end-to-end.
- **`tests/e2e/spawn.ts`** — `spawnCli({ args, env })` helper that
  fails fast with a clear hint if `dist/cli/index.js` is stale.
- **`tests/integration/redaction-hardening.test.ts`** — adversarial
  token-leak suite (Codex M0 §1 / M2 §4 follow-up). Asserts the
  literal canary token is absent from every emitted byte across 9
  failure shapes (Error.message, Error.stack, cause chains,
  redirected URLs, retry-decorator details, etc.).
- **`tests/integration/helpers.ts`** (M4 R6) — shared
  `baseOptions / EnvelopeShape / parseEnvelope /
  assertEnvelopeContract / drive` scaffolding extracted from the M3
  per-noun integration test files. New M5+ test files start at one
  import line.

E2E tests that hit the real Monday API must be gated behind
`RUN_LIVE_TESTS=1` and use a dedicated test workspace — the default
CI run never touches the network. Coverage thresholds live in
`vitest.config.ts` (lines/functions/statements: 95, branches: 94 —
ratchet upward as new code lands; never lower).
