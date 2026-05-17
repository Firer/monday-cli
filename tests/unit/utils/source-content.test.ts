/**
 * Unit tests for `src/utils/source-content.ts` (R-v0.5-NEW-18 lift,
 * v0.5-M37 IMPL kickoff — ahead-of-feat per R-NEW-29 M25 + R-NEW-70
 * M34 cadence; v0.5-plan §22 R-v0.5-NEW-18 entry).
 *
 * `readSourceContent` is exercised indirectly across 5 consumer sites
 * post-lift: `update create / reply / edit` (M13) + `doc import-html /
 * append-markdown` (M37 IMPL). The direct tests below pin the branch
 * matrix (mutex / neither / inline trim / inline returned verbatim /
 * file read / stdin / file read failure / empty after trim / size
 * guard at file + stdin + inline / trimTrailingWhitespace override /
 * verbHint default vs override) so a future refactor that accidentally
 * drifts the helper's contract surfaces inline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { readSourceContent } from '../../../src/utils/source-content.js';
import { UsageError } from '../../../src/utils/errors.js';

const baseInputs = {
  inlineFlagName: '--body',
  fileFlagName: '--body-file',
};

const makeStdin = (chunks: readonly string[]): NodeJS.ReadableStream =>
  Readable.from(chunks.map((c) => Buffer.from(c, 'utf8')));

describe('readSourceContent (R-v0.5-NEW-18 lift)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-source-content-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('inline source', () => {
    it('returns inline content verbatim', async () => {
      const out = await readSourceContent({
        ...baseInputs,
        inline: 'hello world',
        file: undefined,
        stdin: undefined,
      });
      expect(out).toBe('hello world');
    });

    it('preserves trailing whitespace on the inline path', async () => {
      // Inline-string flags pass content verbatim; only file / stdin
      // paths trim trailing whitespace (a `cat foo.md` adds one).
      const out = await readSourceContent({
        ...baseInputs,
        inline: 'hello\n\n',
        file: undefined,
        stdin: undefined,
      });
      expect(out).toBe('hello\n\n');
    });

    it('rejects whitespace-only inline content as usage_error', async () => {
      await expect(
        readSourceContent({
          ...baseInputs,
          inline: '   \n\t',
          file: undefined,
          stdin: undefined,
        }),
      ).rejects.toBeInstanceOf(UsageError);
    });

    it('rejects an empty-string inline as usage_error with a flag-name message', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inline: '',
          file: undefined,
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('--body');
        expect((err as UsageError).message).toContain('empty');
      }
    });
  });

  describe('file source', () => {
    it('reads file content trimmed of trailing whitespace by default', async () => {
      const path = join(tmpRoot, 'foo.md');
      await writeFile(path, 'hello\n\n', 'utf8');
      const out = await readSourceContent({
        ...baseInputs,
        inline: undefined,
        file: path,
        stdin: undefined,
      });
      expect(out).toBe('hello');
    });

    it('preserves trailing whitespace when trimTrailingWhitespace is false', async () => {
      const path = join(tmpRoot, 'foo.md');
      await writeFile(path, 'hello\n\n', 'utf8');
      const out = await readSourceContent({
        ...baseInputs,
        inline: undefined,
        file: path,
        stdin: undefined,
        trimTrailingWhitespace: false,
      });
      expect(out).toBe('hello\n\n');
    });

    it('rejects a missing file as usage_error wrapping the fs error', async () => {
      const path = join(tmpRoot, 'does-not-exist.md');
      try {
        await readSourceContent({
          ...baseInputs,
          inline: undefined,
          file: path,
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('--body-file');
        expect((err as UsageError).message).toContain('failed to read');
        expect((err as UsageError).details).toMatchObject({
          file_path: path,
        });
        expect((err as UsageError).cause).toBeDefined();
      }
    });

    it('rejects an empty file (after trim) as usage_error', async () => {
      const path = join(tmpRoot, 'empty.md');
      await writeFile(path, '   \n\n', 'utf8');
      try {
        await readSourceContent({
          ...baseInputs,
          inline: undefined,
          file: path,
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('empty');
        expect((err as UsageError).details).toMatchObject({
          file_path: path,
        });
      }
    });
  });

  describe('stdin source (file === "-")', () => {
    it('reads stdin to EOF and trims trailing whitespace', async () => {
      const out = await readSourceContent({
        ...baseInputs,
        inline: undefined,
        file: '-',
        stdin: makeStdin(['hello ', 'world\n\n']),
      });
      expect(out).toBe('hello world');
    });

    it('rejects empty stdin as usage_error', async () => {
      const out = readSourceContent({
        ...baseInputs,
        inline: undefined,
        file: '-',
        stdin: makeStdin(['   \n']),
      });
      await expect(out).rejects.toBeInstanceOf(UsageError);
    });

    it('rejects file === "-" without a stdin wire as usage_error (programmer bug)', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inline: undefined,
          file: '-',
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('programmer wiring bug');
      }
    });

    it('preserves trailing whitespace when trimTrailingWhitespace is false', async () => {
      const out = await readSourceContent({
        ...baseInputs,
        inline: undefined,
        file: '-',
        stdin: makeStdin(['hello\n\n']),
        trimTrailingWhitespace: false,
      });
      expect(out).toBe('hello\n\n');
    });
  });

  describe('mutex + neither cases', () => {
    it('rejects both inline + file set with a mutex usage_error', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inline: 'inline content',
          file: '/tmp/x.md',
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('mutually exclusive');
        expect((err as UsageError).message).toContain('--body');
        expect((err as UsageError).message).toContain('--body-file');
      }
    });

    it('rejects neither set with the supplied verbHint', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inline: undefined,
          file: undefined,
          stdin: undefined,
          verbHint: 'monday update create requires either --body or --body-file.',
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain(
          'monday update create requires',
        );
      }
    });

    it('falls back to a generic verbHint computed from flag names when omitted', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inline: undefined,
          file: undefined,
          stdin: undefined,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('--body');
        expect((err as UsageError).message).toContain('--body-file');
      }
    });
  });

  describe('maxBytes size guard', () => {
    it('passes content under the cap on the inline path', async () => {
      const out = await readSourceContent({
        ...baseInputs,
        inline: 'small',
        file: undefined,
        stdin: undefined,
        maxBytes: 100,
      });
      expect(out).toBe('small');
    });

    it('rejects oversized inline as usage_error with source/size/limit details', async () => {
      const big = 'x'.repeat(101);
      try {
        await readSourceContent({
          ...baseInputs,
          inlineFlagName: '--html-string',
          fileFlagName: '--html',
          inline: big,
          file: undefined,
          stdin: undefined,
          maxBytes: 100,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('--html-string');
        expect((err as UsageError).message).toContain('exceeds');
        expect((err as UsageError).details).toMatchObject({
          source: 'inline',
          size_bytes: 101,
          limit_bytes: 100,
        });
      }
    });

    it('rejects oversized file content as usage_error with file_path detail', async () => {
      const path = join(tmpRoot, 'big.md');
      await writeFile(path, 'x'.repeat(101), 'utf8');
      try {
        await readSourceContent({
          ...baseInputs,
          inlineFlagName: '--markdown-string',
          fileFlagName: '--markdown',
          inline: undefined,
          file: path,
          stdin: undefined,
          maxBytes: 100,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).message).toContain('--markdown');
        expect((err as UsageError).details).toMatchObject({
          source: 'file',
          size_bytes: 101,
          limit_bytes: 100,
          file_path: path,
        });
      }
    });

    it('rejects oversized stdin content as usage_error with source: stdin', async () => {
      try {
        await readSourceContent({
          ...baseInputs,
          inlineFlagName: '--markdown-string',
          fileFlagName: '--markdown',
          inline: undefined,
          file: '-',
          stdin: makeStdin(['x'.repeat(101)]),
          maxBytes: 100,
        });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(UsageError);
        expect((err as UsageError).details).toMatchObject({
          source: 'stdin',
          size_bytes: 101,
          limit_bytes: 100,
        });
      }
    });

    it('measures size in UTF-8 bytes, not UTF-16 code units', async () => {
      // 1 emoji = 4 bytes UTF-8. A 26-emoji string is 104 bytes; a
      // 25-emoji string is 100 bytes. Cap at 100 bytes accepts 25
      // and rejects 26.
      const ok = '😀'.repeat(25);
      const tooBig = '😀'.repeat(26);
      await expect(
        readSourceContent({
          ...baseInputs,
          inline: ok,
          file: undefined,
          stdin: undefined,
          maxBytes: 100,
        }),
      ).resolves.toBe(ok);
      await expect(
        readSourceContent({
          ...baseInputs,
          inline: tooBig,
          file: undefined,
          stdin: undefined,
          maxBytes: 100,
        }),
      ).rejects.toBeInstanceOf(UsageError);
    });
  });
});
