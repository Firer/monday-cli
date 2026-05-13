/**
 * Surface tests for `src/api/partial-success-bulk.ts` — the
 * v0.3-M25 partial-success bulk wrapper feeding the
 * `item update --where ... --continue-on-error` envelope shape
 * (cli-design §6.4 "Bulk per-item partial-success" sub-section).
 *
 * Scope: pure helpers (`foldPartialSuccessBulkResult` +
 * `buildPartialSuccessBulkSummary`) + the runtime
 * `runPartialSuccessBulkUpdate` body driven via a sequence-aware
 * seam-injected `MondayClient` stub (mock-at-the-network-
 * boundary per testing.md). The wrapper fires `client.raw` once
 * per matched item; the same `operationName` may appear N times
 * across the dispatch loop, so the stub takes a per-op-name FIFO
 * queue rather than the simpler single-response shape the M23
 * `board-favorites.test.ts` / M24 `item-history-projection.test.ts`
 * stubs use.
 *
 * **R-NEW-20 4th-consumer evaluation.** The M25 wrapper is the
 * 4th unit-test consumer of the seam-injected `MondayClient`
 * stub pattern (after M23 favorites, M23 cross-board search,
 * M24 history projection). The 4 consumers diverge on routing
 * logic — M23-favorites + M24-history route by `operationName`,
 * M23-cross-board routes by `boardId` variable, M25 routes by
 * `operationName` + per-call sequence. Lift to a shared
 * `tests/_helpers/build-monday-client-stub.ts` deferred at the
 * 4th consumer with the rationale that a parametrised shared
 * factory has to subsume three routing strategies (op-name-only,
 * variable-keyed, sequence-aware) and would carry more surface
 * than the per-test-file inline copies it replaces. Re-evaluate
 * if a 5th consumer surfaces (M27 webhook bulk-fan-out
 * candidate) with the same sequence-aware shape as M25.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE,
  buildPartialSuccessBulkSummary,
  foldPartialSuccessBulkResult,
  partialSuccessBulkUpdateDataSchema,
  partialSuccessBulkUpdateResultSchema,
  runPartialSuccessBulkUpdate,
  type PartialSuccessBulkUpdateResult,
} from '../../../src/api/partial-success-bulk.js';
import { ApiError, MondayCliError, UsageError } from '../../../src/utils/errors.js';
import type {
  MondayClient,
  MondayResponse,
} from '../../../src/api/client.js';
import type { ProjectedItem } from '../../../src/api/item-projection.js';
import type { SelectedMutation } from '../../../src/api/column-values.js';
import type { ResolverWarning } from '../../../src/api/columns.js';
import type { Complexity } from '../../../src/utils/output/envelope.js';

const emptyComplexity = (): Complexity | null => null;
const emptyStats = { attempts: 1, sleeps: [] };

const buildProjectedItem = (id: string): ProjectedItem => ({
  id,
  name: `Item ${id}`,
  board_id: '111',
  group_id: null,
  parent_item_id: null,
  state: 'active',
  url: null,
  created_at: null,
  updated_at: null,
  columns: {},
});

/** Raw Item shape the executeItemMutation projector accepts. */
const buildRawItemResponse = (
  id: string,
  rootKey:
    | 'change_simple_column_value'
    | 'change_column_value'
    | 'change_multiple_column_values',
): MondayResponse<unknown> => ({
  data: {
    [rootKey]: {
      id,
      name: `Item ${id}`,
      state: 'active',
      url: null,
      created_at: null,
      updated_at: null,
      board: { id: '111' },
      column_values: [],
    },
  },
  complexity: emptyComplexity(),
  stats: emptyStats,
});

/**
 * Sequence-aware MondayClient stub. Each op-name has a FIFO queue
 * of responses; consecutive calls to the same op-name dequeue in
 * order. Throws if the queue is exhausted or missing — surfaces
 * "the wrapper dispatched a leg we didn't plan for" mismatches
 * loudly. Mirrors the M23 / M24 stub shape but parameterised on
 * sequence rather than single-response.
 */
