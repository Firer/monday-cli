# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.3-M22 closed; M23 unblocked.** v0.2.0 published to
npm 2026-05-08. v0.3 is in progress on `main`; M0–M22 closed.
M22 implementation (`3a1b465`) lands the runtime DNS / TCP / TLS /
auth / cache / redaction / env-var probes for `monday status` +
the `platform_api.daily_*` projection for `monday usage`, preceded
by a small refactor (`84c6d2b`) narrowing the redact-layer
non-string scalar preservation to the boolean/number/null
allowlist (security-bearing tightening per Codex M22 W8).

Per-milestone narratives, post-mortems, and R-class history live
in the plan docs — **do not duplicate them here**:
- `docs/v0.3-plan.md` §11 M19, §12 M20, §13 M21, §14 M22
  post-mortems + §22 R-class backlog (R-NEW-1 + R-NEW-4 shipped +
  R-NEW-2 / R-NEW-3 / R-NEW-5 / R-NEW-6 candidates open +
  R-watch-items).
- `docs/v0.2-plan.md` §3 + §X post-mortems for M8–M18 + §22 for
  R20–R53.
- `docs/v0.1-plan.md` for M0–M7 + M2.5 refactor pass.

**Live numbers (post-M22 close):**
- Test count: **2737** across 118 files (was 2652 at post-M22
  pre-flight; +85 net in the M22 implementation diff: ~48
  `tests/unit/api/probes.test.ts` runtime-body tests across the
  seven probes (per-failure-mode reason discriminants + timeout
  + abort cases), 5 `tests/unit/api/usage.test.ts` fetchUsage
  runtime + parse-drift tests, ~20 new `tests/unit/commands/
  status.test.ts` orchestration tests (a new file for the
  extracted `orchestrateStatusProbes` + `deriveOverall` +
  `resolveStatusTransport` helpers), ~9 `tests/integration/
  commands/diagnostics.test.ts` success-envelope + error-envelope
  tests for `monday status` + `monday usage`, plus a redact test
  for the M22 non-string-scalar preservation rule).
- Coverage: **99.08 / 95.45 / 99.29 / 99.29** (stmts / branches /
  fns / lines), at the **95 / 95.45 / 95 / 95** floor. The M22
  implementation removes the API-layer stub `c8 ignore` wraps
  (the bodies are now test-reachable via injected seams), adds
  `c8 ignore start/stop` to the production-only `defaultDnsLookup`
  / `defaultTcpConnect` / `defaultTlsConnect` real-socket-binding
  paths (unreachable from unit tests by design), and to a handful
  of defensive helpers (`isMissingTokenConfigError` Array.isArray
  guard, `errorCode`/`errorMessage`/`asError` non-Error fallbacks,
  cache_writability non-ENOENT/permission_denied/write_failed
  paths). Branches margin is currently **0pp** (right at the
  floor); post-M22 cleanup may re-raise the floor or recover
  margin via the seam-injected `Symbol.dispose` ergonomic but
  that's an M23-pre-flight-time evaluation.
- ERROR_CODES count: **29** (no new code at M22 implementation —
  probe failures map to existing codes per cli-design §11.5.1).
  Command count: **76** (no new commands at M22 implementation;
  `monday status` + `monday usage` already registered at the M22
  pre-flight).
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
1. **M23 pre-flight** — cross-board `monday item search` +
   `monday board favorites`. Mirrors the v0.3 pre-flight discipline
   (empirical probe of any novel API surface; contract diff
   commit with module signatures under `c8 ignore`; Codex
   pre-flight review; implementation; Codex review; close-docs
   sweep). Per the M22 post-mortem the 7-section pre-flight prompt
   structure repeats verbatim from M21+M22 — at M23 pre-flight,
   R-NEW-6 (template at `.claude/templates/codex-pre-flight
   -review.md`) fires for ratification.
2. **`monday usage` timezone semantics verification** — M22
   shipped with UTC `YYYY-MM-DD` as the `today` key derived from
   `ctx.clock().toISOString().slice(0, 10)`. The pre-flight probe
   captured an empty `by_day` list so the timezone pin remains
   inferred from the sibling `last_updated`'s `ISO8601DateTime`
   scalar. Re-probe `scripts/probe/m22-usage-by-day.ts` against an
   account with live usage activity (or a one-off bootstrap call
   to populate the series). If Monday's runtime `day` field turns
   out to be account-local, amend cli-design §11.5.3 + flip
   `formatTodayKey` in `src/commands/usage.ts`. Pure helpers
   (`sumUsageForDay`, `projectUsageOutput`) treat `day` as an
   opaque equality key; the change is local to the command-action
   `today` derivation.
