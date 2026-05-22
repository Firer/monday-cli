# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Current state

- **Published:** `monday-cli@0.10.0` on npm (`latest` dist-tag,
  2026-05-22T21:24:43Z). **v0.10.0 published — release complete.**
  Annotated `v0.10.0` tag pushed pointing at `c9eceba`; GitHub
  release live at https://github.com/Firer/monday-cli/releases/tag/v0.10.0.
  The v0.10-M53 `NOUN_DESCRIPTIONS` single-source-of-truth lift is
  **LIVE in the published artifact**: ~120 duplicate
  `ensureSubcommand` literals collapsed into one 18-entry map at
  `src/commands/noun-descriptions.ts`, with the `update/upload.ts`
  `'cli-design §4.3 UPDATE'` internal-ref leak structurally fixed in
  the same migration. **v0.10 release-prep cluster**
  (`36d705d..c9eceba`, 4 commits; mirrors the v0.9 precedent
  minus the ToC-audit commit — audit ran CLEAN so the conditional
  commit was skipped per the v0.9 help-text-grep-clean precedent):
  README Scope flip — flipped current to v0.10.0 with internal-
  cleanup framing (`36d705d`; R-v0.9-NEW-15 widened-checklist's
  three surfaces all addressed — Scope block flipped, quickstart
  held, `**v<next> (next):**` block confirmed absent post-`317ae04`
  collapse) / version bump 0.9.0 → 0.10.0 — no audit-fix folded,
  `npm audit` clean (`50c0b9b`) / CHANGELOG [0.10.0] one-line user-
  impact framing per `feedback_public_docs_clean` ("internal cleanup;
  no behaviour change", `579a36d`) / close-docs sweep
  (`c9eceba`). Envelope-snapshot refresh probe ran clean (zero
  diff vs M53 IMPL close, 162 snapshots) — folded into this close-
  docs prose per the v0.5/v0.6/v0.7/v0.8/v0.9 precedent.
  R-NEW-82 **8th-consecutive ratification** (zero stale
  `deferred_to: "v0.10"` slots, by construction — pure-refactor IMPL
  shipped no deferred wire leg); R-NEW-84 graduated-discipline
  applied (Codex skipped — mechanical/process-only cluster, zero
  production `src/**/*.ts` semantic changes); R-v0.9-NEW-15 RESOLVED
  at v0.10 release-prep (first dedicated consumer of the widened
  checklist); R-v0.8-NEW-21 STAYS-FILED after 3rd-consecutive CLEAN
  hygiene grep (rule-graduation criterion still UNMET); R-v0.9-NEW-13
  GRADUATED into `.claude/rules/workflow.md` at this post-publish
  flip — "Post-publish flip commit pattern", 3rd-instance threshold
  met across v0.7 + v0.8 + v0.9 + v0.10 (4 consecutive). Previous:
  `monday-cli@0.9.0` (tag `v0.9.0` at `ee96681`, 2026-05-22T16:38:40Z);
  `monday-cli@0.8.0` (tag `v0.8.0` at `090fb76`, 2026-05-21T23:45:48Z);
  `monday-cli@0.7.0` (tag `3e46f59`, 2026-05-20T15:48:07Z).
- **package.json version:** `0.10.0`.
- **Live numbers:** **4270 tests pass + 4 skipped** (the **v0.10-M53
  IMPL** net +10 over the M52 baseline of 4260 — 12 new
  `tests/unit/commands/types.test.ts` cases pinning the
  `NOUN_DESCRIPTIONS` map contract + `ensureSubcommand` 2-arg/3-arg
  overload + `lookupNounDescription`'s `unknown_noun` strict-mode
  invariant, less two replaced tests subsumed by the new contract.
  The 4 skips are unchanged: the 2 pre-existing + the multipart-upload
  smoke test + the board-projection schema-drift smoke test). **✅ CI
  `test:coverage` PASSES:** global **branch coverage 95.89% vs the
  95.45% floor** (HOLDS across M53 — the pure-refactor lift removed
  87 single-line + 35 multi-line literal 3rd-args + added one
  `lookupNounDescription` strict-mode branch, all covered by the new
  contract tests). **29 ERROR_CODES** (unchanged across M53 — the
  `lookupNounDescription` `unknown_noun` discriminator routes through
  the existing `internal_error` code); **118 commands** (unchanged
  across M53 — pure-refactor lift, no command delta);
  **functions 98.97% (1354/1368)** — net +1 generated overload-witness
  function the migration exercises, no coverage regression;
  `npm audit` **0 vulnerabilities**. Earlier coverage contributors
  still hold: the **v0.8 refactor cluster** (`item/update.ts` 79.42% →
  87.27%), **R-v0.8-NEW-11** transport-helper lift, the M46 dispatch-
  arm tests (`item/create.ts` 82.31% → 86.58%). **Release-prep held
  all numbers** — every release-prep edit is docs-only (README, CHANGELOG,
  plan-doc, CLAUDE.md) plus `package.json`/`package-lock.json` version
  bumps; re-verified green at the close-docs gate.
- **CI status:** **fully green.** The v0.7.0 table-colour test flake
  (root cause: cli-table3's `@colors/colors` caches its enabled-state
  from ambient TTY detection, so `color: true` emitted no ANSI in a
  non-TTY CI worker) is **FIXED** at `a14802d` — `renderTable` now
  makes the resolved colour decision authoritative; the
  `test:coverage` branch-floor gap is closed (R-v0.8-NEW-10 RESOLVED,
  R-v0.8-NEW-11 SHIPPED — `docs/v0.8-plan.md` §22).
- **✅ v0.9-M50 SHIPPED 2026-05-22** (`e89ddfc`, one feat commit;
  Codex IMPL CONVERGED R1 — 0 P1/P2, 3 P3 all doc-drift/test-gap,
  folded in). **Multi-level subitem nesting** — a *deletion*, as the
  pre-flight scoped: the inverted `parent.hierarchyType ===
  'multi_level'` rejection block (`create.ts`, was ~735-752) is GONE,
  and classic + multi-level boards now share the one existing
  `create_subitem` + `deriveSubitemsBoardId` dispatch (no
  `hierarchy_type` branch). The `subtasks` column's
  `settings_str.boardIds[0]` yields the right column-resolution target
  for both — a separate sub_items_board on classic, the self-referenced
  host board on multi-level (so a multi-level `--set` subitem create
  issues ONE `BoardMetadata` round-trip vs classic's two). Fixes
  v0.8.0's shipped-incorrect rejection (it asserted a now-false
  data-model claim + `deferred_to: 'v0.9'` while shipping AT v0.9 —
  R-NEW-82 anti-pattern). **Closes the M28 deferral.** Verified at API
  `2026-01` (the CLI's pin — NOT SDK-gated). **Zero ERROR_CODE delta
  (29), zero command delta (117), zero new wire surface, no pre-flight
  stub** (R-v0.9-NEW-2 — no new deferred wire leg). `hierarchy_type` is
  still fetched (`lookupItemBoardWithHierarchy` retained) but now
  read-but-unused — kept as a regression-guard affordance (M51 surfaced
  `hierarchy_type` via a SEPARATE `boards(...)` query, NOT this fetch;
  R-v0.9-NEW-4 → RESOLVED/KEEP). The
  existing `multi_level → usage_error` test FLIPPED to a
  `create_subitem` success assertion + a regression guard pins the
  deleted literals (`deferred_to`, the false "sub_items_board carries
  no subtasks column" claim, "M28 Decision 11 closure") absent; a new
  live `--set-raw` multi-level test pins the host-board self-reference
  dispatch. The kickoff cross-doc grep + Codex P3 caught two
  contract-surface doc-drift sites the pre-flight §3 source-enumeration
  missed (`api-reference.md`, `architecture.md`) — the R-NEW-56 /
  R-v0.9-NEW-1 catch. Test delta 4254 → **4256 + 3 skipped**; branch
  coverage **95.91%** (≥ 95.45 floor). Full close at
  `docs/v0.9-plan.md` §3 M50 IMPL-close + §22 (R-v0.8-NEW-23 →
  RESOLVED).
- **✅ v0.9-M51 SHIPPED 2026-05-22** (`f63218d` feat + `4d39e4d` Codex
  fix-up; Codex pre-flight R1 + IMPL R1 both CONVERGED — 0 P1/P2).
  **Multi-level board awareness.** `Board.hierarchy_type`
  (`classic` | `multi_level`, `string | null`, raw GraphQL per SDK
  drift) added to the shared `BOARD_FIELDS_FRAGMENT` +
  `boardProjectionSchema` — so `board get` AND the
  create/update/archive/delete/duplicate cluster all surface it (the
  M15 one-canonical-Board-shape invariant preserved) — plus the
  separate `board list` query/schema. `board describe` already emitted
  it (no change); `board find` stays out (narrow projection by design).
  Half 2: `board duplicate` documented as the multi-level board creation
  path (`duplicate_board_with_pulses` preserves `multi_level`;
  `create_board` is always classic) via cli-design §2.8 + clean
  `board duplicate`/`board create` `--help` nudges. The M50 item
  parent-lookup `hierarchy_type` fetch is confirmed read-but-unused and
  KEPT as a regression-guard affordance (R-v0.9-NEW-4 → RESOLVED/KEEP;
  M51 surfaces the field via a SEPARATE `boards(...)` query, NOT that
  fetch — the stale "M51 reuses the fetch" docstrings corrected). D7:
  `BoardGet` + `BoardList` query strings exported + added to the
  RUN_LIVE_TESTS schema-drift smoke test; `match_query: /hierarchy_type/`
  on the cassettes pins the *selection* (Codex IMPL P3 — a mock can't
  catch a fragment regression alone). **Zero ERROR_CODE delta (29), zero
  command delta (117), zero new wire surface** (additive read field on
  existing queries). Closes the R-v0.8-NEW-24 facets (a)+(b). Full close
  at `docs/v0.9-plan.md` §3 M51 IMPL-close + §1 row + §22.
- **✅ v0.9-M52 SHIPPED 2026-05-22** (`a184156` feat; Codex pre-flight
  CONVERGED R3 — 0 P1 across R1/R2/R3, 2+2+0 P2/P3 folded; Codex IMPL
  CONVERGED R1 — 0 P1/P2/P3). **Board views read.** `Board.views`
  (Kanban/Gantt/Calendar/Table/…) now reachable via two routes: (a)
  `boardMetadataSchema` gains a `views: z.array(boardViewSchema)
  .nullable()` slot — `board describe` surfaces it alongside columns +
  groups — and (b) a new `monday board views <bid>` verb mirrors
  `board columns` / `board groups` (cache-aware via `loadBoardMetadata`,
  so a follow-up describe/columns/groups/views pays one fetch). All 13
  `BoardView` wire fields surfaced 1:1 (raw GraphQL — the
  `is_leaf`/`hierarchy_type` SDK-drift class). Required-nullable on
  `views` (M51 precedent — pre-M52 cache entries lacking the key
  auto-invalidate via strict-parse failure, the corrupt-cache → live
  re-fetch contract). `jsonScalarOrNull` helper for the 3 JSON-scalar
  BoardView fields (`settings` / `sort` / `filter`) rejects `undefined`
  so fixtures can't silently omit a wire-selected field (Codex R2 P2-1
  catch). The live-schema-drift smoke gained a `toHaveProperty('views')`
  key-presence assertion (R2 P2-2 — wire-nullable `Board.views` means
  `array | null`, not array-only). Cassette `match_query: /views \{/`
  pin on the new verb's integration test — M52's 2nd consumer of the
  raw-GraphQL selection-pin pattern (M51 was 1st). **Zero ERROR_CODE
  delta (29); +1 command (117 → 118).** Touched 1 of 4 board schemas
  (`boardMetadataSchema` only — `boardProjectionSchema` /
  `boardListSchema` / `boardFindSchema` stay untouched, R-v0.9-NEW-5
  trigger UNMET, stays filed). Closes the R-v0.8-NEW-25 view-metadata
  read gap from the 2026-05-22 dev-board sweep. Folded in: a
  pre-existing M51 leftover (the m3 e2e `BoardList` fixture was
  missing `hierarchy_type`; fixed here because the m3 fixture also
  needed `views` updates). Full close at `docs/v0.9-plan.md` §3 M52
  IMPL-close + §1 row + §22.
- **Two R-class graduations at M52 close** (2nd-instance triggers
  both fired):
  - **R-v0.9-NEW-6** → `.claude/rules/testing.md` as "Wire selection-
    pin for raw-GraphQL SDK-drift fields" — two-layer guard
    (cassette `match_query` + live-smoke `toHaveProperty`) for any
    raw-GraphQL field on the `is_leaf` / `hierarchy_type` / `views`
    class. M51 (`hierarchy_type`) + M52 (`views`) — both consumers
    landed.
  - **R-v0.9-NEW-7** → `.claude/rules/workflow.md` as "Read-side
    field-add — check whether the named command's schema is SHARED"
    — pre-flight discipline to verify single-sourced vs shared
    schemas before scoping; binding decisions escalate via
    `AskUserQuestion`. M51 chose the SHARED projection
    (`boardProjectionSchema` + `hierarchy_type`); M52 chose the
    HEAVY single-sourced one (`boardMetadataSchema` + `views`).
    Both correct per the runtime read; rule documents both valid
    choices.
- **✅ v0.11-M54-G pre-flight CLOSED 2026-05-23**
  (`<pre-flight-sha>` — single commit: new verb `monday item
  get-description <iid>` + schema + tests + cli-design + output-
  shapes + plan-doc open). Picked at v0.11 candidate-selection
  2026-05-22 per R-NEW-75 over the C/D/E/G + R-v0.10-NEW-4
  backlog. **Empirical probe ran 2026-05-23** at pre-flight
  kickoff (`scripts/probe/v0.11-item-description-2026-01.report.txt`)
  — confirms `Item.description` is OBJECT `ItemDescription{id,
  blocks[DocumentBlock]}` at API `2026-01` (the CLI pin); NOT
  SDK-gated; ships standalone. **D1 closed via AskUserQuestion
  2026-05-23 single round-trip** in favour of shape (b) narrow
  verb (mirrors v0.9-M52's `board views` carve-out per the
  graduated "Read-side field-add" rule — heavy/nested fields
  carve out, lightweight/universal extend). **D2 selection-pin
  guard both layers landed** per v0.9-M52-graduated rule
  (cassette `match_query: /description \{/` + RUN_LIVE_TESTS
  `toHaveProperty('description')`; 3rd consumer of R-v0.9-NEW-6
  graduated guard). Per R-v0.9-NEW-2 the pure-additive new
  verb's wire leg IS the runtime payload at pre-flight — no
  stub literal, no PIN test, no RESERVED-literal guard (3rd
  structurally distinct instance: M50 deletion + M53 pure refactor
  + M54-G pure additive — rule body widens at IMPL close, filed
  R-v0.11-NEW-2). 0 fixture ripples, 0 existing call sites
  touched. **R-v0.9-NEW-8 RESOLVED** at pre-flight (the canonical
  filing's open empirical probe + binding decisions both closed
  inline). **R-v0.9-NEW-10** advanced to 2-consumer (jsonScalarOrNull
  pattern re-used in `item-description.ts`; lift at 3rd consumer
  per R-NEW-58). 4 new R-class watch-items filed
  (R-v0.11-NEW-1/2/3/4 in `docs/v0.11-plan.md` §22 — multi_level
  probe gap, R-v0.9-NEW-2 3rd-class rule-widening candidate,
  `runByIdLookup` pluck-sub-field abstraction watch, `_lib.ts`
  DX-improvement). v0.10.0 stays PUBLISHED + release-complete
  (npm `latest` 2026-05-22T21:24:43Z; tag `v0.10.0` at `c9eceba`).
  **E (profile-scoped argument defaults) queued for v0.12**; C
  stays-filed (4 slips on Monday's `ColumnMappingInput` no-value-
  slot at API `2026-01`); D stays design-blocked.
- **Next session:** **v0.11-M54-G IMPL close-docs + Codex IMPL
  review.** Per R-v0.9-NEW-2 the IMPL is unusually thin — no
  stubs to flip (the verb shipped LIVE at pre-flight). IMPL
  session work: (a) Codex IMPL review on the pre-flight diff
  (template at `.claude/templates/codex-pre-flight-review.md`
  applies; MEDIUM sensitivity; 0 P1 target); (b) §3 post-mortem
  + §22 R-class log updates in `docs/v0.11-plan.md`; (c)
  `<pre-flight-sha>` backfill across plan-doc + CLAUDE.md; (d)
  fold R-v0.11-NEW-2 rule-widening into
  `.claude/rules/workflow.md` (R-v0.9-NEW-2 framing widens from
  "rejection-lift OR pure-refactor" to "any pre-flight with no
  deferred wire leg"); (e) cli-design SHA backfills if needed.
  After IMPL close-docs: **v0.11 release-prep** (version bump
  0.10.0 → 0.11.0 + CHANGELOG + README Scope flip per
  R-v0.9-NEW-15 widened checklist + close-docs sweep per
  R-NEW-82/84 baseline). E (profile-scoped argument defaults)
  opens for v0.12 candidate-selection after v0.11 ships.
- **Historical context for v0.10 (previously the active milestone):**
  **R-v0.10-NEW-4 RESOLVED inline at `085e999`** —
  `--maxWorkers=2` folded into the `test:coverage` script
  (work-of-opportunity per the v0.10 post-publish refactor-audit
  finding). **v0.11-G scope:** unblock the v0.9-M52-surfaced
  read gap where `ITEM_FIELDS_FRAGMENT`
  (`src/api/item-helpers.ts`) doesn't select `description`, so
  every item-read verb
  (`item get`/`list`/`find`/`search`/`subitems`/`history`)
  returns items without descriptions. Pre-flight binding
  decisions: shape (a) extend `ITEM_FIELDS_FRAGMENT` (universal
  projection — heavier) vs (b) dedicated `monday item
  get-description <iid>` verb (narrow projection — mirrors
  M52's `board views` carve-out); plus the **open empirical
  probe** for `Item.description` field availability at API
  `2026-01` (the CLI pin — the 2026-05-22 dev-board sweep
  confirmed OBJECT type at `2026-04` but didn't test `2026-01`
  availability). Same SDK-drift class as
  `hierarchy_type`/`views`; the M52-graduated `match_query`
  selection-pin two-layer guard (cassette + RUN_LIVE_TESTS smoke
  per `.claude/rules/testing.md`) applies. **No
  `docs/v0.11-plan.md` opens this session** per the v0.10
  precedent (`5d89754` — plan-doc opens at the first pre-flight
  contract diff commit of the milestone). **Post-publish
  refactor-audit ran 2026-05-22** over `36d705d..177b40c`
  (recency window: release-prep cluster + post-publish flip) —
  process-only cluster (matching v0.9's precedent at `253233f`),
  no code-lift candidates surfaced. Filed
  3 new R-class watch-items (R-v0.10-NEW-5/6/7 in
  `docs/v0.10-plan.md` §22 — `<post-publish-sha>` placeholder
  convention meta-pattern; "if clean, skip" sub-rule of R-NEW-82
  contradicting the stated 6-commit baseline after 2 consecutive
  4-commit clusters; Post-publish flip rule cross-ref gap with
  R-NEW-82's placeholder convention from the close-docs side) +
  flipped R-v0.9-NEW-14 status (2nd-consecutive instance reached
  at M53 — release-prep grep found zero stale slots for the 2nd
  consecutive cycle because the IMPL was a pure refactor with no
  deferred wire leg; trigger at 3rd-consecutive instance for
  graduation). v0.10.0 is **PUBLISHED + release-complete** (npm
  `latest` 2026-05-22T21:24:43Z; tag `v0.10.0` at `c9eceba`;
  release-prep `36d705d..c9eceba`). v0.10 feature-cluster scope
  is fully shipped — **M53** NOUN_DESCRIPTIONS lift — and the
  release-prep cluster landed in 4 commits (matching v0.9's
  4-commit shape; ToC audit skipped after CLEAN audit per the
  "if clean, skip" precedent). Process adoptions at the v0.10
  close-docs: R-NEW-82 **8th-consecutive ratification** (zero
  stale `deferred_to: "v0.10"` slots, by construction —
  pure-refactor IMPL shipped no deferred wire leg); R-NEW-84
  graduated-discipline applied (Codex skipped on the mechanical/
  process-only cluster); R-v0.9-NEW-15 RESOLVED at v0.10
  release-prep (first dedicated consumer of the widened
  checklist); R-v0.8-NEW-21 STAYS-FILED after 3rd-consecutive
  CLEAN hygiene grep (rule-graduation criterion still UNMET, 4th
  consecutive CLEAN sweep at v0.11+ release-prep would justify
  graduation-or-close); R-v0.9-NEW-13 GRADUATED at this
  post-publish flip into `.claude/rules/workflow.md` as
  "Post-publish flip commit pattern" — 3rd-instance threshold met
  across v0.7 + v0.8 + v0.9 + v0.10 (4 consecutive). **✅
  v0.10-M53 SHIPPED 2026-05-22** — see `docs/v0.10-plan.md` §3
  "M53 — IMPL close" + §3 "release-prep — close" + §22 R-class
  register for the full narrative (per the
  `feedback_public_docs_clean` propagation forward, the
  per-milestone narrative belongs in the plan-docs, not here).
  Pre-flight `c48510f` + `b334899`; IMPL `feb8805`; close-docs
  `c9eceba`. Codex IMPL CONVERGED R1 (0 P1/P2/P3); R-class
  outcomes at M53 IMPL close: R-v0.8-NEW-22 + R-v0.10-NEW-1 +
  R-v0.10-NEW-2 all RESOLVED; R-v0.9-NEW-2 GRADUATED into
  `.claude/rules/workflow.md` ("Rejection-lift / pure-refactor
  pre-flights need NO stub literal", 2nd instance: M50 deletion +
  M53 lift). Net stats: zero new wire surface, zero new transport
  seam, zero new ERROR_CODE (29 stays), zero command delta (118
  stays); 4270 tests + 4 skipped; branches 95.89%; `npm audit` 0.
  SDK probe at the M53 pre-flight + this release-prep:
  `@mondaydotcomorg/api@14.0.0` — **5th-consecutive SDK stall**
  (v0.6 → v0.10), so M39/M40/M41 (SDK 15.x → API `2026-04`) +
  M44/M45 (SDK 16.x → API `2026-07`) stay DEFERRED; v0.10 is the
  4th-consecutive pivot in sequence (v0.7/v0.8/v0.9/v0.10).
  v0.9.0 is **PUBLISHED + release-complete** (npm `latest`
  2026-05-22T16:38:40Z; tag `v0.9.0` at `ee96681`; release-prep
  `0147883..ee96681`). v0.9 feature-cluster scope is fully shipped —
  **M50** nesting + **M51** hierarchy_type + **M52** views read —
  and the release-prep cluster landed in 4 commits (vs v0.8's 6 —
  README pre-cleaned + help-text grep clean trimmed two commits).
  Process adoptions at the v0.9 close-docs: R-NEW-82 **7th-consecutive
  ratification** (and notable inversion — M50's deletion-led IMPL
  preempted the historical release-prep slip work entirely, finding
  ZERO stale `deferred_to: "v0.9"` slots at the cross-doc grep);
  R-NEW-84 graduated-discipline applied (Codex skipped on the
  mechanical/process-only cluster); `feedback_public_docs_clean`
  propagated forward from v0.8's `40a58d0` cleanup pass — M50/M51/M52
  source applied the directive from the start, so the v0.9 help-text
  hygiene grep landed clean and the conditional commit was skipped.
  v0.9 R-class additions at close-docs are watch-items only
  (R-v0.9-NEW-5/8/9/10/11/12 — triggers don't fire on a mechanical
  release-prep cluster). **Post-publish refactor-audit (2026-05-22)
  appended 3 more watch-items** (`docs/v0.9-plan.md` §22):
  R-v0.9-NEW-13 (post-publish flip pattern — 2nd consecutive instance,
  graduates into workflow.md at 3rd); R-v0.9-NEW-14 (deletion-led
  IMPLs preempt R-NEW-82's release-prep slip work — 1st instance,
  M50's deletion-led IMPL produced a zero-stale-slot grep at v0.9
  release-prep); R-v0.9-NEW-15 (README Scope-section drift at
  release-prep — caught at this audit + fixed inline; release-prep
  checklist's "README refresh" step needs to widen from quickstart
  to also include the per-version Scope blocks + the
  `**v<next> (next):**` backlog block, 2nd-instance trigger).
  R-v0.8-NEW-21 status flipped OPEN → PARTIALLY-RESOLVED — the
  v0.9 release-prep help-text hygiene grep ran + landed CLEAN
  (rule-graduation criterion ["2nd release-prep surfaces fresh
  leaks"] UNMET, watch-item stays filed).
  **✅ v0.8-M48 SHIPPED 2026-05-21** (`4803cbf` IMPL feat + `f79bb16`
  R1 P3 prose fix-up; Codex IMPL CONVERGED R2, 0 P1/P2 across both
  rounds): the `m48_preflight_stub` c8-ignored stub swapped for the live
  `variables.defaults = CREATE_TIME_SETTINGS_WRAP_TYPES.has(type) ?
  {settings} : settings` wrap (single dispatch-site ternary); the 2 stub
  PIN tests converted to live wire-shape assertions
  (`match_variables: {defaults: {settings: {…}}}`, whole-`defaults`
  JSON.stringify-pinned so a bare pass-through regression fails) + a
  RESERVED-literal regression guard. The wrap is wire-only — dry-run
  echo + read-side `settings_str` stay UNWRAPPED (agent shape). Plain
  JSON (not multipart) + probe-confirmed wire, so no RUN_LIVE_TESTS gate
  (unlike M49). `ApiError` import dropped. The `m48_preflight_stub`
  literal has DISAPPEARED from runtime + stays RESERVED. R-v0.8-NEW-19
  (3-parallel-structure schema-registry/wrap-set fold) + R-v0.8-NEW-20
  (suspected dependency item-VALUE `--set` live-drift) stay filed
  watch-items — neither tripped by M48 IMPL. Full close + D-list at
  `docs/v0.8-plan.md` §3 M48.
  **✅ v0.8-M47 SHIPPED 2026-05-21** (`0d99ea7`,
  `feat(item): live stdin file --set <file-col>=- (v0.8-M47 IMPL)`):
  the `readStdinFileSource` stub swapped for the live stdin buffer →
  `Blob` (mime sniffed from `--filename`, default `"blob"`) → M31's
  `add_file_to_column` fetcher; the four dispatch sites (`item set`
  live + dry-run, single-item `item update`, `item create` two-leg
  under §5.8 orphan-warn) + the D4 size-less dry-run echo wired; empty
  stdin rejects `usage_error` (`stdin_file_empty`); `item create` reads
  stdin BEFORE leg-1 so an empty pipe never orphans. **Codex IMPL
  CONVERGED at R1** (0 P1/P2/P3, 11 watch-items clear). R-v0.8-NEW-15
  considered-but-not-tipped (no shared dispatch helper — composes the
  existing `readStdinFileSource` + `addFileToColumn`, per-site emit
  inline). R-v0.8-NEW-16 GRADUATED into `workflow.md` (`da62add`);
  R-v0.8-NEW-17 verb-shaped upload hints refreshed (`d686177`).
  **R-v0.8-NEW-2 RESOLVED** at the M47 pre-flight
  (`enforceSingleFileColumnSet` → `routeFileColumnDispatch`). Full
  close + D-list at `docs/v0.8-plan.md` §3 M47. (M48 has since SHIPPED
  — `4803cbf` — leaving **release-prep as the last v0.8 unit**.) **✅
  v0.8 refactor cluster SHIPPED 2026-05-21**
  (`refactor(api): lift reThrowDecorated + projectCauseForEnvelope`;
  Codex IMPL CONVERGED R4; branches 95.47% → 95.88%). **v0.8-M49 DONE**
  (`2ec67ad`): `src/api/multipart-transport.ts` emits Monday's native
  multipart shape; full close at `docs/v0.8-plan.md` §3 M49.

  **v0.8 committed scope (post-M49), rough build order** (revised
  2026-05-21 — M49 + the refactor cluster + **M47 SHIPPED** (`0d99ea7`,
  Codex IMPL CONVERGED R1) + **M48 SHIPPED** (`4803cbf` IMPL +
  `f79bb16` fix-up, Codex IMPL CONVERGED R2); **release-prep is the
  next + LAST v0.8 unit**):
  - **M49** — 🚨 P1 file-upload wire-format fix. **SHIPPED in-tree
    `2ec67ad`** (Codex R1 CONVERGED, live-verified).
  - **v0.8 refactor cluster** — **✅ SHIPPED 2026-05-21**
    (`refactor(api): lift reThrowDecorated + projectCauseForEnvelope`;
    pre-flight `ca615e7`, Codex IMPL CONVERGED R4, 0 P1/P2).
    R-v0.7-NEW-5 `reThrowDecorated` fail-fast-scaffold lift (4
    consumers: clear / JSON-bulk / M42 file-bulk / M46 file-bulk-multi)
    + R-v0.8-NEW-6 `projectCauseForEnvelope` builder (3 consumers;
    bundled, both in mutation-path catch arms) now live in
    `src/api/error-decoration.ts`; the 7 sites delegate. Standalone
    `src/api/` lift consolidated the fail-fast scaffold across the
    M42/M46 file-set paths before M47 adds a 5th touch, and widened the
    thin coverage margin (branches 95.47% → 95.88%; `item/update.ts`
    79.42% → 87.27%). Full close at `docs/v0.8-plan.md` §3 + §22.
  - **M47** — stdin file `--set` `<file-col>=-` (D7 closure). **✅
    SHIPPED at `0d99ea7`** (Codex IMPL CONVERGED R1). Pre-flight diff
    `f5353e4..a424293` (Codex CONVERGED R2); IMPL swapped the
    `readStdinFileSource` stub for the live stdin → `Blob` →
    `add_file_to_column` leg + wired the 4 dispatch sites + the D4
    size-less dry-run echo. Scoped single-file/single-target (stdin is
    one non-replayable stream). `stdin_file_empty` rejects an empty
    pipe; `item create` reads stdin before leg-1 (no orphan).
    **R-v0.8-NEW-2 RESOLVED** at pre-flight (`enforceSingleFileColumnSet`
    → `routeFileColumnDispatch`); R-v0.8-NEW-15 not-tipped,
    R-v0.8-NEW-16 graduated (`da62add`), R-v0.8-NEW-17 done (`d686177`).
  - **M48** — board_relation/dependency writable settings. **✅
    SHIPPED 2026-05-21** (pre-flight `fbd60a6..0ca0d81` Codex CONVERGED
    R3; IMPL `4803cbf` feat + `f79bb16` R1 P3 fix-up, Codex IMPL
    CONVERGED R2). Pre-flight shipped the argv surface live (per-type
    schemas, int coercion with a `Number.isSafeInteger` guard, the
    `dependency` same-board reject per D1 option (c), the dry-run echo);
    IMPL swapped the `m48_preflight_stub` for the live
    `variables.defaults = ...has(type) ? {settings} : settings` wrap +
    the whole-`defaults` wire-shape assertion + the RESERVED-literal
    guard. Probe: outcome (b) live-confirmed; single-leg; M19 "no
    documented shape" REFUTED; read back as UNWRAPPED `settings_str`;
    Monday validates board existence → `not_found`; `dependency`
    diverges (same-board — arbitrary target coerced to host).
    Independent of M49 — `create_column` is JSON, not multipart; no
    RUN_LIVE_TESTS gate. Full close + D-list at §3 M48 entry; raw report
    at `scripts/probe/m48-board-relation-settings.report.txt`.
  - **Release-prep cluster** — R-v0.8-NEW-4 (schema parse-test
    backfill) folds into its envelope-snapshot probe.
  - Process/template adoptions (no code milestone): R-v0.8-NEW-7
    (bare-SHA doc citations fragile under rebase — adopt
    commit-subject refs at next close-docs) + R-v0.8-NEW-8 (Codex
    audit-point: new emit shape → `outputSchema` advertisement check).

  **v0.8-M46 SHIPPED at `3e6bdc1..1289133`** (R0 IMPL + R1-R2 Codex
  IMPL fix-up rounds; CONVERGED at R3 with zero findings). The
  v0.6-M38 → v0.8-M46 D2 fold lands multi-file `--set` per call for
  the 3 reachable callShapes (single-item update / bulk update /
  create), each firing N sequential `add_file_to_column` legs per
  item. R-v0.8-NEW-1 RESOLVED as LIFT — the inner sequential N-leg
  loop + partial-failure accumulator lifted to
  `dispatchFileLegsSequentially` (`src/api/file-column-set.ts`, 3
  consumers); per-callShape envelope decoration + `foldAndRemap`
  placement stayed inlined. Pre-flight cluster was `89a86ea..d9b035b`
  (R0 + 3 Codex pre-flight rounds). Full narrative + post-mortem at
  `docs/v0.8-plan.md` §3 M46 entry + §22 R-v0.8-NEW-1.

  v0.8 RE-SCOPES from the original `2026-07`
  SKELETON
  (M44 user-entity migration + M45 user activity) to stay on
  `2026-01` and ship the v0.6-M38 D2 + D7 carve-out folds —
  mirrors the v0.7-pivot precedent verbatim (v0.7 originally
  `2026-04` + M39/M40/M41; shipped `2026-01` + M42/M43
  carve-out folds after SDK 15.x didn't publish in time). SDK
  probe at the candidate-selection commit: `@mondaydotcomorg/api`
  still at 14.0.0 baking `2026-01` natively; no 15.x release
  (which would bake `2026-04`) or 16.x release (which would
  bake `2026-07`, the v0.8 SKELETON's gating dependency).

  Bundle scope (in milestone order):

  - **M46 — multi-file `--set` per call** (v0.6-M38 D2 deferral
    `multi_file_set_unsupported`). **SHIPPED at `3e6bdc1..1289133`.**
    Extended v0.7-M42's per-item file-dispatch envelope to multiple
    file entries per item. Zero new wire surface, zero new transport
    seam, zero new ERROR_CODES (registry stays at 29). Built on M42's
    pinned per-item baseline; `file-source.ts` (R-v0.6-NEW-1) reached
    its 6th consumer (already graduated at 5, so no new lift work) +
    gained the new `dispatchFileLegsSequentially` lift (R-v0.8-NEW-1,
    3 consumers).
  - **M47 — stdin file `--set` `<file-col>=-`** (v0.6-M38 D7
    deferral). Needs `--filename` companion shape pinned at
    pre-flight + one wire-shape probe (does Monday's
    `add_file_to_column` accept the streaming-from-stdin shape
    without an explicit filename, or does it require one?).
    Potential new "stdin-to-Blob" helper inside file-source.ts.

  M44 + M45 (user-entity migration + user activity) retain their
  numbers in the v0.8 SKELETON's §3 sequencing but DEFER again
  pending SDK 16.x publication. The v0.7-deferred M39 / M40 / M41
  cluster (API `2026-04` pin + `set_item_description_content` +
  `create_doc_blocks`) RE-OPENS when `@mondaydotcomorg/api` SDK 15.x
  publishes with `CURRENT_VERSION = '2026-04'` natively. **2026-05-22
  dev-board probe sweep RESOLVED the M40 mystery: `set_item_
  description_content` WORKS on `multi_level` boards** (`success:true`
  on top items + subitems, isolated to the hierarchy via a fresh
  `duplicate_board` copy); it 500s `docs-api` only on CLASSIC boards
  (what the earlier probes tested — so the "paid gating" / "Monday
  bug" reads are SUPERSEDED). M40 is feature-real; only the M39 SDK
  gate remains, and it must scope to `multi_level` boards. The SAME
  sweep also **refuted the M28 multi-level-subitem deferral premise**
  (nesting works depth-3+ on multi_level boards via the `subtasks`
  self-referencing column) and surfaced board-views + multi-level-
  board-creation gaps — all filed as R-class candidates in
  `docs/v0.8-plan.md` §22 (R-v0.8-NEW-23/24/25); see
  [[project-multilevel-dev-board-capabilities]].
  **⚠️ SHIPPED-BEHAVIOR IMPACT (R-v0.8-NEW-23, HIGH):** v0.8.0's `item
  create --parent` REJECTS multi_level boards with an error asserting a
  now-FALSE fact ("Monday's sub_items_board carries no subtasks column
  at 2026-01") — and nesting was re-verified WORKING at API `2026-01`
  (the CLI's pin, NOT just 2026-04), so this is a near-term correctness
  fix, not SDK-gated. (M40 descriptions DO stay 2026-04/M39-gated —
  the mutation doesn't exist at 2026-01.) Multi-level board CREATION is
  possible today via `board duplicate` (preserves multi_level —
  verified) but NOT from scratch (`create_board` has no hierarchy arg).
  The M39 override commits (`bb7c2cc..2e501b5`) + M40 uncommitted
  work are recoverable in `git reflog` for ~90 days; M40 findings
  preserved in user-memory at
  `~/.claude/projects/-home-nick-code-monday-cli/memory/project_m40_findings_deferred.md`.

  Other carry-forward backlog stays deferred:
  (a) profile-scoped argument defaults (filed at v0.6 kickoff;
  extends `~/.monday-cli/config.toml` with `[profiles.<name>.
  defaults]`; carries the §13 carve-out Decision prerequisite
  distinguishing aliases-as-stored-command-strings from
  defaults-as-stored-flag-values); (b) cross-board `item move`
  value-overrides (Monday's `ColumnMappingInput` still carries
  no value slot at API `2026-01` — slipped four times, may
  close permanently or await Monday surface change);
  (c) cross-board search resumable cursor (per-board
  cursor-lifetime under aggregation design issue unchanged);
  (d) multi-level subitem creation (Monday's `sub_items_board`
  still missing `subtasks` column at `2026-01`/`2026-04`/
  `2026-07` per 2026-05-18 changelog research).

- **M43 SHIPPED at `5cf4365..c217011`** (R0 IMPL + R1-R3 Codex
  IMPL fix-up commits + R4 CONVERGED with zero findings). The
  v0.6-M38 → v0.7-M43 D6 fold lands the create-time file `--set`
  two-leg dispatch under the §5.8 orphan-warn atomicity envelope.
  Pre-flight contract diff cluster at `28f117c..ea71b55` (R0 + 5
  Codex pre-flight rounds, CONVERGED at R5); IMPL cluster at
  `5cf4365..c217011` (R0 + 4 Codex IMPL rounds, CONVERGED at R4).
  Behavioural findings: 0 P1 across all 9 rounds (pre-flight 5
  + IMPL 4); only W9 prose-drift fix-ups iterated to convergence.
  The R-v0.7-NEW-4 inherited contract-term checklist (graduated
  v0.7-M42 IMPL R7) short-circuited M43 IMPL's W9 cycle from
  M42's 8 rounds down to 4 — graduation earned its keep.

  D1-D3 closures + implementation summary:
  - **D1 — Atomicity envelope: (b) orphan-warn.** Leg-2 failure
    surfaces `internal_error` with `details.reason:
    'create_then_file_upload_partial_failure'` +
    `details.created_item_id` echoing leg-1's orphan +
    `details.column_id` + `details.cause` (M31 wire failure
    surface, JSON projection) + `details.hint` directing agents
    to retry leg-2 only (`monday item set <iid> <file-col>=<path>`)
    OR rollback (`monday item delete <iid> --yes`). Closure
    rationale: pre-flight rollback-viability probe could not run
    empirically (token lacked `create_item` permission on a
    token-created sandbox workspace + existing-board attempts
    correctly blocked by harness modify-shared-state guards).
    Defaulting to (b) preserves the agent's recovery handle
    without introducing a destructive `delete_item` cleanup leg
    whose own failure mode is unaccounted for. Future milestone
    can lift to (a) automatic rollback if a user-authorized
    probe sandbox surfaces concrete rollback-reliability data.
  - **D2 — Dry-run envelope:** two `planned_changes` entries
    (`operation: 'create_item'` / `'create_subitem'` with
    bundled non-file `column_values`, then `operation:
    'add_file_to_column'` with file pre-check echo; no
    `item_id` on entry-2 — the item doesn't exist at dry-run
    time).
  - **D3 — ERROR_CODES delta:** zero net change. Registry stays
    at 29. Atomicity failures route through existing
    `internal_error` with the new
    `create_then_file_upload_partial_failure` `details.reason`
    discriminator (M43 added the 5th supporting instance of
    R-v0.6-NEW-2's discriminator pattern, hitting the 5-consumer
    graduation threshold).

  R-class outcomes at M43 IMPL:
  - **R-v0.6-NEW-1** (file pre-check + Blob helper) graduated
    at the 5-consumer threshold (M42 4th + M43 5th confirmed
    `5cf4365`). Helper scaled cleanly to consumer-5 with zero
    internal-shape changes.
  - **R-v0.7-NEW-5** (fail-fast error-decoration block lift)
    INLINE at M43 IMPL — M43's leg-2 catch is structurally
    distinct from the fail-fast bulk pattern (always-`internal_
    error` outer code + `details.cause` JSON projection vs
    preserve-remapped-code with typed re-throw). Lift stays
    deferred at 2 consumers; cited as the 1st "considered but
    not tipped" event under R-NEW-58's consumer-threshold gating.
  - **R-NEW-76** (parseArgv-BEFORE-c8) graduated from "stub-
    anchored ordering invariant" to "wire-dispatch-anchored
    ordering invariant" — post-IMPL the c8 boundary is gone but
    the ordering itself stays load-bearing (argv-level failures
    surface as `usage_error` not `internal_error`).
  - **R-v0.7-NEW-4** (pre-IMPL contract-term checklist) extended
    with a "round-agnostic framing" sub-rule (M43 R3 surfaced
    round-counter staleness as a new W9 sub-category; close-docs
    landed the workflow.md extension request).

  Full M43 narrative + post-mortem + R-class log update at
  `docs/v0.7-plan.md` §3 M43 entry + §22 R-class register.

- **M42 SHIPPED** at `22df2fa..08ae263` (R0 IMPL + 8 Codex
  fix-up rounds: R1 behavioral; R2-R8 W9 prose sweep —
  asymptotic convergence with the R7 workflow.md graduation
  of "Pre-IMPL contract-term checklist for cross-doc grep"
  intended to short-circuit the pattern at v0.7-M43 onwards
  — M43 IMPL validated this at R4 convergence).

  Full v0.7 scope (M39-M43) unchanged from SKELETON. v0.8
  SKELETON stays unratified (opens after v0.7.0 publishes).
  Other carry-forward backlog (multi-level subitems /
  cross-board move value-overrides / resumable cross-board
  cursor / profile-scoped argument defaults / multi-file
  `--set` / stdin file-`--set`) stays deferred.

For every shipped milestone's narrative, post-mortem, Codex round
detail, and R-class refactor backlog, **read the plan docs** —
**do not duplicate that history here**:

1. **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical
   contract: command surface, output envelope, 29 stable error codes,
   deferral list (§13), every binding decision.
2. **[`docs/v0.11-plan.md`](./docs/v0.11-plan.md)** — **ACTIVE plan**
   (kickoff 2026-05-23). v0.11 = the **`Item.description`
   read-side carve-out** (`monday item get-description <iid>`) on
   the `2026-01` pin: **M54-G** ships a new narrow verb mirroring
   v0.9-M52's `board views <bid>` carve-out from `board describe`.
   Closes R-v0.9-NEW-8 (filed at v0.9-M52 close-docs;
   user-directed). **M54-G pre-flight CLOSED 2026-05-23**
   (`<pre-flight-sha>` — verb fully wired LIVE per R-v0.9-NEW-2:
   pure-additive new verb has no deferred wire leg → no stub
   needed). §22 R-class register populated at M54-G pre-flight
   (R-v0.11-NEW-1/2/3/4 + carried-forward v0.8 / v0.9 / v0.10
   open watch-items + promoted R-v0.9-NEW-8 → M54-G RESOLVED).
   **Next is M54-G IMPL close-docs + Codex IMPL review** (per
   R-v0.9-NEW-2 the IMPL is unusually thin — no stubs to flip;
   work is Codex review + post-mortem + R-class log + SHA
   backfills + R-v0.11-NEW-2 rule-widening fold into
   workflow.md) + release-prep (0.10.0 → 0.11.0 + CHANGELOG +
   close-docs, per R-NEW-82/84 baseline). M39/M40/M41 (SDK 15.x)
   + M44/M45 (SDK 16.x) stay DEFERRED — SDK still 14.0.0
   (**5th-consecutive stall**).
3. **[`docs/v0.10-plan.md`](./docs/v0.10-plan.md)** — shipped
   (kickoff 2026-05-22). v0.10 = the **`NOUN_DESCRIPTIONS` single-
   source-of-truth lift** on the `2026-01` pin: **M53** collapses
   ~100 duplicate `ensureSubcommand(program, '<noun>', '<desc>')`
   literals across ~80 verb files into one 18-entry map; closes the
   R-v0.8-NEW-22 candidate (filed at v0.8 post-publish; demonstrated
   shipped bug: `doc` "read-only at v0.4" + `update`
   `'cli-design §4.3 UPDATE'` ref leaking into help). **M53
   pre-flight CLOSED 2026-05-22** (`c48510f` — additive
   signature stub + new `src/commands/noun-descriptions.ts` module +
   12 new `tests/unit/commands/types.test.ts` tests; all ~120
   existing call sites compile unchanged). §22 R-class register
   populated at M53 pre-flight (R-v0.10-NEW-1/2 + carried-forward
   v0.8 watch-items R-v0.8-NEW-19/20/21 + carried-forward v0.9
   watch-items R-v0.9-NEW-3/5/8/9/10/11/12/13/14/15/16 + promoted
   R-v0.8-NEW-22 → M53). **Next is M53 IMPL** (drop the 3rd arg
   from each of the ~120 call sites; structurally drops the
   `update/upload.ts` drift) + release-prep (0.9.0 → 0.10.0 +
   CHANGELOG + close-docs, per R-NEW-82/84 baseline).
   M39/M40/M41 (SDK 15.x) + M44/M45 (SDK 16.x) stay DEFERRED —
   SDK still 14.0.0 (**4th-consecutive stall**).
4. **[`docs/v0.9-plan.md`](./docs/v0.9-plan.md)** — shipped (npm
   `latest` 2026-05-22T16:38:40Z; tag `v0.9.0` at `ee96681`). v0.9
   = the **multi-level board cluster** on the `2026-01` pin: **M50**
   multi-level subitem nesting (closes the M28 deferral + fixes the
   shipped-incorrect `item create --parent` rejection) + **M51**
   `hierarchy_type` surfacing / `board duplicate` multi-level path
   + **M52** board views read. **M50 ✅ SHIPPED 2026-05-22**
   (`e89ddfc`, deletion-led IMPL, Codex CONVERGED R1; pre-flight
   `9675f6a..e41b467`); **M51 ✅ SHIPPED 2026-05-22** (`f63218d` +
   `4d39e4d`, Codex pre-flight + IMPL both CONVERGED R1; pre-flight
   `4eb3ca4..2958146`); **M52 ✅ SHIPPED 2026-05-22** (`a184156`,
   Codex pre-flight CONVERGED R3 + IMPL CONVERGED R1; pre-flight
   `d842251..bbde3d5`). Release-prep at `0147883..ee96681` (4
   commits).
   M39/M40/M41 (SDK 15.x) + M44/M45 (SDK 16.x)
   stay DEFERRED — SDK still 14.0.0. §22 R-class register populated at
   the M50 pre-flight refactor-audit (R-v0.9-NEW-1/2 + carried-forward
   v0.8 watch-items R-v0.8-NEW-19/20/21/22 + promoted R-v0.8-NEW-23/24/25
   → M50/M51/M52; **R-v0.8-NEW-23/24/25 all RESOLVED at M50/M51/M52**)
   + the M50 IMPL refactor-audit (R-v0.9-NEW-3
   contract-term-checklist doc-surface / line-wrap miss, MEDIUM;
   **R-v0.9-NEW-4 RESOLVED/KEEP at M51** — fetch retained as a
   regression-guard affordance, M51 used a separate query) + the **M51
   refactor-audit** (R-v0.9-NEW-5 board-projection schema fragmentation
   across 4 schemas, LOW, **stays OPEN at M52 close** — touched 1/4
   schemas, ≥2 lift trigger UNMET; **R-v0.9-NEW-6 GRADUATED into
   testing.md at M52 close** — `match_query` selection-pin for
   raw-GraphQL SDK-drift fields, 2nd consumer `views` landed;
   **R-v0.9-NEW-7 GRADUATED into workflow.md at M52 close** —
   shared-vs-single-sourced field-add scope-check, 2nd instance
   landed with the heavy-single-sourced choice) + the **M52
   close-docs refactor-audit** (R-v0.9-NEW-8 `Item.description`
   read-side coverage paired with v0.7-M40 reopen, MEDIUM,
   user-directed at M52 close; R-v0.9-NEW-9 shared
   `BoardMetadata` fixture factory after the ~33-fixture M52
   mass-update, MEDIUM watch-item; R-v0.9-NEW-10 `jsonScalarOrNull`
   helper lift candidate, LOW watch-item; R-v0.9-NEW-11
   fixture-leftover-detection at close-docs after the M3 e2e M51
   leftover catch, MEDIUM; R-v0.9-NEW-12 Codex pre-flight
   findings-first behavior under `-xhigh` reasoning, LOW-MEDIUM).
5. **[`docs/v0.8-plan.md`](./docs/v0.8-plan.md)** — shipped M49 (P1
   file-upload wire fix) + M46 (multi-file `--set`) + M47 (stdin
   `--set`) + M48 (board_relation/dependency settings) + the refactor
   cluster; re-scoped off the original 2026-07 SKELETON (M44/M45)
   per the v0.7-pivot precedent. §22 R-class log (R-v0.8-NEW-*) —
   **R-v0.8-NEW-22 PROMOTED to v0.10-M53 at this session**
   (status flipped OPEN → PROMOTED 2026-05-22).
6. **[`docs/v0.7-plan.md`](./docs/v0.7-plan.md)** — shipped M42 +
   M43 (the v0.6.x bulk + create file `--set` carve-out folds);
   M39 (API `2026-04` pin bump) + M40 (`item set-description`) +
   M41 (`doc block-create-bulk`) **DEFERRED 2026-05-20** pending
   `@mondaydotcomorg/api` SDK 15.x with `CURRENT_VERSION = '2026-04'`
   natively. §22 R-class log (R-v0.7-NEW-1 through R-v0.7-NEW-5 —
   R-v0.6-NEW-1 graduated at the 5-consumer threshold; R-v0.6-NEW-2
   at the 5-discriminator threshold; R-NEW-82 ratified at the 5th
   consecutive release-prep consumer; R-v0.7-NEW-4 graduated into
   `.claude/rules/workflow.md` at M42 IMPL R7 + refined at R8;
   R-NEW-76 graduated from stub-anchored to wire-dispatch-anchored
   invariant at M43 IMPL).
7. **[`docs/v0.6-plan.md`](./docs/v0.6-plan.md)** — shipped M38
   (files-shaped friendly `--set`) with §22 R-class log
   (R-v0.6-NEW-*).
8. **[`docs/v0.5-plan.md`](./docs/v0.5-plan.md)** — shipped M34–M37
   with §22 R-class log (R-v0.5-NEW-*).
9. **[`docs/v0.4-plan.md`](./docs/v0.4-plan.md)** — shipped M29–M33
   with §22 R-class log (R-NEW-72 through R-NEW-84 graduated).
10. **[`docs/v0.3-plan.md`](./docs/v0.3-plan.md)** — shipped M19–M28
   with §22 R-class log (R-NEW-1 through R-NEW-43).
11. **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** — shipped M8–M18
    (R20–R53).
12. **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** — shipped M0–M7
    foundations.

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
docs/          # see "Current state"; cli-design.md is the contract
.claude/rules/ # path-scoped agent rules — see "Conventions"
```

## Conventions

Full coding standards live in `.claude/rules/` — files auto-load when
editing matching paths:

| File | Loads when editing | Topic |
|------|--------------------|-------|
| `typescript.md` | `src/**`, `tests/**` | TS strictness, no-`any`, no-`null`-by-default |
| `testing.md` | `tests/**` | Coverage standard, test layers, mocking rules |
| `validation.md` | `src/**`, `tests/**` | zod patterns — branded IDs, parse-at-boundary |
| `security.md` | source + `.env*` | Token handling, redaction, fail-secure config |
| `cli.md` | `src/cli/**`, `src/commands/**` | Output discipline, exit codes, signals, stdin |
| `workflow.md` | `src/**`, `tests/**`, `docs/v*-plan.md` | Pre-flight / IMPL / Codex / release-prep disciplines |
| `monday-api.md` | `src/api/**`, `src/commands/**`, `scripts/probe/**` | Endpoint, auth, version pin, SDK drift, pagination |

Headlines (full detail in the rule files):

- **Strictest TypeScript.** No `any` (lint enforced). Avoid `null`
  unless distinct from `undefined`.
- **Tests cover every branch.** Coverage floor 95 / 95.45 / 95 / 95
  (stmts / branches / fns / lines). Raise it; never lower it without
  an inline `vitest.config.ts` rationale.
- **Mock at the network boundary** (stub `fetch`/`undici` or SDK
  `request`), never `commands/*` helpers.
- **ESM with `.js` import specifiers** (NodeNext requirement).
- **One subcommand per file** in `src/commands/`, exported as
  `CommandModule`, registered in `cli/index.ts`.

## Contract headlines

Binding rules most likely to bite if forgotten. Full reasoning and
per-subsystem detail live in [`docs/cli-design.md`](./docs/cli-design.md)
at the linked section. **Don't restate per-subsystem detail here.**

- **Primary user is AI agents; humans are second-class.** When they
  conflict, agent ergonomics win. (§1)
- **Output:** table on TTY, JSON when piped; `--json` is the explicit
  alias. Tables truncate; JSON never does. (§3.1, §3.2)
- **Universal envelope** on every command. Success
  `{ok, data, meta, warnings}`; failure `{ok: false, error, meta}`.
  `meta` always carries `schema_version`, `api_version`, `request_id`,
  `source: "live"|"cache"|"mixed"|"none"`, `cache_age_seconds`,
  `retrieved_at`. Adding fields is non-breaking; removing/renaming is
  major. (§6.1)
- **29 stable error codes.** Errors carry `code`, `message`,
  `http_status`, `monday_code`, `request_id`, `retryable`,
  `retry_after_seconds`. Agents key off `code`, never English.
  Full list + `details.reason` discriminators in §6.5.
- **Exit codes:** 0 success, 1 usage / `confirmation_required`,
  2 API/network, 3 config, 130 SIGINT.
- **No interactive prompts ever.** Destructive ops without `--yes`
  return `confirmation_required`. (§3.1)
- **Two-level command depth** (`monday <noun> <verb>`); two carve-outs
  at three levels — `dev` namespace and `item time-track <verb>`.
  (§5.2)
- **Cursor pagination expires at 60 min — fail fast with
  `stale_cursor`, never silently re-issue.** (§5.6)
- **Column-value abstraction** is what makes `--set` work. Writable
  allowlist + `--set-raw <col>=<json>` escape hatch for
  `change_column_value`-shaped types. Friendly translator routes
  unsupported types to `unsupported_column_type` with hints. (§5.3)
- **`board describe` ships `example_set` per writable column** so an
  agent can construct `--set` calls from one read.

## Workflow rules

The milestone-specific disciplines (cross-doc greps, candidate-
selection, pre-flight stubs, Codex skip-conditions, release-prep
deferral slip) auto-load via `.claude/rules/workflow.md` when editing
`src/**`, `tests/**`, or `docs/v*-plan.md`. Always-on rules:

- **Auto-test:** `npm run typecheck && npm run lint && npm test` after
  any change. Failing gates block.
- **Auto-document:** new commands → update `docs/cli-design.md` §4.3
  + any contract changes. Update *this file's* "Contract headlines"
  only if a binding decision moved.
- **Two-AI review** for non-trivial design + per-milestone IMPL —
  Codex (gpt-5.5). See `workflow.md` for the invocation + skip rules.
- **Atomic, incremental commits.** One self-contained unit each.
  Messages explain WHY and HOW, not WHAT. Conventional Commits +
  SemVer. CI gates everything on Node 22 + 24; don't merge red.

## Monday API quick pointer

Endpoint `POST https://api.monday.com/v2`; auth via `Authorization:
<token>` header (no `Bearer ` prefix); API version pinned `2026-01`.
Full headlines (SDK drift, boundary-typing trap, pagination, rate
limits) in `.claude/rules/monday-api.md` (auto-loads on `src/api/**`
edits) and `docs/cli-design.md` §2.
