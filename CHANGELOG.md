# Changelog

All notable changes to `monday-cli` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html). The CLI's
output envelope (`{ ok, data, meta, ... }`) and 26 stable error
codes are part of the public contract — the SemVer rules in
[`docs/cli-design.md`](./docs/cli-design.md) §6 govern bumps.

## [0.1.0] — Initial release

The "read-only core + safe mutations" milestone — an agent can read
everything the CLI surfaces, make small scoped idempotent changes,
and post comments narrating its work. Built incrementally across
M0–M7 (M5 split into M5a + M5b; M2.5 inserted post-M2 as a
structural-debt cleanup pass).

### Surface

**Five reader nouns + 35 commands shipped.**

- `account` — `whoami`, `info`, `version`, `complexity`.
- `workspace` — `list`, `get`, `folders`.
- `board` — `list`, `get`, `find`, `describe`, `columns`,
  `groups`, `subscribers`, `doctor`.
- `user` — `list`, `get`, `me` (alias for `account whoami`).
- `update` (Monday "comments") — `list`, `get`, `create`.
- `item` reads — `list`, `get`, `find`, `search`, `subitems`.
- `item` mutations — `set` (single-column write), `clear`
  (per-column clear), `update` (atomic multi-`--set` plus
  bulk `--where`).
- `raw` — GraphQL escape hatch with AST-aware operation routing
  + `--allow-mutation` + `--operation-name` + `--dry-run` for
  mutations.
- Local-only — `cache` (`list`, `clear`, `stats`),
  `config` (`show`, `path`), `schema` (full registry + per-command
  JSON Schema 2020-12).

**Filter DSL.** `--where <col><op><value>` (operator allowlist:
`=`, `!=`, `~=`, `<`, `<=`, `>`, `>=`, `:is_empty`,
`:is_not_empty`) plus `--filter-json` for richer inputs;
mutually exclusive. `me` token resolves through `account whoami`.

**Pagination.** Two walkers, one contract per Monday shape.
`walkPages` covers Monday's `limit`/`page` collections (workspace
/ board / user / update); `paginate` covers cursor-based
`items_page` → `next_items_page` (item list / search / find).
60-minute cursor lifetime; `stale_cursor` fail-fast (no silent
re-issue). Page-based walks cap at `--limit-pages`
(default 50, max 500); `pagination_cap_reached` warning surfaces
on truncated walks. NDJSON streaming via `--output ndjson`
(item list).

**Column-value writer (v0.1 allowlist).** Seven types are
writable: `status`, `text`, `long_text`, `numbers`, `dropdown`,
`date`, `people`. Translates each to its Monday wire shape
(simple-form `change_simple_column_value`,
rich-form `change_column_value`, multi-form
`change_multiple_column_values`). Mutation selection is
fixture-pinned per (count × type) cell. Token resolution: ID > NFC
exact title > NFC + case-fold > `ambiguous_column`.

**Dry-run engine.** `--dry-run` on every mutation emits a
`planned_changes[]` envelope (cli-design §6.4) without touching
the wire. All-or-nothing semantics: any resolution failure
aborts the batch before the item read fires.

**Diagnostics.** `board doctor` flags
`duplicate_column_title`, `unsupported_column_type` (per roadmap
category — `v0.2_writer_expansion` / `read_only_forever` /
`future`), and `broken_board_relation` (archived /
unreachable / mixed).

### Output contract (binding — major-bump on change)

**Universal envelope.** Every command returns
`{ ok, data, meta, warnings }` (success) or `{ ok, error, meta }`
(failure). `meta` always carries `schema_version: "1"`,
`api_version`, `cli_version`, `request_id`, `source`
(`live` / `cache` / `mixed` / `none`), `cache_age_seconds`,
`retrieved_at`, `complexity` (when `--verbose`).

**Stable error codes (26).** `usage_error`,
`confirmation_required`, `not_found`, `ambiguous_name`,
`ambiguous_column`, `column_not_found`, `column_archived`,
`column_token_collision`, `unsupported_column_type`,
`user_not_found`, `validation_failed`, `unauthorized`,
`forbidden`, `rate_limited`, `complexity_exceeded`,
`daily_limit_exceeded`, `concurrency_exceeded`,
`ip_rate_limited`, `resource_locked`, `stale_cursor`,
`pagination_cap_reached`, `network_error`, `timeout`,
`config_error`, `cache_error`, `internal_error`. Two `dev_*`
codes reserved for v0.3 are listed but inactive in v0.1.
Agents key off `error.code`; `error.message` is human-readable
and **not** part of the contract.

**Exit codes.**

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error / `confirmation_required` |
| 2 | API or network error |
| 3 | Config error |
| 130 | SIGINT |

**TTY-aware output.** Tables when stdout is a TTY, JSON when
piped. `--json` (alias for `--output json`) forces JSON in
pseudo-TTYs (the agent path). Tables truncate; JSON never does.

### Foundations

- **Typed errors** at `src/utils/errors.ts` — `ConfigError`,
  `UsageError`, `ApiError` (with `MondayCliError` parent and
  `code`/`details`/`cause`). Every parse boundary wraps
  `ZodError` so config errors map to exit 3, usage errors to
  exit 1, never `internal_error`.
