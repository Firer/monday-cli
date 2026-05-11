/**
 * Surface tests for `src/api/board-favorites.ts` — the v0.3-M23
 * runtime body for the 2-stage favorites resolver (cli-design §13
 * v0.3 entry).
 *
 * Scope: GraphQL document constants + schemas + pure helpers
 * (`filterFavoritesToBoards`, `joinFavoritesWithBoards`,
 * `buildStaleFavoritesWarning`) + the runtime `fetchBoardFavorites`
 * 2-stage resolver driven via a seam-injected `MondayClient` stub
 * (mock-at-the-network-boundary per testing.md — the stub replaces
 * the typed `raw` surface MondayClient exposes downstream).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  BOARDS_HYDRATE_QUERY,
  FAVORITES_LIST_QUERY,
  HIERARCHY_OBJECT_TYPE_BOARD,
  boardFavoriteOutputSchema,
  boardFavoritesOutputSchema,
  boardsHydrateResponseSchema,
  buildStaleFavoritesWarning,
  favoritesListResponseSchema,
  fetchBoardFavorites,
  filterFavoritesToBoards,
  joinFavoritesWithBoards,
  rawFavoriteEntrySchema,
  rawHydratedBoardSchema,
  staleFavoritesWarningSchema,
} from '../../../src/api/board-favorites.js';
import { ApiError } from '../../../src/utils/errors.js';
import type {
  MondayClient,
  MondayResponse,
} from '../../../src/api/client.js';
import type { Complexity } from '../../../src/utils/output/envelope.js';

describe('HIERARCHY_OBJECT_TYPE_BOARD', () => {
  it('pins the literal "Board" string per the empirical probe', () => {
    // `scripts/probe/m23-monday-object-enum.ts` confirmed the
    // GraphqlMondayObject enum values are Board | Folder |
    // Dashboard | Workspace. The filter step matches the literal
    // `"Board"` string.
    expect(HIERARCHY_OBJECT_TYPE_BOARD).toBe('Board');
  });
});

describe('FAVORITES_LIST_QUERY', () => {
  it('selects the polymorphic discriminator + position', () => {
    expect(FAVORITES_LIST_QUERY).toMatch(/favorites/);
    expect(FAVORITES_LIST_QUERY).toMatch(/object\s*{\s*id\s+type\s*}/);
    expect(FAVORITES_LIST_QUERY).toMatch(/position/);
  });

  it('does not select unused fields per the pre-flight scope', () => {
    expect(FAVORITES_LIST_QUERY).not.toMatch(/createdAt|updatedAt|folderId|accountId/);
  });
});

describe('BOARDS_HYDRATE_QUERY', () => {
  it('hydrates the boards(ids:) selection for the M23 output shape', () => {
    expect(BOARDS_HYDRATE_QUERY).toMatch(/boards\(ids:\s*\$ids\)/);
    expect(BOARDS_HYDRATE_QUERY).toMatch(/\bid\b/);
    expect(BOARDS_HYDRATE_QUERY).toMatch(/\bname\b/);
    expect(BOARDS_HYDRATE_QUERY).toMatch(/\bstate\b/);
    expect(BOARDS_HYDRATE_QUERY).toMatch(/workspace_id/);
    expect(BOARDS_HYDRATE_QUERY).toMatch(/\burl\b/);
  });

  it('does NOT select complexity unconditionally (Codex P1-1)', () => {
    // MondayClient.raw() injects `complexity { ... }` at the
    // operation root only when --verbose is on (src/api/client.ts
    // injectComplexity); hard-coding it in the query would leak
    // the field outside --verbose, which contradicts cli-design
    // §6.1's `meta.complexity: null` outside-verbose contract,
    // and would inflate per-call cost for every favorites read.
    expect(BOARDS_HYDRATE_QUERY).not.toMatch(/complexity/);
  });
});

describe('rawFavoriteEntrySchema', () => {
  it('parses a Board-typed favorite', () => {
    expect(() =>
      rawFavoriteEntrySchema.parse({
        id: '1',
        object: { id: '100', type: 'Board' },
        position: 1.5,
      }),
    ).not.toThrow();
  });

  it('parses a Folder-typed favorite (polymorphic — not filtered at parse)', () => {
    // The filter step (`filterFavoritesToBoards`) drops non-Board
    // entries — the parser must accept them so the parse doesn't
    // break on the user's mixed-favorites list.
    expect(() =>
      rawFavoriteEntrySchema.parse({
        id: '2',
        object: { id: '200', type: 'Folder' },
        position: 2.0,
      }),
    ).not.toThrow();
  });

  it('rejects empty hierarchy-item id', () => {
    expect(() =>
      rawFavoriteEntrySchema.parse({
        id: '',
        object: { id: '100', type: 'Board' },
        position: 1,
      }),
    ).toThrow();
  });
});

describe('favoritesListResponseSchema', () => {
  it('parses an empty favorites list', () => {
    expect(favoritesListResponseSchema.parse({ favorites: [] })).toEqual({
      favorites: [],
    });
  });

  it('parses a null favorites list (some accounts return null)', () => {
    expect(favoritesListResponseSchema.parse({ favorites: null })).toEqual({
      favorites: null,
    });
  });

  it('is loose — allows additive future Monday Query-root fields', () => {
    const parsed = favoritesListResponseSchema.parse({
      favorites: [],
      future_field: 'whatever',
    });
    expect(parsed.favorites).toEqual([]);
  });
});

describe('rawHydratedBoardSchema', () => {
  it('accepts a fully-populated board', () => {
    expect(() =>
      rawHydratedBoardSchema.parse({
        id: '100',
        name: 'Tasks',
        state: 'active',
        workspace_id: '50',
        url: 'https://x.monday.com/boards/100',
      }),
    ).not.toThrow();
  });

  it('allows null state / workspace_id / url (main workspace / archived)', () => {
    expect(() =>
      rawHydratedBoardSchema.parse({
        id: '100',
        name: 'Tasks',
        state: null,
        workspace_id: null,
        url: null,
      }),
    ).not.toThrow();
  });
});

describe('boardsHydrateResponseSchema', () => {
  it('parses the standard hydrate response shape', () => {
    expect(() =>
      boardsHydrateResponseSchema.parse({
        boards: [
          {
            id: '100',
            name: 'Tasks',
            state: 'active',
            workspace_id: '50',
            url: 'https://x.monday.com/boards/100',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('accepts null boards (some accounts return null instead of [])', () => {
    expect(() =>
      boardsHydrateResponseSchema.parse({ boards: null }),
    ).not.toThrow();
  });

  it('accepts an empty boards array', () => {
    expect(() =>
      boardsHydrateResponseSchema.parse({ boards: [] }),
    ).not.toThrow();
  });

  it('is loose — Monday-side complexity injection passes through (Codex P1-1)', () => {
    // MondayClient injects `complexity { ... }` at the operation
    // root under --verbose; the response carries the field
    // alongside `boards`. Since the schema is `.loose()`, the
    // extra field passes parse without breaking.
    expect(() =>
      boardsHydrateResponseSchema.parse({
        boards: [],
        complexity: {
          before: 999_950,
          after: 999_920,
          query: 30,
          reset_in_x_seconds: 60,
        },
      }),
    ).not.toThrow();
  });
});

describe('boardFavoriteOutputSchema', () => {
  it('accepts the M23 output row', () => {
    expect(() =>
      boardFavoriteOutputSchema.parse({
        id: '100',
        name: 'Tasks',
        state: 'active',
        workspace_id: '50',
        url: 'https://x.monday.com/boards/100',
        position: 1.5,
      }),
    ).not.toThrow();
  });

  it('rejects empty id (strict)', () => {
    expect(() =>
      boardFavoriteOutputSchema.parse({
        id: '',
        name: 'Tasks',
        state: 'active',
        workspace_id: null,
        url: null,
        position: 1,
      }),
    ).toThrow();
  });
});

describe('boardFavoritesOutputSchema', () => {
  it('parses an empty array', () => {
    expect(boardFavoritesOutputSchema.parse([])).toEqual([]);
  });

  it('parses a populated array', () => {
    const data = [
      { id: '1', name: 'A', state: 'active', workspace_id: null, url: null, position: 1 },
      { id: '2', name: 'B', state: 'active', workspace_id: '50', url: 'u', position: 2 },
    ];
    expect(boardFavoritesOutputSchema.parse(data)).toEqual(data);
  });
});

describe('filterFavoritesToBoards', () => {
  it('keeps only Board-typed entries', () => {
    const result = filterFavoritesToBoards({
      favorites: [
        { id: '1', object: { id: '100', type: 'Board' }, position: 1 },
        { id: '2', object: { id: '200', type: 'Folder' }, position: 2 },
        { id: '3', object: { id: '300', type: 'Dashboard' }, position: 3 },
        { id: '4', object: { id: '400', type: 'Workspace' }, position: 4 },
        { id: '5', object: { id: '500', type: 'Board' }, position: 5 },
      ],
    });
    expect(result.map((e) => e.object.id)).toEqual(['100', '500']);
  });

  it('sorts by position ascending', () => {
    const result = filterFavoritesToBoards({
      favorites: [
        { id: 'c', object: { id: '300', type: 'Board' }, position: 3 },
        { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
        { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
      ],
    });
    expect(result.map((e) => e.position)).toEqual([1, 2, 3]);
  });

  it('breaks position ties deterministically by hierarchy-item id', () => {
    const result = filterFavoritesToBoards({
      favorites: [
        { id: 'b', object: { id: '200', type: 'Board' }, position: 1 },
        { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
      ],
    });
    expect(result.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('returns an empty array on empty favorites', () => {
    expect(filterFavoritesToBoards({ favorites: [] })).toEqual([]);
  });

  it('treats null favorites as empty', () => {
    expect(filterFavoritesToBoards({ favorites: null })).toEqual([]);
  });

  it('does not mutate the input', () => {
    const input = {
      favorites: [
        { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
        { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
      ],
    };
    const before = JSON.stringify(input);
    filterFavoritesToBoards(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('treats unrecognised type values as non-Board (forward-compat)', () => {
    const result = filterFavoritesToBoards({
      favorites: [
        { id: '1', object: { id: '100', type: 'Form' }, position: 1 },
        { id: '2', object: { id: '200', type: 'Board' }, position: 2 },
      ],
    });
    expect(result.map((e) => e.object.id)).toEqual(['200']);
  });
});

describe('joinFavoritesWithBoards', () => {
  it('joins Stage-1 favorites with Stage-2 hydrated boards', () => {
    const result = joinFavoritesWithBoards(
      [
        { id: '1', object: { id: '100', type: 'Board' }, position: 1.5 },
        { id: '2', object: { id: '200', type: 'Board' }, position: 2.0 },
      ],
      [
        { id: '100', name: 'A', state: 'active', workspace_id: '50', url: 'u' },
        { id: '200', name: 'B', state: 'archived', workspace_id: null, url: null },
      ],
    );
    expect(result).toEqual([
      { id: '100', name: 'A', state: 'active', workspace_id: '50', url: 'u', position: 1.5 },
      { id: '200', name: 'B', state: 'archived', workspace_id: null, url: null, position: 2.0 },
    ]);
  });

  it('drops favorites that Stage 2 did not hydrate (stale)', () => {
    const result = joinFavoritesWithBoards(
      [
        { id: '1', object: { id: '100', type: 'Board' }, position: 1 },
        { id: '2', object: { id: '200', type: 'Board' }, position: 2 },
      ],
      [
        { id: '100', name: 'A', state: 'active', workspace_id: null, url: null },
      ],
    );
    expect(result.map((b) => b.id)).toEqual(['100']);
  });

  it('preserves Stage-1 order (already position-sorted)', () => {
    const result = joinFavoritesWithBoards(
      [
        { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
        { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
      ],
      // Stage-2 may return in a different order; the join uses
      // Stage-1's order.
      [
        { id: '200', name: 'B', state: null, workspace_id: null, url: null },
        { id: '100', name: 'A', state: null, workspace_id: null, url: null },
      ],
    );
    expect(result.map((b) => b.id)).toEqual(['100', '200']);
  });

  it('returns an empty array when Stage 1 is empty', () => {
    expect(joinFavoritesWithBoards([], [])).toEqual([]);
  });
});

describe('buildStaleFavoritesWarning', () => {
  it('reports the missing IDs', () => {
    const w = buildStaleFavoritesWarning(['100', '200', '300'], ['100', '300']);
    expect(w.code).toBe('board_favorites_stale');
    expect(w.details.favorited_count).toBe(3);
    expect(w.details.hydrated_count).toBe(2);
    expect(w.details.missing_board_ids).toEqual(['200']);
  });

  it('handles the no-stale case (delta zero)', () => {
    const w = buildStaleFavoritesWarning(['100'], ['100']);
    expect(w.details.missing_board_ids).toEqual([]);
  });

  it('parses against the schema', () => {
    const w = buildStaleFavoritesWarning(['100', '200'], ['100']);
    expect(() => staleFavoritesWarningSchema.parse(w)).not.toThrow();
  });

  it('hint mentions the access-revoked / deletion scenarios', () => {
    const w = buildStaleFavoritesWarning(['100'], []);
    expect(w.details.hint).toMatch(/deleted|access revoked|archived/);
  });
});

/**
 * Builds a seam-injected `MondayClient` stub for the resolver tests.
 * Mock-at-the-network-boundary per testing.md: only `raw` is
 * stubbed (the typed surface `fetchBoardFavorites` consumes); the
 * other methods stay unimplemented because the resolver never
 * touches them.
 *
 * Each call routes by `operationName` to the matching response in
 * `responses`. Throws if no entry matches — surfaces "the resolver
 * issued a stage we didn't plan for" mismatches loudly.
 */
