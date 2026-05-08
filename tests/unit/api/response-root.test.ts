/**
 * Unit tests for `src/api/response-root.ts` (R41 + R42 lifts).
 *
 * The helper has two modes — `'caller_handles'` (R42 single-target
 * verbs) and `'throw_not_found'` (R41 partial-success-fan-out
 * verbs). Each mode's branch behaviour is exercised end-to-end in
 * the corresponding verb integration tests (item set / item archive
 * / item move etc. for caller_handles; board / workspace add-users /
 * remove-users for throw_not_found). These unit tests pin the
 * helper's per-mode contract in isolation so a regression to the
 * helper itself fails here loudly without depending on any
 * consumer's full path.
 */
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import { assertResponseFieldPresent } from '../../../src/api/response-root.js';

describe('assertResponseFieldPresent', () => {
  describe("'caller_handles' mode (R42 single-target verbs)", () => {
    it('returns void when the key is present and the value is non-null', () => {
      expect(() => {
        assertResponseFieldPresent({
          data: { archive_item: { id: '12345' } },
          key: 'archive_item',
          operationLabel: 'ItemArchive',
          details: { item_id: '12345' },
          nullHandling: 'caller_handles',
        });
      }).not.toThrow();
    });

    it('returns void when the key is present and the value is null (caller projector handles null)', () => {
      // 'caller_handles' explicitly DOES NOT throw on null — the
      // caller's downstream projector decides per-noun semantics
      // (item archive throws not_found, item set throws
      // internal_error). Helper just covers missing-key.
      expect(() => {
        assertResponseFieldPresent({
          data: { archive_item: null },
          key: 'archive_item',
          operationLabel: 'ItemArchive',
          details: { item_id: '12345' },
          nullHandling: 'caller_handles',
        });
      }).not.toThrow();
    });

    it('throws internal_error when the key is absent (schema drift)', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: { other_root_field: 'something' },
          key: 'archive_item',
          operationLabel: 'ItemArchive',
          details: { item_id: '12345' },
          nullHandling: 'caller_handles',
        });
      } catch (err: unknown) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ApiError);
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('internal_error');
      expect(apiError.message).toBe(
        "Monday's ItemArchive response is missing the archive_item root field",
      );
      expect(apiError.details).toMatchObject({
        item_id: '12345',
        hint: expect.stringContaining('schema-drift') as string,
      });
    });

    it('echoes the full caller-supplied details map (two-tuple verbs carry both ids)', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: {},
          key: 'archive_group',
          operationLabel: 'GroupArchive',
          details: { board_id: '111', group_id: 'topics' },
          nullHandling: 'caller_handles',
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.details).toMatchObject({
        board_id: '111',
        group_id: 'topics',
      });
    });
  });

  describe("'throw_not_found' mode (R41 partial-success-fan-out verbs)", () => {
    it('returns void when the key is present and the value is non-null', () => {
      expect(() => {
        assertResponseFieldPresent({
          data: { add_users_to_board: { id: '111', subscribers: [{ id: '42' }] } },
          key: 'add_users_to_board',
          operationLabel: 'BoardAddUsers',
          details: { board_id: '111', user_id: '42' },
          nullHandling: 'throw_not_found',
          notFoundTarget: { key: 'user_id', id: '42' },
        });
      }).not.toThrow();
    });

    it('throws internal_error when the key is absent (whole-call schema drift)', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: { other_field: 'x' },
          key: 'add_users_to_board',
          operationLabel: 'BoardAddUsers',
          details: { board_id: '111', user_id: '42' },
          nullHandling: 'throw_not_found',
          notFoundTarget: { key: 'user_id', id: '42' },
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('internal_error');
      expect(apiError.message).toBe(
        "Monday's BoardAddUsers response is missing the add_users_to_board root field",
      );
    });

    it('throws not_found when the key is present but the value is null (per-record idiomatic)', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: { add_users_to_board: null },
          key: 'add_users_to_board',
          operationLabel: 'BoardAddUsers',
          details: { board_id: '111', user_id: '42' },
          nullHandling: 'throw_not_found',
          notFoundTarget: { key: 'user_id', id: '42' },
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('not_found');
      expect(apiError.message).toBe(
        'Monday returned no payload from add_users_to_board for user 42',
      );
      // not_found details carry only the per-record target — the
      // per-record dispatch slot keys off this shape.
      expect(apiError.details).toEqual({ user_id: '42' });
    });

    it('throws not_found when the key is present but the value is undefined', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: { add_users_to_workspace: undefined },
          key: 'add_users_to_workspace',
          operationLabel: 'WorkspaceAddUsers',
          details: { workspace_id: '999', user_id: '7' },
          nullHandling: 'throw_not_found',
          notFoundTarget: { key: 'user_id', id: '7' },
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('not_found');
    });

    it('strips the trailing _id from the target key when phrasing the not_found message', () => {
      // 'user_id' → 'user', 'workspace_id' → 'workspace'. The
      // helper does this so the message reads naturally without
      // forcing the caller to carry a separate display name.
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: { remove_users_from_workspace: null },
          key: 'remove_users_from_workspace',
          operationLabel: 'WorkspaceRemoveUsers',
          details: { workspace_id: '999', user_id: '7' },
          nullHandling: 'throw_not_found',
          notFoundTarget: { key: 'user_id', id: '7' },
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.message).toBe(
        'Monday returned no payload from remove_users_from_workspace for user 7',
      );
    });
  });

  describe('non-object data (defensive narrow)', () => {
    it('throws internal_error when data is null', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: null,
          key: 'archive_item',
          operationLabel: 'ItemArchive',
          details: { item_id: '12345' },
          nullHandling: 'caller_handles',
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('internal_error');
      expect(apiError.message).toBe(
        "Monday's ItemArchive response data is not object-shaped",
      );
    });

    it('throws internal_error when data is a primitive', () => {
      let thrown: unknown;
      try {
        assertResponseFieldPresent({
          data: 'a string instead of an object',
          key: 'archive_item',
          operationLabel: 'ItemArchive',
          details: { item_id: '12345' },
          nullHandling: 'caller_handles',
        });
      } catch (err: unknown) {
        thrown = err;
      }
      const apiError = thrown as ApiError;
      expect(apiError.code).toBe('internal_error');
      expect(apiError.message).toContain('not object-shaped');
    });
  });
});
