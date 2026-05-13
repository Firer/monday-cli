/**
 * Argv parser unit tests for `src/commands/item/update.ts` v0.4-M30
 * `--concurrency <N>` slot extension to the M25 partial-success bulk
 * surface (cli-design §6.4 "Bulk per-item partial-success — Parallel
 * dispatch" + §9.3).
 *
 * Test matrix scope: schema-level parse-boundary surface ONLY —
 * `z.coerce.number()` + `.int()` + `.min(MIN_CONCURRENCY)` +
 * `.max(MAX_CONCURRENCY)` + `.optional()`. The combination-rule
 * rejection paths (`--concurrency` requires `--continue-on-error`;
 * `--concurrency` rejected on single-item shape) live in
 * `validateInputShape` and are exercised via integration tests at
 * `tests/integration/commands/item-update-bulk.test.ts` because they
 * depend on the bulk-vs-single-item shape discrimination that
 * `parseArgv` itself doesn't perform.
 *
 * The existing v0.3-M25 `--continue-on-error` argv slot is also
 * covered here — the M30 pre-flight is the first session that adds a
 * dedicated unit argv test for `item update`; prior milestones leaned
 * on the integration test surface alone.
 *
 * The schema is the contract surface; agents key off the
 * `usage_error.details.issues` shape. The action body's runtime
 * routing between sequential / parallel dispatch is v0.4-M30 IMPL's
 * concern.
 */
import { describe, expect, it } from 'vitest';
import { itemUpdateCommand } from '../../../src/commands/item/update.js';
import { UsageError } from '../../../src/utils/errors.js';
import { parseArgv } from '../../../src/commands/parse-argv.js';

const VALID_IID = '1234567890';
const VALID_BID = '9876543210';

describe('itemUpdateCommand.inputSchema (M30 --concurrency argv)', () => {
  describe('happy paths', () => {
    it('parses `--concurrency 8` on the bulk + continue-on-error shape', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        continueOnError: true,
        concurrency: '8',
      });
      expect(parsed.concurrency).toBe(8);
      expect(parsed.continueOnError).toBe(true);
    });

    it('parses `--concurrency 1` (sequential no-op) on the bulk shape', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        continueOnError: true,
        concurrency: '1',
      });
      expect(parsed.concurrency).toBe(1);
    });

    it('parses absent `--concurrency` as undefined (default sequential)', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        continueOnError: true,
      });
      expect(parsed.concurrency).toBeUndefined();
    });

    it('coerces the documented ceiling (MAX_CONCURRENCY = 32)', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        continueOnError: true,
        concurrency: '32',
      });
      expect(parsed.concurrency).toBe(32);
    });
  });

  describe('range enforcement', () => {
    it('rejects `--concurrency 0` (below MIN_CONCURRENCY)', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '0',
        }),
      ).toThrow(UsageError);
    });

    it('rejects negative values', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '-1',
        }),
      ).toThrow(UsageError);
    });

    it('rejects `--concurrency 33` (above MAX_CONCURRENCY)', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '33',
        }),
      ).toThrow(UsageError);
    });

    it('rejects non-integer (1.5)', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '1.5',
        }),
      ).toThrow(UsageError);
    });

    it('rejects non-numeric strings (`--concurrency abc`)', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: 'abc',
        }),
      ).toThrow(UsageError);
    });

    it('rejects empty string', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '',
        }),
      ).toThrow(UsageError);
    });

    it('rejects floating-point at the ceiling boundary (32.5)', () => {
      expect(() =>
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '32.5',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('issue path discrimination', () => {
    it('surfaces `concurrency` in the issue path for an out-of-range value', () => {
      try {
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '100',
        });
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UsageError);
        const usageErr = err as UsageError;
        const issues = usageErr.details?.issues as
          | readonly { readonly path: readonly (string | number)[] }[]
          | undefined;
        expect(issues).toBeDefined();
        expect(issues?.some((i) => i.path.includes('concurrency'))).toBe(true);
      }
    });

    it('surfaces `concurrency` in the issue path for a non-integer value', () => {
      try {
        parseArgv(itemUpdateCommand.inputSchema, {
          board: VALID_BID,
          where: ['status=Backlog'],
          set: ['status=Working'],
          continueOnError: true,
          concurrency: '1.5',
        });
        expect.fail('should have thrown');
      } catch (err: unknown) {
        expect(err).toBeInstanceOf(UsageError);
        const usageErr = err as UsageError;
        const issues = usageErr.details?.issues as
          | readonly { readonly path: readonly (string | number)[] }[]
          | undefined;
        expect(issues).toBeDefined();
        expect(issues?.some((i) => i.path.includes('concurrency'))).toBe(true);
      }
    });
  });

  describe('orthogonality with existing argv slots', () => {
    it('accepts `--concurrency` alongside `--filter-json` (bulk via JSON shape)', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        filterJson: '{"rules":[]}',
        set: ['status=Working'],
        continueOnError: true,
        concurrency: '4',
      });
      expect(parsed.concurrency).toBe(4);
      expect(parsed.filterJson).toBe('{"rules":[]}');
    });

    it('accepts `--concurrency` alongside `--create-labels-if-missing`', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        continueOnError: true,
        concurrency: '4',
        createLabelsIfMissing: true,
      });
      expect(parsed.concurrency).toBe(4);
      expect(parsed.createLabelsIfMissing).toBe(true);
    });

    it('accepts `--concurrency` alongside multiple `--set` clauses', () => {
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working', 'owner=alice@example.test'],
        continueOnError: true,
        concurrency: '4',
      });
      expect(parsed.concurrency).toBe(4);
      expect(parsed.set.length).toBe(2);
    });

    it('schema-side parse permits `--concurrency` without `--continue-on-error` (validateInputShape rejects later)', () => {
      // The schema itself accepts the combination; the validateInputShape
      // imperative check is what rejects `--concurrency` without
      // `--continue-on-error`. This test documents the layering: the
      // schema is the parse-boundary surface, and the combination-rule
      // rejection fires at a downstream validation step. Integration
      // tests at `tests/integration/commands/item-update-bulk.test.ts`
      // cover the downstream rejection envelope shape.
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        board: VALID_BID,
        where: ['status=Backlog'],
        set: ['status=Working'],
        concurrency: '4',
      });
      expect(parsed.concurrency).toBe(4);
      expect(parsed.continueOnError).toBeUndefined();
    });

    it('schema-side parse permits `--concurrency` with single-item shape (validateInputShape rejects later)', () => {
      // Same layering as the previous test: the schema accepts the
      // combination; the bulk-vs-single-item discrimination happens at
      // validateInputShape, not at parse time. The schema-level
      // `--concurrency` slot is shape-agnostic.
      const parsed = parseArgv(itemUpdateCommand.inputSchema, {
        itemId: VALID_IID,
        set: ['status=Working'],
        concurrency: '4',
      });
      expect(parsed.concurrency).toBe(4);
      expect(parsed.itemId).toBe(VALID_IID);
    });
  });
});
