---
paths:
  - "src/**/*.ts"
  - "tests/**/*.ts"
  - "docs/v*-plan.md"
  - "docs/cli-design.md"
  - "docs/output-shapes.md"
---

# Milestone workflow rules

Disciplines surfaced across v0.3–v0.6 milestones and graduated to
permanent rules. Full per-rule narrative + supporting-instance counts
live in the relevant plan-doc §22 R-class entries; this file carries
the rule + the trigger + the one-line "why".

## Pre-flight contract diff discipline

Every milestone whose pre-flight contract surface introduces new
modules / commands / ERROR_CODES / cli-design sections runs through:

1. **Empirical probe** for any novel API surface (scripts under
   `scripts/probe/`, reuse `_lib.ts`).
2. **Pre-flight contract diff commit** — module signatures (stub
   bodies under `c8 ignore`) + ERROR_CODES widening + cli-design
   extension + cross-doc count bumps + milestone decisions list.
3. **Codex pre-flight review** (1–2 rounds).
4. **Implementation commits** swap stubs for runtime bodies.
5. **Codex implementation review** (1–3 rounds typical).
6. **Close-docs sweep** — post-mortem in `v0.x-plan.md` §X +
   `§9` preconditions tick + `§22` R-class log + cli-design SHA
   backfills + `CLAUDE.md` status flip.

**Stub-literal naming + RESERVED-literal regression-guard.** When step
2's c8-ignored stub throws, give it an `internal_error` (or the
milestone's natural code) with a `details.reason: 'mNN_preflight_stub'`
literal — milestone-tagged so an integration test can pin the stubbed
surface verbatim (`expect(...).toMatchObject({ reason:
'mNN_preflight_stub' })`) at pre-flight. At step 4 the live body
replaces the throw and the literal disappears from runtime output. From
that point the literal stays **RESERVED across the codebase** — never
reused for a different rejection — and a regression-guard integration
test asserts it never reappears in emitted stdout/stderr
(`expect(out.stdout).not.toContain('mNN_preflight_stub')`). The same
RESERVED discipline applies to any milestone-specific `details.reason`
discriminator the pre-flight introduces (the v0.6/v0.7 file-`--set`
folds reserved `file_set_on_bulk_unsupported` /
`file_set_on_create_unsupported` / `multi_file_set_unsupported` this
way). Graduated v0.8-M47 IMPL after four instances (`m42`/`m43`/`m46`/
`m47_preflight_stub`).

**Rejection-lift / pure-refactor pre-flights need NO stub literal.**
When a pre-flight's IMPL session is a deletion (an existing rejection
is removed because it was incorrect) or a pure refactor (no new
deferred wire leg, no new rejection code) the stub-literal + PIN test
+ RESERVED-literal regression-guard scaffold from the preceding rule
does NOT apply. The trigger is structural: no new deferred wire leg
ships at pre-flight → no surface to pin → no stub needed. If the
pre-flight introduces a new runtime rejection that fires
unconditionally (not behind a c8-ignored stub), that rejection ships
LIVE at pre-flight; the IMPL flips other code, not the rejection.
Cross-refs the parseArgv-BEFORE-c8 ordering rule (R-NEW-76): when
pre-flight is rejection-lift, c8-ignore typically has no anchor at
all (the live runtime path is the entire implementation; the IMPL
session deletes a sibling, not unwraps a stub). Graduated v0.10-M53
IMPL close after 2 instances:

- **1st: v0.9-M50** multi-level subitem nesting (`e89ddfc`). A pure
  deletion — the inverted `parent.hierarchyType === 'multi_level'`
  rejection block at `item/create.ts` (~735-752) was the IMPL
  payload. No stub at pre-flight; no PIN test; no RESERVED-literal
  guard. The new shape is the EXISTING `create_subitem` dispatch
  shared between classic + multi-level boards.
- **2nd: v0.10-M53** `NOUN_DESCRIPTIONS` single-source-of-truth lift
  (`feb8805`). A pure refactor — IMPL drops the 3rd arg from 122
  `ensureSubcommand(program, '<noun>', '<desc>')` call sites. The
  `lookupNounDescription` rejection (`InternalError` with
  `details.reason: 'unknown_noun'` on a missing map entry) is a
  LIVE runtime invariant from pre-flight — it fires at registration
  walk on typo, not on a deferred wire leg.

R-v0.9-NEW-2 (graduated v0.10-M53 IMPL close, 2 instances M50 + M53).

## Pre-IMPL cross-doc grep for surface-extending milestones

