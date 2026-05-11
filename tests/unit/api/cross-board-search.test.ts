/**
 * Surface tests for `src/api/cross-board-search.ts` — the v0.3-M23
 * runtime body for the cross-board fan-out walker (cli-design §13
 * v0.3 entry; Decision 5 closure `3a2f1db`).
 *
 * Scope: constants + schemas + pure helpers (`validateMaxBoards`,
 * `buildInaccessibleBoardsWarning`,
 * `buildColumnNotFoundOnBoardWarning`,
 * `buildCrossBoardTruncatedWarning`) + the runtime `crossBoardSearch`
 * walker driven via a seam-injected `MondayClient` stub (mock-at-
 * the-network-boundary per testing.md).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_MAX_BOARDS,
  HARD_CAP_MAX_BOARDS,
  buildColumnNotFoundOnBoardWarning,
  buildCrossBoardTruncatedWarning,
  buildInaccessibleBoardsWarning,
  columnNotFoundOnBoardWarningSchema,
  crossBoardItemSchema,
  crossBoardSearch,
  crossBoardSearchOutputSchema,
  crossBoardTruncatedWarningSchema,
  inaccessibleBoardsWarningSchema,
  maxBoardsSchema,
  validateMaxBoards,
} from '../../../src/api/cross-board-search.js';
import { ApiError } from '../../../src/utils/errors.js';
import type {
  MondayClient,
  MondayResponse,
} from '../../../src/api/client.js';
import type { BoardId } from '../../../src/types/ids.js';
import { BoardIdSchema } from '../../../src/types/ids.js';

describe('Decision 5 constants', () => {
  it('pins --max-boards default at 25 per `3a2f1db`', () => {
    expect(DEFAULT_MAX_BOARDS).toBe(25);
  });

  it('pins --max-boards hard cap at 100 per `3a2f1db`', () => {
    expect(HARD_CAP_MAX_BOARDS).toBe(100);
  });

  it('default is strictly less than hard cap', () => {
    expect(DEFAULT_MAX_BOARDS).toBeLessThan(HARD_CAP_MAX_BOARDS);
  });
});

describe('maxBoardsSchema', () => {
  it('accepts the default', () => {
    expect(maxBoardsSchema.parse(DEFAULT_MAX_BOARDS)).toBe(DEFAULT_MAX_BOARDS);
  });

  it('accepts the hard cap', () => {
    expect(maxBoardsSchema.parse(HARD_CAP_MAX_BOARDS)).toBe(HARD_CAP_MAX_BOARDS);
  });

  it('coerces string input (commander pre-validation shape)', () => {
    expect(maxBoardsSchema.parse('25')).toBe(25);
  });

  it('rejects above hard cap with a hint-bearing message', () => {
    const result = maxBoardsSchema.safeParse(HARD_CAP_MAX_BOARDS + 1);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/hard cap/i);
      expect(result.error.issues[0]?.message).toMatch(/--workspace|--favorites/);
    }
  });

  it('rejects zero', () => {
    expect(maxBoardsSchema.safeParse(0).success).toBe(false);
  });

  it('rejects negative', () => {
    expect(maxBoardsSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects non-integer', () => {
    expect(maxBoardsSchema.safeParse(2.5).success).toBe(false);
  });
});

describe('validateMaxBoards', () => {
  it('returns the default when input is undefined', () => {
    expect(validateMaxBoards(undefined)).toBe(DEFAULT_MAX_BOARDS);
  });

  it('returns the user-supplied value when within range', () => {
    expect(validateMaxBoards(50)).toBe(50);
  });

  it('accepts the boundary cap', () => {
    expect(validateMaxBoards(HARD_CAP_MAX_BOARDS)).toBe(HARD_CAP_MAX_BOARDS);
  });
});

describe('buildInaccessibleBoardsWarning', () => {
  it('reports the missing IDs in input order', () => {
    const w = buildInaccessibleBoardsWarning(
      ['1', '2', '3', '4'],
      ['1', '3'],
    );
    expect(w.code).toBe('inaccessible_boards');
    expect(w.details.missing_board_ids).toEqual(['2', '4']);
    expect(w.details.requested_count).toBe(4);
    expect(w.details.returned_count).toBe(2);
  });

  it('produces an empty missing list when every board returned', () => {
    const w = buildInaccessibleBoardsWarning(['1', '2'], ['1', '2']);
    expect(w.details.missing_board_ids).toEqual([]);
    expect(w.details.requested_count).toBe(2);
    expect(w.details.returned_count).toBe(2);
  });

  it('parses against the schema', () => {
    const w = buildInaccessibleBoardsWarning(['1', '2'], ['1']);
    expect(() => inaccessibleBoardsWarningSchema.parse(w)).not.toThrow();
  });

  it('hint mentions the silent-omit semantics', () => {
    const w = buildInaccessibleBoardsWarning(['1', '2'], ['1']);
    expect(w.details.hint).toMatch(/silently omitted|boards\(ids/);
  });
});

describe('buildCrossBoardTruncatedWarning (Codex P1-2 single-call surface)', () => {
  it('reports limit_hit when --limit short-circuited the walk', () => {
    const w = buildCrossBoardTruncatedWarning(
      'limit_hit',
      500,
      500,
      { '1': 'exhausted', '2': 'has_more', '3': 'not_started' },
    );
    expect(w.code).toBe('cross_board_truncated');
    expect(w.details.reason).toBe('limit_hit');
    expect(w.details.total_returned).toBe(500);
    expect(w.details.limit).toBe(500);
    expect(w.details.per_board_state).toEqual({
      '1': 'exhausted',
      '2': 'has_more',
      '3': 'not_started',
    });
  });

  it('reports board_has_more when boards exceed the v0.3 single-call surface', () => {
    const w = buildCrossBoardTruncatedWarning(
      'board_has_more',
      1_200,
      null,
      { '1': 'has_more', '2': 'has_more' },
    );
    expect(w.details.reason).toBe('board_has_more');
    expect(w.details.limit).toBe(null);
  });

  it("limit_hit hint references --limit + narrowing levers + the v0.1 single-board path", () => {
    const w = buildCrossBoardTruncatedWarning(
      'limit_hit',
      25,
      25,
      {},
    );
    expect(w.details.hint).toMatch(/--limit/);
    expect(w.details.hint).toMatch(/--workspace|--favorites/);
    expect(w.details.hint).toMatch(/--board/);
  });

  it("board_has_more hint points at v0.4-deferred resumable cursor + narrowing", () => {
    const w = buildCrossBoardTruncatedWarning(
      'board_has_more',
      1_000,
      null,
      {},
    );
    expect(w.details.hint).toMatch(/v0\.3 cross-board single-call|narrow|--board/);
  });

  it('parses against the schema', () => {
    const w = buildCrossBoardTruncatedWarning(
      'limit_hit',
      10,
      10,
      { '1': 'exhausted', '2': 'has_more' },
    );
    expect(() => crossBoardTruncatedWarningSchema.parse(w)).not.toThrow();
  });

  it('schema rejects unknown per-board state values', () => {
    expect(() =>
      crossBoardTruncatedWarningSchema.parse({
        code: 'cross_board_truncated',
        message: 'x',
        details: {
          reason: 'limit_hit',
          total_returned: 0,
          limit: 10,
          per_board_state: { '1': 'unknown' },
          hint: 'h',
        },
      }),
    ).toThrow();
  });
});

describe('buildColumnNotFoundOnBoardWarning', () => {
  it('reports the board + column token + a hint', () => {
    const w = buildColumnNotFoundOnBoardWarning('123', 'status');
    expect(w.code).toBe('column_not_found_on_board');
    expect(w.details.board_id).toBe('123');
    expect(w.details.column).toBe('status');
    expect(w.details.hint).toMatch(/skipped|cross-board/i);
  });

  it('parses against the schema', () => {
    const w = buildColumnNotFoundOnBoardWarning('123', 'status');
    expect(() => columnNotFoundOnBoardWarningSchema.parse(w)).not.toThrow();
  });

  it('rejects extra keys via .strict()', () => {
    expect(() =>
      columnNotFoundOnBoardWarningSchema.parse({
        code: 'column_not_found_on_board',
        message: 'x',
        details: { board_id: '1', column: 'a', hint: 'h', extra: 'rejected' },
      }),
    ).toThrow();
  });
});

describe('crossBoardItemSchema', () => {
  it('accepts a minimal valid item', () => {
    expect(() =>
      crossBoardItemSchema.parse({
        id: '1',
        name: 'Task',
        state: 'active',
        board: { id: '10', name: 'Tasks' },
        column_values: { status: 'Done' },
      }),
    ).not.toThrow();
  });

  it('allows null column values', () => {
    expect(() =>
      crossBoardItemSchema.parse({
        id: '1',
        name: 'Task',
        state: null,
        board: { id: '10', name: 'Tasks' },
        column_values: { status: null },
      }),
    ).not.toThrow();
  });

  it('rejects empty id', () => {
    expect(() =>
      crossBoardItemSchema.parse({
        id: '',
        name: 'Task',
        state: 'active',
        board: { id: '10', name: 'Tasks' },
        column_values: {},
      }),
    ).toThrow();
  });

  it('rejects when board.name is missing', () => {
    expect(() =>
      crossBoardItemSchema.parse({
        id: '1',
        name: 'Task',
        state: 'active',
        board: { id: '10' },
        column_values: {},
      }),
    ).toThrow();
  });
});

describe('crossBoardSearchOutputSchema', () => {
  it('is an array of crossBoardItemSchema', () => {
    expect(() =>
      crossBoardSearchOutputSchema.parse([
        {
          id: '1',
          name: 'A',
          state: 'active',
          board: { id: '10', name: 'Board A' },
          column_values: { status: 'Working on it' },
        },
        {
          id: '2',
          name: 'B',
          state: null,
          board: { id: '11', name: 'Board B' },
          column_values: { status: 'Done' },
        },
      ]),
    ).not.toThrow();
  });

  it('accepts an empty array (no items matched)', () => {
    expect(crossBoardSearchOutputSchema.parse([])).toEqual([]);
  });
});

/**
 * Per-call wire-response shape the fixture stubs emit. Mirrors the
 * GraphQL document the walker issues (one call per board in the
 * fan-out — see `CROSS_BOARD_SEARCH_QUERY` in cross-board-search.ts).
 */
