# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Current state

- **Published:** `monday-cli@0.6.0` on npm (`latest` dist-tag,
  2026-05-18T16:30:21Z). **v0.6.0 published — release complete.**
  Release-prep closed at `98185d4..51ba1a4` (5 commits: ToC audit
  + slip / README refresh / version bump + audit-fix / CHANGELOG /
  close-docs sweep; envelope-snapshot probe ran clean + folded
  into close-docs prose per the v0.5 precedent). Annotated
  `v0.6.0` tag pushed pointing at `51ba1a4`; GitHub release live
  at https://github.com/Firer/monday-cli/releases/tag/v0.6.0.
  Previous: `monday-cli@0.5.0` (2026-05-17T20:55:05Z).
- **package.json version:** `0.6.0`.
- **Live numbers:** 4115 tests + 1 skipped across 172 files (was
  4113 + 1 at v0.6.0 / v0.7-M42 baseline; +2 from v0.7-M43
  pre-flight `kind: 'file_create'` clean-path unit test + the
  multi-file-on-create regression-guard); coverage 98.85 / 95.82
  / 99.16 / 99.14 (stmts / branches / fns / lines) at the
  95 / 95.45 / 95 / 95 floor (branches margin **0.37pp**
  unchanged from v0.7-M42 IMPL baseline — M43 pre-flight stub
  helper body is c8-ignored, so no further branches absorption;
  was 1.01pp at v0.6.0 baseline — v0.7-M42 IMPL absorbed the
  0.64pp drop across foldAndRemap-decorated ApiError ctor +
  SourceAggregator seed-vs-record arms; full breakdown in
  `docs/v0.7-plan.md` §3 M42 "Coverage residual"); **29
  ERROR_CODES**; **117 commands**; `npm audit` 0 vulnerabilities
  (audit-fix `fast-uri 3.1.0 → 3.1.2` folded into the
  version-bump commit per security.md "high = merge blocker").
- **Next session:** v0.7-M43 **IMPL** — runtime body for two-leg
  create+file dispatch. **M43 pre-flight contract diff cluster
  SHIPPED at `28f117c..ea71b55`** (7 commits: R0 contract diff
  + R1-R5 Codex pre-flight fix-ups + §22 watch-items annotation
  close-out; cycle CONVERGED at R5 with 0 P1 across all 5
  rounds — every finding was prose-drift on the contract-term
  surface). D1-D3 closed:
  - **D1 — Atomicity envelope: (b) orphan-warn.** Leg-2 failure
    surfaces `internal_error` with `details.reason:
    'create_then_file_upload_partial_failure'` +
    `details.created_item_id` echoing leg-1's orphan +
    `details.column_id` + `details.cause` (M31 wire failure
    surface) + `details.hint` directing agents to retry leg-2
    only (`monday item set <iid> <file-col>=<path>`) OR
    rollback (`monday item delete <iid>`). Closure rationale:
    pre-flight rollback-viability probe could not run
    empirically (token lacked `create_item` permission on a
    token-created sandbox workspace + existing-board attempts
    correctly blocked by harness modify-shared-state guards).
    Defaulting to (b) under uncertainty preserves the agent's
    recovery handle without introducing a destructive
    `delete_item` cleanup leg whose own failure mode is
    unaccounted for. M43 IMPL revisits if user-authorized probe
    surfaces concrete rollback-reliability data.
  - **D2 — Dry-run envelope:** two `planned_changes` entries
    (`operation: 'create_item'` / `'create_subitem'` with
    bundled non-file `column_values`, then `operation:
    'add_file_to_column'` with file pre-check echo).
  - **D3 — ERROR_CODES delta:** zero. Registry stays at 29.
    Atomicity failures route through existing `internal_error`
    with the new `create_then_file_upload_partial_failure`
    `details.reason` discriminator.

  Pre-flight stubs: `enforceSingleFileColumnSet` +
  `preCheckM38FileDispatch` extended with `kind: 'file_create'`
  variant; `runItemCreateFileDispatch` helper stub in
  `src/commands/item/create.ts` (mirrors M42's
  `runItemUpdateBulkFileDispatch` shape) throws
  `internal_error` with `details.reason: 'm43_preflight_stub'`
  per R-NEW-76 (parseArgv-BEFORE-c8 discipline). Existing
  v0.6-M38 integration + unit tests asserting
  `'file_set_on_create_unsupported'` flipped to assert the
  stub envelope + regression-guard the v0.6 literal's absence;
  mixed-rule SUPPRESSION on `'item_create'` callShape (D6
  asymmetry — `create_item` bundles non-file `column_values`
  atomically into leg-1) unit-tested. M43 inherits the
  R-v0.7-NEW-4 pre-IMPL contract-term checklist (graduated
  v0.7-M42 IMPL R7); the full M43 checklist is committed
  inline at `docs/v0.7-plan.md` §3 M43 entry. Apply from
  R1 onwards as the post-fix-up grep checklist to short-
  circuit the W9 prose-escalation pattern M42 absorbed across
  8 rounds.

  M42 **SHIPPED** at `22df2fa..08ae263` (R0 IMPL + 8 Codex
  fix-up rounds: R1 behavioral [foldAndRemap + SourceAggregator
  + partial-success invalidate]; R2-R8 W9 prose sweep —
  asymptotic convergence with the R7 workflow.md graduation
  of "Pre-IMPL contract-term checklist for cross-doc grep"
  intended to short-circuit the pattern at v0.7-M43 onwards).
  Per-item multipart fan-out helper `runItemUpdateBulkFileDispatch`
  ships with `foldAndRemap` per-item + `SourceAggregator` over
  metadata + M38 pre-check + walk + dispatch legs + fail-fast
  partial-success invalidate + full envelope
  (`operation: 'item_update_bulk_file_set'`).

  IMPL Codex review estimate 4-5 fix-up rounds (similar profile
  to M42 — non-atomic two-leg). M43 close-docs re-probes
  `npm view @mondaydotcomorg/api versions --json | tail` +
  decides M39 D1 between (a) SDK 15.x lift if shipped /
  (b) string-literal override on SDK 14.0.0 + hand-rolled zod
  schemas per the "Boundary-typing trap" pattern / (c) continued
  wait. Full v0.7 scope (M39-M43) unchanged from SKELETON.
  v0.8 SKELETON stays unratified (opens after v0.7.0
  publishes). Other carry-forward backlog (multi-level subitems
  / cross-board move value-overrides / resumable cross-board
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
   user-entity migration (M44) + `user activity` (M45). Ratified
   at v0.8 kickoff candidate-selection AFTER v0.7.0 ships.
3. **[`docs/v0.7-plan.md`](./docs/v0.7-plan.md)** — **SKELETON**
   (filed forward 2026-05-18). v0.7 = Monday API 2026-04 pin +
   item set-description (M40) + doc block-create-bulk (M41) +
   v0.6.x bulk + create file `--set` carve-outs (M42 / M43).
   Ratified at v0.7 kickoff candidate-selection (next session).
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
