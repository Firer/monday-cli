/**
 * Integration tests for the v0.3-M21 profile-resolution preAction
 * hook (cli-design §7.2 / §7.4 — `src/cli/program.ts`).
 *
 * Exercises the path where a non-auth command with `--profile <name>`
 * (or `MONDAY_PROFILE` env) reads the token from the credentials
 * cache or `api_token_env`, injects it into `ctx.env.MONDAY_API_TOKEN`,
 * and the downstream command consumes it via `loadConfig`.
 *
 * Uses `monday config show` because it's local-only — exercises the
 * config-load path without requiring a fixture cassette.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import {
  baseOptions,
  parseEnvelope,
  type Captured,
} from '../helpers.js';
import {
  CREDENTIALS_DIR_NAME,
  setProfileCredentials,
  type ProfileEntry,
} from '../../../src/config/credentials.js';
import { PROFILES_CONFIG_FILE_NAME } from '../../../src/config/profiles.js';

const writeConfigToml = async (home: string, content: string): Promise<void> => {
  const dir = join(home, CREDENTIALS_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, PROFILES_CONFIG_FILE_NAME), content, 'utf8');
};

const driveWithProfile = async (
  argv: readonly string[],
  home: string,
  envOverrides: Record<string, string | undefined> = {},
  overrides: Partial<RunOptions> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    env: {
      MONDAY_API_URL: 'https://api.monday.com/v2',
      HOME: home,
      ...Object.fromEntries(
        Object.entries(envOverrides).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    },
    ...overrides,
  });
  const result = await run(options);
  return { exitCode: result.exitCode, captured };
};

const sampleEntry: ProfileEntry = {
  access_token: 'tok-from-cache-xxxx',
  obtained_at: '2026-05-10T12:00:00Z',
  expires_at: null,
  scopes: ['boards:read'],
  account_id: '12345',
};

describe('profile resolution preAction hook (M21)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-profile-resolve-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('--profile work + credentials cache: command runs with the cached token', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry },
      { home },
    );

    const { exitCode, captured } = await driveWithProfile(
      ['config', 'show', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
    // The cache-resolved token NEVER appears in the rendered output.
    expect(captured.stdout()).not.toContain('tok-from-cache-xxxx');
    expect(captured.stderr()).not.toContain('tok-from-cache-xxxx');
  });

  it('--profile work + config.toml api_token_env: resolves env-named token', async () => {
    await writeConfigToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
      ].join('\n'),
    );
    const { exitCode } = await driveWithProfile(
      ['config', 'show', '--profile', 'work', '--json'],
      home,
      { MONDAY_API_TOKEN_WORK: 'tok-env-xxxx' },
    );
    expect(exitCode).toBe(0);
  });

  it('MONDAY_PROFILE env names the profile (no --profile flag)', async () => {
    await setProfileCredentials(
      { profileName: 'personal', entry: sampleEntry },
      { home },
    );
    const { exitCode } = await driveWithProfile(
      ['config', 'show', '--json'],
      home,
      { MONDAY_PROFILE: 'personal' },
    );
    expect(exitCode).toBe(0);
  });

  it('default_profile in config.toml + cached credentials: resolves default', async () => {
    await writeConfigToml(
      home,
      [
        'default_profile = "work"',
        '',
        '[profiles.work]',
        'api_version = "2026-01"',
      ].join('\n'),
    );
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry },
      { home },
    );
    const { exitCode, captured } = await driveWithProfile(
      ['config', 'show', '--json'],
      home,
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.ok).toBe(true);
  });

  it('--profile X but no cache + no api_token_env: surfaces config_error', async () => {
    await writeConfigToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK_UNSET"',
      ].join('\n'),
    );
    const { exitCode, captured } = await driveWithProfile(
      ['config', 'show', '--profile', 'work', '--json'],
      home,
    );
    expect(exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('config_error');
  });

  it('--profile X but profile not in config.toml: surfaces config_error', async () => {
    await writeConfigToml(
      home,
      ['[profiles.personal]', 'api_token_env = "X"'].join('\n'),
    );
    const { exitCode, captured } = await driveWithProfile(
      ['config', 'show', '--profile', 'unknown', '--json'],
      home,
    );
    expect(exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('config_error');
  });

  it('implicit v1 (no profile, no config): falls through to MONDAY_API_TOKEN env', async () => {
    const { exitCode } = await driveWithProfile(
      ['config', 'show', '--json'],
      home,
      { MONDAY_API_TOKEN: 'tok-implicit-v1-xxxx' },
    );
    expect(exitCode).toBe(0);
  });

  it('profile with api_version override: applied when --api-version flag is absent', async () => {
    await writeConfigToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        'api_version = "2025-10"',
      ].join('\n'),
    );
    const { exitCode, captured } = await driveWithProfile(
      ['config', 'show', '--profile', 'work', '--json'],
      home,
      { MONDAY_API_TOKEN_WORK: 'tok-env-xxxx' },
    );
    expect(exitCode).toBe(0);
    const env = parseEnvelope(captured.stdout());
    expect(env.meta.api_version).toBe('2025-10');
  });
});
