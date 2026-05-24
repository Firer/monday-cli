/**
 * Integration tests for the v0.12-M55-E defaults companion verbs
 * (`monday config set` / `get` / `unset`). Drives `run()` end-to-
 * end against a tmp HOME so the TOML write + re-read paths +
 * envelope shape + exit codes are pinned in lockstep.
 *
 * Covered scenarios:
 *   - Happy-path set → get round-trip (profile_default source).
 *   - Env wins over profile (env_var source) on the same key.
 *   - Unset → re-get → source: 'unset'.
 *   - Unset on absent key — idempotent (ok: true, previous_value: null).
 *   - Unknown key → config_error.unknown_defaults_key (exit 3).
 *   - Wrong type → config_error.wrong_defaults_type (exit 3).
 *   - --profile <name> scopes the write to a non-active profile.
 *   - Implicit-v1 (no profile) → config get reports env-only +
 *     all unset; config set rejects with config_error.
 *   - get without [key] emits all 4 entries.
 *   - 0o600 mode on the written config.toml.
 *
 * Mirrors `tests/integration/commands/config.test.ts`'s baseOptions
 * shape; new helper `driveConfig` threads a tmp HOME +
 * MONDAY_PROFILE + optional MONDAY_API_TOKEN.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
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

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: { schema_version: string };
}

const driveConfig = async (
  argv: readonly string[],
  home: string,
  envOverrides: Readonly<Record<string, string>> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));

  const options: RunOptions = {
    argv: ['node', 'monday', ...argv],
    env: {
      HOME: home,
      ...envOverrides,
    },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-id']),
    clock: () => new Date('2026-05-24T10:00:00Z'),
  };
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    captured: {
      stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    },
  };
};

const parseEnvelope = (raw: string): Envelope => JSON.parse(raw) as Envelope;

const writeProfileToml = async (
  home: string,
  body: string,
): Promise<void> => {
  const dir = join(home, '.monday-cli');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'config.toml'), body, { mode: 0o600 });
};

describe('monday config set/get/unset (integration, v0.12-M55-E)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'config-defaults-it-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('set → get round-trip: emits the resolved value with source: profile_default', async () => {
    // Seed a minimal profile entry so selectProfile picks "work".
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const setResult = await driveConfig(
      ['config', 'set', 'board', '987654', '--profile', 'work', '--json'],
      home,
    );
    expect(setResult.exitCode).toBe(0);
    const setEnv = parseEnvelope(setResult.captured.stdout());
    expect(setEnv.ok).toBe(true);
    expect(setEnv.data?.value).toBe('987654');
    expect(setEnv.data?.previous_value).toBe(null);
    expect(setEnv.data?.profile).toBe('work');

    const getResult = await driveConfig(
      ['config', 'get', 'board', '--profile', 'work', '--json'],
      home,
    );
    expect(getResult.exitCode).toBe(0);
    const getEnv = parseEnvelope(getResult.captured.stdout());
    const entries = getEnv.data?.entries as {
      key: string;
      value: string | null;
      source: string;
    }[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      key: 'board',
      value: '987654',
      source: 'profile_default',
    });
  });

  it('env var wins over profile default (source: env_var)', async () => {
    await writeProfileToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        '[profiles.work.defaults]',
        'board = "987654"',
      ].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'get', 'board', '--profile', 'work', '--json'],
      home,
      { MONDAY_BOARD: '99999' },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    const entries = env.data?.entries as { source: string; value: string }[];
    expect(entries[0]?.source).toBe('env_var');
    expect(entries[0]?.value).toBe('99999');
  });

  it('unset → re-get: source falls back to unset (value null)', async () => {
    await writeProfileToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        '[profiles.work.defaults]',
        'board = "987654"',
      ].join('\n'),
    );
    const unsetResult = await driveConfig(
      ['config', 'unset', 'board', '--profile', 'work', '--json'],
      home,
    );
    expect(unsetResult.exitCode).toBe(0);
    const unsetEnv = parseEnvelope(unsetResult.captured.stdout());
    expect(unsetEnv.data?.previous_value).toBe('987654');

    const getResult = await driveConfig(
      ['config', 'get', 'board', '--profile', 'work', '--json'],
      home,
    );
    expect(getResult.exitCode).toBe(0);
    const getEnv = parseEnvelope(getResult.captured.stdout());
    const entries = getEnv.data?.entries as {
      source: string;
      value: string | null;
    }[];
    expect(entries[0]).toMatchObject({ source: 'unset', value: null });
  });

  it('unset on an absent key is idempotent: ok: true, previous_value: null', async () => {
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'unset', 'concurrency', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
    expect(env.data?.previous_value).toBe(null);
  });

  it('unknown key → config_error.unknown_defaults_key (exit 3) — token-storage rule preserved', async () => {
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'set', 'api_token_env', 'MONDAY_API_TOKEN_X', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('config_error');
    expect(env.error?.details?.reason).toBe('unknown_defaults_key');
  });

  it('wrong type on allowed key → config_error.wrong_defaults_type (exit 3)', async () => {
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'set', 'output', 'yaml', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('config_error');
    expect(env.error?.details?.reason).toBe('wrong_defaults_type');
  });

  it('--profile <name> scopes the write to a non-active profile (preserves active)', async () => {
    await writeProfileToml(
      home,
      [
        'default_profile = "work"',
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        '[profiles.personal]',
        'api_token_env = "MONDAY_API_TOKEN_PERSONAL"',
      ].join('\n'),
    );
    const { exitCode } = await driveConfig(
      ['config', 'set', 'board', '12345', '--profile', 'personal', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    // Verify the write landed on `personal` and not on `work`.
    const tomlBody = await readFile(
      join(home, '.monday-cli', 'config.toml'),
      'utf8',
    );
    expect(tomlBody).toContain('[profiles.personal.defaults]');
    expect(tomlBody).not.toContain('[profiles.work.defaults]');
  });

  it('implicit-v1 (no profile selected): `config set` rejects with config_error', async () => {
    const { exitCode, captured } = await driveConfig(
      ['config', 'set', 'board', '12345', '--json'],
      home,
    );
    expect(exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('config_error');
  });

  it('implicit-v1: `config get` degrades to env-only resolution (still emits ok: true)', async () => {
    const { exitCode, captured } = await driveConfig(
      ['config', 'get', 'board', '--json'],
      home,
      { MONDAY_BOARD: '99999' },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    const entries = env.data?.entries as { source: string; value: string }[];
    expect(entries[0]?.source).toBe('env_var');
    expect(entries[0]?.value).toBe('99999');
  });

  it('config get without [key] emits all 4 entries (one per allowlist key)', async () => {
    await writeProfileToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        '[profiles.work.defaults]',
        'board = "987654"',
        'output = "table"',
      ].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'get', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    const entries = env.data?.entries as {
      key: string;
      source: string;
      value: string | number | null;
    }[];
    expect(entries).toHaveLength(4);
    const byKey = Object.fromEntries(entries.map((e) => [e.key, e]));
    expect(byKey.board?.source).toBe('profile_default');
    expect(byKey.output?.source).toBe('profile_default');
    expect(byKey.workspace?.source).toBe('unset');
    expect(byKey.concurrency?.source).toBe('unset');
  });

  it('config.toml is written with mode 0o600 (security.md disk discipline)', async () => {
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode } = await driveConfig(
      ['config', 'set', 'board', '12345', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const stats = statSync(join(home, '.monday-cli', 'config.toml'));
     
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('set on a fresh HOME (no config.toml) bootstraps the file when --profile is given', async () => {
    // No pre-seeded config.toml; --profile names a new profile.
    const { exitCode } = await driveConfig(
      ['config', 'set', 'board', '12345', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const tomlBody = await readFile(
      join(home, '.monday-cli', 'config.toml'),
      'utf8',
    );
    expect(tomlBody).toContain('board = "12345"');
  });

  // ===== Lazy env-validation scope pins (Codex IMPL R1 P1 + R2 P2) =====
  // The lazy fix's actual scope: a malformed value for ONE allowlist
  // key doesn't crash commands that don't resolve THAT key for
  // argument injection. MONDAY_OUTPUT is special — output-format
  // selection (`src/utils/output/select.ts`) reads it independently
  // and validates against OUTPUT_FORMATS at emit time, regardless of
  // which key any given command consumed. These tests pin both
  // contracts so a future regression surfaces the right tripwire.

  it('lazy fix: malformed MONDAY_BOARD does NOT crash `config get output` (unrelated key)', async () => {
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'get', 'output', '--profile', 'work', '--json'],
      home,
      { MONDAY_BOARD: 'not-numeric' },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
  });

  it('pre-existing: malformed MONDAY_OUTPUT crashes the output-format selector at emit time (scope-limit of P1 fix)', async () => {
    // Pre-v0.12 behavior: select.ts validates MONDAY_OUTPUT against
    // OUTPUT_FORMATS at emit time. The v0.12-M55-E lazy resolver
    // didn't change this — it only stopped the PROFILE-DEFAULTS
    // layer from eagerly validating unrelated env vars. The
    // output-format selector still fails fast on malformed
    // MONDAY_OUTPUT regardless of which command is running.
    //
    // The test omits --json / --table / --output / `isTTY: true` so
    // select.ts falls through to the env layer. With --json /
    // --table /--output present (the shorthand wins), MONDAY_OUTPUT
    // is ignored — the format-selector hierarchy stays intact and
    // the malformation is invisible. This is by design at select.ts
    // and orthogonal to the v0.12-M55-E lazy resolver.
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode } = await driveConfig(
      // No --json / --table / --output — falls through to env.
      ['config', 'get', 'board', '--profile', 'work'],
      home,
      { MONDAY_OUTPUT: 'yaml' },
    );
    // Crashes at emit time — usage_error (exit 1) per
    // src/utils/output/select.ts's documented contract.
    expect(exitCode).toBe(1);
  });

  it('with --json override: malformed MONDAY_OUTPUT becomes invisible (shorthand priority preserved)', async () => {
    // Companion to the previous test: with --json explicitly in
    // argv, select.ts's shorthand priority wins and MONDAY_OUTPUT
    // is not consulted. Pins the orthogonal contract.
    await writeProfileToml(
      home,
      ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
    );
    const { exitCode, captured } = await driveConfig(
      ['config', 'get', 'board', '--profile', 'work', '--json'],
      home,
      { MONDAY_OUTPUT: 'yaml' },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
  });
});