interface FakeWireBoard {
  readonly id: string;
  readonly name: string;
  readonly items_page: {
    readonly cursor: string | null;
    readonly items: readonly {
      readonly id: string;
      readonly name: string;
      readonly state: string | null;
      readonly column_values: readonly {
        readonly id: string;
        readonly text: string | null;
      }[];
    }[];
  };
}

interface WirePlanResponse {
  readonly boardId: string;
  readonly board: FakeWireBoard | null;
}

const bid = (n: string): BoardId => BoardIdSchema.parse(n);

/**
 * Seam-injected MondayClient stub for walker tests. Each call
 * matches by the `boardId` variable; null `board` simulates Monday's
 * silent-omit shape for an inaccessible board.
 */
const buildWalkerClientStub = (
  responses: readonly WirePlanResponse[],
): { client: MondayClient; raw: ReturnType<typeof vi.fn> } => {
  const byBoardId = new Map(
    responses.map((r) => [r.boardId, r.board]),
  );
  const raw = vi.fn(
    (
      _query: string,
      variables: Readonly<Record<string, unknown>> | undefined,
      _options: { operationName?: string } = {},
    ): Promise<MondayResponse<unknown>> => {
      const boardId = (variables as { boardId?: string } | undefined)?.boardId;
      if (boardId === undefined) {
        return Promise.reject(
          new Error('buildWalkerClientStub: missing boardId in variables'),
        );
      }
      if (!byBoardId.has(boardId)) {
        return Promise.reject(
          new Error(`buildWalkerClientStub: no canned response for ${boardId}`),
        );
      }
      const board = byBoardId.get(boardId) ?? null;
      return Promise.resolve({
        data: { boards: board === null ? [] : [board] },
        complexity: null,
        stats: { attempts: 1, sleeps: [] },
      });
    },
  );
  const client = { raw } as unknown as MondayClient;
  return { client, raw };
};

