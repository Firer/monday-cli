# Changelog

All notable changes to `monday-cli` are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning
follows [SemVer](https://semver.org/spec/v2.0.0.html). The CLI's
output envelope (`{ ok, data, meta, ... }`) and 29 stable error
codes are part of the public contract — the SemVer rules in
[`docs/cli-design.md`](./docs/cli-design.md) §6 govern bumps.

## [0.5.0] - 2026-05-17 — Team writers + full Monday workdocs CRUD mutation surface

The "agents can write to teams + drive the full workdocs surface"
milestone — v0.4's read-only workdocs + asset-upload foundation
gains the six team-writer verbs deferred at the post-v0.4-M33
candidate-selection session and the full Monday workdocs CRUD
mutation surface deferred at v0.4-M32 D8 closure (10 new doc-
namespace verbs across doc-level + doc-block + doc-content-import
clusters). **16 new CLI verbs across 9 wire mutations.** **No
breaking changes vs `0.4.0` — every v0.5 surface is additive.**
Built incrementally across M34–M37.

### Breaking changes vs `0.4.0`

**None.** Every command, error code, envelope key, and warning
shape shipped in v0.4.0 is preserved byte-for-byte. v0.5 only adds.

### Surface

**~117 commands shipped (was ~101 in v0.4).** 16 new verbs.
The new noun namespaces are extensions of existing ones — no new
top-level noun lands at v0.5 (team writers extend `monday user`;
doc-level + doc-block + doc-content-import extend `monday doc`).

**Team writers (M34) — `monday user team-list/get/create/delete/
add-members/remove-members`.** Six new verbs closing the v0.4-M33
candidate-selection deferral. The two read verbs (`team-list` /
`team-get`) project Monday's `Team` shape (`id`, `name`, `picture_url`,
`users[]`, `owners[]`). The four mutations:

- `team-create --name <n> [--users <id>,...] [--guest-team]
  [--allow-empty] [--dry-run]` — backed by `create_team`.
  `--users` resolves to Monday `UserId` list at the parse boundary
  via the new lifted `parseBrandedListArg<T>(raw, brandSchema,
  options)` helper (R-NEW-70 shipped ahead-of-feat at M34
  pre-flight — 4 consumers post-lift).
- `team-delete <tid> --yes [--dry-run]` — backed by `delete_team`.
  The destructive verb in the cluster; `--yes` gate fires BEFORE
  `resolveClient` per the M10 round-1 P2 invariant.
- `team-add-members <tid> --users <id>,... [--dry-run]` +
  `team-remove-members <tid> --users <id>,...` — backed by
  `change_team_memberships`. Monday's mutation returns
  `failed_users` + `successful_users` lists (asymmetric — failed
  users carry a User object but no per-user failure reason, so
  the CLI surfaces a generic `membership_failed` message per
  failed record). The new shared `_team-membership.ts:
  projectMembershipResults` helper projects to the universal
  §6.1 `data.results: [{user_id, ok, ...}]` shape with input-
  order preserved + failed-bucket-priority discipline + an
  `internal_error` surface for input users that land in neither
  bucket (wire-shape regression defensive). Lifted at IMPL
  kickoff as a 2-consumer inline lift mirroring M26b's
  `_shared.ts:requireDevBoard` cadence.

`team-list` ships flat (Monday's `teams(...)` has no pagination
on the wire); the two-read-without-pagination shape mirrors
`monday user list`. The four mutations all surface `--dry-run`
for planned-change envelopes.

**Doc-level CRUD (M35) — `monday doc create-in-workspace/
create-on-column/rename/delete/duplicate`.** Five verbs, four
wire mutations (both create variants share `create_doc` per D7's
mutually-exclusive `board` vs `workspace` split):

- `create-in-workspace --workspace <wid> --name <n> [--folder
  <fid>] [--kind public|private|share]` — creates a workspace-
  level doc. Brand: new `DocFolderIdSchema` joins
  `src/types/ids.ts` as the 11th numeric brand.
- `create-on-column --item <iid> --column <cid>` — creates a
  column-level doc against an existing file-shaped column.
- `rename <did> --name <n>` — `update_doc_name`.
- `delete <did> --yes [--dry-run]` — `delete_doc`. Destructive
  gate fires BEFORE `resolveClient` per the M10 invariant.
- `duplicate <did> [--with-updates] [--dry-run]` — `duplicate_doc`
  (D8 closure dropped `--name <n>` because the wire side has no
  rename slot on duplicate). `--with-updates` copies the source
  doc's comments to the duplicate; new `extractDuplicateDocId`
  helper defensively unwraps the opaque-JSON new-doc-id across
  bare-string / number / record-with-`id` / `doc_id` /
  `new_doc_id` shapes per D9 closure (Monday's `duplicate_doc`
  returns a flat `{ doc_id, success: true }` projection with
  `success` pinned literal-`true` because failure surfaces via
  GraphQL `errors[]` upstream, NOT via a wire-side success flag).
  `--dry-run` previews the planned change envelope without firing
  the wire.

