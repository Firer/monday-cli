/**
 * Unit tests for `src/api/board-child-finder.ts` (R51 lift).
 *
 * Mirrors per-noun helper tests: happy path + not_found + empty
 * collection per kind. The three migration sites (column-update,
 * group-update, group-archive) carry their own integration tests
 * for the lifted-from contract; these unit tests pin the helper's
 * behaviour in isolation.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import { findBoardChildOrThrow } from '../../../src/api/board-child-finder.js';
import type { BoardMetadata } from '../../../src/api/board-metadata.js';

const baseMetadata: BoardMetadata = {
  id: '12345',
  name: 'Sample Board',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: null,
  url: null,
  hierarchy_type: null,
  items_count: null,
  permissions: null,
  updated_at: null,
  groups: [
    {
      id: 'topics',
      title: 'Topics',
      color: 'blue',
      position: '1.0',
      archived: false,
      deleted: false,
    },
    {
      id: 'sprint_42',
      title: 'Sprint 42',
      color: 'green',
      position: '2.0',
      archived: false,
      deleted: false,
    },
  ],
  columns: [
    {
      id: 'status_4',
      title: 'Status',
      type: 'status',
      description: null,
      archived: false,
      settings_str: null,
      width: null,
    },
    {
      id: 'name',
      title: 'Name',
      type: 'name',
      description: null,
      archived: false,
      settings_str: null,
      width: null,
    },
  ],
  views: [],
};

describe('findBoardChildOrThrow — kind: columns', () => {
  it('returns the column when the id matches', () => {
    const out = findBoardChildOrThrow({
      metadata: baseMetadata,
      kind: 'columns',
      id: 'status_4',
      boardId: '12345',
    });
    expect(out.id).toBe('status_4');
    expect(out.title).toBe('Status');
    expect(out.type).toBe('status');
  });

  it('throws ApiError(not_found) when the column id is absent', () => {
    expect(() =>
      findBoardChildOrThrow({
        metadata: baseMetadata,
        kind: 'columns',
        id: 'ghost_col',
        boardId: '12345',
      }),
    ).toThrow(ApiError);
  });

  it('thrown error pins details.{board_id, column_id} (NOT columns_id)', () => {
    try {
      findBoardChildOrThrow({
        metadata: baseMetadata,
        kind: 'columns',
        id: 'ghost_col',
        boardId: '12345',
      });
      expect.fail('expected findBoardChildOrThrow to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.message).toBe(
        'Monday returned no column with id ghost_col on board 12345',
      );
      expect(err.details).toEqual({
        board_id: '12345',
        column_id: 'ghost_col',
      });
      expect(err.details).not.toHaveProperty('columns_id');
      expect(err.details).not.toHaveProperty('group_id');
    }
  });

  it('throws not_found when columns is empty', () => {
    const empty: BoardMetadata = { ...baseMetadata, columns: [] };
    try {
      findBoardChildOrThrow({
        metadata: empty,
        kind: 'columns',
        id: 'any_col',
        boardId: '12345',
      });
      expect.fail('expected findBoardChildOrThrow to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.details).toEqual({
        board_id: '12345',
        column_id: 'any_col',
      });
    }
  });
});

describe('findBoardChildOrThrow — kind: groups', () => {
  it('returns the group when the id matches', () => {
    const out = findBoardChildOrThrow({
      metadata: baseMetadata,
      kind: 'groups',
      id: 'topics',
      boardId: '12345',
    });
    expect(out.id).toBe('topics');
    expect(out.title).toBe('Topics');
    expect(out.color).toBe('blue');
  });

  it('throws ApiError(not_found) when the group id is absent', () => {
    expect(() =>
      findBoardChildOrThrow({
        metadata: baseMetadata,
        kind: 'groups',
        id: 'ghost_group',
        boardId: '12345',
      }),
    ).toThrow(ApiError);
  });

  it('thrown error pins details.{board_id, group_id} (NOT groups_id)', () => {
    try {
      findBoardChildOrThrow({
        metadata: baseMetadata,
        kind: 'groups',
        id: 'ghost_group',
        boardId: '12345',
      });
      expect.fail('expected findBoardChildOrThrow to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.message).toBe(
        'Monday returned no group with id ghost_group on board 12345',
      );
      expect(err.details).toEqual({
        board_id: '12345',
        group_id: 'ghost_group',
      });
      expect(err.details).not.toHaveProperty('groups_id');
      expect(err.details).not.toHaveProperty('column_id');
    }
  });

  it('throws not_found when groups is empty', () => {
    const empty: BoardMetadata = { ...baseMetadata, groups: [] };
    try {
      findBoardChildOrThrow({
        metadata: empty,
        kind: 'groups',
        id: 'any_group',
        boardId: '12345',
      });
      expect.fail('expected findBoardChildOrThrow to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.details).toEqual({
        board_id: '12345',
        group_id: 'any_group',
      });
    }
  });
});

describe('findBoardChildOrThrow — non-mutation guarantee', () => {
  it('does not mutate the input metadata', () => {
    const before = JSON.stringify(baseMetadata);
    findBoardChildOrThrow({
      metadata: baseMetadata,
      kind: 'columns',
      id: 'status_4',
      boardId: '12345',
    });
    expect(JSON.stringify(baseMetadata)).toBe(before);
  });
});