3. **Coverage-floor margin recovery** — M22 close lands at exactly
   95.45% branches (0pp margin). The remaining uncovered branches
   are split between defensive guards in helpers
   (`errorCode`/`errorMessage`/`asError` non-Error fallbacks, the
   `isMissingTokenConfigError` Array.isArray guard) and
   production-only OS-call paths (real DNS/TCP/TLS bind). Most
   are already `c8 ignore`d; an M23-pre-flight-time audit can
   either re-raise the floor with a confidence-margin lift or
   widen the seam-injected matrix to recover branches without
   real-network reliance.
4. **Pre-publish blocker still open** — OAUTH_CLIENT_ID /
   OAUTH_CLIENT_SECRET constants in `src/api/oauth.ts` still ship
   as `<UNREGISTERED_PENDING_OAUTH_APP>`. Externally-blocked on
   registering a Monday OAuth app; tests don't depend on the
   values. Tracked for v0.3.0 release prep (after M28).

**R-class state (post-M22 close)**
(full detail in `docs/v0.3-plan.md` §22):
- **Shipped:** R-NEW-1 `isENOENT` lift into `src/utils/fs.ts`
  (`1c77699`, M21 close); R-NEW-4 `statusOutputSchema` +
  `probeResultSchema` import-from-api/probes lift (`0b5af57`,
  post-M22 pre-flight drift sweep); R-NEW-7 `formatMode` lift
  into `src/utils/fs.ts` (post-M22 close — 3-consumer trigger
  fired when the M22 cache_writability probe added the third
  named copy beyond `src/api/cache.ts` + `src/config/credentials.ts`;
  mirrors R-NEW-1 cadence verbatim). The M22 implementation
  also added orchestration extractions (`orchestrateStatusProbes`
  + `deriveOverall` + `resolveStatusTransport` exported from
  `src/commands/status.ts` for direct unit-testing); not an
  R-class lift in the traditional sense but the same shape —
  pure helpers split out of a command action for independent
  test coverage of the network-probe short-circuit cascade +
  the §11.5.2 overall-mapping rules.
- **Open candidates:** R-NEW-2 `credentialsHomeOptions`
  (fires at `monday auth status`, v0.3.x); R-NEW-3
  `wrapFsError` factory (M22 close did NOT trigger — the
  cache_writability probe converts fs errors into `ProbeFail`
  shapes inline rather than throwing typed CLI errors; the
  pattern doesn't match the `wrapAsConfigError` / `wrapFsError`
  factory cadence in credentials.ts + cache.ts. R-NEW-3 stays
  open as a candidate for the next fs-error-throwing surface);
  R-NEW-5 `introspectType()` helper in `scripts/probe/_lib.ts`
  (fires at M27 webhooks pre-flight if introspecting probe
  scripts repeat the M22 pattern); R-NEW-6 Codex pre-flight
  review prompt template at `.claude/templates/codex-pre-flight
  -review.md` (fires at M23 pre-flight if the 7-section
  prompt structure repeats verbatim across M21+M22+M23 —
  template would amortise the per-prompt copy-paste at M23-M28).
- **R-watch-items:** `vi.stubGlobal('fetch')` boundary mock
  pattern (still single-consumer in production probe scripts —
  M22 status probes use mockable-seam injection in tests
  rather than vi.stubGlobal); Post-OAuth fresh-transport
  pattern (still single-consumer; ratified by Codex M21 P1);
  `c8 ignore` vs v8 branch-coverage friction (tooling — M22
  close re-fired this watch-item, with branches landing right
  at the 95.45% floor; coverage-floor margin recovery is in
  next-session scope); **filesystem-state probes** for
  non-ENOENT fs-error branches (test-pattern; EISDIR-via-dir-at
  -path probe ratified at `7058754`); **empirical-probe-step
  -in-pre-flight** — fired twice (M21 OAuth `5c07840` + M22
  `platform_api.daily_*` reshape `fbab6b0`), discipline
  ratified as always-run-for-novel-API-surface pre-flights;
  **mockable-seam pattern in probes** — new at M22, ratified
  via the per-probe `lookupImpl` / `tcpConnectImpl` /
  `tlsConnectImpl` / `redactImpl` injection slots that let
  unit tests drive every failure-mode discriminant offline.
  Pattern carries forward to any future probe-style surface
  (webhooks M27 candidate).

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
