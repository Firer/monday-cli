import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';
import {
  resolveCacheRoot,
  writeEntry,
} from '../../../src/api/cache.js';

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const baseOptions = (
  workDir: string,
  overrides: Partial<RunOptions> = {},
): { options: RunOptions; captured: Captured } => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const options: RunOptions = {
    argv: ['node', 'monday'],
    env: { XDG_CACHE_HOME: workDir, MONDAY_API_TOKEN: 'tok-leakcheck-xxxx' },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-id']),
    clock: () => new Date('2026-04-29T10:00:00Z'),
    ...overrides,
  };

  return {
    options,
    captured: {
      stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    },
  };
};

describe('monday cache list (integration)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cache-cmd-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('emits an empty entries array on a fresh cache', async () => {
    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'list', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as {
      ok: boolean;
      data: {
        root: string;
        entries: unknown[];
        total_entries: number;
        total_bytes: number;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.entries).toEqual([]);
    expect(env.data.total_entries).toBe(0);
    expect(env.data.total_bytes).toBe(0);
    expect(env.data.root).toBe(resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } }));
  });

  it('reports populated entries with kind/id classification', async () => {
    const cacheRoot = resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } });
    await writeEntry(cacheRoot, { kind: 'board', boardId: '12345' }, { v: 1 });
    await writeEntry(cacheRoot, { kind: 'users' }, { v: 2 });

    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'list', '--json'],
    });
    await run(options);

    const env = JSON.parse(captured.stdout()) as {
      data: {
        entries: { kind: string; id: string | null; relative_path: string }[];
        total_entries: number;
      };
    };
    expect(env.data.total_entries).toBe(2);
    expect(env.data.entries.find((e) => e.kind === 'boards')?.id).toBe('12345');
    expect(env.data.entries.find((e) => e.kind === 'users')?.id).toBeNull();
  });
});

describe('monday cache clear (integration)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cache-cmd-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('clears all entries when no flag is passed', async () => {
    const cacheRoot = resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } });
    await writeEntry(cacheRoot, { kind: 'board', boardId: '1' }, {});
    await writeEntry(cacheRoot, { kind: 'users' }, {});

    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'clear', '--json'],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: { scope: string; removed: number; bytes_freed: number };
    };
    expect(env.data.scope).toBe('all');
    expect(env.data.removed).toBe(2);
    expect(env.data.bytes_freed).toBeGreaterThan(0);
  });

  it('clears a single board entry with --board <bid>', async () => {
    const cacheRoot = resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } });
    await writeEntry(cacheRoot, { kind: 'board', boardId: '1' }, {});
    await writeEntry(cacheRoot, { kind: 'board', boardId: '2' }, {});

    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'clear', '--board', '1', '--json'],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: { scope: string; board_id: string | null; removed: number };
    };
    expect(env.data.scope).toBe('board');
    expect(env.data.board_id).toBe('1');
    expect(env.data.removed).toBe(1);
  });

  it('reports removed=0 when --board <bid> targets a missing entry', async () => {
    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'clear', '--board', '999', '--json'],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: { removed: number; bytes_freed: number };
    };
    expect(env.data.removed).toBe(0);
    expect(env.data.bytes_freed).toBe(0);
  });

  it('rejects a non-numeric --board argument with usage_error', async () => {
    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'clear', '--board', '../etc', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(captured.stderr()) as {
      error: { code: string; message: string };
    };
    expect(err.error.code).toBe('usage_error');
    expect(err.error.message).toMatch(/numeric board ID/u);
  });
});

describe('monday cache stats (integration)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cache-cmd-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports exists=false on an empty XDG_CACHE_HOME', async () => {
    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'stats', '--json'],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: {
        exists: boolean;
        entries: number;
        bytes: number;
        oldest_age_seconds: number | null;
        newest_age_seconds: number | null;
      };
    };
    expect(env.data.exists).toBe(false);
    expect(env.data.entries).toBe(0);
    expect(env.data.bytes).toBe(0);
    expect(env.data.oldest_age_seconds).toBeNull();
    expect(env.data.newest_age_seconds).toBeNull();
  });

  it('reports populated stats after entries are written', async () => {
    const cacheRoot = resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } });
    await writeEntry(cacheRoot, { kind: 'board', boardId: '1' }, { v: 1 });

    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'stats', '--json'],
      // Advance the clock so the age computation surfaces a non-zero
      // value (catches a regression where ageSeconds was always 0).
      clock: () => new Date(Date.now() + 30_000),
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: {
        exists: boolean;
        entries: number;
        bytes: number;
        oldest_age_seconds: number | null;
      };
    };
    expect(env.data.exists).toBe(true);
    expect(env.data.entries).toBe(1);
    expect(env.data.bytes).toBeGreaterThan(0);
    expect(env.data.oldest_age_seconds).toBeGreaterThanOrEqual(30);
  });
});

describe('monday cache --help', () => {
  it('lists list/clear/stats verbs', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cache-help-'));
    try {
      const { options, captured } = baseOptions(workDir, {
        argv: ['node', 'monday', 'cache', '--help'],
      });
      await run(options);
      expect(captured.stdout()).toContain('list');
      expect(captured.stdout()).toContain('clear');
      expect(captured.stdout()).toContain('stats');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('cache commands — token redaction', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cache-leak-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('does not leak the literal token in any cache list output', async () => {
    const literal = 'tok-leakcheck-xxxx';
    // Smuggle the literal via a stray cache file path (the path is
    // surfaced verbatim in the listing).
    const cacheRoot = resolveCacheRoot({ env: { XDG_CACHE_HOME: workDir } });
    await writeEntry(cacheRoot, { kind: 'board', boardId: '1' }, {});
    // Add a non-cache file so listEntries skips it without emitting
    // the path; ensures the literal can't sneak through that branch.
    writeFileSync(join(cacheRoot, 'boards', `${literal}.txt`), 'noop');

    const { options, captured } = baseOptions(workDir, {
      argv: ['node', 'monday', 'cache', 'list', '--json'],
      env: { XDG_CACHE_HOME: workDir, MONDAY_API_TOKEN: literal },
    });
    await run(options);
    expect(captured.stdout()).not.toContain(literal);
  });
});