const buildSequenceClientStub = (
  responses: Readonly<
    Record<
      string,
      | MondayResponse<unknown>
      | Error
      | readonly (MondayResponse<unknown> | Error)[]
    >
  >,
): {
  client: MondayClient;
  raw: ReturnType<typeof vi.fn>;
} => {
  const queues = new Map<string, (MondayResponse<unknown> | Error)[]>();
  for (const [opName, value] of Object.entries(responses)) {
    if (Array.isArray(value)) {
      queues.set(opName, [...(value as readonly (MondayResponse<unknown> | Error)[])]);
    } else {
      queues.set(opName, [value as MondayResponse<unknown> | Error]);
    }
  }
  const raw = vi.fn(
    (
      _query: string,
      _variables: Readonly<Record<string, unknown>> | undefined,
      options: { operationName?: string } = {},
    ): Promise<MondayResponse<unknown>> => {
      const opName = options.operationName ?? '<anon>';
      const queue = queues.get(opName);
      if (queue === undefined || queue.length === 0) {
        return Promise.reject(
          new Error(
            `buildSequenceClientStub: no canned response for ${opName} (queue empty)`,
          ),
        );
      }
      const next = queue.shift();
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `buildSequenceClientStub: queue shift returned undefined for ${opName}`,
          ),
        );
      }
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next);
    },
  );
  const client = { raw } as unknown as MondayClient;
  return { client, raw };
};

const simpleStatusMutation: SelectedMutation = {
  kind: 'change_simple_column_value',
  columnId: 'status_4',
  value: 'Done',
};

const richMutation: SelectedMutation = {
  kind: 'change_column_value',
  columnId: 'status_4',
  value: { label: 'Done' },
};

const multiMutation: SelectedMutation = {
  kind: 'change_multiple_column_values',
  columnValues: {
    status_4: { label: 'Done' },
    date4: '2026-05-15',
  },
};

const baseInputs = {
  boardId: '111',
  createLabelsIfMissing: undefined,
  resolverWarnings: [] as readonly ResolverWarning[],
  remapColumnIds: ['status_4'] as readonly string[],
  env: {} as NodeJS.ProcessEnv,
  noCache: false,
  resolutionSource: 'live' as const,
};

// ============================================================
// PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE constant
// ============================================================

describe('PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE', () => {
  it('is the literal "live" — every per-item mutation contributes a live leg', () => {
    // Action layer reads against this named constant rather than
    // a bare literal so the contract surface stays discoverable.
    // Mirrors the v0.1 fail-fast path's terminal
    // sourceAgg.record('live', null) at update.ts:1196.
    expect(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE).toBe('live');
  });
});

// ============================================================
// foldPartialSuccessBulkResult — per-row projection helper
// ============================================================

