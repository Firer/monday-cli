/**
 * Source-item dry-run reader — the M10 lifecycle verbs (`archive` /
 * `delete` / `duplicate`) all share the same `--dry-run` preflight: a
 * single-item read against `ITEM_FIELDS_FRAGMENT`, a null-result throw
 * with `details.item_id`, then `parseRawItem + projectItem` to surface
 * the §6.4 dry-run envelope's `item: <projected snapshot>` slot.
 *
 * Lifted from three sites — see v0.2-plan §14 R27:
 *   - `commands/item/archive.ts` action — dry-run path
 *   - `commands/item/delete.ts` action — dry-run path
 *   - `commands/item/duplicate.ts` action — dry-run path
 *
 * The query body is byte-identical across the three M10 verbs (just
 * `items(ids:) { ${ITEM_FIELDS_FRAGMENT} }`); only the operation name
 * differs (`ItemArchiveRead` / `ItemDeleteRead` / `ItemDuplicateRead`).
 * The op-name divergence exists for fixture cassettes + Monday's
 * request-log telemetry (so wire calls are distinguishable per verb),
 * so the helper takes it as a required parameter rather than
 * collapsing it. M11's `item move` will pass `ItemMoveRead` and
 * inherit the helper rather than copying the pattern.
 *
 * **Why not also for the live-mutation null-handling.** The live
 * mutation returns the post-mutation item directly; the parsing +
 * projection shape is shared with R28's
 * `projectMutationItem`, but the error semantics diverge (live
 * mutations throw `not_found` with a mutation-name-bearing message
 * while this helper throws `not_found` with the read-side phrasing).
 * Two helpers, one per concern.
 */

import { ApiError } from '../utils/errors.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from './item-helpers.js';
import {
  projectItem,
  type ProjectedItem,
} from './item-projection.js';
import type { MondayClient } from './client.js';

interface SourceItemReadResponse {
  readonly items: readonly unknown[] | null;
}

/**
 * Reads the source item for an M10 lifecycle dry-run preview, returns
 * the §6.2 / §6.3 projected snapshot. Null/missing → typed
 * `not_found` with `details.item_id` so agents key off the stable
 * code per cli-design §6.5 (mirrors the live-path null-handling so
 * the error shape stays identical regardless of which path the agent
 * took).
 */
export const readSourceItemForDryRun = async ({
  client,
  itemId,
  operationName,
}: {
  readonly client: MondayClient;
  readonly itemId: string;
  readonly operationName: string;
}): Promise<ProjectedItem> => {
  const query = `
    query ${operationName}($ids: [ID!]!) {
      items(ids: $ids) {
        ${ITEM_FIELDS_FRAGMENT}
      }
    }
  `;
  const response = await client.raw<SourceItemReadResponse>(
    query,
    { ids: [itemId] },
    { operationName },
  );
  const items = response.data.items;
  const first: unknown = Array.isArray(items) ? items[0] : undefined;
  if (first === undefined || first === null) {
    throw new ApiError(
      'not_found',
      `Monday returned no item for id ${itemId}`,
      { details: { item_id: itemId } },
    );
  }
  return projectItem({ raw: parseRawItem(first, { item_id: itemId }) });
};