D7 / D8 / D9 closures pinned at pre-flight: D7 two CLI verbs over
one with placement choosers (mirrors v0.4-M31's `monday item
upload` / `monday update upload` split for the same multipart
wire path). D8 drops `--name <n>` from duplicate. D9 opaque-JSON
returns project to flat `{ doc_id, success: true }` per §6.1
single-record envelope.

**Doc-block CRUD (M36) — `monday doc block-create/block-update/
block-delete`.** Three verbs / three wire mutations. `--type
<DocBlockContentType>` takes one of 16 enum values (`normal_text`
/ `large_title` / `medium_title` / `small_title` / `quote` /
`bulleted_list` / `numbered_list` / `check_list` / `code` /
`divider` / `image` / `video` / `file` / `table` / `layout` /
`column`) per D10 closure (unknown values reject at the parse
boundary with `usage_error.details.issues[]` carrying `{path:
'type', message}`). `--content <json>` parses via the M27-lifted
`parseJsonArg` helper (4th + 5th consumers of the helper).
`block-create` accepts optional `--after <bid>` / `--parent <bid>`
positioning slots; `block-update` updates the named block's
content payload; `block-delete --yes` deletes the named block.
Per-type content payload shapes documented in `docs/output-
shapes.md` "Per-block content shapes" reference table — 7
cassette-pinned variants + 9 TBD / inferred variants awaiting
follow-up cassettes per D11 closure (per-variant payload-shape
deferral to IMPL cassettes — R-v0.5-NEW-15 watch-item supporting
instance 2 of 3 ahead of graduation).

`DocBlockIdSchema` brand uses `slugIdSchema` (non-empty-string
base; same shape as `ColumnId` / `GroupId`) because Monday's
`DocumentBlock.id` is wire `String!`, NOT `ID!` — load-bearing
distinction from `DocId`'s numeric brand. Snake_case wire arg
names (`doc_id` / `block_id` / `after_block_id` / `parent_block_id`)
— Monday's standard cadence, not a new R-NEW-41 supporting site.

**Doc-content import (M37) — `monday doc import-html/append-
markdown`.** Two verbs / two wire mutations. Bulk doc-content
import in a single wire round-trip (no per-block loop):

- `import-html --workspace <wid> (--html <file|-> | --html-string
  <s>) [--folder <fid>] [--kind public|private|share] [--title
  <t>]` — creates a new doc from an HTML payload.
- `append-markdown <did> (--markdown <file|-> | --markdown-string
  <s>) [--after <bid>]` — appends blocks to an existing doc from
  a markdown payload.

Both surface mutex argv sources (file / stdin / inline string)
backed by the new generic `readSourceContent` helper at
`src/utils/source-content.ts` (R-v0.5-NEW-18 lifted ahead-of-
feat at M37 IMPL — widens M13's `readUpdateBody` to parameterise
on `inlineFlagName` / `fileFlagName` / `verbHint?` / `maxBytes?` /
`trimTrailingWhitespace?`; 5 consumers post-lift: 3 M13 update
verbs + 2 M37 doc verbs). 20 unit tests pin the helper's branch
matrix.

D12 closure pins the custom-OBJECT projection (5 branches):
success → flat envelope; `success: false + populated error` →
`validation_failed`; `success: false + empty/null error` →
`internal_error` (wire-regression hint); `success: true +
missing payload` → `internal_error` (probe descriptions promise
non-null); EMPTY `block_ids: []` on success → success WITH empty
array. D13 empirical-probe ran at M37 pre-flight kickoff
(`scripts/probe/v0.5-m37-size-limits.ts`, 2026-05-17, API
`2026-01`) + pinned the wire-side rejection threshold between
250KB-OK and 500KB-rejected on both surfaces — rejection shape
is generic `INTERNAL_SERVER_ERROR` (NOT the documented
`{success: false, error}` envelope path), so the CLI pre-empts
at parse boundary via `MAX_DOC_IMPORT_PAYLOAD_BYTES = 256_000`
on the `.refine()` for inline `--html-string` / `--markdown-
string`.

### Output contract additions

**No new stable error codes — registry stays at 29.** Every v0.5
milestone closed the new-error-code question NEGATIVE: M34
team mutations route per-user partial-success failures through
the generic `membership_failed` message (envelope-level per-record
discriminator, not a top-level code); M35 / M36 / M37 route
deletes through the existing `not_found`, validation failures
through the existing `validation_failed`, wire-shape regressions
through the existing `internal_error`, and parse-boundary
rejections through the existing `usage_error`.

**New per-record partial-success projection** (M34 —
`team-add-members` + `team-remove-members`). The
`change_team_memberships` wire mutation returns asymmetric
`failed_users` + `successful_users` lists; the shared
`_team-membership.ts:projectMembershipResults` helper projects
to the universal §6.1 `data.results: [{user_id, ok, ...}]`
shape with input-order preserved + failed-bucket-priority
discipline + an `internal_error` surface for input users that
land in neither bucket (wire-shape regression defensive).
Mirrors M13's `update clear-all` partial-success cadence but
with the wire-side asymmetry pinned in the projection.

**New custom-OBJECT 5-branch projection** (M37 — `import-html`
+ `append-markdown`). Monday's two new mutations return a
custom `{success: bool, error?: string}` shape (NOT the
standard OBJECT-with-id pattern). The CLI projects through the
5-branch dispatch pinned at D12 closure (success → flat
envelope; `success: false + populated error` →
`validation_failed`; `success: false + empty error` →
`internal_error` wire-regression hint; `success: true + missing
payload` → `internal_error`; EMPTY `block_ids: []` on success →
success WITH empty array). The projection is per-fetcher (no
shared helper at 2 consumers; R-v0.5-NEW-17 watch-item tracks
the OBJECT-shape null-payload guard pattern at 9 consumers
across M34/M35/M36 mutation fetchers but stays UNFILED today
per the per-consumer divergence rationale).

### Upgrade notes

- **`unsupported_column_type` `deferred_to: "v0.5"` slips to
  `"v0.6"`** for the files-shaped category (`file` column type
  via `--set` / `--set-raw`). Originally slipped from v0.4 →
  v0.5 at v0.4 release-prep; v0.5 didn't pick up the friendly /
  raw forms either (the translator boundary still doesn't
  dispatch into the multipart wire). Slipped from v0.5 → v0.6
  at v0.5 release-prep. `monday item upload` (v0.4-M31)
  continues to be the verb-shaped alternative path agents
  should use today; the hint pointing at `monday item upload`
  is unchanged. **The hint is the load-bearing routing surface
  — agents key off the hint, not the `deferred_to` value.**
- **Multi-level subitem creation slips from `"v0.5"` → `"v0.6"`.**
  Originally slipped from v0.3 → v0.4 → v0.5 across two prior
  release-preps. v0.5 didn't pick it up — Monday's
  `sub_items_board` still carries no `subtasks` column at API
  `2026-01`, so depth-2 subitems still have no data-model home.
  Single-level subitems (`item create --parent <iid>` against
  classic boards) continue to work byte-identically. The
  `error.code: "usage_error"` + `details.hierarchy_type:
  "multi_level"` keys are unchanged.
- **Cross-board `item move` value-overrides slip from `"v0.5"`
  → `"v0.6"`.** Originally v0.3-M11-targeted, slipped to v0.4
  at v0.3-M28 audit, slipped to v0.5 at v0.4 release-prep,
  slipped to v0.6 at v0.5 release-prep. Monday's
  `ColumnMappingInput` still carries no value slot; supporting
  it would need a non-atomic post-move `change_multiple_column_
  values` with cross-leg partial-failure envelope shapes that
  have no precedent at v0.5 close. Agents needing overrides
  continue to fire `monday item set <iid> <target>=<value>`
  post-move.
- **Cross-board resumable cursor slips from `"v0.5"` →
  `"v0.6"`.** The `cross_board_truncated` warning's
  `details.hint` continues to recommend narrowing via
  `--workspace` / `--favorites` / `--max-boards`; v0.6 may pick
  the resumable surface up if per-board cursor-lifetime under
  aggregation gets a clean design.
- **Stable error-code registry stays at 29.** Existing codes'
  shapes are unchanged across v0.4 → v0.5.
- **Snake_case wire arg names on M36 doc-block surfaces**
  (`doc_id` / `block_id` / `after_block_id` / `parent_block_id`).
  Monday's standard cadence — NOT a new R-NEW-41 supporting
  site. M37 camelCase wire arg names (`workspaceId` / `folderId`
  / `docId` / `afterBlockId`) ARE a 5th R-NEW-41 supporting
  site for the wire-vs-CLI semantics asymmetry section in
  `docs/architecture.md`.
- **`monday auth login` placeholder-guard unchanged.** The verb
  is still registered and still surfaces `usage_error.details.
  reason: oauth_unregistered` pointing at `MONDAY_API_TOKEN`
  (unchanged from v0.4.0). The OAuth deferral revisits in
  v0.5.x / v0.6 contingent on user demand.

### Internals worth highlighting

- **R-class refactors shipped during v0.5.** R-NEW-70
  (`parseBrandedListArg<T>`) shipped ahead-of-feat at v0.5-M34
  pre-flight close (`17c1a54`) — 4 consumers post-lift (doc/list
  `--workspace` + team-create `--users` + team-add-members
  `--users` + team-remove-members `--users`). 18 unit tests pin
  the helper's branch matrix. R-v0.5-NEW-18 (`readSourceContent`)
  shipped at M37 IMPL kickoff (`c431d96`) — widens M13's
  `readUpdateBody` to parameterise on inline / file flag names +
  optional size cap / trim-whitespace; 5 consumers post-lift
  (3 M13 update verbs + 2 M37 doc verbs).
- **R-class disciplines graduated during v0.5.** R-v0.5-NEW-11
  (per-fetcher null-payload contract decision discipline derived
  from probe-description return-shape promises) graduated at
  M37 pre-flight close (3rd supporting instance — to a permanent
  Codex pre-flight template W{N} audit-point). R-v0.5-NEW-15
  (pre-flight per-variant payload-shape deferral to IMPL
  cassettes) graduated at M37 pre-flight close (3rd supporting
  instance — to a permanent Codex pre-flight template W{N}
  audit-point). R-v0.5-NEW-19 (post-fix-up cross-doc grep
  extension to `src/commands/index.ts` module-import block prose)
  graduated at M37 IMPL close (2nd supporting instance — folded
  into the CLAUDE.md R-NEW-72 "Workflow rules" entry as the
  fourth search path alongside `src/api/*.ts` + `src/commands/
  **/*.ts` + `docs/*.md`). R-v0.5-NEW-9 (round-N parallel-
  fetcher fix-up test parity discipline) graduated at the
  post-M37-close audit (2nd supporting instance — to a
  permanent IMPL-review / pre-flight template W{N} audit-point).
- **Noun-stem matching for R-NEW-72 grep patterns** ratified at
  v0.5-M37 IMPL rounds 3-5 — use `\b<noun>\b` regex matching
  rather than literal-substring matching to catch all
  inflections in a single pass. Lesson folded into CLAUDE.md
  R-NEW-72 entry: enumerate sibling-site noun-stems before
  grepping; use regex word-boundary matching to catch all
  inflections (e.g., `cassette` / `cassette pin` / `cassette
  pinned` / `cassette pins` collapse under `\bcassette\b`).
- **Empirical probes** ratified across the v0.5 surface
  introducing novel wire shapes: M34 `change_team_memberships`
  asymmetric bucket containers (probe round-2 surfaced the
  outer-LIST nullability + the missing per-user failure reason
  pinned at IMPL round-1 P2-1); M35 opaque-JSON `duplicate_doc`
  return-shape variance probe (pinned the defensive 5-shape
  unwrap in `extractDuplicateDocId`); M37 `MAX_DOC_IMPORT_
  PAYLOAD_BYTES` size-limit probe at M37 pre-flight (pinned
  the wire-side rejection threshold between 250KB-OK and
  500KB-rejected on both surfaces). R-NEW-37 W2 (operation-
  name parity) safely-by-construction across all v0.5
  fetchers — verified clean at every Codex IMPL round.
- **Two-AI review** (cli-design pre-flight + implementation
  review) ran for every v0.5 milestone M34–M37 + skipped on
  the v0.5 release-prep cluster per the **R-NEW-84 carve-out**
  graduated at v0.5-M34 pre-flight (skip Codex review on
  mechanical / process-only / test-side housekeeping clusters
  with zero production `src/**/*.ts` changes). M34 IMPL
  converged in 3 rounds; M35 IMPL converged in 6 rounds (one
  round above the OBJECT-return precedent — driven by the
  opaque-JSON cassette-prose sweep surfacing incrementally as
  the post-fix-up R-NEW-72 grep pattern broadened);
  M36 IMPL converged in 2 rounds (at the LOWER bound of the
  precedent); M37 IMPL converged in 5 rounds (~1 round above
  M36's clean cadence, driven by the custom-OBJECT shape's
  prose surface). The cumulative finding count + per-milestone
  Codex-round breakdown lives in the per-milestone post-
  mortems in [`docs/v0.5-plan.md`](./docs/v0.5-plan.md)
  §11–§14.

### Tests + quality gates

- **4054 unit/integration + E2E tests** at v0.5.0 (+1 skipped;
  was 3634+1 at v0.4.0; ~420 new tests across M34–M37). All
  green on Node 22 + 24.
- **Coverage at 99.29 / 96.45 / 99.45 / 99.55** (statements /
  branches / functions / lines) against the floor 95 / 95.45 /
  95 / 95. Branches margin **1.00pp** at v0.5.0 (was 0.88pp at
  v0.4.0; +0.12pp recovery — the v0.5 surface's runtime-body
  branches integration-test-cover the c8-ignored stub drops at
  IMPL close cleanly, first v0.5 IMPL milestone (M37) to cross
  the 1.00pp branches margin threshold; the release-prep
  cluster adds no production branches). Floor unchanged across
  v0.4.0 → v0.5.0.
- **Envelope-snapshot suite** — no refresh needed at release-
  prep; per-milestone close-docs sweeps refreshed snapshots in
  lockstep at each IMPL close (M34 +12 snapshots, M35 +11,
  M36 +6, M37 +0 net — describe-block widening swap only).
- **Five test layers held**: unit, integration (in-process
  `FixtureTransport` + `MultipartFixtureTransport`), E2E
  (subprocess against fixture server), envelope-shape snapshot
  suite, published-tarball E2E.

### Documentation

- **[`docs/v0.5-plan.md`](./docs/v0.5-plan.md)** new — the v0.5
  active plan with M34–M37 milestones, decisions log
  (D1-D13), R-class register (R-v0.5-NEW-1 through
  R-v0.5-NEW-22), per-milestone post-mortems (§11–§14 + §22).
- **[`docs/cli-design.md`](./docs/cli-design.md)** §4.3 grew
  16 new verb entries (6 USER team-* rows + 10 DOC rows for
  M35/M36/M37); §13 v0.4 entry's v0.5 deferral list closed
  out + the v0.6 frame pinned (files-shaped friendly + multi-
  level subitems + cross-board move value-overrides + cross-
  board resumable cursor).
- **[`docs/output-shapes.md`](./docs/output-shapes.md)** —
  M35/M36/M37 verb sections snapshot-backed; M34 team-writer
  sections deferred to v0.5.x as a documentation backfill
  (caught at v0.5 release-prep ToC audit as a v0.5-M34
  close-docs gap; ToC row updated to enumerate the team-*
  verbs, a minimal cross-pointer section landed under
  `### user me` pointing agents at `cli-design.md` §4.3 +
  the per-verb integration tests + envelope-snapshot
  regression suite that pin the team-writer contract surface
  today).