describe('foldPartialSuccessBulkResult', () => {
  it('projects a success row carrying ProjectedItem into the per-record success shape', () => {
    const projected = buildProjectedItem('5001');
    const row = { item_id: '5001', ok: true };
    const result = foldPartialSuccessBulkResult(row, projected);
    expect(result).toEqual({
      item_id: '5001',
      ok: true,
      item: projected,
    });
    // Mutual-exclusion: success records carry `item` but NOT `error`.
    expect(result.error).toBeUndefined();
  });

  it('projects a failure row carrying error into the per-record failure shape', () => {
    const row = {
      item_id: '5002',
      ok: false,
      error: { code: 'column_archived', message: 'archived' },
    };
    const result = foldPartialSuccessBulkResult(row, undefined);
    expect(result).toEqual({
      item_id: '5002',
      ok: false,
      error: { code: 'column_archived', message: 'archived' },
    });
    // Mutual-exclusion: failure records carry `error` but NOT `item`.
    expect(result.item).toBeUndefined();
  });

  it('throws internal_error when a success row arrives without a captured ProjectedItem (wrapper-layer side-map miss)', () => {
    const row = { item_id: '5001', ok: true };
    expect(() => foldPartialSuccessBulkResult(row, undefined)).toThrow(
      ApiError,
    );
    expect(() => foldPartialSuccessBulkResult(row, undefined)).toThrow(
      /side-map miss/,
    );
    try {
      foldPartialSuccessBulkResult(row, undefined);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      if (err instanceof ApiError) {
        expect(err.code).toBe('internal_error');
        expect(err.details).toMatchObject({ item_id: '5001' });
      }
    }
  });

  it('throws internal_error when a failure row arrives without an error payload (dispatcher contract violation)', () => {
    const row = { item_id: '5002', ok: false };
    expect(() => foldPartialSuccessBulkResult(row, undefined)).toThrow(
      /no error payload/,
    );
    try {
      foldPartialSuccessBulkResult(row, undefined);
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.code).toBe('internal_error');
        expect(err.details).toMatchObject({ item_id: '5002' });
      }
    }
  });

  it('throws internal_error when the row is missing the item_id slot', () => {
    // dispatchSequential populates the id-field for every result row;
    // an absent slot is a programmer bug, not a Monday-side failure.
    const row = { ok: true } as unknown as Parameters<
      typeof foldPartialSuccessBulkResult
    >[0];
    expect(() =>
      foldPartialSuccessBulkResult(row, buildProjectedItem('5001')),
    ).toThrow(/missing the `item_id` field/);
  });

  it('throws internal_error when the item_id slot is non-string', () => {
    const row = { item_id: 5001 as unknown as string, ok: true };
    expect(() =>
      foldPartialSuccessBulkResult(row, buildProjectedItem('5001')),
    ).toThrow(/missing the `item_id` field/);
  });

  it('throws internal_error when the item_id slot is empty', () => {
    const row = { item_id: '', ok: true };
    expect(() =>
      foldPartialSuccessBulkResult(row, buildProjectedItem('')),
    ).toThrow(/missing the `item_id` field/);
  });
});

// ============================================================
// buildPartialSuccessBulkSummary — summary projection helper
// ============================================================

describe('buildPartialSuccessBulkSummary', () => {
  const projected = buildProjectedItem('5001');

  it('derives applied_count + failed_count from the result records', () => {
    const results: readonly PartialSuccessBulkUpdateResult[] = [
      { item_id: '5001', ok: true, item: projected },
      { item_id: '5002', ok: false, error: { code: 'x', message: 'y' } },
      { item_id: '5003', ok: true, item: buildProjectedItem('5003') },
    ];
    expect(
      buildPartialSuccessBulkSummary({
        matchedCount: 3,
        boardId: '111',
        results,
      }),
    ).toEqual({
      matched_count: 3,
      applied_count: 2,
      failed_count: 1,
      board_id: '111',
    });
  });

  it('handles the all-success path (failed_count: 0)', () => {
    const results: readonly PartialSuccessBulkUpdateResult[] = [
      { item_id: '5001', ok: true, item: projected },
      { item_id: '5002', ok: true, item: buildProjectedItem('5002') },
    ];
    expect(
      buildPartialSuccessBulkSummary({
        matchedCount: 2,
        boardId: '111',
        results,
      }),
    ).toEqual({
      matched_count: 2,
      applied_count: 2,
      failed_count: 0,
      board_id: '111',
    });
  });

  it('handles the all-failed path (applied_count: 0, but top-level envelope stays ok: true via universal partial-success)', () => {
    const results: readonly PartialSuccessBulkUpdateResult[] = [
      { item_id: '5001', ok: false, error: { code: 'x', message: 'y' } },
      { item_id: '5002', ok: false, error: { code: 'x', message: 'y' } },
    ];
    expect(
      buildPartialSuccessBulkSummary({
        matchedCount: 2,
        boardId: '111',
        results,
      }),
    ).toEqual({
      matched_count: 2,
      applied_count: 0,
      failed_count: 2,
      board_id: '111',
    });
  });

  it('throws internal_error when matched_count != applied_count + failed_count (invariant violation)', () => {
    const results: readonly PartialSuccessBulkUpdateResult[] = [
      { item_id: '5001', ok: true, item: projected },
    ];
    expect(() =>
      buildPartialSuccessBulkSummary({
        matchedCount: 5,
        boardId: '111',
        results,
      }),
    ).toThrow(/invariant violated/);
    try {
      buildPartialSuccessBulkSummary({
        matchedCount: 5,
        boardId: '111',
        results,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        expect(err.code).toBe('internal_error');
        expect(err.details).toMatchObject({
          matched_count: 5,
          applied_count: 1,
          failed_count: 0,
          board_id: '111',
        });
      }
    }
  });
});

// ============================================================
// runPartialSuccessBulkUpdate — runtime body driver
// ============================================================

describe('runPartialSuccessBulkUpdate — all-success path', () => {
  it('fires one ItemUpdateSimple per matched item + returns ProjectedItems in results[i].item', async () => {
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
        buildRawItemResponse('5002', 'change_simple_column_value'),
        buildRawItemResponse('5003', 'change_simple_column_value'),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002', '5003'],
      mutation: simpleStatusMutation,
    });
    expect(raw).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(3);
    expect(result.results[0]?.item_id).toBe('5001');
    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[0]?.item?.id).toBe('5001');
    expect(result.results[0]?.error).toBeUndefined();
    expect(result.results[1]?.item?.id).toBe('5002');
    expect(result.results[2]?.item?.id).toBe('5003');
  });
});

