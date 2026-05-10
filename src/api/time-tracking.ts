/**
 * Time-tracking start/stop verb primitives for the v0.3-M20
 * `monday item time-track start / stop` surface (cli-design §5.2
 * carve-out 2 — verb-shaped column-type extensions surface as
 * `<noun> <subnoun> <verb>`).
 *
 * **Documentation-only verbs at v0.3.** An empirical probe against a
 * real Monday workspace on 2026-05-10 against API version `2026-01`
 * confirmed that Monday's public GraphQL API exposes **no mutation
 * for writing to `time_tracking` columns**:
 *
 *   - `change_simple_column_value` rejects every candidate value
 *     (`"true"`, `"false"`, `"start"`, `"stop"`) with
 *     `CorrectedValueException`. Verbatim Monday response: *"column
 *     type DurationColumn is not supporting changing the column
 *     value with simple column value, please check our API
 *     documentation for the correct data structure for this
 *     column."* — paraphrased elsewhere for brevity.
 *   - `change_column_value` rejects every candidate JSON shape
 *     (`{running:true}`, `{running:false}`, `{started_at}`,
 *     `{ended_at}`, `{}`) with `InvalidColumnTypeException`.
 *     Verbatim Monday response: *"This column type is not supported
 *     yet in the API"* (`actual_type: "DurationColumn"`).
 *   - Full mutation-root introspection (152 mutations) found zero
 *     time-tracking-related mutations matching
 *     `/time|track|session|duration|start|stop|play|pause|timer/i`.
 *
 * The pre-flight contract assumed `change_simple_column_value` would
 * route through; that assumption was empirically wrong. M20 ships the
 * verbs **as documentation-only** so the CLI surface is stable when
 * Monday eventually exposes the underlying mutation: agents can
 * grep for `monday item time-track start` and see a registered verb
 * that today rejects with a clear `usage_error` and a hint pointing
 * at Monday's UI as the only write path.
 *
 * **Two surfaces.**
 *
 *   - `startTimeTracking({client, boardId, itemId, columnId, env?})`
 *     — when Monday's API supports it, will flip the column from
 *     stopped → running. Today, rejects with `usage_error` per the
 *     `API_UNSUPPORTED_HINT` constant below.
 *   - `stopTimeTracking({client, boardId, itemId, columnId, env?})`
 *     — when Monday's API supports it, will flip the column from
 *     running → stopped. Today, rejects with the same `usage_error`.
 *
 * The four exported `*Inputs` / `*Result` interfaces are kept verbatim
 * from the pre-flight (`a702af2`) so when Monday ships the mutation,
 * the api-layer change is small: replace the rejection bodies with
 * the actual wire call against the pinned input shape. The
 * `commands/item/time-track/{start,stop}.ts` command files will need
 * follow-up wiring at the same time — column resolution against board
 * metadata, `--dry-run` branching to emit `planned_changes`, and an
 * `emitMutation` call against the primitive's success result.
 *
 * **Decisions 4.1 / 4.2 / 4.3 (v0.3-plan §3 M20)** stay closed but
 * unenforceable today — the verb rejects before any state-machine
 * branch is reachable. They describe the future behavior:
 *
 *   - **4.1 — `start` against a running column:** future
 *     `usage_error` with `details.running: true` (state-discriminant);
 *     hint will point at the stop verb.
 *   - **4.2 — `stop` against a non-running column:** future
 *     symmetric `usage_error` with `details.running: false`.
 *   - **4.3 — Idempotency:** future verbs will be non-idempotent
 *     (start opens a new session each time; stop closes the open one
 *     — both throw on invalid pre-state).
 *
 * Today, every invocation throws the same `usage_error` regardless
 * of pre-state, so the discriminants don't surface yet.
 *
 * **No cache surface, no board-invalidation fan-out.**
 * `time_tracking` columns don't cache and don't affect board
 * structure; the `env` slot in the inputs is preserved for parity
 * with sibling primitives (test-isolation), not for cache-key
 * resolution.
 */

import type { MondayClient } from './client.js';
import type { BoardId, ItemId } from '../types/ids.js';
import { ApiError } from '../utils/errors.js';

/**
 * Inputs to the `startTimeTracking` primitive. Pinned at pre-flight
 * (`a702af2`); kept unchanged so M20-implementation's documentation-
 * only rejection becomes a one-sided swap to a real wire call when
 * Monday ships API support.
 *
 * `client` + `env` are unused today — the rejection is constructed
 * synchronously in the body — but the contract retains them so
 * future implementation has a stable signature.
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
 * `StartTimeTrackingInputs` — the verb pair will route through the
 * same `(board_id, item_id, column_id)` triple at the wire layer
 * once Monday exposes the mutation.
 */
