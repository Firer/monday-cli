import { mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteSecureFile, isENOENT } from '../../../src/utils/fs.js';

describe('isENOENT', () => {
  it('returns true for a Node Error with code "ENOENT"', () => {
    const err = Object.assign(new Error('file not found'), {
      code: 'ENOENT',
    });
    expect(isENOENT(err)).toBe(true);
  });

  it('returns false for a Node Error with a different code', () => {
    const err = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    expect(isENOENT(err)).toBe(false);
  });

  it('returns false for a plain Error without a `code` property', () => {
    expect(isENOENT(new Error('something else'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isENOENT(null)).toBe(false);
  });

  it('returns false for a non-object value (string)', () => {
    expect(isENOENT('ENOENT')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isENOENT(undefined)).toBe(false);
  });

  it('treats a plain object literal with code:"ENOENT" as ENOENT', () => {
    // The helper checks the shape, not the prototype — a fixture
    // that hand-shapes an object with code:"ENOENT" still matches.
    expect(isENOENT({ code: 'ENOENT' })).toBe(true);
  });
});

describe('atomicWriteSecureFile', () => {
  let dir: string;
  const neverCalled = (): Error => {
    throw new Error('wrapError must not run on the success path');
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'monday-cli-atomic-write-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the payload to the final path and leaves no tmp sibling', async () => {
    const fullPath = join(dir, 'secret.toml');
    await atomicWriteSecureFile({
      fullPath,
      payload: 'token = "abc"\n',
      mode: 0o600,
      wrapError: neverCalled,
    });

    expect(await readFile(fullPath, 'utf8')).toBe('token = "abc"\n');
    // rename consumed the tmp sibling — only the final file remains.
    expect(await readdir(dir)).toEqual(['secret.toml']);
  });

  it('applies mode 0o600 to the written file (umask-proof via chmod)', async () => {
    const fullPath = join(dir, 'creds.json');
    await atomicWriteSecureFile({
      fullPath,
      payload: '{}',
      mode: 0o600,
      wrapError: neverCalled,
    });

    const { mode } = await stat(fullPath);
    expect(mode & 0o777).toBe(0o600);
  });

  it('wraps the failure, cleans up the tmp file, and never leaves a partial write', async () => {
    // Parent directory does not exist → writeFile of the tmp sibling
    // rejects → the catch runs (best-effort unlink of the never-
    // created tmp swallows its own ENOENT) → wrapError maps it.
    const missingDir = join(dir, 'definitely-not-created');
    const fullPath = join(missingDir, 'out.txt');
    let wrappedCause: unknown;

    await expect(
      atomicWriteSecureFile({
        fullPath,
        payload: 'data',
        mode: 0o600,
        wrapError: (err) => {
          wrappedCause = err;
          return new TypeError('wrapped: write failed');
        },
      }),
    ).rejects.toThrow(/wrapped: write failed/u);

    // wrapError received the raw fs error, not a re-shaped one.
    expect(wrappedCause).toBeInstanceOf(Error);
    expect((wrappedCause as NodeJS.ErrnoException).code).toBe('ENOENT');
    // No tmp artefact escaped into the writable parent dir.
    expect(await readdir(dir)).toEqual([]);
  });

  it('cleans up the tmp sibling when the rename fails after it is written', async () => {
    // `fullPath` is an existing directory, so the tmp sibling is
    // written + chmod'd successfully, then `rename(tmp, dir)` fails
    // (EISDIR). This is the only path that proves the catch's
    // `unlink(tmpPath)` actually removes a tmp that WAS created —
    // the missing-parent-dir case above never creates one.
    const fullPath = join(dir, 'a-directory');
    await mkdir(fullPath);
    let wrappedCause: unknown;

    await expect(
      atomicWriteSecureFile({
        fullPath,
        payload: 'data',
        mode: 0o600,
        wrapError: (err) => {
          wrappedCause = err;
          return new TypeError('wrapped: rename failed');
        },
      }),
    ).rejects.toThrow(/wrapped: rename failed/u);

    expect(wrappedCause).toBeInstanceOf(Error);
    // The tmp sibling the helper wrote was unlinked — only the
    // pre-existing directory remains, no `.tmp` leftover.
    expect(await readdir(dir)).toEqual(['a-directory']);
  });
});