describe('runPartialSuccessBulkUpdate — change_column_value (rich) shape', () => {
  it('drives ItemUpdateRich for rich-mutation kinds', async () => {
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateRich: [
        buildRawItemResponse('5001', 'change_column_value'),
        buildRawItemResponse('5002', 'change_column_value'),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002'],
      mutation: richMutation,
    });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[0]?.[2]).toEqual({ operationName: 'ItemUpdateRich' });
    expect(result.results.every((r) => r.ok)).toBe(true);
  });
});

describe('runPartialSuccessBulkUpdate — change_multiple_column_values shape', () => {
  it('drives ItemUpdateMulti for multi-column mutations', async () => {
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateMulti: [
        buildRawItemResponse('5001', 'change_multiple_column_values'),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: multiMutation,
      remapColumnIds: ['status_4', 'date4'],
    });
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]?.[2]).toEqual({ operationName: 'ItemUpdateMulti' });
    expect(result.results[0]?.ok).toBe(true);
  });
});

describe('runPartialSuccessBulkUpdate — all-failed path (universal partial-success)', () => {
  it('lands every per-item failure into results[i].error without aborting', async () => {
    const wireFailure = new ApiError('validation_failed', 'invalid value', {
      details: {},
    });
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [wireFailure, wireFailure, wireFailure],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002', '5003'],
      mutation: simpleStatusMutation,
    });
    expect(raw).toHaveBeenCalledTimes(3);
    expect(result.results).toHaveLength(3);
    for (const record of result.results) {
      expect(record.ok).toBe(false);
      expect(record.error?.code).toBe('validation_failed');
      expect(record.item).toBeUndefined();
    }
  });
});

describe('runPartialSuccessBulkUpdate — mixed success/failure path', () => {
  it('captures per-record outcomes in input order', async () => {
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
        new ApiError('validation_failed', 'rejected by Monday', {}),
        buildRawItemResponse('5003', 'change_simple_column_value'),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002', '5003'],
      mutation: simpleStatusMutation,
    });
    expect(result.results).toHaveLength(3);
    expect(result.results[0]).toMatchObject({
      item_id: '5001',
      ok: true,
    });
    expect(result.results[0]?.item?.id).toBe('5001');
    expect(result.results[1]).toMatchObject({
      item_id: '5002',
      ok: false,
      error: { code: 'validation_failed' },
    });
    expect(result.results[1]?.item).toBeUndefined();
    expect(result.results[2]).toMatchObject({
      item_id: '5003',
      ok: true,
    });
    expect(result.results[2]?.item?.id).toBe('5003');
  });
});

