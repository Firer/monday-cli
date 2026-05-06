/**
 * Unit tests for `src/api/items-page-walker.ts` — the
 * `fetchItemsPage` / `fetchNextItemsPage` single-page helpers lifted
 * in §18 R34 (post-M12). The cursor walker stays in `pagination.ts`
 * across all five migration sites — every consumer (upsert single-
 * page, list / update bulk / clear bulk multi-page) routes the
 * helper through `paginate.ts`'s fetcher closures so the §3.1 #8
 * per-page sort and §5.6 `stale_cursor` enrichment carry over.
 *
 * Coverage discipline mirrors `tests/unit/api/source-aggregator.test.ts`:
 * every branch of every export, including the malformed-response path
 * + groupId-variant query shape + per-call operation-name threading.
 * Integration parity for the migration sites (upsert / clear bulk /
 * update bulk / list) lives in `tests/integration/commands/*` — those
 * cassettes ride byte-identical post-lift.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  fetchItemsPage,
  fetchNextItemsPage,
  type ItemsPageInputs,
  type NextItemsPageInputs,
} from '../../../src/api/items-page-walker.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

interface CapturedCall {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>> | undefined;
  readonly operationName: string | undefined;
}

interface FakeClient {
  readonly client: MondayClient;
  readonly calls: readonly CapturedCall[];
}

const buildResponse = <T>(data: T): MondayResponse<T> => ({
  data,
  complexity: null,
  stats: { attempts: 1, totalBackoffMs: 0 },
});

/**
 * Wraps a sequence of canned responses into a `MondayClient` whose
 * `raw` method returns each response in order. Captures every call's
 * `(query, variables, operationName)` so per-test assertions can pin
 * the GraphQL string + variable shape + operation name.
 */
const makeClient = (responses: readonly MondayResponse<unknown>[]): FakeClient => {
  const calls: CapturedCall[] = [];
  let i = 0;
  const raw = vi.fn(
    (
      query: string,
      variables: Readonly<Record<string, unknown>> | undefined,
      options?: { readonly operationName?: string },
    ): Promise<MondayResponse<unknown>> => {
      calls.push({ query, variables, operationName: options?.operationName });
      const next = responses[i];
      if (next === undefined) {
        return Promise.reject(
          new Error(
            `makeClient: ran out of canned responses at call #${String(i + 1)}`,
          ),
        );
      }
      i++;
      return Promise.resolve(next);
    },
  );
  // Cast through `unknown` because we only stub `raw` — the helper
  // never touches the other typed methods (`whoami`, `account`, …).
  const client = { raw } as unknown as MondayClient;
  return { client, calls };
};

const itemSchema = z.object({ id: z.string(), name: z.string() }).loose();
type Item = z.infer<typeof itemSchema>;

const item = (id: string): Item => ({ id, name: `Item ${id}` });

const baseInputs = (
  client: MondayClient,
  overrides: Partial<ItemsPageInputs<Item>> = {},
): ItemsPageInputs<Item> => ({
  client,
  operationName: 'ItemsPage',
  boardId: '111',
  limit: 50,
  queryParams: undefined,
  itemFields: 'id\n          name',
  itemSchema,
  ...overrides,
});

const nextInputs = (
  client: MondayClient,
  overrides: Partial<NextItemsPageInputs<Item>> = {},
): NextItemsPageInputs<Item> => ({
  client,
  operationName: 'NextItemsPage',
  cursor: 'CURSOR_X',
  limit: 50,
  itemFields: 'id\n          name',
  itemSchema,
  ...overrides,
});

