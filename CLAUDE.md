# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.3-M25 pre-flight closed; M25 implementation unblocked.**
v0.2.0 published to npm 2026-05-08. v0.3 is in progress on
`main`; M0–M24 closed + M25 pre-flight closed.
**M25 pre-flight contract diff landed at `d5839a9`**
(partial-success-bulk module signatures + cli-design §6.4 new
"Bulk per-item partial-success" sub-section + Decision 6 close
+ `--continue-on-error` argv extension; runtime body under
`c8 ignore start/stop` stubs awaiting M25 impl). Preceded by
`85b93e8` (R-class cleanup bundle — R-NEW-25 + R-NEW-17
template fold-ins + R-NEW-27 `isPlainObject` consolidation; 6
sites migrated). Codex pre-flight review ran 2 rounds: round 1
surfaced 1 P1 (foldAndRemap context-thread requirement) + 1 P2
(empty-match contract drift) + 3 P3 — fixed at `832a169`; round
2 surfaced 1 P2 (empty-match still drifted) + 3 P3 — fixed at
`67df582`. R-NEW-25 "findings up front" directive validated for
the 5th + 6th time (pre-flight × 2 + the 4 M24 rounds);
R-NEW-17 W1 redactor-pattern audit returned "nothing flagged"
across both rounds against M25's new detail-key surface.
**M24 implementation landed at `d058172`** (item history
runtime walker + per-event projectors + action body); Codex
impl review round 1 surfaced 1 P1 + 2 P2 (all out-of-band /
W4); all three fixed at `5f10cda`. M23 implementation landed at
`1f09a25` (cross-board `item search` + `board favorites`
runtime bodies — `fetchBoardFavorites` 2-stage resolver,
`crossBoardSearch` per-board fan-out walker, cross-board action
with column-resolution pre-pass + SourceAggregator merge +
union-schema emit). M22 implementation (`3a1b465`) lands the
runtime DNS / TCP / TLS / auth / cache / redaction / env-var
probes for `monday status` + the `platform_api.daily_*`
projection for `monday usage`. Decision 6
(`--continue-on-error` naming) closed at the M25 pre-flight
contract diff `d5839a9` — positive form; cli-design §4.3 bulk
`item update` row + new §6.4 sub-section pin the flag +
envelope shape. Decision 2 (item-history `kind` taxonomy)
closed at the post-M23 M24-prep session via the local
`scripts/probe/m24-history-kinds.ts` empirical probe. Full
findings in v0.3-plan §8.

Per-milestone narratives, post-mortems, and R-class history live
in the plan docs — **do not duplicate them here**:
- `docs/v0.3-plan.md` §11 M19, §12 M20, §13 M21, §14 M22, §15 M23,
  §16 M24 post-mortems + §22 R-class backlog (R-NEW-1 + R-NEW-4 +
  R-NEW-5 + R-NEW-6 + R-NEW-7 + R-NEW-14/15/16 + R-NEW-17 +
  R-NEW-19 + R-NEW-21 + R-NEW-25 + R-NEW-27 shipped +
  R-NEW-2 / R-NEW-3 candidates open + R-watch-items including
  R-NEW-26).
- `docs/v0.2-plan.md` §3 + §X post-mortems for M8–M18 + §22 for
  R20–R53.
- `docs/v0.1-plan.md` for M0–M7 + M2.5 refactor pass.

**Live numbers (post-M25 pre-flight):**
- Test count: **2969** across 124 files (unchanged from M24
  close; pre-flight added no test files — runtime tests land
  at M25 impl per the M24 `d058172` precedent). 1 skipped
  unchanged (auth-probe real-network placeholder).
- Coverage: **99.11 / 96.15 / 99.33 / 99.30** (stmts / branches /
  fns / lines), at the **95 / 95.45 / 95 / 95** floor.
  **Branches margin shifted 0.55pp → 0.70pp** through M25
  pre-flight — R-NEW-27's `isPlainObject` consolidation
  removed 5 duplicate branch sites (each of the 6 migrated
  sites had a 3-way condition; consolidating to one lifted
  helper drops the denominator) while the partial-success-
  bulk stub adds no branches under `c8 ignore` wraps. Three
  deferred file-level gaps still: `item/search.ts` 88.23%,
  `errors.ts` ~95.37%, `dry-run.ts` 96.26% — same set as
  pre-M24 (genuinely defensive or requires new cross-board
  integration test); `errors.ts` improved slightly via the
  R-NEW-27 lift removing one site.