- **Two-layer redaction** at `src/utils/redact.ts`. Key-based
  filter (Authorization, MONDAY_API_TOKEN, generic
  `(token|secret|password|api[-_]?key)` regex) + value-scanning
  filter (the literal token value, scrubbed from
  `Error.message`, `Error.stack`, `Error.cause.message`, fetch
  URLs, debug payloads). Adversarial integration suite asserts
  the canary token doesn't appear in any emitted byte.
- **Header lockdown.** Caller-supplied headers can't override
  transport-owned `Authorization` / `API-Version` /
  `Content-Type` (case-insensitive strip + reserved-set
  enforcement).
- **Universal-envelope builder + meta-builder** at
  `src/utils/output/envelope.ts`. One source of truth for §6.1
  meta keys; per-command output uses `emitSuccess` /
  `emitMutation` / `emitDryRun` helpers.
- **Cursor / page walkers** at `src/api/pagination.ts` (cursor)
  and `src/api/walk-pages.ts` (page). Both fail-fast on
  Monday-side errors with structured `details`.
- **Resolver-warning fold module** at
  `src/api/resolver-error-fold.ts`. Folds collision /
  stale-cache-refreshed warnings into a thrown
  `MondayCliError`'s `details.resolver_warnings` slot so a
  stale-cache-then-failure flow doesn't lose the refresh signal.
  Six consumers across mutation paths.
- **Cache-aware board metadata** at `src/api/board-metadata.ts`.
  XDG-cache-rooted, with explicit `--no-cache` opt-out.
  Cache-miss-refresh on resolution failure (single round-trip
  to refresh, then re-resolve once); refresh outcome echoed via
  `meta.source: "mixed"` + `stale_cache_refreshed` warning.
- **Validation-failed → column-archived remap** for
  cache-sourced live mutations (Monday returns
  `validation_failed` when the cached column was archived
  server-side — refresh and remap so agents key off the stable
  code, with `details.remapped_from: "validation_failed"` for
  triage).

### Pinned to Monday API `2026-01`

Pinned via the `API-Version` header on every request.
Override per-call with `--api-version`, per-environment with
`MONDAY_API_VERSION`. Matches `@mondaydotcomorg/api@14.0.0`'s
`CURRENT_VERSION`. Bumping the pin is a SemVer-minor (or major
if the output schema changes).

### Explicitly deferred (see [`docs/cli-design.md`](./docs/cli-design.md) §13)

- **v0.2 — writer expansion + bulk + filters.**
  `item create/move/archive/delete/duplicate/upsert`,
  `update reply/edit/delete`, broader column writes
  (`link`, `email`, `phone`, `tags`, `board_relation`,
  `dependency`), `--set-raw` escape hatch, boolean filter DSL,
  workspace mutations, board / column / group mutations.
- **v0.3 — `monday dev` namespace** (workflow shortcuts on top
  of CRUD), `monday auth login`, OAuth profiles, config files.
- **v0.4 — operational features.** `monday item watch`
  (long-poll + reconnect), `--concurrency`, asset uploads, shell
  completion.
- **No `restore` in v0.1.** Monday has no unarchive mutation;
  recreating is lossy. v0.1 deliberately does not ship a
  misleading `restore`.

### Tests + quality gates

- **1408 unit/integration + 37 E2E = 1445 tests** at the v0.1.0
  tag. All green.
- **Branch coverage 94%+ floor** (lines / functions /
  statements 95%+).
- **Network-boundary mocking only** — no internal-module
  monkey-patching; every test exercises the real
  `commands/*` → `api/*` path.
- **Five test layers.** Unit, integration (in-process
  fixture-transport), E2E (subprocess against fixture server),
  envelope-shape snapshot suite (M7 — pins per-command
  data/meta byte shape so v0.2 drift fails loud), published-
  tarball E2E (M7 — `npm pack` + extract + install runtime
  deps + smoke-test the binary that ships).
- **Two-AI review** (Codex `gpt-5.5`) gates every milestone close
  and design-doc change. Ten Codex review rounds across M0–M7.

### CLI standards

- Node ≥ 22.
- ESM (`"type": "module"`); strictest TypeScript
  (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`,
  `useUnknownInCatchVariables`, `verbatimModuleSyntax`).
- Conventional Commits + atomic incremental commits.
- `process.exitCode` (not `process.exit`) so stdout drains
  naturally before exit — large payloads (e.g. `monday schema
  --json` past ~64KB) won't truncate on slow consumers.
- SIGINT handler exits 130 without an envelope dump.
- No interactive prompts. `confirmation_required` exits 1 on
  destructive ops without `--yes` (or `--dry-run`).

### Documentation

- [`docs/cli-design.md`](./docs/cli-design.md) — canonical CLI
  contract (~2,200 lines). Two AI-collaborator review passes;
  internally consistent.
- [`docs/v0.1-plan.md`](./docs/v0.1-plan.md) — implementation plan
  + per-milestone post-mortems (§11–§21).
- [`docs/output-shapes.md`](./docs/output-shapes.md) — per-command
  output reference. New in v0.1.
- [`docs/architecture.md`](./docs/architecture.md) — module
  boundaries (commands → api → SDK).
- [`docs/examples.md`](./docs/examples.md) — worked agent sessions.
- [`docs/api-reference.md`](./docs/api-reference.md) — Monday
  concepts cheat sheet.
- [`docs/development.md`](./docs/development.md) — local dev
  workflow.

[0.1.0]: https://github.com/Firer/monday-cli/releases/tag/v0.1.0
