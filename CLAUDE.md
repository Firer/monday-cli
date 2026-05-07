# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.1.0 published; v0.2.0 in development on `main`.** M0–M15 shipped;
**M16 (board columns + cache invalidation) is next.**

**M15 closed** (see `docs/v0.2-plan.md` §3 M15 status block + §23
post-mortem):
- Six board lifecycle verbs (create / update / archive / delete /
  duplicate / add-users) shipped across **fifteen** atomic commits:
  one docs pre-flight (`a3b03c3`) + four pre-flight Codex rounds
  + six feat commits (`d7c342a` … `0088283`) + two implementation
  Codex rounds + R41 lift (`4756269`) + this docs close. Project
  coverage 98.96 / 95.04 / 99.48 / 99.14 (above the 94/95/95/95
  floor); 2023 tests passing.
- **R41 shipped at M15 close** in `4756269 refactor(r41): lift
  partial-success null-payload guard into api/response-root`.
  All 3 partial-success-fan-out consumers (workspace add-users +
  workspace remove-users + board add-users) migrate to the
  shared `assertResponseFieldPresent` helper; byte-identical
  post-lift; the assertion's signature pins the three parameter
  divergences (mutation root key / operation label / scope-id
  key+value) so future fan-out verbs adopt cleanly.
- **`board duplicate` introduces the M15-unique wrapped envelope
  shape** — `data: { board: <projection>, is_async }` per Monday's
  `BoardDuplication` SDK type. cli-design §6.1 universal envelope
  widened to `data: <resource | array | verb-specific JSON>` to
  acknowledge both this wrapper and the partial-success consumers'
  shape.

**M15 → M16 cleanup window** (R40 + R43 shipped; R42 + R44
remain — full detail in §22):
- **R40 shipped** in `541e5e7 refactor(r40): lift partial-
  success --users fan-out helper into api/users-fan-out-mutation`.
  All 3 consumers (workspace add-users + workspace remove-users
  + board add-users) migrate to `dispatchUsersFanOut` from
  `src/api/users-fan-out-mutation.ts`. Helper exposes
  `parseUsersArg` separately so each call site preserves the
  `parseArgv → parseUsersArg → resolveClient` order pinning
  `usage_error` (malformed `--users`) ahead of `config_error`
  (missing token). Net –766 LOC across three call sites + ~+360
  LOC in the new helper file.
- **R43 shipped** in `6b45abf refactor(r43): lift board mutation
  projection into api/board-mutation-result`. Five consumers
  (board create / archive / delete / update / duplicate) migrate
  to `projectMutationBoard` from
  `src/api/board-mutation-result.ts`. Mirrors R28
  (`projectMutationItem`) + R37 (`projectMutationUpdate`) — the
  third per-noun projection helper. Net –29 LOC across five
  board verbs + ~+50 LOC in the new helper.
- **R42 — retroactive missing-root-key distinction across pre-
  M14 mutation verbs** (~23 sites across M5b/M9-M13 + 6 new M15
  mutation sites) — remaining backlog. Schedule: post-M15
  dedicated session — bundling with the M15 sites lands the
  contract uniformly across the codebase before R-class
  accounting drifts further.
- **R44 — generic `projectMutationResource` over R28/R37/R43**
  stays deferred to v0.3 OR a fifth-noun trigger per §22 R44's
  entry; touching R44 now would re-touch all three per-noun
  helpers and scope-creep into a 4-noun refactor.

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
