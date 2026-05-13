# Changelog

All notable changes to `monday-cli` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html). The CLI's
output envelope (`{ ok, data, meta, ... }`) and 29 stable error
codes are part of the public contract — the SemVer rules in
[`docs/cli-design.md`](./docs/cli-design.md) §6 govern bumps.

## [0.3.0] - 2026-05-13 — Monday Dev + multi-profile + diagnostics + outbound writes

The "agent can drive a real backlog with a real workflow" milestone —
v0.2's mutating core gains the Monday Dev convention layer (sprints /
epics / releases / tasks), multi-profile auth, diagnostics
(`monday status` / `monday usage`), cross-board search + favorites,
per-item history, partial-success bulk updates, and outbound writes
(webhooks + notifications). **No breaking changes vs `0.2.0` — every
v0.3 surface is additive.** Built incrementally across M19–M28.

### Breaking changes vs `0.2.0`

**None.** Every command, error code, envelope key, and warning shape
shipped in v0.2.0 is preserved byte-for-byte. v0.3 only adds.

### Surface

**~95 commands shipped (was ~75 in v0.2).** Four new noun-namespaces
(`tag` reads under `account`, `auth`, `dev`, `webhook`,
`notification`) plus two new top-level diagnostics verbs
(`monday status` / `monday usage`).

**Friendly-translator close-out (M19) — three new writable column
types.** `tags`, `board_relation`, `dependency` graduate from the v0.2
tentative row to first-class `--set` writers. The friendly tokens
resolve through per-account / per-board directories with cache
fallbacks. `WRITABLE_COLUMN_TYPES` reaches 13. M19 also ships
`monday account tags` (the read verb that closes the
`tag_not_found.details.hint` forward-reference from v0.2) and adds
`tag_not_found` to the stable error-code registry.

**Time-tracking placeholders (M20) — documentation-only.** `monday item
time-track start <iid>` / `monday item time-track stop <iid>` are
registered so agent scripts targeting these verbs are stable across
the eventual swap when Monday ships API support. They reject every
invocation today with `usage_error` carrying the empirical-probe
context as the hint — an empirical probe (2026-05-10, API `2026-01`)
confirmed Monday's public API does not currently support writing to
`time_tracking` columns.

**Multi-profile auth (M21).** `monday auth login --profile <name>` /
`monday auth logout --profile <name>` implement the OAuth flow + the
`~/.monday-cli/credentials` mode-`0600` cache; `~/.monday-cli/config.toml`
ships per-profile metadata with the new `--profile <name>` global
flag resolving through `cli/program.ts`'s preAction hook. `oauth_failed`
joins the stable error-code registry. **OAuth login is deferred in
v0.3.0** (see "Internals worth highlighting" → OAuth deferral); the
`monday auth login` command surfaces a clear `usage_error` pointing
agents at `MONDAY_API_TOKEN` until the canonical OAuth app is
registered. The redaction runtime folds credentials-cache tokens into
the secret-bag so the two-layer scrub covers them on every emission
path.

**Diagnostics cluster (M22).** `monday status` runs a seven-probe
matrix (DNS / TCP / TLS / auth / cache writability / redaction
self-test / env-var pickup) for "is everything working?" without
touching account state; `--no-probe` skips the four network probes.
`monday usage` reports the daily Monday API operation budget remaining
from `platform_api.daily_limit` + `platform_api.daily_analytics`
(operations-per-day on free tier; an empirical probe pivoted this
away from `account.complexity`, which does not exist on the `Account`
type at API `2026-01`).

**Cross-board search + favorites (M23).** `monday item search` gains
cross-board mode when `--board` is omitted: `--workspace <wid>` /
`--favorites` / `--max-boards <n>` (default 25; hard cap 100) scope
the fan-out. `monday board favorites` reads the current user's
starred boards. Both fan-outs use single-call cross-board semantics
(no resumable cross-board cursor in v0.3 — per-board cursor lifetime
under cross-board aggregation is genuinely thorny; agents narrow with
`--workspace` / `--favorites` or use the v0.1 `--board <bid>` path
which carries its own resumable cursor). Four new load-bearing
warnings: `inaccessible_boards`, `column_not_found_on_board`,
`cross_board_truncated`, `board_favorites_stale`.

