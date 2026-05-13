/**
 * Argv parser unit tests for `src/commands/update/upload.ts` v0.4-M31
 * pre-flight surface.
 *
 * Test matrix scope: schema-level parse-boundary surface ONLY —
 * `UpdateIdSchema` (numeric ID brand) + non-empty file path. The
 * `add_file_to_update` mutation carries no column-id, so the schema
 * is simpler than `item upload`'s — but the file-path validation +
 * brand-id surface is identical so the matrix stays parallel.
 */
import { describe, expect, it } from 'vitest';
import { updateUploadCommand } from '../../../../src/commands/update/upload.js';
import { UsageError } from '../../../../src/utils/errors.js';
import { parseArgv } from '../../../../src/commands/parse-argv.js';

const VALID_UID = '987654321';

describe('updateUploadCommand.inputSchema (M31 asset-upload argv)', () => {
  describe('happy paths', () => {
    it('parses a numeric uid + relative file path', () => {
      const parsed = parseArgv(updateUploadCommand.inputSchema, {
        updateId: VALID_UID,
        file: './screenshot.png',
      });
      expect(parsed.updateId).toBe(VALID_UID);
      expect(parsed.file).toBe('./screenshot.png');
    });

    it('accepts an absolute file path', () => {
      const parsed = parseArgv(updateUploadCommand.inputSchema, {
        updateId: VALID_UID,
        file: '/tmp/upload.bin',
      });
      expect(parsed.file).toBe('/tmp/upload.bin');
    });
  });

  describe('rejections', () => {
    it('rejects a non-numeric updateId', () => {
      expect(() =>
        parseArgv(updateUploadCommand.inputSchema, {
          updateId: 'not-numeric',
          file: './a.png',
        }),
      ).toThrow(UsageError);
    });

    it('rejects an empty updateId', () => {
      expect(() =>
        parseArgv(updateUploadCommand.inputSchema, {
          updateId: '',
          file: './a.png',
        }),
      ).toThrow(UsageError);
    });

    it('rejects an empty file path', () => {
      expect(() =>
        parseArgv(updateUploadCommand.inputSchema, {
          updateId: VALID_UID,
          file: '',
        }),
      ).toThrow(UsageError);
    });

    it('surfaces the stdin-not-supported hint on empty file path', () => {
      try {
        parseArgv(updateUploadCommand.inputSchema, {
          updateId: VALID_UID,
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
        parseArgv(updateUploadCommand.inputSchema, {
          updateId: VALID_UID,
          file: './a.png',
          rogueExtraKey: 'nope',
        }),
      ).toThrow(UsageError);
    });
  });
});
