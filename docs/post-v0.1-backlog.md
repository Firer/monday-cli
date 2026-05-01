# Post-v0.1 backlog

> A parking lot for features and doc gaps that surfaced during v0.1
> implementation but **don't have a slot in cli-design.md's v0.x
> phasing yet**. Not contract material; not commitments. The job of
> this file is to make sure no surfaced idea is lost between the
> close of one milestone and the cli-design backfill PR that picks
> a real version slot for it.
>
> Two flavours of entry:
> - **Surface candidates** — verbs / flags / shapes the contract
>   could grow. Each carries a *suggested* v0.x slot (negotiable);
>   the real decision happens when these get reviewed for the
>   cli-design backfill PR.
> - **Doc-only gaps** — places cli-design.md is fuzzy or silent in
>   ways that don't change the binary's behavior, just an agent's
>   ability to plan around it.
>
> When an entry lands in cli-design.md (with a real v0.x line or a
> §13 explicit-deferral entry), strike it from this file in the
> same commit. Items can also age out as "won't ship" — moved to
> the *Permanent non-goals candidates* section below pending a
> formal §13.5 entry.

## Surface candidates (no v0.x slot yet)

### Read-side symmetry

- ~~**`monday update list --board <bid>`** — board-wide updates list
  (all comments across all items on the board). Today
  `update list <iid>` is per-item only. Agent use case: "what was
  discussed on this board today?" *Suggested slot: v0.2.*~~ → now in
  cli-design §13 v0.2 + §4.3 `update list --board <bid>` entry.

- ~~**`monday update list <iid> --with-replies`** — comment-thread
  expansion. Today only top-level updates surface; replies are a
  separate Monday query. Pairs naturally with `update reply`
  (already v0.2). *Suggested slot: v0.2.*~~ → now in cli-design §13
  v0.2 + §4.3 `update list <iid>` `--with-replies` comment.

- ~~**NDJSON streaming on `item search` / `update list`** — today
  only `item list` (v0.1) and `item watch` (v0.4) stream. Long
  searches and large comment lists could benefit from incremental
  output. *Suggested slot: v0.2 alongside the above.*~~ → now in
  cli-design §13 v0.2 + §5.6 ndjson surface note.

- ~~**Cross-board `item search`** (omit `--board`, scan every
  visible board). Currently `--board` is required. Agent use case:
  "find my open tasks anywhere I have access". *Suggested slot:
  v0.2 / v0.3 — needs a complexity-budget design pass; could be
  expensive on large accounts.*~~ → now in cli-design §13 v0.3 +
  §4.3 `item search` comment.

- ~~**`monday item history <iid>`** — Monday's per-item activity
  log (status changes + comments + assignments interleaved
  chronologically). cli-design.md:803 mentions "activity log"
  only as a `restore`-deprecation argument; no read verb.
  *Suggested slot: v0.3.*~~ → now in cli-design §13 v0.3 + §4.3
  `item history <iid>` entry.

- ~~**`monday board favorites`** — list the current user's starred
  boards. Monday surfaces this concept; agent use case: "orient
  on what the user actively works with, skip rarely-touched
  boards". *Suggested slot: v0.3.*~~ → now in cli-design §13 v0.3 +
  §4.3 `board favorites` entry.

### Bulk operation symmetry

- ~~**`monday item clear --where ... <col> --yes`** — bulk clear
  symmetric with `item update --where`. Currently
  `monday item update --where ... --set X=` is rejected by the
  translator (empty values aren't valid set inputs); the dedicated
  verb is the right contract surface. *Suggested slot: v0.2.*~~ →
  now in cli-design §13 v0.2 + §4.3 `item clear --board ...
  --where` entry.

- ~~**`monday item update --continue-on-error`** — partial-progress
  bulk recovery. Today bulk `item update --where` fails fast on
  the first error; mutated items before the failure surface in
  `details.applied_to`. cli-design.md §9.2 explicitly rejects
  rollback. A `--continue-on-error` flag would attempt every
  matched item regardless and emit a partial-success envelope
  with per-item status. *Suggested slot: v0.2 / v0.3.*~~ → now in
  cli-design §13 v0.3 + §4.3 `item update --where` comment.

### Diagnostics

- ~~**`monday status`** — connectivity + auth probe. Today the
  closest is `monday account whoami`, which is a real GraphQL
  query against `me { id }`. A dedicated probe could short-circuit
  on auth/network without touching account state. *Suggested
  slot: v0.3 (low value alone; bundles well with other diagnostic
  verbs).*~~ → now in cli-design §13 v0.3 + §4.3 `monday status`
  entry under new DIAGNOSTICS section.

- ~~**`monday usage` / `quota`** — current account's daily API
  budget remaining. Today `account complexity` is a per-query
  spot probe; nothing tracks the rolling daily total. Agent use
  case: "should I throttle myself before this 500-item bulk?"
  *Suggested slot: v0.3.*~~ → now in cli-design §13 v0.3 + §4.3
  `monday usage` entry under DIAGNOSTICS section. Naming chosen
  as `usage` (descriptive — "what have I used") over `quota`
  ("hard cap") since Monday's budget is a soft rolling window.

## Doc-only gaps (no behavior change, just clearer contract)

- ~~**Writer-expansion roadmap table.** cli-design.md:1625 lists
  *"Broad column-type write support (allowlist grows in v0.2+)"*
  as a single line. A per-type table mapping each Monday column
  type to its target v0.x would help agents know what's coming
  when.~~ → now in cli-design §5.3 "Writer-expansion roadmap"
  sub-section, with a "tentative" caveat on `tags` /
  `board_relation` / `dependency` (may slip v0.2→v0.3 after
  fixture work) and a "read-only forever" row for
  Monday-computed types. §13 v0.1-deferral list now points at
  the table instead of the prior single-line bullet.

## Permanent non-goals candidates

cli-design.md §13.5 currently lists only: hosting webhooks,
app frameworks, real-time subscriptions, telemetry / update-
notifier / analytics. These additions plug visible gaps an agent
might otherwise expect:

- **Forms** — Monday's public-submission forms feature.
  Different product surface; out of CLI scope.
- **Saved queries / aliases** (`monday alias save my-tasks
  "..."`). Violates the CLI's stateless principle (every
  invocation reads from env/argv only; no persistent state
  beyond the cache, which is a derived read).
- **`monday undo`** — replay-based reversal of recent
  mutations. Requires a local mutation log; conflicts with the
  stateless principle and with Monday's authoritative state
  model (the user can also undo via the UI).
- **Activity logs / audit trail** as a top-level read verb.
  *(Tension with `item history` above — `item history` is a
  per-item view of the same underlying data; the org-wide audit
  log is admin-flavored and probably belongs to the
  webhook/notification surface, which is itself v0.3.)* Move
  here only if v0.3 review concludes it's not worth shipping.

## How to use this file

- **When a new feature gets noticed during a session**, add it
  here in the appropriate section. Lead with the verb / flag,
  one-paragraph rationale, suggested slot.
- **When a feature gets a real v0.x line in cli-design.md**,
  strike it here in the same commit (don't leave a stub).
- **When a feature gets explicitly deferred to "won't ship"**,
  move it to the candidates section, then on cli-design.md §13.5
  review move it from here to there.
- **Don't pin behavior in this file**. Anything that would
  constrain implementation (operator allowlists, envelope shapes,
  exit codes) belongs in cli-design.md, not here.
