# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Current state

- **Published:** `monday-cli@0.8.0` on npm (`latest` dist-tag,
  2026-05-21T23:45:48Z). **v0.8.0 published — release complete.**
  Annotated `v0.8.0` tag pushed pointing at `090fb76`; GitHub release
  live at https://github.com/Firer/monday-cli/releases/tag/v0.8.0. The
  🚨 P1 file-upload wire fix (v0.8-M49, `2ec67ad`) is now
  **LIVE-RESOLVED in the published artifact**: `item upload` /
  `update upload` / file `--set` — broken in published v0.7.0 across
  M31/M38/M42/M43/M46 by the Apollo multipart spec that live Monday
  rejects — now work live. `multipart-transport.ts` emits Monday's
  native shape (`query` + sibling `variables` + string-`map` + named
  part, POSTed to `/v2/file`); live-verified via a RUN_LIVE_TESTS-gated
  smoke test (R-v0.8-NEW-9 RESOLVED + graduated into `testing.md`).
  **v0.8 release-prep cluster** (`66d5142..090fb76`, 6 commits;
  mirrors the v0.7 precedent + one extra user-requested commit):
  deferral slip v0.8 → v0.9 + ToC M46/M47/M48 sync
  (`66d5142`, `slip stale v0.8 deferral to v0.9`) / README v0.8
  quickstart + scope refresh (`aef9d32`) / version bump 0.7.0 → 0.8.0
  — no audit-fix folded, `npm audit` clean (`2152244`) / CHANGELOG
  [0.8.0] headlining the M49 P1 fix (`c930d27`) / **user-facing
  help-text cleanup** stripping internal §/version/M-number refs from
  `monday help` + verb `--help` (`40a58d0`, user-requested — also fixed
  a stale `doc` noun description still claiming "read-only at v0.4") /
  close-docs sweep (`090fb76`). Envelope-snapshot refresh probe ran
  clean (zero diff vs M48 IMPL close, 162 snapshots) — folded into this
  close-docs prose per the v0.5/v0.6/v0.7 precedent. Previous:
  `monday-cli@0.7.0` (tag `3e46f59`, 2026-05-20T15:48:07Z);
  `monday-cli@0.6.0` (2026-05-18T16:30:21Z).
- **package.json version:** `0.8.0`.
- **Live numbers:** **4254 tests pass + 3 skipped** (3 skips
  unchanged: the 2 pre-existing + the RUN_LIVE_TESTS-gated
  multipart-upload smoke test; the +16 pre-flight block plus the
  **v0.8-M48 IMPL** net +1 — the 2 `m48_preflight_stub` PIN tests
  converted to 2 live wire-shape assertions (`match_variables:
  {defaults: {settings: {…}}}`, whole-`defaults` JSON.stringify-pinned)
  + a RESERVED-literal regression guard). **✅ CI `test:coverage`
  PASSES:** global **branch coverage 95.91% (4484/4675) vs the 95.45%
  floor** (HOLDS across the M48 IMPL — the removed c8-ignored stub block
  contributed no counted branches, and the new `variables.defaults =
  CREATE_TIME_SETTINGS_WRAP_TYPES.has(type) ? {settings} : settings`
  ternary's two arms are both covered: board_relation/dependency hit the
  `{settings}` arm, status/dropdown/numbers hit the bare arm). **29
  ERROR_CODES**; **117 commands** (M48 added neither — `--settings` is
  an existing flag; the `m48_preflight_stub` `details.reason` literal
  has DISAPPEARED from runtime at IMPL and stays RESERVED, regression-
  guarded; the dependency board-target rejection is an existing
  `usage_error` with a `details.rejected_keys` shape); **functions
  98.97% (1349/1363)**; `npm audit` **0 vulnerabilities**. Earlier
  coverage contributors still hold: the **v0.8 refactor cluster**
  (`item/update.ts` 79.42% → 87.27%), **R-v0.8-NEW-11** transport-helper
  lift, the M46 dispatch-arm tests (`item/create.ts` 82.31% → 86.58%).
  **Release-prep held all numbers** — the deferral slip changed test
  names/assertions only, and the help-text cleanup is string-only (no
  new tests/branches); re-verified green at the close-docs gate.
- **CI status:** **fully green.** The v0.7.0 table-colour test flake
  (root cause: cli-table3's `@colors/colors` caches its enabled-state
  from ambient TTY detection, so `color: true` emitted no ANSI in a
  non-TTY CI worker) is **FIXED** at `a14802d` — `renderTable` now
  makes the resolved colour decision authoritative; the
  `test:coverage` branch-floor gap is closed (R-v0.8-NEW-10 RESOLVED,
  R-v0.8-NEW-11 SHIPPED — `docs/v0.8-plan.md` §22).