- ERROR_CODES count: **29** (unchanged across M25 pre-flight
  per Decision 6 closure — per-item failures under
  `--continue-on-error` route through existing codes;
  `cli-design §6.4` "Bulk per-item partial-success" adds no
  new registry entries).
  Command count: **78** (unchanged — `--continue-on-error`
  is a flag on the existing `monday item update --where`
  verb, not a new command).
- Floor never lowered without an inline `vitest.config.ts`
  rationale comment.

**Pre-publish blocker (carried to v0.3.0 release prep):**
`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` placeholders in
`src/api/oauth.ts` ship as `<UNREGISTERED_PENDING_OAUTH_APP>`.
One-time external step: register a Monday OAuth app at
https://developer.monday.com/apps with redirect URI exactly
`http://127.0.0.1:9876/callback`, then swap the constants. Until
then production users hit `oauth_failed.code_exchange_failed`.
Tests don't depend on the values (cassettes intercept
`/oauth2/token`). Pinned in source per the public-OAuth-client
convention.

**Next session — likely scope:**
1. **M25 implementation — fill the runtime body for
   `runPartialSuccessBulkUpdate` + wire the per-item dispatch
   loop.** Pre-flight pinned the contract surface at `d5839a9`
   (cli-design §6.4 "Bulk per-item partial-success" + new
   `src/api/partial-success-bulk.ts` module signatures + the
   `--continue-on-error` argv extension under `c8 ignore`
   block-wraps). M25 impl swaps the stub `Promise.reject` body
   in `runPartialSuccessBulkUpdate` for the runtime loop:
   `dispatchSequential` over `matchedItemIds` with id-field
   `'item_id'`; per-item dispatch callback fires
   `executeMutation` + `foldAndRemap` (with the threaded
   `resolverWarnings` / `remapColumnIds` / `env` / `noCache` /
   `resolutionSource` context — Codex round-1 P1-1 contract
   requirement) BEFORE throwing into `dispatchSequential`;
   ProjectedItem side-map fold on success; the action body's
   `c8 ignore start/stop` wrap drops at impl (the partial-
   success branch becomes live). Test matrix +30-50 (mirror
   M22/M23/M24 impl cadence) — unit tests for
   `foldPartialSuccessBulkResult` + `buildPartialSuccessBulkSummary`
   pure helpers (currently exported as REAL implementations
   awaiting coverage), `partial-success-bulk.ts` integration
   tests driving the wrapper via mocked `client.raw` with
   per-item routing predicates (mirror M15's pattern at
   `tests/unit/api/users-fan-out-mutation.test.ts`),
   command-level integration tests at
   `tests/integration/commands/item-update-bulk.test.ts`
   exercising the empty-match no-op + dispatch-with-mixed-
   success-and-failure paths. Codex impl review × 1-2
   rounds. **Decision 6 (`--continue-on-error` naming)
   already closed at `d5839a9`** — pre-flight pinned the
   contract; impl doesn't reopen.
2. **Branches-margin deferred residuals.** Three files carry
   the remaining out-of-coverage residual: `item/search.ts`
   88.23% — needs a new cross-board integration test driving
   `--where Owner=me` to cover buildPerBoardPlan's me-
   resolution helper (lines 546-549) + the same-column-twice
   push branch (line 575); `errors.ts` 95.37% — defensive
   lines (272 message fallback, 319 status<400, 365
   path-present) — could be c8-ignored OR covered with
   targeted unit tests; `dry-run.ts` 96.26% — defensive
   `env === undefined ? {}` spreads. Each is a small bounded
   follow-up if a future session needs more margin (margin
   at 0.70pp post-M25-pre-flight, comfortable surplus).