const buildClientStub = (
  responses: Readonly<Record<string, MondayResponse<unknown>>>,
): { client: MondayClient; raw: ReturnType<typeof vi.fn> } => {
  const raw = vi.fn(
    (
      _query: string,
      _variables: Readonly<Record<string, unknown>> | undefined,
      options: { operationName?: string } = {},
    ): Promise<MondayResponse<unknown>> => {
      const opName = options.operationName ?? '<anon>';
      const response = responses[opName];
      if (response === undefined) {
        return Promise.reject(
          new Error(`buildClientStub: no canned response for ${opName}`),
        );
      }
      return Promise.resolve(response);
    },
  );
  const client = { raw } as unknown as MondayClient;
  return { client, raw };
};

const emptyComplexity = (): Complexity | null => null;

describe('fetchBoardFavorites — Stage-1 short-circuit', () => {
  it('returns empty data + skips Stage 2 when favorites is empty', async () => {
    const { client, raw } = buildClientStub({
      BoardFavoritesStage1: {
        data: { favorites: [] },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBe(null);
    expect(result.complexity).toBe(null);
    expect(raw).toHaveBeenCalledTimes(1);
    expect(raw.mock.calls[0]?.[2]).toEqual({
      operationName: 'BoardFavoritesStage1',
    });
  });

  it('skips Stage 2 when Stage 1 returns null favorites', async () => {
    const { client, raw } = buildClientStub({
      BoardFavoritesStage1: {
        data: { favorites: null },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('skips Stage 2 when Stage 1 has only non-Board entries', async () => {
    const { client, raw } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: '1', object: { id: '100', type: 'Folder' }, position: 1 },
            { id: '2', object: { id: '200', type: 'Dashboard' }, position: 2 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(1);
  });
});

describe('fetchBoardFavorites — happy path', () => {
  it('runs both stages + joins position with hydrated board fields', async () => {
    const { client, raw } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: 'h1', object: { id: '100', type: 'Board' }, position: 1.5 },
            { id: 'h2', object: { id: '200', type: 'Folder' }, position: 2 },
            { id: 'h3', object: { id: '300', type: 'Board' }, position: 3 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: {
          boards: [
            {
              id: '100',
              name: 'Tasks',
              state: 'active',
              workspace_id: '50',
              url: 'https://x.monday.com/boards/100',
            },
            {
              id: '300',
              name: 'Archive',
              state: 'archived',
              workspace_id: null,
              url: null,
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards).toEqual([
      {
        id: '100',
        name: 'Tasks',
        state: 'active',
        workspace_id: '50',
        url: 'https://x.monday.com/boards/100',
        position: 1.5,
      },
      {
        id: '300',
        name: 'Archive',
        state: 'archived',
        workspace_id: null,
        url: null,
        position: 3,
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBe(null);
    expect(raw).toHaveBeenCalledTimes(2);
    expect(raw.mock.calls[1]?.[1]).toEqual({ ids: ['100', '300'] });
  });

  it("passes Stage 2's complexity through (verbose-injection contract)", async () => {
    const stage2Complexity: Complexity = {
      before: 999_950,
      after: 999_900,
      query: 50,
      reset_in_x_seconds: 60,
    };
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: '1', object: { id: '100', type: 'Board' }, position: 1 },
          ],
        },
        complexity: {
          before: 999_950,
          after: 999_940,
          query: 10,
          reset_in_x_seconds: 60,
        },
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: {
          boards: [
            { id: '100', name: 'X', state: 'active', workspace_id: null, url: null },
          ],
        },
        complexity: stage2Complexity,
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.complexity).toEqual(stage2Complexity);
  });

  it("passes Stage 1's complexity through on the empty short-circuit path", async () => {
    const stage1Complexity: Complexity = {
      before: 999_950,
      after: 999_940,
      query: 10,
      reset_in_x_seconds: 60,
    };
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: { favorites: [] },
        complexity: stage1Complexity,
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.complexity).toEqual(stage1Complexity);
  });
});

describe('fetchBoardFavorites — stale-favorites warning', () => {
  it('surfaces board_favorites_stale on the Stage-1/Stage-2 count delta', async () => {
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
            { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
            { id: 'c', object: { id: '300', type: 'Board' }, position: 3 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: {
          boards: [
            { id: '100', name: 'A', state: 'active', workspace_id: null, url: null },
            { id: '300', name: 'C', state: 'active', workspace_id: null, url: null },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards.map((b) => b.id)).toEqual(['100', '300']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.code).toBe('board_favorites_stale');
    expect(result.warnings[0]?.details.missing_board_ids).toEqual(['200']);
  });

  it('drops null entries from Stage 2 boards (defensive nullability)', async () => {
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
            { id: 'b', object: { id: '200', type: 'Board' }, position: 2 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: {
          boards: [
            { id: '100', name: 'A', state: 'active', workspace_id: null, url: null },
            null,
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards.map((b) => b.id)).toEqual(['100']);
    expect(result.warnings[0]?.code).toBe('board_favorites_stale');
    expect(result.warnings[0]?.details.missing_board_ids).toEqual(['200']);
  });

  it('handles Stage 2 returning null boards (some accounts return null)', async () => {
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: 'a', object: { id: '100', type: 'Board' }, position: 1 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: { boards: null },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    const result = await fetchBoardFavorites({ client });
    expect(result.boards).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.details.missing_board_ids).toEqual(['100']);
  });
});

describe('fetchBoardFavorites — parse-failure surface', () => {
  it('surfaces internal_error with details.issues on Stage 1 type mismatch', async () => {
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: { favorites: 'not-an-array' },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    await expect(fetchBoardFavorites({ client })).rejects.toBeInstanceOf(
      ApiError,
    );
    try {
      await fetchBoardFavorites({ client });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('internal_error');
      expect(apiErr.message).toMatch(/Query\.favorites/);
      const details = apiErr.details as {
        issues: readonly { path: string; message: string }[];
        hint: string;
      };
      expect(details.issues.length).toBeGreaterThan(0);
      expect(details.hint).toMatch(/Query\.favorites|m23-favorites-deep/);
    }
  });

  it('surfaces internal_error with details.issues on Stage 2 type mismatch', async () => {
    const { client } = buildClientStub({
      BoardFavoritesStage1: {
        data: {
          favorites: [
            { id: '1', object: { id: '100', type: 'Board' }, position: 1 },
          ],
        },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
      BoardFavoritesStage2: {
        data: { boards: [{ id: '100' }] },
        complexity: emptyComplexity(),
        stats: { attempts: 1, sleeps: [] },
      },
    });
    try {
      await fetchBoardFavorites({ client });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('internal_error');
      expect(apiErr.message).toMatch(/boards\(ids:\)/);
      const details = apiErr.details as { hint: string };
      expect(details.hint).toMatch(/boards\(ids:\)/);
    }
  });
});