- **README.md** quickstart expanded with v0.5 examples
  (workdocs CRUD steps demonstrating M35/M36/M37 verbs;
  team-writer steps demonstrating M34). Scope section
  reshaped around v0.5.0 / v0.4.0 / v0.3.0 / v0.2.0 / v0.1.0
  per-version layout.

[0.5.0]: https://github.com/Firer/monday-cli/releases/tag/v0.5.0

## [0.4.0] - 2026-05-14 — Operational features: long-poll watch, parallel bulk, asset upload, workdocs reads, shell completion

The "agents can drive long-running workflows + multipart wire +
shell completion" milestone — v0.3's "drive a real backlog"
foundation gains long-poll item activity streaming (NDJSON), bounded
parallel bulk dispatch, the first multipart wire surface (asset
uploads), Monday workdocs reads, and per-shell completion script
generation. **No breaking changes vs `0.3.0` — every v0.4 surface
is additive.** Built incrementally across M29–M33.

### Breaking changes vs `0.3.0`

**None.** Every command, error code, envelope key, and warning
shape shipped in v0.3.0 is preserved byte-for-byte. v0.4 only adds.

### Surface

**~101 commands shipped (was ~95 in v0.3).** Six new verbs +
one orthogonal flag extension on an existing verb. The new noun
namespaces are `doc` (workdocs reads) and `completion` (CLI-
internal, shell completion script generator).

