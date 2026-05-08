# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.1.0 published; v0.2.0 in development on `main`.** M0–M17 shipped;
**M18 (NDJSON streaming + 0.2.0 release prep) is next.**

**M17 closed** (see `docs/v0.2-plan.md` §3 M17 status block + §25
post-mortem):
- Five group lifecycle verbs (group-create / group-update /
  group-archive / group-duplicate / group-delete) shipped across
  **eight** atomic commits since the M17 pre-flight contract
  `bed75c6` landed: five feat (`df5a2ae` group-create / R48 lift,
  `c44a899` group-update, `b25b20a` group-archive, `7019868`
  group-duplicate, `32965bd` group-delete) + two implementation
  Codex round fix-ups (`c056c11` round-1 P2 fix-ups + `c8a1288`
  round-2 P3 stale-comment fix-up) + this docs close. Project
  coverage 99.04 / 95.51 / 99.51 / 99.17 (above the 94/95/95/95
  floor); 2218 tests passing.
- **R48 shipped at M17 implementation start** in `df5a2ae feat(m17):
  add board group-create — R48 group projection helper + first
  group verb`. New `src/api/group-mutation-result.ts` exports
  `projectMutationGroup` + `GROUP_FIELDS_FRAGMENT` +
  `groupProjectionSchema`; all five M17 group verbs adopt the
  helper from day one (mirrors R45's M16-implementation + R39's
  M15-implementation timing — third milestone running this
  pattern). The `idKey: 'group_id' | 'name'` parameter pins the
  per-noun divergence (group-create uses `name` for the pre-id
  throw shape; group-update / group-archive / group-duplicate /
  group-delete use `group_id`); `boardId` is always paired since
  every group wire signature is two-tuple.
- **`GROUP_COLOR_VALUES` palette shipped in `src/api/group-color.ts`**
  at the round-1 P2 fix in `c056c11`. 41-name palette covering
  Monday's documented group colours; both `group-create` and
  `group-update` consume it via `z.enum(GROUP_COLOR_VALUES)` so
  invalid colour names surface as `usage_error` (exit 1) BEFORE
  any network call. The M17 implementation owns the field set per
  cli-design §4.3 — the contract pins the SHAPE, the implementation
  owns the values (mirrors M16 column-types.ts).
- **R29 destructive-gate `extraDetails` slot consumer-count rises
  1 → 3.** M16 column-delete shipped the slot extension; M17
  group-archive + group-delete are the 2nd + 3rd two-tuple
  consumers. All three echo `{board_id, <noun>_id, hint}` per
  cli-design §6.5 single-target shape.
- **R46 `withBoardInvalidation*` consumer-count rises 6 → 11.**
  M17 adds five new consumers: group-create + group-archive +
  group-duplicate + group-delete adopt
  `withBoardInvalidationSingleLeg` (4 new single-leg, total 8);
  group-update adopts `withBoardInvalidationFanOut` (3rd fan-out
  consumer after column-update + board-update).