describe('runPartialSuccessBulkUpdate — foldAndRemap per-item remap (Codex round-1 P1-1)', () => {
  it('remaps cache-sourced validation_failed → column_archived per-item when refresh confirms archived', async () => {
    const wireFailure = new ApiError(
      'validation_failed',
      'column is archived',
      { details: {} },
    );
    const refreshedArchived: MondayResponse<unknown> = {
      data: {
        boards: [
          {
            id: '111',
            name: 'Board',
            description: null,
            state: 'active',
            board_kind: null,
            board_folder_id: null,
            workspace_id: null,
            url: null,
            hierarchy_type: null,
            is_leaf: null,
            items_count: null,
            permissions: null,
            updated_at: null,
            groups: [],
            columns: [
              {
                id: 'status_4',
                title: 'Status',
                type: 'status',
                description: null,
                archived: true,
                settings_str: '{}',
                width: null,
              },
            ],
          },
        ],
      },
      complexity: emptyComplexity(),
      stats: emptyStats,
    };
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [wireFailure],
      BoardMetadata: [refreshedArchived],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: simpleStatusMutation,
      resolutionSource: 'cache',
    });
    // Pre-remap code: validation_failed. Post-remap code:
    // column_archived (per cli-design §6.5 stable-code rule).
    // The remap fires only when resolutionSource is 'cache' /
    // 'mixed' AND the BoardMetadata refresh confirms archived.
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error?.code).toBe('column_archived');
    expect(result.results[0]?.error?.message).toMatch(/archived/);
  });

  it('skips foldAndRemap when resolutionSource is "live" (genuine validation_failed surfaces unchanged)', async () => {
    // Live resolution already saw the live archived flag, so a
    // post-resolution validation_failed is genuine (label typo,
    // schema mismatch). The refresh probe must not fire.
    const wireFailure = new ApiError('validation_failed', 'bad value', {});
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [wireFailure],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: simpleStatusMutation,
      resolutionSource: 'live',
    });
    // Only one raw call — the wire mutation. The BoardMetadata
    // refresh would have been call #2, but the live-source guard
    // in foldAndRemap short-circuits before reaching it.
    expect(raw).toHaveBeenCalledTimes(1);
    expect(result.results[0]?.error?.code).toBe('validation_failed');
  });

  it('folds resolver warnings into per-item error.details when resolverWarnings is non-empty', async () => {
    const wireFailure = new ApiError('column_archived', 'archived', {
      details: {},
    });
    const warning: ResolverWarning = {
      code: 'stale_cache_refreshed',
      message: 'cache miss',
      details: { token: 'status_4', resolved_to: 'status_4' },
    };
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [wireFailure],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: simpleStatusMutation,
      resolverWarnings: [warning],
    });
    // foldAndRemap surfaces a new error carrying the warnings in
    // details.resolver_warnings. The dispatchSequential per-record
    // error decoration drops `details` (only carries `{code,
    // message}` per the partial-success contract), so the assert
    // here is on the code preservation across the fold.
    expect(result.results[0]?.error?.code).toBe('column_archived');
  });
});

