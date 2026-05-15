/**
 * Unit tests for `src/utils/parse-brand-list.ts` (R-NEW-70 lift,
 * v0.5-M34 pre-flight kickoff — ahead-of-feat per R-NEW-29 M25
 * cadence; v0.5-plan §22 R-NEW-70 entry).
 *
 * `parseBrandedListArg` is exercised indirectly across 4 consumer
 * sites post-M34-pre-flight (1 migrated + 3 new) — `doc list
 * --workspace` + `team-create --users` + `team-add-members --users`
 * + `team-remove-members --users`. The direct tests below pin the
 * branch matrix (split / trim / empty-entry rejection / per-entry
 * brand-validation rejection / argv-value echo / hint propagation /
 * emptyEntryHint default-vs-override / multi-issue surfacing) so a
 * future refactor that accidentally drifts the helper's contract
 * surfaces inline.
 *
 * Tests bind the helper against `WorkspaceIdSchema` (numeric brand,
 * same shape M32 doc list uses) + `UserIdSchema` (M34 team verbs) +
 * a synthetic non-numeric brand to cover the brand-shape-
 * agnosticism explicitly.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseBrandedListArg } from '../../../src/utils/parse-brand-list.js';
import { UsageError } from '../../../src/utils/errors.js';
import {
  UserIdSchema,
  WorkspaceIdSchema,
} from '../../../src/types/ids.js';

describe('parseBrandedListArg (R-NEW-70 lift)', () => {
  describe('happy paths', () => {
    it('splits a single numeric id', () => {
      const ids = parseBrandedListArg('12345', WorkspaceIdSchema, {
        flagName: '--workspace',
        entryDescription: 'numeric workspace ID',
        hint: 'workspace IDs are numeric (e.g. 12345)',
      });
      expect(ids).toEqual(['12345']);
    });

    it('splits two numeric ids', () => {
      const ids = parseBrandedListArg('12345,67890', WorkspaceIdSchema, {
        flagName: '--workspace',
        entryDescription: 'numeric workspace ID',
        hint: 'workspace IDs are numeric (e.g. 12345)',
      });
      expect(ids).toEqual(['12345', '67890']);
    });

    it('trims whitespace around commas', () => {
      const ids = parseBrandedListArg('12345 , 67890', WorkspaceIdSchema, {
        flagName: '--workspace',
        entryDescription: 'numeric workspace ID',
        hint: 'workspace IDs are numeric (e.g. 12345)',
      });
      expect(ids).toEqual(['12345', '67890']);
    });

    it('preserves input order across many entries', () => {
      const ids = parseBrandedListArg(
        '1,2,3,4,5',
        UserIdSchema,
        {
          flagName: '--users',
          entryDescription: 'numeric user ID',
          hint: 'user IDs are numeric (e.g. 12345)',
        },
      );
      expect(ids).toEqual(['1', '2', '3', '4', '5']);
    });
  });

  describe('empty-entry rejections', () => {
    it('rejects a trailing comma', () => {
      expect(() =>
        parseBrandedListArg('12345,', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/empty entry/u);
    });

    it('rejects a leading comma', () => {
      expect(() =>
        parseBrandedListArg(',12345', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/empty entry/u);
    });

    it('rejects a double comma', () => {
      expect(() =>
        parseBrandedListArg('12345,,67890', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/empty entry/u);
    });

    it('rejects a whitespace-only entry (trim collapses to empty)', () => {
      expect(() =>
        parseBrandedListArg('12345, ,67890', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/empty entry/u);
    });

    it('surfaces the argv_value on empty-entry rejection', () => {
      try {
        parseBrandedListArg('12345,', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        expect(detail.argv_value).toBe('12345,');
      }
    });

    it('uses the default empty-entry hint when emptyEntryHint is omitted', () => {
      try {
        parseBrandedListArg('12345,', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        expect(detail.hint).toMatch(/--workspace <id>,<id>/u);
        expect(detail.hint).toMatch(/no leading, trailing, or duplicate commas/u);
      }
    });

    it('uses the emptyEntryHint override when supplied', () => {
      try {
        parseBrandedListArg('12345,', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
          emptyEntryHint:
            'e.g. --workspace 12345,67890 — no leading, trailing, or ' +
            'duplicate commas',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        expect(detail.hint).toBe(
          'e.g. --workspace 12345,67890 — no leading, trailing, or ' +
            'duplicate commas',
        );
      }
    });
  });

  describe('brand-rejection paths', () => {
    it('rejects a non-numeric entry', () => {
      expect(() =>
        parseBrandedListArg('abc', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/not a numeric workspace ID/u);
    });

    it('rejects a mixed numeric + non-numeric list (per-entry validation)', () => {
      expect(() =>
        parseBrandedListArg('12345,abc', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        }),
      ).toThrow(/not a numeric workspace ID/u);
    });

    it('rejects a numeric entry that fails a non-numeric brand', () => {
      const NonNumericBrand = z
        .string()
        .regex(/^[a-z]+$/u, 'must be all-lowercase letters')
        .brand<'NonNumericBrand'>();
      expect(() =>
        parseBrandedListArg('abc,12345', NonNumericBrand, {
          flagName: '--token',
          entryDescription: 'lowercase letter token',
          hint: 'tokens are all-lowercase letters (e.g. abc)',
        }),
      ).toThrow(/not a lowercase letter token/u);
    });

    it('surfaces the argv_value + issues + hint on brand rejection', () => {
      try {
        parseBrandedListArg('12345,abc', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        expect(detail.argv_value).toBe('12345,abc');
        expect(detail.hint).toBe('workspace IDs are numeric (e.g. 12345)');
        expect(Array.isArray(detail.issues)).toBe(true);
        const issues = detail.issues as readonly { path: string; message: string }[];
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]?.message).toBeTruthy();
      }
    });

    it('preserves the ZodError as cause on brand rejection for --debug surfacing', () => {
      try {
        parseBrandedListArg('abc', WorkspaceIdSchema, {
          flagName: '--workspace',
          entryDescription: 'numeric workspace ID',
          hint: 'workspace IDs are numeric (e.g. 12345)',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).cause).toBeDefined();
        // ZodError instance check via shape rather than constructor
        // (avoids importing the zod ZodError type just for this).
        const cause = (err as UsageError).cause as { issues?: readonly unknown[] };
        expect(Array.isArray(cause.issues)).toBe(true);
      }
    });

    it('uses the flagName + entryDescription in the per-entry message verbatim', () => {
      try {
        parseBrandedListArg('xyz', UserIdSchema, {
          flagName: '--users',
          entryDescription: 'numeric user ID',
          hint: 'user IDs are numeric (e.g. 12345)',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toMatch(
          /--users entry "xyz" is not a numeric user ID/u,
        );
      }
    });

    it('serialises non-empty issue paths via the inner map callback', () => {
      // Branded numeric schemas surface zod issues with `path: []`,
      // which leaves the inner `.map((p) => String(p))` callback
      // uncovered. A schema whose validation issue carries a non-
      // empty path covers the callback explicitly.
      const NestedBrand = z
        .preprocess(
          (raw) =>
            typeof raw === 'string' ? { nested: { id: raw } } : raw,
          z.object({
            nested: z.object({
              id: z.string().regex(/^\d+$/u, 'expected numeric id'),
            }),
          }),
        )
        .brand<'NestedBrand'>();
      try {
        parseBrandedListArg('abc', NestedBrand, {
          flagName: '--nested',
          entryDescription: 'nested numeric token',
          hint: 'nested IDs are numeric',
        });
        expect.fail('expected throw');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        const issues = detail.issues as readonly { path: string; message: string }[];
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]?.path).toBe('nested.id');
      }
    });
  });
});