**Long-poll item activity streaming (M29) — `monday item watch
<iid>`.** Long-polls Monday's `boards.activity_logs(item_ids:)`
with a polling cadence floor of `MIN_WATCH_INTERVAL_MS` (1000ms)
and emits one NDJSON event record per emitted activity-log row
plus a trailing `{"_meta": {...}}` record carrying the seven
M29-specific session counters flat under `_meta`:
`events_emitted`, `polls_made`, `failed_polls`,
`last_seen_event_id`, `circuit_broken_at`, `exit_reason`,
`watch_duration_seconds` (plus the standard meta keys + a
`warnings: [...]` slot accumulating `poll_failed` /
`circuit_breaker_armed` warnings). Modes: `--once` drains backlog
and exits without polling further; `--max-events <N>` /
`--max-duration <duration>` ceilings exit cleanly with the matching
`exit_reason`; `--since <event-id>` looks up the event's
`created_at` once and starts the loop from there; `--include
<kind>` filter narrows emitted events (v0.5+ may extend with
comment polling via `--include update_posted` once Monday's
`activity_logs` surfaces those). SIGINT drains gracefully + exits
130. Circuit-breaker trips after 5 consecutive `complexity_exceeded`
polls (emits an `exit_reason: circuit_broken` trailer + a §6.5
failure envelope on stderr + exit code 2; a successful poll between
failures resets the consecutive counter). Walker-side
`entity === 'pulse'` filter drops board-scoped rows per Decision 2
closure.