describe('runPartialSuccessBulkUpdate — internal_error re-throw escape hatch (M14 round-2 F1 precedent)', () => {
  it('re-throws internal_error as whole-call rather than landing per-record', async () => {
    const schemaDrift = new ApiError(
      'internal_error',
      'Monday response missing root key',
      { details: {} },
    );
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [schemaDrift],
    });
    // dispatchSequential's escape hatch re-throws internal_error
    // so the runner's catch-all surfaces it as top-level
    // ok: false — not papered over as a per-record slot.
    let caught: unknown;
    try {
      await runPartialSuccessBulkUpdate({
        ...baseInputs,
        client,
        matchedItemIds: ['5001'],
        mutation: simpleStatusMutation,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    if (caught instanceof ApiError) {
      expect(caught.code).toBe('internal_error');
    }
  });

  it('re-throws BEFORE processing subsequent items (whole-call abort, not per-record)', async () => {
    const schemaDrift = new ApiError(
      'internal_error',
      'malformed response',
      { details: {} },
    );
    const { client, raw } = buildSequenceClientStub({
      // Only one response queued — if the wrapper continued past
      // the throw, the second call would surface the queue-empty
      // error rather than the internal_error escape hatch.
      ItemUpdateSimple: [schemaDrift],
    });
    await expect(
      runPartialSuccessBulkUpdate({
        ...baseInputs,
        client,
        matchedItemIds: ['5001', '5002'],
        mutation: simpleStatusMutation,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    // Whole-call abort: only the first item dispatched before the
    // throw bailed out.
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('does not call foldAndRemap on internal_error (foldAndRemap is a no-op for non-validation_failed codes, but the re-throw bypasses the remap context entirely)', async () => {
    // The wrapper catches MondayCliError → calls foldAndRemap →
    // re-throws. foldAndRemap is a no-op for non-
    // validation_failed codes (returns the error unchanged); the
    // re-throw then hits dispatchSequential's internal_error
    // arm. Net: the original internal_error surfaces whole-call.
    const schemaDrift = new ApiError(
      'internal_error',
      'malformed response',
      {},
    );
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [schemaDrift],
    });
    await expect(
      runPartialSuccessBulkUpdate({
        ...baseInputs,
        client,
        matchedItemIds: ['5001'],
        mutation: simpleStatusMutation,
        // Cache source would NORMALLY trigger the refresh probe,
        // but internal_error short-circuits foldAndRemap's
        // validation_failed-specific path.
        resolutionSource: 'cache',
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
    // Only ONE raw call — the wire mutation. The BoardMetadata
    // refresh would have fired if foldAndRemap probed; it didn't
    // because the code isn't validation_failed.
    expect(raw).toHaveBeenCalledTimes(1);
  });
});

describe('runPartialSuccessBulkUpdate — non-MondayCliError re-throw', () => {
  it('propagates programmer-bug exceptions (TypeError) through dispatchSequential as whole-call', async () => {
    const programmerBug = new TypeError('unexpected undefined');
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [programmerBug],
    });
    await expect(
      runPartialSuccessBulkUpdate({
        ...baseInputs,
        client,
        matchedItemIds: ['5001'],
        mutation: simpleStatusMutation,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('continues the dispatch loop past a UsageError fold (which becomes a per-record failure via foldAndRemap)', async () => {
    // foldAndRemap accepts MondayCliError subclasses (UsageError
    // included) and returns either the original or a remapped
    // ApiError. UsageError stays a UsageError (no remap fires for
    // non-validation_failed codes); dispatchSequential lands the
    // UsageError into the per-record slot.
    const usageErr = new UsageError('bad input shape', { details: {} });
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [
        usageErr,
        buildRawItemResponse('5002', 'change_simple_column_value'),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002'],
      mutation: simpleStatusMutation,
    });
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.error?.code).toBe('usage_error');
    expect(result.results[1]?.ok).toBe(true);
    expect(result.results[1]?.item?.id).toBe('5002');
  });
});

describe('runPartialSuccessBulkUpdate — empty matchedItemIds', () => {
  it('returns empty results array with no wire calls (action layer guards this path, but the wrapper is itself empty-safe)', async () => {
    // The action body's empty-match handler runs BEFORE the
    // partial-success routing branch, but the wrapper's
    // dispatchSequential loop is a no-op for empty inputs so the
    // wrapper is empty-safe regardless. Pinning the contract here
    // hedges against a future caller forgetting the empty-match
    // pre-check.
    const { client, raw } = buildSequenceClientStub({});
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: [],
      mutation: simpleStatusMutation,
    });
    expect(result.results).toEqual([]);
    expect(raw).not.toHaveBeenCalled();
  });
});

describe('runPartialSuccessBulkUpdate — schema parse of the produced data shape', () => {
  it('emits results that parse cleanly through partialSuccessBulkUpdateResultSchema', async () => {
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
        new ApiError('validation_failed', 'rejected', {}),
      ],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002'],
      mutation: simpleStatusMutation,
    });
    for (const record of result.results) {
      expect(() =>
        partialSuccessBulkUpdateResultSchema.parse(record),
      ).not.toThrow();
    }
  });

  it('the full partial-success bulk data shape parses cleanly after the action layer assembles operation + summary', async () => {
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
        buildRawItemResponse('5002', 'change_simple_column_value'),
      ],
    });
    const wrapperResult = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002'],
      mutation: simpleStatusMutation,
    });
    const summary = buildPartialSuccessBulkSummary({
      matchedCount: 2,
      boardId: '111',
      results: wrapperResult.results,
    });
    const data = {
      operation: 'item_update' as const,
      summary,
      results: wrapperResult.results,
    };
    expect(() => partialSuccessBulkUpdateDataSchema.parse(data)).not.toThrow();
    expect(data.summary.matched_count).toBe(2);
    expect(data.summary.applied_count).toBe(2);
    expect(data.summary.failed_count).toBe(0);
  });
});

