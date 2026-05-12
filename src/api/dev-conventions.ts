/**
 * Monday Dev convention helpers for the v0.3-M26 `monday dev …`
 * namespace (`cli-design.md` §2.7 + §5.9 + §11.3 + §13 v0.3 entry;
 * `v0.3-plan.md` §3 M26).
 *
 * **Monday Dev is convention, not API (cli-design §2.7).** No
 * dedicated GraphQL surface — `dev sprint current`, `dev task done`,
 * etc. are *workflow shortcuts* that resolve to standard board /
 * item CRUD operations against per-profile-configured board IDs.
 * This module owns the convention-to-board-ID resolution, the
 * per-profile `[profiles.<name>.dev]` reader / writer, and the
 * board-name-based discovery heuristic that seeds the config from
 * a Monday Dev template-shaped workspace.
 *
 * **What this module owns.**
 *
 *   1. The {@link DevMapping} alias over `profiles.ts:profileDevBlockSchema`
 *      — single source of truth for the per-profile board mapping
 *      shape. Re-exported here for namespace-clarity at the
 *      `dev`-command call sites; the schema itself lives next to
 *      the profile-file reader so v0.3-M21's multi-profile config
 *      shape stays single-source-of-truth.
 *   2. The {@link DevDiscoverOutput} + {@link DevConfigureOutput} +
 *      {@link DevDoctorOutput} output projections — pinned at this
 *      pre-flight so `monday schema` reads consistent shapes across
 *      the three setup verbs.
 *   3. Pure helpers: {@link matchBoardByConvention} (name-based
 *      heuristic — exact-match-then-substring against the
 *      Monday Dev template's stock board names) +
 *      {@link buildDiscoverMappingFromMatches} (collapses the
 *      heuristic's per-noun matches into a {@link DevMapping}).
 *      Real implementations — the heuristic is content-addressed
 *      against board names so it shipped testable at pre-flight
 *      alongside the runtime fetchers (M26a IMPL `19755e3` landed
 *      the `boards(state: all, workspace_ids:)` walker with the
 *      `Board.type === 'board'` filter + per-board metadata
 *      hydration).
 *   4. Runtime fetchers: {@link discoverDevBoards} (walks accessible
 *      boards + applies the heuristic) + {@link runDevDoctor}
 *      (validates the active profile's mapping against current board
 *      shape) + {@link loadDevMapping} (reads
 *      `[profiles.<name>.dev]`) + {@link saveDevMapping} (writes
 *      `[profiles.<name>.dev]` via atomic TOML round-trip). The
 *      pre-flight `c8 ignore start/stop` wraps dropped at M26a IMPL
 *      (`19755e3`) alongside the per-fetcher wire bodies.
 *
 * **Empirical-probe findings pinned at M26a IMPL (2026-05-11, against
 * `api.monday.com`, API version `2026-01`) — `scripts/probe/m26-
 * dev-discover.ts` + `scripts/probe/m26-board-kind.ts` +
 * `scripts/probe/m26-board-type.ts`:**
 *
 *   - **Stock template names unchanged.** Live Monday Dev workspace
 *     surfaces `Tasks` / `Epics` / `Bugs Queue` matching the pinned
 *     {@link DEV_NOUN_PATTERNS} (substring tolerance handles the
 *     `Queue` suffix on bugs). Decision 1 closure stands; no
 *     `DEV_NOUN_PATTERNS` amendment needed.
 *   - **`Board.type === 'board'` filter required.** Monday's
 *     `boards()` walker returns `sub_items_board` virtual entries
 *     (auto-generated `Subitems of <BoardName>` boards) that pollute
 *     the substring heuristic — `Subitems of Tasks` matches the
 *     `tasks` pattern, creating an ambiguous match that prevents
 *     auto-mapping. The walker filters to `type === 'board'`,
 *     silently dropping `sub_items_board` / `custom_object` /
 *     `document` entries. Behavior-equivalent refinement, NOT a
 *     contract amendment — {@link DiscoverBoardCandidate} schema
 *     unchanged.
 *   - **`state: all` walker filter.** Per the M26 IMPL handoff
 *     guidance (don't filter by board state at the walker), the
 *     walker passes `state: all` so the heuristic sees archived /
 *     deleted boards too; the action body surfaces them on
 *     {@link DevDiscoverOutput.matches} for agent-side review.
 *   - **`board_kind`-`public`/`private`/`share` only.** Does NOT
 *     discriminate subitem boards — `Subitems of Tasks` reports
 *     `board_kind: 'public'`, identical to the parent `Tasks`
 *     board. Hence the `Board.type` filter rather than a
 *     `board_kind` filter.
 *
 * **What this module does NOT own.**
 *
 *   - The base profile-config schema + read path. Lives in
 *     `src/config/profiles.ts` per v0.3-M21 (`loadProfilesConfig`,
 *     `profilesConfigSchema`, `profileDevBlockSchema`). This module
 *     re-exports the dev-block schema as `devMappingSchema` for
 *     namespace clarity + owns the dev-block WRITE-back path
 *     (`saveDevMapping`); the parent profile shape stays under
 *     `src/config/profiles.ts`.
 *   - Per-workflow-verb wire calls (sprint/epic/release/task
 *     reads + writes). Those route through existing api/* modules
 *     (`items-page-walker`, `item-mutation-execute`, etc.) — the
 *     dev namespace contributes the *resolver* that maps `current
 *     sprint` to the right item-search input, not new wire
 *     primitives.
 *   - Convention-name overrides for non-template workspaces. The
 *     heuristic looks for Monday Dev template's stock English
 *     names; localised workspaces (Spanish "Tareas" etc.) fall
 *     through to `dev configure` + an explicit per-board override.
 *     A v0.4+ extension may add `--name-aliases` to discover.
 *
 * **Failure-mode routing (no new ERROR_CODES; 29 stays).** Per
 * cli-design §5.9, the two `dev_*` codes pre-registered in
 * `src/utils/errors.ts:ERROR_CODES` cover the namespace's failure
 * modes:
 *
 *   - `dev_not_configured` — active profile has no `[profiles.
 *     <name>.dev]` block AND no overrides via env vars / flags.
 *     Surface points at `monday dev configure` + `monday dev
 *     discover`.
 *   - `dev_board_misconfigured` — mapped board exists but doesn't
 *     expose the expected column (no status column on the tasks
 *     board, etc.). Surface points at `monday dev doctor` for
 *     diagnostics + `monday board describe <bid>` to inspect.
 *
 * Other failures (board deleted / access revoked / column-token
 * collision / etc.) route through the existing 29-code registry
 * (`not_found`, `column_not_found`, `unauthorized`, etc.) without
 * widening.
 */

import {
  chmod,
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify as stringifyToml } from 'smol-toml';
import { z } from 'zod';
import { ApiError, ConfigError, asError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import type { Complexity } from '../utils/output/envelope.js';
import {
  PROFILES_DIR_NAME,
  loadProfilesConfig,
  profilesConfigSchema,
  resolveProfilesConfigPath,
  type ProfileEntry,
  type ProfilesConfig,
  type ProfilesRootOptions,
  profileDevBlockSchema,
  type ProfileDevBlock,
} from '../config/profiles.js';
import type { MondayClient } from './client.js';
import {
  fetchItemsPage,
  fetchNextItemsPage,
  type ItemsPagePayload,
} from './items-page-walker.js';
import { paginate } from './pagination.js';
import {
  idFromRawItem,
  projectItem,
  type ProjectedColumn,
  type ProjectedItem,
} from './item-projection.js';
import { ITEM_FIELDS_FRAGMENT, parseRawItem } from './item-helpers.js';
import type { SelectedMutation } from './column-values.js';
import { executeItemMutation } from './item-mutation-execute.js';

/**
 * The per-profile Monday Dev board mapping. Alias over the
 * `profileDevBlockSchema` defined in `src/config/profiles.ts:49-57`
 * so the dev-namespace verbs read the same shape v0.3-M21 pinned
 * for the multi-profile TOML config.
 *
 * Field names use snake_case to match the TOML config; the CLI
 * flag layer (`monday dev configure --tasks-board <bid>`) maps
 * camelCase argv to snake_case at the parse boundary.
 */
export const devMappingSchema = profileDevBlockSchema;
export type DevMapping = ProfileDevBlock;

/**
 * The Monday Dev template's stock noun → board-name patterns.
 * The discovery heuristic uses these as the matcher seed; a
 * workspace whose board names match one of these patterns (case-
 * insensitive, Unicode NFC) gets auto-mapped to the corresponding
 * dev-noun slot.
 *
 * Pinned in the order the heuristic considers them. Order matters
 * only for tie-breaking when a single board matches multiple
 * patterns (rare; e.g. a board named "Tasks & Bugs" matches both
 * `tasks` and `bugs` — the heuristic surfaces such ambiguity on
 * the success envelope's `matches[]` array via
 * `matched.length > 1` rather than auto-mapping).
 *
 * Localised workspaces (Spanish "Tareas", French "Sprints" — same
 * spelling but different language) round-trip the English form
 * since the heuristic is forward-compat-extensible at v0.4 via a
 * `--name-aliases` flag on `dev discover`. Today's heuristic ships
 * English-only by design — Monday Dev templates default to English
 * board names on new workspaces regardless of UI locale.
 */
export const DEV_NOUN_PATTERNS: readonly {
  readonly noun: keyof DevMapping;
  readonly patterns: readonly string[];
}[] = [
  { noun: 'tasks_board', patterns: ['tasks', 'task'] },
  { noun: 'sprints_board', patterns: ['sprints', 'sprint'] },
  { noun: 'epics_board', patterns: ['epics', 'epic'] },
  { noun: 'releases_board', patterns: ['releases', 'release'] },
  { noun: 'bugs_board', patterns: ['bugs', 'bug'] },
] as const;

/**
 * One board candidate the discovery heuristic considers. Carries
 * the minimum the matcher needs: ID for the mapping, name for the
 * heuristic itself, optional workspace_id so `dev discover
 * --workspace <wid>` can scope the search.
 */
export interface DiscoverBoardCandidate {
  readonly id: string;
  readonly name: string;
  readonly workspace_id: string | null;
}

export const discoverBoardCandidateSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    workspace_id: z.string().nullable(),
  })
  .strict();

