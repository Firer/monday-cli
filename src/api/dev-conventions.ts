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
 *      against board names so it ships testable at pre-flight even
 *      though the runtime fetchers don't (M26 IMPL lands the
 *      `boards(workspace_id:)` walker + per-board metadata
 *      hydration).
 *   4. Stub runtime fetchers: {@link discoverDevBoards} (lists
 *      workspace boards + matches via the heuristic) +
 *      {@link runDevDoctor} (validates the active profile's mapping
 *      against current board shape). Both reject with `internal_error`
 *      under `c8 ignore start/stop` block-wraps; M26 IMPL drops the
 *      wraps + lands the wire bodies. Mirrors the M24 history-
 *      projection + M25 partial-success-bulk pre-flight precedent
 *      (`bad98ba` / `d5839a9`).
 *
 * **What this module does NOT own.**
 *
 *   - Profile-config IO (read / write the TOML file). Lives in
 *     `src/config/profiles.ts` per v0.3-M21. The dev-namespace
 *     verbs call `loadProfilesConfig` + `writeProfileDevBlock`
 *     (the latter lands at M26 IMPL alongside `dev configure`'s
 *     runtime body) — both belong in the config layer.
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

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import {
  profileDevBlockSchema,
  type ProfileDevBlock,
} from '../config/profiles.js';
import type { MondayClient } from './client.js';

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
 * `tasks` and `bugs` — the heuristic surfaces an ambiguity
 * warning rather than auto-mapping).
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
 * heuristic surfaces ambiguity (>1 match) as a warning at the
 * `dev discover` action layer rather than auto-resolving silently.
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
 * with empty `matched` arrays (the caller emits a warning per
 * unmapped noun). Pure helper — real implementation at pre-flight.
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
 * findings + the would-be-written mapping + per-noun warnings
 * for unmapped / ambiguous nouns.
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
  'epics_to_releases_relation',
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
 * Open-ended `details` slot so M26 IMPL can add per-check context
 * without contract churn (the check names are pinned; the per-
 * check detail shape is per-check additive).
 *
 * **Round-1 Codex fix (P2-1).** `name` is typed as
 * {@link DevDoctorCheckName} (the enum literal union) so
 * `monday schema` exposes the stable vocabulary + implementation
 * typos fail output-schema validation rather than silently
 * passing through.
 */
export interface DevDoctorCheckResult {
  readonly name: DevDoctorCheckName;
  readonly status: 'ok' | 'warn' | 'fail';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export const devDoctorCheckResultSchema = z
  .object({
    name: z.enum(DEV_DOCTOR_CHECK_NAMES),
    status: z.enum(['ok', 'warn', 'fail']),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

/**
 * Output shape for `monday dev doctor` (cli-design §11.3). The
 * verb runs every check against the active profile's mapping +
 * surfaces both the per-check results and the active mapping
 * (so an agent diagnosing a misconfiguration sees both in one
 * envelope).
 *
 * **Decision 2 closure (M26 pre-flight).** The pinned check
 * names: see {@link DEV_DOCTOR_CHECK_NAMES} above (10 entries
 * post-round-1; round-0 had 9 entries before P1-1 / P2-2
 * fix-ups). Mirror cli-design §11.3 "runs `board doctor`
 * against each configured dev board plus checks the cross-board
 * `board_relation` wiring". Per-check `details` shape is per-
 * check additive; the discriminated union is left for M26 IMPL
 * to pin (run order locks at this pre-flight).
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
 * to that workspace; when unset, it walks every board the user has
 * access to (the M26 IMPL body decides the page-size + workspace-
 * scoping cadence per the boards-walker pattern).
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
 */
export interface DiscoverDevBoardsResult {
  readonly candidates: readonly DiscoverBoardCandidate[];
  readonly matches: readonly DevNounMatchResult[];
}

/**
 * Walks the user's accessible boards (optionally scoped to
 * `workspaceId`) and groups them by dev-noun via the heuristic.
 *
 * **Pre-flight stub.** Runtime body lands at M26 IMPL — page
 * through `boards(...)` with limit ≤ 500 + the optional
 * `workspace_ids:` filter, narrow to `state: 'active'`, project
 * each row into a {@link DiscoverBoardCandidate}, then call
 * {@link groupCandidatesByDevNoun} on the full candidate list.
 */
export const discoverDevBoards = (
  /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
  _inputs: DiscoverDevBoardsInputs,
): Promise<DiscoverDevBoardsResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'monday dev discover not yet implemented (v0.3-M26 pre-flight stub)',
      {
        details: {
          hint: 'M26 implementation lands the discover walker; see docs/v0.3-plan.md §3 M26',
        },
      },
    ),
  );
/* c8 ignore stop */

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
 * resolver stays narrow).
 */
export interface RunDevDoctorResult {
  readonly checks: readonly DevDoctorCheckResult[];
  readonly summary: DevDoctorOutput['summary'];
}

/**
 * Runs every {@link DEV_DOCTOR_CHECK_NAMES} check against the
 * `inputs.mapping`. Returns a per-check result list + a summary
 * count.
 *
 * **Pre-flight stub.** Runtime body lands at M26 IMPL — one
 * `boards(ids:)` call to verify each configured board exists +
 * exposes the expected column + the `board_relation` wiring.
 */
export const runDevDoctor = (
  /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
  _inputs: RunDevDoctorInputs,
): Promise<RunDevDoctorResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'monday dev doctor not yet implemented (v0.3-M26 pre-flight stub)',
      {
        details: {
          hint: 'M26 implementation lands the doctor walker; see docs/v0.3-plan.md §3 M26',
        },
      },
    ),
  );
/* c8 ignore stop */

/**
 * Reads the active profile's `[profiles.<name>.dev]` block. Throws
 * `dev_not_configured` when no `dev` block is present for the
 * active profile (`details.hint` points at `monday dev configure`
 * + `monday dev discover`).
 *
 * **Pre-flight stub.** Runtime body lands at M26 IMPL — reads via
 * `loadProfilesConfig` (already shipped at v0.3-M21) + extracts
 * `profiles[profileName].dev` (also already shipped on the
 * profile-entry schema).
 */
export const loadDevMapping = (
  /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
  _profile: string,
): Promise<DevMapping> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'loadDevMapping not yet implemented (v0.3-M26 pre-flight stub)',
      {
        details: {
          hint: 'M26 implementation lands the runtime body; see docs/v0.3-plan.md §3 M26',
        },
      },
    ),
  );
/* c8 ignore stop */

/**
 * Writes a {@link DevMapping} into the active profile's
 * `[profiles.<name>.dev]` block. Idempotent — re-writing the same
 * mapping is a no-op (the TOML write preserves surrounding
 * formatting + comments per `smol-toml`'s round-trip).
 *
 * **Pre-flight stub.** Runtime body lands at M26 IMPL — read the
 * config, splice in the dev block, write back atomically.
 */
export const saveDevMapping = (
  /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
  _profile: string,
  _mapping: DevMapping,
): Promise<void> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'saveDevMapping not yet implemented (v0.3-M26 pre-flight stub)',
      {
        details: {
          hint: 'M26 implementation lands the runtime body; see docs/v0.3-plan.md §3 M26',
        },
      },
    ),
  );
/* c8 ignore stop */