**Per-item activity history (M24).** `monday item history <iid>`
merges Monday's `boards.activity_logs(item_ids:)` with `items.updates`
chronologically by `created_at` ascending (lexicographic `id` tie-
break). Event taxonomy is a zod discriminated union over Monday's
observed `event` slot (`update_column_value`, board-scoped variants,
synthesized `update_posted` / `update_replied`); unrecognised events
surface under `kind: 'unknown'` carrying raw `event` + `entity` slots,
with one bounded `unknown_event_kind` warning per unique unrecognised
event. Per-source pagination (`--activity-logs-page` /
`--updates-page`; independent denominators) + `--since` / `--until`
ISO8601 wall-clock filters + `--stream` NDJSON output reusing R52's
`startNdjsonStream`. Eventual-consistency lag is empirically >30s on
freshly-edited boards — the verb's `--help` text documents the
caveat.

**Partial-success bulk updates (M25).** `monday item update --where
... --continue-on-error` attempts every matched item regardless of
per-item failure and emits a partial-success envelope (cli-design
§6.4): `ok: true` whenever dispatch ran, per-target outcomes in
`data.results: [{ item_id, ok, error? }]`, with
`data.summary.failed_count` joining the existing
`matched_count`/`applied_count` invariant
(`matched_count === applied_count + failed_count`). The flag is
orthogonal to the `--yes` confirmation gate. ERROR_CODES registry
stays at 29 — per-item failures route through existing codes
(`column_archived`, `validation_failed`, `complexity_exceeded`, etc.).
The pre-existing fail-fast bulk path is unchanged.

**Monday Dev convention layer (M26).** Thirteen verbs land under the
`monday dev` namespace — the workflow-namespace three-level carve-out
(cli-design §5.2 carve-out 1; §5.9 mechanics). Three setup verbs at
two-level depth: `dev discover [--apply]` (auto-detect Tasks /
Sprints / Epics / Releases / Bugs boards by name), `dev configure
--tasks-board <bid> [...]` (pin board IDs per profile), `dev doctor`
(11-reason structured health-check enum surfaced via
`monday schema dev.doctor`). Ten workflow verbs at three-level depth:
`dev sprint current/list/items`, `dev epic list/items`, `dev release
list`, `dev task list/start/done/block`. Every workflow verb
translates to standard board / item CRUD against the per-profile
configured board IDs — no new Monday GraphQL mutations introduced. Two
new stable error codes activate (`dev_not_configured`,
`dev_board_misconfigured`; reserved on the v0.1 registry, now live).

**Outbound writes (M27).** Webhook lifecycle: `monday webhook list
[--board <bid>]` / `webhook create --board <bid> --url <url> --event
<type> [--config <json>]` (event-type validated against the 21-value
`WEBHOOK_EVENT_TYPES` closed enum, probed against API `2026-01`) /
`webhook delete <wid>` (destructive — `--yes` required;
`enforceDestructiveGate` fires BEFORE the resolver per the M10
invariant). Notifications: `monday notification send --user <uid>
--target <id> --target-type item|board --text <body>` (single-
recipient at v0.3). Webhooks are live-only — outside cli-design §8's
cache scope. The CLI never receives — webhooks land on the user's own
HTTPS endpoint (cli-design §1 permanent non-goal: hosting webhooks).
ERROR_CODES registry unchanged.

