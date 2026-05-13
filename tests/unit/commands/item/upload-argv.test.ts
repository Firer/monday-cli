/**
 * Argv parser unit tests for `src/commands/item/upload.ts` v0.4-M31
 * pre-flight surface (cli-design §4.3 + §6.4 asset-upload sub-section +
 * §13 v0.4 entry).
 *
 * Test matrix scope: schema-level parse-boundary surface ONLY —
 * `ItemIdSchema` (numeric ID brand) + `ColumnIdSchema` (slug brand) +
 * non-empty file path. Combination-rule rejections (column resolves
 * to non-`file` type; file path doesn't exist on disk) live downstream
 * of `parseArgv` (column-resolution layer at IMPL; `fs.stat` at the
 * action body) and are exercised via integration tests once the
 * runtime body lands.
 *
 * The schema is the contract surface; agents key off the
 * `usage_error.details.issues` shape. The action body's runtime
 * dispatch + multipart wire shape is v0.4-M31 IMPL's concern.
 */
import { describe, expect, it } from 'vitest';
import { itemUploadCommand } from '../../../../src/commands/item/upload.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

const VALID_IID = '1234567890';

describe('itemUploadCommand.inputSchema (M31 asset-upload argv)', () => {
  describe('happy paths', () => {
    it('parses a numeric iid + slug column + relative file path', () => {
      const parsed = parseArgv(itemUploadCommand.inputSchema, {
        itemId: VALID_IID,
        column: 'files',
        file: './screenshot.png',
      });
      expect(parsed.itemId).toBe(VALID_IID);
      expect(parsed.column).toBe('files');
      expect(parsed.file).toBe('./screenshot.png');
    });

    it('accepts column tokens with digits + underscores (slug shape)', () => {
      const parsed = parseArgv(itemUploadCommand.inputSchema, {
        itemId: VALID_IID,
        column: 'attachments_3',
        file: 'report.pdf',
      });
      expect(parsed.column).toBe('attachments_3');
    });

    it('accepts an absolute file path', () => {
      const parsed = parseArgv(itemUploadCommand.inputSchema, {
        itemId: VALID_IID,
        column: 'files',
        file: '/tmp/upload.bin',
      });
      expect(parsed.file).toBe('/tmp/upload.bin');
    });
  });

  describe('rejections', () => {
    it('rejects a non-numeric itemId', () => {
      expect(() =>
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: 'not-numeric',
          column: 'files',
          file: './a.png',
        }),
      ).toThrow(UsageError);
    });

    it('rejects an empty itemId', () => {
      expect(() =>
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: '',
          column: 'files',
          file: './a.png',
        }),
      ).toThrow(UsageError);
    });

    it('rejects an empty column', () => {
      expect(() =>
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: VALID_IID,
          column: '',
          file: './a.png',
        }),
      ).toThrow(UsageError);
    });

    it('rejects an empty file path', () => {
      expect(() =>
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: VALID_IID,
          column: 'files',
          file: '',
        }),
      ).toThrow(UsageError);
    });

    it('surfaces the stdin-not-supported hint on empty file path', () => {
      try {
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: VALID_IID,
          column: 'files',
          file: '',
        });
        throw new Error('expected UsageError');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        const ue = err as UsageError;
        const issuesUnknown = (ue.details as { issues?: unknown }).issues;
        expect(Array.isArray(issuesUnknown)).toBe(true);
        const messages = (issuesUnknown as { message: string }[]).map(
          (i) => i.message,
        );
        expect(messages.some((m) => m.includes('stdin'))).toBe(true);
      }
    });

    it('rejects unknown extra keys (strict schema)', () => {
      expect(() =>
        parseArgv(itemUploadCommand.inputSchema, {
          itemId: VALID_IID,
          column: 'files',
          file: './a.png',
          rogueExtraKey: 'nope',
        }),
      ).toThrow(UsageError);
    });
  });
});
