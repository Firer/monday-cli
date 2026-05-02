/**
 * Item-board lookup — shared GraphQL query + parse boundary + the
 * `--board <bid> ?? lookup` resolver every item-mutation surface needs.
 *
 * Lifted from four sites (`set.ts`, `clear.ts`, `update.ts`, `create.ts`)
 * — see v0.2-plan §12 R23. Each had the same triple: a verbatim
 * `ItemBoardLookup` query, a `boardLookupResponseSchema` zod parse
 * (defence-in-depth on item-id + board-id shapes per validation.md
 * "Never bubble raw ZodError out of a parse boundary" + M5b parse-1
 * F3), and a `resolveBoardId(client, itemId, explicit)` helper with
 * `not_found` for both missing-item and null-board paths.
 *
 * Two query shapes:
 *   - `ITEM_BOARD_LOOKUP_QUERY` — `items.id, items.board.id` (M5b).
 *     Used by `set` / `clear` / `update` / `create`'s
 *     `--relative-to` verification.
 *   - `ITEM_PARENT_LOOKUP_QUERY` — adds `board.hierarchy_type` (M9).
 *     Used by `create`'s `--parent` lookup so the multi-level
 *     classic-only gate fires pre-mutation per cli-design §5.8.
 *
 * Error labels are caller-supplied so the disambiguation between
 * "Item N", "Parent item N", and "--relative-to item N" stays in
 * the consumer's voice. Defaults match the M5b set/clear/update
 * messages.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { BoardIdSchema, ItemIdSchema } from '../types/ids.js';
import type { MondayClient } from './client.js';

export const ITEM_BOARD_LOOKUP_QUERY = `
  query ItemBoardLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

export const ITEM_PARENT_LOOKUP_QUERY = `
  query ItemParentLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board {
        id
        hierarchy_type
      }
    }
  }
`;

export const boardLookupResponseSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: ItemIdSchema,
          board: z.object({ id: BoardIdSchema }).nullable(),
        }),
      )
      .nullable(),
  })
  .loose();

export const parentLookupResponseSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: ItemIdSchema,
          board: z
            .object({
              id: BoardIdSchema,
              hierarchy_type: z.string().nullable(),
            })
            .nullable(),
        }),
      )
      .nullable(),
  })
  .loose();

interface LookupInputs {
  readonly client: MondayClient;
  readonly itemId: string;
  /** Defaults to `Item` — overridden by callers like `Parent item` or `--relative-to item`. */
  readonly label?: string;
  /** Defaults to `item_id` — overridden to `parent_item_id` / `relative_to_id`. */
  readonly detailKey?: string;
}

/**
 * Looks up the item's board via `ITEM_BOARD_LOOKUP_QUERY`. Throws
 * `not_found` for both missing-item and null-board paths so callers
 * key off the stable code per cli-design §6.5.
 */
export const lookupItemBoard = async (
  inputs: LookupInputs,
): Promise<{ readonly itemId: string; readonly boardId: string }> => {
  const { client, itemId, label = 'Item', detailKey = 'item_id' } = inputs;
  const response = await client.raw<unknown>(
    ITEM_BOARD_LOOKUP_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemBoardLookup' },
  );
  const data = unwrapOrThrow(
    boardLookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemBoardLookup response for id ${itemId}`,
      details: { [detailKey]: itemId },
      hint:
        "this is a data-integrity error in Monday's response; verify " +
        'the response shape and update boardLookupResponseSchema if ' +
        "Monday's contract has changed.",
    },
  );
  const first = data.items?.[0];
  if (first === undefined) {
    throw new ApiError(
      'not_found',
      `${label} ${itemId} does not exist or the token has no read access.`,
      { details: { [detailKey]: itemId } },
    );
  }
  if (first.board === null) {
    throw new ApiError(
      'not_found',
      `${label} ${itemId} has no readable board; the token may not have ` +
        `permission on its board, or the board is deleted.`,
      { details: { [detailKey]: itemId } },
    );
  }
  return { itemId: first.id, boardId: first.board.id };
};

/**
 * Variant of `lookupItemBoard` that also returns `hierarchy_type`,
 * driving M9's classic-only subitem gate. SDK 14.0.0 doesn't type
 * `hierarchy_type` on `Board` (cli-design §2.8), so the raw escape
 * hatch is the M9 work-around.
 */
export const lookupItemBoardWithHierarchy = async (
  inputs: LookupInputs,
): Promise<{
  readonly itemId: string;
  readonly boardId: string;
  readonly hierarchyType: string | null;
}> => {
  const { client, itemId, label = 'Item', detailKey = 'item_id' } = inputs;
  const response = await client.raw<unknown>(
    ITEM_PARENT_LOOKUP_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemParentLookup' },
  );
  const data = unwrapOrThrow(
    parentLookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemParentLookup response for id ${itemId}`,
      details: { [detailKey]: itemId },
    },
  );
  const first = data.items?.[0];
  if (first === undefined) {
    throw new ApiError(
      'not_found',
      `${label} ${itemId} does not exist or the token has no read access.`,
      { details: { [detailKey]: itemId } },
    );
  }
  if (first.board === null) {
    throw new ApiError(
      'not_found',
      `${label} ${itemId} has no readable board; the token may not have ` +
        `permission on its board, or the board is deleted.`,
      { details: { [detailKey]: itemId } },
    );
  }
  return {
    itemId: first.id,
    boardId: first.board.id,
    hierarchyType: first.board.hierarchy_type,
  };
};

/**
 * `--board <bid>` is authoritative; without it, Monday is queried.
 * Per cli-design §5.3 step 1 — "Implicit (preferred): `--board <bid>`
 * skips a lookup and is authoritative."
 */
export const resolveBoardId = async (inputs: {
  readonly client: MondayClient;
  readonly itemId: string;
  readonly explicit: string | undefined;
}): Promise<string> => {
  if (inputs.explicit !== undefined) return inputs.explicit;
  const result = await lookupItemBoard({
    client: inputs.client,
    itemId: inputs.itemId,
  });
  return result.boardId;
};