describe('crossBoardSearch — happy path (single board, exhausted)', () => {
  it('issues one call per plan and emits items keyed by the wire column_id', async () => {
    const { client, raw } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'Tasks',
          items_page: {
            cursor: null,
            items: [
              {
                id: 'i1',
                name: 'Task 1',
                state: 'active',
                column_values: [
                  { id: 'status', text: 'Done' },
                  { id: 'name', text: 'Task 1' },
                ],
              },
            ],
          },
        },
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100')],
      plans: [
        {
          board_id: bid('100'),
          rules: [{ column_id: 'status', compare_values: ['Done'] }],
        },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual({
      id: 'i1',
      name: 'Task 1',
      state: 'active',
      board: { id: '100', name: 'Tasks' },
      column_values: { status: 'Done', name: 'Task 1' },
    });
    expect(result.hasMore).toBe(false);
    expect(result.totalReturned).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.source).toBe('live');
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('emits an empty items[] and no warnings when no plan boards match', async () => {
    // Walker emits the empty result even when the wire returns
    // boards that match the plan but have no items_page hits.
    const { client } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'Tasks',
          items_page: { cursor: null, items: [] },
        },
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100')],
      plans: [
        {
          board_id: bid('100'),
          rules: [{ column_id: 'status', compare_values: ['Done'] }],
        },
      ],
    });
    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});

