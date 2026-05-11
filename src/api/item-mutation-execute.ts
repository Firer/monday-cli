/**
 * Per-item column-write mutation executor — lifted from
 * `src/commands/item/update.ts` at the v0.3-M25 implementation
 * kickoff to share the wire-call shape across three consumers:
 *
 *   1. `src/commands/item/update.ts` single-item path
 *      (`updateCommand.attach` action body) — fires one mutation
 *      against the positional `<itemId>`.
 *   2. `src/commands/item/update.ts` fail-fast bulk path
 *      (`runBulk` loop) — fires one mutation per matched item;
 *      first error aborts the loop.
 *   3. `src/api/partial-success-bulk.ts`
 *      `runPartialSuccessBulkUpdate` — fires one mutation per
 *      matched item under `--continue-on-error`; per-item
 *      failures land in `data.results[]` rather than aborting.
 *
 * **Trigger.** v0.3-plan §22 R7/R8 timing rule (lift at the 3rd
 * consumer). Pre-M25 the helper lived locally in `update.ts`;
 * M25 IMPL adds the partial-success bulk consumer + lifts the
 * helper here so all three sites share the single wire-call
 * source of truth. Mirrors `85b93e8`'s R-class cleanup bundle
 * cadence that landed ahead of `d5839a9` (M25 pre-flight) — R-
 * class refactor ships in its own commit AHEAD of the feat
 * commit so the impl-review diff is smaller + the refactor's
 * structural-change risk is isolated from the feat's behavioural
 * change.
 *
 * **What lifts.** The three GraphQL mutation strings
 * (`change_simple_column_value` / `change_column_value` /
 * `change_multiple_column_values`), their response-shape
 * interfaces, `executeItemMutation` (the per-mutation-kind
 * dispatcher), and the local `projectMutationItem` wrapper
 * (which itself is a thin call through to
 * `src/api/item-mutation-result.ts`). No behaviour change — the
 * lift is purely structural; the existing integration test
 * coverage for the three mutation kinds (set, update single-
 * item, update bulk fail-fast) all exercise this helper unchanged.
 *
 * **What stays at the call site.** Argv parse, column resolution,
 * dry-run path, confirmation gate, `foldAndRemap` per-item-error
 * remap, `SourceAggregator` fold, envelope assembly via
 * `emitMutation`. The lift is scoped to "the wire-call dispatch
 * + the post-mutation projection"; everything before and after
 * stays at the call layer.
 */

import type { MondayClient, MondayResponse } from './client.js';
import {
  ITEM_FIELDS_FRAGMENT,
} from './item-helpers.js';
import { projectMutationItem as projectMutationItemShared } from './item-mutation-result.js';
import { assertResponseFieldPresent } from './response-root.js';
import type { ProjectedItem } from './item-projection.js';
import type { SelectedMutation } from './column-values.js';

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpdateSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
    $createLabelsIfMissing: Boolean
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemUpdateRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION = `
  mutation ItemUpdateMulti(
    $itemId: ID!
    $boardId: ID!
    $columnValues: JSON!
    $createLabelsIfMissing: Boolean
  ) {
    change_multiple_column_values(
      item_id: $itemId
      board_id: $boardId
      column_values: $columnValues
      create_labels_if_missing: $createLabelsIfMissing
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}
interface ChangeMultipleResponse {
  readonly change_multiple_column_values: unknown;
}

export interface ExecuteItemMutationInputs {
  readonly mutation: SelectedMutation;
  readonly itemId: string;
  readonly boardId: string;
  readonly createLabelsIfMissing: boolean | undefined;
}

export interface ExecuteItemMutationResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

/**
 * Fires the per-mutation-kind wire call against the supplied item
 * + board + column-resolved `SelectedMutation`, returning the
 * post-mutation `ProjectedItem` projection plus the raw response
 * (callers may pluck `request_id` from the response for envelope
 * meta).
 *
 * Throws an `internal_error` typed `ApiError` (via
 * `assertResponseFieldPresent`) when Monday's response lacks the
 * expected mutation root key (schema drift). Returns `null`-
 * handling responsibility to the caller via `nullHandling:
 * 'caller_handles'` so the local `projectMutationItem` wrapper
 * surfaces the M5b "no item payload" `internal_error` with
 * `details.item_id` (per R28 / `item-mutation-result.ts`'s
 * `caller_handles` semantics).
 *
 * The three consumers (single-item path, fail-fast bulk loop,
 * partial-success bulk wrapper) each layer their own
 * post-mutation error handling (`foldAndRemap` per-item remap,
 * bulk-progress decoration, partial-success per-record fold)
 * above this helper's throw path.
 */
export const executeItemMutation = async (
  client: MondayClient,
  inputs: ExecuteItemMutationInputs,
): Promise<ExecuteItemMutationResult> => {
  const { mutation, itemId, boardId, createLabelsIfMissing } = inputs;
  const labelsFlag = createLabelsIfMissing ?? false;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateSimple' },
    );
    assertResponseFieldPresent({
      data: response.data,
      key: 'change_simple_column_value',
      operationLabel: 'ItemUpdateSimple',
      details: { item_id: itemId, board_id: boardId },
      nullHandling: 'caller_handles',
    });
    return {
      projected: projectMutationItem(
        response.data.change_simple_column_value,
        itemId,
      ),
      response,
    };
  }
  if (mutation.kind === 'change_column_value') {
    const response = await client.raw<ChangeColumnResponse>(
      CHANGE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
        createLabelsIfMissing: labelsFlag,
      },
      { operationName: 'ItemUpdateRich' },
    );
    assertResponseFieldPresent({
      data: response.data,
      key: 'change_column_value',
      operationLabel: 'ItemUpdateRich',
      details: { item_id: itemId, board_id: boardId },
      nullHandling: 'caller_handles',
    });
    return {
      projected: projectMutationItem(
        response.data.change_column_value,
        itemId,
      ),
      response,
    };
  }
  // change_multiple_column_values — multi-`--set` or `--set + --name`.
  const response = await client.raw<ChangeMultipleResponse>(
    CHANGE_MULTIPLE_COLUMN_VALUES_MUTATION,
    {
      itemId,
      boardId,
      columnValues: mutation.columnValues,
      createLabelsIfMissing: labelsFlag,
    },
    { operationName: 'ItemUpdateMulti' },
  );
  assertResponseFieldPresent({
    data: response.data,
    key: 'change_multiple_column_values',
    operationLabel: 'ItemUpdateMulti',
    details: { item_id: itemId, board_id: boardId },
    nullHandling: 'caller_handles',
  });
  return {
    projected: projectMutationItem(
      response.data.change_multiple_column_values,
      itemId,
    ),
    response,
  };
};

// Thin wrapper around `api/item-mutation-result.ts projectMutationItem`
// (R28). M5b's `internal_error` + "no item payload" semantics for an
// empty-payload mutation success are preserved; the wrapper keeps the
// existing `(raw, itemId)` call signature so executeItemMutation's
// three arms stay readable inline.
const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem =>
  projectMutationItemShared({
    raw,
    itemId,
    errorCode: 'internal_error',
    errorMessage:
      `Monday returned no item payload from the mutation for id ${itemId}.`,
  });