/**
 * One per-noun match result from the heuristic. The `matched`
 * array carries every board that matched the noun's patterns; the
 * `dev discover` action layer surfaces ambiguity (`matched.length
 * > 1`) and zero-match (`matched.length === 0`) cases via the
 * success envelope's `matches[]` array rather than auto-resolving
 * silently or emitting a warning code.
 */
export interface DevNounMatchResult {
  readonly noun: keyof DevMapping;
  readonly matched: readonly DiscoverBoardCandidate[];
}

export const devNounMatchResultSchema = z
  .object({
    noun: z.enum([
      'tasks_board',
      'sprints_board',
      'epics_board',
      'releases_board',
      'bugs_board',
    ]),
    matched: z.array(discoverBoardCandidateSchema),
  })
  .strict();

/**
 * Normalises a board name for the heuristic's case-insensitive
 * substring match. Unicode NFC + lowercase + collapse internal
 * whitespace + trim — same shape as the column-token resolver
 * (cli-design §5.3 step 2.b).
 */
const normaliseBoardName = (name: string): string =>
  name
    .normalize('NFC')
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ')
    .trim();

/**
 * Returns true when `candidate.name` matches any of `patterns`.
 * Exact-match wins over substring-match; the matcher returns true
 * on either form so the caller can rank candidates afterwards if
 * needed. Pure helper — real implementation at pre-flight so the
 * Codex review can verify the heuristic shape inline.
 */
export const matchBoardByConvention = (
  candidate: DiscoverBoardCandidate,
  patterns: readonly string[],
): boolean => {
  const normalised = normaliseBoardName(candidate.name);
  for (const pattern of patterns) {
    const normalisedPattern = normaliseBoardName(pattern);
    if (normalised === normalisedPattern) return true;
    if (normalised.includes(normalisedPattern)) return true;
  }
  return false;
};

/**
 * Runs the heuristic across `candidates` and groups by dev-noun.
 * Returns one {@link DevNounMatchResult} per noun in
 * {@link DEV_NOUN_PATTERNS} order; nouns with zero matches surface
 * with empty `matched` arrays (the caller surfaces these on the
 * `dev discover` success envelope's `matches[]` array via
 * `matched.length === 0` — no warning code registered at M26
 * pre-flight). Pure helper — real implementation at pre-flight.
 */
export const groupCandidatesByDevNoun = (
  candidates: readonly DiscoverBoardCandidate[],
): readonly DevNounMatchResult[] =>
  DEV_NOUN_PATTERNS.map(({ noun, patterns }) => ({
    noun,
    matched: candidates.filter((c) => matchBoardByConvention(c, patterns)),
  }));

/**
 * Collapses the per-noun match results into a {@link DevMapping}.
 * Nouns with exactly one match populate the mapping slot;
 * zero-match or ambiguous (>1 match) nouns are omitted from the
 * mapping. The caller — `dev discover` — surfaces both modes
 * via the same `matches[]` array on the success envelope
 * (`matched.length === 0` = unmapped; `matched.length > 1` =
 * ambiguous); no separate warning code is registered at M26
 * pre-flight (round-1 Codex P2-3 clarification — warning-code
 * registration is per cli-design §6.1 + the `dev discover`
 * surface intentionally uses data-shape rather than warnings
 * for the heuristic's per-noun outcomes). Pure helper — real
 * implementation at pre-flight.
 */
export const buildDiscoverMappingFromMatches = (
  matches: readonly DevNounMatchResult[],
): DevMapping => {
  const mapping: { [K in keyof DevMapping]?: string } = {};
  for (const { noun, matched } of matches) {
    if (matched.length === 1) {
      // Type-safe assignment via the keyof DevMapping pin on `noun`.
      const slot = noun;
      const value = matched[0]?.id;
      if (value !== undefined) {
        mapping[slot] = value;
      }
    }
  }
  return mapping satisfies DevMapping;
};

/**
 * Output shape for `monday dev discover` (cli-design §11.3 +
 * §4.3 `dev discover [--apply]` row). Surfaces the heuristic's
 * findings + the would-be-written mapping. Per-noun outcomes
 * (matched / unmapped / ambiguous) are surfaced via the
 * `matches[]` array's per-entry `matched.length` rather than
 * via a separate warning surface.
 */
export interface DevDiscoverOutput {
  readonly profile: string;
  readonly mapping: DevMapping;
  readonly matches: readonly DevNounMatchResult[];
  readonly applied: boolean;
}

export const devDiscoverOutputSchema = z
  .object({
    profile: z.string().min(1),
    mapping: devMappingSchema,
    matches: z.array(devNounMatchResultSchema),
    applied: z.boolean(),
  })
  .strict();

/**
 * Output shape for `monday dev configure` (cli-design §4.3 +
 * §5.9). The verb writes the now-stored mapping to the active
 * profile's `[profiles.<name>.dev]` block and returns the
 * canonical mapping (post-write read-back) so an agent can verify
 * the value landed.
 */
export interface DevConfigureOutput {
  readonly profile: string;
  readonly mapping: DevMapping;
}

export const devConfigureOutputSchema = z
  .object({
    profile: z.string().min(1),
    mapping: devMappingSchema,
  })
  .strict();

/**
 * Pinned check-name vocabulary for `dev doctor` (Decision 2
 * closure at M26 pre-flight). The runtime body iterates this list
 * in order and emits one {@link DevDoctorCheckResult} per name.
 * Names are stable contract surface — agents key off them (an
 * agent self-correcting after a `dev task` failure can grep the
 * doctor output for `tasks_status_column_present.status === 'fail'`).
 *
 * Adding a check is non-breaking (additive); removing or renaming
 * is a major bump.
 *
 * **Round-1 Codex fix (P1-1).** `sprints_state_column_present`
 * was the round-0 name but every sprint verb's runtime semantics
 * are date-range-derived (cli-design §5.9 + the sprint-list verb's
 * `--state active|past|future` filter), not status-column-derived.
 * Renamed to `sprints_date_columns_present` to match what the
 * runtime body will actually inspect — start_date + end_date
 * columns on the configured sprints board.
 *
 * **Round-1 Codex fix (P2-2).** Added `bugs_board_exists` so the
 * `bugs_board` mapping slot is diagnosed by the doctor like every
 * other dev-noun slot.
 *
 * **Round-2 Codex fix (P2-3).** Replaced `epics_to_releases_relation`
 * with `tasks_to_epics_relation` — the round-1 list had a relation
 * check for an epic↔release wiring that no M26 verb consumes
 * (there's no `dev release items` verb at v0.3), while the
 * actually-consumed epic↔task relation (`dev epic items <eid>`
 * walks tasks linked to a given epic) was missing. The release-
 * to-epic relation can rejoin in a v0.3.x / v0.4 follow-up when /
 * if a `dev release items` verb lands. Total check count holds at
 * 10.
 */
export const DEV_DOCTOR_CHECK_NAMES = [
  'tasks_board_exists',
  'tasks_status_column_present',
  'tasks_status_labels_canonical',
  'sprints_board_exists',
  'sprints_date_columns_present',
  'epics_board_exists',
  'releases_board_exists',
  'bugs_board_exists',
  'tasks_to_sprints_relation',
  'tasks_to_epics_relation',
] as const;

export type DevDoctorCheckName = (typeof DEV_DOCTOR_CHECK_NAMES)[number];

/**
 * One diagnostic check `dev doctor` ran against the active
 * profile's mapping. `status: 'ok'` = passed; `'warn'` = the
 * check raised a non-fatal concern (e.g. status column has
 * non-standard labels); `'fail'` = the check found drift that
 * blocks the corresponding `dev` verb (e.g. tasks board has no
 * status column at all — `dev task start` would fail).
 *
 * Per-status `details` shape is now STRUCTURALLY pinned at M26a
 * IMPL round-2 P2-1 via the {@link okCheckDetailsSchema} /
 * {@link warnCheckDetailsSchema} / {@link failCheckDetailsSchema}
 * discriminated union below — `monday schema dev.doctor` surfaces
 * the closed {@link DEV_DOCTOR_REASONS} enum via JSON Schema
 * export, and `failResult` enforces a required `reason` at
 * compile time. Extra `details` keys beyond `reason` stay open
 * per-status (open-ended `Record<string, unknown>` extension via
 * `.loose()`) so each check emits its own context fields
 * (`board_id`, `column_id`, etc.) without per-check schema
 * widening.
 *
 * **M26 pre-flight round-1 Codex fix (P2-1).** `name` is typed
 * as {@link DevDoctorCheckName} (the enum literal union) so
 * `monday schema` exposes the stable vocabulary + implementation
 * typos fail output-schema validation rather than silently
 * passing through.
 */
