# Codex pre-flight review prompt template

This template captures the 7-section structure that every Codex
pre-flight review prompt has used across `monday-cli`'s
v0.3-M21 / v0.3-M22 / v0.3-M23 pre-flight cycles (6+ rounds
total). The pattern is ratified by `docs/v0.3-plan.md` §22 R-NEW-6
(**Shipped:** post-M23 pre-flight round 1).

## How to use

1. **Copy** this file to `.review-prompt.md` at the repo root
   (`.review-*.md` is gitignored per `.gitignore` line 49).
2. **Fill in** the milestone-specific sections marked
   `{{...}}` — see "Sections" below for which are
   template-stable vs milestone-specific.
3. **Run** `codex exec -m gpt-5.5 -s read-only - < .review-prompt.md
   > .review-output.md`.
4. **Apply findings inline.** P1 → block any feat commit until
   resolved; P2 → apply before next round; P3 → apply if scope
   allows, else log to §22 watch-items.
5. **Iterate to round-2 (and round-3 if needed)** by re-using
   this template with Section 2 filled in from the round-1
   findings + per-finding fix description.

## Sections

The structure has seven sections; four are template-stable
(reusable verbatim across milestones), three are
milestone-specific (re-fill each round / each milestone).

  1. **Header** — *template-stable*. Format:
     `# Codex pre-flight review — vX.Y-MNN contract diff [ROUND N]`
  2. **Round-N findings + how they were addressed** —
     *round-specific*. Round 1: omit; round 2+: list every
     prior-round P1/P2/P3 with per-finding "fix applied at
     `<sha>`" or "fix applied inline at this prompt" cite.
  3. **Scope of review** — *milestone-specific shell, stable
     headings*. List the commit SHA(s) being reviewed, file
     list with NEW / MODIFIED tags, test count delta, coverage
     at gate.
  4. **Empirical-probe findings the diff is built against** —
     *milestone-specific*. Verbatim probe findings with date +
     API version + load-bearing-finding flag. Only included
     when novel API surface was probed (§22 R-watch-item
     "empirical-probe step in pre-flight" — fires at M21, M22,
     M23; expected to fire at M24+ if the milestone touches
     novel Monday surfaces).
  5. **Audit points** — *milestone-specific count, stable
     numbering scheme*. Pre-enumerated watch-items per the M22
     post-mortem lesson — 5-10 numbered W{N} items specific to
     the milestone. Round 2+: re-numbered as W{N}' to flag
     round-over-round repetition.
  6. **Things explicitly OUT of scope for this review** —
     *template-stable*. Standard exclusions:
       - Existing modules NOT touched by this diff.
       - Future-milestone surfaces.
       - Probe scripts (gitignored / disposable).
       - The line-by-line implementation of stub bodies
         (those land at milestone implementation and get
         their own review pass).
  7. **Output format** — *template-stable*. Standard shape:

         **P{1|2|3}-{N}** ({W-number} or "out-of-band"):
         {problem statement}.
         - File: `path:line` (or "doc/cli-design.md §X").
         - Issue: {what's wrong + why it matters}.
         - Fix: {what to change}.

       Group by priority (P1 first). End with one-sentence
       overall verdict. Note unaddressed watch-items
       explicitly: "W{N}: nothing flagged."

## When to use this template

- **Pre-flight contract diffs** for new milestone surfaces
  (`docs(mNN)`-prefixed commits per CLAUDE.md workflow rules).
- **Implementation reviews** post-feat commits at milestone
  close — the same 7-section shape works (section 2 carries
  the prior pre-flight + implementation rounds).
- **Cli-design extension PRs** that close a single §8 Decision
  with empirically-pinned shape — usually 1 round, may skip
  sections 4 + 5 if the decision is small.

## When NOT to use this template

- **Trivial single-paragraph cli-design amendments** that
  don't open a contract surface (Codex's review-quality
  drops when the diff is too small; the per-call cost isn't
  worth it).
- **Test-only refactor PRs** that don't move a contract
  shape (R-class lifts that change zero contract surfaces —
  the gate for those is `npm run typecheck && npm run lint
  && npm test`).

## History

- **Sites (6+):** M21 round 1 / M21 round 2 / M22 round 1 /
  M22 round 2 / M22 round 3, plus M23 round 1 / M23 round 2
  (this template's extraction trigger).
- **Shipped at:** post-M23 pre-flight round 1 — three
  confirming repetitions (M21+M22+M23) cleared the §22
  R-class 3-consumer trigger.
- **Template-stable section weighting:** sections 1, 6, 7
  almost never change across rounds; section 5 grows
  watch-items per-milestone but the numbering scheme is
  stable; sections 2, 3, 4 are entirely milestone-specific.
- **Risk:** low — template is documentation; a regression in
  the template surfaces at the next pre-flight when Codex's
  review quality drops vs the baseline.

## Notes from past rounds

- **Section 5 (audit points) is load-bearing.** The M22 post-
  mortem identified that pre-enumerated watch-items catch
  P1/P2 findings the reviewer would otherwise miss — 1 P1 +
  4 P2 in M22 round 1, 2 P1 + 3 P2 in M23 round 1. Don't
  skip this section; investing 15-20 minutes pre-enumerating
  watch-items saves 1-2 review rounds.
- **Section 4 (empirical probes) is load-bearing for novel
  surfaces.** Every milestone touching a Monday API surface
  not previously covered runs the probe matrix first per the
  §22 R-watch-item. Pinning load-bearing findings in section 4
  lets Codex verify the contract-shape against the wire-shape
  inline rather than re-deriving the wire shape.
- **Section 2 is the round-over-round continuity slot.**
  Without it, round-2 Codex doesn't know what round-1 said
  was fixed; it'll re-flag the same issues. Always cite
  the fix-commit SHA so Codex can verify the fix landed.
