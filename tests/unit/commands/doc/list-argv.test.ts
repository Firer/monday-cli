/**
 * Argv parser unit tests for `src/commands/doc/list.ts` v0.4-M32
 * pre-flight surface (cli-design §4.3 DOC section + §13 v0.4 entry).
 *
 * Test matrix scope: schema-level parse-boundary surface +
 * `parseWorkspaceListArg` comma-split helper. Combination-rule
 * rejections beyond the argv layer (Monday-side empty-result for
 * inaccessible workspace IDs; wire-side limit enforcement) live
 * downstream of `parseArgv` and are exercised via integration tests
 * once the runtime body lands at M32 IMPL.
 *
 * The schema is the contract surface; agents key off the
 * `usage_error.details.issues` + `details.argv_value` /
 * `details.hint` shape.
 */
import { describe, expect, it } from 'vitest';
import { docListCommand, _internals } from '../../../../src/commands/doc/list.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

describe('docListCommand.inputSchema (M32 doc-list argv)', () => {
  describe('happy paths', () => {
    it('parses an empty argv (all flags optional)', () => {
      const parsed = parseArgv(docListCommand.inputSchema, {});
      expect(parsed.workspace).toBeUndefined();
      expect(parsed.orderBy).toBeUndefined();
      expect(parsed.limit).toBeUndefined();
      expect(parsed.page).toBeUndefined();
    });

    it('accepts every documented optional flag together', () => {
      const parsed = parseArgv(docListCommand.inputSchema, {
        workspace: '12345,67890',
        orderBy: 'used_at',
        limit: 50,
        page: 2,
      });
      expect(parsed.workspace).toBe('12345,67890');
      expect(parsed.orderBy).toBe('used_at');
      expect(parsed.limit).toBe(50);
      expect(parsed.page).toBe(2);
    });

    it('accepts limit at the floor (1)', () => {
      const parsed = parseArgv(docListCommand.inputSchema, { limit: 1 });
      expect(parsed.limit).toBe(1);
    });

    it('accepts limit at the ceiling (100)', () => {
      const parsed = parseArgv(docListCommand.inputSchema, { limit: 100 });
      expect(parsed.limit).toBe(100);
    });

    it('accepts orderBy=created_at', () => {
      const parsed = parseArgv(docListCommand.inputSchema, {
        orderBy: 'created_at',
      });
      expect(parsed.orderBy).toBe('created_at');
    });
  });

  describe('schema-level rejections', () => {
    it('rejects orderBy with an unknown value', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { orderBy: 'updated_at' }),
      ).toThrow(UsageError);
    });

    it('rejects limit below the floor (0)', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { limit: 0 }),
      ).toThrow(/--limit must be at least 1/u);
    });

    it('rejects limit above the ceiling (101)', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { limit: 101 }),
      ).toThrow(/--limit must be at most 100/u);
    });

    it('rejects a non-integer limit (NaN from commander parseInt failure)', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { limit: Number.NaN }),
      ).toThrow(UsageError);
    });

    it('rejects a non-integer limit (fractional)', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { limit: 25.5 }),
      ).toThrow(/--limit must be an integer/u);
    });

    it('rejects page below 1', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { page: 0 }),
      ).toThrow(/--page is 1-based/u);
    });

    it('rejects a non-integer page', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { page: 1.5 }),
      ).toThrow(/--page must be an integer/u);
    });

    it('rejects an empty workspace string', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, { workspace: '' }),
      ).toThrow(/--workspace must not be empty/u);
    });

    it('rejects unknown keys (strict schema)', () => {
      expect(() =>
        parseArgv(docListCommand.inputSchema, {
          workspace: '123',
          // @ts-expect-error — testing strict-mode rejection
          unknownFlag: 'oops',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('command module metadata', () => {
    it('declares the canonical command name', () => {
      expect(docListCommand.name).toBe('doc.list');
    });

    it('marks itself idempotent (pure read)', () => {
      expect(docListCommand.idempotent).toBe(true);
    });

    it('ships at least one example', () => {
      expect(docListCommand.examples.length).toBeGreaterThan(0);
    });
  });
});

describe('_internals.parseWorkspaceListArg (--workspace comma-split)', () => {
  describe('happy paths', () => {
    it('splits a single numeric id', () => {
      expect(_internals.parseWorkspaceListArg('12345')).toEqual(['12345']);
    });

    it('splits two numeric ids', () => {
      expect(_internals.parseWorkspaceListArg('12345,67890')).toEqual([
        '12345',
        '67890',
      ]);
    });

    it('trims whitespace around commas', () => {
      expect(_internals.parseWorkspaceListArg('12345 , 67890')).toEqual([
        '12345',
        '67890',
      ]);
    });
  });

  describe('rejections', () => {
    it('rejects a trailing comma (empty entry at end)', () => {
      expect(() => _internals.parseWorkspaceListArg('12345,')).toThrow(
        /empty entry/u,
      );
    });

    it('rejects a leading comma (empty entry at start)', () => {
      expect(() => _internals.parseWorkspaceListArg(',12345')).toThrow(
        /empty entry/u,
      );
    });

    it('rejects a double comma (empty entry in middle)', () => {
      expect(() =>
        _internals.parseWorkspaceListArg('12345,,67890'),
      ).toThrow(/empty entry/u);
    });

    it('rejects a non-numeric entry', () => {
      expect(() =>
        _internals.parseWorkspaceListArg('abc'),
      ).toThrow(/not a numeric workspace ID/u);
    });

    it('rejects a mixed numeric + non-numeric list (per-entry validation)', () => {
      expect(() =>
        _internals.parseWorkspaceListArg('12345,abc'),
      ).toThrow(/not a numeric workspace ID/u);
    });

    it('surfaces the argv_value on rejection for agent debugging', () => {
      try {
        _internals.parseWorkspaceListArg('12345,abc');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const detail = (err as UsageError).details as Record<string, unknown>;
        expect(detail.argv_value).toBe('12345,abc');
      }
    });
  });
});
