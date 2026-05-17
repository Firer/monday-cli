# CLAUDE.md

> [AGENTS.md](https://agents.md/) format — context for AI coding agents.

## Project overview

`monday-cli` is a TypeScript CLI for Monday.com's GraphQL API.
**Primary audience is AI coding agents** (Claude Code, Codex, etc.);
humans are second-class. Built incrementally via Claude Code on top of
`@mondaydotcomorg/api` (pinned to 14.0.0; Monday API pinned `2026-01`).

## Status

**v0.5.0 published — release complete.** The v0.5 release-prep
cluster (this session)
mirrored v0.4 release-prep's `c193f21..b8e4cd0` shape verbatim
across 5 commits with diff + 1 zero-diff envelope-snapshot probe
(skipped because every v0.5 milestone refreshed its own snapshots
in lockstep at IMPL close — Commit 1 ran clean with zero diff,
folded into close-docs prose instead of a separate commit):
`9129c67` ToC audit + slip stale `deferred_to: "v0.5"` slots to
`"v0.6"` (4 production sites in `src/api/{column-types,
column-values,raw-write}.ts` + `src/commands/item/create.ts` + 5
test sites + 5 doc prose sites + 1 ToC user-row update closing a
v0.5-M34 close-docs gap caught at release-prep ToC audit per
R-NEW-82's 3rd-consecutive-consumer graduation) + `665c46e`
README v0.5 quickstart + scope refresh + `ae7b074` version bump
0.4.0 → 0.5.0 in `package.json` + `package-lock.json` + `5afa3fe`
CHANGELOG `[0.5.0]` entry + `c2e2df6` close-docs sweep.
**Pushed to `origin/main`** at the close-docs commit +
**annotated `v0.5.0` tag pushed** pointing at `c2e2df6` +
**GitHub release live** at https://github.com/Firer/monday-cli/releases/tag/v0.5.0
with the full CHANGELOG body + **npm publish landed
2026-05-17T20:55:05Z** (`monday-cli@0.5.0`, `latest` dist-tag).

**No code-surface change in the release-prep cluster** — only
docs, tests, the deferral-slip string-literal updates, and the
version bump. ERROR_CODES count stays at 29; command count stays
at 117; the 95.45 branches floor + 95 stmts/fns/lines floor
unchanged. Coverage at the cluster close: 99.29 / 96.45 / 99.45 /
99.55 (branches margin 1.00pp — held from M37 IMPL close, first
v0.5 IMPL milestone to cross the 1.00pp threshold).

**v0.5-M37 IMPL closed at `c431d96..25e1204`** (prior session) —
LAST v0.5 feature milestone shipped end-to-end — doc-content
import surface (2 new verbs under the existing `monday doc`
namespace: `import-html` + `append-markdown`) backed by Monday's
`import_doc_from_html` + `add_content_to_doc_from_markdown`
custom-OBJECT mutations. IMPL cluster: R-v0.5-NEW-18 lift
`c431d96` (ahead-of-feat per R-NEW-58 cadence — generic
`readSourceContent` at `src/utils/source-content.ts` widens
M13's `readUpdateBody` to parameterise on `inlineFlagName` /
`fileFlagName` / `verbHint?` / `maxBytes?` /
`trimTrailingWhitespace?`; 5 consumers post-lift across 3 M13
update verbs + 2 M37 doc verbs; 20 unit tests pin the helper's
branch matrix) + IMPL feat `51ad434` (2 runtime fetcher bodies
in `src/api/documents.ts` swap c8-ignored stubs for live
`client.raw` round-trips against literal-pinned operationNames
`ImportDocFromHtml` + `AddContentToDocFromMarkdown`; two-stage
parse via loose wrapping schemas + `assertResponseFieldPresent`
+ strict inner-OBJECT pin per `importDocFromHtmlResultSchema` /
`docBlocksFromMarkdownResultSchema`; D12 5-branch custom-OBJECT
projection per fetcher per R-v0.5-NEW-11 graduated discipline;
2 action bodies wire `resolveClient` + `readSourceContent` with
`MAX_DOC_IMPORT_PAYLOAD_BYTES` runtime size-guard +
`emitDryRun` / `emitMutation`; 36 new integration tests across
2 new files at `tests/integration/commands/doc-{import-html,
append-markdown}.test.ts`; 2 envelope-snapshot dry-run shapes
refreshed) + 5 Codex IMPL fix-up rounds (round-1 `9374a7c`:
0 P1 + 2 P2 + 2 P3 — dry-run/live whitespace-only asymmetry
fixed by `.refine((s) => s.trim().length > 0, ...)` on both
schemas + M13 lift contract drift pinned in update.test.ts +
5 stale pre-flight prose sites + empty-block_ids prose conflict;
round-2 `0ec8629`: 0 P1 + 0 P2 + 2 P3 — residual empty-block
prose + 3 remaining pre-flight prose sites including the
R-v0.5-NEW-19 W15 catch on src/commands/index.ts; round-3
`1a64f49`: 0 P1 + 0 P2 + 1 P3 — sibling-site empty-block
prose at schema + envelope + cli-design row; round-4 `58e41c2`:
0 P1 + 0 P2 + 3 P3 — append-markdown read-boundary half +
stale `readUpdateBody` references in update/edit.ts +
update/reply.ts + output-shapes test count swap; round-5
`25e1204`: 0 P1 + 0 P2 + 3 P3 — envelope-snapshots describe-
title M37 mislabelling + cli-design "pre-flight ships" stale
tense + validation_failed example message order mismatch).
Round-6 ratified clean (0 P1 + 0 P2 + 0 P3 across all 16
audit points W1-W16). **Cumulative IMPL findings: 0 P1 + 2 P2
+ 11 P3 across 5 fix-up rounds** — within the M22 / M27 / M30
/ M31 / M32 / M34 / M35 / M36 write-surface IMPL precedent;
~1 round above M36's clean 3-round OBJECT-return cadence,
driven by the custom-OBJECT shape's prose surface + the R-NEW-72
sibling-site grep cycle expanding noun-stem matching over
rounds 3-5. **Pushed to `origin/main`** at close-docs.
**v0.5-M37 closes the LAST feature milestone in v0.5 scope.**
**16 new CLI verbs / 9 wire mutations across M34 (6) + M35 (5)
+ M36 (3) + M37 (2)** all shipped end-to-end; v0.5 release-
prep opens at the next session per the per-milestone cadence.

**v0.5-M34 IMPL closed at `afdba15..02f1b1a`** (carried for
context). First v0.5 milestone shipped end-to-end — team writer
surface (6 new
verbs under the existing `monday user` namespace: `team-list`
/ `team-get` / `team-create` / `team-delete` / `team-add-
members` / `team-remove-members`). IMPL cluster: `afdba15`
IMPL feat (6 runtime fetcher bodies in `src/api/teams.ts`
swap the c8-ignored stubs for live `client.raw` round-trips
against literal-pinned operationNames; new wrapping response
schemas + `projectTeam` wire-vs-output filter helper + new
shared `_team-membership.ts:projectMembershipResults` for the
partial-success projection lifted at IMPL kickoff — 2-consumer
inline lift mirroring M26b `_shared.ts:requireDevBoard`
cadence; 6 action bodies wired via `resolveClient` + fetcher +
emit; dry-run paths for the 4 mutation verbs; +40 integration
tests across 6 new files + 12 envelope snapshots) + `99bbd01`
Codex round-1 fix-up (0 P1 + 1 P2 + 2 P3 — widen
`changeTeamMembershipsResultSchema` bucket containers to
nullable + normalise null → [] in both fetchers per the
empirical-probe outer-LIST nullability; pin team-create
missing-key + same-user-in-both-buckets regression tests) +
`72470b3` Codex round-2 fix-up (0 P1 + 0 P2 + 2 P3 —
team-delete no-token destructive-gate regression test for the
M10 P2 invariant; remove-members null-bucket cassettes
parallel to add-members) + `02f1b1a` Codex round-3 fix-up
(0 P1 + 0 P2 + 1 P3 — dry-run docstring prose drift on team-
add-members / team-remove-members, "per supplied user_id"
flipped to single-shot bulk shape). Round 4 ratified clean
(0 P1 + 0 P2 + 0 P3 across W1-W11). **Cumulative IMPL
findings: 0 P1 + 1 P2 + 4 P3 across 3 fix-up rounds** —
within the M22 / M27 / M30 / M31 / M32 IMPL read-or-write
precedent (1-3 fix-up rounds typical for new wire surfaces).
**Pushed to `origin/main`** at close-docs. **Post-IMPL
refactor-audit** filed R-v0.5-NEW-7 (read-one-by-id wrapper-
extract helper; 2 consumers post-M34 — `getDocument` +
`getTeam`; LOW watch-item, lift at 3rd consumer) +
R-v0.5-NEW-8 (test-fixture `wireUser` consolidation; 7
consumers across 6 team integration test files + envelope-
snapshot describe block; LOW watch-item, lift at next test-
refactor session) + R-v0.5-NEW-9 (round-N parallel-fetcher
fix-up test parity discipline; 1 supporting instance from
M34 IMPL round-2 P3-2) + R-v0.5-NEW-10 (sibling-verb module-
docstring prose audit at IMPL kickoff; 1 supporting instance
from M34 IMPL round-3 P3-1) + expanded the R-v0.5-NEW-6 full
entry that was pending from close-docs; swept 3 carry-
forward drift sites annotating M34 IMPL outcomes for R-NEW-73
(stays UNFILED at 6 candidates — IMPL confirmed per-fetcher
divergence too high) + R-NEW-74 (M34 negative-case
validation — team-list has no pagination per D6).

**v0.4.0 published — release complete.** The v0.4 release-prep
cluster mirrored v0.3-M28's `d9ad757..5e8c210` shape verbatim
across 6 commits: `c193f21` envelope-snapshot refresh (+11
snapshots for M29-M33 surfaces) + `eb9e7a9` ToC audit + slip
stale `deferred_to: "v0.4"` slots to `"v0.5"` (3 production
sites + matching test + doc prose; mirrors M28's `f2600fa`
v0.3-deferral slip) + `f9eef68` README v0.4 quickstart + scope
refresh + `861a734` version bump 0.3.0 → 0.4.0 in `package.json`
+ `package-lock.json` + `b1739bf` CHANGELOG `[0.4.0]` entry +
`b8e4cd0` close-docs sweep. **Pushed to `origin/main`** +
**GitHub release live** at
https://github.com/Firer/monday-cli/releases/tag/v0.4.0 with
the full CHANGELOG body + **npm publish landed
2026-05-14T22:46:28Z** (`monday-cli@0.4.0`, `latest` dist-tag).
The post-release-prep refactor-audit commit `70d0cba` filed
R-NEW-83 (NDJSON-trailer parsing helper; HIGH priority lift
candidate at 6 consumers) + swept the team-CRUD slip-to-v0.5
drift across `cli-design.md` §13 + `v0.4-plan.md` §1 (the M34
team-writers deferral happened at the post-M33 candidate-
selection session before release-prep, but the planning-scope
sites weren't swept until this audit). v0.4.0 ships **no
breaking changes vs v0.3.0** — every v0.4 surface is additive
across M29–M33.

**Live numbers (v0.5-M34 IMPL close):**
- Test count: **3752 + 1 skipped** across **156** test files
  (+59 net vs 3693 + 1 skipped at M34 pre-flight close: 40 new
  in `tests/integration/commands/team-*.test.ts` covering all
  6 verb surfaces + 12 envelope snapshots in
  `tests/integration/envelope-snapshots.test.ts` + 7 added
  across the 3 Codex IMPL fix-up rounds — 3 round-1 fix-ups
  for null-bucket / missing-key / same-user-in-both-buckets, 3
  round-2 fix-ups for no-token destructive-gate +
  remove-members null-bucket parity, 1 round-3 doc-prose fix
  added no tests).
- Coverage: **99.26 / 96.29 / 99.43 / 99.53** (stmts / branches
  / fns / lines) at the **95 / 95.45 / 95 / 95** floor.
  **Branches margin 0.84pp** (was 0.72pp at v0.5-M34 pre-flight
  close; +0.12pp recovery from the 6 c8-ignored stub fetcher
  bodies dropping in favour of integration-test-covered runtime
  bodies + the 12 stub functions becoming covered — standard
  IMPL cadence per the M32 precedent where every metric
  improved at IMPL close).
- ERROR_CODES count: **29** (unchanged per D1-D6 closures).
- Command count: **107** (was 101 — 6 new team verbs).
- `package.json` version: **0.4.0** (stays through v0.5
  milestones; bumps to `0.5.0` at v0.5 release-prep).
- npm registry version: **0.4.0** (`latest` dist-tag,
  published 2026-05-14T22:46:28Z by `nickwebster`).

**No code-surface change in the release-prep cluster** — only docs,
tests, envelope-snapshot regen, and the version bump. ERROR_CODES
count stays at 29; command count stays at 101; the 95.45 branches
floor + 95 stmts/fns/lines floor unchanged. Coverage at the cluster
close: 99.26 / 96.33 / 99.34 / 99.53 (branches margin 0.88pp).

**v0.4-M33 IMPL closed at `7cbb120..e651674`** (prior session) —
shell completion (`monday completion <bash|zsh|fish>`), first
non-envelope stdout surface in the CLI (cli-design §3.1 #2
raw-bytes carve-out). Empirical commander-capability check at
pre-flight (`grep -rn 'completion\|complete' node_modules/
commander/lib/ node_modules/commander/typings/` 2026-05-14,
commander 14.0.3) returned ZERO hits — commander ships NO
built-in completion machinery, so the verb hand-rolls per-shell
templates (D1 closure; no runtime dep added per the cli-design
§1 "minimum deps" principle). **IMPL cluster
`7cbb120..e651674` (2 commits: feat `7cbb120` + 1 Codex round
fix-up `e651674` + round-2 ratification with 0 P1 + 0 P2 + 0 P3).
Cumulative IMPL findings: 0 P1 + 1 P2 + 1 P3 across the 1
fix-up round** — at the lower bound of the M22 / M27 / M32
read-surface precedent for a CLI-internal milestone. Codex
round 1 `e651674` (0 P1 + 1 P2 + 1 P3: per-depth fish local-flag
emission for `doc list --workspace` / `dev sprint list --state`
+ module docstring `MONDAY_OUTPUT` enumeration); round 2
ratified convergence across all 9 audit points (W1' / W2' / W3'
/ W4' / W5' / W6' / W7' / W8' / W9). Pre-flight cluster carried
forward `c619425..affbf70` (3 commits + 2 fix-ups + 1
ratification; 0 P1 + 3 P2 + 4 P3 cumulative).

**M33 pre-flight highlights.** Single new top-level verb
`monday completion <bash|zsh|fish>` (NOT under a noun
namespace; meta-CLI like `monday raw` / `monday status` /
`monday usage` / `monday schema`). Closed 3-value enum
positional (`bash` / `zsh` / `fish`); unknown values reject at
the parse boundary with `usage_error.details.issues[]` carrying
`{path: 'shell', message}` per `parseArgv`'s `SummarisedIssue`
shape (NO `details.shell` slot; NO Zod `code` field). **Three
output modes** (cli-design §3.1 #2 raw-bytes carve-out):
default emits raw script bytes on stdout regardless of TTY/
pipe context (the install flow `monday completion bash >>
~/.bashrc` relies on this); `--json` / `--output json` /
`MONDAY_OUTPUT=json` opts INTO the standard §6 envelope with
`data: { shell, script }`; `--table` / `--output table` /
`--output text` / `--output ndjson` reject as `usage_error`
(only `--json` and `--table` are global shorthand flags per
§4.4; text and ndjson are accessible only via `--output
<fmt>`). No wire surface (CLI-internal; no Monday API call;
no auth requirement; no cache); `meta.source: "none"` on the
`--json` envelope path. No `--dry-run` (not a mutation); no
GraphQL operation (R-NEW-37 W2 audit returns "nothing
flagged"). ERROR_CODES count stays at 29 per D4 closure.

**Live numbers (v0.4.0 ready for publish):**
- Test count: **3634 + 1 skipped** across **148** test files
  (+11 net vs 3623 + 1 skipped at M33 IMPL close: 11 envelope-
  shape snapshots at `c193f21` covering item watch (NDJSON
  trailer happy single-event + empty backlog) / doc list
  (wrapped record empty + populated) / doc get (direct unwrap
  happy with blocks + D8 not_found) / completion bash|zsh|fish
  --json envelopes (script body collapsed to a sentinel so
  registry-additions don't churn the snapshot) / completion
  --table + invalid-shell usage_error rejections.
- Coverage: **99.26 / 96.33 / 99.34 / 99.53** (stmts /
  branches / fns / lines) at the **95 / 95.45 / 95 / 95**
  floor. **Branches margin 0.88pp** (unchanged from M33 IMPL
  close — the envelope-snapshot refresh adds no production
  branches; the deferral slip changes string literals; the
  README + CHANGELOG additions are doc-only). The release-
  prep cluster matched v0.3-M28's "no coverage residual sweep
  needed" branch (margin >= 0.5pp baseline + no per-file
  100%-residual gap surfaced).
- ERROR_CODES count: **29** (unchanged — release-prep adds no
  new codes).
- Command count: **101** (unchanged — release-prep adds no
  verbs).
- `package.json` version: **0.4.0** (bumped at `861a734`).
- `v0.4.0` annotated tag points at the cluster's final commit
  (`b8e4cd0`); **pushed to `origin/main`** + **GitHub release
  live** at https://github.com/Firer/monday-cli/releases/tag/v0.4.0.
  v0.3.0's tag remains live at `5e8c210`.
- npm registry version: **0.4.0** (`latest` dist-tag,
  published 2026-05-14T22:46:28Z).

**R-class state (post-v0.5 release-prep close):**

- **R-NEW-82 GRADUATED at v0.5 release-prep close** (3rd
  consecutive release-prep cluster firing the "release-prep
  cross-doc grep for `deferred_to: '<currently-releasing-
  version>'`" audit step). M28 caught 2 sites at v0.3.0
  (`f2600fa`); v0.4 release-prep caught 3 production sites + 5
  prose sites at `eb9e7a9`; v0.5 release-prep caught 4
  production sites + 5 test sites + 5 doc prose sites + 1 ToC
  user-row drift at `9129c67` (the ToC user-row drift is a new
  sub-class — a v0.5-M34 close-docs gap where the team-writer
  verbs were added to `cli-design.md` §4.3 but not to
  `output-shapes.md`'s ToC; the release-prep ToC audit caught
  it). Discipline promotes to a permanent CLAUDE.md "Workflow
  rules" entry under the release-prep cadence section below.
  Full entry stays at v0.4-plan §22 R-NEW-82 marked "graduated
  at v0.5 release-prep close".
- **R-NEW-84 ratified at v0.5 release-prep close** (5th
  supporting instance — graduated at v0.5-M34 pre-flight close
  per the 4-instance graduation trigger; the v0.5 release-prep
  cluster IS the symmetric application of the rule). Zero
  production `src/**/*.ts` changes → Codex review skipped;
  gates (`npm run typecheck && npm run lint && npm test`) alone
  verified. Cluster shipped cleanly across 5 commits + 1
  zero-diff probe with no Codex pass; rule application
  confirmed.
- **No code-lift R-class movement at v0.5 release-prep.** The
  cluster shipped only string-literal pins (deferral slips),
  doc prose, README + CHANGELOG additions, and the
  package.json + package-lock.json version bump. No new helper
  crystallized; no 3-consumer threshold fired.

**R-class state (post-v0.5-M34 IMPL close — carried for context):**

- **`_team-membership.ts:projectMembershipResults` lifted at
  IMPL kickoff** (2-consumer inline lift mirroring M26b
  `_shared.ts:requireDevBoard` cadence). Shared partial-
  success projection for `team-add-members` + `team-remove-
  members`: takes wire `ChangeTeamMembershipsResult`
  (`failed_users` + `successful_users` lists) + input user_id
  argv order, projects to universal §6.1 `results: [{user_id,
  ok, ...}]` shape with input-order preserved + failed-bucket-
  priority discipline. Surfaces `internal_error` when an input
  user is in neither bucket (wire-shape regression defensive).
  Lifted ahead of any 3-consumer threshold because the
  two-verb-byte-identical pattern + the wire-vs-CLI
  asymmetry's documentation cross-link make a shared helper
  the cleaner expression — fold-in-place would have left two
  copies of the same generic-`membership_failed`-message
  constant.
- **R-NEW-70 shipped at `17c1a54`** (ahead-of-feat per R-NEW-29's
  M25 cadence). Comma-separated brand-list argv parser pattern
  lifted to `src/utils/parse-brand-list.ts` as
  `parseBrandedListArg<T>(raw, brandSchema, options)`. 4
  consumers post-lift: doc/list `--workspace` (M32 site
  migrated; behaviour-preserving for the user-facing error
  envelope) + team-create `--users` + team-add-members
  `--users` + team-remove-members `--users` (M34 sites
  consume the lifted helper from day one). 18 unit tests at
  `tests/unit/utils/parse-brand-list.test.ts` pin the helper's
  branch matrix (split / trim / empty-entry / brand-rejection
  / hint propagation / multi-issue path serialisation). Helper
  signature parameterises on (a) the zod brand schema + (b)
  per-flag metadata (flagName / entryDescription / hint /
  optional emptyEntryHint override). Mixed numeric-or-email
  fan-out sites (workspace add-users / board add-users)
  deliberately stay on `parseUsersArg` — its `email_kind`
  discriminator + directory-cache leg coupling don't fold
  into the pure-brand-list shape without inflating the helper
  signature.
- **R-NEW-73 stays UNFILED post-M34 IMPL** at 6 candidate
  consumers. IMPL surfaced the runtime divergence: per-fetcher
  error code (`internal_error` for list / get null root +
  create-team missing-key + add/remove-members null payload;
  `not_found` for delete-team null payload + get-team empty
  array; `internal_error` for get-team multi-element) +
  per-fetcher details shape (`team_id` / `team_name` /
  contextual hint) make a parametrised helper signature carry
  more surface than the 4-6 inline lines it would replace.
  Re-evaluate at v0.5.x consumer-7+ if a future verb's
  null-payload semantics happen to align with an existing
  fetcher's exact shape.
- **R-NEW-76 graduated** (pre-flight stub argv-before-deferred-
  feature-throw discipline) — 6th forcing supporting instance
  fired across the 6 M34 team command stubs (all 6 carry
  `parseArgv` + per-verb `parseBrandedListArg` invocations
  BEFORE the `c8 ignore start` block-wrap so invalid argv
  surfaces `usage_error` from the parse boundary, NOT
  `internal_error` from the c8-ignored stub throw). Discipline
  graduates to a permanent CLAUDE.md "Workflow rules" entry
  alongside R-NEW-72 + R-NEW-75 — see additions below. Full
  entry stays at v0.4-plan §22 R-NEW-76 marked "shipped at
  v0.5-M34 pre-flight close".
- **R-NEW-84 graduated** (skip Codex review on mechanical /
  process-only / test-side housekeeping clusters where no
  production `src/**/*.ts` code changes) — 4th supporting
  instance fired at the post-M34-pre-flight refactor-audit
  reasoning that R-NEW-84 DOES NOT apply to the M34 pre-flight
  cluster because the work added production `src/api/teams.ts`
  + 6 new `src/commands/user/team-*.ts` files. The audit-point
  fires correctly — Codex review applied per the standard
  cadence (4 rounds; 3 fix-up rounds + 1 ratification). The
  graduation trigger is "rule fired correctly at the 4th
  consumer" — the v0.5 kickoff probe session (instance 4) +
  the M34 pre-flight cluster (negative-case validation: rule
  correctly did NOT fire) jointly satisfy the 4th-instance
  graduation. R-NEW-84 promotes to a permanent CLAUDE.md
  "Workflow rules" entry under the existing Two-AI review
  rule. Full entry stays at v0.4-plan §22 R-NEW-84 marked
  "shipped at v0.5-M34 pre-flight close".
- **R-NEW-41 4th-consumer trigger fired** (asymmetric wire-vs-
  CLI semantics documentation pattern). The
  `ChangeTeamMembershipsResult.failed_users[]` carries-User-
  object-but-no-reason asymmetry is the 4th supporting site
  for the docs/architecture.md "Wire-vs-CLI semantics
  documentation conventions" section graduated at v0.4-M31.
  Canonical asymmetry note lives at
  `teamMembershipResultSchema` JSDoc in `src/api/teams.ts`;
  cli-design §4.3 + team-add-members.ts + team-remove-
  members.ts carry short one-line pointers to the canonical
  note + the architecture-section reference (Codex round-2
  P3-1 + round-3 P3-1 pinned the short-pointer cadence).
- **R-NEW-73** (`assertNonNullArrayPayload` helper) stays
  UNFILED at the 6-candidate-consumer mark post-M34 pre-
  flight (3 prior v0.4 consumers + 3 new M34 fetcher response-
  parse boundaries: `listTeams` / `addUsersToTeam` /
  `removeUsersFromTeam`). Per-consumer error code + message +
  details divergence stays high enough that a parametrised
  signature would carry more surface than it replaces.
  Re-evaluate at M34 IMPL when the runtime bodies land + the
  per-consumer divergence becomes visible at the code-surface.
- **R-NEW-31** (discriminated-union per-status detail schema)
  stays at 1 consumer post-M34 pre-flight. The team-add-
  members / team-remove-members envelopes ship a flat per-
  record `ok: boolean` discriminator + optional `user` / `error`
  slots — NOT a per-status detail union (no status enum that
  varies the detail shape; the partial-success records are
  structurally uniform regardless of `ok`).
- **R-NEW-43** (deferred-feature surface pattern) stays at 1
  consumer post-M34 pre-flight. The 6 tangential team
  mutations + `update_team` non-existence + `--parent` slot
  are deferral-by-scope-decision, NOT deferral-by-external-
  registration (no OAuth-style placeholder guard); R-NEW-43
  applies only to features gated on external state outside
  the CLI's reach.
- **R-NEW-58** (lift-ahead-of-feat for R-class triggers)
  ratified for the 3rd time at the M34 pre-flight kickoff —
  R-NEW-70 lift fired at `17c1a54` ahead of the M34 pre-
  flight feat commit, mirroring R-NEW-29's M25 cadence
  (`78889df`-ahead-of-`fe15181`). The discipline correctly
  identifies "lift when the 3-consumer trigger fires + the
  duplication would surface at IMPL kickoff"; M34 was the
  ideal moment because the 4-site lift target was visible at
  pre-flight without requiring deep refactor of any in-flight
  surface.
- **R-NEW-72** (cross-doc grep after every contract-flipping
  Codex fix-up) ratified for the 3rd time at M34 pre-flight
  round-2 fix-up. The wire-vs-output schema split (round-2
  P2-1) flipped the `teamSchema` contract surface from
  "agent-facing accepts nullable entries" to "agent-facing
  rejects nullable entries"; the post-fix-up grep enumerated
  the 4 consumer sites (`teamListOutputSchema` /
  `teamGetOutputSchema` / `teamCreateOutputSchema` /
  `teamDeleteOutputSchema`) without finding new drift. The
  round-3 P3-1 finding (cli-design pointer drift) was a
  separate sub-surface the kickoff grep didn't cover —
  documentation prose, not contract-surface drift. Cadence
  stable at 3 ratifying instances.

**R-class state (post-v0.4 release-prep close + R-NEW-83 lift + post-lift refactor-audit):**

- **One new R-class candidate filed at v0.4 release-prep close
  — R-NEW-82** (release-prep `deferred_to: '<currently-
  releasing-version>'` audit step; 2 supporting instances —
  v0.3-M28 audit at `f2600fa` + v0.4 release-prep audit at
  `eb9e7a9`; LOW priority watch-item — process discipline, NOT
  a code lift; graduates at the 3rd consecutive release-prep
  cluster — likely v0.5.0 — that catches >= 1 stale
  `deferred_to` site OR explicitly returns "no stale deferrals
  found"). Full entry at v0.4-plan §22 R-NEW-82.
- **R-NEW-83 shipped at `1e51093`** (post-v0.4-release-prep
  housekeeping session). `parseNdjsonStream(stdout, opts?)`
  lifted to `tests/integration/helpers.ts` with an optional
  `normaliseTrailerField?: (key, value) => unknown` callback
  for the snapshot-determinism site (mirrors R-NEW-21's
  `trialQuery` opts shape). Returns `{records: readonly
  Record<string, unknown>[]; trailer: Record<string, unknown>
  | null}`; `trailer` is the unwrapped `_meta` value (callers
  read `trailer.has_more`, NOT `trailer._meta.has_more`).
  Six of the seven candidate sites migrated directly (item-
  list, item-search at 353+402+490, item-history at 596+
  645, m23-cross-board at 697, item-watch's local
  `parseStream` wrapper now delegates, envelope-snapshots'
  `parseStreamSnapshot` collapsed to a normaliser-callback
  call); the seventh — item-search:445's `Object.keys(trailer).
  toEqual(['_meta'])` outer-shape assertion — deliberately
  stays inline since the helper unwraps the wrapper level.
  Net `+19 lines` (helper JSDoc + defensive null-trailer
  type-narrowing chain ran longer than the spec's
  `~−20 lines` estimate; the longer-than-estimated helper
  is fine — single source of truth + safer null-trailer
  defaults). All 3634 + 1 skipped tests pass unchanged;
  coverage 99.26 / 96.31 / 99.34 / 99.53 at floor 95 / 95.45
  / 95 / 95 — branches margin 0.86pp (was 0.88pp; small
  0.02pp shuffle from consumer-side branch reordering, NOT
  from the helper itself which lives outside the
  `src/**/*.ts` coverage scope). Snapshot file
  `tests/integration/__snapshots__/envelope-snapshots.test.
  ts.snap` byte-identical post-migration. Mirrors R-NEW-14/
  15/16's "missed earlier triggers, mass-migrate when
  surfaced" cadence at the v0.3 audit. Full entry at
  v0.4-plan §22 R-NEW-83.
- **One new R-class candidate filed at the post-R-NEW-83-lift
  refactor-audit — R-NEW-84** (skip Codex review on
  mechanical / process-only / test-side housekeeping clusters
  where no production `src/**/*.ts` code changes; 3 supporting
  instances — v0.3-M28 release-prep + v0.4 release-prep +
  v0.4 R-NEW-83 lift; MEDIUM priority watch-item — process
  discipline, NOT a code lift; graduates to a permanent
  CLAUDE.md "Workflow rules" carve-out under the existing
  Two-AI review rule at the 4th confirming instance — likely
  v0.5.x patch-release prep or another test-side R-class
  lift). Full entry at v0.4-plan §22 R-NEW-84.

**R-class state (post-M33 IMPL close — unchanged):**

- **No code-lift R-class movement at M33 IMPL.** The 1-round
  Codex IMPL cluster's findings (1 P2 + 1 P3) were a runtime
  correctness issue (per-depth fish local-flag emission gap)
  + module docstring prose precision; neither crystallized an
  R-class trigger. The R-NEW-58 2-consumer scan at IMPL
  kickoff returned NEGATIVE — M33 IMPL has no fetcher
  response-parse boundary, no JSON-shape slots, no
  comma-separated brand lists, no wrapped paginated records,
  no numeric-flag parsing — none of R-NEW-68 / 69 / 70 / 71 /
  73 / 74 could have fired here. The three v0.3 R-class
  watch-items also stay at their pre-M33 consumer counts:
  R-NEW-31 (discriminated-union per-status detail schema)
  stays at 1 consumer; R-NEW-41 (asymmetric wire-vs-CLI
  semantics documentation) stays at 3 consumers; R-NEW-43
  (deferred-feature surface pattern) stays at 1 consumer.
- **R-NEW-72 (cross-doc grep AFTER every contract-flipping
  Codex fix-up — R-NEW-56 extension) GRADUATED to permanent
  CLAUDE.md "Workflow rules" entry at M33 IMPL close.** The
  2nd full validation cycle (after pre-flight at M33 ratified
  the discipline) ran cleanly: the round-1 fix-up was
  contract-flipping (replaced single-set option-emission with
  merged-vs-local split for fish), so the post-fix-up
  cross-doc grep ran per discipline; it enumerated 3 stale-
  prose sites pending close-docs (NOT new contract drift the
  fix-up introduced). The round-2 ratification confirmed the
  discipline scales beyond the introduction trigger. **Status:
  shipped — added to "Workflow rules" section below; full
  entry stays at v0.4-plan §22 R-NEW-72 marked "shipped at
  M33 IMPL close".**
- **R-NEW-75 (candidate-selection session shape) GRADUATED to
  permanent CLAUDE.md "Workflow rules" entry at the post-M33
  IMPL candidate-selection session.** 2nd consumer fired at
  this session (release-prep vs M34 team writers); the
  5-dimension scoping framework (wire-shape novelty /
  transport seam / destructive gate / R-class triggers / Codex
  round estimate) applied verbatim, recommending release-prep
  on neutral trade-offs. Release-prep returning zero on 4 of 5
  axes IS the signal that it's process-only, not framework
  drift — no 6th axis needed. **Status: shipped — added to
  "Workflow rules" section below; full entry stays at
  v0.4-plan §22 R-NEW-75 marked "shipped at post-M33 IMPL
  candidate-selection session".**
- **Three M32-IMPL R-NEW candidates (R-NEW-73 / R-NEW-74) all
  stay at their pre-M33 consumer counts.** R-NEW-73
  (`assertNonNullArrayPayload` helper) stays at 3 consumers;
  R-NEW-74 (`kind: 'record'` for wrapped-paginated-record
  emit) stays at 2 consumers (M33's `--json` envelope is a
  flat 2-field record, NOT a wrapped paginated record).
- **Four post-M32-pre-flight R-NEW candidates (R-NEW-68 /
  R-NEW-69 / R-NEW-70 / R-NEW-71) all stay at their pre-M33
  consumer counts** — confirmed by the R-NEW-58 2-consumer
  scan at IMPL kickoff returning NEGATIVE.

**No new R-class candidates surfaced AT M33 IMPL review rounds**
— the 1 P2 + 1 P3 round-1 findings were a runtime fix + prose
precision; neither crystallized a pattern that would fire a
watch-item directly. **However, the post-M33-IMPL refactor-audit
sweep surfaced 3 retrospective candidates** (R-NEW-79 / R-NEW-80
/ R-NEW-81; full entries at v0.4-plan §22) from the M33 IMPL
code surface itself: a POSIX-shell-safe single-quote encoding
helper (`shSingleQuote`, 1 consumer + 6 internal callsites), a
commander program-tree walker pair (`buildCompletionTree` +
`flattenPaths`, 1 consumer), and the per-target template
emission with per-target option shapes pattern (1 supporting
instance — process discipline, surfaced via the M33 round-1
P2-1 catch). All three are LOW-priority watch-items at the
1-consumer/instance threshold; none cross a lift trigger today.
The three M33-pre-flight candidates (R-NEW-76 / R-NEW-77 /
R-NEW-78) all carry forward; see below.

**Three R-class candidates filed at M33 pre-flight** (full
entries at v0.4-plan §22):

- **R-NEW-76 — Pre-flight stub argv-before-deferred-feature-
  throw discipline** (5 forcing supporting instances + 1
  retroactive; LOW priority watch-item; graduates to a
  permanent CLAUDE.md "Workflow rules" entry at the 6th
  forcing supporting instance). Surfaced retroactively at M33
  pre-flight after the cadence became visible across 5
  consecutive post-M31-lesson pre-flight stubs (M31a / M31b /
  M32a / M32b / M33). Pattern: pre-flight stub action body
  runs `parseArgv` (or `inputSchema.parse`) BEFORE the `c8
  ignore start` block-wrap so invalid argv surfaces
  `usage_error` from the parse boundary, NOT `internal_error`
  from the c8-ignored stub throw. The M31 pre-flight round-1
  P2-2 was the surfacing event; M31a / M31b / M32a / M32b /
  M33 are the forcing supporting instances post-lesson. Cross-
  references R-NEW-43 (deferred-feature surface pattern — a
  distinct pattern for permanently-unavailable features behind
  OAuth-style placeholder guards).
- **R-NEW-77 — CLI-internal milestone empirical-probe-slot
  equivalent (framework / SDK capability check)** (1
  supporting instance; LOW priority watch-item, process
  discipline). Surfaced at M33 pre-flight D1 closure as the
  CLI-internal analogue of the standard "empirical-probe step
  in pre-flight" discipline. Pattern: for CLI-internal
  milestones with no Monday wire surface, the pre-flight runs
  a `grep -rn <feature> node_modules/<dep>/lib/ typings/
  Readme.md` capability check at the SDK-pinned version
  against any framework / SDK / tool the cli-design §13
  backlog entry names ("via commander" / "via Node's child_
  process" / etc.). The check REPLACES the standard
  Monday-API empirical-probe step; the pre-flight
  preconditions §9 tick-list reflects the substitution
  explicitly. M33 ran the check against commander 14.0.3
  and got ZERO hits, flipping the §13 v0.4 backlog entry
  from "via commander" to "via hand-rolled per-shell
  templates" before any pre-flight contract claim could
  drift. Fires at 2nd CLI-internal milestone (likely v0.5).
- **R-NEW-78 — Codex template W{N} audit-point for output-
  format-flag enumeration correctness** (1 supporting
  instance; LOW priority watch-item, template-stable
  candidate; NOT a code lift). Surfaced at M33 pre-flight
  round-1 P2-2 — the contract diff described `--text` /
  `--ndjson` as standalone shorthand flags but the cli-
  design §4.4 inventory ships ONLY `--json` and `--table` as
  shorthands; `text` and `ndjson` are accessible only via
  the long-form `--output <fmt>` value. Fires at 2nd
  consumer (any future verb claiming to reject output
  formats at the parse boundary) + folds the audit-point
  into `.claude/templates/codex-pre-flight-review.md`
  alongside W1 / W2. Cross-references R-NEW-25 (Codex
  template "findings up front" directive; shipped) +
  R-NEW-17 (W1 redactor-pattern audit; shipped) +
  R-NEW-37 (W2 GraphQL operation-name parity; shipped) —
  template-extension cadence.

Per-milestone narrative + Codex round detail + lessons learned
live in `docs/v0.4-plan.md` §3 M33 entry + §9 M33 preconditions
+ §15 M33 post-mortem + §22 R-NEW-76/77/78 entries. Do not
duplicate here.

**v0.5-M35 IMPL closed at `153458a..e7c5e50`.** 5 doc-level
CRUD verbs shipped end-to-end under the existing `monday doc`
namespace, backed by 4 Monday GraphQL mutations: `doc create-
in-workspace` / `create-on-column` (both back `create_doc` per
D7's mutually-exclusive `board` vs `workspace` split) + `rename`
(`update_doc_name`) + `delete --yes` (`delete_doc`) +
`duplicate [--with-updates]` (`duplicate_doc`). IMPL cluster:
`153458a` feat (5 runtime fetcher bodies in `src/api/documents.ts`
swap c8-ignored stubs for live `client.raw` round-trips against
the pinned operationNames; new `extractDuplicateDocId` helper
for the opaque-JSON new-doc-id extraction defensively across
bare-string / number / record-with-`id` / `doc_id` /
`new_doc_id` shapes; 5 runtime action bodies wired via
`resolveClient` + dry-run via `emitDryRun` + live via
`emitMutation`; `doc delete`'s destructive gate preserved
BEFORE `resolveClient` per M10 round-1 P2 invariant; 42 new
integration tests across 5 new files + 11 envelope snapshots) +
6 Codex IMPL fix-up rounds (`930cbc8` round-1: 0 P1 + 1 P2 + 2
P3 — `renameDoc` null-payload contract decision per the
per-fetcher probe-description asymmetry + module-header prose
flip + detail-slot test assertions across all 5 verbs;
`465bfd3` round-2: 0 P1 + 0 P2 + 1 P3 — 4 downstream JSDoc
"cassette pins" sites flipped to forward-looking framing;
`a1e7a46` round-3: 0 P1 + 0 P2 + 1 P3 — 1 remaining
"duplicate-cassette pin" hint in `extractDuplicateDocId`'s
JSDoc; `a671e01` round-4: 0 P1 + 0 P2 + 1 P3 — 6 remaining
forward-looking "cassette" mentions uniformly removed to
match W11 audit-point's noun-stem grep; `c26fd31` round-5: 0
P1 + 0 P2 + 1 P3 — 5 module headers' stale `parseGlobalFlags`-
vs-`resolveClient` ordering prose flipped post-IMPL-collapse
(`parseGlobalFlags` now nests inside `resolveClient` for the
4 non-delete verbs); `e7c5e50` round-6: 0 P1 + 0 P2 + 2 P3 —
null-payload test `details.name` assertion + `duplicateDoc`
JSDoc proximity to its function declaration). Round-7
ratified clean across all 16 audit points (W1–W14 + W15 +
W16). **Cumulative IMPL findings: 0 P1 + 1 P2 + 8 P3 across
6 fix-up rounds** — 1-2 rounds above the M22 / M27 / M30 /
M31 / M32 / M34 write-surface IMPL precedent, driven by the
opaque-JSON cassette-prose sweep surfacing incrementally as
the post-fix-up R-NEW-72 grep pattern broadened across rounds
2-4.

**Pre-flight cluster** (prior session) closed at
`f911fbd..a4763a2`: 5 Codex fix-up rounds + 1 ratification;
0 P1 + 1 P2 + 10 P3 cumulative. Lands the contract surface:
5 stub fetcher functions + 5 GraphQL mutation documents + 4
wrapping response schemas (both create variants share
`createDocResponseSchema`) + opaque-JSON projection schema
`docMutationResultSchema` pinning `success: z.literal(true)`
per D9 + `DUPLICATE_TYPE_VALUES` 2-value enum + 5 command
stubs + new `DocFolderIdSchema` brand at `src/types/ids.ts`
(11th numeric-ID kind) + cli-design §4.3 DOC extension + 54
argv-parser unit tests.

**Codex pre-flight review converged in 6 rounds** across
`c99cf95..a4763a2` — round 1 `c99cf95` (0 P1 + 1 P2 + 5 P3:
`parseGlobalFlags`-before-c8 ordering on 4 non-delete stubs +
stale one-verb create example + literal-`true` projection
prose + permission-sensitive prose on create-on-column +
wrong-slot strict-rejection tests + camelCase asymmetry
pointer-only on rename.ts) + round 2 `43962f5` (0 P1 + 0 P2 +
1 P3: camelCase pointer collapse extended to delete +
duplicate sibling docstrings) + round 3 `1e7ea83` (0 P1 + 0 P2
+ 2 P3: `blocks` omit framing harmonised across 4 sites +
v0.5-plan §3 dup placeholder removed + D7 / D8 "Tentative
closure" → "Closed at M35 pre-flight" flip) + round 4
`8d43ee3` (0 P1 + 0 P2 + 1 P3: M35 surface-count prose
precision — 5 CLI verbs / 4 wire mutations / 4 wrapping
schemas / 5 deferred surfaces split across M36+M37) + round 5
`a4763a2` (0 P1 + 0 P2 + 1 P3: R-NEW-76 paragraph dropped
speculative `parseBrandedListArg` mention — M35 verbs don't
consume comma-separated brand lists). **Round 6 ratified
clean across all 15 audit points (W1–W14 + W15).** **Cumulative
pre-flight findings: 0 P1 + 1 P2 + 10 P3 across 5 fix-up
rounds** — within the M22 / M27 / M30 / M31 / M32 / M34
write-surface pre-flight precedent (cumulative 0-3 P2 + 3-10
P3 typical for new write-mutation pre-flights).

**D7 / D8 / D9 closures ratified.** D7: two CLI verbs over one
with placement choosers (mirrors v0.4-M31's `monday item
upload` / `monday update upload` split for the same multipart
wire path). D8: drop `--name <n>` from duplicate (no wire-side
rename slot on `duplicate_doc`). D9: opaque JSON returns
project to flat `{ doc_id, success: true }` per §6.1 single-
record envelope — `success` pinned literal-`true` because
Monday surfaces failure via GraphQL `errors[]` upstream, not
via a wire-side success flag.

**R-class state (post-M35 IMPL close).** No code-lift R-class
movement at M35 IMPL — the 6-round Codex IMPL cluster's
findings (1 P2 + 8 P3) were a single runtime correctness
issue (per-fetcher null-payload asymmetry derived from probe
descriptions) + prose-precision fix-ups + one test detail-slot
assertion + one JSDoc proximity fix. No 3-consumer threshold
crystallised.

**Two new R-class candidates filed at M35 IMPL close** (full
entries at v0.5-plan §22):

- **R-v0.5-NEW-11 — Per-fetcher null-payload contract
  decision discipline at pre-flight, derived from probe-
  description return-shape promises.** Surfaced at M35 IMPL
  round-1 P2-1 — pre-flight pinned all 3 opaque-JSON fetchers
  (`renameDoc` / `deleteDoc` / `duplicateDoc`) as `null →
  not_found` by analogy with M14 + M34, but IMPL surfaced the
  per-fetcher asymmetry: `update_doc_name`'s probe description
  carries NO return-shape prose (null plausibly empty-success);
  `delete_doc` + `duplicate_doc` descriptions BOTH promise
  non-null payloads on success (null = missing record).
  1 supporting instance; LOW priority watch-item — process
  discipline, NOT a code lift. Graduates to a pre-flight
  Codex template audit-point at 3rd supporting instance.
- **R-v0.5-NEW-12 — Pre-IMPL cross-doc grep extension for
  call-ordering claims in module-header prose.** Surfaced at
  M35 IMPL round-5 P3-1 — 5 module headers still claimed the
  pre-flight `parseGlobalFlags`-vs-`resolveClient` ordering
  after the IMPL had collapsed it (the 4 non-delete verbs now
  nest `parseGlobalFlags` inside `resolveClient`). The
  R-NEW-56 IMPL-kickoff grep catches "stub" / "PRE-FLIGHT" /
  "deferred_to" patterns but DOESN'T catch "BEFORE
  resolveClient" / call-ordering claims. 1 supporting
  instance; LOW priority watch-item. Folds into R-NEW-56's
  IMPL-kickoff checklist at 2nd supporting instance.

**Two R-class disciplines ratified at M35 IMPL** (full
context at v0.5-plan §12):

- **R-NEW-72** (post-fix-up cross-doc grep) ratified for the
  **5th time** — discipline fired after every contract-
  flipping fix-up across rounds 1-4 + after rounds 5-6.
  **Lesson surfaced at rounds 3-4:** grep patterns benefit
  from matching noun stems (`cassette` / `cassette pin` /
  `cassette pins` / `cassette pinned`) not just the literal
  substring — the round-2 grep with the narrower pattern
  missed the singular "cassette pin" stem (caught at round
  3); the round-3 grep missed the bare noun `cassette`
  (caught at round 4). When R-NEW-72 fires post-fix-up, use
  `\b<noun>\b` regex matching rather than literal-substring
  matching to catch all inflections in a single pass.
- **R-NEW-37 W2** (operationName parity) safely-by-
  construction across all 5 fetchers — verified clean at
  IMPL rounds 1+7.
- **R-NEW-76** (parseArgv-before-c8 / parseArgv-before-
  resolveClient) consumer-7 applied across all 5 M35 action
  bodies post-IMPL — rule stable post-graduation at M34
  close-docs.

**Live numbers (post-M35 IMPL close):**

- Test count: **3858 + 1 skipped** across **162** test files
  (+52 net vs 3806 + 1 skipped at M35 pre-flight close: 42
  new integration tests across 5 new files
  (`tests/integration/commands/doc-{create-in-workspace,
  create-on-column,rename,delete,duplicate}.test.ts`; 9 + 6
  + 7 + 7 + 13 per file) + 11 envelope snapshots in
  `tests/integration/envelope-snapshots.test.ts` − 1 wrong-
  slot stub test collapsed at IMPL (the pre-flight stub's
  `parseGlobalFlags`-before-c8 test became redundant once
  the c8 block was dropped). Round-1 fix flipped 1 test's
  expected outcome (rename null → success vs not_found);
  round-6 fixes added an assertion + reordered a JSDoc
  block (test count unchanged on rounds 2-6).
- Coverage: **99.29 / 96.36 / 99.44 / 99.55** (stmts /
  branches / fns / lines) at the **95 / 95.45 / 95 / 95**
  floor. **Branches margin recovered 0.91pp** (was 0.84pp at
  M35 pre-flight close; +0.07pp from runtime-body branches
  covered by integration tests vs the 5 c8-ignored stub
  drops). All 4 metrics improved at IMPL close vs pre-flight
  (stmts +0.11pp / branches +0.07pp / fns +0.40pp / lines
  +0.10pp) — same cadence as M32 + M34 IMPL closes.
- ERROR_CODES count: **29** (unchanged; M35 reuses existing
  codes per D-decisions).
- Command count: **112** (unchanged from pre-flight; IMPL
  adds no verbs).
- `package.json` version: **0.4.0** (stays through v0.5
  milestones; bumps to `0.5.0` at v0.5 release-prep).

**Candidate-selection closed: M36 = doc-block CRUD** per the
R-NEW-75 5-dimension framework (this session). Decision pinned
across the 3 candidates evaluated (M36 doc-block CRUD vs M37
doc-content import first vs v0.5.x cleanup bundle). M36 won on
neutral trade-offs: empirical probes already ran at v0.5
kickoff (no fresh probe needed — scope pinned at v0.5-plan §3
M36 + §8 D10-D11); JSON `client.raw` transport seam verbatim
(mirrors M22 / M27 / M32 / M35 — R-v0.4-W2 does NOT fire); 1
destructive verb (`doc block-delete --yes`) follows the
standard `enforceDestructiveGate` cadence per M10 invariant;
R-NEW-42 `parseJsonArg` already 3-consumer-lifted at v0.3-M27
(M36 consumes the helper at consumer 4 + 5 for `block-create
--content` + `block-update --content` — no new R-class
trigger at pre-flight). Codex round estimate 3-5 IMPL rounds
per the M22 / M27 / M30 / M31 / M32 / M34 OBJECT-return
mutation-surface precedent (16-value `DocBlockContentType`
enum may add ~1 round for per-block-type content cassette
breadth at IMPL; M35's 7-round outlier was opaque-JSON-driven
and doesn't apply here — `create_doc_block` /
`update_doc_block` return `DocumentBlock` OBJECT;
`delete_doc_block` returns `{id}` OBJECT). Estimated 3-4
sessions through M36 pre-flight + IMPL. **Trade-off surfaced
at the AskUserQuestion**: M37-first would close D13 (empirical
size-limit probe) earlier and de-risk v0.5 release-prep
sooner; the user picked M36 first on the lower-risk-session
axis (all M36 probes already settled vs M37's still-tentative
D13). M37 + v0.5.x cleanup open at their own candidate-
selection sessions per the framework's per-milestone cadence.

**v0.5-M36 IMPL closed at `ef37b44..66bca9b`.** 3 doc-block CRUD
verbs shipped end-to-end under the existing `monday doc`
namespace, backed by Monday's `create_doc_block` /
`update_doc_block` / `delete_doc_block` wire mutations. IMPL
cluster: `ef37b44` feat (3 runtime fetcher bodies in
`src/api/documents.ts` swap c8-ignored stubs for live
`client.raw` round-trips against literal-pinned operationNames
`CreateDocBlock` / `UpdateDocBlock` / `DeleteDocBlock`; two-stage
parse cadence — loose wrapping schema + `assertResponseFieldPresent`
+ per-fetcher null-payload contract + unwrap inner OBJECT via
`documentBlockSchema` (create + update) or
`documentBlockIdOnlySchema` (delete) — mirrors M34 / M35
cadence; 3 runtime action bodies wire `resolveClient` + fetcher
+ `emitDryRun` / `emitMutation`; `block-delete` preserves the
destructive-gate-BEFORE-resolveClient ordering per M10 round-1
P2 invariant; 32 new integration tests across 3 new files —
14 + 9 + 9 — covering happy / null-payload / missing-key /
schema-drift across all 3 fetchers + per-type content cassettes
sampling 4 of 16 + 2 of 16 `DocBlockContentType` variants per
D11; 6 envelope snapshots refreshed at
`tests/integration/envelope-snapshots.test.ts` replacing the
3 pre-flight stub-`internal_error` snapshots with 3 dry-run
envelope snapshots; `docs/output-shapes.md` flips 3 stub-status
banners + appends "Per-block content shapes" reference table —
7 cassette-pinned rows + 9 TBD / inferred rows pending follow-
up cassettes) + `c3f2c76` Codex round-1 fix-up (0 P1 + 0 P2 +
3 P3 — confirmation_required example precision +
sibling-inferred rows flipped to TBD framing + 3 stale future-
tense "pins land at IMPL cassettes" prose sites) + `66bca9b`
Codex round-2 fix-up (0 P1 + 0 P2 + 1 P3 — count-quoting
"10 of 16 / remaining 6 TBD" prose flipped to count-agnostic
"marks cassette-pinned shapes and TBD / inferred variants"
framing across 3 sites + DOC_BLOCK_CONTENT_TYPE_VALUES future-
extension JSDoc). Round-3 ratified clean (0 P1 + 0 P2 + 0 P3
across all 10 audit-points). **Cumulative IMPL findings:
0 P1 + 0 P2 + 4 P3 across 2 fix-up rounds** — at the LOWER
bound of the M22 / M27 / M30 / M31 / M32 / M34 OBJECT-return
mutation-surface IMPL precedent, well below M35's 7-round
opaque-JSON outlier. Pre-flight cluster carried forward at
`19e1fa2..7633a23` (3 commits: feat + 2 fix-up rounds + 1
ratification; 0 P1 + 0 P2 + 7 P3 cumulative). **Pushed to
`origin/main`** at close-docs.

**M36 IMPL highlights.** R-v0.5-NEW-11 (per-fetcher null-payload
contract decision derived from probe descriptions) validated
as a pre-flight discipline at M36 — supporting instance 2 of
the watch-item (M35 IMPL surfaced it; M36 pre-flight contract
decisions correctly carried the per-fetcher asymmetry without
an IMPL P2 fix-up — `createDocBlock` null → `internal_error`
because Monday's contract implies "must return the created
block"; `updateDocBlock` null → `not_found` because the probe
description "Update a document block" promises the updated
block on success; `deleteDocBlock` null → `not_found` mirroring
the standard M14 / M34 / M35 delete cadence). **Zero P2
findings IS the standout** — M35 IMPL surfaced 1 P2, M36 IMPL
zero because the lesson generalised. R-NEW-72 (post-fix-up
cross-doc grep) ratified for the 7th time — discipline caught
3 parallel-site drifts in round 1 alone (block-create addHelpText
footer + block-update addHelpText footer + DOC_BLOCK_CONTENT_TYPE_VALUES
future-extension JSDoc). Round-2 surfaced a new lesson:
**count-agnostic prose for documentation tracking an evolving
reference table** (R-v0.5-NEW-16 filed at §22) — when prose
references a count drawn from an evolving table, the count goes
stale silently the moment the table state shifts; use shape-
descriptive framing instead. Per-block content payload structure
documented in `docs/output-shapes.md` "Per-block content shapes"
reference table — 7 cassette-pinned variants (normal_text /
large_title / quote / bulleted_list / check_list / code /
divider) + 9 TBD / inferred variants awaiting follow-up
cassettes per D11.

**v0.5-M36 pre-flight closed at `19e1fa2..7633a23`** (prior
session). 3 new verbs under the existing
`doc` namespace; OBJECT-return cadence (distinct from M35's
opaque-JSON D9 projection — M36's `create_doc_block` +
`update_doc_block` return full 9-field `DocumentBlock`;
`delete_doc_block` returns single-field `DocumentBlockIdOnly`).
Snake_case wire arg names (`doc_id` / `block_id` /
`after_block_id` / `parent_block_id`) — back to Monday's
standard cadence after M35's camelCase asymmetry; NOT a new
R-NEW-41 supporting site. `DocBlockIdSchema` brand uses
`slugIdSchema` (non-empty-string base; same shape as
`ColumnId` / `GroupId`) because Monday's `DocumentBlock.id` is
wire `String!`, NOT `ID!` — load-bearing distinction from
`DocId`'s numeric brand. **D10 + D11 closed** at this pre-flight
(D10: unknown `--type` values reject at parse with
`details.issues[{path: 'type', message: '...'}]` per
`parseArgv`'s `SummarisedIssue` shape; D11: per-type content
payload structure deferred to M36 IMPL cassettes for 16-shape
breadth). **R-NEW-58 2-consumer scan at pre-flight kickoff
returned NEGATIVE** — `parseJsonArg` already 3-consumer-lifted
at v0.3-M27 (M36 consumes the helper at consumers 4 + 5);
`documentBlockSchema` already exists at M32 (M36 fetchers
reuse it); no R-class lift fires ahead of feat.

**Live numbers (v0.5.0 published):**

- Test count: **4054 + 1 skipped** across **170** test files
  (unchanged from M37 IMPL close — the release-prep cluster adds
  no tests; the envelope-snapshot refresh probe at "Commit 1"
  returned zero diff because every v0.5 milestone refreshed its
  own snapshots in lockstep at IMPL close, so no separate
  snapshot commit landed).
- Coverage: **99.29 / 96.45 / 99.45 / 99.55** (stmts / branches
  / fns / lines) at the **95 / 95.45 / 95 / 95** floor.
  **Branches margin 1.00pp** (unchanged from M37 IMPL close —
  the deferral slip changes only string literals; the README +
  CHANGELOG + ToC additions are doc-only; the version bump is
  package.json + package-lock.json only). The release-prep
  cluster matched v0.4 release-prep's "no coverage residual
  sweep needed" branch (margin ≥ 0.5pp baseline + no per-file
  100%-residual gap surfaced).
- ERROR_CODES count: **29** (unchanged — release-prep adds no
  new codes).
- Command count: **117** (unchanged — release-prep adds no
  verbs).
- `package.json` version: **0.5.0** (bumped at `ae7b074`).
- `v0.5.0` annotated tag points at `c2e2df6` (close-docs
  commit); **pushed to `origin/main`** + **GitHub release live**
  at https://github.com/Firer/monday-cli/releases/tag/v0.5.0.
  v0.4.0's tag remains live at `b8e4cd0`.
- npm registry version: **0.5.0** (`latest` dist-tag,
  published 2026-05-17T20:55:05Z by `nickwebster`).

**Live numbers (post-v0.5-M37 IMPL close — carried for context):**

- Test count: **4054 + 1 skipped** across **170** test files
  (+56 net vs 3998 + 1 skipped at M37 pre-flight close: 20
  source-content unit tests at `tests/unit/utils/source-content.
  test.ts` (R-v0.5-NEW-18 lift) + 36 M37 integration tests
  across 2 new files (`tests/integration/commands/doc-{import-
  html,append-markdown}.test.ts`; 17 + 19) − 2 envelope-
  snapshot tests renumbered post-describe-widening (round-5
  P3-1 widened the M36 describe-block to cover M37; snapshot
  bodies byte-identical, only key prefix changed). Rounds 1-5
  fix-ups added prose-only changes; round-1 P2-2 pinned 2 new
  assertions on existing update.test.ts cases; round-4 P3-2
  renamed one test.
- Coverage: **99.29 / 96.45 / 99.45 / 99.55** (stmts /
  branches / fns / lines) at the **95 / 95.45 / 95 / 95**
  floor. **Branches margin 1.00pp** (was 0.93pp at M37
  pre-flight close; +0.07pp from runtime-body branches covered
  by integration tests vs the 2 c8-ignored stub fetcher drops
  + 2 stub action-body drops; first v0.5 IMPL milestone to
  cross the 1.00pp branches margin threshold). All four
  metrics within floor; stmts/fns/lines functionally unchanged
  vs pre-flight (the R-v0.5-NEW-18 lift adds the helper file
  outside the M37 src surface; the round-1 P2-1 `.refine()`
  adds minor branch surface).

**Live numbers (post-M36 IMPL close):**

- Test count: **3950 + 1 skipped** across **166** test files
  (+31 net vs 3919 + 1 skipped at M36 pre-flight close: 32 new
  integration tests across 3 new files
  (`tests/integration/commands/doc-block-{create,update,delete}.test.ts`;
  14 + 9 + 9 per file — covers happy / null-payload / missing-
  key / schema-drift across all 3 fetchers + per-type content
  cassettes sampling 4 of 16 + 2 of 16 variants per D11) − 6
  stub envelope-shape snapshots collapsed + 6 new envelope
  snapshots (3 dry-run + 3 parse-boundary surfaces). Rounds
  1 + 2 fix-ups added 0 tests — both prose-only.
- Coverage: **99.30 / 96.38 / 99.45 / 99.56** (stmts /
  branches / fns / lines) at the **95 / 95.45 / 95 / 95**
  floor. **Branches margin recovered 0.93pp** (was 0.86pp at
  M36 pre-flight close; +0.07pp from runtime-body branches
  covered by integration tests vs the 3 c8-ignored stub
  fetcher drops + 3 stub action-body drops). All 4 metrics
  improved vs pre-flight (stmts +0.01pp / branches +0.07pp /
  fns +0.00pp / lines +0.01pp) — same cadence as M32 + M34 +
  M35 IMPL closes.
- ERROR_CODES count: **29** (unchanged per D10/D11 closures —
  M36 reuses existing codes).
- Command count: **115** (unchanged from pre-flight; IMPL
  adds no verbs).
- `package.json` version: **0.4.0** (stays through v0.5
  milestones; bumps to `0.5.0` at v0.5 release-prep).

**R-class movement at M36 IMPL close:** The 4 P3 findings across
the 2 fix-up rounds were all prose drift; one new R-class
candidate surfaced (R-v0.5-NEW-16). R-v0.5-NEW-11 graduated to
2 supporting instances — discipline applied successfully at M36
pre-flight contract-decision time (per-fetcher null-payload
decisions landed correctly on first feat commit; zero P2 IMPL
fix-ups; M35 IMPL's lesson generalised).

**One new R-class candidate filed at M36 IMPL close —
R-v0.5-NEW-16** (count-agnostic prose for documentation
tracking an evolving reference table; 1 supporting instance —
M36 IMPL round-2 P3-1; LOW priority watch-item, process
discipline NOT a code lift; graduates at 2nd supporting
instance — likely v0.5-M37 IMPL or v0.5 release-prep where
another evolving reference table fires the same count-drift
pattern). Pattern: documentation prose that quotes a count
drawn from an evolving table goes stale silently the moment
the table state shifts; use count-agnostic shape-descriptive
framing instead. Full entry at v0.5-plan §22 R-v0.5-NEW-16.

R-class state carried forward at M36 IMPL close:

- R-v0.5-NEW-1 (introspect-helper `inputFields` widening) —
  still DEFERRED; M36 IMPL didn't add a new probe consumer.
- R-v0.5-NEW-11 (per-fetcher null-payload contract decision
  discipline) — **graduates to 2 supporting instances**
  (negative ratification at M36: discipline prevented the
  drift from landing; zero P2 IMPL fix-ups). 1 more supporting
  instance graduates to a permanent pre-flight Codex template
  audit-point.
- R-v0.5-NEW-12 (pre-IMPL cross-doc grep extension for call-
  ordering claims) — stays at 1 supporting instance; M36 IMPL
  applied the discipline correctly at kickoff (no post-IMPL
  fix-up required — negative-case validation; the graduation
  trigger fires when the discipline catches a real drift).
- R-v0.5-NEW-13 (post-IMPL close-docs sweep includes
  output-shapes.md) — verified at M36 IMPL close: output-
  shapes.md flipped in the feat commit `ef37b44` (NOT delayed
  to the close-docs commit), so the discipline applied
  ahead-of-close. Stays at 2 supporting instances.
- R-v0.5-NEW-15 (pre-flight per-variant payload-shape
  deferral to IMPL cassettes) — **supporting instance 2
  fulfilled**: M36 IMPL wrote 7 cassette-pinned rows + 9 TBD
  rows in `output-shapes.md`'s "Per-block content shapes"
  reference table. Graduates to a Codex pre-flight template
  audit-point at the 3rd supporting instance (likely M37).
- R-v0.5-NEW-16 (count-agnostic prose discipline) — newly
  filed at M36 IMPL close-docs; 1 supporting instance; LOW
  priority.
- **R-v0.5-NEW-17 (OBJECT-shape null-payload guard pattern;
  sibling to R-NEW-73 for arrays) — newly filed at the post-
  M36-IMPL refactor-audit** with 9 consumers across M34/M35/
  M36 mutation fetchers (createTeam + deleteTeam + 4 doc
  mutations + 3 doc-block mutations). UNFILED-as-helper today
  per the same per-consumer divergence rationale as R-NEW-73
  (error code + message template + details shape differ per
  consumer; helper signature ≈ inline line-count at 9
  consumers). LOW priority watch-item; lift fires when
  divergence shrinks OR consumer count crosses ~12-15.
- R-NEW-72 (post-fix-up cross-doc grep) — **7th instance**
  ratified at M36 IMPL round 1 (caught 3 parallel-site drifts
  inline). Discipline stable.
- R-NEW-37 W2 (operationName parity) — safely-by-construction
  across all 3 fetchers; verified clean at Codex IMPL rounds
  1-3.
- R-NEW-76 (parseArgv-before-c8 / parseArgv-before-
  resolveClient) — **consumer 9** applied across all 3 M36
  action bodies post-IMPL; rule stable post-graduation at
  M34 close-docs.

**Candidate-selection closed: M37 = doc-content import** per the
R-NEW-75 5-dimension framework (this session). Decision pinned
across 3 candidates evaluated (M37 doc-content import vs v0.5.x
cleanup bundle vs skip to v0.5 release-prep). M37 won on neutral
trade-offs: empirical probes already ran at v0.5 kickoff for the
2 mutation signatures + custom `{success, error?}` return shape
(no fresh probe needed for the contract diff — D13's empirical
size-limit probe runs AT M37 pre-flight per its tentative
closure); JSON `client.raw` transport seam verbatim (mirrors
M22 / M27 / M32 / M35 / M36 — R-v0.4-W2 does NOT fire); 0
destructive verbs (both `doc import-html` + `doc append-
markdown` are content-creation); R-v0.5-NEW-15 graduates at 3rd
supporting instance (per-variant payload-shape deferral to IMPL
cassettes — M37's HTML / markdown payload variability mirrors
M36's 16-shape DocBlockContentType breadth); R-v0.5-NEW-11 likely
fires at 3 supporting instances (per-fetcher null-payload
contract decision discipline — both M37 mutations carry the
custom `{success, error?}` shape where `error` empty vs populated
splits into `internal_error` vs `validation_failed`). Codex round
estimate 3-5 IMPL rounds per the M22 / M27 / M30 / M31 / M32 /
M34 / M35 / M36 OBJECT-return mutation-surface precedent (M35's
7-round outlier was opaque-JSON-driven; M37's custom-OBJECT
shape may add ~1 round vs M36's clean 3-round cadence). Trade-
offs surfaced at the AskUserQuestion: cleanup bundle would close
in 1-2 sessions vs M37's 3-4 sessions but defers the last v0.5
feature milestone to v0.5.x; skip-to-release-prep would publish
v0.5.0 with M34 + M35 + M36 only but leaves doc-content-import
unshipped in v0.5. User picked M37 on the v0.5-scope-completion
axis (M37 is the last feature milestone in v0.5 scope; release-
prep opens cleanly after M37 IMPL close-docs). After M37 closes,
v0.5 release-prep opens at its own candidate-selection-or-direct
session per the framework's per-milestone cadence.

**v0.5-M37 pre-flight closed at `8eb6da7..7f77b2d`** (4
commits: feat `8eb6da7` + 3 Codex fix-up rounds at `44783f9` /
`42860bb` / `7f77b2d` + round-4 ratification clean).
**Cumulative pre-flight findings: 0 P1 + 1 P2 + 4 P3 across 3
fix-up rounds** — within the M22 / M27 / M30 / M31 / M32 / M34
/ M35 / M36 write-surface pre-flight precedent (cumulative 0-3
P2 + 3-10 P3 typical). The contract surface for the 2 new
v0.5-M37 verbs (`monday doc import-html` +
`monday doc append-markdown`) ships: 2 stub fetchers at
`src/api/documents.ts` (`importDocFromHtml` +
`addContentToDocFromMarkdown` with `c8 ignore` wraps) + 2
GraphQL mutation documents pinned at literal operationNames
(`ImportDocFromHtml` + `AddContentToDocFromMarkdown` per
R-NEW-37 W2 safely-by-construction) + 2 wrapping response
schemas + 2 strict inner-OBJECT result schemas
(`importDocFromHtmlResultSchema` /
`docBlocksFromMarkdownResultSchema`) + 2 CLI projection
envelopes + `MAX_DOC_IMPORT_PAYLOAD_BYTES = 256_000` constant +
2 command stubs with mutex-source schemas
(`src/commands/doc/import-html.ts` + `append-markdown.ts` —
`parseArgv` BEFORE c8-ignore per R-NEW-76 graduated discipline;
11th + 12th consumers post-graduation); cli-design §4.3 DOC
extension + §13 v0.5 entry fold-in; output-shapes.md M37
sections + "Doc-content import error messages" reference table
per R-v0.5-NEW-15 per-source TBD deferral. D13 empirical
size-limit probe ran at pre-flight kickoff
(`scripts/probe/v0.5-m37-size-limits.ts`, 2026-05-17) +
pinned the wire-side rejection threshold between 250KB-OK and
500KB-rejected on both surfaces — rejection shape is generic
`INTERNAL_SERVER_ERROR` (NOT the documented `{success: false,
error}` envelope path), so the CLI pre-empts at parse boundary
via the `MAX_DOC_IMPORT_PAYLOAD_BYTES` `.refine()` on inline
`--html-string` / `--markdown-string`. D12 closure pins the
custom-OBJECT projection (5 branches): success → flat envelope;
`success: false + populated error` → `validation_failed`;
`success: false + empty/null error` → `internal_error` (wire-
regression hint); `success: true + missing payload` →
`internal_error` (probe descriptions promise non-null); EMPTY
`block_ids: []` on success → success WITH empty array. **9 doc-
mutation surfaces total now sequenced across M35 (4 wire / 5
CLI verbs) + M36 (3 wire / 3 CLI) + M37 (2 wire / 2 CLI) — 10
CLI verbs; closes the v0.4-M32 doc-mutation deferral.**

**R-v0.5-NEW-11 GRADUATED to a permanent Codex pre-flight
template audit-point at M37 pre-flight close** (3rd supporting
instance — per-fetcher null-payload contract decision discipline
derived from probe-description return-shape promises). **R-v0.5-
NEW-15 GRADUATED** (3rd supporting instance — pre-flight per-
variant payload-shape deferral to IMPL cassettes). Template
extensions (`.claude/templates/codex-pre-flight-review.md` W{N}
audit-points) land at the next pre-flight session touching a
custom-OBJECT / opaque-JSON / N-variant payload surface. **R-NEW-
72 cross-doc grep extension to `src/commands/index.ts` module-
import block prose filed as R-v0.5-NEW-19** (1 supporting
instance from M37 pre-flight round-3 P3-1 catch — fix-up cost
a full extra round because the round-1 W4 sweep missed the
`src/commands/index.ts:286` site). **R-v0.5-NEW-18 filed**
(`readUpdateBody` lift to generic file-or-stdin-or-inline-string
helper; 3 consumers today + 2 projected at M37 IMPL = 5 projected
post-lift; MEDIUM priority lift fires at M37 IMPL kickoff per
R-NEW-58 lift-ahead-of-feat cadence). **R-NEW-41 5th supporting
site landed** (camelCase wire arg names `workspaceId` /
`folderId` / `docId` / `afterBlockId`). **Pushed to `origin/main`**
at close-docs. **Post-close refactor-audit additions:**
**R-v0.5-NEW-9 GRADUATED** (2nd supporting instance — the M37
round-1 P2-1 fix-up added an oversized-payload envelope
snapshot for `--html-string` but missed the parallel
`--markdown-string` sibling; rounds 2-4 didn't catch the gap;
the post-close audit closed the gap inline + bumped the entry
to 2 instances, graduating the round-N parallel-fetcher fix-up
test parity discipline to a permanent IMPL-review / pre-flight
template W{N} audit-point at the next template extension
session). **R-v0.5-NEW-20 NEWLY FILED** (mutex-source argv
cross-field `.refine()` pattern; 2 consumers via M37; LOW
priority; fires at 3rd consumer). **R-v0.5-NEW-21 NEWLY
FILED** (UTF-8 byte-length cap via `.refine()` for wire-side
payload caps; 2 consumers via M37; LOW priority; fires at 3rd
consumer).

**v0.5-M37 IMPL closed at `c431d96..25e1204`** (7 commits:
R-v0.5-NEW-18 lift `c431d96` + IMPL feat `51ad434` + 5 Codex
fix-up rounds at `9374a7c` / `0ec8629` / `1a64f49` / `58e41c2` /
`25e1204` + round-6 ratification clean across all 16 audit
points; cumulative IMPL findings **0 P1 + 2 P2 + 11 P3 across 5
fix-up rounds** — within the M22 / M27 / M30 / M31 / M32 / M34
/ M35 / M36 write-surface IMPL precedent; ~1 round above M36's
clean 3-round OBJECT-return cadence, driven by the custom-OBJECT
shape's prose surface + the R-NEW-72 sibling-site grep cycle
expanding noun-stem matching over rounds 3-5). v0.5-M37 closes
the LAST feature milestone in v0.5 scope. **R-v0.5-NEW-11
GRADUATED** (3rd supporting instance — per-fetcher null-payload
contract decision discipline) + **R-v0.5-NEW-15 GRADUATED**
(3rd supporting instance — per-variant payload-shape deferral
to IMPL cassettes); both promote to permanent Codex pre-flight
template audit-points at the next pre-flight session touching a
custom-OBJECT / opaque-JSON / N-variant payload surface.
**R-v0.5-NEW-18 SHIPPED** (5 consumers post-lift: 3 M13 +
2 M37; helper at `src/utils/source-content.ts` with 20 unit
tests). **R-v0.5-NEW-19** fired at IMPL round-2 P3-2 (first
post-pre-flight supporting instance); folds into R-NEW-72's
"Workflow rules" entry at next contract-flipping fix-up cluster.
**R-NEW-72 ratified for the 8th time** across rounds 1-5 with a
load-bearing lesson: noun-stem matching must extend to ALL
sibling sites; round-N fixes commonly introduce round-N+1
catches when the grep pattern is too narrow.

**Next session — v0.6 kickoff (externally-blocked on user
authorization for v0.5.0 push + publish first).** Once `v0.5.0`
has been pushed + published, v0.6 opens with a candidate-
selection session per the R-NEW-75 5-dimension framework.
Carried-forward backlog candidates from v0.5 (slipped from v0.5
→ v0.6 at v0.5 release-prep): files-shaped friendly column
writes (`--set <file-col>=<path>` + `--set-raw <file-col>=<json>`
— `monday item upload` from v0.4-M31 is the verb-shaped
alternative agents use today); multi-level subitem creation
(still conditional on Monday's `sub_items_board` surfacing a
`subtasks` column at a future API version); cross-board `item
move` value-overrides (Monday's `ColumnMappingInput` still
carries no value slot); resumable cross-board cursor pagination
(per-board cursor-lifetime under aggregation needs design work).
Plus any unspecified v0.6 wishlist items the user prioritises.
**R-NEW-82 graduated at this v0.5 release-prep cluster** —
3rd consecutive release-prep that caught ≥ 1 stale `deferred_to`
site (M28 caught 2; v0.4 caught 3; v0.5 caught 4 production + 5
test + 5 doc prose sites + 1 ToC user-row drift); promoted to a
permanent CLAUDE.md "Workflow rules" entry under the existing
release-prep cadence. **R-NEW-84 ratified** — the v0.5 release-
prep cluster IS the symmetric application of the rule (zero
production `src/**/*.ts` changes → Codex review skipped; gates
alone verified).

**M34 closed end-to-end** at `afdba15..02f1b1a` (carried for
context). IMPL feat + 3 Codex fix-up rounds + 1 ratification —
0 P1 + 1 P2 + 4 P3 cumulative. 6 team writer verbs live +
tested against fixture cassettes. Empirical findings from the
IMPL cassettes: no per-user failure reason on Monday's
`ChangeTeamMembershipsResult` wire today (probe round-2
introspection holds; CLI's generic `membership_failed` code
stays the agent contract); wire's outer bucket containers are
NULLABLE list wrappers (round-1 P2-1 caught the schema-vs-
docstring inconsistency in the pre-flight schema — IMPL widens
to `z.array(...).nullable()` + normalises to `[]` at the
projection boundary); `Team.owners` inner-entry nullability
not probed at IMPL (no integration test cassette exercised the
owners-null edge — defer until a real wire response surfaces
it).

**Candidate-selection closed: M35 = doc-level CRUD** per the
R-NEW-75 5-dimension framework (prior session). Decision pinned
across the 4 candidates evaluated (M35 doc-level CRUD vs M37
doc-content import first vs small cleanup bundle vs tangential
team mutations). M35 won on neutral trade-offs: empirical
probes already ran at v0.5 kickoff (no fresh probe needed —
scope pinned at v0.5-plan §3 M35 + §8 D7-D9); JSON
`client.raw` transport seam verbatim (mirrors M22 / M27 / M32
— R-v0.4-W2 does NOT fire); 1 destructive verb (`doc delete
--yes`) follows the standard `enforceDestructiveGate` cadence.
Codex round estimate 3-4 pre-flight + 2-3 IMPL per the M22 /
M27 / M30 / M31 / M32 write-surface precedent. Estimated 3-4
sessions through M35 pre-flight + IMPL; M36 / M37 open at
their own candidate-selection sessions per the framework's
per-milestone cadence.

**v0.4 release-prep close (prior session).** Mirrored v0.3-M28's
release-prep cadence verbatim: 6 commits (envelope-snapshot
refresh + ToC audit / deferral slip + README + version bump +
CHANGELOG + close-docs sweep) + annotated `v0.4.0` git tag
landed; **pushed to `origin/main`** + GitHub release live +
**npm publish landed 2026-05-14T22:46:28Z**. **R-NEW-75
graduated at the candidate-selection session that picked this
release-prep over M34 team writers** — the 5-dimension scoping
framework applied cleanly (release-prep returning zero on 4 of
5 axes IS the
signal that it's process-only, not a sign the dimensions are
wrong); promoted to a permanent CLAUDE.md "Workflow rules"
entry below.

**Prior milestone — v0.4-M32 IMPL landed end-to-end.**
Doc list/get (`monday doc list [--workspace <wid>,...]
[--order-by <created_at|used_at>] [--limit <n>] [--page <n>]` +
`monday doc get <did>`) — first v0.4 verbs against Monday's
`Query.docs(...)` surface; read-only at v0.4 with full workdocs
CRUD (9 mutation surfaces on the wire) deferred to v0.5 (each
mutation has enough surface area to warrant its own milestone
cluster). No new transport seam (read uses the JSON
`client.raw` path verbatim — same shape M22 `monday usage` +
M27 `webhook list` use); no destructive gate (pure read); no
new ERROR_CODE (29 stays per D8 closure). **Empirical probe**
(`scripts/probe/m32-docs.ts` + `m32-docs-2.ts`, 2026-05-14, API
`2026-01`) pinned `Query.docs(workspace_ids: [ID], order_by:
DocsOrderBy, limit: Int, page: Int) → [Document]` ahead of the
contract diff. **Eleven D-closures pinned at pre-flight** (D1–
D11): D1 two dedicated read verbs; D2 wire type is `Document`
not `Doc` (the standalone `DocKind` enum exists but
`Document.doc_kind` returns `BoardKind!` reusing the same
`public`/`private`/`share` values — wire-side type aliasing,
no CLI projection asymmetry); D3 page/limit pagination
(`MIN_DOC_LIST_LIMIT=1`, `MAX_DOC_LIST_LIMIT=100`,
`DEFAULT_DOC_LIST_LIMIT=25`) — no cursor on Monday's workdocs
surface; D4 `--workspace` comma-separated WorkspaceId filter
maps to wire `workspace_ids: [ID]`, best-effort (Monday silently
drops inaccessible IDs, no resolver warning); D5 `--order-by`
closed 2-value enum (`created_at`/`used_at`, both `desc`
server-side); D6 `blocks` slot in `doc get` only (list-row
projection skips the rich-text payload); D7 live-only — no
cache (mirrors `monday usage`/`status`/`webhook list`); D8 no
new ERROR_CODE; D9 `doc list` wrapped record envelope
`{documents, page, limit, returned_count, has_more}` (has_more
heuristic = `returned_count === limit`; no total-count on
wire), `doc get` direct unwrap `data: <Document with blocks>`;
D10 operationNames pinned literally (`ListDocs` / `GetDoc`; NOT
caller-overridable per R-NEW-37 W2); D11 `DocId` numeric-string
brand added to `src/types/ids.ts` (9th brand).

**Prior milestone — v0.4-M31 IMPL closed end-to-end.** Asset
upload (`monday item upload` + `monday update upload`) shipped
the first v0.4 multipart transport extension across the
pre-flight cluster `6b4c91e..ada29d1` (7 Codex rounds — driven
by two distinct surface classes including the new-transport-seam
substantive gaps at rounds 6-7) + IMPL cluster
`18c5386..4582dd7` (3 Codex rounds — runtime body at `18c5386`,
P2 substantive fixes at `f0952ea` round 1, prose precision at
`6e06f90`/`4582dd7` rounds 2-3). Full per-milestone narrative
at `docs/v0.4-plan.md` §3 M31 + §13 post-mortem.
R-v0.4-W2 (pre-pre-flight "new transport seam" interface-mirror
checklist) fired its 1st IMPL-side validation at M31 IMPL P2-1
(the "non-retryable rewrap placement" axis is a new invariant
unique to multipart upload); recommendation at v0.4-plan §13 to
extend R-v0.4-W2 with that axis ahead of the next "new transport
seam" milestone.

**M32 IMPL highlights.** Two runtime fetcher bodies shipped at
`src/api/documents.ts` — `listDocuments` (single `Query.docs(...)`
round-trip with `operationName: 'ListDocs'`, response-parse via
wrapping `listDocsResponseSchema` `.loose()` + `unwrapOrThrow`,
null root → `internal_error` with drift hint) + `getDocument`
(single `Query.docs(ids:)` round-trip with `operationName:
'GetDoc'`, empty-array → `not_found` per D8, null root →
`internal_error` per round-1 P2-1 closure, multi-element →
defensive `internal_error`). Two runtime action bodies shipped
at `src/commands/doc/list.ts` + `src/commands/doc/get.ts` —
`resolveClient` + fetcher + `emitSuccess` (`kind: 'single'` for
the wrapped-record envelope on doc list — `emit.ts` has no
`'record'` kind, so `'single'` is correct mirroring the M22
`monday usage` cadence; direct-unwrap for doc get). All four
stub bodies' `c8 ignore start/stop` block-wraps dropped; single
defensive `/* c8 ignore next 6 */` preserved on the
`document === undefined` sparse-array guard (zod's
`noUncheckedIndexedAccess` widening, not a production branch).
**Codex IMPL review converged in 3 rounds** across the cluster
`2ca8b97..cc31f76` — feat `2ca8b97` + round 1 `b8aa70d` (0 P1 +
1 P2 + 1 P3: null-vs-empty branch split + docstring drift) +
round 2 `cc31f76` (0 P1 + 0 P2 + 1 P3: two remaining prose
sites the round-1 fix introduced) + round 3 ratification (0 P1
+ 0 P2 + 0 P3). Within the M22 / M27 read-surface precedent
(1-3 rounds). Cumulative IMPL findings: **0 P1 + 1 P2 + 2 P3
across the 2 fix-up rounds**.

**M32 pre-flight highlights (carried for context).** Two new
read verbs + one fetcher module + one new ID brand
(`DocIdSchema` in `src/types/ids.ts`) + cli-design §4.3 DOC
section expanded with multi-line entries pinning the wire
surface. **Codex pre-flight review converged in 4 rounds**
across the cluster `05c5988..a889eac` — initial contract diff at
`05c5988` + round 1 `a875add` (0 P1 + 2 P2 + 2 P3: strict
decimal parser + `requiredJsonValueSchema` + 2 prose drifts)
+ round 2 `823fccc` (0 P1 + 1 P2 + 2 P3: pagination-invariant
`.superRefine` + 2 prose drifts) + round 3 `880d9fb` (0 P1 +
1 P2 + 1 P3: `.superRefine` early-return guard + close-docs
deferral) + round 4 ratification. Cumulative pre-flight
findings: **0 P1 + 4 P2 + 5 P3 across the 3 fix-up rounds**.

**Live numbers (M32 IMPL close):**
- Test count: **3578 + 1 skipped** across **146** test files
  (+24 net vs 3554 + 1 skipped M32 pre-flight close baseline:
  15 doc list integration tests + 9 doc get integration tests;
  round-1 fix flipped a test's expected error code without
  changing count; round-2 fix touched a test-file header
  comment without changing count).
- Coverage: **99.25 / 96.30 / 99.33 / 99.53** (stmts /
  branches / fns / lines) at the **95 / 95.45 / 95 / 95**
  floor. **Branches margin 0.85pp** (was 0.58pp at M32 pre-flight
  close; +0.27pp recovery from runtime-body branches covered by
  integration tests vs stub c8-ignore drops; ALL metrics improved
  vs pre-flight close — first v0.4 milestone where every metric
  improved at IMPL).
- ERROR_CODES count: **29** (unchanged per D8 closure).
- Command count: **100** (unchanged — IMPL adds no verbs).
- `package.json` version: **0.3.0** (stays through v0.4
  milestones; bumps to `0.4.0` at v0.4 release-prep).

**R-class state (post-M32 IMPL close):**

- **No code-lift R-class movement at M32 IMPL** — but **three
  new R-class candidates surfaced** (R-NEW-72 / R-NEW-73 /
  R-NEW-74; full entries at v0.4-plan §22). The 3-round IMPL
  cluster's findings (1 P2 + 2 P3) were a runtime correctness
  issue + prose drift fix-ups; the R-class candidates that
  surfaced are watch-items at 1-3 consumers, none crystallized
  for an immediate lift. The four post-M32-pre-flight
  candidates (R-NEW-68/69/70/71) all stay at their pre-IMPL
  consumer counts; the R-NEW-58 2-consumer scan at IMPL kickoff
  returned NEGATIVE (no lift fired ahead of the feat).
- **R-NEW-56 (cross-doc grep at IMPL kickoff) ratified for the
  3rd consecutive IMPL milestone.** Discipline now 3rd-time
  validated and stable (M30 → forced, M31 → vindicated, M32 →
  ratified). M32 IMPL's lesson at v0.4-plan §14: re-run the
  grep AFTER every Codex round that flips a contract (round-1
  fix introduced new prose drift that round-2 caught — the
  per-round-fix grep would have collapsed rounds 1+2).
- **R-NEW-58 (lift-ahead-of-feat) ratified via NEGATIVE
  evidence at M32 IMPL.** M31 IMPL ratified via positive case
  (`sniffContentType` 2-consumer lift). M32 IMPL ratified the
  inverse: the 2-consumer scan ran clean, no lift fired. The
  discipline correctly identifies BOTH positive and negative
  cases — "scan at IMPL kickoff and lift when the trigger is
  real", not "always lift at 2".
- **R-NEW-41 stays at 3 consumers post-M32.** The
  `BoardKind`-for-`Document.doc_kind` reuse is wire-side
  type-name aliasing, NOT a wire-vs-CLI semantic asymmetry.
- **R-NEW-43 stays at 1 consumer post-M32.** The v0.5 deferral
  list of 9 doc-mutation surfaces lives in §13 v0.4 entry prose.
- **R-NEW-31 stays at 1 consumer post-M32.** No per-status
  detail union surfaces — `doc list` + `doc get` envelopes
  carry flat shapes without status discrimination.

**Four R-class candidates filed at M32 pre-flight + carried
forward at IMPL (all stay at pre-IMPL counts)** (full
entries at v0.4-plan §22):

- **R-NEW-68 — `parseStrictDecimal` strict-decimal-integer
  parser for commander option-value coercion** (1 consumer;
  LOW priority watch-item, code lift at 2nd consumer).
  Surfaced at round-1 P2-1: `Number.parseInt` silently
  truncates `'25.5'` → 25 in commander's coercer recipe,
  bypassing the schema-layer `.int()` check. M32's strict
  variant lives at `src/commands/doc/list.ts:232`; lift
  target is `src/utils/numeric.ts` (or fold next to
  `DECIMAL_USER_ID_PATTERN`) at the 2nd numeric-flag
  consumer.
- **R-NEW-69 — `requiredJsonValueSchema` zod helper for
  required-but-any-JSON-shape slots** (1 consumer; LOW
  priority watch-item, code lift at 2nd module consumer).
  Surfaced at round-1 P2-2: bare `z.unknown()` accepts
  missing keys, silently weakening the contract pin.
  `z.unknown().refine((v) => v !== undefined)` at
  `src/api/documents.ts:124` covers `Document.settings` +
  `DocumentBlock.content`; lift target is
  `src/utils/parse-boundary.ts` at the 2nd module consumer
  (likely v0.5 doc-mutation `update_doc_block.content`).
- **R-NEW-70 — Comma-separated brand-list argv parser
  pattern** (2 consumers AT M32; MEDIUM priority watch-item,
  code lift at 3rd consumer per R7/R8 threshold). **Since
  shipped at v0.5-M34 pre-flight close (`17c1a54`)** —
  ahead-of-feat per R-NEW-29's M25 cadence; 4 consumers
  post-lift; lifted to `src/utils/parse-brand-list.ts:
  parseBrandedListArg`. See the post-v0.5-M34 R-class state
  block above for the full close-docs note + the
  parseUsersArg-stays-separate rationale. M32-snapshot
  pre-lift state: `parseUsersArg` at
  `src/commands/workspace/add-users.ts:144` (M14) +
  `parseWorkspaceListArg` at `src/commands/doc/list.ts:244`
  (M32) shared the outer split + trim + empty-entry +
  per-entry brand-validation outline; the per-call sites
  carried distinct error-context strings so a lift at M32
  would have over-fit. Lift fired at the 3rd consumer (v0.5
  team writers `team-create --users` + team-add-members +
  team-remove-members `--users` sites).
- **R-NEW-71 — Pagination-invariant `.superRefine` with
  dirty-input early-return guard** (1 consumer; LOW
  priority watch-item, code lift at 2nd consumer).
  Surfaced cumulatively at round-2 P2-1 (invariant check)
  + round-3 P2-1 (early-return guard). Pattern reusable
  across any paginated read envelope using the `has_more
  === (returned_count === limit)` heuristic; the
  dirty-input guard is the load-bearing detail (zod runs
  `.superRefine` even when scalar range checks have
  produced "dirty" issues). Today: 1 consumer
  (`docListOutputSchema` in `src/api/documents.ts:307`).

**Three new R-class candidates filed at M32 IMPL** (full
entries at v0.4-plan §22):

- **R-NEW-72 — Cross-doc grep AFTER every contract-flipping
  Codex fix-up (R-NEW-56 extension)** (1 supporting instance;
  LOW priority watch-item — process discipline, NOT a code
  lift). Surfaced at M32 IMPL round 2: the round-1 fix
  flipped the null-vs-empty contract but introduced two new
  prose-drift sites the kickoff grep couldn't have caught
  (it ran BEFORE the round-1 fix). Extension: run the
  cross-doc grep after EVERY Codex fix-up that flips a
  contract surface, not just at IMPL kickoff. Fires at 2nd
  supporting instance (one more "round-N fix introduces
  prose drift round-N+1 catches" cadence pins R-NEW-72 as
  a permanent CLAUDE.md "Workflow rules" addition).
- **R-NEW-73 — `assertNonNullArrayPayload` helper for
  fetcher response-parse boundaries** (3 consumers; LOW
  priority watch-item, code lift at 4th consumer with
  tractable signature). Pattern: `if (parsed.X === null)
  throw ApiError(code, msg, { details })` after schema-parse.
  Three consumers across `listWebhooks` M27 (null → not_found
  data-shape semantics) + `listDocuments` M32 + `getDocument`
  M32 (null → internal_error wire-regression semantics). The
  per-consumer divergence in error code + message + details
  shape is why the helper stays UNFILED at 3 consumers — a
  parametrised signature would carry 4-5 args + a message
  closure, likely exceeding the 6-7 lines it would replace.
  Fires at 4th consumer if the shape stays tractable;
  otherwise stays documented at v0.4-plan §22 entry.
- **R-NEW-74 — `kind: 'record'` for wrapped-paginated-
  record `emitSuccess` shape** (2 consumers; LOW priority
  watch-item, code lift at 3rd consumer + a table-UX
  complaint). The session prompt referenced `kind: 'record'`
  at M32 IMPL kickoff but `src/commands/emit.ts` only ships
  `kind: 'single' | 'collection'`; `'single'` is doing
  double-duty across `monday usage` (M22 wrapped record) +
  `monday doc list` (M32 wrapped paginated record). JSON
  output works correctly with `'single'`; table-rendering
  layout is where the conflation matters. Fires at 3rd
  consumer + an observed table-UX complaint (both M22 +
  M32 are agent-primary so the cost is hypothetical today).

**One new R-class candidate filed at post-M32 candidate-
selection session** (full entry at v0.4-plan §22):

- **R-NEW-75 — Candidate-selection session shape for
  post-feature-cluster milestone picking** (1 supporting
  instance; LOW priority watch-item — process discipline,
  NOT a code lift). Surfaced at the post-M32 IMPL
  candidate-selection session `169b2bc` — first explicit
  "scope each remaining backlog candidate + recommend"
  session in the repo (prior milestones' preceded-by
  sessions were either empirical probes or direct
  pre-flight kickoffs). Pinned the 5-dimension scoping
  framework (wire-shape novelty / transport seam /
  destructive gate / R-class triggers / Codex cadence)
  + the AskUserQuestion-driven single-round-trip approval
  cycle. Fires at 2nd consumer if a future "post-feature-
  cluster, multiple-candidates-remain" session uses the
  same framework verbatim — likely v0.5 kickoff against
  the 9-surface doc-CRUD-mutation backlog M32 D8 closure
  deferred. Graduates to a permanent CLAUDE.md "Workflow
  rules" addition if the 2nd consumer ratifies the
  5-dimension framework without drift.

**R-class state (post-M31 IMPL close — carried forward for
historical context):**

- **R-NEW-41 shipped** (3rd consumer trigger fired at M31
  pre-flight + ratified at M31 IMPL). Wire-vs-CLI semantics
  documentation pattern lifted as a new `docs/architecture.md`
  "Wire-vs-CLI semantics documentation conventions" section
  enumerating the three documented asymmetries (M27
  webhook.config + M27 NotificationTargetType + M31 multipart-
  vs-JSON transport). IMPL didn't surface a new asymmetry but
  ratified the section's utility — the per-module docstrings
  cross-link cleanly.
- **R-NEW-NEW shipped (M31-IMPL-surfaced):
  `sniffContentType` lift to `src/utils/mime.ts`** (R-class
  trigger crystallized at IMPL coverage check; 2-consumer
  lift ahead of the typical 3-consumer threshold). The
  duplicated 31-line MIME-extension switch in both upload
  command files would have left coverage at 95.32 branches
  (0.13pp below floor) because the integration tests only
  exercised the `'png'` row. Lift consolidated the helper +
  added 24 exhaustive unit tests + brought coverage back to
  96.25 branches. Mirrors R-NEW-29's M25 cadence (lift AHEAD
  of the feat commit when the trigger fires at IMPL kickoff).
  Carried into the IMPL feat commit `18c5386`. R-NEW-58
  ratified — lift-at-2 is justified when duplicated surface
  size makes branch-coverage from integration tests alone
  intractable.
- **R-v0.4-W2 (M31 pre-flight-surfaced)** — pre-pre-flight
  "new transport seam" interface-mirror checklist.
  **Fired its 1st IMPL-side validation at M31 IMPL** via
  round-1 P2-1 (file_too_large rewrap retry placement) — a
  NEW substantive runtime issue that the pre-flight checklist
  didn't cover (the rewrap-inside-retry-thunk pattern is
  unique to multipart upload — JSON fetchers don't have a
  "non-retryable rewrap of a retryable underlying" shape).
  Recommendation at v0.4-plan §13 lessons: extend R-v0.4-W2
  with a "non-retryable rewrap placement" axis (axis 7) ahead
  of the next "introduces NEW transport seam" milestone.
  Watch-item fires at 2nd consumer (likely v0.4.x / v0.5
  milestone introducing webhook delivery / OAuth refresh).
- **R-NEW-NEW (M31-IMPL-surfaced): `dispatchMultipart` shared
  helper for parallel-shape multipart fetchers** (1 consumer
  today). Both `addFileToColumn` + `addFileToUpdate` share an
  inline `dispatchMultipartOnce` helper PLUS an inline
  retry-thunk rewrap pattern (added at round-1 P2-1). The
  dispatch helper already lifted; the retry-thunk pattern stays
  inline because the fetcher-specific arguments differ per
  fetcher. Fires at 3rd consumer if a future v0.4.x verb (e.g.,
  webhook delivery with multipart payload) adopts the same
  shape; lift candidate is
  `dispatchMultipartWithSizeRewrap(inputs)`. Tracked at v0.4-plan
  §22.
- **R-NEW-NEW (M31-IMPL-surfaced):
  `ResolvedClient.multipart` slot mirror of `transport`** (1
  consumer today). Pattern (test injection via `ctx.{slot}`
  wins; production builds fresh via `create{X}Transport(...)`)
  mirrors the JSON `transport`. Fires at 2nd consumer if a
  future v0.4 verb introduces yet another transport shape
  (e.g., websocket / streaming) — at which point lift to a
  small protocol in `resolve-client.ts`. Today: 1 consumer
  (multipart), implemented inline.
- **R-NEW-56 (cross-doc grep at IMPL kickoff) ratified at M31
  IMPL** — 2nd-time validated discipline. M30 IMPL's 5-round
  prose-drift cadence forced the discipline; M31 IMPL's
  3-round convergence vindicated it (the kickoff grep
  enumerated ~25 prose sites that needed the "stub-shipped →
  runtime-body-shipped" flip; without the grep, prose drift
  would likely have fanned out across 4-5 Codex impl rounds).
  Carry forward to every subsequent IMPL session.
- **R-NEW-58 (lift-ahead-of-feat for R-class triggers)
  ratified at M31 IMPL** — the `sniffContentType` lift fired
  at the 2-consumer threshold (one consumer below the typical
  3-consumer trigger) because coverage at IMPL would otherwise
  have failed the floor.
- **R-NEW-43** (deferred-feature surface pattern) stays at
  1 consumer; M31 doesn't fit (asset upload is NOT a deferred
  feature gated on external registration).
- **R-NEW-31** (discriminated-union per-status detail schema)
  stays at 1 consumer; M31's three-value `details.reason`
  enum is a flat discriminator, not a per-status detail union.
- **R-NEW-20** (`MondayClient` seam-injection stub factory)
  stays at 4 consumers. M31 IMPL's `assets.test.ts` uses a
  stub `MultipartTransport`, NOT a stub `MondayClient` (the
  multipart fetchers `void inputs.client` — the JSON client
  is a pass-through slot the multipart wire bypasses).
  Fires at 5th consumer if a future verb extends
  `MondayClient`'s test seam.
- **R-NEW-44 / R-NEW-45 / R-NEW-46 / R-NEW-47 / R-NEW-48 /
  R-NEW-49 / R-NEW-50** all stay at their existing consumer
  counts (M31's runtime body doesn't exercise polling, retry
  timing, signal accessors, numeric comparators, deadlines,
  session counters, or epoch sentinels).

Per-milestone narrative + Codex round detail + lessons learned
live in `docs/v0.4-plan.md` §3 M32 entry + §9 M32 preconditions
+ §3 M31 entry + §13 M31 post-mortem + §22 R-v0.4-W2 entry. Do
not duplicate here.

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
- **Post-fix-up cross-doc grep after every contract-flipping
  Codex round** (R-NEW-72, v0.4-M33 IMPL graduation). When a Codex
  fix-up flips a contract surface (runtime predicate change,
  error-code semantic change, schema invariant change, contract-
  prose-bearing module rename), re-run the same R-NEW-56 cross-doc
  grep AFTER the fix-up commit lands. The round-1 fix can introduce
  NEW prose drift that the kickoff grep couldn't have seen (the
  kickoff grep ran against the pre-fix state); without the
  post-fix-up grep, the next Codex round catches the new drift
  and the prose precision fans out across an extra round. Two
  ratifying instances: M32 IMPL round 2 (where the discipline
  surfaced as a watch-item) + M33 pre-flight (where the cadence
  applied for the first time) + M33 IMPL (graduated). Sister rule
  to R-NEW-56: kickoff grep covers pre-flight → runtime transition
  prose; post-fix-up grep covers round-N fix → round-N+1 prose.

  **Cross-doc grep search paths** (R-v0.5-NEW-19 graduated at
  v0.5-M37 IMPL — 2nd supporting instance fired at round-2 P3-2;
  pre-flight surfacing event was round-3 P3-1). The post-fix-up
  cross-doc grep MUST search:
    - `src/api/*.ts` (fetcher headers + projection contracts).
    - `src/commands/**/*.ts` (verb-specific JSDoc).
    - **`src/commands/index.ts` (module-import block prose
      summarising milestone wire shape + D-closures — easy to miss
      because it lives outside the per-verb command file but
      carries contract-prose mirroring the verbs').**
    - `docs/*.md` (cli-design + plan docs + output-shapes).

  **Noun-stem matching for grep patterns** (carry-forward lesson
  from v0.5-M37 IMPL rounds 3-5). Use `\b<noun>\b` regex matching
  rather than literal-substring matching to catch all inflections
  in a single pass. M37 IMPL rounds 3-5 each surfaced new sibling-
  site drifts the prior round's grep missed because the pattern
  was too narrow: `pre-flight stub` literal missed `pre-flight
  ships`; `empty markdown` literal missed sibling schema/envelope
  JSDoc sites; `wire dispatch` literal missed
  `readUpdateBody`/`body-source.ts` in untouched-but-documenting-
  the-lifted-symbol module headers. Lesson: when running the post-
  fix-up grep, (a) extend the search paths per R-v0.5-NEW-19 above;
  (b) enumerate sibling-site noun-stems before grepping; (c) use
  regex word-boundary matching.
- **Candidate-selection session when ≥2 backlog candidates remain
  with non-obvious priority** (R-NEW-75, post-v0.4-M33 IMPL
  graduation). When a feature-cluster closes and 2+ candidates
  remain on the `cli-design.md §13 v<release>` backlog, run a
  dedicated pre-pre-flight session before any pre-flight contract
  diff: (1) confirm clean state (`git status` + `git log --oneline
  -12` + `npm test --reporter=dot 2>&1 | tail -4`); (2) read each
  remaining backlog entry; (3) scope each candidate against five
  dimensions — **wire-shape novelty** (does it need an empirical
  probe?), **transport seam** (does R-v0.4-W2 fire?), **destructive
  gate** (does it ship `--yes`-requiring verbs?), **R-class
  triggers** (does it crystallize a known 2-/3-consumer R-class
  candidate per R-NEW-58?), **Codex round estimate** (per the M22
  / M27 / M30 / M31 / M32 read-surface precedent — median 3 IMPL
  rounds); (4) recommend ONE candidate with **neutral trade-offs
  presented** — don't pick silently; (5) `AskUserQuestion` for the
  binding decision (single round-trip); (6) annotate `CLAUDE.md`
  "Next session" block + commit
  `docs(<m-n>-prep): annotate Next session block — M<N> = <candidate>`
  + push. Process-only candidates (release-prep, polish clusters)
  legitimately return zero across 4-5 axes — that IS the signal,
  not a sign the framework is wrong. Skip the dedicated session
  only when one candidate is obvious enough to inline in a regular
  pre-flight kickoff. Two ratifying instances: post-v0.4-M32 IMPL
  session `169b2bc` (surfaced) + post-v0.4-M33 IMPL session
  (graduated; release-prep picked over team writers).
- **Pre-flight stub action body — `parseArgv` BEFORE the c8
  ignore block** (R-NEW-76, v0.5-M34 pre-flight graduation).
  When shipping a pre-flight stub for a new verb, the action
  body MUST invoke `parseArgv` (+ any sibling parse-boundary
  helpers like `parseBrandedListArg`, `enforceDestructiveGate`,
  `parseGlobalFlags`) BEFORE the `c8 ignore start` block-wrap
  that contains the `internal_error` stub throw. Without this
  ordering, invalid argv would surface as `internal_error`
  (exit 2) from the c8-ignored stub throw instead of
  `usage_error` (exit 1) from the parse boundary — a contract
  violation that surfaces only at the first agent invocation
  of the stub. The pre-flight ARGV surface is the shipped
  agent contract; only the wire-call leg + envelope emit live
  behind the c8-ignore. Six ratifying instances ahead of
  graduation (M31a, M31b, M32a, M32b, M33, M34's six command
  stubs); the M31 pre-flight round-1 P2-2 surfacing event +
  the 6 forcing instances jointly pin the discipline.
- **Skip Codex review on mechanical / process-only / test-side
  housekeeping clusters with no production `src/**/*.ts`
  changes** (R-NEW-84, v0.5-M34 pre-flight graduation —
  negative-case validation). The Two-AI review rule above
  fires when a cluster moves production code surface or
  contract documentation. Test-only refactors that change zero
  contract surfaces (R-class lifts that touch only test sites,
  envelope-snapshot regens, version bumps + CHANGELOG, ToC
  audits) skip the Codex pass; gates (`npm run typecheck && npm
  run lint && npm test`) carry verification. The rule applies
  symmetrically: if a "test-only" cluster accidentally pulls
  in production code, Codex review applies. Four ratifying
  instances ahead of graduation (v0.3-M28 release-prep + v0.4
  release-prep + R-NEW-83 lift session + v0.5 kickoff probe
  session); the negative-case validation at the M34 pre-flight
  cluster (production code changed → Codex review applied →
  rule correctly did NOT fire the skip) confirms the rule's
  scope. Re-ratified at v0.5 release-prep cluster (5th
  supporting instance — zero production `src/**/*.ts` changes
  → Codex review skipped; gates alone verified).
- **Release-prep cross-doc grep for stale
  `deferred_to: '<currently-releasing-version>'` slots**
  (R-NEW-82, v0.5 release-prep graduation). Every release-prep
  cluster runs a cross-doc grep at the ToC-audit step for
  `deferred_to: "v<current>"` across `src/` + `docs/` + `tests/`
  to catch deferral slots that would tell agents reading the
  released envelope to "wait for the version they're already
  running" (e.g., v0.5.0 shipping `deferred_to: "v0.5"` is a
  contract bug). Each stale site gets ONE of three
  resolutions: (a) **slip** the slot to the next version
  (when the deferred feature has a clear forward home —
  Monday's data model still ungated, friendly translator still
  unrouted, etc.); (b) **drop the slot** (when the deferral
  was resolved during the released cycle — the feature
  shipped); (c) **drop the rejection altogether** (when the
  feature is no longer planned and the slot is dead code).
  Matching test pins + doc prose + module docstrings update
  in lockstep with the runtime slot. Three ratifying instances
  ahead of graduation (v0.3-M28 audit caught 2 sites at
  `f2600fa`; v0.4 release-prep caught 3 production sites + 5
  prose sites at `eb9e7a9`; v0.5 release-prep caught 4
  production + 5 test + 5 doc prose + 1 ToC user-row drift at
  `9129c67`). The ToC user-row drift is a sub-class — a
  prior-milestone close-docs gap where a verb cluster was
  added to `cli-design.md` §4.3 but not to `output-shapes.md`
  ToC; the release-prep ToC audit catches it. Pair with the
  envelope-snapshot refresh probe (Commit 1) + README
  quickstart refresh (Commit 3): release-prep is a 6-commit
  baseline (5 with diff + 1 probe) per the v0.4 release-prep
  cluster shape verbatim.
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