**Subitem multi-level creation — deferred out of v0.3 (M28).** Closed
at M28 pre-flight on empirical grounds: an empirical probe
(2026-05-13, API `2026-01`) confirmed Monday's `sub_items_board` does
NOT carry a `subtasks` column at the pinned API version, so a depth-2
subitem has structurally no place to live in the data model. Single-
level subitems remain first-class via the existing M9 carve-in (`item
create --parent <iid>`, `item subitems <iid>`, and every standard
item verb operating uniformly on subitems). v0.3.x / v0.4 picks the
feature up if Monday surfaces the capability.

### Output contract additions

**Two new stable error codes — registry grows from 27 to 29.**

1. **`tag_not_found`** (M19) — `monday item set <iid> tags=<token>`
   when the token doesn't resolve through the per-account tag
   directory. `details.hint` points the agent at `monday account
   tags` for discovery.
2. **`oauth_failed`** (M21) — umbrella for OAuth-flow failures
   (`monday auth login`). `details.reason` discriminates per failure
   mode (`port_in_use`, `code_exchange_failed`, `state_mismatch`,
   `redirect_invalid`, `oauth_unregistered` for the v0.3.0
   placeholder-guard path, etc.) so agents key off the structured
   reason rather than the umbrella code alone.

The two `dev_*` codes reserved on the v0.1 registry
(`dev_not_configured`, `dev_board_misconfigured`) activate at M26 —
they were registry-stable but inactive in v0.1/v0.2.

**Per-item history envelope shape** (M24). New under
`docs/cli-design.md` §6 for the merged activity stream: event objects
carry `created_at` (ISO), `actor_id`, `kind` (discriminator —
`update_column_value` / `update_posted` / `update_replied` /
board-scoped variants / `unknown`), `before`, `after` (typed where
M24 ships the projector, raw JSON elsewhere — agents read `kind` and
case on it).

**Partial-success bulk envelope** (M25 — §6.4 sub-section).
`data.summary.failed_count` joins the bulk-summary fields; per-item
`data.results: [{ item_id, ok, error? }]`. The fail-fast bulk path
(`details.applied_to` decoration on the error envelope) is unchanged
— agents who haven't migrated to read `data.results[]` continue to
receive the v0.1 envelope shape.

**Cross-board search envelope** (M23 — additive on `item search`).
The data shape is unchanged; the cross-board path adds per-board
`state` breakdown inside `cross_board_truncated.details`
(`exhausted` / `has_more` / `not_started`).

**Four new warnings** (cross-board search + favorites):
`inaccessible_boards`, `column_not_found_on_board`,
`cross_board_truncated`, `board_favorites_stale`. Plus
`unknown_event_kind` (item history). All warnings carry structured
`details` agents can route on.

### Upgrade notes

- **`unsupported_column_type` `deferred_to: "v0.3"` resolves** for
  the v0.2 tentative row (`tags`, `board_relation`, `dependency`
  shipped at M19). The `--set-raw` escape hatch on these types
  continues to work byte-identically; agents using the friendly form
  pick it up automatically.
- **Stable error-code registry expanded from 27 to 29.** Existing
  codes' shapes are unchanged.
- **`--profile <name>` is a new global flag.** Resolved through
  `cli/program.ts`'s preAction hook; profile precedence is documented
  at `docs/cli-design.md` §7.4. Single-profile installs (the v0.2
  shape) need no change — the implicit default profile preserves the
  v0.2 behaviour.
- **`monday auth login` placeholder-guard.** The verb is registered
  but returns `usage_error.details.reason: oauth_unregistered`
  pointing at `MONDAY_API_TOKEN` until the canonical Monday OAuth app
  is registered. `monday auth logout` works against any locally
  cached credentials. The deferral is documented at cli-design §7.3.

### Internals worth highlighting

- **OAuth deferral.** `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` ship
  as `<UNREGISTERED_PENDING_OAUTH_APP>` placeholders in `src/api/oauth.ts`
  at v0.3.0. The full M21 OAuth source + test infrastructure stays as
  dormant infrastructure (the `__test_oauth_helper` seam keeps the
  M21 round-trip tests green). Whether a canonical `monday-cli`
  OAuth app gets registered at v0.3.x / v0.4 is a separate product
  decision — the CLI works fully with API tokens today, which is the
  shape every agent harness already consumes. If registration lands,
  the swap is one-sided in `src/api/oauth.ts` and the placeholder
  guard drops in one edit.

