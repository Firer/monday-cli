/**
 * Validator for v0.3-M19's `board_relation` and `dependency`
 * friendly translators. Each translator's input is a comma-split
 * item-ID list (`<iid1>,<iid2>`); both target columns scope the
 * relation to a specific allowed-board set (Monday's
 * `column.settings.boardIds` for `board_relation` /
 * `column.settings.dependencyBoards` for `dependency`).
 *
 * The validator batches a single `items(ids: [...])` query (one
 * trip per `--set` call rather than one trip per item) and confirms
 * each input item belongs to one of the column's allowed boards.
 * Mismatches surface as `usage_error` with `details.item_id` /
 * `details.allowed_boards` so agents can correct without reading
 * the column's settings separately.
 *
 * **Pre-flight contract diff (this commit) lands type-level
 * signatures only.** The runtime body lands at M19 implementation
 * alongside the two translator slots that consume this helper.
 *
 * **Why a separate module from `column-values.ts`.** Both
 * `board_relation` and `dependency` translators consume the same
 * helper (different settings field, identical wire shape +
 * resolution path). Keeping the validator in its own module
 * mirrors the precedent set by `dates.ts` / `links.ts` /
 * `emails.ts` / `phones.ts` / `people.ts` — translator-specific
 * machinery isolated from `column-values.ts`'s dispatcher logic
 * for unit-test ergonomics. The `--set` cap (Monday's documented
 * 25-item-per-call ceiling per cli-design §5.3) lives here too;
 * over-cap inputs surface `usage_error` pre-network without
 * burning a complexity-budget call against `items(ids: ...)`.
 */

import type { MondayClient } from './client.js';
import { ApiError } from '../utils/errors.js';

/** Monday's documented per-call cap for relation-column item lists. */
export const BOARD_RELATION_MAX_ITEMS = 25;

export interface BoardRelationValidationInputs {
  /**
   * The Monday GraphQL client. Required because the validator
   * batches a single live `items(ids: [...])` query to read each
   * input item's `board.id` and confirm membership in the column's
   * allowed-board set. No cache fallback — board membership of an
   * item can change between calls (item moved cross-board), so the
   * validator always hits live.
   */
  readonly client: MondayClient;
  readonly itemIds: readonly number[];
  readonly allowedBoards: readonly number[];
  /**
   * Diagnostic context — surfaced in the throw's `details` so a
   * mismatch between `board_relation` and `dependency` consumers
   * is visible in the error envelope (per cli-design §6.5
   * single-target shape).
   */
  readonly context: 'board_relation' | 'dependency';
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface BoardRelationMismatch {
  readonly itemId: number;
  readonly actualBoard: number | null;
}

export type BoardRelationValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly mismatches: readonly BoardRelationMismatch[];
    };

const NOT_IMPLEMENTED_HINT =
  'board-relation validator body lands at M19 implementation ' +
  'alongside the `board_relation` + `dependency` friendly ' +
  'translators. The pre-flight contract diff pins the public ' +
  'surface only — see docs/v0.3-plan.md §3 M19 + §9 preconditions ' +
  'for the implementation-session sequencing.';

/**
 * Validates that every input item ID belongs to one of the
 * column's allowed boards. Batches a single `items(ids: [...])`
 * query (Monday charges complexity per-call, not per-id, so
 * batching is a hard requirement, not an optimisation).
 *
 * Returns `{ ok: true }` when every item resolves cleanly OR
 * `{ ok: false, mismatches: [...] }` listing every input item
 * whose `board.id` falls outside the allowed set. Inputs over
 * the per-call cap (`BOARD_RELATION_MAX_ITEMS`) throw
 * `usage_error` before any network call.
 *
 * **Stub body — implementation lands at M19.**
 */
/* c8 ignore start — stub body rejects on every path; M19
   implementation replaces this with the batched items(ids:)
   query + per-item allowed-boards membership check. */
export const validateBoardRelationItems = (
  _inputs: BoardRelationValidationInputs,
): Promise<BoardRelationValidationResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      'validateBoardRelationItems is a v0.3-M19 pre-flight stub — ' +
        'the runtime body lands when the friendly board_relation + ' +
        'dependency translators ship at M19 implementation.',
      { details: { hint: NOT_IMPLEMENTED_HINT } },
    ),
  );
/* c8 ignore stop */
