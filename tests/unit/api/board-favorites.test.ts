/**
 * Surface tests for `src/api/board-favorites.ts` — the v0.3-M23
 * pre-flight contract diff (cli-design §13 v0.3 entry).
 *
 * Scope: GraphQL document constants + schemas + pure helpers
 * (`filterFavoritesToBoards`, `joinFavoritesWithBoards`,
 * `buildStaleFavoritesWarning`) pinned at pre-flight. The runtime
 * `fetchBoardFavorites` 2-stage resolver body is a stub (rejects
 * with `internal_error`) and is exercised at M23 implementation
 * alongside the real `Query.favorites` + `boards(ids:)` work.
 */
import { describe, it, expect } from 'vitest';
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
import type { Transport } from '../../../src/api/transport.js';

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

  it('selects complexity for --verbose support', () => {
    expect(BOARDS_HYDRATE_QUERY).toMatch(/complexity/);
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
        complexity: {
          before: 999_950,
          after: 999_920,
          query: 30,
          reset_in_x_seconds: 60,
        },
      }),
    ).not.toThrow();
  });

  it('accepts null boards (some accounts return null instead of [])', () => {
    expect(() =>
      boardsHydrateResponseSchema.parse({ boards: null }),
    ).not.toThrow();
  });

  it('accepts missing complexity (Monday omits complexity sometimes)', () => {
    expect(() =>
      boardsHydrateResponseSchema.parse({ boards: [] }),
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

describe('fetchBoardFavorites (pre-flight stub)', () => {
  // The runtime 2-stage resolver is a Promise.reject(internal_error)
  // stub at the M23 pre-flight. The stub is c8-ignored; the test
  // here confirms the rejection shape so command-level integration
  // tests get a stable failure pattern.
  it('rejects every invocation with internal_error', async () => {
    const fakeTransport = {} as unknown as Transport;
    await expect(
      fetchBoardFavorites({ transport: fakeTransport }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      fetchBoardFavorites({ transport: fakeTransport }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('rejection message mentions M23 + the 2-stage resolver', async () => {
    const fakeTransport = {} as unknown as Transport;
    try {
      await fetchBoardFavorites({ transport: fakeTransport });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.message).toMatch(/M23 pre-flight stub/);
      expect(apiErr.message).toMatch(/2-stage|favorites resolver|board favorites/i);
    }
  });

  it('rejection details.hint references the FAVORITES_LIST_QUERY + BOARDS_HYDRATE_QUERY shape', async () => {
    const fakeTransport = {} as unknown as Transport;
    try {
      await fetchBoardFavorites({ transport: fakeTransport });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      const details = apiErr.details as { hint: string };
      expect(details.hint).toMatch(/FAVORITES_LIST_QUERY|BOARDS_HYDRATE_QUERY|filterFavoritesToBoards/);
    }
  });
});
