/**
 * Eager-invalidation post-success projection wrappers for board-
 * structure mutations (`v0.2-plan.md` §22 R46 lift).
 *
 * Lifts the cli-design §8 eager-invalidation timing rule from six
 * inline call sites into two helpers that pin the timing in the
 * type system. The §8 contract splits by leg-count:
 *
 *   - **Single-leg verbs** (`column-create` / `column-delete` +
 *     M15-retrofit `board archive` / `board delete`). Invalidate
 *     AFTER the success envelope's `data` projection completes,
 *     never before the wire mutation, never between mutation and
 *     projection. Skip on the error path — a failed single-leg
 *     call didn't change board state.
 *   - **Fan-out verbs** (`column-update` per-attribute +
 *     M15-retrofit `board update` per-attribute). Issue all per-
 *     attribute wire calls first; AFTER the loop ends, invalidate
 *     IF at least one per-attribute call succeeded (the wire-
 *     state high-water mark). On whole-call success this is the
 *     same trigger as the single-leg case (every leg succeeded);
 *     on whole-call partial-application failure (call N+1 fails
 *     after call N succeeded) invalidation still fires because
 *     the cache must reflect partially-applied server state.
 *     Zero-legs-succeeded skips invalidation — server state didn't
 *     change.
 *
 * Both helpers order invalidation BEFORE returning so the consumer's
 * `emitMutation` lands AFTER the cache is invalidated; a cache-unlink
 * failure (permission flip, disk loss) surfaces through the runner's
 * catch-all error envelope rather than double-emitting after a
 * success envelope already hit stdout (Codex M16 round-1 F1 ordering
 * pin).
 *
 * **Why a `recordLegSuccess()` callback rather than a returned
 * `{succeededLegs, ...}` object** (the §22 R46 spec's draft shape).
 * The fan-out's high-water-mark counter MUST survive a thrown
 * `runFanOut` — if the closure throws partway through the loop,
 * the helper still needs to know how many legs landed before the
 * throw to decide on partial-application invalidation. Returning
 * the counter would force every consumer to wrap its own
 * try/catch to push the count out before re-throwing; routing it
 * through a closure-captured callback owned by the helper hides
 * the counter from the consumer's data flow entirely. The
 * consumer just calls `recordLegSuccess()` after each successful
 * leg; the helper owns the counter, the catch boundary, and the
 * §8 invalidation gate.
 *
 * **Why a single `perform` callback for single-leg rather than a
 * split `{runMutation, projectData}` (the §22 R46 spec draft).**
 * Splitting "fire the wire call" from "project the response" was
 * artificial in practice — the missing-root-key check + null-
 * payload guard sit between the two and don't belong cleanly to
 * either side. A single callback that owns wire-call + parse +
 * missing-root + projection lets each consumer keep its existing
 * structure, returning whatever shape it needs (typically
 * `{data, response}` so `emitMutation` can take both `data` and
 * `toEmit(response)` post-helper).
 *
 * **Six consumer sites (4 single-leg + 2 fan-out):**
 *   - `commands/board/column-create.ts` — single-leg.
 *   - `commands/board/column-delete.ts` — single-leg.
 *   - `commands/board/archive.ts` — single-leg (M15 retrofit).
 *   - `commands/board/delete.ts` — single-leg (M15 retrofit).
 *   - `commands/board/column-update.ts` — fan-out (per-attribute
 *     across two wire surfaces; trailing per-attribute response
 *     is authoritative).
 *   - `commands/board/update.ts` — fan-out (M15 retrofit; per-
 *     attribute loop + final force-live read; final-read response
 *     is authoritative). The `runFanOut` closure wraps loop +
 *     final read + projection so a final-read failure with
 *     succeededLegs > 0 still triggers invalidation per §8.
 *
 * **M17 trajectory.** The §8 contract is leg-count-shaped, not
 * noun-shaped — M17's five group verbs (`group-create` /
 * `group-update` / `group-archive` / `group-duplicate` /
 * `group-delete`) adopt the helpers verbatim from day one
 * (mirrors R29's M14-close-then-M15-adopts pattern). Site count
 * projects to 9 by M17 close (4 + 5), well above the typical
 * 3-consumer trigger threshold.
 */