describe('fetchItemsPage — top-level (no groupId)', () => {
  it('returns parsed items + cursor on the happy path', async () => {
    const { client, calls } = makeClient([
      buildResponse({
        boards: [{ items_page: { cursor: 'C2', items: [item('1'), item('2')] } }],
      }),
    ]);
    const result = await fetchItemsPage<Item>(baseInputs(client));
    expect(result.data.items).toEqual([item('1'), item('2')]);
    expect(result.data.cursor).toBe('C2');
    expect(calls).toHaveLength(1);
  });

  it('returns null cursor + empty items array when Monday signals exhaustion', async () => {
    const { client } = makeClient([
      buildResponse({ boards: [{ items_page: { cursor: null, items: [] } }] }),
    ]);
    const result = await fetchItemsPage<Item>(baseInputs(client));
    expect(result.data.cursor).toBeNull();
    expect(result.data.items).toEqual([]);
  });

  it('threads operationName + boardId + limit + queryParams to client.raw', async () => {
    const { client, calls } = makeClient([
      buildResponse({ boards: [{ items_page: { cursor: null, items: [] } }] }),
    ]);
    await fetchItemsPage<Item>(
      baseInputs(client, {
        operationName: 'ItemUpsertLookup',
        boardId: '999',
        limit: 11,
        queryParams: { rules: [{ column_id: 'name', compare_value: ['x'] }] },
      }),
    );
    const call = calls[0];
    expect(call?.operationName).toBe('ItemUpsertLookup');
    expect(call?.variables).toMatchObject({
      boardId: '999',
      limit: 11,
      queryParams: { rules: [{ column_id: 'name', compare_value: ['x'] }] },
    });
    // Per-call operation name is also reflected in the GraphQL string
    // (operationName is the SDK-level marker, but the query header
    // mirrors it for Monday's request logs).
    expect(call?.query).toContain('query ItemUpsertLookup(');
  });

  it('passes queryParams as null when caller leaves it undefined', async () => {
    const { client, calls } = makeClient([
      buildResponse({ boards: [{ items_page: { cursor: null, items: [] } }] }),
    ]);
    await fetchItemsPage<Item>(baseInputs(client, { queryParams: undefined }));
    expect(calls[0]?.variables?.queryParams).toBeNull();
  });

  it('inlines the itemFields fragment verbatim into the GraphQL query', async () => {
    const { client, calls } = makeClient([
      buildResponse({ boards: [{ items_page: { cursor: null, items: [] } }] }),
    ]);
    await fetchItemsPage<Item>(
      baseInputs(client, { itemFields: 'id' }),
    );
    expect(calls[0]?.query).toContain('items {\n          id\n        }');
    expect(calls[0]?.query).not.toContain('name');
  });

  it('surfaces internal_error with details.issues on a malformed response', async () => {
    const { client } = makeClient([buildResponse({ boards: [{}] })]);
    let captured: ApiError | undefined;
    try {
      await fetchItemsPage<Item>(baseInputs(client));
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured).toBeInstanceOf(ApiError);
    expect(captured?.code).toBe('internal_error');
    expect(captured?.message).toContain('malformed ItemsPage response');
    expect(captured?.message).toContain('board 111');
    const details = captured?.details as Record<string, unknown> | undefined;
    expect(details?.board_id).toBe('111');
    expect(Array.isArray(details?.issues)).toBe(true);
  });

  it("rejects an empty boards array via the schema's `.min(1)` rule", async () => {
    const { client } = makeClient([buildResponse({ boards: [] })]);
    let captured: ApiError | undefined;
    try {
      await fetchItemsPage<Item>(baseInputs(client));
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured?.code).toBe('internal_error');
    // Empty boards trips the schema before the defensive guard fires —
    // failure surfaces as a parse-boundary `internal_error` carrying
    // the `boards` issue path on `details.issues`.
    const details = captured?.details as
      | { readonly issues?: readonly { readonly path: string }[] }
      | undefined;
    expect(details?.issues).toBeDefined();
  });
});

describe('fetchItemsPage — group-filter variant', () => {
  it("emits the boards.groups.items_page query when groupId is set", async () => {
    const { client, calls } = makeClient([
      buildResponse({
        boards: [
          {
            groups: [
              { items_page: { cursor: 'GC2', items: [item('100')] } },
            ],
          },
        ],
      }),
    ]);
    const result = await fetchItemsPage<Item>(
      baseInputs(client, {
        operationName: 'ItemsPageByGroup',
        groupId: 'topics',
      }),
    );
    expect(result.data.items).toEqual([item('100')]);
    expect(result.data.cursor).toBe('GC2');
    const call = calls[0];
    expect(call?.operationName).toBe('ItemsPageByGroup');
    expect(call?.variables).toMatchObject({
      boardId: '111',
      groupId: 'topics',
      limit: 50,
    });
    // Query includes both the `groups(ids: [$groupId])` selection and
    // the `$groupId: String!` variable declaration.
    expect(call?.query).toContain('groups(ids: [$groupId])');
    expect(call?.query).toContain('$groupId: String!');
  });

  it('surfaces internal_error on a malformed grouped response', async () => {
    const { client } = makeClient([
      buildResponse({ boards: [{ groups: [] }] }),
    ]);
    let captured: ApiError | undefined;
    try {
      await fetchItemsPage<Item>(
        baseInputs(client, {
          operationName: 'ItemsPageByGroup',
          groupId: 'topics',
        }),
      );
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured?.code).toBe('internal_error');
    expect(captured?.message).toContain('malformed ItemsPageByGroup response');
  });

  it("does not include $groupId in variables when groupId is undefined", async () => {
    const { client, calls } = makeClient([
      buildResponse({ boards: [{ items_page: { cursor: null, items: [] } }] }),
    ]);
    await fetchItemsPage<Item>(baseInputs(client));
    expect(calls[0]?.query).not.toContain('$groupId');
    expect((calls[0]?.variables as Record<string, unknown>).groupId).toBeUndefined();
  });
});