**Parallel bulk dispatch (M30) — `monday item update --where ...
--concurrency <N>`.** Extends the M25 partial-success bulk path
with bounded parallel dispatch via a new `--concurrency <N>` flag
(range 1..32; default 1). `--concurrency 1` routes through
`dispatchSequential` (byte-equivalent to the M25 default);
`--concurrency > 1` routes through `dispatchParallel` (semaphore-
bounded worker pool). The envelope is byte-equivalent across both
paths — `--concurrency` is a dispatch-mode flag, not a contract
extension. **Input-order preservation**: `data.results[]` lists
per-target outcomes in the original matched-item order regardless
of completion order, so agents can correlate `results[i]` ↔
`matched_items[i]` deterministically. `--concurrency` is mutually
exclusive with the single-item shape (rejected with `usage_error`
at `validateInputShape` before any network call) and requires
`--continue-on-error` on the bulk shape (the fail-fast bulk path
keeps its v0.1 envelope).

**Asset uploads (M31) — `monday item upload` + `monday update
upload`.** First multipart wire surface (`add_file_to_column` /
`add_file_to_update`). Per-verb shapes:

- `monday item upload <iid> --column <col> <file>` uploads the
  local file as a Monday asset attached to the named column on
  the item. Column type is validated against the writable-files
  allowlist (`file` only at v0.4 — Monday's `add_file_to_column`
  doesn't generalise to other types).
- `monday update upload <update-id> <file>` uploads the local
  file as an asset attached to a Monday "update" (comment).

Both verbs do a JSON-leg pre-read (item-board lookup + board
metadata for column resolution, or update lookup) followed by
the multipart `add_file_to_*` mutation. The success envelope
carries Monday's full `Asset` projection (`id`, `name`, `url`,
`public_url`, `file_extension`, `file_size`, `uploaded_by`, etc.).
Pre-checks: `file_not_readable` (ENOENT or directory), `file_empty`
(zero-byte). `file_too_large` rewrap on Monday's
`FILE_SIZE_LIMIT_EXCEEDED` (non-retryable; the underlying
multipart wire is retryable, but the file-size error isn't —
M31 IMPL round-1 P2-1 closure). MIME content-type sniffed via the
new lifted `src/utils/mime.ts` (R-NEW-NEW shipped at M31 IMPL —
2-consumer trigger ahead of v0.4-plan §22's typical 3-consumer
threshold). `--dry-run` previews the planned change envelope
without firing the multipart wire (file path + filename +
file_size_bytes echoed; argv path preserved verbatim for relative
inputs per the R-class round-2/round-3 closure). Uploads are
**non-idempotent**: each successful call mints a fresh `Asset`
ID — re-running uploads the file a second time. Agents needing
register-once dedupe pre-read `Item.assets` / `Update.assets`
(read-side `item assets` / `update assets` verbs deferred to
v0.4.x per M31 Decision D6). Cache invalidation fires single-leg
on item-upload success (the parent item's board metadata cache
invalidates per §8); update-upload doesn't touch board metadata
so there's no invalidation step.