describe('crossBoardSearch — inaccessible boards', () => {
  it('surfaces inaccessible_boards when the wire returns an empty boards array', async () => {
    const { client } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'Tasks',
          items_page: { cursor: null, items: [] },
        },
      },
      {
        boardId: '999',
        board: null, // Inaccessible — Monday returns boards: []
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100'), bid('999')],
      plans: [
        {
          board_id: bid('100'),
          rules: [{ column_id: 'status', compare_values: ['Done'] }],
        },
        {
          board_id: bid('999'),
          rules: [{ column_id: 'status', compare_values: ['Done'] }],
        },
      ],
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('inaccessible_boards');
    if (result.warnings[0]?.code === 'inaccessible_boards') {
      expect(result.warnings[0].details.missing_board_ids).toEqual(['999']);
      expect(result.warnings[0].details.requested_count).toBe(2);
      expect(result.warnings[0].details.returned_count).toBe(1);
    }
  });
});

describe('crossBoardSearch — cross_board_truncated warning', () => {
  it('surfaces limit_hit when --limit short-circuits mid-walk', async () => {
    const { client, raw } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'A',
          // Non-null cursor + more items beyond the limit → walker
          // collects items up to the aggregate `--limit`, the inner
          // loop bails with limitHit=true, board flagged has_more.
          items_page: {
            cursor: 'cursor-100',
            items: [
              { id: 'a1', name: 'a1', state: null, column_values: [] },
              { id: 'a2', name: 'a2', state: null, column_values: [] },
              { id: 'a3', name: 'a3', state: null, column_values: [] },
            ],
          },
        },
      },
      {
        boardId: '200',
        board: {
          id: '200',
          name: 'B',
          items_page: {
            cursor: null,
            items: [
              { id: 'b1', name: 'b1', state: null, column_values: [] },
            ],
          },
        },
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100'), bid('200')],
      plans: [
        { board_id: bid('100'), rules: [] },
        { board_id: bid('200'), rules: [] },
      ],
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('cross_board_truncated');
    if (result.warnings[0]?.code === 'cross_board_truncated') {
      expect(result.warnings[0].details.reason).toBe('limit_hit');
      expect(result.warnings[0].details.total_returned).toBe(2);
      expect(result.warnings[0].details.limit).toBe(2);
      expect(result.warnings[0].details.per_board_state['100']).toBe(
        'has_more',
      );
      expect(result.warnings[0].details.per_board_state['200']).toBe(
        'not_started',
      );
    }
    // The second board's call should NOT have been issued — --limit
    // short-circuits the fan-out.
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('limit_hit fires at the outer-loop check when board exhausts at exactly --limit', async () => {
    // Board 100 has 2 items, --limit=2, cursor=null (exhausted at
    // the limit). Inner loop drains naturally without firing inner
    // limit check; per_board_state[100] = exhausted. Outer loop
    // then sees items.length === maxItems and fires limit_hit
    // before reaching board 200. Covers the
    // outer-loop-limit-check branch (cross-board-search.ts:725-728).
    const { client, raw } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'A',
          items_page: {
            cursor: null,
            items: [
              { id: 'a1', name: 'a1', state: null, column_values: [] },
              { id: 'a2', name: 'a2', state: null, column_values: [] },
            ],
          },
        },
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100'), bid('200')],
      plans: [
        { board_id: bid('100'), rules: [] },
        { board_id: bid('200'), rules: [] },
      ],
      maxItems: 2,
    });
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    expect(result.warnings[0]?.code).toBe('cross_board_truncated');
    if (result.warnings[0]?.code === 'cross_board_truncated') {
      expect(result.warnings[0].details.reason).toBe('limit_hit');
      expect(result.warnings[0].details.per_board_state['100']).toBe(
        'exhausted',
      );
      expect(result.warnings[0].details.per_board_state['200']).toBe(
        'not_started',
      );
    }
    // Only one wire call — the outer loop short-circuited before
    // reaching board 200.
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('surfaces board_has_more when a board has cursor != null', async () => {
    const { client } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'A',
          items_page: {
            cursor: 'cursor-x',
            items: [
              { id: 'a1', name: 'a1', state: null, column_values: [] },
            ],
          },
        },
      },
    ]);
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100')],
      plans: [{ board_id: bid('100'), rules: [] }],
    });
    expect(result.hasMore).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('cross_board_truncated');
    if (result.warnings[0]?.code === 'cross_board_truncated') {
      expect(result.warnings[0].details.reason).toBe('board_has_more');
      expect(result.warnings[0].details.per_board_state['100']).toBe(
        'has_more',
      );
    }
  });
});

