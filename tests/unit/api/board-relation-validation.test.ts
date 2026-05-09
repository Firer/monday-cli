/**
 * Unit tests for the v0.3-M19 Commit 3 `board-relation-validation`
 * module. Two surfaces:
 *
 *   - `parseRelationItemIds` — pre-network input validator. Five
 *     `usage_error` rejection branches + happy path.
 *   - `validateBoardRelationItems` — single-batch live validator
 *     against `items(ids: ...)` for allowed-board membership.
 *
 * Mocks `MondayClient.raw` so the validator runs without a live
 * transport — the network boundary is the mock seam (per
 * `.claude/rules/testing.md`).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BOARD_RELATION_MAX_ITEMS,
  parseRelationItemIds,
  validateBoardRelationItems,
  type BoardRelationValidationResult,
  type RelationContext,
} from '../../../src/api/board-relation-validation.js';
import type { MondayClient, MondayResponse } from '../../../src/api/client.js';
import { ApiError, UsageError } from '../../../src/utils/errors.js';

interface ItemsResponse {
  readonly items:
    | readonly {
        readonly id: string;
        readonly board: { readonly id: string } | null;
      }[]
    | null;
}

const buildClient = (
  responder: (
    query: string,
    variables: Readonly<Record<string, unknown>> | undefined,
  ) => MondayResponse<ItemsResponse>,
): MondayClient =>
  ({
    raw: vi.fn(
      (
        query: string,
        variables: Readonly<Record<string, unknown>> | undefined,
        _options?: unknown,
      ): Promise<MondayResponse<ItemsResponse>> =>
        Promise.resolve(responder(query, variables)),
    ),
  } as unknown as MondayClient);

const okResponse = (
  items: readonly { id: string; board: { id: string } | null }[],
): MondayResponse<ItemsResponse> => ({
  data: { items },
  complexity: null,
  stats: { calls: 1 },
});

describe('parseRelationItemIds — happy path', () => {
  it('comma-split decimal item IDs return parallel-order numeric array', () => {
    const out = parseRelationItemIds('12345,67890', 'rel_1', 'board_relation');
    expect(out).toEqual([12345, 67890]);
  });

  it('whitespace tolerant — surrounding spaces are stripped per token', () => {
    const out = parseRelationItemIds(
      '  12345 , 67890  ',
      'rel_1',
      'board_relation',
    );
    expect(out).toEqual([12345, 67890]);
  });

  it('single-item input → single-element array', () => {
    expect(parseRelationItemIds('42', 'rel_1', 'board_relation')).toEqual([42]);
  });

  it('zero is a valid item ID (Monday IDs are non-negative integers)', () => {
    expect(parseRelationItemIds('0,1,2', 'rel_1', 'board_relation')).toEqual([
      0, 1, 2,
    ]);
  });

  it('exactly 25 items → no over-cap rejection', () => {
    const ids = Array.from({ length: 25 }, (_, i) => (i + 1).toString());
    const out = parseRelationItemIds(ids.join(','), 'rel_1', 'board_relation');
    expect(out).toHaveLength(25);
  });
});

describe('parseRelationItemIds — empty input rejection', () => {
  it('empty string → usage_error pointing at monday item clear', () => {
    expect(() => parseRelationItemIds('', 'rel_1', 'board_relation')).toThrow(
      UsageError,
    );
    try {
      parseRelationItemIds('', 'rel_1', 'board_relation');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/monday item clear/u);
      expect(err.details).toMatchObject({
        column_id: 'rel_1',
        column_type: 'board_relation',
        raw_input: '',
      });
    }
  });

  it('whitespace-only-with-commas → usage_error (filter eliminates everything)', () => {
    expect(() =>
      parseRelationItemIds('  ,  ,  ', 'rel_1', 'board_relation'),
    ).toThrow(/monday item clear/u);
  });

  it('dependency context carries dependency-tinted message', () => {
    try {
      parseRelationItemIds('', 'dep_1', 'dependency');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/Dependency column/u);
      expect(err.details).toMatchObject({ column_type: 'dependency' });
    }
  });
});

describe('parseRelationItemIds — over-cap rejection', () => {
  it('26 items → usage_error pre-network', () => {
    const ids = Array.from({ length: 26 }, (_, i) => (i + 1).toString());
    expect(() =>
      parseRelationItemIds(ids.join(','), 'rel_1', 'board_relation'),
    ).toThrow(UsageError);
    try {
      parseRelationItemIds(ids.join(','), 'rel_1', 'board_relation');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.message).toMatch(/per-call cap of 25/u);
      expect(err.details).toMatchObject({
        item_count: 26,
        max_items: BOARD_RELATION_MAX_ITEMS,
      });
    }
  });
});

describe('parseRelationItemIds — non-decimal token rejection', () => {
  it.each([
    ['hex', '0x2a'],
    ['scientific', '1e3'],
    ['signed-negative', '-1'],
    ['decimal', '1.5'],
    ['letters', 'abc'],
    ['hyphen-leading-zero', '01'],
  ])('%s token %s → usage_error', (_label, token) => {
    expect(() =>
      parseRelationItemIds(token, 'rel_1', 'board_relation'),
    ).toThrow(/non-numeric token/u);
  });

  it('rejection details carry the failing token + column context', () => {
    try {
      parseRelationItemIds('12345,abc,67890', 'rel_1', 'board_relation');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details).toMatchObject({
        column_id: 'rel_1',
        column_type: 'board_relation',
        raw_input: '12345,abc,67890',
        token: 'abc',
      });
    }
  });
});

describe('parseRelationItemIds — unsafe-integer rejection', () => {
  it('beyond 2^53-1 → usage_error noting the friendly translator cannot safely round-trip the ID', () => {
    // 2^53 = 9007199254740992 — Number() rounds down to 2^53 here.
    // Codex post-Commit-5 P2-2 fix: the hint no longer suggests
    // --set-raw because that path also goes through JSON.parse,
    // which suffers the same precision corruption for IDs beyond
    // the safe-integer range.
    expect(() =>
      parseRelationItemIds(
        '9007199254740993',
        'rel_1',
        'board_relation',
      ),
    ).toThrow(/safe-integer range/u);
    try {
      parseRelationItemIds('9007199254740993', 'rel_1', 'board_relation');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details?.hint).toMatch(/safe-integer range/u);
      // Negative regression: the hint must not steer the agent at
      // an unsafe escape hatch.
      expect(err.details?.hint).not.toMatch(/use --set-raw/iu);
    }
  });

  it('exactly 2^53 - 1 (MAX_SAFE_INTEGER) → accepted', () => {
    const max = Number.MAX_SAFE_INTEGER.toString();
    expect(parseRelationItemIds(max, 'rel_1', 'board_relation')).toEqual([
      Number.MAX_SAFE_INTEGER,
    ]);
  });
});

describe('parseRelationItemIds — duplicate rejection', () => {
  it('duplicate item ID → usage_error mentioning silent collapse', () => {
    expect(() =>
      parseRelationItemIds('12345,12345', 'rel_1', 'board_relation'),
    ).toThrow(/duplicate item ID/u);
    try {
      parseRelationItemIds('12345,67890,12345', 'rel_1', 'board_relation');
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      expect(err.details).toMatchObject({
        token: '12345',
      });
    }
  });
});

describe('validateBoardRelationItems — happy path', () => {
  it('all items in allowed boards → ok with parallel items echo', async () => {
    const client = buildClient(() =>
      okResponse([
        { id: '12345', board: { id: '111' } },
        { id: '67890', board: { id: '222' } },
      ]),
    );
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345, 67890],
      allowedBoards: [111, 222],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.items).toEqual([
      { itemId: 12345, boardId: 111 },
      { itemId: 67890, boardId: 222 },
    ]);
  });

  it('input order preserved across response shuffling', async () => {
    // Monday returns items in unspecified order; the validator's
    // per-item echo must follow the agent's input order so dry-run
    // diffs don't flap.
    const client = buildClient(() =>
      okResponse([
        { id: '67890', board: { id: '222' } },
        { id: '12345', board: { id: '111' } },
      ]),
    );
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345, 67890],
      allowedBoards: [111, 222],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.items).toEqual([
      { itemId: 12345, boardId: 111 },
      { itemId: 67890, boardId: 222 },
    ]);
  });

  it('passes the input itemIds as decimal strings to the GraphQL query', async () => {
    const seenVariables: Readonly<Record<string, unknown>>[] = [];
    const client = buildClient((_q, vars) => {
      if (vars !== undefined) seenVariables.push(vars);
      return okResponse([{ id: '42', board: { id: '111' } }]);
    });
    await validateBoardRelationItems({
      client,
      itemIds: [42],
      allowedBoards: [111],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    expect(seenVariables[0]).toEqual({ ids: ['42'] });
  });
});

describe('validateBoardRelationItems — mismatch surface', () => {
  it('item belongs to disallowed board → mismatch with actualBoard', async () => {
    const client = buildClient(() =>
      okResponse([{ id: '12345', board: { id: '999' } }]),
    );
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345],
      allowedBoards: [111, 222],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected mismatch');
    expect(result.mismatches).toEqual([{ itemId: 12345, actualBoard: 999 }]);
  });

  it('item missing from response (deleted / not visible) → mismatch with actualBoard: null', async () => {
    const client = buildClient(() => okResponse([]));
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345, 67890],
      allowedBoards: [111],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    if (result.ok) throw new Error('expected mismatch');
    expect(result.mismatches).toEqual([
      { itemId: 12345, actualBoard: null },
      { itemId: 67890, actualBoard: null },
    ]);
  });

  it('item with board: null (no read access) → mismatch with actualBoard: null', async () => {
    const client = buildClient(() =>
      okResponse([{ id: '12345', board: null }]),
    );
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345],
      allowedBoards: [111],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    if (result.ok) throw new Error('expected mismatch');
    expect(result.mismatches).toEqual([{ itemId: 12345, actualBoard: null }]);
  });

  it('partial mismatch: some items pass, some fail → result is { ok: false } with only failed ones', async () => {
    const client = buildClient(() =>
      okResponse([
        { id: '12345', board: { id: '111' } }, // OK
        { id: '67890', board: { id: '999' } }, // mismatch
      ]),
    );
    const result = await validateBoardRelationItems({
      client,
      itemIds: [12345, 67890],
      allowedBoards: [111],
      columnId: 'rel_1',
      context: 'board_relation',
    });
    if (result.ok) throw new Error('expected mismatch');
    expect(result.mismatches).toEqual([{ itemId: 67890, actualBoard: 999 }]);
  });
});

describe('validateBoardRelationItems — context discriminant', () => {
  it.each(['board_relation', 'dependency'] as const)(
    'context %s threads through; same wire shape',
    async (context: RelationContext) => {
      const client = buildClient(() =>
        okResponse([{ id: '42', board: { id: '111' } }]),
      );
      const result = await validateBoardRelationItems({
        client,
        itemIds: [42],
        allowedBoards: [111],
        columnId: 'col_x',
        context,
      });
      expect(result.ok).toBe(true);
    },
  );
});

describe('validateBoardRelationItems — malformed response', () => {
  it('Monday returns malformed items shape → internal_error ApiError with issues', async () => {
    const client = {
      raw: vi.fn(() =>
        Promise.resolve({
          data: { items: [{ id: 'not-a-number', board: null }] },
          complexity: null,
          stats: { calls: 1 },
        }),
      ),
    } as unknown as MondayClient;
    await expect(
      validateBoardRelationItems({
        client,
        itemIds: [42],
        allowedBoards: [111],
        columnId: 'rel_1',
        context: 'board_relation',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    try {
      await validateBoardRelationItems({
        client,
        itemIds: [42],
        allowedBoards: [111],
        columnId: 'rel_1',
        context: 'board_relation',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.details?.column_id).toBe('rel_1');
      expect(err.details?.issues).toBeDefined();
    }
  });
});

describe('validateBoardRelationItems — surface contract', () => {
  it('exposes Monday\'s documented per-call cap (25 items)', () => {
    expect(BOARD_RELATION_MAX_ITEMS).toBe(25);
  });

  it('result type is a discriminated union — ok: true | ok: false', () => {
    const ok: BoardRelationValidationResult = {
      ok: true,
      items: [{ itemId: 1, boardId: 10 }],
    };
    expect(ok.ok).toBe(true);

    const fail: BoardRelationValidationResult = {
      ok: false,
      mismatches: [{ itemId: 7, actualBoard: 99 }],
    };
    expect(fail.ok).toBe(false);
  });
});
