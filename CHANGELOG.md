# Changelog

All notable changes to `monday-cli` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html). The CLI's
output envelope (`{ ok, data, meta, ... }`) and 27 stable error
codes are part of the public contract — the SemVer rules in
[`docs/cli-design.md`](./docs/cli-design.md) §6 govern bumps.

## [0.2.0] — Mutating core: agents can drive a backlog

The "agents can drive a backlog" milestone — v0.1's read-only core
+ safe-mutations gain the full mutation surface (item lifecycle,
update mutations, workspace lifecycle, board lifecycle, board
columns + groups). One breaking change vs v0.1 (see below);
everything else is purely additive. Built incrementally across
M8–M18.

### Breaking changes vs `0.1.0`

**`monday update list` no longer populates `replies: []` by
default.** Pass `--with-replies` to restore the v0.1 behaviour.

- **Why**: Monday charges complexity for the nested
  `updates(...) { replies { ... } }` selection, and most agent
  flows don't need the thread expansion. v0.1 silently paid the
  charge on every call; v0.2 makes the nested selection opt-in.
- **Migration**: agents that consume `update.replies` should pass
  `--with-replies` explicitly. The output shape stays
  byte-identical when the flag is set; only the default changed.
- **Detection**: a v0.1 caller looking for `replies[*].body` will
  see an empty array post-upgrade. There's no error envelope —
  the field is present and shaped correctly, just empty unless
  `--with-replies` is set.

This is the only breaking change. All other v0.2 work is
additive.

### Surface

**Five reader nouns + ~75 commands shipped (was 35 in v0.1).** No
new nouns; ~30 new verbs spread across the existing 5 mutation-
receiving nouns plus workspace / board / update / item lifecycles.

**Item lifecycle** (M9–M12) — `item create` (top-level + classic-
only subitem; single round-trip; optional `--position
before|after --relative-to <iid>`); `item archive` / `delete` /
`duplicate` (`duplicate` two-leg live with `--with-updates` +
`duplicated_from_id` echo); `item move` (same-board via
`--to-group <gid>`, cross-board via `--to-group <gid> --to-board
<bid>` + `--columns-mapping`); `item upsert` (idempotency via
`--match-by <col>[,<col>...]` routing 0/1/2+ matches to
`create_item` / `update_item` / `ambiguous_match`); bulk `item
clear --where`.

**Update mutations** (M13) — `update reply` / `edit` / `delete` /
`like` / `unlike` / `pin` / `unpin` / `clear-all`. The
`clear-all` verb introduced the **partial-success envelope**:
`ok: true` whenever dispatch ran; per-target outcomes in
`data.results: [{ update_id, ok, error? }]`.

**Workspace lifecycle** (M14) — `workspace create` / `update` /
`delete` / `add-users` / `remove-users`. `add-users` /
`remove-users` reuse the M13 partial-success envelope with
resolver-fronted dispatch (mixed numeric IDs + emails).

**Board lifecycle** (M15) — `board create` / `update` /
`archive` / `delete` / `duplicate` / `add-users`. `board
duplicate` introduced the **wrapped envelope**: `data: { board:
<projection>, is_async }` because Monday's `BoardDuplication`
carries an `is_async` slot the projection schema doesn't model.
`board update` is per-attribute fan-out across Monday's
`update_board(board_attribute, new_value)` surface with a
force-live final read leg.

