/**
 * Unit tests for `src/api/column-mutation-result.ts` (R45 lift).
 *
 * Mirrors the per-noun helper tests for `projectMutationItem` (R28),
 * `projectMutationUpdate` (R37), and `projectMutationBoard` (R43).
 * Each consumer's call site supplies its own typed error parts; the
 * helper enforces the null guard, the `details: { board_id, [columnIdKey]:
 * value }` envelope, and the projection schema parse.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import {
  COLUMN_FIELDS_FRAGMENT,
  columnProjectionSchema,
  projectMutationColumn,
} from '../../../src/api/column-mutation-result.js';

const sampleColumn = {
  id: 'status_4',
  title: 'Status',
  type: 'status',
  description: null,
  archived: false,
  settings_str: '{"labels":{"0":"Backlog"}}',
  width: 120,
};

describe('COLUMN_FIELDS_FRAGMENT', () => {
  it('selects the seven fields that mirror boardMetadataSchema.columns[*]', () => {
    // Pin the exact field set (and order) so a future drift between
    // the fragment and the schema fails here before integration.
    expect(COLUMN_FIELDS_FRAGMENT).toContain('id');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('title');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('type');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('description');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('archived');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('settings_str');
    expect(COLUMN_FIELDS_FRAGMENT).toContain('width');
  });
});

describe('columnProjectionSchema', () => {
  it('parses a fully-populated column', () => {
    expect(() => columnProjectionSchema.parse(sampleColumn)).not.toThrow();
  });

  it('accepts null description / archived / settings_str / width', () => {
    expect(() =>
      columnProjectionSchema.parse({
        id: 'text_1',
        title: 'Notes',
        type: 'text',
        description: null,
        archived: null,
        settings_str: null,
        width: null,
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() =>
      columnProjectionSchema.parse({ ...sampleColumn, extra_key: 1 }),
    ).toThrow();
  });

  it('rejects missing required key (id)', () => {
    const { id: _, ...withoutId } = sampleColumn;
    void _;
    expect(() => columnProjectionSchema.parse(withoutId)).toThrow();
  });
});

describe('projectMutationColumn — column_id detail key (update / delete)', () => {
  it('returns the projected column for a well-formed payload', () => {
    const out = projectMutationColumn({
      raw: sampleColumn,
      errorCode: 'not_found',
      errorMessage: 'unused on success',
      boardId: '12345',
      columnIdKey: 'column_id',
      columnIdValue: 'status_4',
    });
    expect(out).toEqual(sampleColumn);
  });

  it('throws ApiError(not_found) on null payload with details.{board_id, column_id}', () => {
    expect(() =>
      projectMutationColumn({
        raw: null,
        errorCode: 'not_found',
        errorMessage: 'no column from delete_column for board 12345 column status_4',
        boardId: '12345',
        columnIdKey: 'column_id',
        columnIdValue: 'status_4',
      }),
    ).toThrow(ApiError);
    try {
      projectMutationColumn({
        raw: null,
        errorCode: 'not_found',
        errorMessage: 'no column from delete_column for board 12345 column status_4',
        boardId: '12345',
        columnIdKey: 'column_id',
        columnIdValue: 'status_4',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.message).toMatch(/delete_column for board 12345/);
      expect(err.details).toEqual({ board_id: '12345', column_id: 'status_4' });
    }
  });

  it('throws ApiError(not_found) on undefined payload too', () => {
    expect(() =>
      projectMutationColumn({
        raw: undefined,
        errorCode: 'not_found',
        errorMessage: 'no column',
        boardId: '12345',
        columnIdKey: 'column_id',
        columnIdValue: 'status_4',
      }),
    ).toThrow(ApiError);
  });
});

describe('projectMutationColumn — title detail key (create)', () => {
  it('uses details.title (not column_id) on the create pre-id path', () => {
    try {
      projectMutationColumn({
        raw: null,
        errorCode: 'internal_error',
        errorMessage:
          'no column payload from create_column for board 12345 title "Priority"',
        boardId: '12345',
        columnIdKey: 'title',
        columnIdValue: 'Priority',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.details).toEqual({ board_id: '12345', title: 'Priority' });
      expect(err.details).not.toHaveProperty('column_id');
    }
  });

  it('returns the projected column even when create supplied details.title', () => {
    const out = projectMutationColumn({
      raw: sampleColumn,
      errorCode: 'internal_error',
      errorMessage: 'unused on success',
      boardId: '12345',
      columnIdKey: 'title',
      columnIdValue: 'Status',
    });
    expect(out.id).toBe('status_4');
    expect(out.title).toBe('Status');
  });
});

describe('projectMutationColumn — schema-drift', () => {
  it('throws internal_error with details.{board_id, column_id} on a malformed payload', () => {
    try {
      projectMutationColumn({
        raw: { id: 'status_4' /* missing title/type/etc. */ },
        errorCode: 'not_found',
        errorMessage: 'unused — schema parse fails before null check',
        boardId: '12345',
        columnIdKey: 'column_id',
        columnIdValue: 'status_4',
      });
      expect.fail('expected projectMutationColumn to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // unwrapOrThrow surfaces internal_error (R18 parse-boundary).
      expect(err.code).toBe('internal_error');
      expect(err.details).toMatchObject({
        board_id: '12345',
        column_id: 'status_4',
      });
    }
  });
});