3. **`monday usage` timezone semantics verification** — M22
   shipped with UTC `YYYY-MM-DD` as the `today` key derived from
   `ctx.clock().toISOString().slice(0, 10)`. The pre-flight probe
   captured an empty `by_day` list so the timezone pin remains
   inferred from the sibling `last_updated`'s `ISO8601DateTime`
   scalar. Re-probe `scripts/probe/m22-usage-by-day.ts` against an
   account with live usage activity. If Monday's runtime `day`
   field turns out to be account-local, amend cli-design §11.5.3
   + flip `formatTodayKey` in `src/commands/usage.ts`.
4. **Pre-publish blocker still open** — OAUTH_CLIENT_ID /
   OAUTH_CLIENT_SECRET constants in `src/api/oauth.ts` still ship
   as `<UNREGISTERED_PENDING_OAUTH_APP>`. Externally-blocked on
   registering a Monday OAuth app; tests don't depend on the
   values. Tracked for v0.3.0 release prep (after M28).

**R-class state (post-M25 pre-flight)**
(full detail in `docs/v0.3-plan.md` §22):
- **Shipped:** R-NEW-1 `isENOENT` lift into `src/utils/fs.ts`
  (`1c77699`, M21 close); R-NEW-4 `statusOutputSchema` +
  `probeResultSchema` import-from-api/probes lift (`0b5af57`,
  post-M22 pre-flight drift sweep); R-NEW-6 Codex pre-flight
  review prompt template lift to
  `.claude/templates/codex-pre-flight-review.md` (`9b0ee78`,
  post-M23 pre-flight round 1 — 3-consumer trigger fired after
  M21+M22+M23 all used the same 7-section prompt structure);
  R-NEW-7 `formatMode` lift into `src/utils/fs.ts`
  (post-M22 close); **R-NEW-14 `errorMessage` + R-NEW-15
  `asError` + R-NEW-16 `errorCode` lifts** into
  `src/utils/errors.ts` (`5a7c88d`, post-M23 audit) — 17 inline
  duplicates consolidated across 13 files; trigger fired at M6
  (R-NEW-14) / M21 close (R-NEW-15) / M22 (R-NEW-16) but went
  unnoticed for 5-12 days across many milestones; the M22
  developer wrote LOCAL copies in `src/api/probes.ts` instead
  of finding the inline sites — the smoking gun that exposed
  the missed triggers at the user-prompted post-M23 audit
  ("are there any refactors not done which should have
  triggered earlier?"). Branches margin recovered 0.04pp →
  0.41pp from the consolidation (net positive on coverage +
  clarity). R-NEW-1 `isENOENT` was refactored on top of
  R-NEW-16's `errorCode` (8 lines → 2 lines; identical
  behaviour). **R-NEW-5 `introspectType()` helper** lifted
  into `scripts/probe/_lib.ts` (post-M23 focused-refactor
  session) — 9+ consumers across M22's 4 probe scripts +
  M23 pre-flight's 5; richest-superset selection set so
  future M24+M25+M26+M27+M28 pre-flights can introspect
  any type kind (OBJECT/ENUM/UNION/INTERFACE/SCALAR) from
  one call; no test obligation since `scripts/probe/_lib
  .ts` is outside the `src/**/*.ts` coverage scope. The
  originally-floated branches-margin recovery never
  materialised (scope discovery — record this for future
  R-class candidates with similar out-of-coverage scope).
  **R-NEW-21 `trialQuery()` + `ProbeRawErrors` lift**
  into `scripts/probe/_lib.ts` (`fa07fb4`, post-R-NEW-5
  audit session) — 4 M23 trial-query probes
  (`m23-favorites.ts`, `m23-favorites-deep.ts`,
  `m23-hierarchy-{item,object}.ts`) converged on the
  same `trialQuery(label, query)` + local `RawErrors`
  shape with truncate-length variations (400/600/800).
  Lift uses `options?: { echoQuery?, truncateBody? }`
  with defaults matching the two most-common settings;
  interface renamed `RawErrors` → `ProbeRawErrors` to
  match the existing `RawHttpResponse` namespace. Two
  cosmetic deltas in probe output accepted as part of
  the lift (`[OK] data: <body>` → `[OK] <body>`; echo
  unified on the `query:` prefix). Same out-of-coverage
  scope as R-NEW-5 — no branches-margin movement; the
  M24 pre-flight kickoff's branches recovery still falls
  to targeted seam tests on `cross-board-search.ts`.