/**
 * Pinned `details.reason` enum vocabulary surfaced by per-check
 * failure paths. Closes the Decision 2 deferral (per-check
 * discriminated-union pinning) at M26a IMPL — `details.reason`
 * is the agent-keyable discriminator on `status: 'fail'` (and on
 * `status: 'warn'` when a warn carries a structured reason, e.g.
 * `settings_unparseable`).
 *
 * Codex M26a IMPL round-1 P2-1 fix: previously the schema accepted
 * any `details: Record<string, unknown>` shape, so `monday schema`
 * couldn't expose the reason vocabulary + tests couldn't catch
 * typos. Pinning the enum + the "fail requires reason" refinement
 * gives agents a stable branchpoint.
 *
 * Adding a reason is non-breaking; removing or renaming is major.
 */
export const DEV_DOCTOR_REASONS = [
  'not_in_mapping',
  'not_accessible',
  'board_deleted',
  'no_tasks_board',
  'no_sprints_board',
  'no_status_column',
  'no_date_columns',
  'no_relation_column',
  'no_matching_relation',
  'no_target_board',
  'settings_unparseable',
] as const;

export type DevDoctorReason = (typeof DEV_DOCTOR_REASONS)[number];

export const devDoctorReasonSchema = z.enum(DEV_DOCTOR_REASONS);

/**
 * Per-status `details` shape. Codex M26a IMPL round-2 P2-1 + P2-2
 * fix: the round-1 superRefine ran the `reason`-enum check
 * runtime-only — `monday schema` (which calls `z.toJSONSchema(outputSchema)`)
 * couldn't surface the enum vocabulary, and ok-status details were
 * incidentally blocked when an ok carried any non-enum `reason`.
 * Refactored into a structural discriminated union on `status`:
 *
 *   - `ok`: open `details` object (or null) — no `reason` constraint.
 *   - `warn`: optional `reason: DEV_DOCTOR_REASONS` enum + open
 *     extras; supports both unstructured warnings (archived board)
 *     and structured ones (settings_unparseable).
 *   - `fail`: REQUIRED `reason: DEV_DOCTOR_REASONS` enum + open
 *     extras; `details` is non-nullable on fail (every failure
 *     surfaces a structured reason).
 *
 * Open-ended extra keys per-status mirror Monday's per-call payload
 * variability — every check emits its own context fields
 * (`board_id`, `column_id`, etc.) under the same status family.
 */
export const okCheckDetailsSchema = z
  .record(z.string(), z.unknown())
  .nullable();

export const warnCheckDetailsSchema = z
  .object({ reason: devDoctorReasonSchema.optional() })
  .loose()
  .nullable();

export const failCheckDetailsSchema = z
  .object({ reason: devDoctorReasonSchema })
  .loose();

export const devDoctorCheckResultOkSchema = z
  .object({
    name: z.enum(DEV_DOCTOR_CHECK_NAMES),
    status: z.literal('ok'),
    message: z.string().min(1),
    details: okCheckDetailsSchema,
  })
  .strict();

export const devDoctorCheckResultWarnSchema = z
  .object({
    name: z.enum(DEV_DOCTOR_CHECK_NAMES),
    status: z.literal('warn'),
    message: z.string().min(1),
    details: warnCheckDetailsSchema,
  })
  .strict();

export const devDoctorCheckResultFailSchema = z
  .object({
    name: z.enum(DEV_DOCTOR_CHECK_NAMES),
    status: z.literal('fail'),
    message: z.string().min(1),
    details: failCheckDetailsSchema,
  })
  .strict();

export const devDoctorCheckResultSchema = z.discriminatedUnion('status', [
  devDoctorCheckResultOkSchema,
  devDoctorCheckResultWarnSchema,
  devDoctorCheckResultFailSchema,
]);

export type DevDoctorCheckResult = z.infer<typeof devDoctorCheckResultSchema>;

/**
 * Output shape for `monday dev doctor` (cli-design §11.3). The
 * verb runs every check against the active profile's mapping +
 * surfaces both the per-check results and the active mapping
 * (so an agent diagnosing a misconfiguration sees both in one
 * envelope).
 *
 * **Decision 2 closure (M26 pre-flight + M26a IMPL).** The
 * pinned check names: see {@link DEV_DOCTOR_CHECK_NAMES} above
 * (10 entries post-round-1; round-0 had 9 entries before P1-1
 * / P2-2 fix-ups). Mirror cli-design §11.3 "runs `board doctor`
 * against each configured dev board plus checks the cross-board
 * `board_relation` wiring". Per-check `details` shape was
 * deferred to IMPL at pre-flight + landed at M26a IMPL round-2
 * P2-1 as a structural `z.discriminatedUnion('status', [...])`
 * over {@link okCheckDetailsSchema} / {@link warnCheckDetailsSchema}
 * / {@link failCheckDetailsSchema} (the `reason` enum from
 * {@link DEV_DOCTOR_REASONS} is required on fail + optional on
 * warn; extra keys per check stay open).
 */
export interface DevDoctorOutput {
  readonly profile: string;
  readonly mapping: DevMapping;
  readonly checks: readonly DevDoctorCheckResult[];
  readonly summary: {
    readonly ok_count: number;
    readonly warn_count: number;
    readonly fail_count: number;
  };
}

export const devDoctorOutputSchema = z
  .object({
    profile: z.string().min(1),
    mapping: devMappingSchema,
    checks: z.array(devDoctorCheckResultSchema),
    summary: z
      .object({
        ok_count: z.number().int().nonnegative(),
        warn_count: z.number().int().nonnegative(),
        fail_count: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

/**
 * Inputs to {@link discoverDevBoards}.
 *
 * `workspaceId` is optional — when set, the discovery walker scopes
 * to that workspace via Monday's `boards(workspace_ids: [...])`
 * arg; when unset, it walks every board the user has access to.
 * M26a IMPL pinned the walker cadence at `DISCOVER_PAGE_LIMIT` 200
 * entries per page with a hard `DISCOVER_PAGE_CAP` of 50 pages
 * (10000 boards max — comfortably above any realistic dev
 * workspace).
 */
export interface DiscoverDevBoardsInputs {
  readonly client: MondayClient;
  readonly workspaceId?: string;
}

/**
 * Result of {@link discoverDevBoards}. Carries the candidate list
 * + the grouped per-noun match results so the `dev discover`
 * action can emit the {@link DevDiscoverOutput} envelope after
 * deciding whether `--apply` writes the mapping to the active
 * profile.
 *
 * `source` / `cacheAgeSeconds` / `complexity` mirror the M23
 * {@link FetchBoardFavoritesResult} envelope-meta pin — discover
 * is a pure live read with no per-call cache; `complexity` is the
 * LAST page's complexity slot (under `--verbose`).
 */
export interface DiscoverDevBoardsResult {
  readonly candidates: readonly DiscoverBoardCandidate[];
  readonly matches: readonly DevNounMatchResult[];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Internal wire-row shape for the boards walker. Carries the
 * minimum fields the heuristic + the `Board.type === 'board'`
 * filter need.
 */
const rawDiscoverBoardRowSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    workspace_id: z.string().nullable(),
    type: z.string().nullable(),
  })
  .loose();

const rawDiscoverBoardsResponseSchema = z
  .object({
    boards: z.array(rawDiscoverBoardRowSchema.nullable()).nullable(),
  })
  .loose();

/**
 * Hard cap on the walker's page count. At 200 boards per page that's
 * up to 10000 boards before the walker truncates — far above any
 * realistic dev workspace.
 */
const DISCOVER_PAGE_LIMIT = 200;
const DISCOVER_PAGE_CAP = 50;

/**
 * Walks the user's accessible boards (optionally scoped to
 * `workspaceId`) and groups them by dev-noun via the heuristic.
 *
 * **Walker contract.** Pages through `boards(limit:, page:, state:
 * all[, workspace_ids:])` until a short page indicates the end of
 * results OR the page cap is reached. Per the M26a IMPL handoff,
 * `state: all` is passed so archived / deleted boards surface to the
 * heuristic too — the action body surfaces them on
 * {@link DevDiscoverOutput.matches} for agent-side review. The
 * walker silently drops `Board.type !== 'board'` rows
 * (`sub_items_board` virtual boards, `custom_object` entries,
 * `document` entries) since those aren't valid dev-noun mapping
 * targets — see the module docstring for the empirical-probe
 * rationale.
 */
export const discoverDevBoards = async (
  inputs: DiscoverDevBoardsInputs,
): Promise<DiscoverDevBoardsResult> => {
  const candidates: DiscoverBoardCandidate[] = [];
  let page = 1;
  let lastComplexity!: Complexity | null;
  for (;;) {
    const query =
      inputs.workspaceId === undefined
        ? `query DevDiscoverBoards($limit: Int!, $page: Int!) {
             boards(limit: $limit, page: $page, state: all) {
               id name workspace_id type
             }
           }`
        : `query DevDiscoverBoardsScoped($limit: Int!, $page: Int!, $wsids: [ID!]) {
             boards(limit: $limit, page: $page, state: all, workspace_ids: $wsids) {
               id name workspace_id type
             }
           }`;
    const variables: Record<string, unknown> =
      inputs.workspaceId === undefined
        ? { limit: DISCOVER_PAGE_LIMIT, page }
        : {
            limit: DISCOVER_PAGE_LIMIT,
            page,
            wsids: [inputs.workspaceId],
          };
    const response = await inputs.client.raw<unknown>(query, variables, {
      operationName:
        inputs.workspaceId === undefined
          ? 'DevDiscoverBoards'
          : 'DevDiscoverBoardsScoped',
    });
    lastComplexity = response.complexity;
    const parsed = unwrapOrThrow(
      rawDiscoverBoardsResponseSchema.safeParse(response.data),
      {
        context: 'Monday `boards()` response (dev discover walker)',
        hint: 'Monday may have amended the `boards()` selection set — re-probe via `scripts/probe/m26-dev-discover.ts` and amend the walker schema if so',
      },
    );
    const rows = (parsed.boards ?? []).filter(
      (b): b is z.infer<typeof rawDiscoverBoardRowSchema> => b !== null,
    );
    for (const row of rows) {
      // Filter `type !== 'board'`: drops `sub_items_board` virtual
      // entries (Monday auto-generates `Subitems of <BoardName>` for
      // any board with subitems enabled), `custom_object` (Monday's
      // custom-object surface), and `document` (Monday workdocs).
      // Empirical-probe finding pinned at 2026-05-11; see the
      // module docstring for the full rationale.
      if (row.type !== 'board') continue;
      candidates.push({
        id: row.id,
        name: row.name,
        workspace_id: row.workspace_id,
      });
    }
    if (rows.length < DISCOVER_PAGE_LIMIT) break;
    page += 1;
    if (page > DISCOVER_PAGE_CAP) break;
  }
  const matches = groupCandidatesByDevNoun(candidates);
  return {
    candidates,
    matches,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: lastComplexity,
  };
};

/**
 * Inputs to {@link runDevDoctor}.
 */
export interface RunDevDoctorInputs {
  readonly client: MondayClient;
  readonly profile: string;
  readonly mapping: DevMapping;
}

/**
 * Result of {@link runDevDoctor}. Mirrors the {@link DevDoctorOutput}
 * envelope minus the action-owned `profile` + `mapping` echo (the
 * action body re-echoes these from its own inputs so the doctor
 * resolver stays narrow). `source` / `cacheAgeSeconds` /
 * `complexity` mirror the M23 envelope-meta pin.
 */
export interface RunDevDoctorResult {
  readonly checks: readonly DevDoctorCheckResult[];
  readonly summary: DevDoctorOutput['summary'];
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Internal wire-row shape for the doctor's per-board hydration call.
 * Carries the columns + state needed for the 10 pinned checks.
 */
const rawDoctorColumnSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    type: z.string(),
    settings_str: z.string().nullable(),
  })
  .loose();

const rawDoctorBoardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    columns: z.array(rawDoctorColumnSchema.nullable()).nullable(),
  })
  .loose();

