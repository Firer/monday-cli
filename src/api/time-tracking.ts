/**
 * Time-tracking start/stop verb primitives for the v0.3-M20
 * `monday item time-track start / stop` surface (cli-design §5.2
 * carve-out 2 — verb-shaped column-type extensions surface as
 * `<noun> <subnoun> <verb>`). The `time_tracking` column models a
 * state machine rather than a settable value, so the standard
 * `--set` grammar can't address it; M20 ships a dedicated verb
 * pair instead.
 *
 * **Two surfaces.**
 *
 *   - `startTimeTracking({client, boardId, itemId, columnId, env?})`
 *     — flips the column from stopped → running, opening a new
 *     session whose `started_at` is Monday's wall-clock. Throws
 *     `usage_error` per v0.3-plan §3 M20 Decision 4.1 if the column
 *     is already running.
 *   - `stopTimeTracking({client, boardId, itemId, columnId, env?})`
 *     — flips the column from running → stopped, closing the
 *     just-running session and recording its `ended_at` +
 *     `duration_seconds`. Throws `usage_error` per v0.3-plan §3 M20
 *     Decision 4.2 if the column is not running.
 *
 * **Pre-flight contract diff (this commit) lands type-level
 * signatures only.** Both exported functions throw at runtime to
 * pin the surface ahead of M20's first feat commit; the bodies
 * land at M20 implementation alongside `src/commands/item/time-
 * track/start.ts` + `stop.ts`. The wire-level mutation choice
 * (likely `change_simple_column_value` with the documented Monday
 * time-tracking JSON shape — SDK 14.0.0 does not expose dedicated
 * `start_time_tracking` / `stop_time_tracking` mutations, so the
 * verb pair routes through the generic column-value mutation) is
 * M20-implementation territory; pre-flight pins the internal
 * module surface only.
 *
 * **Why pre-flight pins the signatures.** v0.3-plan §9 preconditions
 * require the M20 contract diff to land before any feat commit so
 * Codex pre-flight can review the contract surface without behaviour
 * changes. Mirrors the `d822982` (M19) / `bed75c6` (M17) / `c0efab5`
 * (M16) cadence.
 *
 * **State-conflict semantics — v0.3-plan §3 M20 Decisions 4.1 / 4.2 /
 * 4.3, closed this commit:**
 *
 *   - **Decision 4.1 — `start` against a running column:** throws
 *     `usage_error` (reuses the existing code rather than
 *     introducing `time_tracking_already_running`; agents already
 *     branch on the verb they invoked, and `details.running: true`
 *     carries the discriminant — adding a per-state-bug code widens
 *     ERROR_CODES for marginal benefit).
 *   - **Decision 4.2 — `stop` against a non-running column:** throws
 *     `usage_error` symmetric to 4.1; `details.running: false`
 *     carries the discriminant. Same reasoning as 4.1 — no
 *     `time_tracking_not_running` code.
 *   - **Decision 4.3 — Idempotency:** both verbs are non-idempotent.
 *     `start` always opens a new session in valid pre-state (each
 *     call against a stopped column appends a new history entry);
 *     `stop` always closes the just-running session in valid
 *     pre-state. Symmetric: both verbs assume valid pre-state and
 *     surface `usage_error` on invalid pre-state. Agents needing
 *     best-effort `stop` swallow the typed error envelope (the
 *     `details.running: false` discriminant) — `monday item get`
 *     does NOT surface the time-tracking running flag in the
 *     v0.3-M20-pre-flight item-read projection (M20 implementation
 *     may widen the projection per v0.3-plan §3 M20 implementation
 *     deliverables; the typed envelope discriminant is the primary
 *     path either way). The alternative `stop` shape (no-op-on-
 *     stopped, idempotent retry-safe) is defensible but breaks
 *     symmetry with `start` and hides state from agents that branch
 *     on the response.
 *
 * **No cache surface.** `time_tracking` columns don't cache — each
 * start/stop is a live mutation that immediately invalidates any
 * stale view of the column anyway. The `env` slot in the inputs is
 * preserved for parity with sibling primitives (test-isolation
 * via tmp `XDG_CACHE_HOME` etc.), not for cache-key resolution.
 *
 * **No board-invalidation fan-out.** `time_tracking` mutations
 * don't affect board structure (rows / columns / groups), so the
 * R46 `withBoardInvalidation*` wrappers don't apply. Time-track
 * verbs invalidate at most the per-item time-entry view — and
 * v0.3 doesn't model that as a cache-keyed surface.
 */

import type { MondayClient } from './client.js';
import type { BoardId, ItemId } from '../types/ids.js';
import { ApiError } from '../utils/errors.js';

/**
 * Inputs to the `startTimeTracking` primitive. The wire mutation
 * (M20-implementation choice — see file-level docstring) needs the
 * `(board_id, item_id, column_id)` triple — `board_id` is required
 * to scope the column-value mutation per Monday's
 * `change_simple_column_value` signature; the standard `--board
 * <bid>` resolution from cli-design §5.3 step 1 applies (explicit
 * `--board` skips the implicit item-board lookup).
 *
 * `client` is required because the runtime body fires a live
 * GraphQL mutation; mirrors the M19 pre-flight pattern from
 * `tag-directory.ts` + the `userByEmail` precedent in
 * `resolvers.ts:238`.
 */
