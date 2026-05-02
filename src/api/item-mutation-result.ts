/**
 * Live-mutation null-result projection — every item-shaped mutation
 * (M5b's `change_simple_column_value` / `change_column_value` /
 * `change_multiple_column_values` plus M10's `archive_item` /
 * `delete_item` / `duplicate_item`) returns the post-mutation `Item`
 * directly, and every consumer guards against a null result with the
 * same shape: a typed throw carrying `details.item_id`, then
 * `parseRawItem + projectItem` to surface the §6.4 mutation
 * envelope's `data: <projected snapshot>`.
 *
 * Lifted from six sites — see v0.2-plan §14 R28:
 *   - `commands/item/set.ts` (M5b — local `projectMutationItem`)
 *   - `commands/item/clear.ts` (M5b — local `projectMutationItem`)
 *   - `commands/item/update.ts` (M5b — local `projectMutationItem`)
 *   - `commands/item/archive.ts` (M10 — inline)
 *   - `commands/item/delete.ts` (M10 — inline)
 *   - `commands/item/duplicate.ts` (M10 — inline)
 *
 * **Why parameterised on `errorCode` + `errorMessage`.** The two
 * cohorts diverge in error semantics. M5b chose `internal_error` with
 * "Monday returned no item payload from the mutation for id ..."
 * (the mutation succeeded server-side but Monday returned an empty
 * payload — server-side glitch, abnormal). M10 chose `not_found` with
 * "Monday returned no item from <op_name> for id ..." (Monday's
 * idiomatic null-for-missing-or-no-access response — a typed agent-
 * recovery story). Both are correct for their semantics, both are
 * pinned by integration tests, and both must survive the lift
 * byte-for-byte. The helper owns the boilerplate (null check,
 * `details: { item_id }` envelope, `parseRawItem + projectItem` chain);
 * each call site supplies its own typed error parts.
 *
 * **What stays at the call site.** The post-projection error
 * decoration (resolver-warning fold, validation_failed → column_
 * archived remap, bulk `applied_count` / `applied_to` /
 * `failed_at_item` attachment in update.ts's bulk path) lives at the
 * call site. The helper's null-throw bubbles into the surrounding
 * try/catch unchanged; callers compose the helper with their own
 * `foldAndRemap` arms exactly as before. M11's `item move` + M14/M15
 * board archive / delete will inherit this seam too.
 */

import { ApiError, type ErrorCode } from '../utils/errors.js';
import { parseRawItem } from './item-helpers.js';
import { projectItem, type ProjectedItem } from './item-projection.js';

/**
 * Parses + projects a live-mutation `Item` payload, throwing the
 * supplied typed error on null/undefined. Caller owns the error code +
 * message so M5b's `internal_error` / "no item payload" and M10's
 * `not_found` / "no item from <op_name>" both survive the lift
 * byte-for-byte.
 *
 * `details: { item_id }` is supplied by the helper so every consumer
 * carries the same envelope shape — agents key off `details.item_id`
 * regardless of which verb threw (cli-design §6.5).
 */
export const projectMutationItem = ({
  raw,
  itemId,
  errorCode,
  errorMessage,
}: {
  readonly raw: unknown;
  readonly itemId: string;
  readonly errorCode: ErrorCode;
  readonly errorMessage: string;
}): ProjectedItem => {
  if (raw === null || raw === undefined) {
    throw new ApiError(errorCode, errorMessage, {
      details: { item_id: itemId },
    });
  }
  return projectItem({ raw: parseRawItem(raw, { item_id: itemId }) });
};
