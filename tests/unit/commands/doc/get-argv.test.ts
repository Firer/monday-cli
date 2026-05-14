/**
 * Argv parser unit tests for `src/commands/doc/get.ts` v0.4-M32
 * pre-flight surface (cli-design §4.3 DOC section + §13 v0.4 entry).
 *
 * Test matrix scope: schema-level parse-boundary surface only — the
 * `DocIdSchema` numeric-string brand + strict schema rejection of
 * extra keys. Downstream rejections (wire-side `not_found` for
 * non-existent docs) live at the action body and are exercised via
 * integration tests once the runtime body lands at M32 IMPL.
 */
import { describe, expect, it } from 'vitest';
import { docGetCommand } from '../../../../src/commands/doc/get.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

const VALID_DID = '1234567890';

describe('docGetCommand.inputSchema (M32 doc-get argv)', () => {
  describe('happy paths', () => {
    it('parses a numeric doc id', () => {
      const parsed = parseArgv(docGetCommand.inputSchema, { docId: VALID_DID });
      expect(parsed.docId).toBe(VALID_DID);
    });

    it('accepts a single-digit doc id (boundary smoke)', () => {
      const parsed = parseArgv(docGetCommand.inputSchema, { docId: '0' });
      expect(parsed.docId).toBe('0');
    });
  });

  describe('schema-level rejections', () => {
    it('rejects a non-numeric doc id', () => {
      expect(() =>
        parseArgv(docGetCommand.inputSchema, { docId: 'abc' }),
      ).toThrow(UsageError);
    });

    it('rejects an empty doc id', () => {
      expect(() =>
        parseArgv(docGetCommand.inputSchema, { docId: '' }),
      ).toThrow(UsageError);
    });

    it('rejects a negative doc id', () => {
      expect(() =>
        parseArgv(docGetCommand.inputSchema, { docId: '-1' }),
      ).toThrow(UsageError);
    });

    it('rejects a hex doc id', () => {
      expect(() =>
        parseArgv(docGetCommand.inputSchema, { docId: '0x2a' }),
      ).toThrow(UsageError);
    });

    it('rejects a missing docId positional', () => {
      expect(() => parseArgv(docGetCommand.inputSchema, {})).toThrow(
        UsageError,
      );
    });

    it('rejects unknown keys (strict schema)', () => {
      expect(() =>
        parseArgv(docGetCommand.inputSchema, {
          docId: VALID_DID,
          // @ts-expect-error — testing strict-mode rejection
          extra: 'oops',
        }),
      ).toThrow(UsageError);
    });
  });

  describe('command module metadata', () => {
    it('declares the canonical command name', () => {
      expect(docGetCommand.name).toBe('doc.get');
    });

    it('marks itself idempotent (pure read)', () => {
      expect(docGetCommand.idempotent).toBe(true);
    });

    it('ships at least one example', () => {
      expect(docGetCommand.examples.length).toBeGreaterThan(0);
    });
  });
});
