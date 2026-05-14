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
- `cli/program.ts` (M2.5; profile-resolution preAction hook added at
  v0.3-M21 Part 1 in `a4cb5b0`) — commander wiring: program metadata,
  global flag declarations, command registration. Pulled out of
  `run.ts` so the runner stays focused on I/O plumbing. The preAction
  hook (originally M2.5 for the api-version commit, extended at M21
  Part 1) runs before any subcommand action and resolves the active
  profile when `--profile <name>` or `MONDAY_PROFILE` env is set OR
  a `config.toml` with `default_profile` exists; injects the resolved
  token into `ctx.env.MONDAY_API_TOKEN` so downstream `loadConfig` /
  `resolveClient` calls Just Work via the standard env-var path.
  Auth verbs (`auth login`, `auth logout`) are exempt — they're the
  source of credentials, not consumers. Profile-level `api_version`
  override (cli-design §7.2) threads through the same hook: global
  `--api-version` flag wins, but profile-set `api_version` lands in
  `ctx.env.MONDAY_API_VERSION` + `ctx.meta.setApiVersion(...)` when
  the flag is absent.
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
- `api/column-types.ts` (M5a R8 + M8) — single source of truth
  for the writable allowlist + roadmap-category gates.
  `WRITABLE_COLUMN_TYPES` (frozen `as const` array — 10 entries
  post-M8; order is part of the contract; tests iterate it),
  `isWritableColumnType` (type guard narrowing to the
  `WritableColumnType` union), `parseColumnSettings` (defensive
  `settings_str` JSON parser that returns `null` on null/empty/
  malformed input). M8 additions: `isReadOnlyForeverType` /
  `isFilesShapedType` (gate `--set-raw`'s post-resolution reject
  lists per cli-design §5.3 escape-hatch contract);
  `getColumnRoadmapCategory` (drives the category-accurate
  `unsupported_column_type` hint — read-only-forever / future).
  M19 close graduated the full v0.2 tentative row (`tags` /
  `board_relation` / `dependency`) into `WRITABLE_COLUMN_TYPES`;
  the `v0_2_writer_expansion` category branch is now unreachable
  through the runtime classifier (kept as documented dead code
  for future tentative-row revival). Three consumers:
  `commands/board/describe.ts` (writable + example_set),
  `api/column-values.ts` (friendly writer), `api/raw-write.ts`
  (M8 escape hatch).
- `api/column-values.ts` (M5a + M8 + M9) — write half of
  §5.3. **Two entry points**: the sync `translateColumnValue({
  column, value, dateResolution? }) → TranslatedColumnValue`
  covers the locally-resolvable types; the async
  `translateColumnValueAsync({ column, value, dateResolution?,
  peopleResolution? }) → Promise<TranslatedColumnValue>` is the
  unified wrapper the command layer always calls (delegates to
  sync for non-people; dispatches `parsePeopleInput` for `people`,
  which needs network/cache lookup for email→ID resolution). The
  result type returns `columnId`, `columnType`, `rawInput`, a
  discriminated `payload`, and parallel echo slots (`resolvedFrom`
  for relative dates; `peopleResolution` for people inputs).
  Payload variants: `{format:'simple', value:string}` for the
  bare-string form (`change_simple_column_value`) or
  `{format:'rich', value:JsonObject}` for the JSON-object form
  (`change_column_value` / per-column entry of `column_values`
  maps). **Ten types translate** (7 v0.1 + 3 M8 firm-row): `text`
  / `long_text` / `numbers` (simple) and `status` / `dropdown` /
  `date` / `people` / `link` / `email` / `phone` (rich).
  **`selectMutation`** dispatches per cli-design §5.3 step 5:
  1 simple → `change_simple_column_value`; 1 rich →
  `change_column_value`; N → `change_multiple_column_values`
  (atomic). **`bundleColumnValues` (M9 lift)** — projects a
  list of `TranslatedColumnValue`s into the `column_values: JSON!`
  map shape every Monday mutation that takes one accepts
  (`change_multiple_column_values`, `create_item`,
  `create_subitem`). The `long_text` re-wrap (`{text:<value>}`
  inside the map vs. bare-string in `change_simple_column_value`)
  applies uniformly across every wire surface; `selectMutation`
  delegates for its multi case so the rule can't drift between
  update and create.
  **Monday `JSON` scalar discipline:** every payload is a plain
  JS value typed as `JsonObject` (R-JsonValue refactor — catches
  non-JSON shapes like `undefined` / symbols at compile time);
  the SDK / fetch layer stringifies at the wire boundary. The
  translator never `JSON.stringify`s — pinned by regression tests
  per (count × type) cell, including the create_item.column_values
  shape pin (M9).
- `api/raw-write.ts` (M8) — `--set-raw <col>=<json>` escape-hatch
  helpers. **`parseSetRawExpression(raw)`** is argv-parse-time:
  splits `<col>=<json>` on first `=`, validates the JSON parses
  to a `JsonObject` (string / number / array / null at top level
  rejected with `usage_error` + the parse error in `details`).
  **`translateRawColumnValue(column, value, rawJson)`** is
  post-resolution: rejects read-only-forever types
  (`unsupported_column_type` with `read_only: true`) and files-
  shaped types (`unsupported_column_type` with
  `deferred_to: "v0.5"` — `add_file_to_column` is multipart, not
  `change_column_value`; v0.4-M31 shipped the verb-shaped
  `monday item upload` path, the friendly `--set-raw <file-col>=
  <json>` form slipped to v0.5); otherwise builds a `TranslatedColumnValue`
  with `payload: {format: 'rich', value: <parsed>}` so
  `selectMutation` / `bundleColumnValues` handle it uniformly.
  Per cli-design §5.3 line 949–960: no per-type schema validation
  — Monday's server-side rejection surfaces as
  `validation_failed` with Monday's message. Mutual exclusion with
  `--set` is the caller's concern (resolution-time enforcement
  per §5.3 step 2; the cross-token duplicate-resolved-id check
  in `dry-run.ts` / each mutation command catches it).
- `api/set-expression.ts` (M9.5 R22) — `splitSetExpression(raw) →
  {token, value}`, the `--set <col>=<val>` argv splitter shared by
  `item set` / `item update` (single + bulk) / `item create`. Lifted
  from three identical 12-line copies; the M8 sibling
  `parseSetRawExpression` in `raw-write.ts` keeps its own copy of the
  first-`=` rule because its JSON-parsing concerns aren't duplicated.

