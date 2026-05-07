/**
 * Unit tests for `src/api/group-mutation-result.ts` (R48 lift).
 *
 * Mirrors the per-noun helper tests for `projectMutationItem` (R28),
 * `projectMutationUpdate` (R37), `projectMutationBoard` (R43), and
 * `projectMutationColumn` (R45). Each consumer's call site supplies
 * its own typed error parts; the helper enforces the null guard,
 * the `details: { board_id, [idKey]: idValue }` envelope, and the
 * projection schema parse.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import {
  GROUP_FIELDS_FRAGMENT,
  groupProjectionSchema,
  projectMutationGroup,
} from '../../../src/api/group-mutation-result.js';

const sampleGroup = {
  id: 'topics',
  title: 'Topics',
  color: 'blue',
  position: '1.0',
  archived: false,
  deleted: false,
};

describe('GROUP_FIELDS_FRAGMENT', () => {
  it('selects the six fields that mirror boardMetadataSchema.groups[*]', () => {
    expect(GROUP_FIELDS_FRAGMENT).toContain('id');
    expect(GROUP_FIELDS_FRAGMENT).toContain('title');
    expect(GROUP_FIELDS_FRAGMENT).toContain('color');
    expect(GROUP_FIELDS_FRAGMENT).toContain('position');
    expect(GROUP_FIELDS_FRAGMENT).toContain('archived');
    expect(GROUP_FIELDS_FRAGMENT).toContain('deleted');
  });

  it('does NOT select items_page (out of scope for the mutation envelope data slot)', () => {
    expect(GROUP_FIELDS_FRAGMENT).not.toContain('items_page');
  });
});

describe('groupProjectionSchema', () => {
  it('parses a fully-populated group', () => {
    expect(() => groupProjectionSchema.parse(sampleGroup)).not.toThrow();
  });

  it('accepts null color / position / archived / deleted', () => {
    expect(() =>
      groupProjectionSchema.parse({
        id: 'topics',
        title: 'Topics',
        color: null,
        position: null,
        archived: null,
        deleted: null,
      }),
    ).not.toThrow();
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() =>
      groupProjectionSchema.parse({ ...sampleGroup, extra_key: 1 }),
    ).toThrow();
  });

  it('rejects missing required key (id)', () => {
    const { id: _, ...withoutId } = sampleGroup;
    void _;
    expect(() => groupProjectionSchema.parse(withoutId)).toThrow();
  });

  it('rejects empty id (min(1))', () => {
    expect(() =>
      groupProjectionSchema.parse({ ...sampleGroup, id: '' }),
    ).toThrow();
  });
});

describe('projectMutationGroup — group_id detail key (update / archive / duplicate / delete)', () => {
  it('returns the projected group for a well-formed payload', () => {
    const out = projectMutationGroup({
      raw: sampleGroup,
      errorCode: 'not_found',
      errorMessage: 'unused on success',
      boardId: '12345',
      idKey: 'group_id',
      idValue: 'topics',
    });
    expect(out).toEqual(sampleGroup);
  });

  it('throws ApiError(not_found) on null payload with details.{board_id, group_id}', () => {
    expect(() =>
      projectMutationGroup({
        raw: null,
        errorCode: 'not_found',
        errorMessage: 'no group from delete_group for board 12345 group topics',
        boardId: '12345',
        idKey: 'group_id',
        idValue: 'topics',
      }),
    ).toThrow(ApiError);
    try {
      projectMutationGroup({
        raw: null,
        errorCode: 'not_found',
        errorMessage: 'no group from delete_group for board 12345 group topics',
        boardId: '12345',
        idKey: 'group_id',
        idValue: 'topics',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('not_found');
      expect(err.message).toMatch(/delete_group for board 12345/);
      expect(err.details).toEqual({ board_id: '12345', group_id: 'topics' });
    }
  });

  it('throws ApiError(not_found) on undefined payload too', () => {
    expect(() =>
      projectMutationGroup({
        raw: undefined,
        errorCode: 'not_found',
        errorMessage: 'no group',
        boardId: '12345',
        idKey: 'group_id',
        idValue: 'topics',
      }),
    ).toThrow(ApiError);
  });
});

describe('projectMutationGroup — name detail key (create)', () => {
  it('uses details.name (not group_id) on the create pre-id path', () => {
    try {
      projectMutationGroup({
        raw: null,
        errorCode: 'internal_error',
        errorMessage:
          'no group payload from create_group for board 12345 name "Sprint 42"',
        boardId: '12345',
        idKey: 'name',
        idValue: 'Sprint 42',
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.details).toEqual({ board_id: '12345', name: 'Sprint 42' });
      expect(err.details).not.toHaveProperty('group_id');
    }
  });

  it('returns the projected group even when create supplied details.name', () => {
    const out = projectMutationGroup({
      raw: sampleGroup,
      errorCode: 'internal_error',
      errorMessage: 'unused on success',
      boardId: '12345',
      idKey: 'name',
      idValue: 'Topics',
    });
    expect(out.id).toBe('topics');
    expect(out.title).toBe('Topics');
  });
});

describe('projectMutationGroup — schema-drift', () => {
  it('throws internal_error with details.{board_id, group_id} on a malformed payload', () => {
    try {
      projectMutationGroup({
        raw: { id: 'topics' /* missing title/color/etc. */ },
        errorCode: 'not_found',
        errorMessage: 'unused — schema parse fails before null check',
        boardId: '12345',
        idKey: 'group_id',
        idValue: 'topics',
      });
      expect.fail('expected projectMutationGroup to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // unwrapOrThrow surfaces internal_error (R18 parse-boundary).
      expect(err.code).toBe('internal_error');
      expect(err.details).toMatchObject({
        board_id: '12345',
        group_id: 'topics',
      });
    }
  });

  it('throws internal_error with details.{board_id, name} on the create pre-id path schema drift', () => {
    try {
      projectMutationGroup({
        raw: { id: 'topics' /* missing fields */ },
        errorCode: 'internal_error',
        errorMessage: 'unused — schema parse fails before null check',
        boardId: '12345',
        idKey: 'name',
        idValue: 'Sprint 42',
      });
      expect.fail('expected projectMutationGroup to throw');
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      expect(err.code).toBe('internal_error');
      expect(err.details).toMatchObject({
        board_id: '12345',
        name: 'Sprint 42',
      });
    }
  });
});
