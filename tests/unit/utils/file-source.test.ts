/**
 * Unit tests for `src/utils/file-source.ts` (R-v0.6-NEW-1 lift,
 * v0.6-M38 IMPL kickoff — ahead-of-feat per R-NEW-29 M25 + R-NEW-70
 * M34 cadence; v0.6-plan §22 R-v0.6-NEW-1 entry).
 *
 * `precheckLocalFile` + `buildBlobFromPath` are exercised indirectly
 * across 3 consumer sites post-lift: M31 `monday item upload`, M31
 * `monday update upload`, M38 `executeFileColumnSet`. The direct
 * tests below pin the branch matrix (happy path / not-a-file /
 * ENOENT / EACCES / empty / Blob sniff content-type) so a future
 * refactor that accidentally drifts the helper's contract surfaces
 * inline rather than only via the consumer integration tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildBlobFromPath,
  precheckLocalFile,
  isStdinFileSetSource,
  resolveStdinFilename,
  readStdinFileSource,
  STDIN_FILE_SENTINEL,
  DEFAULT_STDIN_FILENAME,
} from '../../../src/utils/file-source.js';
import { ApiError, UsageError } from '../../../src/utils/errors.js';

describe('precheckLocalFile (R-v0.6-NEW-1 lift)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-file-source-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('returns filePath / filename / fileSizeBytes for a regular non-empty file', async () => {
    const filePath = join(tmpRoot, 'sample.txt');
    await writeFile(filePath, 'hello world', 'utf8');

    const result = await precheckLocalFile(filePath);

    expect(result.filePath).toBe(filePath);
    expect(result.filename).toBe('sample.txt');
    expect(result.fileSizeBytes).toBe(11);
  });

  it('resolves a relative path against process.cwd()', async () => {
    const filePath = join(tmpRoot, 'rel.txt');
    await writeFile(filePath, 'x', 'utf8');
    const originalCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      const result = await precheckLocalFile('rel.txt');
      expect(result.filePath).toBe(filePath);
      expect(result.filename).toBe('rel.txt');
      expect(result.fileSizeBytes).toBe(1);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("rejects a directory with usage_error details.reason 'file_not_readable'", async () => {
    try {
      await precheckLocalFile(tmpRoot);
      throw new Error('expected UsageError');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(ue.details?.reason).toBe('file_not_readable');
      expect(ue.message).toContain('is not a regular file');
    }
  });

  it("rejects ENOENT with usage_error + errno_code 'ENOENT'", async () => {
    const missing = join(tmpRoot, 'missing.txt');
    try {
      await precheckLocalFile(missing);
      throw new Error('expected UsageError');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(ue.details?.reason).toBe('file_not_readable');
      expect(ue.details?.errno_code).toBe('ENOENT');
      expect(ue.details?.file_path).toBe(missing);
    }
  });

  it("rejects a zero-byte file with usage_error details.reason 'file_empty'", async () => {
    const empty = join(tmpRoot, 'empty.txt');
    await writeFile(empty, '', 'utf8');
    try {
      await precheckLocalFile(empty);
      throw new Error('expected UsageError');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(ue.details?.reason).toBe('file_empty');
      expect(ue.details?.file_size_bytes).toBe(0);
      expect(ue.details?.filename).toBe('empty.txt');
    }
  });

  it('rejects an EACCES-mode file with file_not_readable + errno_code EACCES', async () => {
    // Skip on Windows / when running as root — chmod 0 doesn't deny
    // root, and POSIX mode semantics don't apply on win32.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return;
    }
    const restricted = join(tmpRoot, 'restricted.txt');
    await writeFile(restricted, 'private', 'utf8');
    await chmod(restricted, 0o000);
    try {
      await precheckLocalFile(restricted);
      throw new Error('expected UsageError');
    } catch (err) {
      // Restore permissions before assertions so afterEach can rm.
      await chmod(restricted, 0o600);
      expect(err).toBeInstanceOf(UsageError);
      const ue = err as UsageError;
      expect(ue.details?.reason).toBe('file_not_readable');
      expect(ue.details?.errno_code).toBe('EACCES');
    }
  });
});

describe('buildBlobFromPath (R-v0.6-NEW-1 lift)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'monday-cli-file-source-blob-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('reads file bytes into a Blob with size matching fileSizeBytes', async () => {
    const filePath = join(tmpRoot, 'report.pdf');
    const bytes = Buffer.from('PDF-bytes-fixture');
    await writeFile(filePath, bytes);

    const blob = await buildBlobFromPath({
      filePath,
      filename: 'report.pdf',
      fileSizeBytes: bytes.byteLength,
    });

    expect(blob.size).toBe(bytes.byteLength);
  });

  it('sniffs PDF content-type from a `.pdf` filename extension', async () => {
    const filePath = join(tmpRoot, 'doc.pdf');
    await writeFile(filePath, 'x', 'utf8');

    const blob = await buildBlobFromPath({
      filePath,
      filename: 'doc.pdf',
      fileSizeBytes: 1,
    });

    expect(blob.type).toBe('application/pdf');
  });

  it('sniffs PNG content-type from a `.png` filename extension', async () => {
    const filePath = join(tmpRoot, 'screenshot.png');
    await writeFile(filePath, 'x', 'utf8');

    const blob = await buildBlobFromPath({
      filePath,
      filename: 'screenshot.png',
      fileSizeBytes: 1,
    });

    expect(blob.type).toBe('image/png');
  });

  it('falls back to application/octet-stream for unknown extensions', async () => {
    const filePath = join(tmpRoot, 'mystery.bin');
    await writeFile(filePath, 'x', 'utf8');

    const blob = await buildBlobFromPath({
      filePath,
      filename: 'mystery.bin',
      fileSizeBytes: 1,
    });

    expect(blob.type).toBe('application/octet-stream');
  });
});

describe('isStdinFileSetSource (v0.8-M47 stdin sentinel detector)', () => {
  it('is true for the bare `-` sentinel', () => {
    expect(isStdinFileSetSource(STDIN_FILE_SENTINEL)).toBe(true);
    expect(isStdinFileSetSource('-')).toBe(true);
  });

  it('is false for a path, an empty string, and `--` (only exactly `-` selects stdin)', () => {
    expect(isStdinFileSetSource('./report.pdf')).toBe(false);
    expect(isStdinFileSetSource('')).toBe(false);
    expect(isStdinFileSetSource('--')).toBe(false);
    expect(isStdinFileSetSource('-x')).toBe(false);
  });
});

describe('resolveStdinFilename (v0.8-M47 --filename default)', () => {
  it('returns the provided --filename verbatim when present', () => {
    expect(resolveStdinFilename('report.pdf')).toBe('report.pdf');
  });

  it('falls back to DEFAULT_STDIN_FILENAME ("blob") when --filename is absent', () => {
    expect(resolveStdinFilename(undefined)).toBe(DEFAULT_STDIN_FILENAME);
    expect(DEFAULT_STDIN_FILENAME).toBe('blob');
  });
});

describe('readStdinFileSource (v0.8-M47 pre-flight stub)', () => {
  it('throws internal_error with details.reason m47_preflight_stub (runtime body lands at M47 IMPL)', async () => {
    // The argv + --filename + routing + scope-enforcement surface is
    // the shipped pre-flight contract; the stdin read + Blob leg is
    // stubbed. Regression-pins the surface without consuming stdin.
    await expect(readStdinFileSource('blob')).rejects.toBeInstanceOf(ApiError);
    try {
      await readStdinFileSource('report.pdf');
      throw new Error('expected ApiError');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
      expect(ae.details?.reason).toBe('m47_preflight_stub');
      expect(ae.details?.filename).toBe('report.pdf');
    }
  });
});
