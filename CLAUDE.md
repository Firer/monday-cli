# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.4-M30 IMPL landed end-to-end; next v0.4 milestone TBD.**
Six-commit IMPL cluster on top of the M30 pre-flight base:
`8faf20e` (`feat(m30): land --concurrency runtime body —
bounded async-pool + AbortSignal threading`) — replaces the
`dispatchParallel` stub with a runtime body, drops the
`c8 ignore` on the parallel-route arm in
`src/api/partial-success-bulk.ts`, threads `signal?:
AbortSignal` on both dispatchers, lands 18 unit tests + 6
integration tests; followed by five Codex impl-review fix-up
commits (`dbcf67d` round-1: 0 P1 + 0 P2 + 3 P3 — `signalReason`
lift to `src/utils/signal.ts:extractSignalReason` (R-NEW-55)
+ axis-2 JSDoc reword + pre-IMPL tense flip; `71ab6be`
round-2: 0 P1 + 0 P2 + 1 P3 — lift-site JSDoc described the
pre-lift state; `05c25bf` round-3: 0 P1 + 0 P2 + 2 P3 —
4 `dispatchSequential`-only doc sites + 3 missing
integration tests (N=8 smoke + `concurrency_exceeded` retry +
SIGINT mid-dispatch); `58e9fd5` round-4: 0 P1 + 0 P2 + 3 P3
— 6 MORE `dispatchSequential`-only sites + N=8 assertion
strengthening + SIGINT stdout-empty assertion; `a05585b`
round-5: 0 P1 + 0 P2 + 1 P3 — cli-design §6.4's contract-
prose sweep to "selected dispatcher" framing). **5-round IMPL
convergence matches the v0.3-M27 W8 cadence**, not the
v0.3-M25 1-round cadence — driven by one prose-drift class
("dispatchSequential-only" framing) with many small sites
across the spec + module docs + internal comments + test
assertions; each round caught a new cluster. Runtime body
was clean from round 1; all rounds 1-5 returned 0 P1 + 0 P2.

**M30 highlights.** Smallest non-trivial v0.4 surface — extends
the v0.3-M25 partial-success-bulk path (`monday item update
--where ... --continue-on-error`) with one new argv flag.
Envelope shape **byte-equivalent** to M25 (`data.results[]`
per-item records + `data.summary.{matched,applied,failed}_count`
slot + `ok: true` universal-partial-success rule unchanged).
**Five constraints pinned at pre-flight + held at IMPL** (D1–D5):
`--concurrency` ranges `[1, 32]` with default `1` (sequential,
byte-equivalent to M25); REQUIRES `--continue-on-error`
(rejected with `usage_error` on the fail-fast bulk path;
parallel fail-fast deferred indefinitely); rejected on the
single-item shape at `validateInputShape` time; bounded
async-pool dispatch strategy (NOT `Promise.all` on the full
batch); `concurrency_exceeded` inherits the existing
`src/api/retry.ts` layer (no M30-specific retry logic).
Bounded async-pool implementation: N workers pull targets
from a shared cursor and assign results by input index (NEVER
push) so the result array preserves input order; cooperate
on an `aborted` flag for whole-call re-throw (`internal_error`
mirrors M14 round-2 F1 escape hatch; non-`MondayCliError`
mirrors axis 3; abort propagation mirrors axis 6). Optional
`signal?: AbortSignal` parameter on BOTH dispatchers
(`dispatchSequential` + `dispatchParallel`) — the dispatcher-
level signal is the pool scheduler short-circuit; in-flight
wire calls abort via the existing `MondayClient.signal`
configured at construction time. **No new ERROR_CODE** —
`concurrency_exceeded` lives in the 29-code registry already.

**Live numbers (M30 IMPL close):**
- Test count: **3347 + 1 skipped** across **134** test files
  (+27 net vs 3320 + 1 skipped M30-pre-flight baseline; 18
  new unit tests at `tests/unit/api/parallel-dispatch.test.ts`
  + 9 new integration tests appended to
  `tests/integration/commands/item-update-bulk.test.ts`).