- **R-class refactors shipped during v0.3.** R-NEW-1 (`isENOENT`
  lift), R-NEW-4 (`statusOutputSchema` / `probeResultSchema`
  import-from-api lift), R-NEW-5 (`introspectType()` probe helper),
  R-NEW-6 (`.claude/templates/codex-pre-flight-review.md` template
  lift after M21 + M22 + M23 converged on the same prompt shape),
  R-NEW-7 (`formatMode` lift), R-NEW-14 / R-NEW-15 / R-NEW-16
  (`errorMessage` / `asError` / `errorCode` consolidation across 17
  inline duplicates), R-NEW-17 (W1 redactor-pattern audit folded
  template-stable), R-NEW-19 (manual `safeParse → ApiError` sites
  migrated to `unwrapOrThrow`), R-NEW-21 (`trialQuery()` /
  `ProbeRawErrors` probe lift), R-NEW-25 (W1's "findings up front"
  Codex-prompt directive), R-NEW-27 (`isPlainObject`
  consolidation), R-NEW-29 (`executeItemMutation` lift —
  three-consumer trigger across single-item + fail-fast bulk + M25
  partial-success bulk), R-NEW-30 (`resolveActiveDevProfile` —
  13-consumer trigger across M26a + M26b), R-NEW-35
  (`requireDevBoard` slot-check helper), R-NEW-36 (seven dev-conventions
  workflow helpers), R-NEW-37 (Codex template W2 audit-point for
  GraphQL operationName parity — caught the M27 IMPL caller-
  overridable operationName slot), R-NEW-38 (sprint date-range
  helpers consolidation), R-NEW-42 (`parseJsonArg` argv-JSON-parse-
  boundary helper). Full register with shipped commit SHAs lives in
  [`docs/v0.3-plan.md`](./docs/v0.3-plan.md) §22.

- **Empirical probes** ratified as always-run-for-novel-API-surface
  pre-flight discipline. v0.3 fired the pattern across M21 OAuth /
  M22 `platform_api.daily_*` reshape / M23 cross-board + favorites /
  M24 history kinds / M26 dev-board discovery / M27 webhook
  event-type enum / M28 multi-level subitems. Multiple milestones
  pivoted contract surfaces at pre-flight on probe findings rather
  than discovering API drift at IMPL.

- **Two-AI review** (cli-design pre-flight + implementation review)
  ran for every milestone M19–M27. Catches contract drift before
  it reaches `main`; the cumulative finding count + per-milestone
  Codex-round breakdown is in the per-milestone post-mortems in
  [`docs/v0.3-plan.md`](./docs/v0.3-plan.md) §11–§20.

### Tests + quality gates

- **3225+ unit/integration + E2E tests** at v0.3.0 (was 2280+38 ≈
  2318 in v0.2.0). All green on Node 22 + 24.
- **Coverage at 99.08 / 95.92 / 99.29 / 99.31** (statements /
  branches / functions / lines) against the floor 95 / 95.45 / 95
  / 95. The branches floor was raised at M22 (94% → 95.45%) and held
  through M28. Branches margin is 0.47pp at v0.3.0.
- **Envelope-snapshot suite refreshed** for v0.3 surfaces — every
  new v0.3 command + the partial-success / history / cross-board /
  dev / webhook / notification envelopes are pinned for byte-shape
  regressions.
- **Five test layers** held: unit, integration (in-process
  `FixtureTransport`), E2E (subprocess against fixture server),
  envelope-shape snapshot suite, published-tarball E2E.

### Documentation

