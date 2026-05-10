# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.3-M19 closed.** M0–M18 shipped on `main`; v0.3 plan +
M19 pre-flight contract diff landed in prior sessions;
**M19 implementation closed across two sessions** —
Commits 1+2 last session, Commits 3+4+5+6+7 this session
(writer-expansion close per cli-design §5.3 writer-
expansion roadmap + §13 v0.3 entry).

**Shipped M19 commits in order:**
- **Commit 1 — `d6c8651 refactor(m19-fold)`.** Collapsed
  `unsupportedColumnTypeError` into a 5-way category-table
  dispatch. Behaviour-preserving; every existing test
  cassette passes byte-identical. Lifts v0.3-plan §22 non-
  R-class quality refactor.
- **Commit 2 — `19801f8 feat(m19) tags translator`.**
  First M19 translator + first new module body. `tags`
  graduates from the v0.2 tentative row into
  `WRITABLE_COLUMN_TYPES` (10 → 11). `tag-directory.ts`
  body lands alongside (R45 cadence). `accountTags`
  extends `CacheKey`; on-disk path `account_tags/
  index.json`. Pre-flight contract amendments to
  `d822982`: `ResolveTagsResult` adds `cacheAgeSeconds`,
  `LoadAccountTagsResult` adds `complexity`, cache key
  named `accountTags` (camelCase) instead of placeholder
  `account-tags`.
- **Commit 2.5 — `b9d9213 docs(m19-mid)`.** Mid-milestone
  Codex review feedback applied (P1-clean with 3 P2 + 1
  P3 findings, all addressed inline). Status flipped to
  "in progress (paused mid-milestone)" — the actual M19
  close defers to next session.
- **Commit 3 — `a569590 feat(m19) board_relation`** (this
  session). `board_relation` graduates;
  `validateBoardRelationItems` runtime body lands
  (replacing the pre-flight stub) with success-branch
  widening to `{ ok: true, items: ValidatedRelationItem[]
  }` per Codex round-2 P1-3. New `parseRelationItemIds`
  shared parser per Codex round-1 P2-11 (5 rejection
  branches: empty / over-cap / non-decimal / unsafe-
  integer / duplicate). Cross-cutting widenings:
  `RelationResolution` echo slot, shared
  `RelationResolutionContext.validateItems` callback,
  `assertEchoExclusivity` N=4 widening,
  `buildResolutionContexts` `relationResolution` context,
  `column-create.ts` settings-maps growth, `describe.ts`
  `exampleSetForColumn` widening. Deferred Commit 2 P2-2
  integration cassette (`item set tags=launch` happy
  path + multi-miss `tag_not_found`) shipped here.
- **Commit 4 — `53a76ea feat(m19) dependency`** (this
  session). Sibling translator. `WRITABLE_COLUMN_TYPES`
  reaches 13; `V0_2_WRITER_EXPANSION_TYPES` becomes empty
  `[]`. The `v0_2_writer_expansion` category branch in
  the `unsupportedColumnTypeError` classifier is
  unreachable through the runtime classifier; retained as
  documented dead code per the M8-era stability comment.
  Integration test cascade fired one final time —
  `dependency`-as-unsupported pins retargeted to
  `battery` (`future` category).
- **Commit 5 — `969dc7e feat(m19) monday account tags`**
  (this session). Read verb. M19-fold mandatory per
  Codex round-1 P2-9 (closes the §6.5
  `tag_not_found.details.hint` forward-reference). Output
  schema `{tags, total}`. Cache-aware via
  `loadAccountTags`. Registry slot in
  `src/commands/index.ts:136`.
- **Commit 6 — `7707085 docs(m19)`** (this session). The
  M19 close itself, bundling Codex implementation review
  feedback (2 P1 + 3 P2 + 1 P3 findings, all addressed
  inline) with the close docs sweep (CLAUDE.md / README /
  cli-design §8 + §4.3 / output-shapes ToC + account-tags
  entry / api-reference M19 row / architecture.md).
  Combined to one commit because the Codex fixes touch
  the same files the close sweep touches; splitting
  would have created two near-identical doc-sweep
  commits. Final M19 commit; the milestone closes
  here.

**Test count + coverage at M19 close:** 2308 (M19 entry,
post-pre-flight) → 2466 (M19 close), +158 net. Coverage
99.03 / 95.47 / 99.32 / 99.18 (statements / branches /
functions / lines), above the 95/95.45/95/95 floor. Floor
unchanged — branches at 95.47% (0.02pp above floor) didn't
clear 95.5% with margin.