- **Next session:** **v0.9 candidate-selection** (R-NEW-75 dedicated
  session). **v0.8.0 is PUBLISHED + release-complete** — push + `npm
  publish` + annotated `v0.8.0` tag (`090fb76`) + GitHub release all
  done (npm 2026-05-21T23:45:48Z); v0.8 release-prep SHIPPED at
  `66d5142..090fb76`, and this post-publish flip commit completes the
  release (status + LIVE-RESOLVED + SHA-backfill; needs a push). The
  v0.9 backlog is M44 / M45 (user-entity migration + `user activity`) +
  the v0.7-deferred M39 / M40 / M41 cluster — all gated on
  `@mondaydotcomorg/api` SDK 15.x (`2026-04`) / 16.x (`2026-07`)
  publishing, which had not happened at the v0.8 candidate-selection
  commit (SDK still 14.0.0). Process adoptions at the v0.8 close-docs:
  **R-v0.8-NEW-7 ADOPTED** (commit-subject refs over bare SHAs in NEW
  prose); **R-v0.8-NEW-8 + R-v0.8-NEW-4 stay deferred watch-items**
  (M47/M48 added no new emit shape, so the `outputSchema` audit-point
  stayed at 1 occurrence; the envelope-snapshot probe ran clean, so
  R-v0.8-NEW-4's schema-parse-test trigger was not met).
  **One extra release-prep commit beyond the baseline:** a
  user-requested help-text cleanup (`40a58d0`) stripping internal
  §/version/M-number refs from `monday help` + verb `--help` — pure
  string edits across 31 command files, gate-verified
  (typecheck + lint + 4254 tests), so the R-NEW-84 mechanical-skip
  spirit held (no Codex).
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
  `create_doc_blocks`) RE-OPENS only when `@mondaydotcomorg/api`
  SDK 15.x publishes with `CURRENT_VERSION = '2026-04'` natively
  AND the M40 `set_item_description_content` wire becomes reachable
  (2026-05-22 re-probe on a new admin-scoped free-tier account: still
  untyped `INTERNAL_SERVER_ERROR { service: 'docs-api' }` across all
  variations, while workspace docs work on the SAME account → most
  likely a Monday-side defect specific to item descriptions, NOT
  paid-tier gating; v0.7-plan §3 M40 + user-memory).
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
2. **[`docs/v0.8-plan.md`](./docs/v0.8-plan.md)** — **SKELETON**
   (filed forward 2026-05-18). v0.8 = Monday API 2026-07 pin +
   user-entity migration (M44) + `user activity` (M45) PLUS the
   v0.7-deferred M39 / M40 / M41 re-open candidates (API
   `2026-04` pin + item set-description + doc block-create-bulk)
   pending SDK 15.x publication. Ratified at v0.8 kickoff
   candidate-selection AFTER v0.7.0 ships AND v0.7.x
   candidate-selection runs.
3. **[`docs/v0.7-plan.md`](./docs/v0.7-plan.md)** — shipped M42 +
   M43 (the v0.6.x bulk + create file `--set` carve-out folds);
   M39 (API `2026-04` pin bump) + M40 (`item set-description`) +
   M41 (`doc block-create-bulk`) **DEFERRED 2026-05-20** to a
   future release pending `@mondaydotcomorg/api` SDK 15.x with
   `CURRENT_VERSION = '2026-04'` natively + a paid-tier sandbox
   for the M40 wire probe. §22 R-class log
   (R-v0.7-NEW-1 through R-v0.7-NEW-5 — R-v0.6-NEW-1 graduated
   at the 5-consumer threshold; R-v0.6-NEW-2 graduated at the
   5-discriminator threshold; R-NEW-82 ratified at the 5th
   consecutive release-prep consumer; R-v0.7-NEW-4 graduated
   into `.claude/rules/workflow.md` at M42 IMPL R7 + refined
   at R8; R-NEW-76 graduated from stub-anchored to wire-
   dispatch-anchored invariant at M43 IMPL).
4. **[`docs/v0.6-plan.md`](./docs/v0.6-plan.md)** — shipped M38
   (files-shaped friendly `--set`) with §22 R-class log
   (R-v0.6-NEW-*).
5. **[`docs/v0.5-plan.md`](./docs/v0.5-plan.md)** — shipped M34–M37
   with §22 R-class log (R-v0.5-NEW-*).
6. **[`docs/v0.4-plan.md`](./docs/v0.4-plan.md)** — shipped M29–M33
   with §22 R-class log (R-NEW-72 through R-NEW-84 graduated).
7. **[`docs/v0.3-plan.md`](./docs/v0.3-plan.md)** — shipped M19–M28
   with §22 R-class log (R-NEW-1 through R-NEW-43).
8. **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** — shipped M8–M18
   (R20–R53).
9. **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** — shipped M0–M7
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