describe('runPartialSuccessBulkUpdate — createLabelsIfMissing threading', () => {
  it('passes createLabelsIfMissing through to the per-item executeItemMutation call', async () => {
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
      ],
    });
    await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: simpleStatusMutation,
      createLabelsIfMissing: true,
    });
    const variables = raw.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(variables.createLabelsIfMissing).toBe(true);
  });

  it('coerces undefined createLabelsIfMissing to the wire-default false', async () => {
    const { client, raw } = buildSequenceClientStub({
      ItemUpdateSimple: [
        buildRawItemResponse('5001', 'change_simple_column_value'),
      ],
    });
    await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001'],
      mutation: simpleStatusMutation,
      createLabelsIfMissing: undefined,
    });
    const variables = raw.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(variables.createLabelsIfMissing).toBe(false);
  });
});

describe('runPartialSuccessBulkUpdate — null wire payload (M5b "no item payload" projector arm)', () => {
  it('surfaces null change_simple_column_value payload as internal_error (re-thrown by dispatchSequential)', async () => {
    // Monday's mutation occasionally returns {data: {change_*: null}}
    // — projectMutationItem throws ApiError(internal_error) per
    // R28. The internal_error then routes through
    // dispatchSequential's escape hatch (whole-call re-throw).
    const nullPayload: MondayResponse<unknown> = {
      data: { change_simple_column_value: null },
      complexity: emptyComplexity(),
      stats: emptyStats,
    };
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [nullPayload],
    });
    await expect(
      runPartialSuccessBulkUpdate({
        ...baseInputs,
        client,
        matchedItemIds: ['5001'],
        mutation: simpleStatusMutation,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('runPartialSuccessBulkUpdate — MondayCliError subclass class preservation', () => {
  it('preserves the MondayCliError base class through foldAndRemap (per-record error.code matches the typed-error code)', async () => {
    // Pinning the M5b finding #2 / R19 invariant on the partial-
    // success path: foldResolverWarningsIntoError reconstructs the
    // error via the concrete typed constructor matching err.code,
    // so a UsageError stays a UsageError, an ApiError stays an
    // ApiError. dispatchSequential then surfaces the .code into
    // the per-record `error.code` slot regardless of subclass.
    const apiError = new ApiError('complexity_exceeded', 'over budget', {});
    const usageError = new UsageError('bad shape', { details: {} });
    const baseError = new MondayCliError('cache_error', 'cache miss', {});
    const { client } = buildSequenceClientStub({
      ItemUpdateSimple: [apiError, usageError, baseError],
    });
    const result = await runPartialSuccessBulkUpdate({
      ...baseInputs,
      client,
      matchedItemIds: ['5001', '5002', '5003'],
      mutation: simpleStatusMutation,
    });
    expect(result.results[0]?.error?.code).toBe('complexity_exceeded');
    expect(result.results[1]?.error?.code).toBe('usage_error');
    expect(result.results[2]?.error?.code).toBe('cache_error');
  });
});
