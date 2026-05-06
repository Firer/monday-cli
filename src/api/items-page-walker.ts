/**
 * `items_page` GraphQL helper — single-page fetcher pair
 * (`v0.2-plan.md` §18 R34).
 *
 * Lifted from five sites that all hand-rolled the same
 * `query Foo($boardId: ID!, $limit: Int!, $queryParams: ItemsQuery)
 * { boards(ids: [$boardId]) { items_page(...) { cursor items {...} } } }`
 * shape with per-site item-field projection + per-site
 * `unwrapOrThrow`-wrapped malformed-response handling. The shared
 * surface is:
 *
 *   - GraphQL string assembly (operation name + optional group-filter
 *     wrapper + caller-supplied item-fields fragment).
 *   - Response parse boundary — `boards[0]` (and `groups[0]` for the
 *     group-filtered variant) → `items_page.{cursor, items[]}` with
 *     the matching malformed-response context message.
 *
 * **Operation name as a parameter**, not a constant. The SDK threads
 * `operationName` to Monday's request-log telemetry so a `bulk item
 * update --where` walk is distinguishable from a `bulk item clear
 * --where` walk in Monday's logs. Same reason §18 R33 stays deferred:
 * collapsing operations under one name breaks attribution.
 *
 * **Item-fields fragment as a string**, not a typed projection. Three
 * projections in scope today: `id` (clear / update bulk walkers),
 * `id\n          name` (upsert lookup), `${ITEM_FIELDS_FRAGMENT}`
 * (item list). Projections are inlined verbatim into the query
 * source — the per-call response zod schema validates that the rows
 * Monday returned actually match.
 *
 * **Group-filter variant** (`item list --group <gid>`) wraps an extra
 * `groups(ids: [$groupId])` selection between `boards` and
 * `items_page`. The helper switches the query shape and the response
 * schema based on the optional `groupId` input — both the wire shape
 * and Monday's accepted variable set diverge between the two queries
 * (the top-level `items_page` doesn't accept `group_id` inside
 * `query_params`, so the group-aware path is structurally distinct).
 *
 * **The cursor walker stays in `pagination.ts`.** All bulk consumers
 * (item list, item update --where, item clear --where) thread these
 * single-page fetchers through `paginate.ts`'s `fetchInitial` /
 * `fetchNext` closures. That preserves the §3.1 #8 per-page
 * ascending-by-ID sort and the §5.6 `stale_cursor` enrichment
 * (`cursor_age_seconds` / `items_returned_so_far` / `last_item_id`)
 * across every site post-lift. Codex round-1 F1 + F2 caught the
 * variant where a thin generator dropped both — pure refactor must
 * match pre-lift behavior, not just pre-lift error code.
 *
 * **stale_cursor fail-fast.** `cli-design.md` §5.6 — Monday's cursor
 * lifetime is 60 min, expired cursors return `INVALID_CURSOR_EXCEPTION`
 * which `api/errors.ts` maps to `error.code === 'stale_cursor'`. The
 * helper bubbles the error unchanged so `paginate.ts` can layer its
 * §5.6 details enrichment on top.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import type { MondayClient, MondayResponse } from './client.js';

/**
 * Inputs for a single `items_page(query_params:)` call. The `groupId`
 * slot switches the query shape to the `boards.groups.items_page`
 * variant; absent it the top-level `boards.items_page` is used.
 */
export interface ItemsPageInputs<T> {
  readonly client: MondayClient;
  /**
   * Operation name threaded to Monday for telemetry / error
   * attribution (e.g. `'ItemsPage'`, `'ItemsPageByGroup'`,
   * `'ItemUpsertLookup'`). Per-call-site naming preserves Monday's
   * request-log triage even when the underlying GraphQL is identical.
   */
  readonly operationName: string;
  readonly boardId: string;
  /** Group-filter variant when defined; top-level `items_page` otherwise. */
  readonly groupId?: string;
  readonly limit: number;
  readonly queryParams: Readonly<Record<string, unknown>> | undefined;
  /**
   * Inner-fragment GraphQL string for the per-row projection — e.g.
   * `'id'`, `'id\n          name'`, or `${ITEM_FIELDS_FRAGMENT}`.
   * Inlined verbatim into the query source.
   */
  readonly itemFields: string;
  /** Per-row zod schema. The helper wraps it in the items_page envelope. */
  readonly itemSchema: z.ZodType<T>;
}