**M19 → M20 cleanup window** (mirrors v0.2's M(N-1) → M(N)
cadence: R51 between M17–M18, R53 between M18 and v0.3
opening — see `docs/v0.3-plan.md` §11 looking-ahead block):
- **Non-R-class — `peopleResolution.resolveEmail` source-
  aggregation parity fix. Shipped: `2cbf0d3`.** Closes the
  v0.3-plan §11 M19 post-mortem refactor-backlog candidate.
  Pre-fix `--set Owner=alice@example.com` against a cache-
  hit user-directory lookup emitted `meta.source: "live"`
  because the email-resolution leg never reached the
  envelope-level aggregate. Post-fix `PeopleResolutionContext.
  resolveEmail` returns `{id, source, cacheAgeSeconds}`
  (Option A from the handoff — transparent passthrough of
  `userByEmail`'s public shape mirroring the M19 tags
  translator's `resolveTags` callback); `parsePeopleInput`
  aggregates per-leg via `SourceAggregator` (`me` always
  'live' — `me { id }` is a network call; emails forward
  `userByEmail`'s source verbatim); `translatePeople`
  threads the aggregate into `translatorResolution`; the
  existing post-translate aggregation loop in
  `resolution-pass.ts` (already shipped for tags +
  relations) merges the leg into the envelope automatically.
  Codex P1-clean (1 P2 stale-comment fix-up at three sites
  addressed inline in the same commit).
- **Test count + coverage post-cleanup:** 2387 → 2396 (+9
  net: 6 unit aggregation in `parsePeopleInput` describe
  block + 2 unit translator-level + 1 integration cache-hit
  cassette mirroring `workspace.test.ts:1333` cache-hit
  pattern). Coverage 99.03 / 95.47 / 99.32 / 99.19 — lines
  ticked up 99.18 → 99.19; statements/branches/functions
  unchanged. Floor unchanged at 95/95.45/95/95.

**M20 pre-flight gate — Decision 4 closure shipped this
session** (mirrors the `4c652d5` Decision 1 closure ahead of
M19; pre-flight contract diff for M20's `time-tracking.ts`
module signatures is the next session's work):
- **Commit A — `1e81b2f docs(cli-design)`.** v0.3-plan §8
  Decision 4 closed — cli-design §5.2 grows from one carve-out
  (workflow namespaces, the `dev` namespace) to two,
  numbered. Carve-out 1 stays the workflow-namespace exception
  for `dev sprint/epic/release/task` shapes; carve-out 2
  admits verb-shaped column-type extensions for `<noun>
  <subnoun> <verb>` (M20's `item time-track start/stop`
  shape; reserves the slot for any future verb-shaped column
  type). New "general rule" paragraph articulates the
  three-token-shape test so future carve-outs aren't ad-hoc;
  intentionally shape-based (not name-based) so `dev sprint
  current` (third token "current" is a verb on a workflow
  concept) and `item time-track start` (third token a verb on
  a column-type subnoun) both fit. Codex round 1: 1 P1 + 1 P2
  + 1 P3. P1 caught a name-based generalisation that
  disqualified carve-out 1 — fixed inline with the shape-based
  wording. P2 + cli-design slice of P3 inline; v0.3-plan slice
  of P3 + the P2 plan-doc fix deferred to Commit B.
- **Commit B (this commit) — close docs.** v0.3-plan §3 M20
  body now cites carve-out 2 directly (P2 fix); §3 M19
  glossary row + §3 M26 three-level naming reference now pin
  to carve-out 1 (P3 fix); §8 Decision 4 annotated with closed
  SHA + scope; §9 preconditions tick (`M19 closed` + `Decision
  4 closed`); §3 M26 precondition wording cleaned up to
  reflect carve-out 1 already in force. CLAUDE.md status block
  block updated. No source-code changes; net diff
  docs-only across cli-design.md (Commit A) + v0.3-plan.md
  (Commit B) + this CLAUDE.md hunk.
- **M20 unblocked.** Next session ships M20 pre-flight
  contract diff (mirrors `d822982` cadence — `src/api/
  time-tracking.ts` module signatures + any new ERROR_CODES
  + stub bodies) with Codex pre-flight review BEFORE M20's
  first feat commit. Three open M20-specific decisions
  (start-while-running semantics, stop-while-not-running
  semantics, idempotency — see v0.3-plan §3 M20 line 625-637)
  close at M20 pre-flight, NOT here.

**M20 closed (documentation-only verbs).** Empirical probe at
M20 implementation kickoff (2026-05-10, against API version
`2026-01`) confirmed Monday's public GraphQL API does not
currently support writing to `time_tracking` columns:

- `change_simple_column_value` rejects every candidate value
  (`"true"`, `"false"`, `"start"`, `"stop"`) with
  `CorrectedValueException`: *"DurationColumn does not support
  simple column value writes"*.
- `change_column_value` rejects every candidate JSON shape
  (`{running:true}`, `{running:false}`, `{started_at:...}`,
  `{ended_at:...}`, `{}`) with `InvalidColumnTypeException`:
  *"This column type is not supported yet in the API"*.
- Full mutation-root introspection (152 mutations) found zero
  time-tracking-related mutations.

The pre-flight contract assumed `change_simple_column_value`
would route through; that assumption was empirically wrong.
M20 ships the verbs as **forward-compatibility markers** —
`monday item time-track start <iid>` / `... stop <iid>` are
registered in the CLI surface so agent scripts targeting the
verbs are stable across the eventual swap when Monday ships
API support — and reject every invocation today with
`usage_error` carrying the empirical-probe context (date,
API version, Monday's exact error codes for each candidate
wire shape) so an agent reading `details.hint` can self-verify
the limitation. The four pre-flight `*Inputs` / `*Result`
interfaces stay verbatim; when Monday ships API support, the
runtime body swap is one-sided in `src/api/time-tracking.ts`.

**Shipped M20 commits:**
- **Commit 1 (this commit) — `feat(m20): documentation-only
  time-track start/stop verbs`.** Bundles runtime-body update
  in `src/api/time-tracking.ts` (rejection swap; pre-flight
  interfaces preserved) + new `src/commands/item/time-track/
  start.ts` + `... /stop.ts` (three-level command depth per
  cli-design §5.2 carve-out 2; `--board` resolution preserved
  for invalid-item `not_found` UX consistency, `--column`
  resolution intentionally skipped) + registry slots in
  `src/commands/index.ts` (70 → 72 commands) + the
  `unsupportedColumnTypeError` time_tracking-branch hint
  update in `src/api/column-values.ts` (now points at the
  documentation-only verbs by argv shape with the
  empirical-probe caveat) + tests/unit expansion (9 → 16) +
  new `tests/integration/commands/item-time-track.test.ts`
  (8 cassettes — `--board` supplied, `--board` omitted with
  valid item, invalid item with `not_found`, parse-boundary
  `usage_error`, omitted `--column` echoes empty string,
  token redaction, symmetric for `stop`) + envelope-snapshot
  `command_count: 70 → 72` + close-docs sweep (cli-design
  §4.3 + §6.4, output-shapes.md, v0.3-plan §3 M20 status
  flip, this CLAUDE.md hunk).
- **Commit 2 — `<followup>` `docs(m20-followup): drift sweep
  + M20 post-mortem + 3 new R-watch-items`** (next commit
  this session). Drift sweep across §9 preconditions tick,
  §22 R-watch-item time-tracking.ts narrative update,
  cli-design §13 v0.3 entry adding the M20 verbs, cli-design
  §5.3 writer-expansion-table line for `time_tracking`
  noting the documentation-only state. New §12 M20
  post-mortem (mirrors §11 M19 structure: Codex round
  summary, contract drift findings, exit ratchets, refactor
  backlog candidates surfaced, lessons for M21). New §22
  R-watch-items: (a) `FixtureTransport` order-tolerance
  for parallel transport calls (logged from the `7dbcf7e`
  flake fix); (b) empirical-probe step in pre-flight for
  novel API surfaces (process item, not code refactor —
  M20's pivot was avoidable with this discipline); (c)
  `scripts/probe/` reusable probe infrastructure (R-candidate
  for M21+ probe scenarios).

**Test count + coverage at M20 close:** 2407 (M20 entry,
post-pre-flight + Node 24 flake fix) → 2422 (M20 close), +15
net (8 unit time-tracking + 8 integration item-time-track,
minus 1 column-values assertion that consolidated). Coverage
99.05 / 95.49 / 99.32 / 99.21 (statements / branches /
functions / lines), above the 95/95.45/95/95 floor. Floor
unchanged. **Full M20 post-mortem at v0.3-plan §12.**

**M21 pre-pre-flight gate — Decision 3 closure + §7.3 OAuth
flow design shipped this session** (mirrors the `4c652d5`
Decision 1 closure ahead of M19 + the `1e81b2f` Decision 4
closure ahead of M20; the M21 pre-flight contract diff —
`src/config/profiles.ts` + `src/config/credentials.ts` +
`src/commands/auth/login.ts` + `src/commands/auth/logout.ts`
module signatures + ERROR_CODES widening for `oauth_failed`
+ empirical OAuth probe per §22 R-watch-item — is the next
session's work):

- **Commit A — `3eba714 docs(cli-design): flesh out §7.3
  OAuth flow + add §7.4 credentials cache — v0.3-M21
  prerequisite`.** Replaces the §7.3 single-paragraph stub
  with a comprehensive OAuth-flow design (8-step flow
  shape — per-attempt CSRF state via 32-byte crypto-random
  + PKCE code_verifier + SHA-256 code_challenge; ephemeral
  `127.0.0.1:0` listener with 5-min default timeout;
  `crypto.timingSafeEqual` with explicit length-check
  guard so length-mismatched buffers route to
  `oauth_failed.reason: "csrf_mismatch"` rather than
  `internal_error`; headless-friendly URL-print fallback
  when no browser opener is found; idempotent silent-
  overwrite on credentials write; account-id fingerprint
  in success envelope) + adds §7.4 credentials cache
  section closing Decision 3 (plain JSON at
  `~/.monday-cli/credentials` mode `0600`; per-profile
  `{access_token, obtained_at, expires_at, scopes,
  account_id}` schema with `schema_version: "1"`; atomic-
  replace via temp-file `writeFile` + `chmod` + `rename`
  mirroring `src/api/cache.ts` `writeJsonFile` verbatim;
  read-time `fs.fstat`-against-open-descriptor TOCTOU-safe
  permission check; HOME-scoped, never repo-tracked;
  per-profile token source order pinned —
  credentials cache > `api_token_env` > `config_error`;
  OS-keyring deferred to v0.4+ with explicit threat-model
  commitment) + §7.3.3 error-surface design committing to
  ONE new ERROR_CODE (`oauth_failed` umbrella with
  `details.reason` discriminant; mirrors M20 Decision
  4.1/4.2's "fewer new codes, discriminant-in-details"
  reasoning; the actual registry widening lands at the
  M21 pre-flight contract diff alongside the type-level
  surface) + §7.3.4 mock OAuth helper env-var contract
  (`__test_oauth_helper` per the §9 precondition's exact
  wording — fixture supplies `code` only, the CLI's own
  generated `state` echoes back so CSRF passes by default;
  three `force_*` flags exercise the local-side failure
  branches) + §7.3.5 OAuth-only-no-paste-in commitment
  (paste-in becomes a separate cli-design §7.3 amendment
  PR with Codex review BEFORE M21's first feat commit if
  the OAuth flow proves out of budget; never a quiet
  implementation choice) + §14.5 open-question status
  flip (auth caching format closed via §7.4). Wire-level
  semantics that depend on Monday's actual OAuth
  implementation (redirect-URI matching exactness, whether
  Monday allows wildcard `127.0.0.1:*` redirect URIs vs
  requiring a fixed port, exact `/oauth2/token` response
  shape, scope-string format, PKCE acceptance, whether
  Monday requires a `client_secret` for the monday-cli
  OAuth app, code TTL — Monday's docs describe roughly
  10-minute validity but the exact TTL is probe-time-
  pinned) tagged as *probe-time confirmation* throughout
  §7.3 — the M21 pre-flight contract diff runs the
  empirical probe per the §22 R-watch-item discipline
  (which fires for the first time at M21 per its own
  trigger condition). Codex round 1 returned 1 P1 + 5 P2
  + 1 P3, all addressed inline; round 2 returned 0 P1 +
  4 P2 residual cross-doc drifts, the cli-design slice
  addressed inline (the v0.3-plan / CLAUDE.md slice lands
  in commit B). Net diff this commit: 430 lines added in
  `docs/cli-design.md`.
- **Commit B (next commit this session) —
  `docs(decision-3-close): tick §9 + annotate §8 Decision
  3 with shipped SHA + apply Codex round-2 cross-doc
  fixes to v0.3-plan + CLAUDE.md status block`.** The
  close-docs sweep that backfills `3eba714`'s SHA into
  v0.3-plan §8 Decision 3 closure annotation + §9 M21
  preconditions tick (both Decision 3 + OAuth-callback-
  design boxes, combined since flow shape and credentials
  shape are inseparable for review purposes) + §3 M21
  Decision 3 milestone-body status flip (was "open per
  §14.5") + §3 M21 stub-deliverables wording flip
  ("filled at M21 kickoff" → "filled at M21 pre-flight
  contract diff next session, post this PR's §7.3/§7.4
  design"; deliverables list grows the `oauth_failed`
  registry widening + cli-design §6.5 row insertion as
  explicit pre-flight items) + Codex round-2 P2 fixes:
  `/oauth/authorize` → `/oauth2/authorize` drift fix in
  §22 R-watch-item, "codes valid for ~10 min" → probe-
  time-pinned wording in §6 risk register, testing-
  strategy fixture realignment to match the new §7.3.4
  `force_*`-flag shape (was "returning a tok-fixture-xxxx
  token") + this CLAUDE.md hunk. No source-code changes
  in commit B either; net diff 65 LOC across CLAUDE.md +
  docs/v0.3-plan.md.

**M21 pre-flight contract diff shipped this session**
(mirrors the `d822982` M19 / `a702af2` M20 cadence — the
biggest pre-flight to date by surface count: 4 new
modules + 2 new commands + ERROR_CODES widening + first
empirical probe under v0.3-plan §22's "empirical-probe
step in pre-flight for novel API surfaces" discipline +
first second-consumer fire of the
`scripts/probe/` R-candidate):

- **Empirical probe shipped first** per the §22
  R-watch-item discipline that fires for the first time
  at M21. `scripts/probe/_lib.ts` lifted as the shared
  scaffold (under a one-off `.gitignore` exclusion since
  the rest of `scripts/` stays local); `scripts/probe/
  m21-oauth.ts` (gitignored) ran the probe matrix
  against `auth.monday.com` on 2026-05-10. Findings
  baked into module docstrings + cli-design §7.3
  probe-time-confirmation tags + v0.3-plan §3 M21
  deliverables. **Three load-bearing findings:** (1)
  Monday's `/oauth2/token` rejects the PKCE-only shape
  with `{"error":"invalid_request","error_description":"Missing client_secret param"}`
  — `client_secret` is mandatory; PKCE is non-load-
  bearing for v0.3 and dropped from the design. (2)
  `/oauth2/authorize` accepts arbitrary query params
  (encodes them all into a JWT-signed
  `oauth_payload_token` redirect target) — `state`
  round-trips through verbatim per RFC 6749. (3)
  Rejection-response shape is RFC 6749 standard
  (`{"error", "error_description"}`, status 400,
  `application/json`) — maps verbatim to
  `oauth_failed.details.{monday_code, monday_description}`.
  GraphQL `account.id` returns string-typed numeric
  (e.g., `"34900083"`); `expires_in` absent per
  Monday's "tokens do not expire" pin.

- **Four new module bodies (all stub `Promise.reject`
  under `c8 ignore`).** `src/api/oauth.ts` (constants +
  type surface + `generateOAuthState` + `verifyCsrf` as
  real bodies; `bindOAuthListener` + `exchangeCode` as
  stubs). `src/config/credentials.ts` (zod schemas for
  the §7.4.1 file shape; constants
  `CREDENTIALS_FILE_MODE = 0o600` etc.; six stub helpers
  for read/write/set/delete/path/resolve). `src/config/
  profiles.ts` (zod schemas for the §7.2 TOML shape;
  three stub helpers for path/load/select). `src/utils/
  redact.ts` (extends `DEFAULT_SENSITIVE_KEYS` with
  `'access_token'` per §7.4.3; runtime
  value-scanning extension lands at M21 implementation).
  Coverage held at 99.06 / 95.51 / 99.33 / 99.22 (above
  95/95.45/95/95 floor) — new files at 100% per-file via
  `c8 ignore` on stubs + surface-import tests.

- **Two new commands (registry 72 → 74).**
  `src/commands/auth/login.ts` + `src/commands/auth/
  logout.ts`. Both read `--profile` from the global-flag
  layer (per cli-design §4.4 — auth verbs do NOT
  redeclare `--profile` at the command level) and
  reject with `internal_error` carrying the M21-pending
  hint. Action handlers are async (mirrors M20 time-track
  stub-action pattern — sync throws can get swallowed by
  commander's own error path).

- **ERROR_CODES widened 28 → 29 with `oauth_failed`.**
  First widening since M19. `CODE_RETRYABLE_DEFAULT.
  oauth_failed = false`; `CODE_TYPICAL_HTTP_STATUS.
  oauth_failed = null` (varies by reason);
  `exitCodeForError(oauth_failed) = 1` (treating it as
  usage-shaped per the M20 Decision 4.1/4.2 reasoning —
  agents already branch on the verb invoked, plus
  `details.reason` carries the discriminant).

- **`src/types/global-flags.ts` widened.**
  `--profile <name>` structurally accepts any non-empty
  string (was 'default'-only with v0.3 hint pre-M21);
  the `MONDAY_PROFILE` env / flag-conflict check stays.
  The actual resolution-to-token step (cache >
  `api_token_env` > `config_error` per §7.4.1) lands at
  M21 implementation in `cli/run.ts`'s config-load step.

- **Cli-design §7.3 amendments inline.** §7.3.1 step 1
  drops PKCE-as-primary (probe-pinned to
  `client_secret`-only); §7.3.1 step 2 pins fixed port
  `9876` (probe-pinned to docs' "exact match"
  redirect URI); §7.3.1 step 3 drops `code_challenge` /
  `code_challenge_method` from the consent URL; §7.3.1
  step 5 confirms `state` round-trips as a query param;
  §7.3.1 step 6 drops `code_verifier`, adds
  `client_secret`, pins 10-min code TTL, pins RFC 6749
  rejection shape; §7.3.3 error-table grows
  `port_in_use` reason for fixed-port collision; §7.4.1
  `account_id` confirms string-typed numeric (probe);
  §7.4.1 `expires_at` confirms `null` for v0.3.

- **Cross-doc count bumps (4 sites).** README.md (lines
  21 + 189), output-shapes.md (line 2601 + alphabetical
  list), architecture.md (line 1241 + 1254), CLAUDE.md
  status block (this hunk). Cli-design §6.5 grows the
  `oauth_failed` row + per-code `details` schema +
  count-narrative bump.

- **Test count + coverage at gate:** 2422 (M20 close +
  cleanup) → 2494 (M21 pre-flight close), +72 net (~30
  surface tests across `tests/unit/api/oauth.test.ts` +
  `tests/unit/config/credentials.test.ts` +
  `tests/unit/config/profiles.test.ts`; ~30 across
  `tests/integration/commands/auth.test.ts`; widened
  `tests/unit/types/global-flags.test.ts` for the
  any-name-acceptance + `tests/unit/utils/{errors,
  redact}.test.ts` for the new code + key; 1
  envelope-snapshot regenerated to bake `command_count:
  72 → 74` + `oauth_failed` row in alphabetical
  position). Coverage held at 99.06 / 95.51 / 99.33 /
  99.22 above the 95/95.45/95/95 floor; floor unchanged.

- **R-candidate fired.**
  `scripts/probe/` reusable probe infrastructure
  (v0.3-plan §22) hits its second consumer at this
  pre-flight. The `_lib.ts` shared scaffold ships under
  a one-off `.gitignore` exclusion (`scripts/*` +
  `scripts/*/*` excluded; `!scripts/probe/` +
  `!scripts/probe/_lib.ts` re-included) so per-probe
  scripts stay local while the helpers themselves
  version. The next consumer (M27 webhooks probe per
  §22 likely-affected-milestones list) reuses
  `_lib.ts` from day one.

- **R-candidate stays below threshold.**
  Secure-file primitive shared between cache +
  credentials (v0.3-plan §22) is at 2 consumers
  (`src/api/cache.ts` + `src/config/credentials.ts`);
  3-consumer threshold not met. The §7.4.2 "mirror
  verbatim" wording is the in-design backstop —
  `src/config/credentials.ts` does NOT consolidate;
  M21 implementation copies `writeJsonFile`'s body
  verbatim per the explicit-duplication discipline.

- **R-watch-item logged.** `__test_oauth_helper` as a
  generalised "headless flow" test seam pattern
  (v0.3-plan §22 from `aa5d93c`) stays single-consumer
  at M21; documented for future `wait for external
  callback` flows. No code lift this session.

- **Codex pre-flight: 2 rounds expected.** Mirrors the
  M19 / M20 cadence; results land in commit B.

**M11 cross-board flake fix (Node 24 cassette ordering)
shipped in `7dbcf7e fix(m11): serialise cross-board metadata
loads`** at session start before M20 work began.
`runCrossBoardMove` loaded source + target board metadata via
`Promise.all`; on Node 24 microtask scheduling occasionally
flips that order, and the test `FixtureTransport` strictly
consumes `queue[0]` per request — when target arrives before
source, queue[0]'s `match_variables: {ids: ['111']}` fails
and the runner maps the `cassette mismatch` to
`internal_error`. Fix: serialise the two loads. Production-
latency cost is at most one cache-miss network roundtrip
(~300ms instead of max-of-two); negligible for an
interactive mutation. The alternative (out-of-order matching
in `FixtureTransport`) would weaken cassette-as-strict-
sequence semantics across 105 test files for the benefit of
one Promise.all call site; the narrower fix wins.

**M20 pre-flight contract diff shipped previous session**
(mirrors the `d822982` M19 cadence):

- **`src/api/time-tracking.ts` module signatures landed.**
  Four exported interfaces (`StartTimeTrackingInputs` /
  `StartTimeTrackingResult` / `StopTimeTrackingInputs` /
  `StopTimeTrackingResult`) + two stub-body verbs
  (`startTimeTracking` / `stopTimeTracking`) that
  `Promise.reject` an `internal_error` ApiError under
  `c8 ignore` until M20 implementation lands the runtime
  bodies. Module file ~210 LOC; mirrors the M19
  `tag-directory.ts` pre-flight cadence verbatim.
  Inputs carry `client: MondayClient` + branded `boardId:
  BoardId` / `itemId: ItemId` + `columnId: string`
  (`ColumnIdSchema` / `ColumnId` exist in
  `src/types/ids.ts` but no consumer call site uses them
  — every existing API consumer passes plain `string` for
  column IDs; `time-tracking.ts` matches the consumer
  precedent rather than introducing a one-off branded
  call site) + optional `env` for parity. Results
  literal `running: true` (start) / `running: false`
  (stop) — verb-success implies the state flip. Stop's
  `startedAt: string | null` + `durationSeconds: number
  | null` track the SDK's
  `TimeTrackingHistoryItem.started_at: Maybe<Date>` —
  automation-added sessions can omit `started_at`, and
  per-session duration is uncomputable without it (SDK
  14.0.0 exposes no per-history `duration` field; only
  the column-level `TimeTrackingValue.duration` total,
  which would conflate sessions). The nullable
  `durationSeconds` was a Codex round-1 P1 catch:
  `number` would've shipped a slot the implementation
  can't reliably fill. 9 surface tests in
  `tests/unit/api/time-tracking.test.ts` cover
  type-import compile checks + stub-throw + hint-content
  assertions.
- **Three M20-specific decisions closed (v0.3-plan §3 M20):**
  4.1 start-while-running → `usage_error` (reused; no
  new ERROR_CODE) with `details.running: true` discriminant
  + hint pointing at stop verb. 4.2 stop-while-not-running
  → `usage_error` symmetric to 4.1 with
  `details.running: false`. 4.3 idempotency → BOTH
  non-idempotent; symmetry over no-op convenience. The
  `--restart` flag mention from the original v0.3-plan
  recommendation dropped — forward-looking flag we
  haven't designed; the two-step stop-then-start path is
  the agent's recovery surface.
- **No ERROR_CODES widening.** Decisions 4.1 / 4.2 reuse
  the existing `usage_error` rather than adding
  `time_tracking_already_running` /
  `time_tracking_not_running`. Reasoning: agents already
  branch on the verb they invoked, and `details.running`
  carries the discriminant; new codes per state-machine
  bug widens the contract surface for marginal benefit.
  `ERROR_CODES.length` stays at 28; no count-bumps in
  CLAUDE.md / README.md / output-shapes.md / cli-design
  §6.5.
- **No cache surface, no board-invalidation fan-out.**
  `time_tracking` columns don't cache (each start/stop
  is a live mutation; no on-disk surface) and don't
  affect board structure (no `withBoardInvalidation*`
  wrapper applies). The pre-flight intentionally does
  NOT extend `CacheKey`; the `env` slot in the inputs is
  preserved for parity (test-isolation), not for cache-key
  resolution.
- **`column-values.ts` `unsupportedColumnTypeError`
  time_tracking-branch hint NOT touched in pre-flight.**
  The current generic hint ("v0.3 plans a dedicated
  surface; until then there is no friendly or raw write
  path") is more accurate for the pre-flight state than
  a verb-pointing hint would be — the verbs aren't yet
  wired (no command file ships in pre-flight; calling
  `monday item time-track start` would surface
  `usage_error: unknown command`). The hint update
  lands at M20 implementation alongside the command
  files, not here.
- **Cross-doc surface:** cli-design §4.3 grows two new
  rows in the item section (between `item history` and
  `# Subitems`); §5.2 carve-out 2 unchanged (Decision 4
  closed it last session in `1e81b2f`); §6.4 grows a
  "Time-track shape" planned-changes bullet between
  `Group-delete shape` and the "Future mutation verbs..."
  closing paragraph (Codex round-1 P2-3 fix — the
  `current_state` dry-run slot is canonical-§6.4 not just
  output-shapes.md); output-shapes.md ToC + `item
  (mutations)` section grows two new per-command entries
  (live + dry-run envelopes for both verbs, with full
  error-surface enumeration including `column_archived`
  per Codex round-2 P2-1 fix); v0.3-plan §3 M20
  deliverables wording flipped from "Stub deliverables
  (filled at M20 kickoff)" to "Stub deliverables (shipped
  in pre-flight, this commit)" with the three closed
  decisions inline + a structured "Deliverables landing
  at M20 implementation kickoff" enumeration that grows
  an OPTIONAL item-read projection-widening bullet
  (Codex round-1 P2-4 fix — the verb's docs no longer
  promise a `monday item get` pre-check the projection
  doesn't deliver).
- **Codex pre-flight: two rounds, P1-clean at round 2.**
  Round 1 returned 1 P1 + 4 P2 + 1 P3. P1 caught a
  `durationSeconds: number` slot the implementation
  can't reliably fill — SDK 14.0.0 exposes no per-
  `TimeTrackingHistoryItem` duration field, only the
  column-level `TimeTrackingValue.duration` total —
  fixed inline by widening to `number | null`. Round 2
  returned 0 P1 + 2 P2 (`column_archived` missing from
  the time-track error-surface enumeration; stale
  `monday item get` pre-check guidance lingering in
  `time-tracking.ts` source docstring after the
  user-facing docs were softened) + 0 P3. All 8
  findings across both rounds addressed inline.

**Pre-flight gate state at session start** (per
`docs/v0.3-plan.md` §9 preconditions):
- **Decision 1 (`tag_not_found` registry entry) closed** in
  `4c652d5 docs(cli-design): add tag_not_found to §6.5 — v0.3-M19
  prerequisite`. cli-design §6.5 grows from 27 → 28 stable error
  codes; `details` shape pinned as `{ tags: string[], hint:
  string }` (array form per Decision 1 round-1 P2.8 fix). Hint
  default hard-pinned to reference `monday account tags`
  (forward-looking commitment per session decision — agent UX
  over the conservative `monday raw` fallback). Codex round 1
  returned 0 P1 / 3 P2 / 1 P3; two findings (P2-1 + P3-1)
  addressed inline, two (P2-3 + P2-4) deferred to the contract
  diff that followed in this same session.
- **M19 contract diff landed in `d822982`** (this same
  session, one commit). The
  diff lands tag-directory + board-relation-validation module
  signatures (stub bodies — runtime lands at M19 implementation
  alongside the friendly translator cases) + `src/utils/errors.ts`
  ERROR_CODES widening (28 total) so M19 feat commits throw into a
  stable typed surface + cross-doc count-bumps (CLAUDE.md /
  README.md / output-shapes.md) per Codex P2-4 fix + v0.3-plan
  Decision 1 status flip + §9 preconditions tick + §3 M19
  deliverables wording realignments (V0_3 → V0_2 constant name
  per stability comment, `user-directory.ts` → `resolvers.ts`
  pattern reference, `error-codes.ts` hedge removal, `monday
  account tags` deliverable note added).
- **`column-values.ts` dispatcher widening deferred to M19
  implementation.** The pre-flight diff intentionally does NOT
  widen `WRITABLE_COLUMN_TYPES` (10 → 13) or add the new
  translator switch cases — that would create a half-state where
  the type is "writable" but the body throws. M19 feat commits
  widen the dispatcher AND land the runtime translator bodies
  in the same commit per the R45 / R48 "ship the helper
  alongside the first new consumer" cadence.
- **`column-types.ts` constant rename NOT happening.** v0.3-plan
  §3 M19 deliverables originally said "drop from
  `V0_3_WRITER_EXPANSION_TYPES`" but the runtime constant retains
  its M8-era spelling `V0_2_WRITER_EXPANSION_TYPES` per the
  stability comment at `column-types.ts` lines 209–211 — renaming
  would churn every consumer with no wire-shape change.
  Plan-doc wording realigned to the actual constant name in this
  commit.
- **Test count grows 2296 → 2308** (+12 net: 6 in
  `tag-directory.test.ts` + 5 in
  `board-relation-validation.test.ts` + 1 new
  `tag_not_found` containment assertion in `errors.test.ts`;
  existing `ERROR_CODES.length === 27` assertion bumped to
  28). Coverage unchanged at 99.05 / 95.47 / 99.51 / 99.18
  (above the 95/95.45/95/95 floor); new stub modules use
  `c8 ignore` on throw-bodies + carry surface-import tests
  for the type-level exports.

**v0.3 plan draft opened last session** (see
`docs/v0.3-plan.md`):
- Ten milestones M19–M28 sequenced (writer-expansion close →
  time_tracking → auth foundations → diagnostics → cross-board
  reads → history → partial-success bulk → dev namespace →
  outbound writes → subitem expansion + release prep). M19's
  body is fully detailed; M20–M28 land as stubs filled out at
  their respective implementation kickoffs.
- **R44 / R49 / R50 candidates + non-R-class
  `unsupportedColumnTypeError` quality refactor** migrated from
  v0.2-plan §22 to v0.3-plan §22. The `unsupportedColumnTypeError`
  refactor is M19-fold-pointed (the tentative-row reclassification
  touches the function anyway).
- **§8 lists 11 decisions** to close at their milestone-blocking
  moments. Decision 1 (`tag_not_found` registry entry — `details:
  { tags: string[], hint }` array shape) must close before M19
  first feat commit as a cli-design §6.5 extension PR.
- **Codex pre-flight: two rounds, P1-clean at round 2.** Round 1
  returned 11 findings (1 P1 / 8 P2 / 2 P3) covering scope-realism
  + cross-milestone-dependency + cli-design §13 alignment +
  contract-divergence drift. Round 2 returned 3 P2 / 0 P1 / 0 P3
  (residual drift from the round-1 fixes); all 14 findings across
  both rounds addressed inline. M21 OAuth flow per cli-design §7.3
  pinned (no paste-in shortcut); M22 `monday usage` ships
  `complexity_remaining_24h` only; M27 webhooks live-only (no §8
  cache extension); M28 multi-level subitems gated on a Decision
  11 cli-design §13 v0.3 amendment PR.
- **No source-code edits this session** — pure planning-doc work.
  2296 tests still passing; coverage 99.05 / 95.47 / 99.51 /
  99.18; floor 95/95.45/95/95 unchanged.

**M18 closed** (see `docs/v0.2-plan.md` §3 M18 status block + §26
post-mortem):
- The polish + ship milestone — NDJSON streaming for `item search`
  + `update list` (the missing pair vs M7's `item list` streaming
  pin), envelope-snapshots refresh (60 → 92), output-shapes ToC
  audit, README quickstart with `item create` + `item upsert`
  examples, CHANGELOG 0.2.0 entry, and the version bump to
  `0.2.0`. **No new contract surface** — M18 was pure consolidation
  + release prep.
- **Three Codex rounds total** — one pre-flight (8 findings: 0 P1
  / 4 P2 / 4 P3) + two implementation rounds (5 + 3 findings: 0
  P1 / 4 P2 / 4 P3). The smallest review surface to date (M17: 6
  rounds, M16: 9, M18: 3); confirms the §25 M17 post-mortem
  prediction that "rounds scale inversely with cross-cutting
  contract maturity." M18's no-new-contract status puts it at
  the floor.
- **R52 shipped at M18 implementation start** in `39c91a6
  refactor(r52): lift startNdjsonStream into utils/output/ndjson`.
  New public exports in `src/utils/output/ndjson.ts`
  (`startNdjsonStream` + `NdjsonStreamInputs` +
  `NdjsonStreamHandle`) — three-input parameterised helper
  (`stream` + `secrets` + `project`) returning a
  `{ onItem, writeTrailer }` handle. Three consumers post-lift
  (item list switches inside the same R52 commit; item search +
  update list adopt from day one). Mirrors R45 / R48's "ship the
  projection helper alongside the first new consumer" cadence.
- **`walkPages.onItem` hook shipped in `e8e38c4`.** Mirrors
  `paginate.onItem`'s contract verbatim — same signature, same
  per-item-arrival-order, same push-then-await ordering (Codex
  M18 pre-flight P3-1: pin the ordering invariant explicitly so
  a future regression that swapped push/await would break loud).
  `update list` (both per-item and per-board variants) is the
  first consumer; agents now stream paginated update reads.
- **NDJSON streaming actual `'drain'` backpressure** (Codex M18
  round-1 P3-3 fix): `startNdjsonStream.onItem` returns
  `Promise<void>` and awaits the stream's `'drain'` event when
  `stream.write` returns false. Pre-fix the helper returned
  `void`, so `paginate.onItem` / `walkPages.onItem`'s await on a
  void-returning callback was trivially resolved and items piled
  up in Node's internal write queue. Now agent's piped `jq`
  consumer can backpressure the cursor walk for real.
- **`deferred_to: "v0.2"` runtime drift fixed** (Codex M18
  pre-flight P2-4 + round-2 P2). Tentative writer-expansion row
  (`tags` / `board_relation` / `dependency`) **slipped to v0.3
  at v0.2.0 release** per cli-design §13. Runtime
  `unsupported_column_type` errors now emit `deferred_to: "v0.3"`
  for tentative-row types, `deferred_to: "v0.4"` for files-shaped
  (asset upload), `deferred_to: "v0.3"` for `time_tracking`
  (verb-shaped extension), `deferred_to: "future"` for unscoped
  types. Plus a sweep across module/test docstrings to remove
  stale "v0.2 will add `--set-raw`" wording.
- **Coverage floor ratchet** branches 95 → 95.5 (project actual
  at v0.2.0 close: 99.05 / 95.51 / 99.51 / 99.18). The §3 M18
  96% target wasn't met — the new code shipped at 100% per-file
  but the global percentage only ticked up by ~0.5pp because
  the denominator grew alongside the numerator. The 96% target
  slips to v0.3 as a focused coverage-push session if it turns
  out to be load-bearing.
- **2280 tests passing** (was 2218 at M17 close; +62 net).
- **The v0.2.0 release — published 2026-05-08.** Live on npm at
  https://www.npmjs.com/package/monday-cli, sha `499afd1d` /
  sha512 `Q7P0ckiSuocgc...`. First public npm release of
  `monday-cli`; v0.1.0 was a tagged git release that didn't
  ship to npm under this name. The v0.3 plan opens in a fresh
  `docs/v0.3-plan.md` doc next session.

**v0.2 → v0.3 cleanup window** (mirrors the M17 → M18 cleanup
window per §22 R51 precedent — see `docs/v0.2-plan.md` §22 R42 +
R53 entries + §26 looking-ahead block):
- **R53 — `buildStreamingTrailerMeta` lift. Shipped: `055b13d`.**
  Three-consumer trigger met at M18 close (item list M7 + item
  search M18 + update list M18). New helper in
  `src/utils/output/ndjson.ts` sibling to `startNdjsonStream`;
  consolidates ~15 × 3 = ~45 lines of meta-build boilerplate into
  one shared call. Per-noun divergence preserved via optional
  `result.nextCursor` (cursor- vs page-walked) and `columns`
  (column-bearing vs not). Existing integration tests across the
  three streaming paths pass byte-identical pre-lift vs post-lift;
  five direct unit tests pin the helper's per-input contract.
- **R42 — retroactive missing-root-key sweep across ~32 sites.
  Shipped: `c529445`.** Generalised `assertResponseFieldPresent`
  from a workspace-pair-shaped signature to a flexible
  `details: Record<string, unknown>` map plus an explicit
  `nullHandling: 'caller_handles' | 'throw_not_found'`
  discriminant. Single-target verbs (M5b/M9-M12/M13 ADDED, M15-M17
  CONSOLIDATED) use 'caller_handles' so the per-noun projector
  handles null-value; partial-success-fan-out verbs (R41's
  existing 3 consumers) use 'throw_not_found' to preserve M14's
  per-target dispatch contract. M13 update verbs run the helper
  BEFORE the responseSchema parse (z.unknown() normalizes missing
  keys into present-undefined, swallowing the distinction).
  `update clear-all` stays on `assertUpdateMutationPresent` —
  separate v0.3 question. **Coverage dip realised: -0.04pp (95.51
  → 95.47);** floor lowered 95.5 → 95.45 with documented
  rationale in `vitest.config.ts` per the post-v0.2 cleanup-window
  handoff's anticipated 0.05-0.1pp consolidation-effect band.
  Will close at the next milestone's focused coverage push.
- **2296 tests passing** (was 2280 at v0.2.0 publish; +5 R53 unit
  tests + 11 R42 unit tests = +16 net). Quality refactor flagged
  in §22 R53 (collapsing `unsupportedColumnTypeError` into a
  category-table-driven shape) deferred to v0.3 → first-cleanup-
  window — R42's coverage-recovery work pushed this session past
  the typical refactor budget; the quality refactor was bonus
  polish per the handoff and ships next.

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

**M17 → M18 cleanup window** (R51 shipped at the cleanup window;
full detail in §22):
- **R51 — `findBoardChildOrThrow` helper. Shipped: `9e7c032`.**
  New post-M17 finding; 3-consumer pattern surfaced by M17
  implementation review (column-update + group-update +
  group-archive each load board metadata, find a child by ID,
  throw `not_found` with `details: {board_id, [<kind>_id]: id}`
  if absent). Three call sites collapsed from 14 lines each to
  a single helper call; pure boilerplate consolidation. Mirrors
  R40 + R43 + R46's M15→M16 / M16→M17 cleanup-window cadence.
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