- **Open candidates:** R-NEW-2 `credentialsHomeOptions`
  (fires at `monday auth status`, v0.3.x); R-NEW-3
  `wrapFsError` factory (M22 + M23 + M24-pre-flight did
  NOT trigger); R-NEW-8 `missingByDifference` set-delta
  helper (2 consumers; fires at 3); R-NEW-9 2-stage
  GraphQL filter+hydrate resolver shape — **STAYS AT 2
  consumers** (M22 usage + M23 favorites); M24 `item
  history` shipped as 2-SOURCE MERGE not filter+hydrate
  (Decision 2 closure ratified the shape; M24-prep
  empirical-probe ran first), so the M24-planned third
  consumer never materialised. Watch-item active at M27
  (webhook source set might be filter+hydrate-shaped).
- **R-watch-items:** `vi.stubGlobal('fetch')` boundary mock
  pattern (still single-consumer in production probe scripts);
  Post-OAuth fresh-transport pattern (single-consumer);
  `c8 ignore` vs v8 branch-coverage friction (tooling — M23
  pre-flight recovered branches margin to 0.04pp; tight);
  **filesystem-state probes** for non-ENOENT fs-error
  branches (test-pattern; EISDIR-via-dir-at-path probe
  ratified at `7058754`); **empirical-probe-step
  -in-pre-flight** — fired FOUR TIMES (M21 OAuth `5c07840`,
  M22 `platform_api.daily_*` reshape `fbab6b0`, M23 cross-board
  + favorites `3a2f1db`+`1fefdb1`, M24-prep history kinds
  `a1f3025` closing Decision 2), discipline ratified as
  always-run-for-novel-API-surface pre-flights; **mockable-
  seam pattern in probes** — ratified at M22 via per-probe
  injection slots, carries to any future probe-style surface
  (webhooks M27 candidate); **R-NEW-10 stable warning-builder
  factory** — 6 sites today (buildCapWarning,
  buildNoncanonicalWarning, buildInaccessibleBoardsWarning,
  buildColumnNotFoundOnBoardWarning,
  buildCrossBoardTruncatedWarning, buildStaleFavoritesWarning);
  inner-details shapes differ enough that lifting now would
  be over-engineering — LOW priority watch-item; fires only
  if 3+ builders converge on identical inner-details shapes;
  **R-NEW-11 pre-flight stub factory** — 15+ sites across
  M19-M23 pre-flights but each stub's surface-specific hint
  is the load-bearing payload; LOW priority watch-item;
  **R-NEW-12 structured `params` through error envelope** —
  `parse-argv.ts:summariseIssues` now preserves
  `ZodIssue.params` (M23 round-2 P2-3); LOW priority
  watch-item; fires when a 2nd + 3rd `.superRefine` rule
  wants to surface structured per-issue context; **R-NEW-13
  command-output union-schema pattern** — M23 round-2 P1-1
  introduced `z.union([itemSearchOutputSchema,
  crossBoardSearchOutputSchema])`; LOW priority watch-item;
  fires when M25/M27/M28 cross-cutting extensions need the
  same union shape; **R-NEW-17 redactor-pattern check at
  pre-flight** — **Shipped: `85b93e8`** (M25 pre-flight
  kickoff cleanup bundle). Surfaced at M23 impl
  (`column_token` rename; v0.3-plan §15 contract drift
  finding); applied per-prompt AT M24 pre-flight + impl
  Codex reviews (4 rounds clean), then folded into
  `.claude/templates/codex-pre-flight-review.md` as the
  template-stable W1 audit-point at the M25 pre-flight
  kickoff. M25 pre-flight rounds 1+2 returned "W1: nothing
  flagged" against the new partial-success-bulk detail-key
  surfaces, validating the template-stable form;
  **R-NEW-18 sequential
  per-board fan-out builder** — surfaced at M23 impl
  (`crossBoardSearch` walker); LOW priority watch-item. M24
  `item history` shipped as CHRONOLOGICAL MERGE
  (`mergeByCreatedAt` over fully-drained lists), NOT
  sequential per-board fan-out, so the watch-item stays at
  1 consumer. Fires at M27 webhook fan-out if it duplicates
  the M23 shape;
  **R-NEW-19 migrate manual `safeParse → ApiError` sites to
  `unwrapOrThrow`** — **Shipped: `f4e8e1e`** (post-M23 audit);
  5 sites across M21+M22+M23 (oauth + login + usage + favorites
  Stage 1 + Stage 2 + cross-board walker) migrated to the R18
  helper that already existed in `src/utils/parse-boundary.ts`
  (same pattern miss + mass-migrate cadence as R-NEW-14/15/16);
  **R-NEW-20 `MondayClient` seam-injection stub factory** —
  **3 consumers at M24 impl** (board-favorites +
  cross-board-search + item-history-projection unit tests; 3rd
  consumer landed at `tests/unit/api/item-history-projection
  .test.ts:553` in `d058172`). Lift decision: keep stub factory
  inline this session — the three sites share the seam pattern
  (mock `client.raw` only) but each carries different routing
  logic (favorites by `operationName`, cross-board by `boardId`
  variable, item-history by `operationName`). Lifting now would
  force a parametrised factory that doesn't meaningfully reduce
  duplication; the shared shape is the contract surface, not
  the routing logic. **Status: 3-consumer trigger fired but
  lift deferred with rationale.** Re-evaluate at 4th consumer
  (M27 webhooks candidate);
  **R-NEW-22 probe-script `main().catch()` runner** —
  surfaced at post-R-NEW-5 audit (`fb77baf`); 14+
  consumers but each instance is 3 trivial defensive lines
  + the duplication reads as "always-defensive
  boilerplate", not meaningful repetition; LOW priority
  watch-item, fold into R-NEW-21's commit ONLY if that
  commit is already touching every probe script (it's
  not — R-NEW-21 only touches 4 trial-query probes);
  **R-NEW-23 two-source chronological merge projector**
  — surfaced at M24 pre-flight (`bad98ba`,
  `mergeByCreatedAt` in `src/api/item-history-projection.ts`);
  M24 impl (`d058172`) kept the helper inline (single
  consumer); LOW priority watch-item, fires at 2nd consumer
  (likely M27 webhooks if account-scoped + board-scoped
  surfaces need a merged stream); **R-NEW-24
  schema field-name drift (wire ↔ CLI) documentation
  pattern** — 3 sites today: M22 `daily_limit` /
  `platform_api.daily_limit`, M23 column-tokens /
  `column_id`, M24 `kind` / `event`. Each is ad-hoc in its
  module docstring; not a code lift. LOW priority watch-
  item; if a 4th site appears at M25-M28, consider
  lifting to a shared `## Field-name mapping conventions`
  section in `docs/architecture.md` or `docs/cli-design.md`;
  **R-NEW-25 R-NEW-6 template extension — "findings up
  front" instruction** — **Shipped: `85b93e8`** (M25
  pre-flight kickoff cleanup bundle). M23 impl-review
  truncation lesson (v0.3-plan §15) drove a custom "deliver
  findings up front, not after exhaustive exploration"
  instruction on M24 pre-flight + impl review Codex prompts;
  all four M24 rounds (pre-flight × 2 + impl × 2) returned
  numbered findings cleanly without truncation. Folded into
  `.claude/templates/codex-pre-flight-review.md` as a
  top-of-file template-stable preamble at M25 pre-flight
  kickoff. M25 rounds 1+2 confirmed the directive worked
  template-side (rounds delivered numbered findings up
  front despite the substantive diff), bringing the
  validated-rounds count to 6;
  **R-NEW-26 defensive abort-listener race guard in async
  test promises** — surfaced post-M24 impl (`4c83860`): three
  tests in `tests/unit/cli/run.test.ts` flaked under full
  coverage parallelism because the test's
  `setTimeout(abort, 10ms)` could fire BEFORE the action's
  promise constructor registered its `addEventListener
  ('abort', ...)`. Node's AbortSignal does NOT replay 'abort'
  for listeners attached after the event dispatched, so the
  listener silently waited for an abort that already happened.
  Fix: sync `if (signal.aborted) reject(...)` check before
  listener registration. All three sites in run.test.ts now
  carry the guard; LOW priority watch-item. Fires at next
  async-abort-handling test site OR if the pattern repeats
  enough to warrant a `buildAbortablePromise(signal,
  onAbort)` helper in `tests/_helpers/`. The pattern lives
  next to `.claude/rules/testing.md`'s
  `c8 ignore start/stop` block-wrap discussion — the
  race-window guards mentioned there are the production-side
  analogue (`src/commands/auth/login.ts:fetchAccountId`'s
  guards on the OAuth listener). Document the pattern at
  v0.3-plan §22 R-NEW-26 entry for future-session
  prophylactic application;
  **R-NEW-27 `isPlainObject` consolidation** —
  **Shipped: `85b93e8`** (M25 pre-flight kickoff cleanup
  bundle). Surfaced at post-M24 close-docs audit (6 sites:
  4 production + 2 test; all structurally identical
  `typeof === 'object' && !== null && !Array.isArray(...)`
  type-guards — same pattern miss + mass-migrate cadence as
  R-NEW-14/15/16). Lifted to `src/utils/json.ts` (new
  module) exporting one helper narrowing `unknown` to
  `Readonly<Record<string, unknown>>`. All 6 sites migrated
  (`src/commands/run-by-id-lookup.ts`,
  `src/commands/board/column-create.ts`, `src/api/errors.ts`,
  `src/api/item-history-projection.ts`,
  `tests/fixtures/load.ts`, `tests/e2e/fixture-server.ts`);
  the 2 test sites that previously used the shorter form
  (no `!Array.isArray(v)` clause) widened to the stricter
  form — behaviour-neutral in practice (analysis at v0.3-plan
  §22 R-NEW-27 entry). Branches margin recovered 0.55pp →
  0.70pp through this consolidation (5 duplicate branch sites
  removed; lifted helper has no `c8 ignore` wrap and contributes
  one branch).