/**
 * Inputs for a single `next_items_page(cursor:)` continuation call.
 * No `boardId` / `groupId` / `queryParams` — the cursor encodes the
 * server-side filter state.
 */
export interface NextItemsPageInputs<T> {
  readonly client: MondayClient;
  readonly operationName: string;
  readonly cursor: string;
  readonly limit: number;
  readonly itemFields: string;
  readonly itemSchema: z.ZodType<T>;
}

/**
 * Single-page response payload after parse — `MondayResponse.data`
 * is re-typed to the parsed `{items, cursor}` shape. The wider
 * response (complexity, stats) passes through unchanged so callers
 * driving `paginate.ts`'s rich walker can lift `complexity` /
 * request id off the same envelope they get today.
 */
export interface ItemsPagePayload<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

const buildItemsPageQuery = (inputs: {
  readonly operationName: string;
  readonly hasGroup: boolean;
  readonly itemFields: string;
}): string => {
  const itemsPage = `items_page(limit: $limit, query_params: $queryParams) {
        cursor
        items {
          ${inputs.itemFields}
        }
      }`;
  if (inputs.hasGroup) {
    return `
  query ${inputs.operationName}(
    $boardId: ID!
    $groupId: String!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      groups(ids: [$groupId]) {
        ${itemsPage}
      }
    }
  }
`;
  }
  return `
  query ${inputs.operationName}(
    $boardId: ID!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      ${itemsPage}
    }
  }
`;
};

const buildNextItemsPageQuery = (inputs: {
  readonly operationName: string;
  readonly itemFields: string;
}): string => `
  query ${inputs.operationName}($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        ${inputs.itemFields}
      }
    }
  }
`;

// Schema builders are inlined per call site so the generic-instance
// types stay narrow per fetcher (the lint
// `explicit-function-return-type` rule combined with zod's deeply
// nested ZodObject<...> inferred return type makes a top-level
// builder ergonomically infeasible without massive annotations —
// the inlined versions infer cleanly from each call site's `T`).

/**
 * Fires one `items_page(query_params:)` query and returns the parsed
 * `{items, cursor}` payload as `MondayResponse.data`. The wider
 * `MondayResponse` shape (complexity, stats) passes through untouched
 * so callers can spread it into `toEmit(response)` for `meta`.
 *
 * Malformed responses surface as typed `internal_error` carrying
 * `details.issues` (per-field zod failure path) — same parse-boundary
 * contract as the standalone `unwrapOrThrow` helper.
 */
export const fetchItemsPage = async <T>(
  inputs: ItemsPageInputs<T>,
): Promise<MondayResponse<ItemsPagePayload<T>>> => {
  const hasGroup = inputs.groupId !== undefined;
  const query = buildItemsPageQuery({
    operationName: inputs.operationName,
    hasGroup,
    itemFields: inputs.itemFields,
  });
  const variables: Record<string, unknown> = {
    boardId: inputs.boardId,
    limit: inputs.limit,
  };
  if (hasGroup) {
    variables.groupId = inputs.groupId;
  }
  if (inputs.queryParams !== undefined) {
    variables.queryParams = inputs.queryParams;
  } else {
    variables.queryParams = null;
  }
  const response = await inputs.client.raw<unknown>(query, variables, {
    operationName: inputs.operationName,
  });
  const context = `Monday returned a malformed ${inputs.operationName} response for board ${inputs.boardId}`;
  const details = { board_id: inputs.boardId };
  const itemsPage = hasGroup
    ? extractGroupedItemsPage<T>(response.data, inputs.itemSchema, {
        context,
        details,
        operationName: inputs.operationName,
      })
    : extractTopLevelItemsPage<T>(response.data, inputs.itemSchema, {
        context,
        details,
        operationName: inputs.operationName,
      });
  return {
    ...response,
    data: { items: itemsPage.items, cursor: itemsPage.cursor },
  };
};

