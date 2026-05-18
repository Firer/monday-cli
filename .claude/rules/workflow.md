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