import { invalidateBoard } from './cache.js';

/**
 * Tracker handed to the `runFanOut` closure so consumer loops can
 * record successful per-attribute legs without owning the counter.
 * The helper observes `recordLegSuccess()` calls to gate §8
 * invalidation on the high-water-mark rule.
 */
export interface BoardFanOutTracker {
  /**
   * Call once per successfully-committed per-attribute wire call.
   * Drives the §8 fan-out invalidation gate: invalidation fires
   * iff this is called at least once before `runFanOut` returns
   * or throws.
   */
  readonly recordLegSuccess: () => void;
}

export interface WithBoardInvalidationSingleLegInputs<T> {
  readonly boardId: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Performs the wire mutation, parses + projects the response,
   * and returns whatever the consumer needs post-helper (typically
   * `{data, response}` so `emitMutation` can take both `data` and
   * `toEmit(response)`). If `perform` throws, invalidation is
   * skipped — a failed single-leg call didn't change board state.
   */
  readonly perform: () => Promise<T>;
}

/**
 * Single-leg eager-invalidation wrapper per cli-design §8. Runs
 * `perform()` to completion, then calls `invalidateBoard(boardId,
 * env)` before returning the perform result. On the error path
 * (perform throws) invalidation is skipped — bypass-by-throw is
 * the timing contract: a failed single-leg call didn't change
 * server state, so the cache stays valid.
 */
export const withBoardInvalidationSingleLeg = async <T>({
  boardId,
  env,
  perform,
}: WithBoardInvalidationSingleLegInputs<T>): Promise<T> => {
  const result = await perform();
  await invalidateBoard(boardId, env);
  return result;
};

export interface WithBoardInvalidationFanOutInputs<T> {
  readonly boardId: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Runs the per-attribute wire-call loop (and any trailing read /
   * projection legs). Calls `tracker.recordLegSuccess()` after each
   * successful leg so the helper can apply the §8 high-water-mark
   * invalidation rule. Returns whatever the consumer needs post-
   * helper (typically `{data, response}` for `emitMutation` +
   * `toEmit(response)`). When `runFanOut` throws after recording
   * one or more leg successes, the helper invalidates BEFORE
   * re-throwing so the cache reflects partially-applied state.
   */
  readonly runFanOut: (tracker: BoardFanOutTracker) => Promise<T>;
}

/**
 * Fan-out eager-invalidation wrapper per cli-design §8. Runs
 * `runFanOut(tracker)` and applies the high-water-mark rule:
 *
 *   - Whole-call success → invalidate iff any leg succeeded
 *     (recordLegSuccess called at least once); return the result.
 *   - Whole-call partial-application failure → catch the throw;
 *     invalidate iff any leg succeeded; re-throw.
 *   - Whole-call zero-legs-succeeded failure (the very first leg
 *     threw before recordLegSuccess fired) → skip invalidation;
 *     re-throw. Server state didn't change, so the cache stays
 *     valid.
 *
 * The counter lives in this helper's closure — `runFanOut` cannot
 * read or write it directly, only signal increments via
 * `tracker.recordLegSuccess()`. This pins the §8 contract in the
 * type system (the consumer can't accidentally invalidate before
 * the wire call or skip invalidation on partial-application
 * failure).
 */
export const withBoardInvalidationFanOut = async <T>({
  boardId,
  env,
  runFanOut,
}: WithBoardInvalidationFanOutInputs<T>): Promise<T> => {
  let succeededLegs = 0;
  const tracker: BoardFanOutTracker = {
    recordLegSuccess: () => {
      succeededLegs += 1;
    },
  };
  try {
    const result = await runFanOut(tracker);
    if (succeededLegs > 0) {
      await invalidateBoard(boardId, env);
    }
    return result;
  } catch (err) {
    if (succeededLegs > 0) {
      await invalidateBoard(boardId, env);
    }
    throw err;
  }
};