const rawDoctorResponseSchema = z
  .object({
    boards: z.array(rawDoctorBoardSchema.nullable()).nullable(),
  })
  .loose();

type RawDoctorBoard = z.infer<typeof rawDoctorBoardSchema>;
type RawDoctorColumn = z.infer<typeof rawDoctorColumnSchema>;

/**
 * Canonical status-column labels Monday's stock Tasks template
 * surfaces. Used by the `tasks_status_labels_canonical` check to
 * warn when the configured tasks board's status column has drifted
 * from the stock label set. Case-folded match per the heuristic's
 * NFC convention.
 */
const CANONICAL_STATUS_LABELS = ['Done', 'Working on it', 'Stuck'] as const;

/**
 * Date-column types the `sprints_date_columns_present` check
 * accepts as a valid sprint date-range column. `timeline` is a
 * single-column date-range; `date` covers split start/end columns.
 */
const SPRINT_DATE_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'date',
  'timeline',
]);

const findBoardById = (
  boards: readonly RawDoctorBoard[],
  id: string | undefined,
): RawDoctorBoard | undefined => {
  if (id === undefined) return undefined;
  return boards.find((b) => b.id === id);
};

const liveColumns = (board: RawDoctorBoard): readonly RawDoctorColumn[] =>
  (board.columns ?? []).filter((c): c is RawDoctorColumn => c !== null);

const okResult = (
  name: DevDoctorCheckName,
  message: string,
  details: Readonly<Record<string, unknown>> | null = null,
): DevDoctorCheckResult => ({ name, status: 'ok', message, details });

const warnResult = (
  name: DevDoctorCheckName,
  message: string,
  details:
    | Readonly<{ reason?: DevDoctorReason } & Record<string, unknown>>
    | null = null,
): DevDoctorCheckResult => ({ name, status: 'warn', message, details });

// Codex M26a IMPL round-2 P2-1: failResult now REQUIRES a
// `reason: DevDoctorReason` field so TypeScript enforces the
// pinned enum at every fail emit site (was previously runtime-only
// via superRefine). The check's contract is "every failure has a
// stable, agent-keyable reason".
const failResult = (
  name: DevDoctorCheckName,
  message: string,
  details: Readonly<{ reason: DevDoctorReason } & Record<string, unknown>>,
): DevDoctorCheckResult => ({ name, status: 'fail', message, details });

/**
 * `<noun>_board_exists` family. Verifies a mapping slot is set AND
 * the configured board ID resolves to an accessible board via the
 * `boards(ids:)` hydration. `ok` when the board exists and is
 * active; `warn` when archived (still usable but flagged for
 * agent review); `fail` when the slot is unset, the board ID
 * returned null (deleted / inaccessible), or the board state is
 * `deleted`.
 */
const checkBoardExists = (
  name: DevDoctorCheckName,
  slotName: keyof DevMapping,
  mapping: DevMapping,
  boards: readonly RawDoctorBoard[],
): DevDoctorCheckResult => {
  const boardId = mapping[slotName];
  if (boardId === undefined) {
    return failResult(
      name,
      `${slotName} not configured for this profile`,
      {
        slot: slotName,
        reason: 'not_in_mapping',
        hint: `set the slot via \`monday dev configure --${slotName.replace('_board', '-board')} <bid>\` or \`monday dev discover --apply\``,
      },
    );
  }
  const board = findBoardById(boards, boardId);
  if (board === undefined) {
    return failResult(
      name,
      `${slotName} (${boardId}) is not accessible — board deleted, access revoked, or board never existed`,
      {
        slot: slotName,
        board_id: boardId,
        reason: 'not_accessible',
        hint: 're-run `monday dev discover` to pick up the current workspace shape',
      },
    );
  }
  if (board.state === 'archived') {
    return warnResult(
      name,
      `${slotName} (${boardId}) is archived — dev verbs will still resolve against it`,
      {
        slot: slotName,
        board_id: boardId,
        board_name: board.name,
        state: 'archived',
      },
    );
  }
  if (board.state === 'deleted') {
    return failResult(
      name,
      `${slotName} (${boardId}) is in state 'deleted'`,
      {
        slot: slotName,
        board_id: boardId,
        board_name: board.name,
        state: 'deleted',
        reason: 'board_deleted',
      },
    );
  }
  return okResult(name, `${slotName} (${boardId}) exists and is accessible`, {
    slot: slotName,
    board_id: boardId,
    board_name: board.name,
    state: board.state,
  });
};

/**
 * `tasks_status_column_present` — verifies the configured tasks
 * board has a column of type `status` or `color` (Monday's two
 * label-shaped column types). `fail` when no tasks board is
 * configured / accessible OR the board has no status-shaped
 * column.
 */
const checkTasksStatusColumnPresent = (
  mapping: DevMapping,
  boards: readonly RawDoctorBoard[],
): DevDoctorCheckResult => {
  const name: DevDoctorCheckName = 'tasks_status_column_present';
  const tasks = findBoardById(boards, mapping.tasks_board);
  if (tasks === undefined) {
    return failResult(name, 'tasks board not configured or not accessible', {
      reason: 'no_tasks_board',
      hint: 'fix `tasks_board_exists` first (see check above)',
    });
  }
  const statusColumn = liveColumns(tasks).find(
    (c) => c.type === 'status' || c.type === 'color',
  );
  if (statusColumn === undefined) {
    return failResult(
      name,
      `tasks board (${tasks.id}) has no status-shaped column`,
      {
        board_id: tasks.id,
        reason: 'no_status_column',
        hint: 'add a Status column to the tasks board, or re-run `monday dev discover` if you intended a different board',
      },
    );
  }
  return okResult(
    name,
    `tasks board (${tasks.id}) has status column \`${statusColumn.id}\``,
    {
      board_id: tasks.id,
      column_id: statusColumn.id,
      column_title: statusColumn.title,
      column_type: statusColumn.type,
    },
  );
};