export interface StopTimeTrackingInputs {
  readonly client: MondayClient;
  readonly boardId: BoardId;
  readonly itemId: ItemId;
  readonly columnId: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Result of a `startTimeTracking` call once Monday's API supports
 * time-tracking writes. **Aspirational at v0.3** — the verb rejects
 * today, so this shape never materialises on the wire. Pinned so
 * agents grepping the type surface see the documented future shape.
 *
 * `running: true` is a literal — verb-success implies the column
 * state flipped to running. `startedAt` carries Monday's
 * authoritative session-start timestamp.
 */
export interface StartTimeTrackingResult {
  readonly itemId: string;
  readonly columnId: string;
  readonly running: true;
  readonly startedAt: string;
}

/**
 * Result of a `stopTimeTracking` call once Monday's API supports
 * time-tracking writes. **Aspirational at v0.3** — see
 * `StartTimeTrackingResult`.
 *
 * `startedAt` mirrors `TimeTrackingHistoryItem.started_at` (`null`
 * when Monday omits it on the just-closed session record);
 * `endedAt` is the stop wall-clock; `durationSeconds` is the
 * just-stopped session's duration in seconds, **`null` when
 * `startedAt` is `null`** — SDK 14.0.0 exposes no per-history
 * duration field, so without a `startedAt` the per-session duration
 * is uncomputable.
 */
export interface StopTimeTrackingResult {
  readonly itemId: string;
  readonly columnId: string;
  readonly running: false;
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly durationSeconds: number | null;
}

/**
 * Hint string shipped on every documentation-only rejection. Names
 * the empirical probe (date + API version + the exact error codes
 * Monday returned for each candidate wire shape) so an agent reading
 * the envelope's `details.hint` can self-verify the limitation
 * without re-running the probe themselves.
 */
const API_UNSUPPORTED_HINT =
  "Monday's public GraphQL API does not currently expose a " +
  'mutation for writing to time_tracking columns. Empirical probe ' +
  '(2026-05-10, API version 2026-01): change_simple_column_value ' +
  "rejects every candidate value with CorrectedValueException " +
  '("DurationColumn does not support simple column value writes"); ' +
  'change_column_value rejects every candidate JSON shape with ' +
  'InvalidColumnTypeException ("This column type is not supported ' +
  'yet in the API"); the mutation root has no time-tracking-' +
  'related mutation. Use Monday\'s UI to start/stop time-tracking ' +
  'sessions until Monday ships API support — the verb is ' +
  'registered for forward-compatibility so agent scripts targeting ' +
  '`monday item time-track start/stop` are stable across the ' +
  'eventual swap.';

/**
 * Documentation-only `start` verb. Rejects with `usage_error` on
 * every invocation; the inputs are echoed in `details` so agents
 * inspecting the envelope can confirm the call site they intended.
 *
 * When Monday ships the underlying mutation, replace the body with
 * the wire call (likely `change_simple_column_value` once Monday
 * extends DurationColumn's accepted-value enum, or a new dedicated
 * `start_time_tracking` mutation if Monday exposes one).
 */
export const startTimeTracking = (
  inputs: StartTimeTrackingInputs,
): Promise<StartTimeTrackingResult> =>
  Promise.reject(
    new ApiError(
      'usage_error',
      "`monday item time-track start` is registered for forward-" +
        "compatibility but cannot fire today — Monday's public API " +
        'does not currently support writing to time_tracking columns.',
      {
        details: {
          board_id: inputs.boardId,
          item_id: inputs.itemId,
          column_id: inputs.columnId,
          hint: API_UNSUPPORTED_HINT,
        },
      },
    ),
  );

/**
 * Documentation-only `stop` verb. Mirrors `startTimeTracking`'s
 * rejection shape; differs only in the verb name in the
 * envelope's `error.message` (so agents grepping the envelope
 * for "time-track stop" vs "time-track start" can disambiguate
 * the call site they invoked).
 */
export const stopTimeTracking = (
  inputs: StopTimeTrackingInputs,
): Promise<StopTimeTrackingResult> =>
  Promise.reject(
    new ApiError(
      'usage_error',
      "`monday item time-track stop` is registered for forward-" +
        "compatibility but cannot fire today — Monday's public API " +
        'does not currently support writing to time_tracking columns.',
      {
        details: {
          board_id: inputs.boardId,
          item_id: inputs.itemId,
          column_id: inputs.columnId,
          hint: API_UNSUPPORTED_HINT,
        },
      },
    ),
  );