**Board columns** (M16) — `board column-create` / `column-update`
/ `column-delete`. `column-create` adds the
`noncanonical_column_type` warning for non-allowlisted column
types with per-category `suggested_write_path`. M16 also shipped
the **§8 eager-invalidation contract**: every board-structure
mutation calls `invalidateBoard(boardId)` post-success so a
same-process `board describe` sees fresh state without TTL
eviction. Six call sites adopted (M16's three column verbs +
M15's three retrofitted board update / archive / delete).

**Board groups** (M17) — `board group-create` / `group-update` /
`group-archive` / `group-duplicate` / `group-delete`.
`group-update` is per-attribute fan-out (no force-live final
read — Monday's `update_group` returns the full Group projection
post-mutation, distinguishing it from board-update). Group-
create + group-update validate `--color` against the pinned
Monday-supported palette in `src/api/group-color.ts`.

**Writer expansion** (M8) — `--set-raw <col>=<json>` escape
hatch for non-allowlisted column types (gated against
read-only-forever and files-shaped types) plus three new firm
friendly translators: `link` (pipe-form `link=<url>|<text>`),
`email` (pipe-form `email=<email>|<text>`), and `phone`
(pipe-form `phone=<phone>|<country>` with ISO 3166-1 alpha-2
country code).

**NDJSON streaming** (M7 → M18) — `--output ndjson` for `item
list` (M7), `item search` (M18), and `update list` (M18). Trailer
shape pinned to `{"_meta":{...}}` per cli-design §6.3 (no
`warnings` slot — agents read warnings from JSON envelopes, not
NDJSON streams).

### Output contract additions

**27th error code: `ambiguous_match`** (M12). Reserved on the
v0.1 registry, now active on `item upsert` when `--match-by`
resolves to 2+ items. Agents key off `error.code` to retry with
a tighter match; the message names the matched IDs.

**Three envelope shape variants joined the contract:**

1. **Partial-success envelope** (M13) — `ok: true` with
   `data.results: [...]` per-target outcomes. Used by `update
   clear-all`, `workspace add-users` / `remove-users`, `board
   add-users`. Top-level `ok: false` only on whole-call failure.
2. **Wrapped envelope** (M15) — `data: { board: <projection>,
   is_async }` for `board duplicate` (Monday-side async-rebuild
   slot the projection doesn't model).
3. **Bulk mutation envelope** (M12) — `data: { summary, items
   }` for bulk `item update --where` / `item clear --where` with
   `summary.matched_count` + `summary.applied_count`.

**`resolved_ids`** echo (cli-design §6.4) on every column-
mutation envelope (`item set` / `clear` / `update`), including
the empty `{}` when no `--set` token resolved. Agents capture
once and skip subsequent metadata lookups.

### Upgrade notes

- **`unsupported_column_type` `deferred_to: "v0.2"` resolves**
  for the M8 firm row (`link` / `email` / `phone` shipped) and
  **slips to `"v0.3"`** for the tentative row (`tags` /
  `board_relation` / `dependency` — friendly translators land in
  v0.3 once the per-account directory + linked-board enumeration
  design clears). Agents using these types via `--set-raw`
  continue to work; the runtime hint surfaces `--set-raw` as the
  current path.

- **The error-code registry expanded from 26 to 27.** New code:
  `ambiguous_match` (M12) on `item upsert` with 2+ matches.
  Existing codes' shapes are unchanged.

- **Cache-invalidation discipline tightened.** M16's §8 contract
  means a same-process `board describe` after `board column-*` /
  `group-*` / `update` / `archive` / `delete` mutations now sees
  fresh state. v0.1 callers that read post-mutation state see
  *less* stale data than before — purely an improvement, but
  a behavioural shift worth flagging for any agent that timed
  reads against TTL eviction (none should have, but flagging
  for completeness).

### Internals worth highlighting

- **9 R-class refactors shipped during v0.2** (R20–R52, with
  some reserved numbers deferred to v0.3): R29 destructive-gate
  helper consolidation, R39/R45/R48 per-noun mutation projection
  helpers (workspace / column / group), R40 partial-success-fan-
  out helper, R46 §8 eager-invalidation wrappers, R51
  `findBoardChildOrThrow` helper, R52 `startNdjsonStream` lift
  (M18 — ships streaming parity across `item list` / `item
  search` / `update list`). Full R-class register lives in
  [`docs/v0.2-plan.md`](./docs/v0.2-plan.md) §22.

- **52 Codex AI review rounds** across M8–M18. The two-AI review
  workflow (cli-design pre-flight + implementation review)
  caught 200+ findings before merge across the v0.2 work.

### Tests + quality gates

- **2279 unit/integration + 38 E2E tests** at the v0.2.0 tag (was
  1408+37 = 1445 in v0.1). All green on Node 22 + 24.
- **Branch coverage ratchet** to 96% (was 95% in v0.1); other
  thresholds at 95%. The `vitest.config.ts` floor enforces.
- **92 envelope-shape snapshots** (was 60 in v0.1) — every
  shipped command pinned for byte-shape regressions.
- **Five test layers held**: unit, integration (in-process
  `FixtureTransport`), E2E (subprocess against fixture server),
  envelope-shape snapshot suite (extended at M18), published-
  tarball E2E.

### Documentation

- **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** new — the v0.2
  active plan with M8–M18 milestones, decisions log, R-class
  register (R20–R52), per-milestone post-mortems (§10–§26), and
  the §13 deferral roadmap.
- **[`docs/cli-design.md`](./docs/cli-design.md)** §4.3 grew
  ~30 new verb entries; §6.4 added the partial-success +
  wrapped + bulk envelope variants; §8 added the eager-
  invalidation contract.
- **[`docs/output-shapes.md`](./docs/output-shapes.md)** — every
  shipped v0.2 command has a per-section data shape entry,
  snapshot-backed.
- **README.md** quickstart expanded with `item create` + `item
  upsert` examples (the two verbs that change the "drive a
  backlog" story most).

[0.2.0]: https://github.com/Firer/monday-cli/releases/tag/v0.2.0

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
`ambiguous_column`, `column_not_found`, `user_not_found`,
`unsupported_column_type`, `column_archived`, `unauthorized`,
`forbidden`, `rate_limited`, `complexity_exceeded`,
`daily_limit_exceeded`, `concurrency_exceeded`,
`ip_rate_limited`, `resource_locked`, `validation_failed`,
`stale_cursor`, `config_error`, `cache_error`, `network_error`,
`timeout`, `dev_not_configured`, `dev_board_misconfigured`,
`internal_error`. The two `dev_*` codes are reserved for the
v0.3 `monday dev` namespace — listed in the registry but
inactive on the v0.1 surface. Warning codes
(`stale_cache_refreshed`, `pagination_cap_reached`,
`column_token_collision`, etc.) live in `warnings[]`, not
`error`. Agents key off `error.code`; `error.message` is
human-readable and **not** part of the contract.

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