const parseStatusLabels = (
  settingsStr: string | null,
): readonly string[] | null => {
  if (settingsStr === null || settingsStr.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const labels = (parsed as { labels?: unknown }).labels;
  if (labels === null || labels === undefined || typeof labels !== 'object') {
    return null;
  }
  return Object.values(labels as Record<string, unknown>)
    .filter((v): v is string => typeof v === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

/**
 * `tasks_status_labels_canonical` — verifies the tasks board's
 * status column carries Monday Dev's stock labels (`Done` / `Working
 * on it` / `Stuck`). `warn` when one or more canonical labels are
 * missing; `ok` when all three are present.
 */
const checkTasksStatusLabelsCanonical = (
  mapping: DevMapping,
  boards: readonly RawDoctorBoard[],
): DevDoctorCheckResult => {
  const name: DevDoctorCheckName = 'tasks_status_labels_canonical';
  const tasks = findBoardById(boards, mapping.tasks_board);
  if (tasks === undefined) {
    return failResult(name, 'tasks board not configured or not accessible', {
      reason: 'no_tasks_board',
    });
  }
  const statusColumn = liveColumns(tasks).find(
    (c) => c.type === 'status' || c.type === 'color',
  );
  if (statusColumn === undefined) {
    return failResult(
      name,
      `tasks board (${tasks.id}) has no status-shaped column`,
      {
        board_id: tasks.id,
        reason: 'no_status_column',
      },
    );
  }
  const labels = parseStatusLabels(statusColumn.settings_str);
  if (labels === null) {
    return warnResult(
      name,
      `status column \`${statusColumn.id}\` has unparseable settings_str`,
      {
        board_id: tasks.id,
        column_id: statusColumn.id,
        reason: 'settings_unparseable',
      },
    );
  }
  const normalised = new Set(labels.map((l) => l.toLocaleLowerCase('und')));
  const missing = CANONICAL_STATUS_LABELS.filter(
    (l) => !normalised.has(l.toLocaleLowerCase('und')),
  );
  if (missing.length > 0) {
    return warnResult(
      name,
      `status column \`${statusColumn.id}\` is missing canonical labels: ${missing.join(', ')}`,
      {
        board_id: tasks.id,
        column_id: statusColumn.id,
        present_labels: labels,
        missing_labels: missing,
        hint: 'add the missing labels via the Monday UI, or update your workflow to use the labels this column carries',
      },
    );
  }
  return okResult(
    name,
    `status column \`${statusColumn.id}\` has all canonical labels`,
    {
      board_id: tasks.id,
      column_id: statusColumn.id,
      labels,
    },
  );
};

/**
 * `sprints_date_columns_present` — verifies the sprints board has a
 * date-range column (a `timeline` column or split `date` start/end
 * columns) so the sprint-state filter on `dev sprint list --state`
 * can derive active / past / future from the date range.
 */
const checkSprintsDateColumnsPresent = (
  mapping: DevMapping,
  boards: readonly RawDoctorBoard[],
): DevDoctorCheckResult => {
  const name: DevDoctorCheckName = 'sprints_date_columns_present';
  const sprints = findBoardById(boards, mapping.sprints_board);
  if (sprints === undefined) {
    return failResult(name, 'sprints board not configured or not accessible', {
      reason: 'no_sprints_board',
    });
  }
  const dateColumns = liveColumns(sprints).filter((c) =>
    SPRINT_DATE_COLUMN_TYPES.has(c.type),
  );
  if (dateColumns.length === 0) {
    return failResult(
      name,
      `sprints board (${sprints.id}) has no date-range column (need at least one of: timeline, date)`,
      {
        board_id: sprints.id,
        reason: 'no_date_columns',
        hint: 'add a Timeline column to the sprints board for date-range-derived sprint state',
      },
    );
  }
  const timeline = dateColumns.find((c) => c.type === 'timeline');
  if (timeline !== undefined) {
    return okResult(
      name,
      `sprints board (${sprints.id}) has timeline column \`${timeline.id}\``,
      {
        board_id: sprints.id,
        column_id: timeline.id,
        column_type: 'timeline',
      },
    );
  }
  const dateCols = dateColumns.filter((c) => c.type === 'date');
  if (dateCols.length < 2) {
    return warnResult(
      name,
      `sprints board (${sprints.id}) has only ${String(dateCols.length)} date column(s); need either a timeline column or split start/end date columns`,
      {
        board_id: sprints.id,
        date_column_ids: dateCols.map((c) => c.id),
        hint: 'add a second date column for the sprint end date, or migrate to a timeline column',
      },
    );
  }
  return okResult(
    name,
    `sprints board (${sprints.id}) has ${String(dateCols.length)} date columns (start/end)`,
    {
      board_id: sprints.id,
      date_column_ids: dateCols.map((c) => c.id),
    },
  );
};

const parseBoardRelationTargets = (
  settingsStr: string | null,
): readonly string[] | null => {
  if (settingsStr === null || settingsStr.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(settingsStr);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const ids = (parsed as { boardIds?: unknown; board_ids?: unknown }).boardIds
    ?? (parsed as { board_ids?: unknown }).board_ids;
  if (!Array.isArray(ids)) return null;
  return ids
    .map((v): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''))
    .filter((s): s is string => s.length > 0);
};

/**
 * `tasks_to_<target>_relation` family. Verifies the tasks board has
 * a `board_relation` column whose `settings_str` references the
 * target board's ID.
 */
const checkBoardRelation = (
  name: DevDoctorCheckName,
  targetSlot: keyof DevMapping,
  mapping: DevMapping,
  boards: readonly RawDoctorBoard[],
): DevDoctorCheckResult => {
  const tasks = findBoardById(boards, mapping.tasks_board);
  if (tasks === undefined) {
    return failResult(name, 'tasks board not configured or not accessible', {
      reason: 'no_tasks_board',
    });
  }
  const targetBoardId = mapping[targetSlot];
  if (targetBoardId === undefined) {
    return failResult(
      name,
      `${targetSlot} not configured — cannot verify board_relation wiring`,
      {
        target_slot: targetSlot,
        reason: 'no_target_board',
      },
    );
  }
  const relationColumns = liveColumns(tasks).filter(
    (c) => c.type === 'board_relation',
  );
  if (relationColumns.length === 0) {
    return failResult(
      name,
      `tasks board (${tasks.id}) has no board_relation columns`,
      {
        board_id: tasks.id,
        target_slot: targetSlot,
        target_board_id: targetBoardId,
        reason: 'no_relation_column',
        hint: 'add a Connect Boards column on the tasks board pointing to the target board',
      },
    );
  }
  for (const col of relationColumns) {
    const targets = parseBoardRelationTargets(col.settings_str);
    if (targets?.includes(targetBoardId) === true) {
      return okResult(
        name,
        `tasks board (${tasks.id}) column \`${col.id}\` links to ${targetSlot} (${targetBoardId})`,
        {
          board_id: tasks.id,
          column_id: col.id,
          target_slot: targetSlot,
          target_board_id: targetBoardId,
        },
      );
    }
  }
  return failResult(
    name,
    `no board_relation column on tasks board (${tasks.id}) links to ${targetSlot} (${targetBoardId})`,
    {
      board_id: tasks.id,
      target_slot: targetSlot,
      target_board_id: targetBoardId,
      relation_column_ids: relationColumns.map((c) => c.id),
      reason: 'no_matching_relation',
      hint: `update one of the relation columns to target board ${targetBoardId}, or run \`monday dev configure --${targetSlot.replace('_board', '-board')} <correct-bid>\``,
    },
  );
};

/**
 * Hydrates every configured board in `mapping` via a single
 * `boards(ids:)` call so the doctor checks operate over in-memory
 * data without extra round-trips. Returns `complexity: null` when
 * no boards are configured (no wire call made).
 */
const hydrateDoctorBoards = async (
  client: MondayClient,
  mapping: DevMapping,
): Promise<{
  readonly boards: readonly RawDoctorBoard[];
  readonly complexity: Complexity | null;
}> => {
  const configuredIds = Array.from(
    new Set(
      Object.values(mapping).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    ),
  );
  if (configuredIds.length === 0) {
    return { boards: [], complexity: null };
  }
  const response = await client.raw<unknown>(
    `query DevDoctorBoards($ids: [ID!]!) {
       boards(ids: $ids, state: all) {
         id name state
         columns { id title type settings_str }
       }
     }`,
    { ids: configuredIds },
    { operationName: 'DevDoctorBoards' },
  );
  const parsed = unwrapOrThrow(
    rawDoctorResponseSchema.safeParse(response.data),
    {
      context: 'Monday `boards(ids:)` response (dev doctor)',
      hint: 'Monday may have amended the `boards(ids:)` selection set — re-probe and amend the doctor schema if so',
    },
  );
  const boards = (parsed.boards ?? []).filter(
    (b): b is RawDoctorBoard => b !== null,
  );
  return { boards, complexity: response.complexity };
};

/**
 * Runs every {@link DEV_DOCTOR_CHECK_NAMES} check against the
 * `inputs.mapping`. Returns a per-check result list + a summary
 * count. One `boards(ids:)` call hydrates every configured board's
 * metadata; the 10 checks operate over the hydrated data.
 *
 * The verb's exit code stays 0 regardless of per-check `fail`
 * counts — `dev doctor`'s success is "diagnostics completed";
 * agents inspect `data.summary.fail_count` for drift.
 * `dev_board_misconfigured` is reserved for the case where the
 * doctor itself can't complete (no boards hydrated at all, etc.) —
 * not surfaced here at this milestone (no configured boards = empty
 * mapping = every `<noun>_board_exists` check fails, which is the
 * correct diagnostic signal).
 */
export const runDevDoctor = async (
  inputs: RunDevDoctorInputs,
): Promise<RunDevDoctorResult> => {
  const { boards, complexity } = await hydrateDoctorBoards(
    inputs.client,
    inputs.mapping,
  );
  const checks: DevDoctorCheckResult[] = [];
  for (const name of DEV_DOCTOR_CHECK_NAMES) {
    switch (name) {
      case 'tasks_board_exists':
        checks.push(checkBoardExists(name, 'tasks_board', inputs.mapping, boards));
        break;
      case 'tasks_status_column_present':
        checks.push(checkTasksStatusColumnPresent(inputs.mapping, boards));
        break;
      case 'tasks_status_labels_canonical':
        checks.push(checkTasksStatusLabelsCanonical(inputs.mapping, boards));
        break;
      case 'sprints_board_exists':
        checks.push(checkBoardExists(name, 'sprints_board', inputs.mapping, boards));
        break;
      case 'sprints_date_columns_present':
        checks.push(checkSprintsDateColumnsPresent(inputs.mapping, boards));
        break;
      case 'epics_board_exists':
        checks.push(checkBoardExists(name, 'epics_board', inputs.mapping, boards));
        break;
      case 'releases_board_exists':
        checks.push(checkBoardExists(name, 'releases_board', inputs.mapping, boards));
        break;
      case 'bugs_board_exists':
        checks.push(checkBoardExists(name, 'bugs_board', inputs.mapping, boards));
        break;
      case 'tasks_to_sprints_relation':
        checks.push(checkBoardRelation(name, 'sprints_board', inputs.mapping, boards));
        break;
      case 'tasks_to_epics_relation':
        checks.push(checkBoardRelation(name, 'epics_board', inputs.mapping, boards));
        break;
    }
  }
  const summary = {
    ok_count: checks.filter((c) => c.status === 'ok').length,
    warn_count: checks.filter((c) => c.status === 'warn').length,
    fail_count: checks.filter((c) => c.status === 'fail').length,
  };
  return { checks, summary, source: 'live', cacheAgeSeconds: null, complexity };
};

/**
 * Reads the active profile's `[profiles.<name>.dev]` block. Throws
 * `dev_not_configured` when:
 *   - no `config.toml` exists at all (`details.reason:
 *     "no_config_file"`),
 *   - the named profile is absent from the config
 *     (`details.reason: "profile_absent"`), OR
 *   - the named profile exists but has no `dev` sub-block
 *     (`details.reason: "no_dev_block"`).
 *
 * Each surface points the agent at `monday dev configure` /
 * `monday dev discover --apply` via `details.hint`.
 */
export const loadDevMapping = async (
  profile: string,
  options: ProfilesRootOptions = {},
): Promise<DevMapping> => {
  const config = await loadProfilesConfig(options);
  if (config === undefined) {
    throw new ApiError(
      'dev_not_configured',
      `Monday Dev mapping not configured for profile \`${profile}\` — no \`~/.monday-cli/config.toml\``,
      {
        details: {
          profile,
          reason: 'no_config_file',
          hint: 'run `monday dev discover --apply` to auto-detect Monday Dev boards, or `monday dev configure --tasks-board <bid> ...` to set them explicitly',
        },
      },
    );
  }
  const entry = config.profiles[profile];
  if (entry === undefined) {
    throw new ApiError(
      'dev_not_configured',
      `Monday Dev mapping not configured for profile \`${profile}\` — profile absent from \`config.toml\``,
      {
        details: {
          profile,
          reason: 'profile_absent',
          available_profiles: Object.keys(config.profiles),
          hint: 'create the profile via `monday auth login --profile <name>`, or run `monday dev configure --profile <name> ...`',
        },
      },
    );
  }
  if (entry.dev === undefined) {
    throw new ApiError(
      'dev_not_configured',
      `Monday Dev mapping not configured for profile \`${profile}\` — no \`[profiles.${profile}.dev]\` block`,
      {
        details: {
          profile,
          reason: 'no_dev_block',
          hint: 'run `monday dev discover --apply` to auto-detect, or `monday dev configure --tasks-board <bid> ...` to set explicit mappings',
        },
      },
    );
  }
  return entry.dev;
};

/** Filesystem mode constant for the config.toml file — mirrors
 * credentials.ts's discipline (`.claude/rules/security.md`): files
 * under `~/.monday-cli/` carry user-scoped data even when not
 * directly token-bearing, so 0600 is the conservative default.
 */
const CONFIG_FILE_MODE = 0o600;

/**
 * Atomically writes the supplied `mapping` into
 * `profiles[profile].dev` in `~/.monday-cli/config.toml`. Creates
 * the file (and the named profile entry) if absent.
 *
 * **TOML round-trip behavior.** `smol-toml`'s `stringify` produces
 * canonical TOML output — comments and bespoke formatting from the
 * original file are NOT preserved. This is a contract correction
 * vs the M26 pre-flight docstring claim (to be flagged in the
 * M26a close-docs sweep's post-mortem). Mitigation: most config.toml
 * files are CLI-managed (`monday auth login` populates the
 * credentials side; this helper populates the dev side), so the
 * comment-preservation concern is narrow. A future v0.4 string-
 * surgery write path could preserve comments outside the dev block
 * if user demand surfaces.
 *
 * **Disk discipline (mirrors `src/config/credentials.ts`):**
 *   1. `mkdir({ recursive: true, mode: 0o700 })` + explicit `chmod
 *      0o700` on the parent dir.
 *   2. `writeFile(tmpPath, payload, { mode: 0o600 })`.
 *   3. `chmod(tmpPath, 0o600)` (re-applied since `writeFile`'s
 *      `mode` is advisory under umask).
 *   4. `rename(tmpPath, finalPath)` (atomic on the same filesystem).
 *
 * **Idempotent:** re-writing the same mapping produces the same
 * bytes (modulo formatting). When `mapping` carries every existing
 * slot at the same value, the write is functionally a no-op.
 */
export const saveDevMapping = async (
  profile: string,
  mapping: DevMapping,
  options: ProfilesRootOptions = {},
): Promise<void> => {
  // Load existing config (or start fresh with empty profiles map).
  const existing = await loadProfilesConfig(options);
  const baseConfig: ProfilesConfig =
    existing ?? { profiles: {} };

  // Merge the dev block into the named profile entry. Preserves
  // every non-dev slot on the profile (api_token_env, api_version,
  // default_workspace, timezone) and every other profile in the
  // config file.
  const existingEntry: ProfileEntry =
    baseConfig.profiles[profile] ?? {};
  const nextEntry: ProfileEntry = {
    ...existingEntry,
    dev: mapping,
  };
  const nextConfig: ProfilesConfig = {
    ...baseConfig,
    profiles: {
      ...baseConfig.profiles,
      [profile]: nextEntry,
    },
  };

  // Re-validate the full config before write so a caller passing a
  // malformed mapping (bypassing the per-field BoardIdSchema at the
  // argv layer) can't slip a bad file onto disk.
  const validated = profilesConfigSchema.parse(nextConfig);

  const fullPath = resolveProfilesConfigPath(options);
  const dir = join(options.home ?? homedir(), PROFILES_DIR_NAME);

  // Ensure secure directory (mirrors credentials.ts).
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  } catch (err) {
    // Disk-full / permissions-denied path; not reproducible from a
    // unit test against a tmp dir.
    /* c8 ignore start */
    throw new ConfigError(`cannot prepare config directory ${dir}`, {
      cause: asError(err),
      details: { path: dir },
    });
    /* c8 ignore stop */
  }

  const payload = stringifyToml(validated);
  const tmpPath = `${fullPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, payload, { mode: CONFIG_FILE_MODE });
    await chmod(tmpPath, CONFIG_FILE_MODE);
    await rename(tmpPath, fullPath);
  } catch (err) {
    // Disk-full / atomic-rename failure path; not reproducible from
    // a unit test against a tmp dir.
    /* c8 ignore start */
    await unlink(tmpPath).catch(() => undefined);
    throw new ConfigError(`cannot write config file ${fullPath}`, {
      cause: asError(err),
      details: { path: fullPath },
    });
    /* c8 ignore stop */
  }
};

// =============================================================
// M26b workflow-verb helpers — shared between dev sprint/epic/
// release/task verbs (cli-design §5.9 + §11.3; v0.3-plan §3 M26).
//
// The M26b verbs hydrate the configured dev board(s) by ID, walk
// items_page on them, resolve board_relation columns + canonical
// status labels — same shape recurring across verbs. Lifted here
// rather than the per-verb files so the wire-call surface lives
// one module away from the action body.
// =============================================================

/**
 * Sprint date-range state literal — `active` (today within range),
 * `past` (range ended before today), `future` (range starts after
 * today). Surfaced as the argv shape for `dev sprint list --state`
 * + the classification output of {@link classifySprint}.
 *
 * R-NEW-38 lift (post-M26b drift sweep): hoisted from
 * `commands/dev/sprint/list.ts:_internals` after the 3-consumer
 * threshold fired across `sprint/list.ts` + `sprint/current.ts` +
 * `task/list.ts` (the verb-file-to-verb-file cross-import via
 * `_internals` was the anti-pattern that surfaced the lift).
 */
export const SPRINT_STATE_LITERALS = ['active', 'past', 'future'] as const;
export type SprintState = (typeof SPRINT_STATE_LITERALS)[number];

/**
 * Parses a YYYY-MM-DD string into an epoch-ms day boundary (UTC).
 * NaN-guards per the M24 round-2 P3-1 precedent (`4c83860`) —
 * returns `null` on an unparseable / malformed date so the caller
 * falls through to the `past` default rather than emitting NaN-
 * shaped state buckets.
 */
export const dayEpoch = (raw: string | null | undefined): number | null => {
  if (raw === null || raw === undefined || raw.length === 0) return null;
  // Truncate any time component — Monday's date columns carry just
  // YYYY-MM-DD; timeline columns carry plain YYYY-MM-DD too.
  const head = raw.slice(0, 10);
  const epoch = Date.parse(`${head}T00:00:00Z`);
  if (Number.isNaN(epoch)) return null;
  return epoch;
};

export interface SprintDateRange {
  readonly start: number;
  readonly end: number;
}

const firstDate = (col: ProjectedColumn | undefined): string | null => {
  if (col === undefined) return null;
  return typeof col.date === 'string' ? col.date : null;
};

/**
 * Extracts a sprint's date range from its projected columns. Prefers
 * a `timeline` column (parses `value.from` / `value.to`); falls back
 * to the first two `date` columns sorted by id (single date column
 * = single-day range; reversed start/end auto-normalised by epoch).
 * Returns `null` when no usable date columns are present.
 */
export const extractDateRange = (
  item: ProjectedItem,
): SprintDateRange | null => {
  const cols = Object.values(item.columns);
  // Prefer the timeline column when present.
  const timeline = cols.find((c) => c.type === 'timeline');
  if (timeline !== undefined && timeline.value !== null && typeof timeline.value === 'object') {
    const v = timeline.value as { from?: unknown; to?: unknown };
    const start = typeof v.from === 'string' ? dayEpoch(v.from) : null;
    const end = typeof v.to === 'string' ? dayEpoch(v.to) : null;
    if (start !== null && end !== null) {
      return { start, end };
    }
  }
  // Fall back to date columns (sorted by id for deterministic
  // start/end assignment).
  const dateCols = cols
    .filter((c) => c.type === 'date')
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
  const firstEpoch = dateCols.length > 0
    ? dayEpoch(firstDate(dateCols[0]))
    : null;
  const secondEpoch = dateCols.length > 1
    ? dayEpoch(firstDate(dateCols[1]))
    : null;
  if (firstEpoch === null) return null;
  if (secondEpoch === null) {
    // Single date column = single-day "range".
    return { start: firstEpoch, end: firstEpoch };
  }
  // Order-normalise — lowest epoch is start regardless of column id
  // order (a user who named columns "end_date" / "start_date" would
  // otherwise get reversed ranges).
  if (secondEpoch < firstEpoch) {
    return { start: secondEpoch, end: firstEpoch };
  }
  return { start: firstEpoch, end: secondEpoch };
};

/**
 * Classifies a sprint's state from its date range + the current
 * day's epoch. Sprints without a resolvable date range default to
 * `past` so a `--state past` filter catches misconfigured rows
 * (the structural drift is diagnosed via `dev doctor`'s
 * `sprints_date_columns_present` check; no warning code).
 */
export const classifySprint = (
  range: SprintDateRange | null,
  todayEpoch: number,
): SprintState => {
  if (range === null) return 'past';
  if (todayEpoch < range.start) return 'future';
  if (todayEpoch > range.end) return 'past';
  return 'active';
};

/**
 * True iff the `details.issues` array carries exactly the
 * `boards`/`too_small` zod issue `fetchItemsPage`'s `.min(1)` schema
 * raises on an empty `boards` response. Used by
 * {@link walkDevBoardItems} to narrow the `internal_error` →
 * `dev_board_misconfigured` rewrap to the specific runtime mapping
 * drift surface; other schema-drift parse failures (e.g. Monday
 * adding a required field we haven't modeled) keep their original
 * `internal_error` + `details.issues` shape (Codex round-2 P2-1 fix).
 */
const isEmptyBoardsArrayIssue = (
  details: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  const issues = (details as { issues?: unknown } | undefined)?.issues;
  if (!Array.isArray(issues)) return false;
  return issues.some((issue: unknown): boolean => {
    if (typeof issue !== 'object' || issue === null) return false;
    const i = issue as { path?: unknown; code?: unknown };
    return i.path === 'boards' && i.code === 'too_small';
  });
};

/**
 * Walks every page of `items_page` on the supplied board and projects
 * the rows through the M4 {@link projectItem} contract. Used by the
 * read-side dev workflow verbs (`dev sprint list/items/current`,
 * `dev epic list/items`, `dev release list`, `dev task list`).
 *
 * Skips board-metadata cache loading — dev verbs don't expose
 * `--columns` selection, and the items_page rows include
 * `column { title }` per the {@link ITEM_FIELDS_FRAGMENT}, so the
 * fallback title path on {@link projectItem} is sufficient. Returns
 * the `complexity` from the *last* response so the verb's success
 * envelope reflects the freshest budget snapshot per `cli-design.md`
 * §6.1 — mirrors the {@link paginate} walker's idiom.
 */
export const walkDevBoardItems = async (inputs: {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly operationName: string;
  readonly queryParams?: Readonly<Record<string, unknown>>;
  readonly now: () => Date;
}): Promise<{
  readonly items: readonly ProjectedItem[];
  readonly complexity: Complexity | null;
}> => {
  let result;
  try {
    result = await paginate<unknown, ItemsPagePayload<unknown>>({
      fetchInitial: (effectiveLimit) =>
        fetchItemsPage<unknown>({
          client: inputs.client,
          operationName: inputs.operationName,
          boardId: inputs.boardId,
          limit: effectiveLimit,
          queryParams: inputs.queryParams,
          itemFields: ITEM_FIELDS_FRAGMENT,
          itemSchema: walkerItemSchema,
        }),
      fetchNext: (cursor, effectiveLimit) =>
        fetchNextItemsPage<unknown>({
          client: inputs.client,
          operationName: `${inputs.operationName}Next`,
          cursor,
          limit: effectiveLimit,
          itemFields: ITEM_FIELDS_FRAGMENT,
          itemSchema: walkerItemSchema,
        }),
      extractPage: (r) => r.data,
      getId: idFromRawItem,
      all: true,
      now: inputs.now,
    });
  } catch (err) {
    // Codex M26b IMPL round-1 P2-2 + round-2 P2-1: an inaccessible
    // dev board (deleted / access revoked / never existed) returns
    // `{boards: []}`, which `fetchItemsPage`'s `.min(1)` schema rejects
    // as malformed → bare `internal_error`. For a dev workflow read
    // that's runtime mapping drift; rewrap to the namespace-stable
    // `dev_board_misconfigured` with `reason: 'not_accessible'`,
    // mirroring `hydrateDevBoardColumns`'s shape so the per-verb error
    // surface is consistent across read + mutation paths.
    //
    // **Narrowed to the exact `boards`/`too_small` zod issue** (round-2
    // P2-1 fix) so genuine schema drift on the items_page payload
    // (e.g. Monday adding a required field we haven't modeled) still
    // surfaces as `internal_error` with the full `details.issues`
    // array intact — without the narrowing, ANY parse failure carrying
    // this board's `board_id` would have collapsed into a misleading
    // `not_accessible` rewrap that drops the failing field path.
    if (
      err instanceof ApiError &&
      err.code === 'internal_error' &&
      (err.details as { board_id?: unknown } | undefined)?.board_id ===
        inputs.boardId &&
      isEmptyBoardsArrayIssue(err.details)
    ) {
      throw new ApiError(
        'dev_board_misconfigured',
        `board ${inputs.boardId} is not accessible — deleted, access revoked, or never existed`,
        {
          cause: err,
          details: {
            board_id: inputs.boardId,
            reason: 'not_accessible',
            hint: 'run `monday dev doctor` to diagnose, then re-run `monday dev discover --apply` or `monday dev configure` to update the mapping',
          },
        },
      );
    }
    throw err;
  }
  const items = result.items.map(
    (raw) => projectItem({ raw: parseRawItem(raw) }),
  );
  return { items, complexity: result.complexity };
};

const walkerItemSchema = z.unknown();

/**
 * Hydrates one board's `columns { id title type settings_str }` slot
 * via a single `boards(ids:)` call. Used by mutation verbs
 * (`dev task start/done/block`) to resolve the status column ID +
 * label vocabulary, and by the relation-filter verbs
 * (`dev sprint items`, `dev epic items`) to find the board_relation
 * column linking the tasks board to a target.
 */
export const hydrateDevBoardColumns = async (
  client: MondayClient,
  boardId: string,
  operationName: string,
): Promise<{
  readonly columns: readonly RawDoctorColumn[];
  readonly complexity: Complexity | null;
}> => {
  const response = await client.raw<unknown>(
    `query ${operationName}($ids: [ID!]!) {
       boards(ids: $ids, state: all) {
         id
         columns { id title type settings_str }
       }
     }`,
    { ids: [boardId] },
    { operationName },
  );
  const parsed = unwrapOrThrow(
    rawDoctorResponseSchema.safeParse(response.data),
    {
      context: `Monday \`boards(ids:)\` response (${operationName})`,
      details: { board_id: boardId },
    },
  );
  const boards = (parsed.boards ?? []).filter(
    (b): b is RawDoctorBoard => b !== null,
  );
  if (boards.length === 0) {
    throw new ApiError(
      'dev_board_misconfigured',
      `board ${boardId} is not accessible — deleted, access revoked, or never existed`,
      {
        details: {
          board_id: boardId,
          reason: 'not_accessible',
          hint: 'run `monday dev doctor` to diagnose, then re-run `monday dev discover --apply` or `monday dev configure` to update the mapping',
        },
      },
    );
  }
  const board = boards[0];
  /* c8 ignore next 3 */
  if (board === undefined) {
    throw new ApiError('internal_error', `${operationName}: empty boards array`);
  }
  const columns = (board.columns ?? []).filter(
    (c): c is RawDoctorColumn => c !== null,
  );
  return { columns, complexity: response.complexity };
};