- Coverage: **99.23 / 96.23 / 99.39 / 99.52** (stmts /
  branches / fns / lines) against the **95 / 95.45 / 95 / 95**
  floor. Branches margin **0.78pp** (+0.01pp vs M30 pre-flight
  close's 0.77pp) — the c8 ignore drop on the parallel arm
  added new branches to the denominator; integration tests
  cover them. **v8 instrumentation glitch** documented for
  `dev-conventions.ts` has spread to `parallel-dispatch.ts` +
  `partial-success-bulk.ts` + `partial-success-mutation.ts`
  (none appear in the coverage table despite full test
  coverage); cosmetic, global percentages hold above floor.
- ERROR_CODES count: **29** (unchanged — `concurrency_exceeded`
  pre-existing per M2 retry-layer work).
- Command count: **96** (unchanged — `--concurrency` is a
  flag extension on `monday item update --where`, not a
  new verb).
- `package.json` version: **0.3.0** (stays through v0.4
  milestones; bumps to `0.4.0` at v0.4 release-prep).

**R-class state (post-M30 IMPL close):**

- **R-NEW-55 shipped** (Codex round-1 P3-1 fix at `dbcf67d`):
  `signalReason` lift to `src/utils/signal.ts:
  extractSignalReason`. Three consumers post-lift —
  `dispatchSequential` / `dispatchParallel` /
  `sleepWithSignal`. `src/api/retry.ts:signalAbortError`
  stays inline due to its deliberate `name = 'AbortError'`
  rename for DOMException-style branching (lift-site JSDoc
  carries the carve-out paragraph). v0.4-plan §22 R-NEW-55
  entry has full detail.
- **R-NEW-56 shipped (process discipline)** via the new
  "Pre-IMPL cross-doc grep" workflow rule in this file's
  Workflow rules section. M30 IMPL's 5-round prose-drift
  convergence is the load-bearing lesson; future "flag
  extends existing surface" milestones run a `grep -rn
  '<existing-symbol>' src/ docs/ tests/` at IMPL kickoff to
  enumerate every site needing the new framing BEFORE
  running Codex round 1. Mitigation collapses 4-5 rounds to
  1-2. **Not a code lift** — process discipline applied at
  the IMPL session's kickoff.
- **R-NEW-45 stays at 2 consumers.** M30's bounded async-pool
  doesn't use a cancellable timer between worker completions
  (workers idle on `Promise.all` resolution), so the 3rd-
  consumer trigger didn't fire.
- **R-NEW-28** held cleanly across all 5 IMPL Codex rounds.
  R-NEW-52 watch-item fired its **2nd consumer** at round-3
  P3-1 (4 sites in `partial-success-bulk.ts` that documented
  only `dispatchSequential`'s behaviour) + round-4 P3-1 (6
  MORE sites) + round-5 P3-1 (4 cli-design §6.4 contract-
  prose paragraphs). The drift class caused **5 of 5** M30
  IMPL Codex rounds to surface P3 findings under the same
  umbrella. **Stays at 2 distinct consumers (M30 pre-flight +
  M30 IMPL)**; fires at 3rd consumer (next opt-in-flag-
  extending milestone with parallel-vs-sequential routing).
  Mitigation pattern surfaces as **R-NEW-56's cross-doc grep**
  — the upstream root cause is "IMPL author didn't enumerate
  all sites before kicking off Codex".
- **R-NEW-51 / R-NEW-53 / R-NEW-54** stay at 1 consumer each.
- **R-NEW-57 (Bounded async-pool pattern lift) + R-NEW-58
  (Lift-ahead-of-feat discipline for R-class 3rd-consumer
  triggers)** — new watch-items surfaced at M30 IMPL close,
  both at 1 consumer. R-NEW-57 fires at 2nd parallel-dispatch
  surface (likely M31+ multi-target write verb with
  `--concurrency`); R-NEW-58 fires at 2nd "3rd-consumer
  crystallizes at IMPL kickoff" milestone. Full detail at
  v0.4-plan §22.

Per-milestone narrative + Codex round detail + lessons learned
live in `docs/v0.4-plan.md` §12 (M30 post-mortem). Do not
duplicate here.

**Next session — likely scope:**
1. **v0.4-M31 candidate selection.** The user picks the next
   milestone based on incoming usage signal. Candidates per
   v0.4-plan §3 ordering: asset upload (multipart
   `add_file_to_column`); `doc list/get` (workdocs query
   stability); `team` writers (analogous to M14
   `workspace add-users`); shell completion (bash/zsh
   completion scripts); release-prep (CHANGELOG + version
   bump + npm publish for v0.4.0). M31 pre-flight runs in
   the session after the candidate is picked.
2. **`monday usage` timezone semantics verification** —
   carried over from v0.3 close. M22 shipped with UTC
   `YYYY-MM-DD` as the `today` key derived from
   `ctx.clock().toISOString().slice(0, 10)`. Re-probe
   `scripts/probe/m22-usage-by-day.ts` against an account
   with live usage activity. If Monday's runtime `day` field
   is account-local, amend cli-design §11.5.3 + flip
   `formatTodayKey` in `src/commands/usage.ts`.
3. **v8 instrumentation glitch.** Now spread to 3 more
   modules at M30 IMPL (`parallel-dispatch.ts` +
   `partial-success-bulk.ts` + `partial-success-mutation.ts`
   join `dev-conventions.ts`'s pre-existing case). Cosmetic
   — global percentages hold above floor — but worth
   investigating at v0.4 release-prep before the next tag.
   Workaround if it becomes systematic: `coverage.include`
   overrides in `vitest.config.ts`.
4. **OAuth — deferred indefinitely.** Unchanged from v0.3
   close. `OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET`
   placeholders + the `auth/login.ts` placeholder guard
   produce a clean `usage_error.details.reason:
   oauth_unregistered` for users invoking `monday auth
   login`; revisit only if user feedback shows clear demand
   for the browser-based OAuth path.

**v0.3.0 published — release complete.** M28 IMPL
shipped end-to-end across 8 release-prep commits
(`d9ad757` CHANGELOG + `e7459c2` envelope-snapshot
refresh + `f2600fa` ToC audit + stale-`deferred_to`
slip-to-v0.4 + `4fddc38` README v0.3 quickstart +
`1a87087` version bump 0.2.0 → 0.3.0 + `59c8b58`
close-docs sweep + `472ad1e` branch-coverage residual
tests +0.43pp margin + `5e8c210` housekeeping refresh
of post-coverage stats) + the annotated `v0.3.0` git
tag pointing at `5e8c210`. **Pushed to `origin/main`**
+ **GitHub release live** at
https://github.com/Firer/monday-cli/releases/tag/v0.3.0
with the full CHANGELOG body + **npm publish landed
2026-05-13T12:24:51Z** (`monday-cli@0.3.0`, `latest`
dist-tag). v0.3.0 ships **no breaking changes vs
v0.2.0** — every v0.3 surface is additive across
M19–M28. The npm publish step required the user to
`npm login` separately (`npm whoami` returned 401 in
the session shell — fixed user-side).

**M28 pre-flight rejected Decisions 10 + 11** on
empirical grounds — multi-level subitem creation
deferred out of v0.3 scope. Empirical probe
(`scripts/probe/m28-multi-level-subitem.ts` +
`scripts/probe/m28-depth-triangulate.ts`, 2026-05-13,
API `2026-01`) confirmed Monday's `sub_items_board`
has no `subtasks` column at the pinned API version, so
depth-2 nesting has no data-model home. Direct
`create_item` on the `sub_items_board` returns
`InvalidBoardIdException`: "Can't create an item on
subitems board"; `create_subitem` against a subitem
parent returns bare `USER_UNAUTHORIZED`. Independently
confirmed in Monday's UI (UI also refuses to create a
sub-sub-item). Pinned API `2026-01`
(`@mondaydotcomorg/api@14.0.0`) doesn't expose the
capability; v0.4 (or v0.3.x) picks it up if Monday's
data model surfaces deeper nesting. **Single-level
subitems remain first-class** via the existing M9
carve-in: `item create --parent <iid>`, `item subitems
<iid>`, and all standard item verbs (`item get/update/
set/clear/move/archive/delete/duplicate/history`)
operate uniformly on subitems.

**M28 IMPL audit finding — stale `deferred_to: "v0.3"`
in two production surfaces, slipped to `v0.4`.** Two
sites pointed at the version being released (would
have told v0.3.0 agents to "wait for v0.3"): (a)
`src/commands/item/create.ts` multi-level subitem
rejection's `details.deferred_to` + matching
integration test pin in
`tests/integration/commands/item-create.test.ts`; (b)
cross-board `item move` value-overrides doc note in
`docs/cli-design.md` + `docs/output-shapes.md` (was
v0.3-targeted at M11 close; no v0.3 milestone picked
up the extension — Monday's `ColumnMappingInput`
carries no value slot). Both flipped to `v0.4` at
`f2600fa`; CHANGELOG 0.3.0 entry surfaces the
`deferred_to` value change to agents that key off the
slot. The `time_tracking` + `v0_2_writer_expansion`
categories' `deferred_to: "v0.3"` references stay —
both semantically correct (`time_tracking` verb pair
landed at M20; `v0_2_writer_expansion` is
documented-dead-code post-M19's
`V0_2_WRITER_EXPANSION_TYPES = []`).
**`monday auth login` deferred indefinitely.**
`OAUTH_CLIENT_ID` + `OAUTH_CLIENT_SECRET` stay as
`<UNREGISTERED_PENDING_OAUTH_APP>` placeholders in
v0.3.0. The M28 pre-flight commit adds a one-line
placeholder guard at the top of `auth/login.ts`'s
action that throws a clear `usage_error.details.
reason: oauth_unregistered` pointing users at
`MONDAY_API_TOKEN` instead of the cryptic upstream
`oauth_failed.code_exchange_failed`. Full M21 OAuth
source + test infrastructure stays as dormant infra
(`monday auth login`-bound tests bypass the guard via
the existing `__test_oauth_helper` test seam). v0.3.x
or v0.4 revisits OAuth if there's clear user demand
for browser-based login over the API-token path.

**Prior milestone — v0.3-M27 closed end-to-end.**
M27 IMPL shipped at `9cb6a74` (`feat(m27): runtime bodies for
webhook list/create/delete + notification send`) + Codex impl
review fix-ups across 4 rounds: round 1 `6f59a83` (0 P1 + 1 P2
+ 1 P3 — pinned operationName literals on all 4 fetcher input
interfaces to close R-NEW-37 W2 audit-point safely-by-
construction + two stale pre-IMPL docstring lines); round 2
`2402a76` (0 P1 + 0 P2 + 1 P3 — W7 + W8 doc/test prose drift
across 3 sites including a misnamed integration test); round 3
`ff724fd` (0 P1 + 0 P2 + 1 P3' — W8 prose precision across 4
sites correcting the round-2 overstatement of Monday's server-
side kind validation); round 4 `64d94d7` (0 P1 + 0 P2 + 1 P3''
— 2 final W8 sites Monday's wire doesn't cross-validate item-
vs-board pairing). Runtime behaviour clean from round 1;
rounds 2-4 were doc/test prose precision only. The W8 wire-
semantics convergence (CLI validates enum + numeric ID shape;
Monday validates target visibility as a `Project`; neither
verifies the CLI-declared kind against the underlying record)
took 4 passes to fully settle across 9 prose sites — filed as
the lesson "doc/test prose precision can take 4+ rounds to
converge for subtle wire semantics" in §20 M27 post-mortem.
M27 pre-flight closed at `af1c2f8` + 3 round fix-ups (`4c402d8`
/ `deca893` / `affbb6b`; round 4 converged).
**M27 IMPL highlights.** 4 wire fetchers (`listWebhooks` /
`createWebhook` / `deleteWebhook` in `src/api/webhooks.ts`;
`sendNotification` in `src/api/notifications.ts`) each issuing
a single `client.raw` round-trip with literal pinned
operationNames (`Webhooks` / `CreateWebhook` / `DeleteWebhook`
/ `CreateNotification`) — operationName is NO LONGER a
caller-overridable input slot (round-1 P2-1 closure), so the
R-NEW-37 W2 audit-point is satisfied safely-by-construction.
4 verb action bodies wired via `emitSuccess` / `emitMutation`
/ `emitDryRun` per §6.1 + §6.4 envelopes. `webhook delete`'s
`enforceDestructiveGate` fires BEFORE `resolveClient` per the
M10 round-1 P2 invariant. `webhook create --config <json>`
parses the JSON once at the parse boundary (raw string would
double-encode against Monday's `JSON` scalar); an absent
`--config` omits the wire variable so Monday's per-event
server-side default applies. `notification send`'s
`--target-type item|board` argv collapses to wire
`NotificationTargetType.Project` at the fetcher boundary; the
CLI-declared kind is trusted + echoed in the envelope but
NOT verified against the underlying record (Monday only
validates target visibility as a `Project`).
**M27 pre-flight highlights** (last session, carried for
context): Two new `src/api/*` modules (`webhooks.ts` with the
21-value `WEBHOOK_EVENT_TYPES` closed enum +
`notifications.ts` with the 2-value CLI-side
`NOTIFICATION_TARGET_TYPES` enum) + 4 new command stubs +
`WebhookIdSchema` brand. **Decision 9 (webhook event-type
validation)** closed inline at pre-flight via the empirical-
probe-pinned 21-value enum (probe ran 2026-05-12, API
`2026-01`). **R-NEW-37 (Codex template W2 audit-point for
GraphQL operation-name / named-operation parity) shipped** at
pre-flight round-1 P3-1 fix-up — `.claude/templates/codex-pre-
flight-review.md` carries W2 as template-stable alongside W1
(redactor). M27 IMPL fired W2's first IMPL-side audit run
and caught a real P2 (round-1 caller-overridable
operationName slots), validating the audit-point's IMPL-side
utility.
**v0.3-M26 closed end-to-end** (carried over from prior
session).
v0.2.0 published to npm 2026-05-08. v0.3 is in progress on
`main`; M0–M25 closed + M26 pre-flight pinned across `1620220` /
`4433297` / `f605260` / `d9b2d6d` + **M26a IMPL shipped at
`19755e3`** (feat) + Codex impl review fix-ups across 3 rounds
(`2be9021` / `c70deb3` / `2a3c06c`) + **M26b IMPL shipped at
`10cd1c5`** (feat) + Codex impl review fix-ups across 3 rounds:
round 1 `34a5bc1` (0 P1 + 3 P2 + 1 P3 — `resolved_ids.status`
echo on 3 task verbs + `dev_board_misconfigured` rewrap of
`walkDevBoardItems` on inaccessible board + `fireDevCreateUpdate`
shared parse boundary + side-effect complexity threading) +
round 2 `078dae3` (1 P1 + 1 P2 + 0 P3 — dynamic
`buildCreateUpdateMutation` so doc named-operation + wire
operationName always match + narrowed `walkDevBoardItems` rewrap
to the exact `{path: 'boards', code: 'too_small'}` zod issue
via `isEmptyBoardsArrayIssue`) + round 3 `8ea66c4` (0 P1 + 0 P2
+ 1 P3 — JSDoc positioning cleanup, cosmetic).
**M26b IMPL highlights.** Runtime bodies of the 10 workflow
verbs (`dev sprint current/list/items` + `dev epic list/items`
+ `dev release list` + `dev task list/start/done/block`). New
shared helper `_shared.ts:requireDevBoard` (R-NEW-35 lifted at
IMPL kickoff — 10-consumer trigger; one per workflow verb)
surfaces `dev_not_configured` with `details.slot` when a
noun-specific mapping slot is unset. Seven new helpers in
`src/api/dev-conventions.ts` (R-NEW-36 — `walkDevBoardItems`
across 7 read verbs + `hydrateDevBoardColumns` across 4 verbs +
`findRelationColumnIdToBoard` across 3 verbs +
`extractLinkedItemIds` (handles both `linkedPulseIds` legacy +
`item_ids` newer 2026-01 shapes) + `resolveStatusColumn` +
`resolveCanonicalLabel` + `flipTaskStatus` (3-consumer wrapper
for the start/done/block flip preamble) + `fireDevCreateUpdate`
(round-1 P2-3 lift — shared `create_update` parse boundary
between task done + task block).
**M26a IMPL highlights.** Runtime bodies of the four
`src/api/dev-conventions.ts` stub fetchers (`discoverDevBoards` /
`runDevDoctor` / `loadDevMapping` / `saveDevMapping`) + the three
setup-verb action bodies (`dev discover [--apply]` /
`dev configure` / `dev doctor`) + new
`src/commands/dev/_shared.ts:resolveActiveDevProfile` (lifted out
because all 3 setup verbs AND M26b's 10 workflow verbs need the
same profile-name resolution preamble). Empirical probe at IMPL
kickoff (`scripts/probe/m26-{dev-discover,board-kind,board-type}.ts`)
ratified the heuristic (DEV_NOUN_PATTERNS unchanged) + surfaced
the `Board.type === 'board'` filter requirement to drop
`sub_items_board` virtual entries from the candidate list
(behavior-equivalent refinement; not a contract amendment).
Codex impl review ran 3 rounds: round 1 (1 P1 + 1 P2 + 1 P3) —
P1-1 = `_shared.ts` `resolveActiveDevProfile` swallowed
`UsageError` allowing `dev configure` to write to disk before
emitMutation's re-parse threw; P2-1 = `details.reason` enum-
enforcement via superRefine; P3-1 = soften premature post-mortem
reference. Round 2 (0 P1 + 2 P2 + 1 P3) — P2-1 = the round-1
superRefine was runtime-only and `monday schema`'s
`z.toJSONSchema(outputSchema)` couldn't surface the reason enum;
fix refactored `devDoctorCheckResultSchema` into a structural
`z.discriminatedUnion('status', [ok, warn, fail])` with per-
status detail shapes + tightened `failResult`'s required-reason
signature; P2-2 subsumed; P3-1 = module docstring SHA placeholder
+ ownership-text correction. Round 3 (0 P1 + 0 P2 + 1 P3) —
P3-1 = round-2's discriminated-union refactor incidentally
weakened existing unit tests from message-specific to generic
`toThrow()`; fix strengthened to `safeParse(...).success` +
`issue.path` / `issue.code` asserts. JSON Schema export now
surfaces the closed `DEV_DOCTOR_REASONS` 11-value enum so agents
can introspect via `monday schema dev.doctor`.
R-NEW-25 "findings up front" directive validated for the 10th +
11th + 12th time (M26a IMPL × 3); R-NEW-17 W1 redactor-pattern
audit returned "nothing flagged" across all M26a rounds.
**M25 implementation landed at `fe15181`** (runtime body of
`runPartialSuccessBulkUpdate` + per-item `dispatchSequential`
loop with threaded `foldAndRemap` context per pre-flight
round-1 P1-1 fix + drop of c8-ignore wraps on both the
wrapper body and the action-body routing branch + 32 unit
tests in `tests/unit/api/partial-success-bulk.test.ts` + 10
integration tests extending `tests/integration/commands/item-update-bulk.test.ts`).
**M25 implementation landed at `fe15181`** (runtime body of
`runPartialSuccessBulkUpdate` + per-item `dispatchSequential`
loop with threaded `foldAndRemap` context per pre-flight
round-1 P1-1 fix + drop of c8-ignore wraps on both the
wrapper body and the action-body routing branch + 32 unit
tests in `tests/unit/api/partial-success-bulk.test.ts` + 10
integration tests extending `tests/integration/commands/item-update-bulk.test.ts`).
Preceded by `78889df` (R-NEW-29 `executeItemMutation` lift to
`src/api/item-mutation-execute.ts` — 3-consumer trigger;
single-item + fail-fast bulk + partial-success bulk all share
one wire-call source of truth post-lift). Codex impl review
ran 1 round; surfaced 1 P2 (cli-design §6.4 overstated
"NEVER bubble" doc drift vs the W3 internal_error escape
hatch) + 1 P3 (stale stub prose in module header) — fixed
inline at `c146106`. No P1 surfaced; impl converged in 1
round per the M22/M23 cadence (M24 was 2 rounds).
**M25 pre-flight contract diff landed at `d5839a9`**
(partial-success-bulk module signatures + cli-design §6.4 new
"Bulk per-item partial-success" sub-section + Decision 6 close
+ `--continue-on-error` argv extension). Preceded by `85b93e8`
(R-class cleanup bundle — R-NEW-25 + R-NEW-17 template
fold-ins + R-NEW-27 `isPlainObject` consolidation; 6 sites
migrated). Codex pre-flight review ran 2 rounds: round 1
surfaced 1 P1 (foldAndRemap context-thread requirement) + 1 P2
(empty-match contract drift) + 3 P3 — fixed at `832a169`;
round 2 surfaced 1 P2 (empty-match still drifted) + 3 P3 —
fixed at `67df582`. R-NEW-25 "findings up front" directive
validated for the 7th time (pre-flight × 2 + M24 × 4 + M25
IMPL × 1); R-NEW-17 W1 redactor-pattern audit returned
"nothing flagged" across all M25 rounds (3 total).
**R-NEW-28's six behavioral-equivalence axes** (W2.1-W2.6 in
the impl review prompt) all returned clean at impl round 1 —
validating that the pre-flight rounds had pinned the contract
correctly and the implementation faithfully shipped the
pinned shape.
**M24 implementation landed at `d058172`** (item history
runtime walker + per-event projectors + action body); Codex
impl review round 1 surfaced 1 P1 + 2 P2 (all out-of-band /
W4); all three fixed at `5f10cda`. M23 implementation landed at
`1f09a25` (cross-board `item search` + `board favorites`
runtime bodies). M22 implementation (`3a1b465`) lands the
runtime DNS / TCP / TLS / auth / cache / redaction / env-var
probes for `monday status` + the `platform_api.daily_*`
projection for `monday usage`. Decision 6
(`--continue-on-error` naming) closed at the M25 pre-flight
contract diff `d5839a9` — positive form; cli-design §4.3 bulk
`item update` row + new §6.4 sub-section pin the flag +
envelope shape. Decision 2 (item-history `kind` taxonomy)
closed at the post-M23 M24-prep session via the local
`scripts/probe/m24-history-kinds.ts` empirical probe. Full
findings in v0.3-plan §8.

Per-milestone narratives, post-mortems, and R-class history live
in the plan docs — **do not duplicate them here**:
- `docs/v0.3-plan.md` §11 M19, §12 M20, §13 M21, §14 M22, §15 M23,
  §16 M24, §17 M25, §18 M26a, §19 M26b, §20 M27 post-mortems + §22 R-class
  backlog (R-NEW-1 + R-NEW-4 + R-NEW-5 + R-NEW-6 + R-NEW-7 +
  R-NEW-14/15/16 + R-NEW-17 + R-NEW-19 + R-NEW-21 + R-NEW-25 +
  R-NEW-27 + R-NEW-29 + R-NEW-30 + R-NEW-35 + R-NEW-36 + R-NEW-37
  + R-NEW-38 + R-NEW-42 shipped + R-NEW-2 / R-NEW-3 candidates open +
  R-watch-items including R-NEW-20 / R-NEW-26 / R-NEW-28 /
  R-NEW-31 / R-NEW-32 / R-NEW-33 / R-NEW-39 / R-NEW-40 /
  R-NEW-41 / R-NEW-43).
- `docs/v0.2-plan.md` §3 + §X post-mortems for M8–M18 + §22 for
  R20–R53.
- `docs/v0.1-plan.md` for M0–M7 + M2.5 refactor pass.

**Live numbers (v0.3.0 ready for publish):**
- Test count: **3249** + 1 skipped across 130 files (+24 net
  at M28 IMPL — 18 envelope-shape snapshots at `e7459c2`
  covering account tags / item time-track / auth login
  placeholder guard / monday status / monday usage / board
  favorites / item history / item update --continue-on-error
  / webhook / notification surfaces, plus 6 branch-coverage
  residual tests at `472ad1e` closing the three deferred
  file-level gaps).
- Coverage: **99.26 / 96.40 / 99.37 / 99.51** (stmts / branches
  / fns / lines), at the **95 / 95.45 / 95 / 95** floor.
  **Branches margin 0.95pp** (was 0.52pp pre-`472ad1e`;
  +0.43pp recovery from closing the three deferred file-
  level gaps — `item/search.ts` 88.23% → 100% stmts via
  cross-board `--where Owner=me` + same-column-twice
  integration tests; `errors.ts` 95.37% → 100% lines via
  targeted unit tests on the three defensive branches;
  `dry-run.ts` 96.26% → 100% branches via the
  `env === undefined` spread defensive). **v8
  instrumentation glitch on `dev-conventions.ts`**
  unchanged — still isolated, doesn't drag global
  percentages below floor.
- ERROR_CODES count: **29** (unchanged at M28 IMPL — release
  prep adds no new codes; the `oauth_unregistered` value lives
  under `usage_error.details.reason`, not as a top-level code).
  Command count: **95** (unchanged from M28 pre-flight —
  release prep adds no verbs).
- `package.json` version: **0.3.0** (bumped at `1a87087`).
- `v0.3.0` annotated tag points at `5e8c210` (moved forward
  from `1a87087` to capture `472ad1e`'s coverage lift +
  `5e8c210`'s housekeeping stats refresh); **pushed to
  `origin/main`** + **GitHub release live** at
  https://github.com/Firer/monday-cli/releases/tag/v0.3.0.
- npm registry version: **0.3.0** (`latest` dist-tag,
  published 2026-05-13T12:24:51Z by `nickwebster`).
- Floor never lowered without an inline `vitest.config.ts`
  rationale comment.

**No pre-publish blocker.** `OAUTH_CLIENT_ID` +
`OAUTH_CLIENT_SECRET` stay as
`<UNREGISTERED_PENDING_OAUTH_APP>` placeholders in v0.3.0;
the M28 pre-flight commit added a one-line guard at the
top of `auth/login.ts`'s action that throws
`usage_error.details.reason: oauth_unregistered`
(message: "`monday auth login` is not available in this
release; authenticate via the MONDAY_API_TOKEN env var
instead. OAuth login is deferred to a future version."),
pointing users at `MONDAY_API_TOKEN` instead of the
cryptic upstream `oauth_failed.code_exchange_failed`.
Tests don't depend on the OAuth credential values
(cassettes intercept `/oauth2/token`; the test seam
`__test_oauth_helper` bypasses the placeholder guard).
v0.3.x or v0.4 may register a canonical `monday-cli`
OAuth app if there's demand for the browser-based login
path over `MONDAY_API_TOKEN`.

R-class entries shipped through v0.3-M27 + carried into v0.4
(v0.4-M30 IMPL added R-NEW-55 — see "R-class state" above;
historical entries below stay unchanged):

- **R-NEW-35 — `_shared.ts:requireDevBoard` slot-check helper
  (10 consumers at M26b).** Per-noun
  `mapping[slot] === undefined → throw dev_not_configured`
  preamble that fires 10 times across the M26b workflow verbs
  (one per noun-specific slot check: `tasks_board` /
  `sprints_board` / `epics_board` / `releases_board`).
  Surfaces `dev_not_configured` with `details.slot` +
  `details.profile` + `details.hint`. Lift shipped inline with
  the M26b feat commit at `10cd1c5`. **Status: shipped.**
- **R-NEW-36 — `dev-conventions.ts` workflow-verb helpers
  cluster (7 new exports at M26b IMPL).** Lifts seven helpers
  used across the M26b verbs: `walkDevBoardItems` (7 consumers
  across read verbs), `hydrateDevBoardColumns` (4 consumers
  across mutation + relation-walker verbs),
  `findRelationColumnIdToBoard` (3 consumers across sprint
  items / epic items / task list --sprint),
  `extractLinkedItemIds` (handles both `linkedPulseIds` legacy
  + `item_ids` newer 2026-01 shapes), `resolveStatusColumn` +
  `resolveCanonicalLabel` (the 3 task mutation verbs share
  these), `flipTaskStatus` (3-consumer wrapper for the
  start/done/block flip preamble), plus `fireDevCreateUpdate`
  (round-1 P2-3 lift — shared `create_update` parse boundary
  between task done + task block). Each crosses the R7/R8
  3-consumer threshold. Shipped at `10cd1c5` + `34a5bc1`.
  **Status: shipped.**
- **R-NEW-37 — Codex template audit-point for GraphQL
  operation-name / named-operation parity (3 consumers
  across M26b + M27 pre-flight + M27 IMPL).** Shipped at M27
  pre-flight Codex round-1 P3-1 fix-up (`4c402d8`). The M26b
  round-2 P1-1 catch was the 1st confirming repetition; M27
  pre-flight round-1 P2-1 was the 2nd; **M27 IMPL round-1
  P2-1 (`6f59a83`) was the 3rd — first IMPL-side W2 catch,
  validating the audit-point's IMPL-side utility.** The
  pre-flight stubs documented expected operationNames in
  docstrings only; the IMPL feat shipped with the unsafe
  `inputs.operationName ?? '<PinnedName>'` shape leaving the
  exported contract caller-overridable. W2's IMPL-side run
  caught it; fix dropped the slot entirely. W2 then returned
  "nothing flagged" across M27 IMPL rounds 2-4 (3 confirming
  clean runs). **Status: shipped; 7 total template-stable
  runs across M27 (4 pre-flight + 3 IMPL post-round-1) with
  1 P2 catch (round-1 IMPL) and 6 clean runs.**
- **R-NEW-38 — sprint date-range helpers lift out of
  `commands/dev/sprint/list.ts:_internals` (3 consumers at
  M26b IMPL).** Shipped at the post-M26b drift sweep. Moved
  `dayEpoch` + `extractDateRange` + `classifySprint` + the
  `SprintState` literal union + `SPRINT_STATE_LITERALS` const
  from `sprint/list.ts:_internals` to
  `src/api/dev-conventions.ts`; updated imports in
  `sprint/current.ts` + `task/list.ts`; dropped the
  `_internals` re-export shim. Behaviour preserved — all
  3183 tests pass; coverage even improved slightly (branches
  margin 0.34pp → 0.43pp). The initial drift-sweep draft
  filed this as MEDIUM-priority "lift overdue" + deferred to
  M28; on re-evaluation against the project's lift discipline
  (R-NEW-29/30/35/36 all shipped at 3-consumer threshold),
  deferring was inconsistent + the right call was to ship
  inline. **Status: shipped.**
- **R-NEW-42 — `parseJsonArg` argv-JSON-parse-boundary helper
  (3 consumers at M27 IMPL close).** Surfaced at the post-M27-
  close drift sweep + lifted inline at the 3-consumer threshold,
  mirroring R-NEW-38's same-cadence inline lift at the post-M26b
  drift sweep. Three argv-parse-boundary sites in `src/commands/*`
  shared the same try/catch JSON.parse → UsageError shape with
  per-verb message + details: `monday raw --vars` /
  `board column-create --settings` / `webhook create --config`
  (the 4th JSON.parse site in `item create.ts` is response-side
  recovery, not argv-parse; deliberately NOT migrated). Helper
  lives in `src/utils/json.ts` next to R-NEW-27's `isPlainObject`.
  Behaviour-preserving for agent-facing contracts (`error.code`
  + `cause` identical across all 3 sites); 7 new unit tests at
  `tests/unit/utils/json.test.ts` pin the helper's branch matrix.
  **Status: shipped.**
- **R-NEW-39 — `projectedStatusLabel` / `taskStatusLabel`
  first-status-column helper duplication (2 consumers, M26b;
  LOW priority watch-item).** Surfaced at the post-M26b drift
  sweep. `dev/epic/list.ts:60` and `dev/task/list.ts:69` ship
  byte-identical 11-line helpers walking projected columns for
  the first status / color column with a non-empty `label` (or
  `text` fallback). The companion done-label predicate
  divergence (`DONE_LABELS` Set vs `isDoneOrCancelled` `||`
  chain) is cosmetic. Lift candidate:
  `firstProjectedStatusLabel(item)` + `DEV_DONE_LABELS` /
  `isDoneStatusLabel(label)` in `src/api/dev-conventions.ts`.
  Fires at the 3rd consumer (hypothetical v0.3.x / v0.4 `dev
  release list --state` OR M28 release-prep readiness checks).
  Could ship as a single dev-conventions.ts consolidation
  commit alongside R-NEW-38 when that lift lands.
- **R-NEW-30 — `_shared.ts:resolveActiveDevProfile` lift (13
  consumers at M26b).** Pre-shipped at M26a IMPL (3 consumers
  at M26a — discover/configure/doctor); M26b adds 10 more
  consumers (one per workflow verb). All 13 share the same
  "load profile mapping → resolve → throw if implicit-v1"
  preamble. Shipped at `19755e3`. **Status: shipped.**
- **R-NEW-31 — discriminated-union per-status detail schema
  pattern (1 consumer at M26b; LOW priority watch-item).**
  Stays at 1 consumer (M26a round-2 P2-1 fix's per-status
  detail schemas on `devDoctorCheckResultSchema`); M27
  webhook list doesn't carry per-webhook status either
  (Monday's `Webhook` object has no status field — just
  `id` / `board_id` / `event` / `config`). M26b/M27 didn't
  introduce a 2nd consumer; generalizes to any verb whose
  output carries a status discriminator with per-status
  detail variability. Fires at 2nd + 3rd consumer (likely
  M28 release-prep readiness checks).
- **R-NEW-40 — Codex template W audit-point for
  `[--dry-run]` discipline on new write verbs (1 consumer
  at M27; LOW priority watch-item).** Surfaced at M27 pre-
  flight Codex round 1 P1-1 (`4c402d8`). The initial pre-
  flight contract diff for M27 omitted `[--dry-run]` from
  the §4.3 rows for 3 new write verbs + didn't pin dry-run
  envelope shapes; Codex caught it as P1 because cli-
  design §3.1 #6 + #7 are explicit. Template-stable
  candidate: add a W audit-point asking the reviewer to
  verify `[--dry-run]` discipline at every NEW write verb's
  §4.3 row + output-shapes.md entries. **M28 did NOT fire**
  the watch-item — Decision 11 rejection narrowed M28 to
  release-prep only; no new write verbs landed. Stays at
  1 consumer post-M28; next candidate is any v0.3.x / v0.4
  write verb (e.g., a v0.4 `notification send --users
  <id,id,...>` multi-recipient extension).
- **R-NEW-41 — Asymmetric wire-vs-CLI semantics
  documentation pattern (2 consumers at M27; LOW priority
  watch-item).** Surfaced at M27 pre-flight empirical probe
  Finding 4 (asymmetric `Webhook.config` typing — `JSON`
  scalar on `create_webhook` input + `String` scalar on
  read). **M27 IMPL surfaced a 2nd consumer of the same
  class**: Monday's `NotificationTargetType` wire enum
  collapses CLI's 2-value `--target-type item|board` into
  a single wire `Project` value, meaning the CLI-declared
  kind can't be cross-validated against the underlying
  record at any layer. The W8 wire-semantics convergence
  took 4 Codex IMPL rounds to settle across 9 prose sites
  (§20 M27 post-mortem "Contract drift findings" #2)
  because the asymmetry is subtle. Different shape
  (cardinality-collapse vs scalar-type-mismatch) but same
  documentation-precision-needed class. **Not a code lift**
  — both asymmetries are wire-side facts. **Watch-item
  fires at 3rd consumer for a shared
  `## Wire-vs-CLI semantics documentation conventions`
  section** in `docs/architecture.md`, possibly alongside
  R-NEW-24's potential field-name appendix. v0.4
  `add_file_to_column` is the next likely candidate. **M28
  did NOT add a 3rd site** — Decision 11 rejection
  narrowed M28 to release-prep only; the M28 probe surfaced
  a data-model gap (no `subtasks` column on
  `sub_items_board`) but that's a data-model finding, not
  a wire-typing asymmetry. Stays at 2 consumers post-M28.
- **R-NEW-43 — Deferred-feature surface pattern
  (placeholder guard + sentinel constant + production-
  mode-no-seam integration test) (1 consumer at M28
  pre-flight; LOW priority watch-item).** Surfaced at M28
  pre-flight (`8aeebad`) when OAuth login was deferred
  indefinitely per Decision 11 closure. The three-part
  shape: (Part 1) top-of-action placeholder guard in
  `auth/login.ts` that throws `usage_error.details.reason:
  oauth_unregistered` before any side effect when the
  shipped credentials are still the unregistered
  placeholder AND `__test_oauth_helper` is unset; (Part 2)
  sentinel constant `OAUTH_UNREGISTERED_PLACEHOLDER` in
  `src/api/oauth.ts` with `as string` widening cast at the
  value site to thread the
  `@typescript-eslint/no-unnecessary-condition` vs
  `no-inferrable-types` lint pair without inline disables;
  (Part 3) production-mode-no-seam integration test in
  `tests/integration/commands/auth.test.ts` that bypasses
  the milestone's shared `driveAuth` helper (which
  unconditionally sets the test seam) to construct `run()`
  options manually, verifying the guard's truthy branch
  fires before any wire call. Fires at 2nd consumer; lift
  candidate at trigger is `assertFeatureRegistered()` in
  `src/utils/deferred-feature.ts` + a `runWithoutTestSeam`
  test helper. v0.3.x / v0.4 candidates: any future
  deferred feature gated on external registration (e.g., a
  webhook-delivery verifier needing an HMAC secret; or
  multi-level subitems if Monday's `sub_items_board`
  surfaces a `subtasks` column in a future API version).
- R-NEW-9 (2-stage GraphQL filter+hydrate resolver) stays at
  2 consumers (M22 usage + M23 favorites); M26 dev namespace
  doesn't introduce a 3rd consumer (the workflow verbs are
  single-stage walks + hydrates). M27 also doesn't trigger
  (webhook list + notification send are single-shot wire
  calls).
(full detail in `docs/v0.3-plan.md` §22):
- **Shipped:** R-NEW-1 `isENOENT` lift into `src/utils/fs.ts`
  (`1c77699`, M21 close); R-NEW-4 `statusOutputSchema` +
  `probeResultSchema` import-from-api/probes lift (`0b5af57`,
  post-M22 pre-flight drift sweep); R-NEW-6 Codex pre-flight
  review prompt template lift to
  `.claude/templates/codex-pre-flight-review.md` (`9b0ee78`,
  post-M23 pre-flight round 1 — 3-consumer trigger fired after
  M21+M22+M23 all used the same 7-section prompt structure);
  R-NEW-7 `formatMode` lift into `src/utils/fs.ts`
  (post-M22 close); **R-NEW-14 `errorMessage` + R-NEW-15
  `asError` + R-NEW-16 `errorCode` lifts** into
  `src/utils/errors.ts` (`5a7c88d`, post-M23 audit) — 17 inline
  duplicates consolidated across 13 files; trigger fired at M6
  (R-NEW-14) / M21 close (R-NEW-15) / M22 (R-NEW-16) but went
  unnoticed for 5-12 days across many milestones; the M22
  developer wrote LOCAL copies in `src/api/probes.ts` instead
  of finding the inline sites — the smoking gun that exposed
  the missed triggers at the user-prompted post-M23 audit
  ("are there any refactors not done which should have
  triggered earlier?"). Branches margin recovered 0.04pp →
  0.41pp from the consolidation (net positive on coverage +
  clarity). R-NEW-1 `isENOENT` was refactored on top of
  R-NEW-16's `errorCode` (8 lines → 2 lines; identical
  behaviour). **R-NEW-5 `introspectType()` helper** lifted
  into `scripts/probe/_lib.ts` (post-M23 focused-refactor
  session) — 9+ consumers across M22's 4 probe scripts +
  M23 pre-flight's 5; richest-superset selection set so
  future M24+M25+M26+M27+M28 pre-flights can introspect
  any type kind (OBJECT/ENUM/UNION/INTERFACE/SCALAR) from
  one call; no test obligation since `scripts/probe/_lib
  .ts` is outside the `src/**/*.ts` coverage scope. The
  originally-floated branches-margin recovery never
  materialised (scope discovery — record this for future
  R-class candidates with similar out-of-coverage scope).
  **R-NEW-21 `trialQuery()` + `ProbeRawErrors` lift**
  into `scripts/probe/_lib.ts` (`fa07fb4`, post-R-NEW-5
  audit session) — 4 M23 trial-query probes
  (`m23-favorites.ts`, `m23-favorites-deep.ts`,
  `m23-hierarchy-{item,object}.ts`) converged on the
  same `trialQuery(label, query)` + local `RawErrors`
  shape with truncate-length variations (400/600/800).
  Lift uses `options?: { echoQuery?, truncateBody? }`
  with defaults matching the two most-common settings;
  interface renamed `RawErrors` → `ProbeRawErrors` to
  match the existing `RawHttpResponse` namespace. Two
  cosmetic deltas in probe output accepted as part of
  the lift (`[OK] data: <body>` → `[OK] <body>`; echo
  unified on the `query:` prefix). Same out-of-coverage
  scope as R-NEW-5 — no branches-margin movement; the
  M24 pre-flight kickoff's branches recovery still falls
  to targeted seam tests on `cross-board-search.ts`.
- **Open candidates:** R-NEW-2 `credentialsHomeOptions`
  (fires at `monday auth status`, v0.3.x); R-NEW-3
  `wrapFsError` factory (M22 + M23 + M24-pre-flight did
  NOT trigger); R-NEW-8 `missingByDifference` set-delta
  helper (2 consumers; fires at 3); R-NEW-9 2-stage
  GraphQL filter+hydrate resolver shape — **STAYS AT 2
  consumers** (M22 usage + M23 favorites); M24 `item
  history` shipped as 2-SOURCE MERGE not filter+hydrate
  (Decision 2 closure ratified the shape; M24-prep
  empirical-probe ran first), so the M24-planned third
  consumer never materialised. Watch-item active at M27
  (webhook source set might be filter+hydrate-shaped).
- **R-watch-items:** `vi.stubGlobal('fetch')` boundary mock
  pattern (still single-consumer in production probe scripts);
  Post-OAuth fresh-transport pattern (single-consumer);
  `c8 ignore` vs v8 branch-coverage friction (tooling — M23
  pre-flight recovered branches margin to 0.04pp; tight);
  **filesystem-state probes** for non-ENOENT fs-error
  branches (test-pattern; EISDIR-via-dir-at-path probe
  ratified at `7058754`); **empirical-probe-step
  -in-pre-flight** — fired FOUR TIMES (M21 OAuth `5c07840`,
  M22 `platform_api.daily_*` reshape `fbab6b0`, M23 cross-board
  + favorites `3a2f1db`+`1fefdb1`, M24-prep history kinds
  `a1f3025` closing Decision 2), discipline ratified as
  always-run-for-novel-API-surface pre-flights; **mockable-
  seam pattern in probes** — ratified at M22 via per-probe
  injection slots, carries to any future probe-style surface
  (webhooks M27 candidate); **R-NEW-10 stable warning-builder
  factory** — 6 sites today (buildCapWarning,
  buildNoncanonicalWarning, buildInaccessibleBoardsWarning,
  buildColumnNotFoundOnBoardWarning,
  buildCrossBoardTruncatedWarning, buildStaleFavoritesWarning);
  inner-details shapes differ enough that lifting now would
  be over-engineering — LOW priority watch-item; fires only
  if 3+ builders converge on identical inner-details shapes;
  **R-NEW-11 pre-flight stub factory** — 15+ sites across
  M19-M23 pre-flights but each stub's surface-specific hint
  is the load-bearing payload; LOW priority watch-item;
  **R-NEW-12 structured `params` through error envelope** —
  `parse-argv.ts:summariseIssues` now preserves
  `ZodIssue.params` (M23 round-2 P2-3); LOW priority
  watch-item; fires when a 2nd + 3rd `.superRefine` rule
  wants to surface structured per-issue context; **R-NEW-13
  command-output union-schema pattern** — M23 round-2 P1-1
  introduced `z.union([itemSearchOutputSchema,
  crossBoardSearchOutputSchema])`; LOW priority watch-item;
  fires when M25/M27/M28 cross-cutting extensions need the
  same union shape; **R-NEW-17 redactor-pattern check at
  pre-flight** — **Shipped: `85b93e8`** (M25 pre-flight
  kickoff cleanup bundle). Surfaced at M23 impl
  (`column_token` rename; v0.3-plan §15 contract drift
  finding); applied per-prompt AT M24 pre-flight + impl
  Codex reviews (4 rounds clean), then folded into
  `.claude/templates/codex-pre-flight-review.md` as the
  template-stable W1 audit-point at the M25 pre-flight
  kickoff. M25 pre-flight rounds 1+2 returned "W1: nothing
  flagged" against the new partial-success-bulk detail-key
  surfaces, validating the template-stable form;
  **R-NEW-18 sequential
  per-board fan-out builder** — surfaced at M23 impl
  (`crossBoardSearch` walker); LOW priority watch-item. M24
  `item history` shipped as CHRONOLOGICAL MERGE
  (`mergeByCreatedAt` over fully-drained lists), NOT
  sequential per-board fan-out, so the watch-item stays at
  1 consumer. Fires at M27 webhook fan-out if it duplicates
  the M23 shape;
  **R-NEW-19 migrate manual `safeParse → ApiError` sites to
  `unwrapOrThrow`** — **Shipped: `f4e8e1e`** (post-M23 audit);
  5 sites across M21+M22+M23 (oauth + login + usage + favorites
  Stage 1 + Stage 2 + cross-board walker) migrated to the R18
  helper that already existed in `src/utils/parse-boundary.ts`
  (same pattern miss + mass-migrate cadence as R-NEW-14/15/16);
  **R-NEW-20 `MondayClient` seam-injection stub factory** —
  **4 consumers at M25 IMPL** (board-favorites +
  cross-board-search + item-history-projection + partial-
  success-bulk unit tests; 4th consumer landed at
  `tests/unit/api/partial-success-bulk.test.ts:99` in
  `fe15181`'s `buildSequenceClientStub`). Lift decision:
  STAYS DEFERRED with stronger rationale — the 4th
  consumer's routing logic diverges from the existing three
  (M23-favorites + M24-history route by `operationName`
  only; M23-cross-board routes by `boardId` variable; M25
  routes by `operationName` + per-call sequence with a FIFO
  queue per op-name since the same op-name fires N times
  across the dispatch loop). A parametrised shared helper
  would have to subsume three routing strategies and would
  carry more surface than the per-test-file inline copies
  it replaces. **Status: 4-consumer trigger fired, lift
  deferred for the 2nd time with stronger rationale.**
  Re-evaluate at 5th consumer (M27 webhook bulk-fan-out
  candidate; if the 5th uses the sequence-aware shape M25
  does, lift the sequence-aware variant while keeping the
  op-name-only / variable-keyed shapes inline);
  **R-NEW-22 probe-script `main().catch()` runner** —
  surfaced at post-R-NEW-5 audit (`fb77baf`); 14+
  consumers but each instance is 3 trivial defensive lines
  + the duplication reads as "always-defensive
  boilerplate", not meaningful repetition; LOW priority
  watch-item, fold into R-NEW-21's commit ONLY if that
  commit is already touching every probe script (it's
  not — R-NEW-21 only touches 4 trial-query probes);
  **R-NEW-23 two-source chronological merge projector**
  — surfaced at M24 pre-flight (`bad98ba`,
  `mergeByCreatedAt` in `src/api/item-history-projection.ts`);
  M24 impl (`d058172`) kept the helper inline (single
  consumer); LOW priority watch-item, fires at 2nd consumer
  (likely M27 webhooks if account-scoped + board-scoped
  surfaces need a merged stream); **R-NEW-24
  schema field-name drift (wire ↔ CLI) documentation
  pattern** — 3 sites today: M22 `daily_limit` /
  `platform_api.daily_limit`, M23 column-tokens /
  `column_id`, M24 `kind` / `event`. Each is ad-hoc in its
  module docstring; not a code lift. LOW priority watch-
  item; if a 4th site appears at M25-M28, consider
  lifting to a shared `## Field-name mapping conventions`
  section in `docs/architecture.md` or `docs/cli-design.md`;
  **R-NEW-25 R-NEW-6 template extension — "findings up
  front" instruction** — **Shipped: `85b93e8`** (M25
  pre-flight kickoff cleanup bundle). M23 impl-review
  truncation lesson (v0.3-plan §15) drove a custom "deliver
  findings up front, not after exhaustive exploration"
  instruction on M24 pre-flight + impl review Codex prompts;
  all four M24 rounds (pre-flight × 2 + impl × 2) returned
  numbered findings cleanly without truncation. Folded into
  `.claude/templates/codex-pre-flight-review.md` as a
  top-of-file template-stable preamble at M25 pre-flight
  kickoff. M25 rounds 1+2 confirmed the directive worked
  template-side (rounds delivered numbered findings up
  front despite the substantive diff), bringing the
  validated-rounds count to 6;
  **R-NEW-26 defensive abort-listener race guard in async
  test promises** — surfaced post-M24 impl (`4c83860`): three
  tests in `tests/unit/cli/run.test.ts` flaked under full
  coverage parallelism because the test's
  `setTimeout(abort, 10ms)` could fire BEFORE the action's
  promise constructor registered its `addEventListener
  ('abort', ...)`. Node's AbortSignal does NOT replay 'abort'
  for listeners attached after the event dispatched, so the
  listener silently waited for an abort that already happened.
  Fix: sync `if (signal.aborted) reject(...)` check before
  listener registration. All three sites in run.test.ts now
  carry the guard; LOW priority watch-item. Fires at next
  async-abort-handling test site OR if the pattern repeats
  enough to warrant a `buildAbortablePromise(signal,
  onAbort)` helper in `tests/_helpers/`. The pattern lives
  next to `.claude/rules/testing.md`'s
  `c8 ignore start/stop` block-wrap discussion — the
  race-window guards mentioned there are the production-side
  analogue (`src/commands/auth/login.ts:fetchAccountId`'s
  guards on the OAuth listener). Document the pattern at
  v0.3-plan §22 R-NEW-26 entry for future-session
  prophylactic application;
  **R-NEW-27 `isPlainObject` consolidation** —
  **Shipped: `85b93e8`** (M25 pre-flight kickoff cleanup
  bundle). Surfaced at post-M24 close-docs audit (6 sites:
  4 production + 2 test; all structurally identical
  `typeof === 'object' && !== null && !Array.isArray(...)`
  type-guards — same pattern miss + mass-migrate cadence as
  R-NEW-14/15/16). Lifted to `src/utils/json.ts` (new
  module) exporting one helper narrowing `unknown` to
  `Readonly<Record<string, unknown>>`. All 6 sites migrated
  (`src/commands/run-by-id-lookup.ts`,
  `src/commands/board/column-create.ts`, `src/api/errors.ts`,
  `src/api/item-history-projection.ts`,
  `tests/fixtures/load.ts`, `tests/e2e/fixture-server.ts`);
  the 2 test sites that previously used the shorter form
  (no `!Array.isArray(v)` clause) widened to the stricter
  form — behaviour-neutral in practice (analysis at v0.3-plan
  §22 R-NEW-27 entry). Branches margin recovered 0.55pp →
  0.70pp through this consolidation (5 duplicate branch sites
  removed; lifted helper has no `c8 ignore` wrap and contributes
  one branch);
  **R-NEW-28 pre-flight behavioral-equivalence audit for
  opt-in flag extensions to existing verbs** — surfaced at
  M25 pre-flight Codex review rounds 1 (`832a169` fix) + 2
  (`67df582` fix). Two distinct contract drifts caught because
  M25 extends an EXISTING fail-fast bulk path with a NEW
  opt-in partial-success flag. **Six audit axes ratified at
  M25 IMPL Codex review** (W2.1-W2.6 in the impl review
  prompt's Section 5): per-target error code semantics;
  empty-input envelope shape; confirmation gate firing;
  source aggregation rules; resolver-warning propagation;
  pre-network argv validation. All six axes returned clean
  at impl round 1 — validating that pre-flight rounds had
  pinned the contract correctly + the implementation
  faithfully shipped the pinned shape. **The 6-axis script
  is now ratified for the next opt-in-flag-extending
  milestone.** LOW priority watch-item — process discipline,
  not code lift. Fires at any future pre-flight diff that
  extends an existing verb with an opt-in flag adding a
  parallel path; likely v0.4 `--concurrency` flag extending
  bulk verbs from sequential to parallel dispatch (cli-design
  §9.3 forward-ref). Full audit axes + Codex-prompt-template
  W{N}-candidate analysis at v0.3-plan §22 R-NEW-28 entry;
  **R-NEW-29 `executeItemMutation` lift** —
  **Shipped: `78889df`** (M25 IMPL kickoff). Surfaced at
  the 3-consumer threshold: single-item path + fail-fast
  bulk loop + imminent M25 partial-success bulk wrapper all
  share the per-item Monday `change_*` mutation dispatcher.
  Lifted the helper + 3 GraphQL mutation strings + the
  local `projectMutationItem` wrapper from
  `src/commands/item/update.ts` to new module
  `src/api/item-mutation-execute.ts` (renamed
  `executeMutation` → `executeItemMutation` for namespace
  clarity). Behaviour-preserving: 1018 item-update
  integration tests pass unchanged across the lift. Lands
  AHEAD of the M25 IMPL feat commit (`fe15181`) mirroring
  the `85b93e8`-ahead-of-`d5839a9` R-class-then-feat
  cadence — keeps the feat diff focused on the behavioural
  change + makes Codex's W8 audit-point verification
  cheap.

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

The binding documents — read in this order before writing code:

1. **[`docs/cli-design.md`](./docs/cli-design.md)** — canonical
   contract: command surface, output envelope, 29 stable error codes,
   deferral list, every binding decision. Changes land via PRs that
   argue for the change, not by drift.
2. **[`docs/v0.4-plan.md`](./docs/v0.4-plan.md)** — active plan:
   M29 (`item watch`) entered at planning kickoff; subsequent v0.4
   milestones (`--concurrency` bulk parallelism, asset upload,
   `doc list/get`, `team` writers, shell completion, release prep)
   sequenced into §3 as their pre-flights run. Per-milestone
   post-mortems land at milestone close.
3. **[`docs/v0.3-plan.md`](./docs/v0.3-plan.md)** — shipped foundations
   M19–M28 with per-milestone post-mortems (§11–§21) + the v0.3
   R-class refactor backlog (§22, R-NEW-1 through R-NEW-43).
   Reference for patterns v0.4 milestones build on (cross-board
   reads, partial-success bulk, outbound writes, multi-profile auth,
   Monday Dev convention).
4. **[`docs/v0.2-plan.md`](./docs/v0.2-plan.md)** — shipped foundations
   M8–M18 with per-milestone post-mortems (M8/M9/M10/M11/M12 +
   M13–M18 + R-class refactor backlogs R20–R53). Reference for
   patterns v0.3 milestones built on.
5. **[`docs/v0.1-plan.md`](./docs/v0.1-plan.md)** — shipped foundations
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
- **Pre-IMPL cross-doc grep for "flag extends existing surface"
  milestones** (R-NEW-56, v0.4-M30 lesson). When the IMPL session
  extends an existing helper/surface with a new mode (a new flag,
  a new route, a new dispatcher), run a cross-doc grep at IMPL
  kickoff: `grep -rn '<existing-symbol>' src/ docs/ tests/`. The
  output enumerates every site that needs the "selected dispatcher" /
  "both routes" / general-route framing in module docs, internal
  comments, error messages, and test descriptions. Without this
  step, the prose-drift surface fans out across 4-5 Codex review
  rounds (M30 IMPL took 5 rounds to converge against one drift
  class). Pair with a scan for R-class 3-consumer triggers that
  crystallize at IMPL kickoff (R-NEW-58 lesson) — lift those
  AHEAD of the feat commit, mirroring R-NEW-29's M25 cadence.
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