**M17 → M18 cleanup window** (R51 scheduled for the cleanup
window; full detail in §22):
- **R51 — `findBoardChildOrThrow` helper.** New post-M17 finding;
  3-consumer pattern surfaced by M17 implementation review
  (column-update + group-update + group-archive each load board
  metadata, find a child by ID, throw `not_found` with
  `details: {board_id, [<kind>_id]: id}` if absent). Three call
  sites collapse from 14 lines each to a single helper call;
  pure boilerplate consolidation. Schedule: M17 → M18 cleanup
  window (mirrors R40 + R43 + R46's M15→M16 / M16→M17 cadence).
- **R49 candidate** (snapshot-bearing destructive-archive dry-run
  helper) — evaluated at M17 close and deferred to v0.3. The three
  archive verbs (item-archive / board-archive / group-archive)
  diverge enough on snapshot-loading semantics that a unified
  helper signature exceeds the >4-parameter heuristic.
- **R50 candidate** (1-surface attribute fan-out helper) — deferred
  to v0.3. Two consumers post-M17 (board-update + group-update);
  below the 3-consumer trigger.
- **R42** (retroactive missing-root-key sweep across ~32 sites
  including the 5 new M17 mutation sites) — stays deferred to a
  focused post-M17 dedicated cleanup session distinct from the
  M17 → M18 cleanup window.
- **R44** (generic `projectMutationResource` over R28/R37/R43/R45/R48)
  stays deferred to v0.3 OR a sixth-noun trigger; touching R44 now
  would re-touch five per-noun helpers and scope-creep into a
  six-noun refactor.

**M16 closed** (see `docs/v0.2-plan.md` §3 M16 status block + §24
post-mortem):
- Three column lifecycle verbs (column-create / column-update /
  column-delete) PLUS three M15 retrofitted verbs (board update /
  archive / delete now call `invalidateBoard(boardId)` post-success
  per cli-design §8 eager-invalidation contract) shipped across
  **ten** atomic commits: two docs prelude (`ea74d7a` + `c42b751`)
  alongside the seven-round pre-flight (`c0efab5`, the heaviest
  pre-flight to date — 22 contract bugs caught before any code
  shipped) + six feat commits (`26aa821` column-create / R45 lift,
  `08ef580` column-update, `565d5d3` column-delete, `4580af7`
  board update retrofit, `15a353b` board archive retrofit,
  `20bfeea` board delete retrofit) + two implementation Codex
  rounds (`f94c2fa` round-1 P2 fix-ups + `95009ae` round-2 P3
  diagnostic) + this docs close. Project coverage 99.01 / 95.43 /
  99.49 / 99.14 (above the 94/95/95/95 floor); 2127 tests passing.
- **R45 shipped at M16 implementation start** in `26aa821 feat(m16):
  add board column-create — R45 column projection helper + first
  column verb`. New `src/api/column-mutation-result.ts` exports
  `projectMutationColumn` + `COLUMN_FIELDS_FRAGMENT` +
  `columnProjectionSchema`; the three M16 column verbs adopt the
  helper from day one (mirrors R39's M15-implementation timing).
  The `columnIdKey: 'column_id' | 'title'` parameter pins the per-
  noun divergence (column-create uses `title` for the pre-id throw
  shape; column-update + column-delete use `column_id`); `boardId`
  is always paired since the wire signature is two-tuple.
- **`invalidateBoard(boardId, env?)` shipped in `src/api/cache.ts`**
  as the §8 contract's exported primitive — a thin wrapper over
  `clearEntry(root, { kind: 'board', boardId })` that owns cache-
  root resolution. Idempotent (no-op on missing entry). Six call
  sites adopt it: three M16 column verbs (single-leg + fan-out)
  plus three M15 retrofitted verbs (board update fan-out, board
  archive + delete single-leg). Coexists with the M3-era
  `evictBoardMetadata` in `board-metadata.ts` (parallel re-export
  rather than a rename, so the existing test surface stays
  unchanged).
- **R29 destructive-gate helper grew an `extraDetails` slot** in
  `565d5d3` to support two-tuple destructive verbs (column-delete
  echoes `{board_id, column_id, hint}` per cli-design §6.5 single-
  target shape; the wire signature is two-tuple). The existing
  seven single-id consumers stay byte-identical post-extension
  (the canonical `[detailKey]: target` + `hint` always win on key
  collision; `extraDetails` merges FIRST). M17's group-archive +
  group-delete will reuse the same slot.
- **`READ_ONLY_FOREVER_TYPES` reclassification.** M16 pre-flight
  pinned `item_assignees` as read-only-forever (cli-design §4.3
  column-create) — Monday computes it server-side from people
  columns; never writable via the API. Extended the set in
  `src/api/column-types.ts`; `--set-raw item_assignees=<json>`
  now rejects at column-resolution time rather than waiting for
  Monday's wire `validation_failed`.

**M16 → M17 cleanup window** (R46 shipped at the cleanup window;
R45 shipped at M16 implementation start):
- **R46 — `withBoardInvalidation` post-success projection wrapper**
  shipped in `5b06d53 refactor(r46): lift withBoardInvalidation
  post-success projection wrapper into api/board-mutation-
  invalidation` (mirrors R40 + R43's M15 → M16 cleanup-window
  cadence). New `src/api/board-mutation-invalidation.ts` exports
  two wrappers that pin the §8 leg-count split in the type system:
  `withBoardInvalidationSingleLeg` and
  `withBoardInvalidationFanOut`. M17's five group verbs (single-
  leg + fan-out mix) adopted the helpers from day one — total
  consumer count post-M17 is 11 (8 single-leg + 3 fan-out).

The three binding documents — read in this order before writing code:

1. **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical
   contract: command surface, output envelope, 26 stable error codes,
   deferral list, every binding decision. Changes land via PRs that
   argue for the change, not by drift.
2. **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** — active plan:
   milestones M8–M18 with deliverables, exit criteria, decisions log,
   per-milestone post-mortems (M8/M9/M10/M11/M12 + R-class refactor
   backlogs).
3. **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** — shipped foundations
   M0–M7 with M2.5 refactor pass and the M5a/M5b split. Reference for
   patterns every later milestone builds on.

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
- **26 stable error codes** (`usage_error` / `not_found` /
  `ambiguous_column` / `column_archived` / `unsupported_column_type` /
  `rate_limited` / `complexity_exceeded` / `stale_cursor` / etc.).
  Errors carry `code`, `message`, `http_status`, `monday_code`,
  `request_id`, `retryable`, `retry_after_seconds`. Agents key off
  `code`, never English. (§6.5)
- **Exit codes:** 0 success, 1 usage / `confirmation_required`,
  2 API/network, 3 config, 130 SIGINT.
- **No interactive prompts ever.** Destructive ops without `--yes`
  return `confirmation_required`. (§3.1)
- **Two-level command depth** (`monday <noun> <verb>`); `dev` namespace
  carved out at three levels. (§5.2)
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
