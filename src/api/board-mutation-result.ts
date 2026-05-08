/**
 * Live-mutation null-result projection for the M15 board lifecycle
 * cluster (`v0.2-plan.md` §22 R43 lift). Five verbs share a near-
 * verbatim shape: null-check the wire payload, throw a typed
 * ApiError on null carrying `details.board_id` (or `details.
 * board_name` for create), then parse through `boardProjection
 * Schema` to surface the §6.4 mutation envelope's
 * `data: <projected snapshot>`.
 *
 * Lifted from five sites — see v0.2-plan §22 R43:
 *   - `commands/board/create.ts` (M15 — local `projectCreatedBoard`,
 *     `errorCode: 'internal_error'`, `detailKey: 'board_name'`).
 *   - `commands/board/archive.ts` (M15 — local
 *     `projectArchivedBoard`, `errorCode: 'not_found'`,
 *     `detailKey: 'board_id'`).
 *   - `commands/board/delete.ts` (M15 — local `projectDeletedBoard`,
 *     `errorCode: 'not_found'`, `detailKey: 'board_id'`).
 *   - `commands/board/update.ts` (M15 — inline final-read parse,
 *     `errorCode: 'internal_error'` for the defensive empty-`boards`
 *     guard).
 *   - `commands/board/duplicate.ts` (M15 — inline wrapped-board
 *     parse, `errorCode: 'internal_error'` for the inner-board
 *     null guard; the outer `BoardDuplication { board, is_async }`
 *     wrapper parse stays at the call site since R43 only covers
 *     the inner-board projection, not the wrapped-envelope shape
 *     unique to duplicate).
 *
 * **Why parameterised on `errorCode` + `errorMessage`.** The five
 * sites diverge in error semantics. Create (every successful call
 * returns a Board) + update's defensive final-read guard +
 * duplicate's inner-board guard chose `internal_error` (the
 * mutation succeeded server-side but Monday returned an empty
 * payload — server-side glitch, abnormal). Archive + delete chose
 * `not_found` (Monday's idiomatic null-for-missing-or-no-access
 * response — a typed agent-recovery story). Both are correct for
 * their semantics, both are pinned by integration tests
 * (`tests/integration/commands/board.test.ts` asserts on
 * `error.code`), and both must survive the lift byte-for-byte.
 * The helper owns the boilerplate (null check, `details: {
 * [detailKey]: detailValue }` envelope, the `unwrapOrThrow`
 * schema parse); each call site supplies its own typed error parts.
 *
 * **Why `detailKey` is parameterised.** Create's mutation runs
 * before the new board has an id, so the typed-error envelope
 * carries `details.board_name` (the agent-supplied name) instead.
 * Every other verb operates on an existing `boardId` and carries
 * `details.board_id`. Mirrors R28's `projectMutationItem` keying
 * on `details.item_id` uniformly because every item-mutation
 * surface knows the id ahead of the call.
 *
 * **Mirrors R28** (`projectMutationItem` in
 * `src/api/item-mutation-result.ts`, four consumers) and **R37**
 * (`projectMutationUpdate` in `src/api/update-mutation-result.ts`,
 * five consumers) — both per-noun helpers landed at the same 4–5
 * consumer trigger. R43 ships the third per-noun helper at the
 * same threshold.
 *
 * **What stays at the call site.** The wire-shape parse of the
 * full mutation response (`responseSchema.safeParse(response.data)`)
 * stays inline because each verb's response root key
 * (`create_board` / `archive_board` / etc.) is per-verb. The
 * missing-root-key check (schema-drift → `internal_error` with
 * a `hint`) was Codex M15 implementation round-2 F1's distinction
 * between schema-drift and null-payload, deliberately preserved at
 * each site at M15 ship time. **R42 (post-v0.2 → v0.3 cleanup
 * window — `c529445`) consolidated the inline check across every
 * board-mutation verb onto `assertResponseFieldPresent`** with
 * `nullHandling: 'caller_handles'`; the helper runs immediately
 * after each verb's `unwrapOrThrow(responseSchema.safeParse(...))`,
 * with `projectMutationBoard` continuing to handle null-value per-
 * noun (some verbs throw `internal_error`, some `not_found`).
 */

import { ApiError, type ErrorCode } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { boardProjectionSchema, type BoardProjection } from './board-projection.js';

export type BoardMutationDetailKey = 'board_id' | 'board_name';

export interface ProjectMutationBoardInputs {
  readonly raw: unknown;
  readonly errorCode: ErrorCode;
  /** Full caller-formatted message for the null-payload throw —
   * e.g. `"Monday returned no board payload from archive_board for
   * id 12345"`. Per-verb phrasing is preserved verbatim because
   * agents key off the message text in error logs. */
  readonly errorMessage: string;
  readonly detailKey: BoardMutationDetailKey;
  readonly detailValue: string;
}

/**
 * Parses + projects a live-mutation `Board` payload, throwing the
 * supplied typed error on null/undefined. Caller owns the error code +
 * message so create's `internal_error` / "no board payload from
 * create_board for name <X>" and archive/delete's `not_found` /
 * "no board payload from <op> for id <X>" both survive the lift
 * byte-for-byte.
 *
 * `details: { [detailKey]: detailValue }` is supplied by the
 * helper so every consumer carries the same envelope shape — agents
 * key off `details.board_id` (or `details.board_name` on create's
 * pre-id path) regardless of which verb threw (cli-design §6.5).
 */
export const projectMutationBoard = ({
  raw,
  errorCode,
  errorMessage,
  detailKey,
  detailValue,
}: ProjectMutationBoardInputs): BoardProjection => {
  if (raw === null || raw === undefined) {
    throw new ApiError(errorCode, errorMessage, {
      details: { [detailKey]: detailValue },
    });
  }
  const subjectPhrase =
    detailKey === 'board_name'
      ? `name ${JSON.stringify(detailValue)}`
      : `id ${detailValue}`;
  return unwrapOrThrow(boardProjectionSchema.safeParse(raw), {
    context: `Monday returned a malformed board payload for ${subjectPhrase}`,
    details: { [detailKey]: detailValue },
  });
};
