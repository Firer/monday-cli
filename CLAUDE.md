# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Current state

- **Published:** `monday-cli@0.7.0` on npm (`latest` dist-tag,
  2026-05-20T15:48:07Z). **v0.7.0 published — release complete.**
  **✅ P1 FIXED in-tree (v0.8-M49, `2ec67ad`, 2026-05-21; unreleased
  — still live-broken in published v0.7.0 until v0.8 publishes):**
  file uploads shipped the Apollo multipart spec, which live Monday
  rejects (`item upload` / `update upload` / file `--set` —
  M31/M38/M42/M43/M46). `multipart-transport.ts` now emits Monday's
  native shape (`query` + sibling `variables` + string-`map` + named
  part, POSTed to `/v2/file`); Codex R1 CONVERGED 0 findings;
  live-verified via a RUN_LIVE_TESTS-gated upload smoke test. Tests
  never caught it because the wire-shape assertion validated the wrong
  form (R-v0.8-NEW-9, now RESOLVED).
  Release-prep closed at `9b7e9ad..3e46f59` (5 commits: ToC audit +
  deferral slip `9b7e9ad` / README quickstart + scope refresh
  `3ca51ea` / version bump 0.6.0 → 0.7.0 + audit-fix
  `brace-expansion 5.0.2 → 5.0.5+` `75c8831` / CHANGELOG [0.7.0]
  `9ebaa81` / close-docs sweep `3e46f59`; envelope-snapshot refresh
  probe ran clean at release-prep open — zero diff vs M43 IMPL
  close — and folded into the close-docs prose per the v0.5 / v0.6
  precedent). Annotated `v0.7.0` tag pushed pointing at `3e46f59`;
  GitHub release live at
  https://github.com/Firer/monday-cli/releases/tag/v0.7.0. Previous:
  `monday-cli@0.6.0` (2026-05-18T16:30:21Z).
- **package.json version:** `0.7.0`.
- **Live numbers:** **4203 tests pass + 3 skipped** (post-M49 skips:
  the 2 pre-existing + the RUN_LIVE_TESTS-gated multipart-upload smoke
  test; the new green count adds the R-v0.8-NEW-11 shared-helper unit
  suite + the M46 coverage-arm tests). **✅ CI `test:coverage` now
  PASSES:** global **branch coverage 95.47% (4452/4663) vs the 95.45%
  floor** — the R-v0.8-NEW-10 gap (was 95.14%) is closed. Done by
  (i) the **R-v0.8-NEW-11** transport-helper lift (the duplicated
  defensive arms in `transport.ts` + `multipart-transport.ts` collapse
  into one tested `fetch-transport-helpers.ts`; all three now ZERO
  uncovered arms) + (ii) targeted M46 multi-file `--set` dispatch-arm
  tests (`item/create.ts` 82.31% → 86.58%; `item/update.ts` bulk-multi
  first-leg fail-fast arm). `item/update.ts` stays 79.42% — its
  residual uncovered arms are the R-v0.7-NEW-5 conditional-spreads,
  deferred to that lift. **29 ERROR_CODES**; **117 commands** (this
  session adds neither — a coverage + helper-lift pass); `npm audit`
  **0 vulnerabilities**.
- **CI status:** **fully green.** The v0.7.0 table-colour test flake
  (root cause: cli-table3's `@colors/colors` caches its enabled-state
  from ambient TTY detection, so `color: true` emitted no ANSI in a
  non-TTY CI worker) is **FIXED** at `a14802d` — `renderTable` now
  makes the resolved colour decision authoritative; the
  `test:coverage` branch-floor gap is closed (R-v0.8-NEW-10 RESOLVED,
  R-v0.8-NEW-11 SHIPPED — `docs/v0.8-plan.md` §22).
- **Next session:** CI is green (R-v0.8-NEW-10 + R-v0.8-NEW-11 closed
  this session). Two feature candidates remain — run the
  candidate-selection discipline (`workflow.md`) since 2+ remain:
  **(a) M47 — stdin file `--set` `<file-col>=-`** — UNBLOCKED (M49
  fixed the shared upload transport; probe DONE — `--filename` is
  OPTIONAL, default a non-empty placeholder; R-v0.8-NEW-2 rename folds
  in). **(b) M48 — writable board_relation settings** — independent
  (it's `create_column`, JSON not multipart; probe COMPLETE). Plus the
  committed **v0.8 refactor cluster** (R-v0.7-NEW-5 `reThrowDecorated`
  + R-v0.8-NEW-6 `projectCauseForEnvelope` — standalone `src/api/`
  lift; the R-v0.7-NEW-5 ratchet recovers the conditional-spread arms
  left uncovered in `item/update.ts`). **v0.8-M49 is DONE** (`2ec67ad`):
  `src/api/multipart-transport.ts` emits Monday's native multipart
  shape; full close at `docs/v0.8-plan.md` §3 M49.

  **v0.8 committed scope (post-M49), rough build order:**
  - **M49** — 🚨 P1 file-upload wire-format fix. **SHIPPED in-tree
    `2ec67ad`** (Codex R1 CONVERGED, live-verified).
  - **M47** — stdin file `--set` `<file-col>=-` (D7 closure).
    **UNBLOCKED by M49.** Probe DONE: `--filename` is OPTIONAL (any
    non-empty name works — `"stdin"` / default `"blob"`; empty → 500),
    so default a non-empty placeholder. R-v0.8-NEW-2
    (`enforceSingleFileColumnSet` rename) folds in here (shared
    `file-column-set.ts` touch).
  - **M48** — board_relation/dependency writable settings (probe
    COMPLETE — outcome (b) live-confirmed; single-leg; M19
    "no documented shape" REFUTED; create-time `defaults:
    {settings:{boardIds:[int],...}}` wires the relation, read back as
    unwrapped `settings_str`; Monday validates board existence →
    `not_found`; `dependency` diverges (host-self-ref). Independent
    of M49 — `create_column` is JSON, not multipart). Full result at
    §3 M48 entry; raw report at
    `scripts/probe/m48-board-relation-settings.report.txt`.
  - **v0.8 refactor cluster** (committed, prioritised on user
    demand) — R-v0.7-NEW-5 `reThrowDecorated` fail-fast-scaffold lift
    (4 consumers: clear / JSON-bulk / M42 file-bulk / M46
    file-bulk-multi; needs its own Codex pass + a 4-path coverage
    ratchet) + R-v0.8-NEW-6 `projectCauseForEnvelope` builder
    (3 consumers; bundled, both in mutation-path catch arms).
    Standalone `src/api/` lift — too broad to ride a feature IMPL.
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
  AND a paid-tier sandbox is available for the M40 wire probe.
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