interface ExtractContext {
  readonly context: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly operationName: string;
}

const extractTopLevelItemsPage = <T>(
  data: unknown,
  itemSchema: z.ZodType<T>,
  ctx: ExtractContext,
): { readonly cursor: string | null; readonly items: readonly T[] } => {
  const schema = z
    .object({
      boards: z
        .array(
          z
            .object({
              items_page: z.object({
                cursor: z.string().nullable(),
                items: z.array(itemSchema),
              }),
            })
            .loose(),
        )
        .min(1),
    })
    .loose();
  const parsed = unwrapOrThrow(schema.safeParse(data), {
    context: ctx.context,
    details: ctx.details,
  });
  // Schema's `.min(1)` already rejected empty boards arrays; the
  // guard satisfies `noUncheckedIndexedAccess`.
  const board = parsed.boards[0];
  /* c8 ignore next 6 */
  if (board === undefined) {
    throw new ApiError(
      'internal_error',
      `${ctx.operationName}: empty boards array`,
    );
  }
  return board.items_page;
};

const extractGroupedItemsPage = <T>(
  data: unknown,
  itemSchema: z.ZodType<T>,
  ctx: ExtractContext,
): { readonly cursor: string | null; readonly items: readonly T[] } => {
  const schema = z
    .object({
      boards: z
        .array(
          z
            .object({
              groups: z
                .array(
                  z
                    .object({
                      items_page: z.object({
                        cursor: z.string().nullable(),
                        items: z.array(itemSchema),
                      }),
                    })
                    .loose(),
                )
                .min(1),
            })
            .loose(),
        )
        .min(1),
    })
    .loose();
  const parsed = unwrapOrThrow(schema.safeParse(data), {
    context: ctx.context,
    details: ctx.details,
  });
  const board = parsed.boards[0];
  /* c8 ignore next 6 */
  if (board === undefined) {
    throw new ApiError(
      'internal_error',
      `${ctx.operationName}: empty boards array`,
    );
  }
  const group = board.groups[0];
  /* c8 ignore next 6 */
  if (group === undefined) {
    throw new ApiError(
      'internal_error',
      `${ctx.operationName}: empty groups array`,
    );
  }
  return group.items_page;
};

/**
 * Fires one `next_items_page(cursor:)` continuation and returns the
 * parsed `{items, cursor}` payload. Same parse-boundary contract as
 * {@link fetchItemsPage}.
 */
export const fetchNextItemsPage = async <T>(
  inputs: NextItemsPageInputs<T>,
): Promise<MondayResponse<ItemsPagePayload<T>>> => {
  const query = buildNextItemsPageQuery({
    operationName: inputs.operationName,
    itemFields: inputs.itemFields,
  });
  const response = await inputs.client.raw<unknown>(
    query,
    { cursor: inputs.cursor, limit: inputs.limit },
    { operationName: inputs.operationName },
  );
  const schema = z
    .object({
      next_items_page: z.object({
        cursor: z.string().nullable(),
        items: z.array(inputs.itemSchema),
      }),
    })
    .loose();
  const data = unwrapOrThrow(schema.safeParse(response.data), {
    context: `Monday returned a malformed ${inputs.operationName} response`,
    details: { cursor: inputs.cursor },
  });
  return {
    ...response,
    data: {
      items: data.next_items_page.items,
      cursor: data.next_items_page.cursor,
    },
  };
};