When an IMPL session extends an existing helper/surface with a new
mode (a new flag, route, dispatcher), run a cross-doc grep at IMPL
kickoff: `grep -rn '<existing-symbol>' src/ docs/ tests/`. Enumerates
every site needing "selected dispatcher" / "both routes" framing.
Skipping fans prose drift across 4–5 Codex rounds (v0.4-M30 IMPL).
Pair with a scan for R-class 3-consumer triggers that crystallise at
IMPL kickoff (R-NEW-58) — lift those AHEAD of the feat commit.

R-NEW-56 (graduated v0.4-M32 IMPL).

## Post-fix-up cross-doc grep after every contract-flipping round

When a Codex fix-up flips a contract surface (runtime predicate
change, error-code semantic change, schema invariant change, contract-
prose-bearing rename), re-run the kickoff cross-doc grep AFTER the
fix-up commit. The round-1 fix introduces NEW drift the kickoff grep
couldn't see.

**Search paths:** `src/api/*.ts`, `src/commands/**/*.ts`,
`src/commands/index.ts` (module-import block — easy to miss),
`docs/*.md`.

**Noun-stem matching:** use `\b<noun>\b` regex word-boundary matching
rather than literal substrings. M37 IMPL rounds 3–5 each surfaced new
sibling drifts the prior round missed because the pattern was too
narrow. Enumerate inflections (`cassette` / `cassette pin` / `cassette
pinned`) before grepping.

R-NEW-72 (graduated v0.4-M33 IMPL); R-v0.5-NEW-19 (graduated v0.5-M37
IMPL, extended the search-paths list).

## Pre-flight stub action body — `parseArgv` BEFORE the `c8 ignore` block

Pre-flight stubs MUST invoke `parseArgv` (+ any sibling parse-boundary
helpers: `parseBrandedListArg`, `enforceDestructiveGate`,
`parseGlobalFlags`) BEFORE the `c8 ignore start` block-wrap that
contains the `internal_error` stub throw. Without this ordering,
invalid argv surfaces as `internal_error` (exit 2) instead of
`usage_error` (exit 1) — a contract violation visible from the first
agent invocation. The pre-flight ARGV surface IS the shipped contract;
only the wire-call leg + envelope emit live behind the c8-ignore.

R-NEW-76 (graduated v0.5-M34 pre-flight).

## Pre-IMPL contract-term checklist for cross-doc grep

When a milestone's IMPL touches contract-term prose across multiple
documentation layers (cli-design.md / output-shapes.md /
v0.x-plan.md / source docstrings / runtime user-facing strings /
test prose + assertions), the post-fix-up cross-doc grep
(R-NEW-72) must run against a **per-milestone term checklist**
defined at the pre-flight commit. Without the checklist, Codex
fix-up rounds escalate as each round's broader sweep catches a
new layer of adjacent prose that the prior round's narrower
regex missed.

**How to apply.**

1. At the pre-flight commit (or first IMPL commit), enumerate
   the full set of contract-term phrases the milestone's
   shipped surface uses. Examples from v0.7-M42:
     - State-current phrases that should appear post-IMPL:
       `v0.7-M42`, `bulk friendly`, `per-item fan-out`,
       `--continue-on-error`, `--concurrency`, `runItemUpdateBulkFileDispatch`,
       `BulkFileSetData`, `item_update_bulk_file_set`.
     - Pre-IMPL phrases that should NOT appear in current
       prose post-IMPL. Allowed contexts: (a) historical post-
       mortem entries (`docs/v0.{N-1}-plan.md` section bodies);
       (b) reserved-literal docstrings (the M42 helper docstring
       explicitly notes `'m42_preflight_stub'` / `'file_set_on_
       bulk_unsupported'` literals stay RESERVED); (c) regression-
       guard test assertions (`expect(...).not.toContain(...)`
       on the literal). All OTHER occurrences are drift bugs. The
       v0.7-M42 checklist:
       `m42_preflight_stub`, `file_set_on_bulk_unsupported`,
       `pre-flight stub`, `c8-ignored stub`, `lifts at M42 IMPL`,
       `single-item only` / `single-item shape only` /
       `single-item path only`, `two write paths` / `BOTH write
       paths` / `two paths reach` / `both M38 + M31` /
       `M38 + M31 only`, `defer to v0.6.x` / `defers to v0.6.x` /
       `v0.6.x candidate-selection`, `bulk + create reject` /
       `bulk + create defer` / `bulk + create paths`,
       `M38 bulk` / `M38 ships bulk` (M38 only shipped single-
       item — bulk is v0.7-M42), `form ships at M38` /
       `friendly form ships at M38` (incomplete — should name
       both shipping milestones), `bulk file dispatch rejects per D5`
       / `bulk file --set rejects` (was true at v0.6-M38; post-
       v0.7-M42 IMPL is false).
2. After every Codex fix-up round, grep ALL "should not appear"
   terms across `src/`, `docs/`, `tests/`. Each hit in a non-
   historical context is a contract-term drift bug; fix before
   the next Codex round.