export interface StartTimeTrackingInputs {
  readonly client: MondayClient;
  readonly boardId: BoardId;
  readonly itemId: ItemId;
  readonly columnId: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Inputs to the `stopTimeTracking` primitive. Same shape as
 * `StartTimeTrackingInputs` — the verb pair routes through the
 * same `(board_id, item_id, column_id)` triple at the wire layer.
 */
export interface StopTimeTrackingInputs {
  readonly client: MondayClient;
  readonly boardId: BoardId;
  readonly itemId: ItemId;
  readonly columnId: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Result of a successful `startTimeTracking` call. `running: true`
 * is a literal — verb-success implies the column state flipped to
 * running. `startedAt` carries Monday's authoritative
 * session-start timestamp (mirrors `TimeTrackingValue.started_at`
 * from SDK 14.0.0 `index.d.ts:2783` — ISO 8601 datetime string).
 *
 * `itemId` and `columnId` echo the inputs verbatim so the
 * `monday item time-track start` envelope's `data` block can be
 * built from this result alone (no second read leg).
 */
export interface StartTimeTrackingResult {
  readonly itemId: string;
  readonly columnId: string;
  readonly running: true;
  readonly startedAt: string;
}

/**
 * Result of a successful `stopTimeTracking` call. `running: false`
 * is a literal — verb-success implies the column state flipped to
 * stopped. `startedAt` carries the just-stopped session's start
 * timestamp (mirrors `TimeTrackingHistoryItem.started_at` — `null`
 * when Monday omits it on the just-closed session record, e.g.
 * sessions added by automation that never recorded a `started_at`);
 * `endedAt` is the stop wall-clock.
 *
 * `durationSeconds` is the just-stopped session's duration in
 * seconds, computed by M20 implementation as
 * `endedAt - startedAt`. **`null` when `startedAt` is `null`** —
 * SDK 14.0.0 exposes no per-`TimeTrackingHistoryItem` duration
 * field (only `TimeTrackingValue.duration` for the column-level
 * total), so without a `startedAt` the per-session duration is
 * uncomputable. The `null` is meaningful (distinguishes "Monday
 * omitted the start" from a zero-length session) per the
 * `.claude/rules/typescript.md` `null`-with-meaning rule.
 */
export interface StopTimeTrackingResult {
  readonly itemId: string;
  readonly columnId: string;
  readonly running: false;
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly durationSeconds: number | null;
}

const NOT_IMPLEMENTED_HINT =
  'time-tracking start/stop bodies land at M20 implementation ' +
  'alongside the `monday item time-track start / stop` command ' +
  'files. The pre-flight contract diff pins the public surface ' +
  'only — see docs/v0.3-plan.md §3 M20 + §9 preconditions for the ' +
  'implementation-session sequencing.';

/**
 * Starts the `time_tracking` column's running session. In valid
 * pre-state (column not running), opens a new history entry with
 * `started_at` = Monday's wall-clock and flips `running: true`.
 * Throws `usage_error` per Decision 4.1 if the column is already
 * running (`details.running: true` discriminant; hint points at
 * `monday item time-track stop`).
 *
 * **Stub body — implementation lands at M20.**
 */
/* c8 ignore start — stub body rejects on every path; M20
   implementation replaces this with the change_simple_column_value
   sequence. The non-async signature with `Promise.reject` matches
   the M20 surface (callers `await` the result) without tripping
   the require-await lint on a body that has no await yet. */
export const startTimeTracking = (
  _inputs: StartTimeTrackingInputs,
): Promise<StartTimeTrackingResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'startTimeTracking is a v0.3-M20 pre-flight stub — the runtime ' +
        'body lands when the time-track verb pair ships at M20 ' +
        'implementation.',
      { details: { hint: NOT_IMPLEMENTED_HINT } },
    ),
  );
/* c8 ignore stop */

/**
 * Stops the `time_tracking` column's running session. In valid
 * pre-state (column running), closes the open history entry with
 * `ended_at` = Monday's wall-clock, records `duration_seconds`,
 * and flips `running: false`. Throws `usage_error` per Decision
 * 4.2 if the column is not running (`details.running: false`
 * discriminant; hint points at `monday item time-track start`).
 *
 * **Stub body — implementation lands at M20.**
 */
/* c8 ignore start — stub body rejects on every path. */
export const stopTimeTracking = (
  _inputs: StopTimeTrackingInputs,
): Promise<StopTimeTrackingResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'stopTimeTracking is a v0.3-M20 pre-flight stub — the runtime ' +
        'body lands when the time-track verb pair ships at M20 ' +
        'implementation.',
      { details: { hint: NOT_IMPLEMENTED_HINT } },
    ),
  );
/* c8 ignore stop */