## Pre-flight contract diff discipline

Every milestone whose pre-flight contract surface introduces new
modules / commands / ERROR_CODES / cli-design sections runs
through:

1. **Empirical probe** for any novel API surface (§22
   R-watch-item — fired first at M21 OAuth, scripts under
   `scripts/probe/` reuses `_lib.ts`).
2. **Pre-flight contract diff commit** lands module signatures
   (stub bodies under `c8 ignore`) + ERROR_CODES widening +
   cli-design extension + cross-doc count bumps + the
   milestone-specific decisions list.
3. **Codex pre-flight review** (1-2 rounds) before any feat
   commit.
4. **Implementation commits** swap stubs for runtime bodies; new
   contract widenings are surface-only.
5. **Codex implementation review** (1-2 rounds) before declaring
   done.
6. **Close-docs sweep** (post-mortem in `v0.3-plan.md` §X +
   `§9` preconditions tick + `§22` R-class log + cli-design SHA
   backfills + this file's status flip).

This document is for the **current live state + non-obvious
discipline pointers**. For shipped milestone detail, read the
plan-doc post-mortems.

The three binding documents — read in this order before writing code:

1. **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical
   contract: command surface, output envelope, 29 stable error codes,
   deferral list, every binding decision. Changes land via PRs that
   argue for the change, not by drift.
2. **[`docs/v0.3-plan.md`](./docs/v0.3-plan.md)** — active plan:
   milestones M19–M28 with deliverables, exit criteria, decisions log,
   per-milestone post-mortems land at milestone close.
3. **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** — shipped foundations
   M8–M18 with per-milestone post-mortems (M8/M9/M10/M11/M12 +
   M13–M18 + R-class refactor backlogs R20–R53). Reference for
   patterns v0.3 milestones build on.
4. **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** — shipped foundations
   M0–M7 with M2.5 refactor pass and the M5a/M5b split. Reference for
   the foundational patterns every later milestone builds on.

Supplementary: [`docs/output-shapes.md`](./docs/output-shapes.md)
(snapshot-backed per-command `data` reference);
[`docs/architecture.md`](./docs/architecture.md) (internal module
structure); [`docs/api-reference.md`](./docs/api-reference.md) (Monday
concepts cheat sheet — *not* contract).

## Commands

```bash
npm install
npm run dev -- <args>          # tsx-based dev runner (no build step)
npm run build && npm start -- <args>

# Quality gates — run all three before committing
npm run typecheck
npm run lint
npm test                       # add :unit / :integration / :e2e / :coverage / :watch as needed
```

## Directory layout

```
src/
  cli/         # Commander entry, runner, signal/abort plumbing
  commands/    # One file per CLI subcommand (thin — delegates to api/)
  api/         # Monday API wrapper around @mondaydotcomorg/api
  config/      # Env/file config + zod validation
  types/       # Shared types (incl. branded IDs)
  utils/       # Logger, output formatters, error helpers, redaction
tests/         # unit / integration / e2e / fixtures
docs/          # see "Status"; cli-design.md is the contract
.claude/rules/ # path-scoped agent rules — see "Conventions"
```

## Conventions

The full coding standard lives in `.claude/rules/` — files auto-load
when editing matching paths:

| File | Loads when editing | Topic |
|------|--------------------|-------|
| `typescript.md` | `src/**`, `tests/**` | TS strictness, no-`any`, no-`null`-by-default |
| `testing.md` | `tests/**` | Coverage standard, test layers, mocking rules |
| `validation.md` | `src/**`, `tests/**` | zod patterns — branded IDs, parse-at-boundary |
| `security.md` | source + `.env*` | Token handling, redaction, fail-secure config |
| `cli.md` | `src/cli/**`, `src/commands/**` | Output discipline, exit codes, signals, stdin |

Headlines (full detail in the rule files):

- **Strictest TypeScript settings.** No `any` (lint enforced). Avoid
  `null` unless distinct from `undefined`.
- **Tests cover every branch.** Coverage floor 95% / 95% / 95% / 94%
  (lines / fns / stmts / branches). Raise it; never lower it.
- **Mock at the network boundary** (stub `fetch`/`undici` or SDK
  `request`), never `commands/*` helpers.
- **ESM with `.js` import specifiers** (NodeNext requirement).
- **One subcommand per file** in `src/commands/`, exported as
  `CommandModule`, registered in `cli/index.ts`.

## Contract headlines

These are the binding rules most likely to bite if forgotten. Full
reasoning (and per-subsystem implementation detail) lives in
`docs/cli-design.md` at the linked section.

- **Primary user is AI agents; humans are second-class** — when they
  conflict, agent ergonomics win. (§1)
- **Output:** table on TTY, JSON when piped; `--json` is the explicit
  alias. Tables truncate; JSON never does. (§3.1, §3.2)
- **Universal envelope** on every command. Success
  `{ok, data, meta, warnings}`; failure `{ok: false, error, meta}`.
  `meta` always carries `schema_version`, `api_version`, `request_id`,
  `source: "live"|"cache"|"mixed"|"none"`, `cache_age_seconds`,
  `retrieved_at`. Adding fields is non-breaking; removing/renaming is
  major. (§6.1)
- **29 stable error codes** (`usage_error` / `not_found` /
  `ambiguous_column` / `ambiguous_match` / `column_archived` /
  `unsupported_column_type` / `rate_limited` / `complexity_exceeded` /
  `stale_cursor` / `tag_not_found` / `oauth_failed` / etc. —
  `ambiguous_match` joined the registry at M12; `tag_not_found`
  joined as a v0.3-M19 prerequisite ahead of the `tags` friendly
  translator; `oauth_failed` joined at the v0.3-M21 pre-flight
  contract diff as the `monday auth login` umbrella per cli-design
  §7.3.3, with `details.reason` discriminating per failure mode).
  Errors carry `code`, `message`, `http_status`, `monday_code`,
  `request_id`, `retryable`, `retry_after_seconds`. Agents key off
  `code`, never English. (§6.5)
- **Exit codes:** 0 success, 1 usage / `confirmation_required`,
  2 API/network, 3 config, 130 SIGINT.
- **No interactive prompts ever.** Destructive ops without `--yes`
  return `confirmation_required`. (§3.1)
- **Two-level command depth** (`monday <noun> <verb>`); two carve-outs
  at three levels — `dev` namespace (workflow shortcuts; carve-out 1)
  and `item time-track <verb>` (verb-shaped column-type extensions;
  carve-out 2). (§5.2)
- **Cursor pagination expires at 60 min — fail fast with
  `stale_cursor`, never silently re-issue.** (§5.6)
- **Column-value abstraction** is what makes `--set` work. Writable
  allowlist after M8: `text`, `long_text`, `numbers`, `status`,
  `dropdown`, `date`, `people`, `link`, `email`, `phone`. Other types
  → `unsupported_column_type` with category-specific hints; the
  `--set-raw <col>=<json>` escape hatch covers `change_column_value`-
  shaped types (M8). (§5.3)
- **`board describe` ships `example_set` per writable column** so an
  agent can construct `--set` calls from one read. (M3 exit criterion)

For per-subsystem detail (column-types module, dry-run engine, item
create/move/archive/delete/duplicate semantics, resolver-warning fold,
mutation envelope shape, pagination walkers, filter DSL, etc.) read the
relevant cli-design.md section and the milestone post-mortems in
v0.1-plan.md / v0.2-plan.md. **Don't restate them here.**

## Workflow rules

- **Auto-test:** `npm run typecheck && npm run lint && npm test` after
  any change. Failing gates block.
- **Auto-document:** new commands → update `docs/cli-design.md` §4.3
  + any contract changes. Update *this file's* "Contract headlines"
  only if a binding decision moved.
- **Two-AI review** for non-trivial design decisions AND per-milestone
  implementation passes. Codex (gpt-5.5) via
  `codex exec -m gpt-5.5 -s read-only - < .review-prompt.md > .review-output.md`
  (`.review-*.md` is gitignored). Two triggers:
  - Design changes to `docs/cli-design.md` or `docs/v0.x-plan.md` →
    reviewed before merge.
  - Implementation milestones → reviewed before declaring done. The M0
    review caught 10 bugs (token leak, broken SIGINT, schema/commander
    drift); skipping costs more than the Codex run. Ask before adding
    new AI collaborators.
- **Atomic, incremental commits.** One self-contained unit per commit:
  small enough to revert cleanly, large enough to stand alone. Never
  commit broken `main`.
- **Commit messages explain WHY and HOW, not WHAT.** Diff shows what.
  Spend the message on motivation and approach. Bare conventional-commit
  subject is fine when there's no meaningful why/how — better short than
  padded with "added X, removed Y" prose.
- **Conventional Commits + SemVer.** `feat:` / `fix:` / `docs:` /
  `refactor:` / `test:` / `chore:`. Major bump for breaking
  output/exit-code changes; minor for new commands; patch for fixes.
- **CI gates everything** on Node 22 + 24
  (`.github/workflows/ci.yml`). Don't merge red.

## Monday API notes

Full picture in `cli-design.md` §2. Headlines:

- **Endpoint:** `POST https://api.monday.com/v2`.
- **Auth:** `Authorization: <token>` (no `Bearer ` prefix). Loaded from
  `MONDAY_API_TOKEN` env or `.env`.
- **API version pinned `2026-01`** (`API-Version` header on every
  request); matches SDK 14.0.0's `CURRENT_VERSION`. Override with
  `--api-version` or `MONDAY_API_VERSION`. Bumping the pin requires
  bumping the SDK and is a SemVer-minor (major if output schema
  changes).
- **SDK ↔ API drift.** SDK 14.0.0 types `2026-01` but doesn't expose
  some fields (`BatteryValue`, `hierarchy_type`, `is_leaf`,
  `capabilities`) — those need raw GraphQL via `client.request<T>()`.
  See `cli-design.md` §2.8 / §2.9.
- **Boundary-typing trap.** SDK exports
  `QueryVariables = Record<string, any>`. The `src/api/` wrapper must
  keep `any` from leaking into `commands/*` — internal code sees
  `Record<string, unknown>` (or named GraphQL input types).
- **Pagination:** `items_page(limit ≤500, cursor)` →
  `next_items_page(cursor)`; 60-min cursor lifetime. Flat `items`
  query is deprecated.
- **Rate limits + error codes** mapped to CLI `error.code` per
  `cli-design.md` §2.5 / §6.5.

## References

- Monday API reference: https://developer.monday.com/api-reference/
- Official Node SDK: https://github.com/mondaycom/monday-graphql-api
  (`@mondaydotcomorg/api`, **pinned to 14.0.0**).
- API changelog: https://developer.monday.com/api-reference/changelog