3. The pre-IMPL checklist replaces the round-N-specific term
   discovery — instead of waiting for Codex to enumerate the
   stale terms one round at a time (the historical pattern that
   escalates 3-5 rounds), the IMPL author commits to the full
   set upfront.

**Threshold rule for graduating the checklist into a milestone's
post-mortem.** A milestone with 3+ Codex W9-only rounds (prose
drift dominating the fix-up cadence) should file a per-milestone
contract-term checklist at close-docs naming the load-bearing
phrases that ended up needing flips. The next milestone touching
the same surface inherits the checklist + extends it.

R-v0.7-NEW-4 (graduated v0.7-M42 IMPL — surfaced across 7 Codex
rounds of escalating W9 prose drift; each round's sweep widened
to catch what the prior round's narrower regex missed).

## Read-side field-add — check whether the named command's schema is SHARED

When a milestone plans to add an output field to a "single named
command" (e.g. "add `X` to `board get`", "add `Y` to `item list`"),
the pre-flight MUST verify whether that command's output schema is
**single-sourced** (only that one verb uses it) or **shared** (the
same schema feeds N other verbs through a projection helper). The
plan's command list can under-state the true surface.

**Why the check is binding:** the M15 board-cluster's canonical-shape
invariant single-sources `boardProjectionSchema` across `board get` +
the create/update/archive/delete/duplicate cluster (6 verbs). A
field-add scoped to "just `board get`" actually ripples to all 6;
choosing not to ripple breaks the invariant. The runtime read pins
the right scope; the plan prose doesn't.

**How to apply.** At every pre-flight that adds an output-schema
field to a named verb:

1. `grep -rn '<schema-name>' src/api/ src/commands/` to count
   consumers (the `outputSchema` aliases + any direct `parse`
   callsites).
2. If `count > 1`, escalate the scope decision to the user via
   `AskUserQuestion` — DO NOT silently scope to the named verb. The
   choice is binding (a new shape on a shared schema is a contract-
   surface change across N verbs; a private copy fragments the
   invariant).
3. Document the chosen scope in the §3 D-list, citing the schema-
   sharing fact + the runtime-read that established it.

**Two valid scope choices** (the second M52 instance proved both
exist):

- **Extend the shared schema** (M51, `hierarchy_type` →
  `boardProjectionSchema`): widens the canonical Board shape across
  the 6 verbs deliberately. Use when the new field is lightweight
  + agent-useful on every verb's output.
- **Add to a heavy single-sourced schema** (M52, `views` →
  `boardMetadataSchema`): the lightweight shared schema stays
  untouched; the new field lives on the heavy read (`board describe`)
  + a dedicated lightweight verb (`board views`). Use when the
  new field is heavy/nested + would bloat verbs that don't need it.

R-v0.9-NEW-7 (graduated v0.9-M52 close-docs after 2 instances —
M51 chose the shared schema; M52 chose the heavy single-sourced
one; both correct per the runtime read).

## Skip Codex review on mechanical / process-only clusters

Clusters with zero production `src/**/*.ts` changes (R-class lifts
touching only test sites, envelope-snapshot regens, version bumps +
CHANGELOG, ToC audits) skip the Codex pass; gates (`npm run typecheck
&& npm run lint && npm test`) carry verification. The rule applies
symmetrically — if a "test-only" cluster pulls in production code,
Codex review applies.

R-NEW-84 (graduated v0.5-M34 pre-flight).

## Release-prep cross-doc grep for stale `deferred_to` slots

Every release-prep cluster runs a cross-doc grep at the ToC-audit
step for `deferred_to: "v<current>"` across `src/` + `docs/` +
`tests/` — catches deferral slots that would tell agents reading the
released envelope to "wait for the version they're already running".
Each stale site gets one of: **slip** to next version, **drop the
slot** (feature shipped), or **drop the rejection** (no longer
planned). Matching test pins + doc prose + module docstrings update
in lockstep.

Release-prep is a 6-commit baseline: envelope-snapshot refresh probe
+ ToC audit + deferral slip + README quickstart refresh + version
bump + CHANGELOG + close-docs sweep.

R-NEW-82 (graduated v0.5 release-prep).

## Post-publish flip commit pattern

After `npm publish` lands the release, write ONE small commit that
flips status forward + retires the placeholders the close-docs
commit couldn't fill itself. The close-docs commit can't reference
its own SHA, so it leaves `<close-docs>` placeholders that the
post-publish commit backfills once `git rev-parse HEAD` is stable.

The shape (4 steps, single commit):

1. **Flip CLAUDE.md "Status" → "Published".** Replace the
   "release-prep SHIPPED — ready for publish, EXTERNALLY BLOCKED"
   sentence with "Published: `monday-cli@<version>` on npm
   (`latest` dist-tag, `<timestamp>`). **v<version> published —
   release complete.**" Quote the actual `npm view monday-cli
   time.<version>` timestamp — don't paraphrase or round. Cite
   the annotated tag + the GitHub release URL.
2. **Backfill `<close-docs>` / `<close-docs-sha>` placeholders →
   the close-docs commit SHA.** `rg '<close-docs' CLAUDE.md
   docs/v<version>-plan.md` must return 0 hits after the edits.
3. **Tick §7's pending-publish checklist line** in the plan-doc
   (`- [ ]` → `- [x]`) with the npm timestamp + tag SHA in the
   body; add a "Post-publish flip applied <date>" note to §3's
   release-prep close subsection with the full publish timeline.
4. **Drop the publish-coordination prefix from "Next session".**
   The pointer in CLAUDE.md goes straight to v<version>.x /
   v<version+1> candidate-selection per R-NEW-75 (or whatever
   the actual next-work pointer is for that cycle).

**Skip Codex review** — post-publish flip is mechanical/docs-only;
R-NEW-84 applies; gates (`typecheck && lint && test`) carry
verification. Commit subject mirrors prior cycles:
`docs(v<version>-post-publish): flip status → release complete +
backfill SHAs`.

R-v0.9-NEW-13 (graduated v0.10 post-publish — 3rd consecutive
clean-shape instance formalising the pattern: v0.8 `3f30891`
established the shape; v0.9 `ea8f34e` confirmed stability; v0.10's
post-publish flip met the graduation threshold. v0.7 `d4ca55e`
was a combined audit + flip, not the clean 4-step shape this rule
formalises). Cross-refs R-NEW-82 (the parent release-prep
discipline) + R-NEW-84 (the mechanical/process-only Codex-skip
carve-out that applies here too).

## Candidate-selection session when ≥2 backlog candidates remain

When a feature-cluster closes and 2+ candidates remain on the
`cli-design.md §13 v<release>` backlog, run a dedicated pre-pre-flight
session before any pre-flight contract diff:

1. Confirm clean state (`git status`, `git log --oneline -12`,
   `npm test --reporter=dot 2>&1 | tail -4`).
2. Read each remaining backlog entry.
3. Scope each candidate against five dimensions:
   - **wire-shape novelty** (needs an empirical probe?)
   - **transport seam** (new fetch/multipart/streaming shape?)
   - **destructive gate** (ships `--yes`-requiring verbs?)
   - **R-class triggers** (crystallises a known 2-/3-consumer
     candidate per R-NEW-58?)
   - **Codex round estimate** (median 3 IMPL rounds; outliers up
     to 6 for opaque-JSON / custom-OBJECT shapes).
4. Recommend ONE candidate with **neutral trade-offs presented** —
   don't pick silently.
5. `AskUserQuestion` for the binding decision (single round-trip).
6. Annotate `CLAUDE.md` "Next session" block + commit.

Process-only candidates (release-prep, polish clusters) legitimately
return zero across 4–5 axes — that IS the signal, not framework drift.
Skip the dedicated session only when one candidate is obvious enough
to inline in a regular pre-flight kickoff.

R-NEW-75 (graduated v0.4-M33 post-IMPL).

## Two-AI review for non-trivial design + per-milestone IMPL

Codex (gpt-5.5) via:
```bash
codex exec -m gpt-5.5 -s read-only - < .review-prompt.md > .review-output.md
```
(`.review-*.md` is gitignored.) Two triggers:

- Design changes to `docs/cli-design.md` or `docs/v0.x-plan.md` →
  reviewed before merge.
- Implementation milestones → reviewed before declaring done.

The M0 review caught 10 bugs (token leak, broken SIGINT, schema/
commander drift); skipping costs more than the Codex run. Codex
template at `.claude/templates/codex-pre-flight-review.md` ships
W1 (redactor), W2 (operationName parity) audit-points + the
"deliver findings up front" preamble. Ask before adding new AI
collaborators.

## Commits

- **Atomic, incremental.** One self-contained unit per commit. Small
  enough to revert cleanly, large enough to stand alone. Never commit
  broken `main`.
- **Messages explain WHY and HOW, not WHAT.** Diff shows what. Spend
  the message on motivation and approach. Bare conventional-commit
  subject is fine when no meaningful why/how — short beats padded.
- **Conventional Commits + SemVer.** `feat:` / `fix:` / `docs:` /
  `refactor:` / `test:` / `chore:`. Major bump for breaking output/
  exit-code changes; minor for new commands; patch for fixes.
- **CI gates everything** on Node 22 + 24 (`.github/workflows/ci.yml`).
  Don't merge red.