describe('fetchNextItemsPage', () => {
  it('returns parsed continuation page on the happy path', async () => {
    const { client, calls } = makeClient([
      buildResponse({
        next_items_page: { cursor: null, items: [item('5')] },
      }),
    ]);
    const result = await fetchNextItemsPage<Item>(nextInputs(client));
    expect(result.data.items).toEqual([item('5')]);
    expect(result.data.cursor).toBeNull();
    const call = calls[0];
    expect(call?.operationName).toBe('NextItemsPage');
    expect(call?.variables).toEqual({ cursor: 'CURSOR_X', limit: 50 });
    expect(call?.query).toContain('next_items_page(limit: $limit, cursor: $cursor)');
  });

  it('surfaces internal_error on a malformed response carrying the cursor on details', async () => {
    const { client } = makeClient([buildResponse({})]);
    let captured: ApiError | undefined;
    try {
      await fetchNextItemsPage<Item>(nextInputs(client));
    } catch (err) {
      captured = err as ApiError;
    }
    expect(captured?.code).toBe('internal_error');
    expect(captured?.message).toContain('malformed NextItemsPage response');
    const details = captured?.details as Record<string, unknown> | undefined;
    expect(details?.cursor).toBe('CURSOR_X');
  });

  it('honours a custom operationName for telemetry attribution', async () => {
    const { client, calls } = makeClient([
      buildResponse({
        next_items_page: { cursor: null, items: [] },
      }),
    ]);
    await fetchNextItemsPage<Item>(
      nextInputs(client, { operationName: 'BulkClearNextPage' }),
    );
    expect(calls[0]?.operationName).toBe('BulkClearNextPage');
    expect(calls[0]?.query).toContain('query BulkClearNextPage(');
  });
});

describe('paginate composition', () => {
  // The bulk migration sites (clear --where / update --where / list)
  // thread the helper through `paginate.ts`'s fetchInitial /
  // fetchNext closures. The integration cassettes pin end-to-end
  // behaviour; this unit test pins the wiring expectation that both
  // helpers return the same `MondayResponse<{items, cursor}>` shape
  // so `extractPage: (r) => r.data` works uniformly across both
  // legs.
  it('returns a uniform extractPage-compatible shape across initial + next legs', async () => {
    const { client } = makeClient([
      buildResponse({
        boards: [{ items_page: { cursor: 'C2', items: [item('1')] } }],
      }),
      buildResponse({
        next_items_page: { cursor: null, items: [item('2')] },
      }),
    ]);
    const initial = await fetchItemsPage<Item>(baseInputs(client));
    expect(initial.data).toEqual({ cursor: 'C2', items: [item('1')] });
    const next = await fetchNextItemsPage<Item>(
      nextInputs(client, { cursor: 'C2' }),
    );
    expect(next.data).toEqual({ cursor: null, items: [item('2')] });
    // Both shapes line up: `r.data.items` + `r.data.cursor` works on
    // either leg without a discriminator branch.
    const lift = (
      r:
        | MondayResponse<{ readonly items: readonly Item[]; readonly cursor: string | null }>
        | typeof initial,
    ): { readonly items: readonly Item[]; readonly cursor: string | null } => r.data;
    expect(lift(initial).cursor).toBe('C2');
    expect(lift(next).cursor).toBeNull();
  });
});