describe('crossBoardSearch — streaming hook', () => {
  it('calls onItem per item-arrival in walker order', async () => {
    const { client } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'A',
          items_page: {
            cursor: null,
            items: [
              { id: 'a1', name: 'a1', state: null, column_values: [] },
              { id: 'a2', name: 'a2', state: null, column_values: [] },
            ],
          },
        },
      },
    ]);
    const seen: string[] = [];
    const result = await crossBoardSearch({
      client,
      boardIds: [bid('100')],
      plans: [{ board_id: bid('100'), rules: [] }],
      onItem: (item) => {
        seen.push(item.id);
      },
    });
    expect(seen).toEqual(['a1', 'a2']);
    expect(result.items.map((i) => i.id)).toEqual(['a1', 'a2']);
  });

  it('awaits the async onItem hook before emitting the next item', async () => {
    const { client } = buildWalkerClientStub([
      {
        boardId: '100',
        board: {
          id: '100',
          name: 'A',
          items_page: {
            cursor: null,
            items: [
              { id: 'a1', name: 'a1', state: null, column_values: [] },
              { id: 'a2', name: 'a2', state: null, column_values: [] },
            ],
          },
        },
      },
    ]);
    const seen: string[] = [];
    await crossBoardSearch({
      client,
      boardIds: [bid('100')],
      plans: [{ board_id: bid('100'), rules: [] }],
      onItem: async (item) => {
        await new Promise<void>((r) => setTimeout(r, 1));
        seen.push(item.id);
      },
    });
    expect(seen).toEqual(['a1', 'a2']);
  });
});

describe('crossBoardSearch — parse-failure surface', () => {
  it('surfaces internal_error with details.issues on shape drift', async () => {
    const raw = vi.fn(
      (): Promise<MondayResponse<unknown>> =>
        Promise.resolve({
          data: { boards: [{ id: 100 }] },
          complexity: null,
          stats: { attempts: 1, sleeps: [] },
        }),
    );
    const client = { raw } as unknown as MondayClient;
    try {
      await crossBoardSearch({
        client,
        boardIds: [bid('100')],
        plans: [{ board_id: bid('100'), rules: [] }],
      });
      throw new Error('expected reject');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('internal_error');
      expect(apiErr.message).toMatch(/cross-board search/);
      const details = apiErr.details as {
        board_id: string;
        issues: readonly { path: string; message: string }[];
      };
      expect(details.board_id).toBe('100');
      expect(details.issues.length).toBeGreaterThan(0);
    }
  });
});
