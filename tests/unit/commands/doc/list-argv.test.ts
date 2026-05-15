/**
 * Argv parser unit tests for `src/commands/doc/list.ts` v0.4-M32
 * pre-flight surface (cli-design §4.3 DOC section + §13 v0.4 entry).
 *
 * Test matrix scope: schema-level parse-boundary surface +
 * `parseStrictDecimal` commander-coercer. The `--workspace` comma-
 * split helper migrated to the lifted {@link parseBrandedListArg}
 * helper at the M34 pre-flight kickoff (R-NEW-70 4-consumer lift);
 * generic split / trim / empty-entry / brand-rejection behaviour is
 * pinned at `tests/unit/utils/parse-brand-list.test.ts`. The
 * `--workspace`-specific user-facing message shape (verb name,
 * entryDescription, hint, emptyEntryHint) is exercised here via the
 * end-to-end `parseArgv` + action body once integration tests cover
 * the runtime body at M32 IMPL — argv-only tests don't traverse the
 * action body.
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

describe('_internals.parseStrictDecimal (--limit / --page commander coercer)', () => {
  describe('happy paths', () => {
    it('parses a single-digit decimal', () => {
      expect(_internals.parseStrictDecimal('1')).toBe(1);
    });

    it('parses a multi-digit decimal', () => {
      expect(_internals.parseStrictDecimal('100')).toBe(100);
    });

    it('parses 0 (range floor enforced by schema)', () => {
      expect(_internals.parseStrictDecimal('0')).toBe(0);
    });
  });

  describe('rejections — return NaN so the schema layer rejects', () => {
    it('rejects fractional input (Number.parseInt would silently truncate)', () => {
      expect(_internals.parseStrictDecimal('25.5')).toBeNaN();
    });

    it('rejects trailing garbage (Number.parseInt would silently truncate)', () => {
      expect(_internals.parseStrictDecimal('25abc')).toBeNaN();
    });

    it('rejects leading garbage', () => {
      expect(_internals.parseStrictDecimal('abc25')).toBeNaN();
    });

    it('rejects negative input', () => {
      expect(_internals.parseStrictDecimal('-1')).toBeNaN();
    });

    it('rejects hex input', () => {
      expect(_internals.parseStrictDecimal('0x2a')).toBeNaN();
    });

    it('rejects scientific notation', () => {
      expect(_internals.parseStrictDecimal('1e3')).toBeNaN();
    });

    it('rejects whitespace', () => {
      expect(_internals.parseStrictDecimal('25 ')).toBeNaN();
      expect(_internals.parseStrictDecimal(' 25')).toBeNaN();
    });

    it('rejects empty string', () => {
      expect(_internals.parseStrictDecimal('')).toBeNaN();
    });

    it('rejects leading zeros (Monday IDs + page numbers never carry leading zeros)', () => {
      expect(_internals.parseStrictDecimal('01')).toBeNaN();
      expect(_internals.parseStrictDecimal('007')).toBeNaN();
    });
  });
});