- **[`docs/v0.3-plan.md`](./docs/v0.3-plan.md)** new — the v0.3
  active plan with M19–M28 milestones, decisions log, R-class
  register (R-NEW-1 through R-NEW-43), per-milestone post-mortems
  (§11–§21).
- **[`docs/cli-design.md`](./docs/cli-design.md)** §4.3 grew ~25 new
  verb entries; §6.4 added the M25 bulk partial-success sub-section;
  §6.5 added two new error codes; §7.3 added the OAuth deferral
  block; §7.4 added the multi-profile resolution surface; §11.5
  added the seven-probe `monday status` matrix; §13 v0.3 entry
  closed out.
- **[`docs/output-shapes.md`](./docs/output-shapes.md)** — every
  shipped v0.3 command has a per-section data shape entry, snapshot-
  backed.
- **README.md** quickstart expanded with v0.3 examples (`monday
  status`, `monday dev sprint current`, `monday webhook list`).

[0.3.0]: https://github.com/Firer/monday-cli/releases/tag/v0.3.0

## [0.2.0] - 2026-05-08 — Mutating core: agents can drive a backlog

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

- **R-class refactors shipped during v0.2** — the R20–R52 register
  consolidates per-noun + cross-cutting boilerplate as the surface
  grew. Highlights: R29 destructive-gate helper (initially lifted
  at five consumers in M14; later milestones grew its consumer
  count further as M15-M17 destructive verbs adopted),
  R37/R39/R43/R45/R48 per-noun mutation projection helpers
  (Update / Workspace / Board / Column / Group), R40 partial-
  success-fan-out helper, R46 §8 eager-invalidation wrappers,
  R51 `findBoardChildOrThrow` helper, R52 `startNdjsonStream`
  lift (M18 — ships streaming parity across `item list` /
  `item search` / `update list`). R42 / R44 / R49 / R50 stayed
  deferred to v0.3 at v0.2.0 close. Full R-class register lives
  in [`docs/v0.2-plan.md`](./docs/v0.2-plan.md) §22 with shipped
  commit SHAs.

- **Two-AI review** (cli-design pre-flight + implementation review)
  ran for every milestone M8–M18. Catches contract drift before
  it reaches `main` and projection bugs before they reach a
  release; the cumulative finding count across the v0.2 arc is in
  the per-milestone post-mortems in `docs/v0.2-plan.md` §10–§26.

### Tests + quality gates

- **2280 unit/integration + 38 E2E tests** at the v0.2.0 tag (was
  1408+37 = 1445 in v0.1). All green on Node 22 + 24.
- **Branch coverage ratchet** from 95% (v0.1 floor) to 95.5%
  (v0.2 floor; project's actual branches at v0.2.0 is 95.51%).
  Other thresholds held at 95%. The `vitest.config.ts` floor
  enforces. The §3 M18 exit aimed for 96 — the actual M13–M18
  branch-coverage delta was smaller (~0.5pp) because the new
  code shipped at 100% per-file but the denominator grew
  alongside the numerator. Net effect is "held + small raise"
  per the §3 M18 "held or raised" exit gate.
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

## [0.1.0] — Foundation milestone (git tag — npm publish slipped to 0.2.0)

The "read-only core + safe mutations" milestone — an agent can read
everything the CLI surfaces, make small scoped idempotent changes,
and post comments narrating its work. Built incrementally across
M0–M7 (M5 split into M5a + M5b; M2.5 inserted post-M2 as a
structural-debt cleanup pass).

> **Publication note**: 0.1.0 shipped to `main` as a tagged git
> release but was not published to npm. The first public npm
> release of `monday-cli` is **0.2.0** (which contains the full
> v0.1 surface as its foundation — nothing in 0.1.0 was lost or
> rolled back). The `monday-cli` npm namespace had a brief
> pre-history (`monday-cli@0.0.1`, published and unpublished
> within hours on 2026-01-12) before being claimed for this
> project at the v0.2.0 release.

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
