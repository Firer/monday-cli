import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const baseOptions = (
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
    env: {},
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

interface SuccessEnvelope {
  ok: true;
  data: Record<string, unknown>;
  meta: {
    schema_version: string;
    api_version: string;
    cli_version: string;
    request_id: string;
    source: string;
    cache_age_seconds: number | null;
    complexity: unknown;
    retrieved_at: string;
  };
  warnings: unknown[];
}

const parseEnvelope = (raw: string): SuccessEnvelope =>
  JSON.parse(raw) as SuccessEnvelope;

describe('monday config show (integration)', () => {
  it('emits a §6 envelope with the token reduced to <set>', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', 'show', '--json'],
      env: { MONDAY_API_TOKEN: literal },
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(captured.stderr()).toBe('');

    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
    expect(env.data.auth).toBe('set');
    expect(env.meta.schema_version).toBe('1');
    expect(env.meta.source).toBe('none');
    expect(env.meta.cache_age_seconds).toBeNull();

    // The literal token must not appear anywhere in the emitted bytes.
    expect(captured.stdout()).not.toContain(literal);
  });

  it('emits api_token=unset when the env is missing', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', 'show', '--json'],
      env: {},
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.data.auth).toBe('unset');
  });

  it('renders a human-readable table when isTTY=true and no --json', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', 'show'],
      env: { MONDAY_API_TOKEN: 'tok-leakcheck-xxxx' },
      isTTY: true,
    });
    await run(options);
    const out = captured.stdout();
    expect(out).toContain('auth');
    expect(out).toContain('field');
    expect(out).not.toContain('tok-leakcheck-xxxx');
  });

  it('exposes the command in --help', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', '--help'],
    });
    await run(options);
    expect(captured.stdout()).toContain('show');
    expect(captured.stdout()).toContain('path');
  });

  it('rejects ndjson on a single-resource command with usage_error', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', 'show', '--output', 'ndjson'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const err = JSON.parse(captured.stderr()) as { error: { code: string } };
    expect(err.error.code).toBe('usage_error');
  });
});

describe('monday config path (integration)', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-cfgpath-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reports the .env path under the cwd', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'config', 'path', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    const searched = env.data.searched as { path: string; exists: boolean }[];
    expect(searched.length).toBe(1);
    expect(searched[0]?.path.endsWith('/.env')).toBe(true);
  });

  it('reflects whether the .env file exists', async () => {
    // Drive the command from a tmp cwd so we don't observe whatever
    // .env is sitting in the project root.
    const originalCwd = process.cwd();
    process.chdir(workDir);
    try {
      writeFileSync(join(workDir, '.env'), 'MONDAY_API_TOKEN=tok\n');
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'config', 'path', '--json'],
      });
      await run(options);
      const env = parseEnvelope(captured.stdout());
      const searched = env.data.searched as { exists: boolean }[];
      expect(searched[0]?.exists).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