- `api/links.ts` / `api/emails.ts` / `api/phones.ts` (M8) —
  the firm-row friendly translators. `parseLinkInput("url|text")`
  → `{url, text}` (pipe-form; no auto-extraction of hostnames as
  text). `parseEmailInput` (pipe-form `email|text` or bare
  email — bare emails set `text` to the email). `parsePhoneInput`
  + `iso-country-codes.ts` — E.164 input with explicit
  `phone:countryCode` payload; the country-code allowlist comes
  from a frozen ISO 3166-1 alpha-2 list.

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
  Owner=12345`) rejected with `usage_error`; the hint points at
  the email form first and surfaces the M8 `--set-raw` escape
  hatch as the path for raw IDs. M18 release-prep dropped the
  `deferred_to` slot from this error — `--set-raw` exists today,
  so the rejection isn't a deferral; it's an input-grammar
  limitation with a documented escape. Unknown emails bubble
  `user_not_found` from the
  resolveEmail callback per cli-design §5.3 line 733. `parsePeopleInput`
  also returns a `resolution: PeopleResolution` echo (one
  `{input, resolved_id}` entry per non-empty input token) the
  dry-run engine renders as `details.resolved_from` on the diff
  cell. **M19→M20 cleanup-window widening (`2cbf0d3`):**
  `resolveEmail` was widened to return
  `ResolveEmailResult = {id, source, cacheAgeSeconds}` —
  transparent passthrough of `userByEmail`'s public shape,
  mirroring the M19 tags translator's `resolveTags` callback.
  `parsePeopleInput` aggregates per-leg via `SourceAggregator`
  (R21) — `me` records `'live'` (`me { id }` is always a
  network call), email tokens forward `userByEmail`'s
  `{source, cacheAgeSeconds}` verbatim — and exposes the
  aggregate on `ParsedPeopleInput`'s new `source` +
  `cacheAgeSeconds` slots. The people translator threads the
  aggregate into `translatorResolution` for envelope-level
  merge by the post-translate aggregation loop in
  `resolution-pass.ts`. Closes the v0.3-plan §11 M19 post-
  mortem parity gap where cache-hit email lookups didn't
  contribute to `meta.source`.

- `api/resolution-context.ts` (M9.5 R24) —
  `buildResolutionContexts({client, ctx, globalFlags}) →
  {dateResolution, peopleResolution, tagResolution,
  relationResolution}`. Builds the four contexts every
  mutation surface that calls into `translateColumnValueAsync` /
  `planChanges` / `planCreate` needs, closing over `ctx.clock` +
  `ctx.env.MONDAY_TIMEZONE` (date side), `client` + `ctx.env` +
  `globalFlags.noCache` (people side via `resolveMeFactory` +
  `userByEmail` — M19→M20 forwards the full `{id, source,
  cacheAgeSeconds}` provenance, not just the id), `client` +
  `env` + `noCache` (tags side via `resolveTags` against the
  per-account directory), and `client` + `env` + `noCache`
  (relation side via `validateBoardRelationItems` for both
  `board_relation` and `dependency` — the per-noun divergence
  is the `context` discriminant the translator passes through,
  not a second callback). Lifted from four identical 12-line
  copies in `set.ts` / `update.ts` (single + bulk) /
  `create.ts`; widened to four contexts at M19 (Commits 2 / 3 /
  4). Pure function; the natural seam for `me`-token caching
  across translate calls in one command run (still candidate
  work — see v0.3-plan §22).

- `api/item-board-lookup.ts` (M9.5 R23) — shared
  `ITEM_BOARD_LOOKUP_QUERY` + `ITEM_PARENT_LOOKUP_QUERY` GraphQL
  strings, their zod parse-boundary schemas
  (`boardLookupResponseSchema` / `parentLookupResponseSchema`), plus
  three helpers: `lookupItemBoard({client, itemId, label?,
  detailKey?})` (M5b shape — id + board), `lookupItemBoardWithHierarchy`
  (M9 shape — adds `hierarchy_type` for the multi-level gate),
  `resolveBoardId({client, itemId, explicit})` (the `--board` ??
  lookup wrapper). `set` / `clear` / `update` / `create.ts` each shed
  ~70 LOC of duplicated GraphQL + schema + resolver. Error labels
  caller-supplied (`Item` / `Parent item` / `--relative-to item`)
  preserve consumer voice; null-board / not-found error codes
  (`not_found`) and detail keys (`item_id` / `parent_item_id` /
  `relative_to_id`) match every original site byte-for-byte.

- `api/me-token.ts` (M5a R15) — shared `isMeToken(token)`
  recogniser plus the frozen `ME_TOKENS` array. Three
  consumers: `filters.ts` (`--where Owner=me`),
  `commands/item/search.ts` (search filter), and `api/people.ts`
  (`--set Owner=me`). One rule across all three surfaces per
  cli-design §5.3 step 3 line 704-707; lifted out of three
  verbatim copies that had drifted across the people-session
  Codex passes. v0.2 grammar extensions (`i` / `@me`) land by
  adding to the array.

- `api/dry-run.ts` (M5a + M9) — two orchestrators behind a
  shared resolution discipline. **`planChanges({client,
  boardId, itemId, setEntries, rawEntries?, nameChange?,
  dateResolution?, peopleResolution?, env?, noCache?})`**
  (M5a) powers M5b's mutation surfaces (`item set` / `item
  clear` / `item update`) when `--dry-run` is set. Ties together
  the M3 cache-aware column resolver (with `includeArchived:
  true` so archived targets surface as `column_archived`, not
  `column_not_found`), `translateColumnValueAsync` +
  `translateRawColumnValue` + `selectMutation` for the wire
  shape, and a fresh item-state read for the diff `from` side.
  **`planCreate({client, mode, name, setEntries, rawEntries?,
  dateResolution?, peopleResolution?, env?, noCache?})`** (M9)
  powers `monday item create`'s `--dry-run` path. Same three-
  pass resolution + same all-or-nothing semantics, but **no
  item-state read** (the item doesn't exist; `from` is always
  `null`) and the diff `to` side projects through
  `bundleColumnValues` (the shared map shape, not single-column
  variants) so the long_text re-wrap surfaces in the diff
  exactly as it would on the wire. The `CreateMode` discriminator
  (`{kind: 'item', boardId, groupId?, position?}` vs `{kind:
  'subitem', parentItemId, subitemsBoardId}`) drives the
  `CreatePlannedChange` shape, which hoists `name` / `group_id`
  / `position` / `parent_item_id` to top-level slots per
  cli-design §6.4 item-create variant. Subitem variant **omits
  `board_id`** because Monday derives the subitems board
  server-side. **Output matches cli-design §6.4's
  `planned_changes[]` shape byte-for-byte** for both
  orchestrators, pinned via envelope-snapshot tests (the
  load-bearing exit gate). **All-or-nothing**: any resolution
  failure (`column_not_found`, `ambiguous_column`,
  `column_archived`, `unsupported_column_type`, `user_not_found`,
  item `not_found` (planChanges only), item-on-wrong-board
  (planChanges only), duplicate token, duplicate resolved id)
  aborts the batch before any further work. Resolver warnings on
  a `column_archived` throw fold into
  `error.details.resolver_warnings` via
  `foldResolverWarningsIntoError` so a stale-cache-then-
  archived flow keeps both signals. The engine's own
  `rawItemSchema.parse` boundary (planChanges) uses
  safeParse + `ApiError(internal_error)` per validation.md
  (mirrors R17 + the userByEmail wrap + R18 across every later
  parse boundary).

- `api/source-aggregator.ts` (M9.5 R21) — the §6.1 `meta.source` +
  `meta.cache_age_seconds` merge rules as three exports:
  `mergeSource(current, next)` (3-state aggregator: first leg seeds,
  `mixed` is contagious, `cache + live → mixed`),
  `mergeSourceWithPreflight(planner, preflight)` (4-state variant
  collapsing `'none'` to the preflight when any preflight leg fired
  — used by
  `item create` for parent-lookup + parent-board metadata + relative-
  to legs that fire pre-planner), `mergeCacheAge(current, next)`
  (null-aware `Math.max` for worst-case staleness). Lifted from four
  sites: dry-run.ts (private), update.ts `mergeSourceForRemap` + five
  inline `Math.max` cache-age folds, create.ts `mergeSourceLeg` +
  `mergeSourceWithPreflight` + `mergeCacheAgeWithPreflight`. Every
  multi-leg envelope now folds source/age through this module so the
  rule is one source of truth.

- `api/resolution-pass.ts` (M9.5 R20) — `resolveAndTranslate({client,
  boardId, setEntries, rawEntries, dateResolution?,
  peopleResolution?, env?, noCache?, initialSource?,
  initialCacheAgeSeconds?}) → {resolved, translated, resolvedIds,
  warnings, source, cacheAgeSeconds}`. Lifts the ~80-90 LOC three-
  pass discipline from five sites (`planChanges`, `planCreate`,
  `update.ts` single, `update.ts` bulk, `create.ts`) into one helper:
  pass (a) resolve every `--set` token, then every `--set-raw` token,
  with archived-column gate + same-token duplicate gate; pass (b)
  cross-token duplicate-resolved-id check (cli-design §5.3 line 961-
  972 mutual-exclusion contract); pass (c) translate friendly entries
  through `translateColumnValueAsync`, raw entries through
  `translateRawColumnValue`, with each catch folding cumulative
  resolver warnings (M5b R19 contract — `instanceof MondayCliError`
  catches both translator UsageErrors and ApiErrors). `initialSource`
  + `initialCacheAgeSeconds` seed the aggregator from upstream legs
  (e.g. update.ts's bulk path passes the board-metadata leg's
  source/age). Two consistency normalisations landed alongside the
  lift: archived-column message wording unified across all callers;
  translate-time catch unified to MondayCliError (pre-fix the dry-run
  paths only caught ApiError, missing translator UsageErrors that
  the M5b R19 contract says should fold).

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

- `commands/item/set.ts` (M5b + M8) — first M5b mutation
  surface. `monday item set <iid> (<col>=<val> | --set-raw
  <col>=<json>) [--board <bid>]`. Two argv shapes (mutually
  exclusive at the schema boundary): friendly positional
  `<col>=<val>` runs through `translateColumnValueAsync`;
  `--set-raw <col>=<json>` (M8) runs through
  `translateRawColumnValue` (read-only-forever / files-shaped
  reject lists). Both shapes share `resolveColumnWithRefresh`
  + `selectMutation` + the Monday `change_*_column_value`
  mutation. `--dry-run` delegates to `api/dry-run.ts
  planChanges` (engine handles both `setEntries` + `rawEntries`
  uniformly). Live mutation envelope echoes
  `resolved_ids: { token: column_id }` per cli-design §5.3
  step 2. Resolver-warning preservation via
  `foldResolverWarningsIntoError` covers every typed
  post-resolution failure (UsageError translators, ApiError
  `unsupported_column_type` / `user_not_found`, mutation-
  time `validation_failed`). `maybeRemapValidationFailedTo
  Archived` remaps `validation_failed` → `column_archived`
  on cache-sourced resolution if a forced refresh confirms
  the archived state.

- `commands/item/clear.ts` (M5b session 2 + M12) — dedicated
  per-column clear verb across two argv shapes:
  - **Single-item (M5b):** `monday item clear <iid> <col>
    [--board <bid>]`. Reuses the resolution / mutation
    selection / projection pipeline; the only divergence from
    `item set` is the value source: `translateColumnClear` in
    `api/column-values.ts` returns the per-type clear payload
    (text → `""`, status → `{}`, etc.) rather than translating
    user input. Per-type table is the canonical "what's a
    clear" mapping and lives alongside the writer's
    set-payload table.
  - **Bulk (M12):** `monday item clear --board <bid> <col>
    (--where <c>=<v>... | --filter-json <json>) [--yes]
    [--dry-run]`. Same cursor-walk + `confirmation_required`
    + per-item-failure decoration as bulk `item update --where`
    (M5b). The dispatch (`parseBulkOrSingleArgv`) checks
    whether `--where` / `--filter-json` is present — bulk path
    requires `--board`, single path keeps the positional `<iid>`.
    Output schema is now a `z.union([projectedItemSchema,
    bulkLiveDataSchema])` so `monday schema item.clear` advertises
    both branches (Codex round-1 F4 pinned the union schema).
    Bulk envelope: `{summary: {matched_count, applied_count,
    board_id}, items: [...]}` matching bulk update's shape.
    Per-item failure error decorates with
    `details.applied_count` / `details.applied_to` /
    `details.failed_at_item` / `details.matched_count`. The
    bulk leg shares almost every behaviour with bulk update —
    same gating, same walker, same dry-run aggregation — and
    is documented as R35 in v0.2-plan §18 as a defer-until-
    third-consumer lift candidate.

- `commands/item/update.ts` (M5b + M8) — multi-column
  atomic update + bulk path. `monday item update <iid>
  --set <col>=<val> [--set ...] [--set-raw ...] [--name <n>]`
  for single-item; `monday item update --where <expr> --set
  ... [--set-raw ...] --board <bid> --yes` for bulk. Single-
  item uses `selectMutation` to pick simple / rich / multi
  mutation; `--name` synthesises a `name` translated value
  that bundles into `change_multiple_column_values` alongside
  real columns (Monday's multi mutation accepts `name` as
  a key). M8 widened both single + bulk paths to accept
  `--set-raw` interleaved with `--set`; the resolution-time
  cross-token duplicate-resolved-id check (§5.3 step 2)
  catches a `--set X=...` + `--set-raw X={...}` collision
  pre-translation. Three-pass resolution discipline (resolve
  every token first, then dedupe + cross-token check, then
  translate) — pinned post-M8 so a malformed `--set` value
  doesn't pre-empt the mutual-exclusion error. Bulk walks
  `items_page` / `next_items_page` cursor pagination, fail-
  fast on `stale_cursor`. Bulk without `--yes` / `--dry-run`
  → `confirmation_required` with `matched_count` + filter
  shape. Bulk live: per-item sequential mutation; per-item
  failure decorates error with `applied_count` /
  `applied_to` / `failed_at_item` / `matched_count`. Bulk
  dry-run: aggregates per-item `planChanges` results into
  one N-element `planned_changes`; deduplicates resolver
  warnings by `code+message+token`. Cache-source aggregation
  across metadata + page walk + mutation legs (cli-design
  §6.1).

- `commands/item/create.ts` (M9) — first item-lifecycle
  verb. `monday item create --board <bid> --name <n>
  [--group <gid>] [--set <col>=<val>]... [--set-raw
  <col>=<json>]... [--parent <iid>] [--position before|after
  --relative-to <iid>] [--dry-run]`. Two argv shapes the
  dispatch picks between: top-level (calls `create_item`
  against `--board`) and subitem (`--parent` triggers
  `create_subitem`; classic boards only —
  `hierarchy_type: "multi_level"` rejected pre-mutation
  with `usage_error` + `details.deferred_to: "v0.3"`).
  **Single round-trip is the hard exit gate** (cli-design
  §5.8): every translated `--set` / `--set-raw` value
  bundles into the single `create_item.column_values`
  (or `create_subitem.column_values`) parameter via
  `bundleColumnValues`. The CLI does NOT fall back to
  `create_item` + `change_multiple_column_values` on
  partial failure — partial-state risk by design.
  Resolution mirrors `item update`'s three-pass pattern
  (resolve all tokens → cross-token dup check → translate);
  `resolveCreateMode` returns the dispatch-ready
  `CreateMode` plus pre-planner source aggregation for
  the parent-lookup + parent-board metadata + relative-to
  legs that fire before `planCreate` / live mutation
  (Codex round-1 P2 — `meta.source` reflects every wire
  leg). For subitem with `--set` / `--set-raw`, the
  subitems-board ID derives from the parent's `subtasks`
  column's `settings_str.boardIds[0]`; column resolution
  targets that board, not the parent's. F4 remap wired:
  cache-sourced resolution + Monday `validation_failed`
  → forced refresh → if archived, `column_archived` with
  `details.remapped_from`. Mutation envelope: `data: {id,
  name, board_id, group_id, parent_id?}` + top-level
  `resolved_ids` echo. **Idempotent: false** — re-running
  creates a duplicate item; `monday item upsert` (M12) is
  the idempotent variant.

- `commands/item/archive.ts` (M10 Session A) — `monday item
  archive <iid> --yes [--dry-run]`. The smaller of M10's two
  destructive verbs. Calls Monday's `archive_item` mutation
  behind the cli-design §3.1 #7 confirmation gate (`--yes`
  mandatory; `--dry-run` exempts the gate per §10.2). Single
  round-trip per path: live calls `archive_item` directly (the
  mutation returns the archived `Item`, so no pre-mutation read
  fires); dry-run reads via `ItemArchiveRead` and emits the
  §6.4 envelope with `operation: "archive_item"`, `item_id`,
  and `item: <projected snapshot>` so the agent verifies the
  ID before re-running with `--yes`. Both paths share
  `ITEM_FIELDS_FRAGMENT` + `parseRawItem` + `projectItem` so
  the response shape matches `item get` byte-for-byte. Null
  result on the live mutation surfaces as `not_found` with
  `details.item_id` (mirrors the dry-run path's null-handling
  so the error shape stays identical across both paths).
  **Idempotent: true** — re-archiving an already-archived item
  is a no-op on Monday's side per cli-design §9.1; safe to
  retry on transient transport failures. The
  `confirmation_required` hint anchors at Monday's 30-day
  recovery window + cli-design §5.4 (no `unarchive` mutation).

- `commands/item/delete.ts` (M10 Session A) — `monday item
  delete <iid> --yes [--dry-run]`. Sibling of `item archive`
  — same argv shape, same confirmation contract, same
  projection, one knob different: **`idempotent: false`**.
  Calls `delete_item` instead of `archive_item`; post-mutation
  state flips to `"deleted"`. Why non-idempotent despite
  Monday's `delete_*` being idempotent past the first call
  (cli-design §9.1 — re-deleting → `not_found`): re-running
  with the same `<iid>` after an interim `monday item create`
  would delete the *new* item, so agents can't safely retry
  without verifying the ID still names the same record. The
  `confirmation_required` hint anchors at cli-design §5.4
  (Monday retains deleted items in the trash for 30 days but
  exposes no `unrestore` mutation; recreating is lossy).
  Pinned via an integration-level `idempotent` knob assertion
  importing both archive + delete CommandModules so a copy-
  paste regression that flips the wrong knob fails loud.

- `commands/item/duplicate.ts` (M10 Session B) — `monday item
  duplicate <iid> [--with-updates] [--dry-run]`. Third sibling
  of M10's lifecycle cluster, closing the four-verb set Monday's
  API exposes (`archive` / `delete` / `duplicate` here;
  `move_item_to_*` lands in M11). Unlike its M10 siblings
  duplicate is **creative** (not destructive), so it skips the
  `--yes` gate per cli-design §3.1 #7 — `monday item create`
  sets the precedent for creative verbs without confirmation;
  `resolveClient` runs first since there's no pre-network gate
  to be masked (Session A's round-1 P2 ordering trap doesn't
  apply). **Two-leg live path**: Monday's `duplicate_item(item_
  id, board_id: ID!, with_updates)` requires `board_id` (verified
  at SDK `index.d.ts:2131`), so the CLI calls `lookupItemBoard`
  first to derive it, then fires the mutation. Both legs are
  guaranteed live — no cache participates — so `meta.source:
  "live"` directly without `mergeSource` (the aggregator is for
  cache + live combinations). **Single-leg dry-run**: only
  `ItemDuplicateRead` fires; the source-item snapshot is the
  preview. **Mutation envelope** (cli-design §6.4 line 1827-1831
  precedent — upsert's `data.created` flag): output schema is
  `projectedItemSchema.extend({ duplicated_from_id:
  ItemIdSchema })`, echoing the source ID alongside the new
  item's `id` so v0.2-plan §3 M10's "Returns the new item's ID
  + the source item's ID" commitment lands as one self-
  describing field on `data`. **Dry-run shape** carries the
  additional `with_updates: true | false` slot inside
  `planned_changes[0]` so the preview tells the agent whether
  re-running without `--dry-run` would copy the source's
  updates; otherwise identical to archive's + delete's dry-run
  shapes. **Idempotent: false** — every call creates a new
  item, mirroring `monday item create`'s semantics per
  cli-design §9.1 (`duplicate_item` shares `create_item`'s
  inheritance; the table doesn't list it separately). Pinned
  via an integration-level idempotency knob assertion against
  `itemCreateCommand.idempotent` (the parallel-false pin —
  archive's `true` pin is already covered by Session A's delete
  test). `--with-updates` plumbing pinned via fixture
  `match_variables` (true + false cases) so a regression where
  commander's `undefined` leaked through would surface as a
  cassette mismatch.

- `commands/item/move.ts` (M11) — `monday item move <iid>
  --to-group <gid> [--to-board <bid>] [--columns-mapping <json>]
  [--dry-run]`. Fourth and final lifecycle verb closing the
  four-verb set Monday's API exposes (`archive` / `delete` /
  `duplicate` here; `move_item_to_*` is the M11 closer). Two
  transports under one verb: **same-board** (`--to-group <gid>`
  alone) calls `move_item_to_group` — single-leg live, single-
  leg dry-run via `readSourceItemForDryRun(operationName:
  'ItemMoveRead')` (R27 helper). **Cross-board**
  (`--to-group <gid> --to-board <bid>`) calls
  `move_item_to_board(item_id, board_id, group_id,
  columns_mapping)` — four-leg live (source-item read + source
  `BoardMetadata` + target `BoardMetadata` parallel + the
  mutation), three-leg dry-run (no mutation). `--to-group` is
  required for both forms because Monday's
  `move_item_to_board(group_id: ID!)` is mandatory (verifiable
  in SDK 14.0.0 at `index.d.ts:2156`); `--to-board` alone (no
  `--to-group`) → `usage_error`. The mutex now lives between
  `--columns-mapping` and `--to-board`'s absence (passing the
  mapping without the cross-board flag is a user mistake).
  **`--columns-mapping <json>`** parses through
  `src/api/column-mapping.ts parseColumnMappingJson` — the simple
  `{<source_col_id>: <target_col_id>}` form (string-to-string),
  matching Monday's `ColumnMappingInput = { source: ID!, target?:
  ID }` exactly. The richer `{id, value?}` value-translation form
  is deferred to v0.3 (the wire shape carries no value slot;
  supporting it requires a non-atomic post-move
  `change_multiple_column_values` mutation; v0.2-plan §15
  captures the SDK-shape discovery that drove the deferral).
  **Strict default per cli-design §8 decision 5.** The planner
  (`planColumnMappings`) enumerates every source column **with
  actual content** (the `cellHasData` predicate — recursive
  semantic-empty check on `value` + non-empty `text`; Codex
  round-1 F1 + round-2 F1 escalation pinned the populated-cells
  filter so cleared rich shapes like `{}` /
  `{personsAndTeams: []}` / `{label: null, index: null}` drop
  out). Each populated source column needs (a) a verbatim ID
  match on target OR (b) an agent-supplied mapping entry; both
  branches validate against `targetColumnIds` (Codex round-2 F2
  added the typo-target check — `--columns-mapping
  '{"status_4":"typo"}'` raises `usage_error` with
  `details.invalid_mappings` rather than reaching Monday and
  silently dropping). Unmatched → `usage_error` carrying
  `details.unmatched: [{source_col_id, source_title,
  source_type}]` + `details.example_mapping` so agents
  copy-paste the seed into their retry. `--columns-mapping {}`
  (empty object) is the explicit "drop everything (Monday's
  permissive default)" opt-in that bypasses the unmatched check.
  **Live wire mirrors dry-run echo** (Codex round-2 F3) — the
  live mutation always sends `plan.columnsMapping` (the same
  array dry-run echoes), so the preview describes what Monday
  will receive byte-for-byte. **`meta.source` aggregation** for
  cross-board mixes `mergeSource` + `mergeCacheAge` (R21) across
  the source-item read (always live), source + target metadata
  loads (cache or live), and the mutation (always live); same-
  board paths are pure-live single-leg so the source aggregator
  doesn't fire. **`idempotent: false`** at the verb level —
  same-board (`move_item_to_group`) is wire-level no-op when
  already in target group per cli-design §9.1, but cross-board
  (`move_item_to_board`) re-running on the target board is
  undefined SDK behaviour; conservative bound across all paths
  mirrors `monday item create`. Inherited helpers: R23
  (`lookupItemBoard` for the projection-board-id-null fallback —
  defensive, deliberately uncovered per v0.2-plan §15), R27
  (`readSourceItemForDryRun(operationName: 'ItemMoveRead')`),
  R28 (`projectMutationItem(errorCode: 'not_found')`).

- `commands/item/upsert.ts` (M12) — `monday item upsert
  --board <bid> --name <n> --match-by <col>[,<col>...]
  [--set <col>=<val>]... [--set-raw <col>=<json>]...
  [--create-labels-if-missing] [--dry-run]`. The idempotency-
  cluster verb (cli-design §5.8). **Three-state branch
  decision** via `decideBranch({matchCount, cursor})`: 0
  matches with null cursor → `{kind: 'create'}` → routes
  through `runCreateBranch` (M9 surface reused via
  `create_item`); 1 match → `{kind: 'update', itemId}` →
  routes through `runUpdateBranch` (M5b surface reused via
  `change_multiple_column_values` with synthetic `name`); 2+
  matches → `{kind: 'ambiguous', error: ApiError}` → fails
  fast with `ambiguous_match` carrying
  `details.candidates: [{id, name}]` (up to 10 from the
  `limit: 11` lookahead — the planner can distinguish
  "exactly 2..10 matches" from "11+ matches" in one page) +
  `details.match_by` / `details.match_values` /
  `details.matched_count`. Empty-page-with-non-null-cursor
  raises `internal_error` directly (Codex round-1 F3 —
  Monday's items_page returns `cursor: null` when no more
  pages exist, so non-null cursor with empty items is
  API-side malformation, not "no matches"). **Lookup leg
  routes through `buildQueryParams`** (Codex round-1 F1) —
  the same `items_page(query_params)` filter pipeline `item
  list --where` and bulk `item update --where` use, so
  `me`-resolution + cache-miss-refresh + collision warnings
  inherit automatically. `name` pseudo-token entries skip
  column resolution and feed Monday's built-in `column_id:
  "name"` filter directly. **v0.2 match-by safe-list**
  (cli-design §5.8 — narrowed across Codex rounds 2–4):
  always-safe (`name` / `text` / `long_text` / `numbers` /
  external_id-shaped hidden text), safe-via-label-text
  (`status` / `dropdown`), restricted (`people` → `me` only),
  not-v0.2-safe (`date` / `link` / `email` / `phone`).
  Recommended canonical pattern: stable hidden text /
  external_id column as the synthetic key. **`data.operation:
  "create_item" \| "update_item"`** exposes the branch on the
  success envelope (cli-design §6.4); dry-run encodes the
  same via `planned_changes[0].operation`. **Sequential-retry
  idempotent only** (`idempotent: true` at the verb level —
  the flag is a coarse boolean, the nuanced contract lives in
  cli-design §9.1) — concurrent agents observing zero matches
  both branch to `create_item`; the next call surfaces the
  duplicate as `ambiguous_match`. Concurrent-write protection
  via lock-resource semantics is a v0.4 candidate (cli-design
  §9.3). **Inherited helpers:** `SourceAggregator` (R30) for
  the lookup + create-or-update aggregation across both
  branches; `mergeSourceWithPreflight` (R21) for the dry-run
  create branch; `splitSetExpression` (R22) for the
  `--match-by`-into-where-clause translation;
  `projectMutationItem` (R28) for both branches'
  live-mutation projection. Net new ~1345 LOC; per-file
  branch coverage 78.12 — notably below sibling files because
  of the state-machine fan-out, flagged in v0.2-plan §17 as
  follow-up. Five Codex review rounds during M12 (vs M11's
  two) all narrowed the v0.2 round-trip contract; the
  load-bearing lesson ("wire-shape claims need empirical
  proof, not translator-input-shape reasoning") lives in
  v0.2-plan §17.

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

- `api/resolver-error-fold.ts` (M5b R19, session 2 + M9.5 R26) —
  `foldResolverWarningsIntoError` + `mergeDetails` +
  `maybeRemapValidationFailedToArchived` + `foldAndRemap` (M9.5
  R26 — async wrapper composing fold then remap with the empty-
  columnIds short-circuit). Two integration patterns:
  - **Translate-time catches** (fold-only, in
    `resolution-pass.ts` and `dry-run.ts`'s `column_archived`
    throw) call `foldResolverWarningsIntoError` directly — no
    remap probe needed.
  - **Post-mutation catches** (the five mutation surfaces:
    `item set`, `item clear`, `item update` single + bulk,
    `item create`) call `foldAndRemap` once per mutation site,
    replacing the 25-LOC inline `fold + columnIds.length === 0
    ? folded : maybeRemap` pattern. Bulk's per-item-progress
    decoration stays bulk-specific: the bulk path calls
    `foldAndRemap` first, then attaches `applied_count` /
    `applied_to` / `failed_at_item` / `matched_count` before
    re-throwing.

  M5b cleanup generalised the remap from a single `columnId` to
  a `columnIds: readonly string[]` array so multi-column updates
  probe every translated column for the archived flag, not just
  `translated[0]`. The Codex M9 P1 finding (cache-stale archived
  columns surfacing as `validation_failed` from `item create`)
  was caused by item create skipping this exact catch arm — R26
  reduces the surface where a future command can forget to wire
  it.

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

### Post-M9 helper modules (M10–M17 mutation surface)

The mutation surface that grew M10–M17 (item lifecycle / update
mutations / workspace + board + column + group lifecycles)
settled into a stable set of cross-cutting helpers. Each helper
is a per-noun (or cross-noun) consolidation of a pattern that
recurred across ≥3 mutation sites; the lift-when-three-consumers
heuristic v0.2-plan §22 documents.

- `api/item-source-read.ts` (M10 R27) — `readSourceItemForDryRun
  ({client, itemId, operationName})`. Single-item read against
  `ITEM_FIELDS_FRAGMENT` + null-result throw with
  `details.item_id` + `parseRawItem` + `projectItem`. Three M10
  consumers (`item archive` / `delete` / `duplicate` dry-run);
  M11 `item move` joins later. The named `operationName`
  parameter pins the per-verb GraphQL operation name without
  forcing each call site to re-declare the fragment.

- `api/item-mutation-result.ts` (M10 R28) — `projectMutationItem
  ({raw, itemId, errorCode, errorMessage})`. First per-noun
  projection helper. Owns the null-check + `details: { item_id }`
  envelope + projection-schema parse. Each call site supplies
  its own typed error code + message (M10 verbs use `not_found`;
  M12 upsert's create + update branches diverge on the
  `errorCode` parameter so the helper stays per-noun-shaped, not
  per-verb).

- `api/source-aggregator.ts` (M9.5 R30) — `mergeSource` /
  `mergeCacheAge` / `mergeSourceWithPreflight`. The §6.1
  `meta.source` four-state aggregator (`'live' | 'cache' |
  'mixed' | 'none'`) lifted from inline `Math.max` cache-age
  folds + per-leg `currentSource` accumulators across dry-run.ts
  / update.ts / create.ts.

- `api/destructive-gate.ts` (M14 R29) —
  `enforceDestructiveGate({globalFlags, verb, target, detailKey,
  action, hint, extraDetails?})`. Shared `confirmation_required`
  gate for every destructive verb: `item archive` / `item delete`
  / `update delete` / `update clear-all` / `workspace delete` /
  `board archive` / `board delete` / M16 `column-delete` / M17
  `group-archive` / `group-delete` (10 consumers post-M17). The
  M16 `extraDetails` slot extension carries a secondary
  `board_id` for two-tuple destructive verbs (`column-delete` /
  `group-archive` / `group-delete`) per cli-design §6.5 single-
  target shape; `extraDetails` merges FIRST so the canonical
  `[detailKey]: target` + `hint` always win on key collision.
  Gate fires BEFORE `resolveClient()` so a missing token still
  surfaces `confirmation_required` not `config_error` (the M10
  round-1 P2 ordering invariant — preserved by accepting
  already-parsed `globalFlags` rather than re-resolving inside
  the helper).

- `api/items-page-walker.ts` (M13 R34) — `items_page` GraphQL
  helper for the cursor-walk pagination shape. Five consumers
  post-M14.

- `api/update-mutation-result.ts` (M14 R37) +
  `UPDATE_FIELDS_FRAGMENT` (R38) —
  `projectMutationUpdate({raw, updateId, errorCode,
  errorMessage})` for the four full-projection M13 update
  verbs (`create` / `reply` / `edit` / `delete`) + the
  like-cluster + the dedicated `assertUpdateMutationPresent`
  for `update clear-all`'s partial-success
  `{id}`-only wire shape. Two-export seam handles both shapes;
  five consumers across M13.

- `api/partial-success-mutation.ts` (M13/M14) — the dispatch
  helper for the §6.4 partial-success envelope shape. M13
  `update clear-all` + M14 `workspace add-users` /
  `remove-users` + M15 `board add-users` consume; per-target
  outcomes (`{<target_id_field>: string, ok: boolean,
  error?}`) ride in `data.results: [...]` with the id-field
  name parameterised per verb (`update_id` / `user_id`). The
  envelope is `ok: true` whenever the dispatch ran — top-level
  `ok: false` is reserved for whole-call failure.

- `api/users-fan-out-mutation.ts` (M15 R40) — partial-success
  `--users` resolver-fronted dispatch shared by M14
  `workspace add-users` / `remove-users` and M15 `board add-users`.
  Mixes numeric IDs + emails (resolved through `userByEmail`);
  per-token resolution failures land as records in
  `data.results` with the input token echoed verbatim. Whole-
  call `user_not_found` fires only when no dispatchable user_id
  remains after parsing/resolution.

- `api/response-root.ts` (M15 R41) —
  `assertResponseFieldPresent(data, fieldName, {mutationName,
  details})`. The shared missing-root-key guard surfacing
  `internal_error` with a schema-drift hint (distinguishes
  Monday's contract-drift signal from null-payload). Used by
  M14/M15 inline at call sites; R42 (deferred — see §22)
  consolidates the ~32 pre-M14 + post-M14 mutation sites onto
  this helper for one uniform shape.

- `api/workspace-projection.ts` (M14/M15 R39) +
  `WORKSPACE_FIELDS_FRAGMENT` + `workspaceProjectionSchema`.
  The R28-sibling for Workspace; six M14 consumers (the four
  workspace mutation verbs + `workspace get`).

- `api/board-projection.ts` (M15 R43) +
  `BOARD_FIELDS_FRAGMENT` + `boardProjectionSchema`. The
  read-side projection for Board; six M15 consumers.

- `api/board-mutation-result.ts` (M15 R43) — `projectMutation
  Board({raw, errorCode, errorMessage, detailKey, detailValue})`.
  R28-sibling for Board; six M15 consumers (the six board
  mutation verbs).

- `api/column-mutation-result.ts` (M16 R45) +
  `COLUMN_FIELDS_FRAGMENT` + `columnProjectionSchema` +
  `projectMutationColumn({raw, errorCode, errorMessage,
  boardId, columnIdKey: 'column_id' | 'title', columnIdValue})`.
  Per-noun projection helper for Column. Three M16 consumers
  (`column-create` / `column-update` / `column-delete`); the
  `columnIdKey` parameter pins the per-verb divergence between
  create's pre-id `'title'` shape and update / delete's
  `'column_id'` shape.

- `api/board-mutation-invalidation.ts` (M16→M17 cleanup R46) —
  `withBoardInvalidationSingleLeg({boardId, env, perform})` and
  `withBoardInvalidationFanOut({boardId, env, runFanOut})`. Pin
  the cli-design §8 leg-count split in the type system: single-
  leg verbs invalidate AFTER the success-envelope `data`
  projection and skip on the error path; fan-out verbs
  invalidate ONCE after the per-attribute loop settles iff at
  least one leg succeeded (high-water-mark counter via the
  closure-captured `recordLegSuccess()` callback so partial-
  application failure still invalidates). 11 consumers
  post-M17 (8 single-leg: column-create + column-delete +
  M15-retrofit board-archive + board-delete + M17 group-create
  + group-archive + group-duplicate + group-delete; 3 fan-out:
  column-update + M15-retrofit board-update + M17 group-update).

- `api/group-mutation-result.ts` (M17 R48) +
  `GROUP_FIELDS_FRAGMENT` + `groupProjectionSchema` +
  `projectMutationGroup({raw, errorCode, errorMessage, boardId,
  idKey: 'group_id' | 'name', idValue})`. Per-noun projection
  helper for Group. Five M17 consumers (all five group verbs);
  the `idKey` parameter pins create's pre-id `'name'` shape vs
  update / archive / duplicate / delete's `'group_id'` shape.
  Fifth per-noun projection helper post-M17 — sets up a
  hypothetical R44 (generic `projectMutationResource`) lift
  pending a sixth-noun trigger.

- `api/group-color.ts` (M17 round-1 fix-up) —
  `GROUP_COLOR_VALUES` palette: 41 names covering Monday's
  documented group colours. Both `group-create` and
  `group-update` consume via `z.enum(GROUP_COLOR_VALUES)` so
  invalid colour names surface as `usage_error` BEFORE any
  network call. The M17 implementation owns the field set per
  cli-design §4.3 (the contract pins the shape; the
  implementation owns the values, mirrors M16
  `column-types.ts`).

- `api/board-child-finder.ts` (M17→M18 cleanup R51) —
  `findBoardChildOrThrow<K extends 'columns' | 'groups'>({
  metadata, kind, id, boardId})`. Discriminated lookup-and-throw
  helper for the M16/M17 dry-run preflight "board-level read
  succeeded but the child ID isn't on the board" carve-out:
  finds a child entity by ID inside `metadata[kind]`, throws
  `not_found` with `details: { board_id, [<kind-singular>_id]:
  id }` if absent. Conditional return type
  (`K extends 'columns' ? BoardColumn : BoardGroup`) preserves
  type-narrowing at every call site without `as` casts. Three
  consumers post-M17 (`column-update` + `group-update` +
  `group-archive` dry-run preflights). Future v0.3 fourth child
  kind (e.g. board subscribers) extends the `K` union without
  re-touching the helper — the noun derivation is mechanical
  (`kind.slice(0, -1)`).

- `api/tag-directory.ts` (v0.3 M19 — pre-flight at `d822982`,
  runtime body filled at M19 implementation `19801f8`).
  Per-account tag-directory lookup helper for the `tags`
  friendly translator. Two surfaces: `loadAccountTags` (full
  directory reader, cache-then-live with on-disk
  `account_tags/index.json` at mode 0600 per the `accountTags`
  cache key kind) and `resolveTags` (comma-split name-list →
  tag-id resolver with NFC + case-fold matching, refresh-on-miss,
  residual-miss surfacing as `tag_not_found` per cli-design
  §6.5's array shape). Mirrors the `userByEmail` user-directory
  pattern in `resolvers.ts:191–402` verbatim — there is no
  standalone `user-directory.ts` module; the user-directory
  cache / lookup / refresh-on-miss machinery lives inside
  `resolvers.ts`. Two consumers post-M19: `column-values.ts
  translateTags` (friendly translator dispatch) +
  `commands/account/tags.ts` (the `monday account tags` read
  verb that closes the §6.5 hint forward-reference).

- `api/board-relation-validation.ts` (v0.3 M19 — pre-flight at
  `d822982`, runtime body filled at M19 implementation
  `a569590`). Validates `board_relation` / `dependency` linked-
  item references against the linked-board's
  `items(ids: ...)` query. Returns
  `{ ok: true, items: ValidatedRelationItem[] } | { ok: false,
  code, details }` (the `items` widening was a Codex round-2
  P1-3 catch — the dry-run echo needs per-item home boards to
  render `details.resolved_from.items`). Single batched
  GraphQL call per validation pass to stay inside Monday's
  complexity envelope. Two consumers post-M19: `column-values.ts
  translateRelation` (board_relation + dependency friendly
  translators share the helper — verbatim shape per the M19
  R45/R48 ship-the-helper-with-the-first-new-consumer cadence).

- `api/oauth.ts` (v0.3 M21 — pre-flight at `5c07840`, runtime
  bodies landed at M21 Part 1 in `81eec03`). OAuth wire wrapper
  for the `monday auth login` flow per cli-design §7.3. Constants
  pin the wire URLs (`OAUTH_AUTHORIZE_URL`, `OAUTH_TOKEN_URL`,
  `OAUTH_DEFAULT_PORT = 9876`, `OAUTH_CALLBACK_PATH = '/callback'`,
  `OAUTH_DEFAULT_LISTENER_TIMEOUT_MS`, `OAUTH_SCOPES`,
  `OAUTH_DEFAULT_REQUESTED_SCOPES`) plus the public-OAuth-client
  app credentials (`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` —
  shipped as `<UNREGISTERED_PENDING_OAUTH_APP>` placeholders that
  the user swaps with the registered Monday OAuth app's values
  pre-publish; tests don't depend on the real values since
  cassettes intercept `/oauth2/token`). Type surface splits
  raw-vs-normalized: `RawTokenResponse` is the snake_case
  `/oauth2/token` success body (Monday's wire shape);
  `TokenResponse` is the camelCase normalized shape that
  `exchangeCode` returns to its callers. Four runtime bodies:
  `generateOAuthState` (32-byte CSPRNG → base64url CSRF token);
  `verifyCsrf` (length-guard before `crypto.timingSafeEqual` so
  length-mismatched buffers route to
  `oauth_failed.reason: "csrf_mismatch"` rather than
  `internal_error`); `bindOAuthListener` (`node:http` listener
  on `127.0.0.1:<port>`, single-request handler matching
  `${OAUTH_CALLBACK_PATH}?code=…&state=…` or `?error=…&state=…`,
  404 on other paths, 400 on `/callback` with neither code nor
  error, 5-min timer armed inside `awaitRedirect`'s promise
  executor with `retryable: true` overriding the umbrella
  `oauth_failed` floor for `reason: "timeout"`, EADDRINUSE
  mapping to `oauth_failed.reason: "port_in_use"` with
  `details.port`, server.address() readback so callers passing
  `port: 0` get the OS-assigned port back); `exchangeCode`
  (`POST /oauth2/token` with `application/x-www-form-urlencoded`
  body per Monday's documented shape + the empirical-probe
  finding that PKCE-only is rejected with
  `Missing client_secret param`; 4xx surfaces as
  `oauth_failed.code_exchange_failed` with `monday_code` +
  `monday_description`; 5xx surfaces as `network_error`; fetch
  rejection becomes `network_error`; malformed 200 JSON or
  schema-mismatch surfaces as `internal_error`). Single consumer:
  `commands/auth/login.ts`. PKCE not shipping in v0.3 —
  documented as a v0.4+ amendment per the empirical-probe
  pin.

- `api/oauth-test-helper.ts` (v0.3 M21 Part 1 — `81eec03`).
  Test seam for the `__test_oauth_helper` env var per cli-design
  §7.3.4 (separate file because the helper + fixture-schema
  surface crosses ~165 LOC, above the inline threshold). Two
  exports: `readTestOAuthFixture(path)` parses the JSON fixture
  (zod-validated; rejects with `config_error` on missing /
  malformed / schema-mismatched files) and `buildTestOAuthListener(
  fixture, generatedState)` returns a synthetic
  `OAuthListenerHandle` whose `awaitRedirect` resolves (or
  rejects) based on the fixture's `force_*` flags
  (`force_csrf_mismatch` substitutes a different state;
  `force_user_denied` simulates `?error=access_denied`;
  `force_authorization_failed` simulates a non-`access_denied`
  redirect error with `monday_code` + optional
  `monday_description`; `force_listener_timeout` rejects with
  `oauth_failed.reason: "timeout"`). The default fixture path
  (no `force_*` flags) succeeds with the CLI's own state echoed
  back, so CSRF verification passes — the network-side
  `/oauth2/token` exchange still goes through cassettes for
  `code_exchange_failed` coverage. Production callers never see
  this module; the test seam is opt-in via `ctx.env.
  __test_oauth_helper`.

- `api/probes.ts` (v0.3 M22 — pre-flight at `fbab6b0`;
  implementation at `3a1b465`). Per-probe primitives for
  the `monday status` verb per cli-design §11.5. Type surface
  pins the {@link ProbeName} enum (`dns | tcp | tls | auth |
  cache_writability | redaction_self_test | env_var_pickup`), the
  `ProbeResult` discriminated union (`ok | fail | skipped`), the
  `StatusOutput` envelope (derived from `statusOutputSchema` —
  schema-as-source-of-truth per `.claude/rules/validation.md`).
  Constants pin `STATUS_PROBE_ORDER`, `NO_PROBE_SKIP_SET` (the
  four network-probe names skipped under `--no-probe`),
  `ENV_VAR_PICKUP_KEYS`, `REDACTION_SELF_TEST_FIXTURE_TOKEN` (the
  leak-scan canary). Seven probe runners (`runDnsProbe`,
  `runTcpProbe`, `runTlsProbe`, `runAuthProbe`,
  `runCacheWritabilityProbe`, `runRedactionSelfTest`,
  `summariseEnvVarPickup`) bind to `node:dns/promises.lookup` +
  `node:net.createConnection` + `node:tls.connect` (production
  defaults wrapped in `c8 ignore start/stop` block-wraps — unit
  tests inject `lookupImpl` / `tcpConnectImpl` / `tlsConnectImpl`
  seams) + the `me { id }` GraphQL auth probe + `fs.stat / access
  (W_OK) / probe-write` cache-writability dance + the canary-fold
  redaction self-test + the pure env-var-pickup summariser. The
  mockable-seam pattern mirrors the M21 `__test_oauth_helper`
  env-seam: each probe accepts an injectable helper so tests
  don't bind real sockets / open real fetch handles. Per-probe
  abort context (`createProbeAbortContext`) combines the
  per-probe `timeoutMs` deadline with the outer abort signal so
  every probe seam aborts cleanly on Ctrl-C or per-probe timeout.
  Auth probe scans ALL `errors[]` entries for
  `NOT_AUTHENTICATED` / `UNAUTHENTICATED` codes (Codex M22 W2
  ratification — not just `errors[0]`).
  `RedactionSelfTestInputs` takes BOTH `env` and `runtimeSecrets`
  per cli-design §7.4.3 (Codex M21 P1 ratification) — the probe
  exercises the same two-layer redaction the production emission
  paths use via `collectSecrets(env, runtimeSecrets)`. Single
  consumer: `commands/status.ts`.

- `api/usage.ts` (v0.3 M22 — pre-flight at `fbab6b0`;
  implementation at `3a1b465`). Daily-operation budget for
  the `monday usage` verb per cli-design §11.5.3 / §13 v0.3
  entry. Empirical-probe finding (2026-05-10, API `2026-01`):
  Monday's daily-budget surface lives at `platform_api.daily_limit
  { base total }` + `platform_api.daily_analytics.by_day [{ day,
  usage }]` — NOT `account.complexity` (the field doesn't exist
  on the `Account` type; the cli-design pre-M22 wording was
  loose). The unit Monday tracks under `platform_api.daily_*` is
  **operations per day** (200/day on free tier), NOT complexity
  points; per-minute complexity is a SEPARATE quota system
  already surfaced by v0.1's `account complexity`. Type surface
  pins `RawDailyLimit { base, total }`, `RawDailyAnalyticsByDay
  { day, usage }`, the `UsageOutput` envelope `{daily_limit,
  usage_today, usage_remaining_today, last_updated}` (additive-
  only per Decision 8 closure — v0.4 may extend with per-minute
  complexity + concurrency cap WITHOUT breaking), and the
  `USAGE_QUERY` GraphQL document. `fetchUsage(inputs)` builds a
  per-call `MondayClient` over the injected `Transport` (retries=0,
  verbose=false — the usage path doesn't need retry / complexity
  injection because the verb is reporting on the same budget the
  retry layer would consume) and projects via
  `projectUsageOutput`. Parse-failure path surfaces
  `internal_error` with `details.issues` so a Monday-side
  amendment to the `platform_api.daily_*` surface fails loudly
  rather than silently. The `day`-field timezone pin is UTC
  `YYYY-MM-DD` (`commands/usage.ts formatTodayKey` derives it
  via `toISOString().slice(0, 10)`); re-probe if a live-activity
  account reveals account-local semantics. Two pure helpers
  branch-tested: `sumUsageForDay(byDay, today)` (sum-where-day-
  equals, opaque string equality on the `day` field),
  `projectUsageOutput(parsed, today)` (clamps
  `usage_remaining_today` at zero — Monday's reported `usage` is
  best-effort and may briefly exceed `total` on a near-cap
  account). Single consumer: `commands/usage.ts`.

- `api/time-tracking.ts` (v0.3 M20 — pre-flight at `a702af2`,
  runtime body landed at M20 implementation as **documentation-
  only verbs**). Verb-shaped column-type extension primitives
  for the `monday item time-track start / stop` surface
  (cli-design §5.2 carve-out 2). Two consumers:
  `commands/item/time-track/start.ts` + `... /stop.ts` (three-
  level command depth via nested `ensureSubcommand`). The api
  primitives `startTimeTracking` / `stopTimeTracking` reject
  every invocation today with `usage_error` carrying the
  `API_UNSUPPORTED_HINT` constant — empirical probe at M20
  implementation kickoff (2026-05-10, against API version
  `2026-01`) confirmed Monday's public GraphQL API does not
  currently expose any mutation for writing to time_tracking
  columns: `change_simple_column_value` rejects with
  `CorrectedValueException` for every candidate value;
  `change_column_value` rejects with `InvalidColumnTypeException`
  for every candidate JSON shape; the mutation root has zero
  time-tracking-related mutations. The four pre-flight
  `*Inputs` / `*Result` interfaces stay verbatim so the
  runtime body swap is one-sided when Monday ships API support
  (replace the rejection with the wire call; no consumer
  change). `StopTimeTrackingResult.durationSeconds: number |
  null` — null when Monday omits `started_at` on the just-
  closed session (per-session duration uncomputable; SDK 14.0.0
  exposes only the column-level `TimeTrackingValue.duration`
  total). No cache surface, no R46 `withBoardInvalidation*`
  wrapping — `time_tracking` mutations don't affect board
  structure.

### Post-M9 command surface (M10–M17)

M10–M17 add ~25 command files following the patterns established
in M5b/M9 (commands/<noun>/<verb>.ts each registered in
`commands/index.ts`, parsing argv via `parseArgv`, calling into
the helpers above, projecting through the per-verb output schema,
emitting the §6 envelope). The cli-design §4.3 contract section
is the per-verb spec; the v0.2-plan §3 milestone entries
document the verb cluster post-mortems. Briefly:

- **`commands/item/{archive,delete,duplicate,move,upsert}.ts`** —
  M10 / M11 / M12 lifecycle verbs. Already documented above.
- **`commands/update/{reply,edit,delete,like,unlike,pin,unpin,
  clear-all}.ts`** — M13's eight new update mutation verbs.
  `clear-all` is the first §6.4 partial-success consumer (the
  envelope is `ok: true` when dispatch ran; per-target failures
  land in `data.results[i].error`).
- **`commands/workspace/{create,update,delete,add-users,
  remove-users}.ts`** — M14 lifecycle. `add-users` / `remove-
  users` are the first **resolver-fronted** partial-success
  consumers (mixed numeric IDs + emails; per-token resolution
  failures land in `data.results`).
- **`commands/board/{create,update,archive,delete,duplicate,
  add-users}.ts`** — M15 lifecycle. `board duplicate` introduces
  the **wrapped envelope** shape (`data: { board: <projection>,
  is_async }`) because Monday's `BoardDuplication` carries an
  `is_async` slot the projection doesn't model. `board update`
  is per-attribute fan-out across `update_board(board_attribute,
  new_value)` with a force-live final read leg (Monday's per-
  attribute calls return only the changed slice).
- **`commands/board/{column-create,column-update,column-delete}.ts`** —
  M16 column lifecycle + the §8 eager-invalidation contract.
  Every verb calls `invalidateBoard(boardId)` post-success via
  R46's wrappers. `column-update` is per-attribute fan-out
  across **two** wire surfaces (`change_column_title` for
  `--title`, `change_column_metadata({column_property:
  description})` for `--description`); the trailing per-
  attribute response is authoritative for `data` (no force-live
  read leg — distinguishes column-update from board-update).
  `column-delete` is the first **two-tuple destructive verb**
  (R29's `extraDetails` slot extension carries `board_id`
  alongside the canonical `column_id` detailKey per cli-design
  §6.5).
- **`commands/board/{group-create,group-update,group-archive,
  group-duplicate,group-delete}.ts`** — M17 group lifecycle.
  All five adopt R48's `projectMutationGroup` + R46's
  invalidation wrappers from day one. `group-update` is per-
  attribute fan-out across the **single** `update_group(
  group_attribute, new_value)` surface; trailing response is
  authoritative for `data` (no force-live read leg). `group-
  archive` + `group-delete` are the 2nd + 3rd two-tuple
  destructive consumers (after M16 column-delete). `group-
  duplicate` deliberately omits `--with-updates` because
  Monday's `duplicate_group` wire signature has no
  `with_updates` argument (unlike `duplicate_item` /
  `duplicate_board`).
- **`commands/{status,usage}.ts`** (v0.3 M22 — pre-flight at
  `fbab6b0`; implementation at `3a1b465`). The diagnostics-
  cluster verbs per cli-design §11.5. `status` is a top-level
  verb (not a noun-verb shape) — mirrors `schema` / `raw`; the
  §5.2 two-level rule permits single-level verbs. Argv surface:
  `status` takes `--no-probe`; `usage` takes no flags beyond
  globals. Both action bodies delegate through dedicated helpers
  for testability — `commands/status.ts` extracts
  `orchestrateStatusProbes` (probe-matrix iteration with
  short-circuit on first network failure: DNS fail → TCP/TLS/auth
  surface `upstream_failed`; cache_writability + redaction_self_test
  + env_var_pickup always run) + `deriveOverall` (§11.5.2 rules:
  `redaction_self_test` failure ALWAYS promotes to `'down'`;
  network fail → `'down'`; auth-success + soft-local-fail →
  `'degraded'`) + `resolveStatusTransport` (env → flag → SDK-pin
  precedence, with `isMissingTokenConfigError` discriminator
  that downgrades ONLY the token-only `ConfigError` to a
  `no_token` auth-probe result — Codex M22 F2 ratification; other
  config-validation failures re-throw verbatim as `config_error`).
  `commands/usage.ts` exports `formatTodayKey(now)` returning UTC
  `YYYY-MM-DD` (pinned at M22 close; revise if Monday's runtime
  `day` field turns out to be account-local). `status`'s
  `meta.source` is committed BEFORE the orchestrator call (Codex
  M22 F1 ratification) so error envelopes on `overall='down'`
  report the accurate `source: 'live'` rather than the runner's
  `'none'` default. `status` imports `statusOutputSchema` +
  `StatusOutput` from `src/api/probes.ts` (single source of truth
  for the envelope shape — R-NEW-4 lift at `0b5af57`); `usage`
  defines its own `usageOutputSchema` locally (verb-specific
  envelope, no shared helper).

- **`api/cross-board-search.ts`** (v0.3 M23 — pre-flight at
  `1fefdb1`, Codex round-1 fixes at `9b93f15`, Codex round-2
  fixes at `fa27b60`; runtime body landed at `1f09a25`).
  The cross-board fan-out walker for `monday item search`'s
  v0.3 cross-board path (`--board` omitted; `--workspace` /
  `--favorites` / no-scoping-lever scopes the board set). Per
  the empirical-probe findings (2026-05-11, API `2026-01`,
  `scripts/probe/m23-cross-board.ts` +
  `scripts/probe/m23-cross-board-search-2.ts`), the walker
  fans out via `boards(ids: [...]) { items_page(query_params:
  { rules }) }` — DIFFERENT shape from the v0.1 single-board
  `items_page_by_column_values` (which takes a singular
  `board_id: ID!`). Inaccessible board IDs are silently omitted
  by Monday's `boards(ids:)` resolver; the walker detects the
  count delta and surfaces an `inaccessible_boards` warning.
  Per-board column resolution is required because passing a
  column token (e.g. `status`) that doesn't resolve on ONE
  board errors the WHOLE cross-board query; the walker resolves
  tokens per-board independently, skips boards where the column
  doesn't resolve (with a `column_not_found_on_board` warning).
  **v0.3 cross-board search is single-call-only** (Codex round-1
  P1-2 resolution): no resumable cross-board cursor; aggregate
  `--limit` short-circuit or per-board pagination state surfaces
  a `cross_board_truncated` warning with per-board `state`
  breakdown (`exhausted` / `has_more` / `not_started`) for agent
  introspection. v0.4 may add an opaque-token resumable cursor
  envelope-additively. Cap pinned at `DEFAULT_MAX_BOARDS=25` /
  `HARD_CAP_MAX_BOARDS=100` per Decision 5 closure (`3a2f1db`);
  the cap is wall-clock-latency-based, not complexity-budget-
  based — empirical probe measured ~25-30 complexity points per
  board against a ~999_950 per-call budget (complexity supports
  ~30,000+ boards) but per-call latency scales linearly at
  ~0.5-1.5s/N, putting N=25 at ~12-18s under the 30s
  `MONDAY_REQUEST_TIMEOUT_MS` default and N≥60 at the ceiling.
  Takes `MondayClient` (Codex round-1 P1-1 resolution — not
  `Transport` directly, so the walker inherits `--retry` +
  `--verbose`-complexity injection from MondayClient.raw).
  Walker result is pure-live (`source: 'live'` constant; Codex
  round-2 P2-1 resolution); the command-action aggregates with
  the per-board column-resolution pre-pass's cache state via
  `SourceAggregator`.

- **`api/board-favorites.ts`** (v0.3 M23 — pre-flight at
  `1fefdb1`, Codex round-1 fixes at `9b93f15`, Codex round-2
  fixes at `fa27b60`; runtime body landed at `1f09a25`).
  The 2-stage favorites resolver for `monday board favorites` +
  `monday item search --favorites`. Per the empirical-probe
  findings (2026-05-11, API `2026-01`, `scripts/probe/m23-
  favorites*.ts` + `scripts/probe/m23-hierarchy-*.ts`), Monday
  surfaces favorites at the TOP-LEVEL `Query.favorites:
  [GraphqlHierarchyObjectItem!]` (NOT `User.favorites` /
  `Board.is_starred`). The element is POLYMORPHIC — `object: {
  id, type }` with `type: GraphqlMondayObject` enum (Board |
  Folder | Dashboard | Workspace). Stage 1 fetches
  `FAVORITES_LIST_QUERY` and filters via
  `filterFavoritesToBoards` to `object.type === Board`,
  sorting by `position` (Float — Monday's UI sidebar order
  ascending). Stage 2 hydrates surviving board IDs via
  `BOARDS_HYDRATE_QUERY` (`boards(ids: [...])` for name +
  workspace_id + state + url; `complexity` NOT selected per
  Codex round-1 P1-1 — MondayClient.raw injects it under
  `--verbose` automatically). The 2-stage shape mirrors M22's
  `monday usage` (`platform_api.daily_limit` +
  `platform_api.daily_analytics`); one round-trip per stage.
  Stage-1/Stage-2 count delta surfaces a `board_favorites_stale`
  warning (a favorited board was deleted or had access
  revoked). Resolver result is pure-live
  (`source: 'live', cacheAgeSeconds: null` per Codex round-1
  P1-1 — no per-call cache).

- **`commands/board/favorites.ts`** (v0.3 M23 — pre-flight at
  `1fefdb1`; runtime body landed at `1f09a25`). The
  `monday board favorites` verb. Argv-empty shape (no command-
  specific flags beyond globals). Action body drives
  `fetchBoardFavorites` (the 2-stage filter+hydrate above) and
  emits the §6.1 collection envelope sorted by Monday-UI
  `position` (Float). Integration tests at
  `tests/integration/commands/board-favorites.test.ts` cover
  Stage-1 short-circuit, happy path, stale-favorites warning,
  parse-failure shape + envelope contract.

- **`commands/item/search.ts`** (v0.3 M23 extension; pre-flight
  at `1fefdb1`; cross-board runtime body landed at `1f09a25`).
  The v0.1 single-board path
  (`items_page_by_column_values`) remains UNCHANGED; the v0.3
  extension adds `--workspace <wid>` / `--favorites` /
  `--max-boards <n>` flags + a `.superRefine` mutual-exclusion
  rule (at most one of `--board` / `--workspace` /
  `--favorites`; supplying two surfaces `usage_error` at the
  parse boundary with `params.conflicting_flags` carrying the
  named levers — Codex round-2 P2-3 fix to
  `parse-argv.ts:summariseIssues` preserves `ZodIssue.params`
  through to the envelope's `details.issues[].params`).
  `--max-boards` hard-cap enforcement is CONDITIONAL on the
  cross-board path (Codex round-1 P2-2 fix); the single-board
  path accepts any positive integer (the flag is documented as
  ignored when `--board` is set). Command-registry-facing
  `outputSchema` is `z.union([itemSearchOutputSchema,
  crossBoardSearchOutputSchema])` (Codex round-2 P1-1 fix) so
  `monday schema item.search` reflects both branches.
  Cross-board action body dispatches on the scoping lever:
  `--favorites` calls `fetchBoardFavorites` for the ID set;
  `--workspace <wid>` runs `CrossBoardEnumerate` against
  `boards(workspace_ids:[wid], limit:N, state:active)`; no
  scoping lever runs the same enum without `workspace_ids`
  for all-accessible mode. Per-board column-resolution
  pre-pass calls `loadBoardMetadata` per resolved board; the
  walker fans out via `crossBoardSearch`. Source aggregation
  via `SourceAggregator` merges per-board cache state with the
  walker's `'live'` constant. NDJSON streaming branch wraps the
  walker's `onItem` hook through `startNdjsonStream`. Cassette
  tests at `tests/integration/commands/m23-cross-board.test.ts`
  cover each scoping lever + each warning code (workspace /
  favorites / all-accessible happy paths, inaccessible_boards,
  column_not_found_on_board, cross_board_truncated, empty-plans
  short-circuit, NDJSON streaming, plus parse-boundary mutual
  exclusion + --max-boards validation).

- **`commands/auth/{login,logout}.ts`** (v0.3 M21 — pre-flight
  at `5c07840`, runtime bodies landed at M21 Part 1 in
  `a4cb5b0`). The OAuth flow + credentials cache verbs per
  cli-design §7.3 / §7.4. Both verbs read `--profile <name>`
  from the global flag layer (cli-design §4.4 — auth verbs do
  NOT redeclare `--profile` at the command level; commander
  attaches global flags to the parent program); both throw
  `usage_error` if the flag is missing. `auth login` runs the
  8-step flow per cli-design §7.3.1 (`generateOAuthState` →
  `bindOAuthListener` or `buildTestOAuthListener` if
  `__test_oauth_helper` is set → consent-URL build + best-effort
  browser open + stderr URL print fallback → `awaitRedirect` →
  `verifyCsrf` → kind-mapping [`code` → exchange, `error:
  access_denied` → `user_denied`, other error →
  `authorization_failed` with `monday_code` + optional
  `monday_description`] → `exchangeCode` → post-exchange
  `account { id }` GraphQL via the just-obtained token [single
  consumer of the fresh-transport pattern; R-watch-item logged
  for `monday auth refresh` v0.4+] → `setProfileCredentials`)
  and emits `{profile, account_id, scopes}` (token NEVER in
  `data` per §7.4.3). `auth logout` calls
  `deleteProfileCredentials(profileName)` and emits `{profile,
  was_present}` (idempotent per §7.3.2; the post-delete
  profiles map is preserved as `{schema_version: '1', profiles:
  {}}` rather than the file being deleted outright).

- **`api/dev-conventions.ts`** (v0.3 M26 — pre-flight at `1620220`,
  M26a IMPL runtime fetchers at `19755e3`, M26b IMPL workflow-verb
  helpers cluster at `10cd1c5` + `34a5bc1` round-1 P2-3 lift).
  Owns the `monday dev …` namespace's convention-to-board-ID
  resolution per cli-design §2.7 (Monday Dev is convention, not
  API). Three layers:
  1. **Discover heuristic + doctor diagnostics** (M26a):
     `matchBoardByConvention` + `groupCandidatesByDevNoun` +
     `buildDiscoverMappingFromMatches` (pure helpers seeding
     auto-detection from stock English board names: `Tasks` /
     `Sprints` / `Epics` / `Releases` / `Bugs`). `discoverDevBoards`
     walks accessible boards via `boards(state: all,
     workspace_ids:)` with a `Board.type === 'board'` filter
     (drops `sub_items_board` virtual entries — empirical-probe
     finding pinned at 2026-05-11). `runDevDoctor` validates a
     mapping via 10 checks pinned in `DEV_DOCTOR_CHECK_NAMES`
     (`tasks_board_exists` / `tasks_status_column_present` /
     `tasks_status_labels_canonical` / `sprints_board_exists` /
     `sprints_date_columns_present` / `epics_board_exists` /
     `releases_board_exists` / `bugs_board_exists` /
     `tasks_to_sprints_relation` / `tasks_to_epics_relation`)
     with per-status detail surfaced via the structural
     `z.discriminatedUnion('status', [ok, warn, fail])` schema +
     the closed `DEV_DOCTOR_REASONS` 11-value enum
     (`z.toJSONSchema` exposure for `monday schema dev.doctor`
     introspection — M26a IMPL round-2 P2-1 refactor).
  2. **Per-profile dev-block IO**: `loadDevMapping(profile,
     options)` reads `[profiles.<name>.dev]` from
     `~/.monday-cli/config.toml`; throws `dev_not_configured`
     with `details.reason ∈ {no_config_file, profile_absent,
     no_dev_block}` when absent. `saveDevMapping(profile,
     mapping, options)` writes atomically via tmp-rename with
     mode `0o600`. `smol-toml` `stringify` produces canonical
     TOML (comments discarded — M26a IMPL contract correction).
  3. **M26b workflow-verb helpers cluster** (R-NEW-36):
     `walkDevBoardItems` (7 consumers across read verbs;
     composes paginate + fetchItemsPage + parseRawItem +
     projectItem; narrowed `dev_board_misconfigured` rewrap of
     empty-`boards` parse failures via `isEmptyBoardsArrayIssue`
     — Codex round-2 P2-1 fix), `hydrateDevBoardColumns` (4
     consumers; single `boards(ids:)` + column projection),
     `findRelationColumnIdToBoard` + `extractLinkedItemIds` (3
     consumers; the sprint-items / epic-items / task-list-with-
     sprint walkers filter tasks-board items by board_relation
     column value), `resolveStatusColumn` +
     `resolveCanonicalLabel` (3 consumers; the task mutation
     verbs case-insensitively resolve the canonical
     "Working on it" / "Done" / "Stuck" label against the
     configured status column's labels), `flipTaskStatus` (3
     consumers; composes hydrate + resolve + executeItemMutation
     into the start/done/block flip preamble),
     `fireDevCreateUpdate` (2 consumers; the `task done
     --message` + `task block --reason` side-effect with a
     strict zod parse boundary on Monday's `create_update`
     mutation + dynamic operation-name builder so the doc
     named-operation + wire `operationName` always agree —
     Codex round-2 P1-1 fix).

  **`commands/dev/_shared.ts`** owns the per-verb preamble:
  `resolveActiveDevProfile(ctx, programOpts)` resolves the
  active profile name via the same flag / env / default_profile
  precedence `cli/program.ts`'s preAction hook uses for token
  resolution (throws `config_error` in implicit-v1 mode); and
  `requireDevBoard(mapping, slot, profile)` (R-NEW-35, 10
  consumers) pulls a noun-specific board ID off the loaded
  mapping or throws `dev_not_configured` with `details.slot`.

### `config/` (configuration boundary)

- `config/load.ts` (M0) — env-var-only config loader. Parses
  `MONDAY_API_TOKEN` / `MONDAY_API_URL` / `MONDAY_API_VERSION` /
  `MONDAY_REQUEST_TIMEOUT_MS` through a zod schema; rejects with
  `config_error` (exit 3) on any failure.
- `config/credentials.ts` (v0.3 M21 — pre-flight at `5c07840`,
  runtime bodies landed at M21 Part 1 in `5c1f7ac`). Mode-`0600`
  per-profile credentials cache primitive at
  `~/.monday-cli/credentials` per cli-design §7.4. Closes
  v0.3-plan §8 Decision 3. Zod schemas pin the §7.4.1 file
  shape (`schema_version` literal-pinned to `"1"` at the
  security floor — defends against future-version files
  silently passing through; `profileEntrySchema` covers
  `{access_token, obtained_at, expires_at: string | null,
  scopes, account_id}`). Six runtime helpers:
  `resolveCredentialsPath`, `readCredentials` (with
  `fs.fstat`-against-open-descriptor permission check; refuses
  on `mode & 0o077 !== 0` with `chmod 600` hint),
  `writeCredentials` (atomic-replace mirroring `src/api/cache.ts
  writeJsonFile` verbatim — `mkdir 0o700` + `chmod 0o700` on
  parent dir; `writeFile(tmp, payload, {mode: 0o600})` +
  re-`chmod 0o600` + `rename`; secure-file primitive R-candidate
  stays below the 3-consumer threshold per cli-design §7.4.2's
  in-design backstop), `setProfileCredentials` (read-modify-
  write convenience for `auth login`), `deleteProfileCredentials`
  (idempotent for `auth logout` — returns `{wasPresent}`;
  preserves the file with empty `profiles: {}` map after the
  last delete per §7.3.2), `resolveProfileToken` (per-profile
  source-order resolver: `credentials_cache` > `api_token_env`
  > `config_error`).
- `config/profiles.ts` (v0.3 M21 — pre-flight at `5c07840`,
  runtime bodies landed at M21 Part 1 in `5c1f7ac`). TOML loader
  for `~/.monday-cli/config.toml` per cli-design §7.2. Zod
  schemas pin the §7.2 file shape with two layers of defense
  for the no-token-in-config rule: structural exclusion via
  `.strict()` rejects unknown keys (`access_token`, `api_token`,
  `secret`, `token`); value-level shape check via
  `/^[A-Z_][A-Z0-9_]*$/u` regex on `api_token_env` rejects
  token-looking values. Three runtime helpers:
  `resolveProfilesConfigPath`, `loadProfilesConfig` (parses TOML
  via `smol-toml` — the dep added at Part 1 per the v0.3-plan
  §3 M21 leaning, minimal footprint + ESM-native + zero runtime
  deps), `selectProfile` (§7.2 source-order resolver:
  `--profile flag` > `MONDAY_PROFILE env` >
  `default_profile in config` > implicit-v1 mode). One contract
  widening vs the M21 pre-flight: `selectProfile` returns a
  synthetic empty `ProfileEntry` when `--profile work` is set
  but no `config.toml` exists — credentials-cache-only flows
  (run `monday auth login --profile work` then any other
  command with `--profile work`) work without requiring a
  `config.toml` edit. The `config_error` path stays for the
  genuine "named profile missing from the listed profiles" case.

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

The full envelope contract — `meta` skeleton, error fields, the
**29 stable error codes** (v0.1 froze 26; v0.2-M12 added
`ambiguous_match` → 27; v0.3-M19 added `tag_not_found` → 28; v0.3-M21
added `oauth_failed` → 29 at the M21 pre-flight contract diff per
§7.3.3; v0.3-M22 added NO new codes — probe failures map to existing
codes per cli-design §11.5.1's per-probe mapping table) — lives in
`cli-design.md` §6 and is enforced by the
integration suite's envelope-contract assertion
(`assertEnvelopeContract`) on every M2+ command's output. Adding
fields to `meta` or `data` is non-breaking; removing or renaming
is a major version bump.

## Error model

Thrown errors are instances of the typed family in `src/utils/errors.ts`,
all sharing a base class with a stable `code` from the registry
(29 codes today; v0.1 froze the initial 26 + v0.2/v0.3 milestones
extended it):

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

## Wire-vs-CLI semantics documentation conventions

> **Loaded at v0.4-M31 pre-flight** (R-NEW-41 lift, 3rd-consumer
> trigger). v0.3-plan §22 R-NEW-41 entry pinned this section's
> placement.

The CLI surfaces a stable, agent-keyed envelope contract (§6
in `cli-design.md`). Monday's wire surface evolves at its own
cadence — and at API `2026-01` the wire surface carries three
documented asymmetries where the CLI's argv shape OR transport
shape diverges from a 1:1 mirror of Monday's wire. Each
asymmetry needs documentation discipline so future agents
(and future maintainers) understand WHY the divergence exists
and where to look when the wire surface evolves.

This section enumerates the three asymmetries known at v0.4-M31
pre-flight, the per-asymmetry documentation cadence, and the
expansion rule for future asymmetries.

### The three asymmetries

**1. `Webhook.config` JSON-input / String-output asymmetry**
(v0.3-M27). Monday's `create_webhook` mutation accepts
`config: JSON` (any valid JSON value); Monday's read-side
`Webhook.config` returns `String` (the stored JSON-encoded
text). The CLI's read-shape treats `config` as `string | null`;
`webhook create` parses `--config <json>` once at the parse
boundary and threads the resulting JS value to Monday's
`JSON` scalar (sending the raw string would result in Monday
seeing a JSON-string-of-a-string). Documented inline in
`src/api/webhooks.ts`'s module docstring.

**2. `NotificationTargetType` wire enum collapse** (v0.3-M27).
Monday's `NotificationTargetType` wire enum has TWO values
(`Post` / `Project`); `Project` covers both items and boards
at the wire level. The CLI surfaces a TWO-value `--target-type
item|board` argv that collapses to wire `Project`; the CLI
preserves the item-vs-board distinction at the parse boundary
for argv-validation discipline + envelope echo, but neither
the CLI nor Monday cross-validates that the supplied `--target
<id>` actually names the declared kind. Documented inline in
`src/api/notifications.ts`'s module docstring + `cli-design.md`
§4.3 notification row.

**3. Multipart-vs-JSON transport asymmetry** (v0.4-M31).
Monday's `add_file_to_column` + `add_file_to_update` mutations
cross the wire via `multipart/form-data` per the standard
GraphQL multipart-request specification (jaydenseric) — the
operations + map + file parts wire envelope is incompatible
with the JSON-only `client.request` seam's
`body: JSON.stringify(...)` + `Content-Type: application/json`
invariants. The CLI carries TWO sibling transports rather than
one transport with a multipart branch:

  - `src/api/transport.ts` — `Transport` interface + JSON body
    + hard-coded `Content-Type: application/json`.
  - `src/api/multipart-transport.ts` — `MultipartTransport`
    interface + binary `file: Blob` slot + `filename` slot +
    `Content-Type` set by `fetch` from FormData boundary.

The two interfaces share the `Authorization` + `API-Version`
header lockdown discipline + the timeout-aware combined-signal
threading; they DIFFER on `Content-Type` ownership (JSON
transport owns it; multipart transport delegates to `fetch`).
Documented inline in `src/api/multipart-transport.ts`'s module
docstring + `src/api/assets.ts`'s module docstring + cli-design
§6.4 asset-upload sub-section.

### Documentation cadence — inline + cross-link

Each per-asymmetry inline prose lives in the relevant module
docstring (one per asymmetry). The module docstring is the
load-bearing source — it carries the empirical-probe finding
(e.g., "introspected via `scripts/probe/m31-asset-upload.ts`
2026-05-13, API `2026-01`") + the rationale for the CLI's
chosen shape + the failure-mode mapping. The architecture.md
section (this one) is the **canonical cross-link target**
for any other prose that needs to reference the asymmetry:

  - the relevant cli-design.md subsection (e.g., §6.4
    asset-upload sub-section, §4.3 verb-row prose) — points
    HERE rather than re-explaining the asymmetry.
  - per-verb prose in cli-design.md §4.3 — points HERE.
  - the v0.3-plan + v0.4-plan §22 R-class entries — point
    HERE.
  - per-asymmetry module docstrings — are the
    source-of-truth; carry the empirical-probe finding +
    rationale; point at THIS section for the cross-cutting
    "why we document this pattern" discussion.

The cadence is **inline-first**. An agent diagnosing a wire
mismatch reads the module docstring first (it's the closest to
the code path); the architecture section exists to explain
WHY the documentation lives where it does and to flag the
pattern for future maintainers seeing a 4th asymmetry.

### Expansion rule — the 4th asymmetry

When a 4th wire-vs-CLI asymmetry surfaces in a future milestone,
the discipline is:

  1. Document the asymmetry inline in the relevant
     `src/api/<noun>.ts` module docstring (empirical-probe
     finding + rationale + failure-mode mapping).
  2. Extend THIS section's "The three asymmetries" enumeration
     to four — same prose shape as the existing three.
  3. Update the per-affected cli-design + plan-doc references
     to point HERE.
  4. File an R-NEW entry in the relevant plan doc's §22 if the
     asymmetry has a code-shape implication (a new
     transport/interface; a new wire-enum bridge), or skip the
     R-class entry if it's purely a documentation lift.

**Anti-pattern to avoid.** Re-explaining the asymmetry in
every consumer's docstring + cli-design + plan-doc prose +
test description. The M27 webhook + notification surfaces
shipped with three+ inline copies of the per-asymmetry
prose because no canonical cross-link target existed; the
R-NEW-41 lift at M31 pre-flight closes that gap.