/**
 * Walks `columns` looking for a `board_relation` column whose
 * `settings_str.boardIds` (or `board_ids`) array includes
 * `targetBoardId`. Returns the first match or `undefined`.
 *
 * Same `settings_str` parse as the doctor's
 * `checkBoardRelation` — pinned at M26a IMPL. Lifted here for
 * reuse by `dev sprint items` and `dev epic items`.
 */
export const findRelationColumnIdToBoard = (
  columns: readonly { readonly id: string; readonly type: string; readonly settings_str: string | null }[],
  targetBoardId: string,
): string | undefined => {
  for (const col of columns) {
    if (col.type !== 'board_relation') continue;
    const targets = parseBoardRelationTargets(col.settings_str);
    if (targets?.includes(targetBoardId) === true) {
      return col.id;
    }
  }
  return undefined;
};

/**
 * Extracts linked item IDs (as decimal strings) from a board_relation
 * column's parsed `value` JSON. Monday's wire shape is one of:
 *   - `{linkedPulseIds: [{linkedPulseId: 123 | "123"}, ...]}`
 *   - `{item_ids: [123 | "123", ...]}` (newer 2026-01 shape)
 * Returns an empty array on null / malformed / unrecognised shape.
 */
export const extractLinkedItemIds = (value: unknown): readonly string[] => {
  if (value === null || typeof value !== 'object') return [];
  const v = value as Record<string, unknown>;
  const ids: string[] = [];
  const linkedPulse = v.linkedPulseIds;
  if (Array.isArray(linkedPulse)) {
    for (const entry of linkedPulse) {
      if (entry === null || typeof entry !== 'object') continue;
      const id = (entry as { linkedPulseId?: unknown }).linkedPulseId;
      if (typeof id === 'number') ids.push(String(id));
      else if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  const itemIds = v.item_ids;
  if (Array.isArray(itemIds)) {
    for (const id of itemIds) {
      if (typeof id === 'number') ids.push(String(id));
      else if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
};

/**
 * Finds the status (or color) column on a board. Returns the column
 * + the parsed labels (id → label text). Throws
 * `dev_board_misconfigured` with `reason: 'no_status_column'` when
 * no status column is present (mirrors the doctor's
 * `tasks_status_column_present` fail surface; if doctor passes, this
 * lookup also passes).
 */
export const resolveStatusColumn = (
  boardId: string,
  columns: readonly RawDoctorColumn[],
): {
  readonly columnId: string;
  readonly labels: ReadonlyMap<string, string>;
} => {
  const col = columns.find((c) => c.type === 'status' || c.type === 'color');
  if (col === undefined) {
    throw new ApiError(
      'dev_board_misconfigured',
      `board ${boardId} has no status column`,
      {
        details: {
          board_id: boardId,
          reason: 'no_status_column',
          hint: 'add a Status column to the tasks board, then re-run `monday dev doctor` to verify',
        },
      },
    );
  }
  const parsed = parseStatusLabels(col.settings_str);
  const map = new Map<string, string>();
  if (parsed !== null) {
    for (const label of parsed) {
      map.set(label.toLocaleLowerCase('und'), label);
    }
  }
  return { columnId: col.id, labels: map };
};

/**
 * Canonical status labels Monday Dev's stock Tasks template surfaces.
 * The three task mutation verbs (`dev task start/done/block`) flip
 * the status column to one of these. Exported for the
 * {@link flipTaskStatus} helper + the verbs that import the literal
 * union for argv shapes.
 */
export type DevTaskCanonicalLabel = 'Working on it' | 'Done' | 'Stuck';

/**
 * Resolves a canonical Monday Dev status label ("Working on it" /
 * "Done" / "Stuck") to the actual label text written on the
 * configured status column — case-insensitive match. Returns the
 * exact stored form so the subsequent
 * `change_simple_column_value` flips against bytes Monday accepts
 * (the wire is case-sensitive on the value).
 *
 * Throws `dev_board_misconfigured` with
 * `reason: 'no_status_column'` when the canonical label isn't
 * present on the column — points at `monday dev doctor` for
 * diagnostics. (Mirrors the doctor's
 * `tasks_status_labels_canonical` warn surface; the doctor's warn
 * doesn't block a workflow verb at the doctor layer, but the
 * workflow verb itself can't proceed without a matching label.)
 */
export const resolveCanonicalLabel = (
  boardId: string,
  columnId: string,
  labels: ReadonlyMap<string, string>,
  canonical: DevTaskCanonicalLabel,
): string => {
  const match = labels.get(canonical.toLocaleLowerCase('und'));
  if (match !== undefined) return match;
  throw new ApiError(
    'dev_board_misconfigured',
    `tasks board ${boardId} status column \`${columnId}\` has no \`${canonical}\` label`,
    {
      details: {
        board_id: boardId,
        column_id: columnId,
        reason: 'no_status_column',
        canonical_label: canonical,
        present_labels: Array.from(labels.values()),
        hint: `add the \`${canonical}\` label to the status column, or run \`monday dev doctor\` to inspect the configured labels`,
      },
    },
  );
};

/**
 * Flips a task's status column to the supplied canonical label
 * ("Working on it" / "Done" / "Stuck") on the configured tasks
 * board.
 *
 * **3-consumer helper.** `dev task start` + `dev task done` +
 * `dev task block` all share this exact shape (hydrate tasks board
 * columns → find status column → resolve canonical label → fire
 * `change_simple_column_value`). Lifted here at M26b IMPL so the
 * three verb files stay focused on their side-effects (start: none;
 * done: optional comment; block: required comment).
 *
 * Returns the post-mutation {@link ProjectedItem}, the resolved
 * status `columnId` + `label` for any caller that wants to log them,
 * and the `complexity` accumulated across the hydrate + mutation
 * calls (caller picks the freshest snapshot for envelope meta).
 */
/**
 * Wire-shape parser for the `create_update` mutation Monday returns
 * on `dev task done --message` + `dev task block --reason` side-
 * effects. Mirrors the parse-boundary discipline `src/commands/
 * update/create.ts` uses (`assertResponseFieldPresent` + zod parse)
 * so the side-effect's `update_id` lands typed rather than via the
 * compile-time-only `client.raw<T>` generic.
 *
 * Codex M26b IMPL round-1 P2-3 fix: prior to this helper, both task
 * verbs read `response.data.create_update.id` via an unparsed
 * generic, which would have surfaced a raw TypeError on a malformed
 * response (and silently accepted a missing `id` field as
 * `undefined`).
 */
const createUpdateResponseSchema = z
  .object({
    create_update: z
      .object({ id: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .loose();

export interface DevCreateUpdateResult {
  readonly updateId: string;
  readonly complexity: Complexity | null;
}

/**
 * Builds the `create_update` mutation document with the supplied
 * operation name embedded as the GraphQL named-operation. Codex
 * round-2 P1-1 fix: prior to this builder, the doc was statically
 * named `DevCreateUpdate` while the wire `operationName` was per-
 * verb (`DevTaskDoneCreateUpdate` / `DevTaskBlockCreateUpdate`).
 * GraphQL servers may reject mismatched operationName + named-op
 * pairs ("Operation 'DevTaskDoneCreateUpdate' not found"); making
 * the two agree at every call site removes the drift class.
 * Mirrors the static pattern `executeItemMutation` uses (constants
 * where doc name + operationName always match).
 */
const buildCreateUpdateMutation = (operationName: string): string => `
  mutation ${operationName}($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
    }
  }
`;

/**
 * Fires the `create_update` mutation for a dev task side-effect
 * (`task done --message` / `task block --reason`) and returns the
 * created update's ID + the wire complexity. Shared by both verbs
 * (3-consumer threshold not yet reached, but the parse-boundary
 * discipline matters at every site).
 *
 * Throws `internal_error` when Monday's response carries
 * `create_update: null` (the documented null-payload escape hatch
 * for failed update creation; mirrors M5b's `internal_error` shape
 * per `item-mutation-result.ts`'s `caller_handles` semantics).
 */
export const fireDevCreateUpdate = async (inputs: {
  readonly client: MondayClient;
  readonly itemId: string;
  readonly body: string;
  readonly operationName: string;
}): Promise<DevCreateUpdateResult> => {
  const response = await inputs.client.raw<unknown>(
    buildCreateUpdateMutation(inputs.operationName),
    { itemId: inputs.itemId, body: inputs.body },
    { operationName: inputs.operationName },
  );
  const parsed = unwrapOrThrow(
    createUpdateResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ${inputs.operationName} response`,
      details: { item_id: inputs.itemId },
    },
  );
  if (parsed.create_update === null) {
    throw new ApiError(
      'internal_error',
      `Monday returned no update payload from create_update for item ${inputs.itemId}`,
      { details: { item_id: inputs.itemId } },
    );
  }
  return {
    updateId: parsed.create_update.id,
    complexity: response.complexity,
  };
};

export const flipTaskStatus = async (inputs: {
  readonly client: MondayClient;
  readonly tasksBoard: string;
  readonly itemId: string;
  readonly canonical: DevTaskCanonicalLabel;
  readonly hydrateOperation: string;
}): Promise<{
  readonly projected: ProjectedItem;
  readonly columnId: string;
  readonly label: string;
  readonly complexity: Complexity | null;
}> => {
  const { columns, complexity: hydrateComplexity } = await hydrateDevBoardColumns(
    inputs.client,
    inputs.tasksBoard,
    inputs.hydrateOperation,
  );
  const { columnId, labels } = resolveStatusColumn(inputs.tasksBoard, columns);
  const label = resolveCanonicalLabel(
    inputs.tasksBoard,
    columnId,
    labels,
    inputs.canonical,
  );
  const mutation: SelectedMutation = {
    kind: 'change_simple_column_value',
    columnId,
    value: label,
  };
  const result = await executeItemMutation(inputs.client, {
    mutation,
    itemId: inputs.itemId,
    boardId: inputs.tasksBoard,
    createLabelsIfMissing: false,
  });
  return {
    projected: result.projected,
    columnId,
    label,
    complexity: result.response.complexity ?? hydrateComplexity,
  };
};

