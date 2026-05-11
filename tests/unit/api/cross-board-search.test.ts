/**
 * Surface tests for `src/api/cross-board-search.ts` — the v0.3-M23
 * pre-flight contract diff (cli-design §13 v0.3 entry; Decision 5
 * closure `3a2f1db`).
 *
 * Scope: constants + schemas + pure helpers (`validateMaxBoards`,
 * `buildInaccessibleBoardsWarning`,
 * `buildColumnNotFoundOnBoardWarning`) pinned at pre-flight. The
 * runtime fan-out walker body is a stub (rejects with
 * `internal_error`) and is exercised at M23 implementation alongside
 * the real `boards(ids:) { items_page(query_params:) }` work.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAX_BOARDS,
  HARD_CAP_MAX_BOARDS,
  buildColumnNotFoundOnBoardWarning,
  buildInaccessibleBoardsWarning,
  columnNotFoundOnBoardWarningSchema,
  crossBoardItemSchema,
  crossBoardSearch,
  crossBoardSearchOutputSchema,
  inaccessibleBoardsWarningSchema,
  maxBoardsSchema,
  validateMaxBoards,
} from '../../../src/api/cross-board-search.js';
import { ApiError } from '../../../src/utils/errors.js';
import type { Transport } from '../../../src/api/transport.js';
import type { BoardId } from '../../../src/types/ids.js';

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

describe('buildColumnNotFoundOnBoardWarning', () => {
  it('reports the board + column token + a hint', () => {
    const w = buildColumnNotFoundOnBoardWarning('123', 'status');
    expect(w.code).toBe('column_not_found_on_board');
    expect(w.details.board_id).toBe('123');
    expect(w.details.column_token).toBe('status');
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
        details: { board_id: '1', column_token: 'a', hint: 'h', extra: 'rejected' },
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

describe('crossBoardSearch (pre-flight stub)', () => {
  // The runtime fan-out walker is a Promise.reject(internal_error)
  // stub at the M23 pre-flight. The stub is c8-ignored; the test
  // here confirms the rejection shape so command-level integration
  // tests get a stable failure pattern.
  it('rejects every invocation with internal_error', async () => {
    const fakeTransport = {} as unknown as Transport;
    const fakeBoardIds: readonly BoardId[] = [];
    const fakePlans: readonly { board_id: BoardId; rules: readonly never[] }[] = [];
    await expect(
      crossBoardSearch({
        transport: fakeTransport,
        boardIds: fakeBoardIds,
        plans: fakePlans,
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      crossBoardSearch({
        transport: fakeTransport,
        boardIds: fakeBoardIds,
        plans: fakePlans,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('rejection message mentions M23 + the cross-board surface', async () => {
    const fakeTransport = {} as unknown as Transport;
    try {
      await crossBoardSearch({
        transport: fakeTransport,
        boardIds: [],
        plans: [],
      });
      throw new Error('expected reject');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ApiError);
      const apiErr = err as ApiError;
      expect(apiErr.message).toMatch(/M23 pre-flight stub/);
      expect(apiErr.message).toMatch(/cross-board|fan-out|`monday item search`/);
    }
  });

  it('rejection details.hint points at the M23 implementation surface', async () => {
    const fakeTransport = {} as unknown as Transport;
    try {
      await crossBoardSearch({
        transport: fakeTransport,
        boardIds: [],
        plans: [],
      });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { hint: string };
      expect(details.hint).toMatch(/fan-out walker|M23 implementation/);
    }
  });
});
