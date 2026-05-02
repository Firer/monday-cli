# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project Overview

`monday-cli` is a TypeScript command-line tool for interacting with the
[Monday.com](https://monday.com) GraphQL API and Monday Dev. The primary
audience is **AI coding agents** (Claude Code, Codex, etc.) — the CLI exists
so that agents can pull down assigned tasks, file backlog items, update
descriptions, reorder items, transition statuses, etc., without each agent
needing to learn the GraphQL schema directly. Humans are second-class users
but should still get a pleasant experience.

The integration is being built **incrementally and entirely via Claude Code**
on top of the official `@mondaydotcomorg/api` SDK.

## Status

**v0.1.0 published; v0.2.0 in development on `main` — M0–M9 shipped.**
The published tarball at `0.1.0` has the v0.1 surface (5 reader
nouns + the four M5b mutations + diagnostics + escape hatch). On
`main`, M8 expanded the writer surface (`--set-raw` escape hatch +
firm-row `link` / `email` / `phone` translators) and M9 added the
first item-lifecycle verb (`item create` — top-level + classic-only
subitem with single round-trip per cli-design §5.8). The
`@mondaydotcomorg/api` SDK pin (14.0.0 / API 2026-01) is unchanged.
The agent-flow E2E (`tests/e2e/agent-flow.test.ts`) exercises the
v0.1 contract across four binary spawns — `item list` → `item set`
→ `item set` → `update create`. Three binding documents:

- **[`docs/cli-design.md`](./docs/cli-design.md)** (~2,200 lines) —
  the canonical CLI contract: command surface, output envelope,
  error codes (26 stable), deferral list, every single design
  decision. Two AI-collaborator review passes per change; M8/M9
  hard-gate diffs cleared with N→Y verdicts before implementation.
- **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** (~1,500 lines) —
  the v0.1 implementation plan: ten sequenced milestones (M0–M7
  with M5 split + M2.5 refactor pass inserted post-M2), per-
  milestone deliverables, testing-pyramid commitments, risk
  register, exit checklist, and per-milestone post-mortems
  (§11 M0, §12 M2, §13 M2.5, §14 M3, §16 M4, §18 M5a, §19 M5b,
  §20 M6, §21 M7).
- **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** (~850 lines) —
  the active v0.2 plan: eleven sequenced milestones M8–M18, per-
  milestone deliverables, exit criteria, decisions log, §10 M8 +
  §11 M9 post-mortems.

**Milestones:**

| ID | Status | Surface |
|----|--------|---------|
| M0 | shipped | runner + `errors.ts` + `redact.ts` + signal handling + envelope builders |
| M1 | shipped | `config show/path`, `cache list/clear/stats`, `schema`; CommandModule registry |
| M2 | shipped | `Transport` + `MondayClient` + retry; `account whoami/info/version/complexity` |
| M2.5 | shipped | structural-debt cleanup pre-M3: `resolve-client.ts`, `envelope-out.ts` (`MetaBuilder`), `program.ts`, `toEmit` |
| M3 | shipped | `workspace`/`board`/`user`/`update` reads (14 commands) + `board-metadata.ts` + `columns.ts` + `resolvers.ts` + `walk-pages.ts` |
| M4 | shipped | `item` reads (5 commands: list/get/find/search/subitems) + `filters.ts` + `pagination.ts` + `sort.ts` + `item-projection.ts` + R6/R7 refactors (test helpers + get-by-id helper) |
| M5a | shipped | `column-types.ts` (R8: shared writable allowlist + `parseColumnSettings`) + `column-values.ts` (all seven v0.1 translators: text / long_text / numbers / status / dropdown / date / people, plus `selectMutation` mutation-selection helper + `unsupported_column_type` error path + safe-integer guard + the async entry `translateColumnValueAsync` for people-resolution-needing paths) + `dates.ts` (ISO date / ISO date+time / relative tokens with DST-safe resolution against `MONDAY_TIMEZONE`) + `people.ts` (comma-split emails + `me` token via injected `resolveMe` + `resolveEmail` callbacks; defence-in-depth ID schema-tightening on `userByEmail`) + `src/types/json.ts` (R-JsonValue: tightened `JsonObject` slot replaces `Readonly<Record<string, unknown>>` for rich payloads) + `dry-run.ts` (M3 column resolution + R12 cache-miss-refresh + M5a translation + item-state read; all-or-nothing semantics + cli-design §6.4 byte-snapshot exit gate; resolver-warning preservation across `column_archived` throws) + `me-token.ts` (R15 shared `isMeToken` helper) + `DECIMAL_USER_ID_PATTERN` lift (R16) + R17 ZodError wrap at `userByEmail`. |
| M5b | shipped | All four mutation commands: `item set` (single-column write) + `item clear` (per-type dedicated clear payload) + `item update` (multi-`--set` atomic + bulk `--where` w/ `confirmation_required`) + `update create` (`--body` / `--body-file` / stdin, `--dry-run` supported despite non-idempotent). Five supporting refactors: `item-helpers.ts` lift (R9 — `COLUMN_VALUES_FRAGMENT` + `ITEM_FIELDS_FRAGMENT` + `collectColumnHeads` + `titleMap` + `resolveMeFactory` + `projectFromRaw` + `parseRawItem`) + `collectSecrets` consolidation (R10) + `resolveColumnsAcrossClauses` lift (R12) + `parse-boundary.ts unwrapOrThrow` (R18 — `board-metadata` + `item-helpers` + `emit.ts` drift catch) + `resolver-error-fold.ts` lift (R19 — `foldResolverWarningsIntoError` + `mergeDetails` + `maybeRemapValidationFailedToArchived`, six consumers); `emitMutation` + `emitDryRun` emit helpers; `MutationEnvelope.resolved_ids` echo per cli-design §5.3 step 2; `boardLookupResponseSchema` for implicit board lookup; `validation_failed` → `column_archived` remap on cache-sourced resolution (single + bulk per-item). |
| M6 | shipped | `board doctor` (3 diagnostic kinds: duplicate_column_title / unsupported_column_type per roadmap category / broken_board_relation) + `raw` (GraphQL escape hatch w/ `<query>` positional, `--query-file <path\|->`, `--vars <json>`, `--vars-file <path\|->`, `--allow-mutation` gate, `--operation-name <n>`, AST-aware `analyzeRawDocument` analyser keying off the `graphql` reference parser, `--dry-run` honoured for mutations per §9.2 — close-arc Codex P1 fixes) + agent-flow E2E (4-spawn list → start → done → comment with `assertEnvelopeContract` per §6.1) |
| M7 | shipped | release prep — `published-tarball.test.ts` (npm pack + extract + install runtime deps + smoke binary), `envelope-snapshots.test.ts` (40 snapshots — one per shipped command pinning the §6.1 byte shape so v0.2 drift fails loud), `docs/output-shapes.md` (per-command `data` reference, snapshot-backed), `CHANGELOG.md` 0.1.0, README auth + agent quickstarts, version bump → 0.1.0 |
| M8 | shipped (on main) | Writer expansion: `--set-raw <col>=<json>` escape hatch (`raw-write.ts` parser + post-resolution gate that rejects `read-only-forever` / `files-shaped` types per cli-design §5.3 escape-hatch contract; `change_column_value` / `change_multiple_column_values` only — never `change_simple_column_value` for raw) + three firm-row friendly translators (`links.ts` pipe-form `url\|text`, `emails.ts` pipe-form, `phones.ts` E.164 + `iso-country-codes.ts` for the country-code allowlist). `--set-raw` wired into `item set` + `item update` single + `item update --where` bulk; resolution-time mutual-exclusion check (`--set` + `--set-raw` against same resolved column → `usage_error` per cli-design §5.3 step 2). Codex post-implementation fixes pinned the resolution-before-translation invariant (resolve every token first, then translate) so a `--set X=bad` alongside `--set-raw X={...}` surfaces the mutual-exclusion error rather than the translation error. |
| M9 | shipped (on main) | `monday item create` — top-level + classic-only subitem with single round-trip per cli-design §5.8. New `commands/item/create.ts` (~1,340 LOC) + `bundleColumnValues` lift in `column-values.ts` (shared between `selectMutation`'s multi case and create's single bundled `column_values` parameter) + `planCreate` engine sibling in `dry-run.ts` (no item-state read; hoisted `name` / `group_id` / `position` / `parent_item_id` slots per cli-design §6.4 item-create shape). `--parent <iid>` triggers `create_subitem` against the auto-derived subitems board (`subtasks.settings_str.boardIds[0]`); multi-level boards (`hierarchy_type: "multi_level"`) rejected pre-mutation with `usage_error` carrying `details.deferred_to: "v0.3"`. Three rounds of Codex review (round 1 N → 2 partial Y → 3 Y / zero findings). |
| M9.5 | shipped (on main) | post-M9 R-class refactor cleanup pre-M10 (v0.2-plan.md §12): `set-expression.ts` (R22 — `splitSetExpression`), `resolution-context.ts` (R24 — `buildResolutionContexts`), `item-board-lookup.ts` (R23 — `lookupItemBoard` + `lookupItemBoardWithHierarchy` + `resolveBoardId`), `source-aggregator.ts` (R21 — `mergeSource` + `mergeSourceWithPreflight` + `mergeCacheAge`), `resolver-error-fold.ts foldAndRemap` (R26 — mutation catch-arm wrapper for fold + F4 remap), `resolution-pass.ts` (R20 — three-pass column resolution helper consolidating ~80-90 LOC × 5 sites into one shared `resolveAndTranslate`). Plus R25 — drop drift `CreateModeFromCommand` in favour of imported `CreateMode`. Net ~1900 LOC duplication collapsed into ~660 LOC of shared helpers; coverage 98.82 / 95.17 / 99 / 98.91 above the 95/94/95/95 floor. M10's three new mutation commands (archive / delete / duplicate) inherit the helpers rather than copy the patterns. |

> **If you're implementing anything in this repo, read
> `docs/cli-design.md` for the contract and `docs/v0.2-plan.md` for
> the active milestone before writing code.** The design contract is
> binding — changes land via PRs that argue for the change, not by
> drift. The plan is a living doc; update it when scope shifts.

Updates to the design also update this file's "Contract at a glance"
section below so a future fresh agent doesn't have to read the whole
design doc to orient.

## Commands

```bash
# Install
npm install

# Develop
npm run dev -- <args>          # tsx-based dev runner (no build step)
npm run build                  # compile to dist/
npm start -- <args>            # run compiled CLI

# Quality gates
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint .
npm run lint:fix               # eslint . --fix
npm test                       # vitest run (all suites)
npm run test:unit              # unit only
npm run test:integration       # integration only
npm run test:e2e               # E2E only
npm run test:coverage          # with v8 coverage + threshold check
npm run test:watch             # watch mode
```

## Directory Layout

```
src/
  cli/         # Commander entry — wires commands to argv parsing
  commands/    # One file per CLI subcommand (thin — delegate to api/)
  api/         # Monday API wrapper around @mondaydotcomorg/api
  config/      # Env/file config loading + zod validation
  types/       # Shared TypeScript types not auto-generated by the SDK
  utils/       # Logger, output formatters (json/table), error helpers
tests/
  unit/        # Pure logic — no network, no fs writes
  integration/ # Hits a recorded fixture server or mocked GraphQL
  e2e/         # Spawns the compiled CLI and asserts on stdout/exit codes
  fixtures/    # Recorded GraphQL responses, sample column values, etc.
docs/
  cli-design.md     # ★ CANONICAL CONTRACT — read first. Command surface,
                    #   output envelope, error codes, divergences from
                    #   Monday's API, v0.1/v0.2/v0.3/v0.4 phasing.
  v0.1-plan.md      # ★ shipped — v0.1 implementation plan M0–M7
                    #   with M5 split + M2.5 refactor pass; per-milestone
                    #   post-mortems §11–§21. Reference for the v0.1
                    #   foundations every later milestone builds on.
  v0.2-plan.md      # ★ ACTIVE IMPLEMENTATION PLAN — milestones M8–M18,
                    #   per-milestone deliverables + tests + exit criteria,
                    #   §10 M8 + §11 M9 post-mortems. Read after
                    #   cli-design.md before any v0.2 code.
  architecture.md   # Module boundaries (commands→api→SDK separation)
  api-reference.md  # Monday concepts cheat sheet — supplementary; the
                    #   canonical schema summary is cli-design.md §2
  development.md    # Local dev workflow, how to add a new command
  examples.md       # Worked agent sessions — instructional, not contract
.claude/
  rules/       # Path-scoped rule files for Claude Code agents
.github/
  workflows/ci.yml  # typecheck + lint + test + build smoke on Node 22 / 24
```

## Conventions

The full coding standard lives in `.claude/rules/` — files auto-load
when editing matching paths:

| File | Loads when editing | Contents |
|------|--------------------|----------|
| `typescript.md` | `src/**/*.ts`, `tests/**/*.ts` | TS strictness, no-`any`, no-`null`-by-default, imports, errors |
| `testing.md` | `tests/**/*.ts` | Coverage standard (every branch), test layers, mocking rules |
| `validation.md` | `src/**/*.ts`, `tests/**/*.ts` | zod patterns — branded IDs, discriminated unions, parse-at-boundary |
| `security.md` | source + `.env*` | Token handling, redaction, fail-secure config, file permissions |
| `cli.md` | `src/cli/**`, `src/commands/**` | CLI standards — output discipline, exit codes, signals, stdin, conventional commits |

Headlines:

- **Strictest TypeScript settings.** `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noUnusedLocals/Parameters`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`. **No `any` types**
  (lint enforced). Avoid `null` unless `null` is a meaningful value distinct
  from `undefined` — for "no value", prefer `undefined` or omit the property.
- **ESLint: `strictTypeChecked` + `stylisticTypeChecked`** with extra rules
  including `prefer-readonly`, `switch-exhaustiveness-check`,
  `consistent-type-imports`, `explicit-function-return-type` on exported
  functions. `no-console` is **off** because this is a CLI — `console` is the
  product. Use the logger in `utils/` for anything structured.
- **Tests cover every branch.** Happy path, edge cases, error cases, format
  variations. Non-trivial commands need an E2E test that spawns the binary.
  Coverage thresholds are **95% lines / functions / statements + 94% branches**
  (post-M3 ratchet, sustained through M4); raise the floor as the codebase
  grows, never lower it.
- **Mock at the network boundary, not internal modules.** Stub
  `fetch`/`undici` (or the SDK's `request` method) — never reach into
  `commands/*` from a unit test to monkey-patch internal helpers.
- **Files are ESM (`"type": "module"`).** Use `.js` import specifiers in
  TypeScript (`import { foo } from './bar.js'`) — required by NodeNext
  resolution.
- **One subcommand per file** in `src/commands/`, following the shape:
  `export const command: CommandModule = { ... }`. `cli/index.ts` registers
  them.

## Contract at a glance

A summary of what the design doc commits to. **None of these is
negotiable without a doc revision and PR-style argument.** Read the
linked sections of `docs/cli-design.md` for the full reasoning.

- **Primary user is AI coding agents.** Humans are second-class. When
  the two conflict, agent ergonomics win. (§1)
- **Output:** table when stdout is a TTY, JSON when piped — preserves
  `monday item list | jq` without flags. Agents in pseudo-TTYs use
  `--json` (an explicit alias for `--output json`). Tables truncate
  long values; `--full` disables; JSON output never truncates. (§3.1, §3.2)
- **Universal envelope on every command.** Success:
  `{ok: true, data, meta, warnings}`. Failure: `{ok: false, error, meta}`.
  `meta` always carries `schema_version`, `api_version`, `request_id`,
  `source: "live"|"cache"|"mixed"|"none"`, `cache_age_seconds`,
  `retrieved_at`. Adding fields is non-breaking; removing/renaming is a
  major-version bump. (§6.1)
- **Stable error codes** (26 of them — `usage_error`, `not_found`,
  `ambiguous_column`, `column_archived`, `unsupported_column_type`,
  `rate_limited`, `complexity_exceeded`, `stale_cursor`, etc.).
  Errors carry
  `code`, `message`, `http_status`, `monday_code`, `request_id`,
  `retryable`, `retry_after_seconds`. Agents key off `code`, never
  English. (§6.5)
- **Exit codes:** 0 success, 1 usage, 2 API/network, 3 config, 130 SIGINT.
- **No interactive prompts. Ever.** Destructive ops without `--yes`
  return `confirmation_required`. (§3.1)
- **Monday API pinned to `2026-01`** matching SDK 14.0.0's
  `CURRENT_VERSION`. The pin goes on every request via the
  `API-Version` header. Override via `--api-version` for newer-API
  features (will need raw GraphQL where the SDK doesn't type them). (§2)
- **Column-value abstraction (§5.3)** is what makes `--set` work.
  Writable allowlist after M8 firm-row promotion: `status`, `text`,
  `long_text`, `numbers`, `dropdown`, `date`, `people` (v0.1) plus
  `link`, `email`, `phone` (M8). Other types return
  `unsupported_column_type` with per-category guidance:
  v0.2-tentative writer-expansion (`tags` / `board_relation` /
  `dependency`) carries `deferred_to: "v0.2"` plus a `--set-raw`
  hint; read-only-forever (`mirror` / `formula` / `auto_number` /
  `creation_log` / `last_updated` / `item_id`) carries
  `read_only: true` with a hint pointing at the underlying source
  column; other types carry `deferred_to: "future"` plus a
  `--set-raw` hint when the underlying mutation is shaped like
  `change_column_value`.
  **`--set-raw <col>=<json>` escape hatch (M8).** Bypasses the
  friendly translator — agent supplies the wire JSON object verbatim.
  Argv-parse-time validation rejects malformed JSON / non-object JSON
  with `usage_error`; post-resolution gate rejects read-only-forever
  + files-shaped types per §5.3 escape-hatch contract. Always uses
  `change_column_value` / `change_multiple_column_values` (never
  `change_simple_column_value`); for create, bundles into the same
  `column_values` map. Resolution-time mutual exclusion with `--set`
  (same resolved column ID across both → `usage_error` per §5.3 step 2).
  The CLI resolves `<col>` as ID > NFC-normalised
  exact title > NFC + case-fold > `ambiguous_column`. `me` is a
  recognised token for people columns. **Read-side resolver lives at
  `src/api/columns.ts`** (M3) and is the seam M5a's value translator
  reuses; archived columns surface as `column_not_found` for read
  paths. Cache-aware lookups via `resolveColumnWithRefresh` auto-
  refresh once on `column_not_found` after a cache hit per §5.3
  step 5; the refresh-then-resolve case sets `meta.source: "mixed"`
  with a `stale_cache_refreshed` warning. ID/title collisions on the
  ID-match path emit a `column_token_collision` warning (§5.3 step 3).
- **Column-type contract (M5a R8 + M8).** `src/api/column-types.ts`
  is the single source of truth for the writable allowlist:
  `WRITABLE_COLUMN_TYPES` (frozen `as const` array — order is part
  of the contract; tests iterate it; 10 entries post-M8),
  `isWritableColumnType` (type guard narrowing to the
  `WritableColumnType` union), `parseColumnSettings` (defensive
  `settings_str` JSON parser that returns `null` on null/empty/
  malformed input rather than throwing), `isReadOnlyForeverType` /
  `isFilesShapedType` (M8 — gate `--set-raw`'s post-resolution
  reject lists), `getColumnRoadmapCategory` (M8 — drives the
  category-accurate `unsupported_column_type` hint). Three
  consumers: `commands/board/describe.ts` (writable + example_set),
  `api/column-values.ts` (the friendly writer), `api/raw-write.ts`
  (the M8 escape hatch). Adding a v0.2-tentative type is one
  entry's worth of edit.
- **Column-value writer (M5a + M8).** `src/api/column-values.ts`
  is the write half of §5.3. `translateColumnValue({ column,
  value })` returns a `TranslatedColumnValue` carrying `columnId`,
  `columnType`, `rawInput`, and a discriminated `payload` —
  `{ format: 'simple', value: <bare-string> }` for the simple-form
  mutation path or `{ format: 'rich', value: <plain-object> }` for
  the JSON-object form. **Ten types translate** (7 v0.1 + 3 M8):
  `text` / `long_text` / `numbers` (all simple) and `status` /
  `dropdown` / `date` / `people` / `link` / `email` / `phone`
  (rich). **Two entry points**: the sync `translateColumnValue`
  covers the locally-resolvable types; `translateColumnValueAsync`
  is the unified async wrapper M5b's command layer always calls —
  it delegates to sync for non-people, dispatches
  `parsePeopleInput` for `people` (which needs network/cache
  lookup for email→ID resolution).
  **Status payload**: label-first (`{label:<verbatim>}`) with
  non-negative integer fallback (`{index:N}`, JS number). **Dropdown
  payload**: comma-split, per-segment trimmed, empties dropped;
  all-numeric → `{ids:[N1,N2]}` (numbers), any non-numeric →
  `{labels:[s1,s2]}` (strings). **Date payload**: ISO date
  → `{date}`, ISO date+time → `{date,time:"HH:MM:SS"}`,
  relative tokens (`today` / `tomorrow` / `+Nd` / `-Nw` / `+Nh`)
  → resolved against `MONDAY_TIMEZONE` via the M0-injected
  clock pattern; the resolution context plumbs through
  `TranslateColumnValueInputs.dateResolution` (defaulting to
  system clock + system tz). The full grammar lives in
  `src/api/dates.ts` with DST-boundary tests pinned for
  Europe/London + Pacific/Auckland 2026 transitions. Relative
  offsets are bounded to ±100 years magnitude so unsafe inputs
  surface as typed `usage_error` rather than malformed wire
  payloads. **People payload**: comma-split tokens (emails or
  case-insensitive `me`), each resolved through injected
  `resolveMe` + `resolveEmail` callbacks (mirrors `filters.ts`'s
  `me` plumbing — one rule across `--where Owner=me`, `item
  search --where Owner=me`, and `--set Owner=me`). Wire shape
  `{personsAndTeams:[{id:N,kind:'person'},...]}` with `id` as JS
  number; `kind` literal `'person'` only (teams deferred to
  v0.2). Numeric tokens (`--set Owner=12345`) rejected with
  `usage_error` carrying a `--set-raw` paste-ready hint
  (M8 — the hint now points at a flag that exists);
  unknown emails surface as `user_not_found` (bubbled from
  `resolveEmail`). The full grammar lives in
  `src/api/people.ts`. Defence-in-depth ID
  validation: `userByEmail`'s schema enforces decimal
  non-negative integer strings, AND the translator's
  `idStringToNumber` re-checks before `Number()` conversion —
  malformed shapes (`"0x2a"`, `"1e3"`) surface as
  `internal_error` rather than silently corrupting the wire
  payload. **Safe-integer guard**: numeric input > 2^53 - 1
  throws `usage_error` rather than silently rounding via
  `Number(raw)` and corrupting the wire payload.
  **Mutation selection** (`selectMutation`, §5.3 step 5):
  1 simple → `change_simple_column_value`; 1 rich →
  `change_column_value`; N (any combo) →
  `change_multiple_column_values` (atomic). Inside the multi
  mutation, `long_text` is re-wrapped as `{text:<value>}`
  because Monday's per-column blob there requires the object
  form (logged as a spec gap in v0.1-plan §3 M5a; pinned via
  fixture). Duplicate column IDs in a multi bundle throw
  `usage_error` (last-write-wins is silent corruption).
  **Bundled `column_values` map (M9 lift).** The
  per-column projection (`projectForMulti` + the long_text
  re-wrap rule) lives behind `bundleColumnValues(translated)`
  — the shared helper both `selectMutation`'s multi case AND
  M9's `item create` use to build the `column_values: JSON!`
  parameter. Same shape across `change_multiple_column_values`,
  `create_item`, and `create_subitem`; the fixture-pin tests
  in `column-values.test.ts` "create_item.column_values shape
  pin (M9)" cover the create surface alongside the original
  multi-update pin.
  **Monday `JSON` scalar discipline:** every payload is a
  plain JS value; the SDK / fetch layer stringifies at the
  wire boundary. The translator never `JSON.stringify`s —
  pinned by regression tests per category so a future
  contributor doesn't introduce double-encoding.
  Fixture-pinned wire shape per (count × type) cell so M5b's
  bulk surface and M9's create surface both inherit unchanged.
- **Dry-run engine (M5a + M9).** `src/api/dry-run.ts` exports
  two orchestrators. **`planChanges(...)`** powers M5b's mutation
  surfaces (`item set` / `item clear` / `item update`) — ties
  together M3 column resolution (with `includeArchived: true` so
  archived targets surface as `column_archived`, not
  `column_not_found`), M5a's `translateColumnValueAsync` +
  `selectMutation`, and a fresh item-state read for the diff
  `from` side. Output matches cli-design §6.4's column-mutation
  `planned_changes[]` shape byte-for-byte — pinned via a
  `JSON.stringify(result.plannedChanges[0])` literal-byte snapshot.
  **`planCreate(...)`** powers M9's `item create` (top-level +
  subitem). Sibling shape: same three-pass resolution, same
  resolver-warning preservation, same all-or-nothing semantics —
  but **no item-state read** (the item doesn't exist; `from` is
  always `null`) and the diff `to` side projects through
  `bundleColumnValues` (the shared map shape, not single-column
  variants) so the long_text re-wrap surfaces verbatim. The
  `CreateMode` discriminator handles top-level (`{kind: 'item',
  boardId, groupId?, position?}`) vs subitem (`{kind: 'subitem',
  parentItemId, subitemsBoardId}`) in one shape; the planned
  change hoists `name` / `group_id` / `position` /
  `parent_item_id` to top-level slots per cli-design §6.4
  item-create shape. Subitem variant **omits `board_id`** because
  Monday derives the subitems board server-side from the parent.
  **All-or-nothing semantics**: any resolution failure
  (`column_not_found` / `ambiguous_column` / `column_archived` /
  `unsupported_column_type` / `user_not_found` / item `not_found`
  / item-on-wrong-board / duplicate token / duplicate resolved id)
  aborts the batch BEFORE the item read fires. **Diff projection
  through `selectMutation`** (planChanges) / `bundleColumnValues`
  (planCreate): the diff `to` side surfaces the actual wire shape
  the live mutation would send — including the `long_text` re-wrap
  inside the map. Resolver warnings on a `column_archived` throw
  fold into `error.details.resolver_warnings` via
  `foldResolverWarningsIntoError` so a stale-cache-then-archived
  flow doesn't lose the `stale_cache_refreshed` signal. **Echo
  design — Option B**: `TranslatedColumnValue` carries parallel
  `resolvedFrom: DateResolution | null` and `peopleResolution:
  PeopleResolution | null` slots; `buildDiffCell` (and
  `buildCreateDiffCell`) enforces exclusivity via `internal_error`
  if a translator wires both. The people echo shape
  (`{tokens: [{input, resolved_id}, ...]}`) is logged as cli-design
  §6.4 backfill. **Parse-boundary discipline**: every wire-shape
  schema parse boundary uses safeParse + `ApiError(internal_error)`
  per validation.md, mirroring R17 / R18.
- **`item create` (M9).** `src/commands/item/create.ts` —
  `monday item create --board <bid> --name <n> [--group <gid>]
  [--set <col>=<val>]... [--set-raw <col>=<json>]... [--parent
  <iid>] [--position before|after --relative-to <iid>]`. Two
  argv shapes: top-level (calls `create_item`) and subitem
  (`--parent` triggers `create_subitem`). **Single round-trip is
  a hard exit gate** (cli-design §5.8): every `--set` / `--set-raw`
  value bundles into the single `column_values` parameter via
  `bundleColumnValues`; the CLI does NOT fall back to
  `create_item` + `change_multiple_column_values` on partial
  failure (partial-state risk). **Classic boards only** for v0.2:
  multi-level boards (`hierarchy_type: "multi_level"` per §2.8)
  rejected pre-mutation with `usage_error` carrying
  `details.hierarchy_type` + `deferred_to: "v0.3"`. The
  hierarchy_type check fires AFTER parent-item lookup but BEFORE
  any column resolution / value translation / mutation. **Subitems-
  board derivation**: when `--set` / `--set-raw` is supplied, the
  CLI loads parent's BoardMetadata, finds the `subtasks` column,
  parses `settings_str.boardIds[0]` to get the auto-generated
  subitems-board ID — column resolution targets that board, not
  the parent's. **Cross-flag mutex**: `--parent` excludes
  `--board` / `--group` / `--position` (subitems live on the
  subitems board, not in groups, not relative to arbitrary items);
  `--position` and `--relative-to` are required together; multiple
  `--set` against the same token caught at parse time. **F4 remap
  wired** (Codex round-1 P1): cache-sourced resolution + Monday
  `validation_failed` → forced metadata refresh → if archived,
  remap to `column_archived` with `details.remapped_from`. Mirrors
  every M5b mutation surface. **Mutation envelope**: `data: {id,
  name, board_id, group_id, parent_id?}` plus top-level
  `resolved_ids` echo per cli-design §5.3 step 2 / §6.4. **Source
  aggregation across pre-planner legs** (Codex round-1 P2): parent
  lookup is always live, parent-board metadata may be cache or
  live, column resolution may be cache / live / mixed, mutation is
  always live — `mergeSourceWithPreflight` + `mergeSourceLeg` fold
  every leg into the final envelope source. **Idempotent: false**
  — re-running creates a duplicate item; `monday item upsert`
  (M12) is the idempotent variant.
- **No `restore` in v0.1.** Monday has no unarchive mutation; recreating
  is lossy (new ID, no updates/assets/automation history). Don't add a
  misleading "restore" command — see §5.4 for what a future explicit
  recreate command would look like.
- **Two-level command depth** (`monday <noun> <verb>`) for CRUD
  surfaces, **with `dev` carved out** as a workflow namespace allowed
  three levels deep (`monday dev sprint current`). (§5.2)
- **Pagination cursor expires at 60 min.** Fail-fast with
  `stale_cursor` rather than silently re-issuing — silent re-issue can
  duplicate or skip rows. There's no safe deterministic resume in v0.1;
  callers restart with idempotent operations or a known-stable filter.
  (§5.6) M3 commands are page-based (Monday's `workspaces` / `boards`
  / `users` / `updates` use `limit` + `page`, not cursors). M4 added
  cursor pagination (`item list` / `search` via `items_page` →
  `next_items_page`) through `src/api/pagination.ts`'s `paginate`
  walker — fail-fast on `stale_cursor` with enriched
  `details.cursor_age_seconds / items_returned_so_far / last_item_id`,
  per-call effective `limit = min(pageSize, remainingBudget)` so
  Monday's cursor advances over exactly the rows the walker emits
  (no silent-skip on `--limit < pageSize` resume), and an injected
  clock so tests pin expiry without wall-clock waits. Page-based
  `--all` walks cap at `--limit-pages` (default 50, max 500); a
  cap-hit on a still-full page emits a `pagination_cap_reached`
  warning so agents can widen the cap or narrow the query. M4 reuses
  the same warning code on `item find` when the cap-bounded scan was
  truncated and uniqueness can't be verified. **Spec gaps (logged in
  v0.1-plan §3 M3 / §3 M4 for backfill):** `--limit-pages` /
  `pagination_cap_reached` aren't in cli-design.md yet; same for the
  M4 `--state` deferral and the find-cap variant of the warning. All
  additive / non-breaking.
- **v0.1 (published 0.1.0)** is read-heavy: account info, board
  list/get/find/describe/doctor, item list/get/find/search/set/clear/
  update (single mutation), update list/get/create, schema, raw,
  cache, config. **v0.2 in development on `main`** — M8 added the
  `--set-raw` escape hatch + the `link`/`email`/`phone` firm-row
  translators; M9 added `item create` (top-level + classic-only
  subitem). Remaining v0.2 milestones (M10–M18) cover `item archive`
  / `delete` / `duplicate` / `move` / `upsert`, full update mutation
  surface (`reply` / `edit` / `delete` / `like` / `pin` / `clear-all`),
  workspace + board lifecycle, NDJSON streaming, and 0.2.0 release
  prep. Monday Dev shortcuts arrive in v0.3. Watch and concurrency
  are v0.4. **See §13 of cli-design.md for the full phase markers —
  every command in §4.3 also carries its phase.**
- **`board describe` ships `example_set` per writable column** (M3
  exit criteria). Agents reading one `board describe` payload can
  construct `--set <token>=<value>` calls for every M5b-writable
  column on the board without consulting external Monday docs. Lives
  at `src/commands/board/describe.ts`.
- **Cross-noun resolver patterns (M3 share-out, extended M4).**
  `findOne(scope, query)` in `src/api/resolvers.ts` powers every
  `find` verb (boards in M3; items in M4) with identical NFC +
  case-fold + `--first` semantics. `userByEmail` in the same module
  owns the directory-cache + `users(emails:)` fallback that M5a's
  `--set Owner=<email>` value translator will reuse; M4's `--where
  owner=me` resolves through `client.whoami()` instead (cached for
  the lifetime of one filter-build call).
- **Pagination helpers.** Two walkers, one contract per Monday
  shape:
  - `walkPages` (`src/api/walk-pages.ts`) — page-based (`limit:` +
    `page:`), used by `workspace` / `board` / `user` / `update`
    list commands. Owns `--all` semantics, the `--limit-pages` cap,
    and the `pagination_cap_reached` warning.
  - `paginate` (`src/api/pagination.ts`) — cursor-based
    (`items_page` → `next_items_page`), used by M4 `item list` /
    `item search` / `item find`. Owns `--all` + `--limit` +
    streaming `onItem` + the §5.6 stale-cursor fail-fast contract.
    Result type carries every §6.1 + §6.3 meta slot from day one
    (`source / cacheAgeSeconds / complexity / warnings /
    nextCursor / hasMore / totalReturned / pagesFetched /
    lastResponse`) — §14 M3 prophylactic.
- **Filter DSL parser (M4).** `src/api/filters.ts` —
  `parseWhereSyntax` (pure syntax) + `buildFilterRules` (with
  `onColumnNotFound` cache-miss-refresh callback per §5.3 step 5) +
  `buildQueryParams` (top-level helper used by `item list`). Operator
  allowlist `=`, `!=`, `~=`, `<`, `<=`, `>`, `>=`, `:is_empty`,
  `:is_not_empty`. Splits on first operator per §5.3 step 2.b;
  operator-in-title columns route through `--filter-json` (the
  `title:`/`id:` prefix doesn't disambiguate post-split — see the
  module header). `me` sugar restricted to `people` columns;
  resolves through the injected `resolveMe` callback. `--where`
  and `--filter-json` mutually exclusive. Result type carries
  `warnings + refreshed` so callers fold `stale_cache_refreshed`
  into the envelope and flip `meta.source` to `'mixed'`.
- **Item projection (M4).** `src/api/item-projection.ts` —
  `rawItemSchema` (parse boundary) + `projectItem({raw,
  columnTitles?, omitColumnTitles?})` (canonical §6.2 shape).
  Single-resource calls (`item get`) keep per-cell `title` inline;
  collection calls (`item list / search`) drop per-cell `title`
  and consolidate into `meta.columns` per §6.3. Typed inline
  fields for the v0.1-allowlisted writable types (status / date /
  people); other types surface `text + value`.
- **Get-by-id action helper (M4 R7).** `src/commands/run-by-id-lookup.ts`
  compresses the parseArgv → resolveClient → client.raw → not_found
  → emit shape into one call; used by `workspace get`, `board get`,
  `user get`, `update get`, `item get`. Optional `project` callback
  for shapes that need a parse-then-project step (item get uses
  it for the column projection).
- **Integration test helpers (M4 R6).** `tests/integration/helpers.ts`
  — `baseOptions / EnvelopeShape / parseEnvelope /
  assertEnvelopeContract / drive` shared by every M2+ integration
  test file. New M5+ test files should start at one import line.
- **Item-command shared helpers (M5b R9).** `src/api/item-helpers.ts`
  — `COLUMN_VALUES_FRAGMENT` + `ITEM_FIELDS_FRAGMENT` (the
  GraphQL projection §6.2 + §6.3 surface across every item-shape
  query), `collectColumnHeads` + `titleMap` (per-board column
  heads + title-by-id map), `resolveMeFactory` (whoami-based `me`
  token resolver), `projectFromRaw` (parse + project with §6.3
  same-board title de-dup), `parseRawItem` (R18-wrapped raw item
  schema parser). Six consumers: `item get / list / find /
  search / subitems` + the dry-run engine + `item set`.
- **Cross-clause column resolution (M5b R12).**
  `resolveColumnsAcrossClauses` in `src/api/columns.ts` — batched
  variant of `resolveColumnWithRefresh` that takes pre-loaded
  metadata + N tokens + an optional refresh callback, returns N
  matches in input order with cache-miss-refresh-once semantics.
  Two consumers (`api/filters.ts` + `commands/item/search.ts`);
  M5b's bulk `--where` will be the third. The dry-run engine
  keeps its per-token `resolveColumnWithRefresh` loop because it
  loads metadata internally per-token (different shape).
- **Parse-boundary wrap helper (M5b R18).** `src/utils/parse-
  boundary.ts unwrapOrThrow` — single-line `safeParse + ApiError(
  internal_error, ..., { details: { issues } })` used at every
  parse boundary that consumes data from outside the compiled
  bundle. Live-fetch parses, agent-input parses, output-schema
  drift catches all funnel through this. Cache-read parses
  (board-metadata, user directory) intentionally don't — the
  surrounding cache-miss try/catch swallows them as misses
  (corrupt cache → re-fetch live, the established contract).
- **Mutation envelope (M5b).** `src/utils/output/envelope.ts
  buildMutation` — the §6.4 mutation result envelope shape with
  optional `side_effects` (for v0.3 dev shortcuts) + optional
  `resolved_ids` slot (cli-design §5.3 step 2 — token → resolved
  column ID echo). `emitMutation` (in `commands/emit.ts`) is the
  call-site helper with R18 outputSchema-drift wrap; M5b's `item
  set` is the first consumer. Adding `resolved_ids` is the M5b
  spec-gap candidate — cli-design §6.4's live sample doesn't show
  the slot; backfill alongside the M5b docs sweep.
- **Dry-run envelope (M5b).** `buildDryRun` in envelope.ts +
  `emitDryRun` in `commands/emit.ts`. The §6.4 dry-run shape
  (`data: null`, `meta.dry_run: true`, top-level
  `planned_changes: [...]`). JSON-only — the dry-run shape doesn't
  have a sensible non-JSON rendering. Item set passes the M5a
  `planChanges` result through `emitDryRun`; bulk paths in M5b's
  `item update --where` will pass an N-element array with the
  same shape.
- **Live mutation `validation_failed` → `column_archived` remap
  (M5b, Codex pass-1 F4 + M5b cleanup).**
  `maybeRemapValidationFailedToArchived` (in
  `src/api/resolver-error-fold.ts`) — when a live mutation fails
  with `validation_failed` AFTER cache-sourced resolution
  succeeded (cache said active), force a metadata refresh. If
  any of the translated column IDs is now archived, remap the
  error to `column_archived` so agents key off the stable code
  per cli-design §6.5. **Probes every translated column id**
  (M5b finding #3 — pre-fix probed only `translated[0]`, missing
  multi-column updates where a later target was archived).
  Single-column callers (`item set`, `item clear`) pass a
  one-element array; multi-column callers (`item update` single
  + bulk) pass every translated real column ID. First archived
  match in input order wins (deterministic). Live-sourced
  resolutions skip the remap (the live read already saw the
  archived flag). Resolver warnings (collision /
  stale_cache_refreshed) survive the remap via
  `error.details.resolver_warnings`. The remapped error carries
  `details.remapped_from: "validation_failed"` for triage.
- **Resolver-warning fold module (M5b R19 + M9.5 R26).**
  `src/api/resolver-error-fold.ts` — single source of truth for
  `foldResolverWarningsIntoError` + `mergeDetails` +
  `maybeRemapValidationFailedToArchived` + `foldAndRemap` (the
  M9.5 R26 wrapper composing fold + remap with the empty-
  columnIds short-circuit). Folds collision /
  `stale_cache_refreshed` warnings into a thrown
  `MondayCliError`'s `details.resolver_warnings` slot so a
  stale-cache-then-failure flow doesn't lose the refresh
  signal. Applies to every typed post-resolution failure:
  translator `UsageError`s, `ApiError(unsupported_column_type)` /
  `user_not_found`, mutation-time `validation_failed`. Two
  consumer patterns: translate-time catches (in
  `resolution-pass.ts` + `dry-run.ts`) call
  `foldResolverWarningsIntoError` directly — no remap probe.
  Post-mutation catches in the five mutation surfaces (`item
  set`, `item clear`, `item update` single + bulk, `item
  create`) call `foldAndRemap` once per site so the M9 P1
  pattern (create skipping the catch arm and surfacing
  `validation_failed` for archived columns) can't recur.
  `maybeRemapValidationFailedToArchived` only fires for
  cache-sourced resolutions; live-sourced skip the remap (the
  live read already saw the archived flag). Remapped errors
  carry `details.remapped_from: "validation_failed"`.
- **Item clear (M5b).** `src/commands/item/clear.ts` — dedicated
  per-column clear verb (single-item, single-column).
  `translateColumnClear` in `api/column-values.ts` returns the
  per-type clear payload: simple types (`text`, `long_text`,
  `numbers`) → `""`; rich types (`status`, `dropdown`, `date`,
  `people`) → `{}`. `planClear` in `api/dry-run.ts` builds the
  diff `to` side accordingly. Accepts implicit `--board` lookup
  via `ItemBoardLookup`. Archived column → `column_archived`.
  Item-on-wrong-board (only detected in dry-run) → `usage_error`
  with `item_board_id` + `requested_board_id` for self-correction.
- **Item update (M5b).** `src/commands/item/update.ts` — atomic
  multi-`--set` write with optional `--name`, plus the bulk
  `--where` / `--filter-json` path. Single-item shape uses
  `change_simple_column_value` / `change_column_value` (1
  target) or `change_multiple_column_values` (multi target,
  with `name` synthetically bundled as a column-id when
  `--name` is set — Monday's multi mutation accepts `name` as
  a key alongside real columns). Bulk shape requires
  `--board <bid>`, walks `items_page` cursor pagination,
  fails fast on stale cursor, and gates without `--yes` /
  `--dry-run` with `confirmation_required` carrying
  `matched_count` + `where_clauses` (or `filter_json`) +
  `board_id` in details. Bulk live: per-item mutation is
  sequential (cli-design §9.3); per-item failure decorates
  the error envelope with `applied_count` / `applied_to`
  (mutated items before failure) / `failed_at_item` /
  `matched_count` so agents can reconstruct partial progress.
  Bulk dry-run: per-item `planChanges` results aggregate into
  one N-element `planned_changes`; warnings dedupe by
  `code+message+token` so collision warnings don't spam the
  envelope. F3 (Codex pass-1): bulk per-item failures run the
  F4 `validation_failed` → `column_archived` remap too. M5b
  cleanup widened the probe to every translated column id, so a
  bulk multi-column update where a later target was archived
  still surfaces `column_archived` (pre-fix only the first
  translated column was checked). Bulk envelope source
  aggregation (Codex pass-2): merges metadata + column-resolution
  + walk + mutation legs per cli-design §6.1 — cache-served
  metadata + live wire calls correctly surfaces as
  `meta.source: 'mixed'`.
- **Update create (M5b).** `src/commands/update/create.ts` —
  posts a comment (Monday "update") on an item via
  `create_update`. Body sources: `--body <md>` inline,
  `--body-file <path>`, or `--body-file -` for stdin.
  Mutually exclusive with each other. Inline whitespace-only
  bodies rejected post-trim (`usage_error`); empty file or
  empty stdin same. Markdown is passed verbatim — Monday
  renders to HTML; the rendering risk is documented in
  cli-design §6. **`--dry-run` supported despite
  non-idempotent**: the dry-run shape diverges from
  column-mutation shape (no `board_id`, no `resolved_ids`,
  no `diff` — instead `operation: "create_update"` +
  `body` + `body_length`). Dry-run `meta.source: "none"`
  because no API call fires. `idempotent: false` in the
  CommandModule since re-running creates a duplicate
  comment.
- **Process exitCode drain (M5b session 2).**
  `src/cli/index.ts` uses `process.exitCode = N` rather than
  `process.exit(N)` so stdout drains naturally before the
  event loop terminates. Pre-fix, `process.exit` could
  truncate stdout on slow consumers when the payload exceeded
  ~64KB (the `monday schema --json` output passed this
  threshold during M5b). Pre-existing bug masked by smaller
  M0–M4 payloads; M5b's schema growth surfaced it.

## Workflow Rules

- **Auto-test:** run `npm run typecheck && npm run lint && npm test` after
  any change. Failing gates block the change.
- **Auto-document:** when adding a command, also update
  `docs/cli-design.md` (§4.3 command tree + any contract changes) and
  this CLAUDE.md's "Contract at a glance" if a binding decision moved.
  `docs/api-reference.md` is supplementary cheat-sheet material — not
  a contract — but keep it in sync if you touch the underlying
  Monday concept.
- **Two-AI review for non-trivial design decisions AND per-milestone
  implementation passes.** We use Codex (gpt-5.5) as a second reviewer
  via `codex exec -m gpt-5.5 -s read-only - < .review-prompt.md >
  .review-output.md` with a prompt explaining what to evaluate.
  `.review-*.md` is gitignored; the resulting design / fix-up changes
  go in normal commits. Two distinct triggers:
  - **Design changes** to `docs/cli-design.md` or `docs/v0.1-plan.md`
    get reviewed before merge. See `docs/cli-design.md` history
    (commits `ee3f288`, `5218ca0`) for worked examples.
  - **Implementation milestones** (M0, M1, … in `docs/v0.1-plan.md`)
    get reviewed *before declaring the milestone done*. The M0 review
    (post-mortem note in `v0.1-plan.md` §11) caught ten bugs the
    coder missed — including a token-leak path, SIGINT not actually
    aborting, schema/commander drift, and contract drift around
    `meta.complexity` and the NDJSON trailer. **Don't skip this**;
    the cost of one Codex run is far less than the cost of fixing
    those bugs after M(N+1) builds on top.
  Ask before adding new AI collaborators.
- **Atomic, incremental commits.** Each commit is one self-contained
  unit of progress — small enough to revert cleanly, large enough to
  stand alone (e.g. one command + its tests + its doc update). Don't
  bundle unrelated changes; don't split a coherent change. Never
  commit broken `main`.
- **Commit messages explain WHY and HOW, not WHAT.** A reader of the
  diff already sees what changed; pretty self-documenting code makes
  that obvious. Spend the message on:
  - *Why* — the motivation, the constraint, the user-facing reason.
  - *How* — the approach, the trade-off, the rejected alternative.
  If there's no meaningful why/how to add, the conventional-commit
  subject line alone is fine — better short than padded with
  "added X, removed Y" prose. See `git log --grep='Why:'` for shape.
- **Conventional Commits + SemVer.** Subject: `feat:` / `fix:` /
  `docs:` / `refactor:` / `test:` / `chore:`. Major bump for breaking
  output/exit-code changes, minor for new commands, patch for bug
  fixes.
- **CI gates everything.** `.github/workflows/ci.yml` runs typecheck +
  lint + test (with coverage threshold) + build smoke-test on Node 22
  and 24. Don't merge red.
- **No `any`, no `null`-by-default, validate every boundary.** See
  `validation.md`. Heavy validation is a feature — Nick has explicitly
  endorsed this.

## Monday API Notes

> The full picture is `cli-design.md` §2. Headlines for orientation:

- **Endpoint:** `https://api.monday.com/v2` (GraphQL, POST).
- **Auth:** `Authorization: <api_token>` header (no `Bearer ` prefix).
  Tokens from the user's Monday admin panel; guests can't mint one.
  CLI loads `MONDAY_API_TOKEN` from env or `.env`.
- **API version PINNED to `2026-01`.** Matches the
  `CURRENT_VERSION` exported by `@mondaydotcomorg/api@14.0.0`
  (verifiable in `node_modules/.../constants/index.d.ts`). Sent on
  every request via the `API-Version` header. Override per-request
  with `--api-version` or per-environment with `MONDAY_API_VERSION`.
  Bumping the pin requires bumping the SDK and is a SemVer-minor (or
  major if output schema changes).
- **SDK ↔ API drift.** The SDK's typed surface lags Monday's actual
  schema. SDK 14.0.0 types `2026-01` but doesn't expose
  `BatteryValue` (status rollups), `hierarchy_type`, `is_leaf`,
  `capabilities` — those need raw GraphQL via `client.request<T>()`
  in `src/api/` (see `cli-design.md` §2.8 / §2.9).
- **Boundary-typing trap.** SDK exports
  `QueryVariables = Record<string, any>`. The `src/api/` wrapper must
  wrap this so `any` doesn't leak into `commands/*` — internal code
  sees `Record<string, unknown>` (or named GraphQL input types) and
  parses at the boundary.
- **Pagination:** `items_page(limit ≤500, cursor)` →
  `next_items_page(cursor)`. **60-minute cursor lifetime from the
  initial call.** Stale cursor returns `stale_cursor` error — never
  silently re-issued. The flat `items` query is deprecated.
- **Rate limits and error codes** — six distinct limits
  (per-minute, complexity, daily, concurrency, IP, locked-resource).
  All carry `retry_in_seconds` (or HTTP `Retry-After`). Mapped to
  CLI `error.code` values listed in `cli-design.md` §2.5 / §6.5.

## References

- Monday API reference: https://developer.monday.com/api-reference/
- Official Node SDK: https://github.com/mondaycom/monday-graphql-api
  (`@mondaydotcomorg/api` on npm, **pinned to 14.0.0**).
- API changelog: https://developer.monday.com/api-reference/changelog