**Monday workdocs reads (M32) — `monday doc list [--workspace
<wid>,...] [--order-by <created_at|used_at>] [--limit <n>]
[--page <n>]` + `monday doc get <did>`.** First read-only access
to Monday's workdocs surface (`Query.docs(...)`). `doc list` is
paginated via page/limit (no cursor on Monday's workdocs surface);
defaults to `--limit 25 --page 1`; range 1..100. `--workspace
<wid>,...` accepts a comma-separated `WorkspaceId` list and maps
to wire `workspace_ids: [ID]` — Monday silently drops inaccessible
IDs (best-effort, no resolver warning). `--order-by <created_at|
used_at>` is a closed 2-value enum; both sort `desc` server-side.
`doc list` emits a wrapped record envelope: `data:
{ documents: [...], page, limit, returned_count, has_more }`
where `has_more === (returned_count === limit)` (Monday's wire
has no `total_count` slot). `doc get <did>` emits the direct-
unwrap `data: <Document with blocks>` shape; empty `docs: []` →
`not_found` with `details.doc_id` per D8 closure (Monday returns
empty when the doc doesn't exist OR is inaccessible — single
error code per the closure). `DocId` joins the brand registry
(`src/types/ids.ts`) as the 9th brand. **The full workdocs CRUD
mutation surface (9 mutations: `create_doc` / `update_doc_name`
/ `delete_doc` / `duplicate_doc` / `import_doc_from_html` /
`add_content_to_doc_from_markdown` / `create_doc_block` /
`update_doc_block` / `delete_doc_block`) is deferred to v0.5 per
D8 closure** — each mutation has enough surface area to warrant
its own milestone cluster.

**Shell completion (M33) — `monday completion <bash|zsh|fish>`.**
First raw-bytes-carve-out verb (cli-design §3.1 #2). The default
mode emits the install-time script bytes on stdout regardless of
TTY/pipe context — `monday completion bash >> ~/.bashrc` writes
the bash script to bashrc as a sourceable file. The `--json` /
`--output json` / `MONDAY_OUTPUT=json` paths opt INTO the §6
envelope with `data: { shell, script }` + `meta.source: "none"`
(CLI-internal verb — no Monday wire call, no cache, no auth
requirement). `--table` / `--output table` / `--output text` /
`--output ndjson` reject with `usage_error` at the parse boundary
(only `--json` and `--table` are global shorthand flags per
cli-design §4.4). Per-shell scripts are hand-rolled templates
(commander 14.0.3 ships **no** built-in completion machinery,
verified by empirical probe at M33 pre-flight) generated by
walking the registered command tree at runtime so agents adding a
new verb get completion for free. ERROR_CODES count stays at 29
per D4 closure. No new runtime dependency added per cli-design §1
"minimum deps".

### Output contract additions

**No new stable error codes — registry stays at 29.** Every v0.4
milestone closed the new-error-code question NEGATIVE: M29 routes
poll failures through the existing `complexity_exceeded` /
`rate_limited` / `network_error` codes (the trailer's
`exit_reason: circuit_broken` is an envelope-level discriminator,
not a `error.code`); M30 routes per-item failures through the M25
codes (`column_archived` / `validation_failed` / etc.); M31 routes
file-IO pre-checks through `usage_error.details.reason` discriminator
(`file_not_readable` / `file_empty` / `file_too_large`); M32
routes empty-array `doc get` through the existing `not_found`; M33
routes invalid shells through `usage_error` from the `parseArgv`
boundary.

**New NDJSON trailer shape** (M29 — `monday item watch`). NDJSON-
streaming verbs emit a final `{"_meta": {...}}` record carrying the
seven M29-specific session counters flat alongside the standard
meta keys (per cli-design §6.3 trailer contract). Pinned by the
envelope-snapshot suite + dedicated per-command suite.

**New wrapped-paginated-record envelope** (M32 — `monday doc
list`). `data: { documents, page, limit, returned_count, has_more
}` carries the pagination wrapper alongside the projection list.
Mirrors the M22 `monday usage` wrapped-record shape but on a
read-paginated surface. R-NEW-74 watch-item tracks the
`kind: 'record'` candidate for a future `emitSuccess` shape
extension (`emit.ts` ships only `kind: 'single' | 'collection'`
today; `'single'` does double-duty for wrapped records). JSON
output works correctly today; the watch-item fires only on a
table-UX complaint + 3rd consumer.

**New raw-bytes-default verb** (M33 — `monday completion`). First
verb whose default stdout payload is NOT a §6 envelope. The
carve-out at cli-design §3.1 #2 enumerates the rule: raw-bytes
mode is opt-out (`--json` / `--output json` / `MONDAY_OUTPUT=json`
opts INTO the envelope). The §6 envelope shape on the opt-in path
is byte-identical to other CLI-internal verbs:
`data: { shell, script }` + `meta.source: "none"`.

**New multipart-mutation planned-change envelope** (M31 —
`item upload --dry-run` + `update upload --dry-run`). The
`planned_changes[]` entry shape extends the standard dry-run
envelope with multipart-specific slots: `operation:
"add_file_to_column"` / `"add_file_to_update"`, `file_path`,
`filename`, `file_size_bytes`, plus the standard `item_id` /
`column_id` (or `update_id`) keys.

### Upgrade notes

- **`unsupported_column_type` `deferred_to: "v0.4"` slips to
  `"v0.5"`** for the files-shaped category (`file` column type via
  `--set` / `--set-raw`). v0.4-M31 shipped the verb-shaped path
  (`monday item upload`) — that's the alternative path agents
  should use today — but NOT the friendly `--set
  <file-col>=<path>` / `--set-raw <file-col>=<json>` form (which
  would need a separate dispatch from the translator boundary
  into the multipart wire). Agents that previously caught the
  v0.3.0 envelope's `deferred_to: "v0.4"` for the files-shaped
  reject path should update their comparison to `"v0.5"`; the
  `error.code: "unsupported_column_type"` + the hint pointing at
  `monday item upload` are unchanged. **The hint is the load-
  bearing routing surface — agents key off the hint, not the
  `deferred_to` value.**
- **Multi-level subitem creation slips from `"v0.4"` → `"v0.5"`.**
  Originally slipped from v0.3 → v0.4 at v0.3-M28 audit. v0.4
  didn't pick it up — Monday's `sub_items_board` carries no
  `subtasks` column at API `2026-01`, so depth-2 subitems still
  have no data-model home. Single-level subitems (`item create
  --parent <iid>` against classic boards) continue to work
  byte-identically. The `error.code: "usage_error"` +
  `details.hierarchy_type: "multi_level"` keys are unchanged.
- **Cross-board `item move` value-overrides slip from `"v0.4"` →
  `"v0.5"`.** Originally v0.3-M11-targeted, slipped to v0.4 at
  v0.3-M28 audit, slipped to v0.5 at v0.4 release-prep. Monday's
  `ColumnMappingInput` still carries no value slot; supporting it
  would need a non-atomic post-move `change_multiple_column_
  values` with cross-leg partial-failure envelope shapes that
  have no precedent at v0.4 close. Agents needing overrides
  continue to fire `monday item set <iid> <target>=<value>`
  post-move.
- **Cross-board resumable cursor slips from `"v0.4"` → `"v0.5"`.**
  The `cross_board_truncated` warning's `details.hint` continues
  to recommend narrowing via `--workspace` / `--favorites` /
  `--max-boards`; v0.5 may pick the resumable surface up if
  per-board cursor-lifetime under aggregation gets a clean design.
- **Stable error-code registry stays at 29.** Existing codes'
  shapes are unchanged across v0.3 → v0.4.
- **`--concurrency <N>` is a new global-ish flag on bulk
  `item update`.** Default `1` preserves the M25 sequential
  envelope byte-for-byte; agents only opt INTO parallel dispatch
  by passing the flag.
- **`monday auth login` placeholder-guard unchanged.** The verb
  is still registered and still surfaces `usage_error.details.
  reason: oauth_unregistered` pointing at `MONDAY_API_TOKEN`
  (unchanged from v0.3.0). The OAuth deferral revisits in v0.4.x
  / v0.5 contingent on user demand.

### Internals worth highlighting

- **First multipart wire surface (M31)** introduces a new
  transport seam (`MultipartTransport`) alongside the JSON
  `transport` slot in `ResolvedClient`. Test seam mirrors the
  JSON path's pattern (`ctx.multipart` injection wins;
  production builds fresh via `createMultipartTransport(...)`).
  The `add_file_to_column` / `add_file_to_update` fetchers share
  an inline `dispatchMultipartOnce` helper + an inline retry-
  thunk rewrap pattern for the non-retryable file_too_large case
  (the wrap-vs-thunk placement is invariant — round-1 P2-1
  closure). Codex pre-pre-flight checklist R-v0.4-W2 ratified
  for "new transport seam" milestones.

- **R-class refactors shipped during v0.4.** R-NEW-41 (asymmetric
  wire-vs-CLI semantics documentation pattern) shipped at M31
  pre-flight as a new `docs/architecture.md` "Wire-vs-CLI
  semantics documentation conventions" section enumerating the
  three documented asymmetries (M27 webhook.config wire-typing
  + M27 NotificationTargetType + M31 multipart-vs-JSON
  transport). R-NEW-NEW `sniffContentType` lift to
  `src/utils/mime.ts` (M31 IMPL — 2-consumer trigger ahead of
  the typical 3-consumer threshold; coverage from integration
  tests alone would have failed the branches floor). R-NEW-56
  ratified for the 3rd consecutive IMPL milestone (cross-doc
  grep at IMPL kickoff catches prose-drift surface ahead of
  Codex review). R-NEW-58 ratified via positive case at M31
  + negative case at M32. R-NEW-72 (cross-doc grep after every
  contract-flipping Codex fix-up) graduated to a permanent
  CLAUDE.md "Workflow rules" entry at M33 IMPL close. R-NEW-75
  (5-dimension candidate-selection framework) graduated at the
  post-M33 candidate-selection session that picked release-prep
  over team writers. Full register with shipped commit SHAs +
  consumer counts lives in [`docs/v0.4-plan.md`](./docs/v0.4-plan.md) §22.

- **Empirical probes** ratified across every novel v0.4 surface:
  M29 `activity_logs` polling shape, M31 multipart `add_file_to_*`
  wire, M32 `Query.docs(...)` filter + ordering enum + pagination
  shape, M33 commander capability check (returned ZERO hits,
  flipping the cli-design §13 entry from "via commander" to
  "hand-rolled templates" before any pre-flight contract claim
  could drift). R-NEW-77 (CLI-internal milestone empirical-probe-
  slot equivalent) filed at M33 pre-flight as a 1-consumer
  watch-item.

- **Two-AI review** (cli-design pre-flight + implementation
  review) ran for every milestone M29–M33. M30 IMPL took 5
  rounds to converge (the lesson driving R-NEW-56's pre-IMPL
  cross-doc grep + R-NEW-72's post-fix-up grep). M31 took 7
  pre-flight rounds (two distinct surface classes plus
  substantive transport-seam gaps at rounds 6-7) + 3 IMPL rounds.
  M32 / M33 each converged in 3 IMPL rounds. The cumulative
  finding count + per-milestone Codex-round breakdown lives in
  the per-milestone post-mortems in
  [`docs/v0.4-plan.md`](./docs/v0.4-plan.md) §3 + §13–§15.

### Tests + quality gates

- **3634 unit/integration + E2E tests** at v0.4.0 (+1 skipped;
  was 3249+1 ≈ 3250 in v0.3.0; ~385 new tests across M29–M33 +
  the v0.4 release-prep envelope-snapshot refresh). All green on
  Node 22 + 24.
- **Coverage at 99.26 / 96.33 / 99.34 / 99.53** (statements /
  branches / functions / lines) against the floor 95 / 95.45 / 95
  / 95. Branches margin **0.88pp** at v0.4.0 (was 0.95pp at
  v0.3.0; the v0.4 surface introduced novel branch-heavy areas
  like M29's circuit-breaker progression + M30's parallel
  dispatcher, both of which carry full integration-test coverage
  but eat margin). Floor unchanged across v0.3.0 → v0.4.0.
- **Envelope-snapshot suite refreshed** for v0.4 surfaces — adds
  11 snapshots covering item watch (NDJSON trailer shape),
  doc list (wrapped record), doc get (direct unwrap + D8
  not_found), completion bash/zsh/fish --json (raw-bytes-carve-
  out envelope opt-in), completion --table + invalid-shell
  rejections. Item upload / update upload pinned by the per-
  command suites (multipart transport scaffolding stays out
  of the envelope-snapshot suite per the v0.3-M28 cross-board /
  dev precedent). `--concurrency` envelope byte-equivalent to
  the existing M25 sequential snapshot — pinned by the per-
  command bulk suite.
- **Five test layers held**: unit, integration (in-process
  `FixtureTransport` + `MultipartFixtureTransport`), E2E
  (subprocess against fixture server), envelope-shape snapshot
  suite, published-tarball E2E.

### Documentation

- **[`docs/v0.4-plan.md`](./docs/v0.4-plan.md)** new — the v0.4
  active plan with M29–M33 milestones, decisions log, R-class
  register (R-NEW-44 through R-NEW-81), per-milestone post-
  mortems (§3 + §13–§15 + §22).
- **[`docs/cli-design.md`](./docs/cli-design.md)** §4.3 grew six
  new verb entries; §3.1 #2 raw-bytes carve-out documented; §13
  v0.4 entry closed out + the v0.5 frame pinned (team writers +
  doc CRUD mutation surface deferred to v0.5).
- **[`docs/architecture.md`](./docs/architecture.md)** gained
  the "Wire-vs-CLI semantics documentation conventions" section
  (R-NEW-41 shipped at M31 pre-flight).
- **[`docs/output-shapes.md`](./docs/output-shapes.md)** — every
  shipped v0.4 command has a per-section data shape entry,
  snapshot-backed.
- **README.md** quickstart expanded with v0.4 examples (`monday
  completion`, `monday item watch`, `monday item upload`,
  `--concurrency`, `monday doc list/get`).

[0.4.0]: https://github.com/Firer/monday-cli/releases/tag/v0.4.0

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
- **Multi-level subitem creation slips to `deferred_to: "v0.4"`.**
  M28 Decision 11 closure: Monday's `sub_items_board` carries no
  `subtasks` column at API `2026-01`, so depth-2 subitems have no
  data-model home. Agents that previously caught the v0.2.0
  envelope's `deferred_to: "v0.3"` should update the comparison;
  the `error.code: "usage_error"` + `details.hierarchy_type:
  "multi_level"` keys are unchanged. Single-level subitems (`item
  create --parent <iid>` against classic boards) continue to work
  byte-identically.
- **Cross-board `item move` value-overrides slip to v0.4.**
  `--columns-mapping`'s string-to-string form is unchanged. The
  richer `{id, value?}` form was originally v0.3-targeted at M11
  close; no v0.3 milestone picked up the extension because
  Monday's `ColumnMappingInput` carries no value slot. Agents
  needing overrides continue to fire `monday item set <iid>
  <target>=<value>` post-move.
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

- **3249 unit/integration + E2E tests** at v0.3.0 (+1 skipped; was
  2280+38 ≈ 2318 in v0.2.0). All green on Node 22 + 24.
- **Coverage at 99.26 / 96.40 / 99.37 / 99.51** (statements /
  branches / functions / lines) against the floor 95 / 95.45 / 95
  / 95. The branches floor was raised at M22 (94% → 95.45%) and
  held through M28; the M28 close-out shipped six branch-coverage
  residual tests closing the three deferred file-level gaps
  (`item/search.ts` 88.23% → 100% stmts; `errors.ts` 95.37% → 100%
  lines; `dry-run.ts` 96.26% → 100% branches). Branches margin is
  0.95pp at v0.3.0.
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
