/**
 * Integration tests for the v0.3-M21 pre-flight `monday auth login`
 * + `monday auth logout` verbs. Both ship as documentation-only
 * stubs at pre-flight: argv shape is the final shape M21
 * implementation lands against; runtime bodies (OAuth flow + cache
 * primitive) are stubbed under `internal_error` per cli-design §7.3 +
 * §7.4 (v0.3-plan §3 M21 stub deliverables).
 *
 * Coverage:
 *
 *   - `auth login --profile <name>` — argv parses; stub body throws
 *     `internal_error` with M21-pending hint.
 *   - `auth logout --profile <name>` — argv parses; stub body throws
 *     `internal_error` with M21-pending hint.
 *   - Required `--profile` enforcement — commander surfaces the
 *     missing-required-option as `usage_error` (exit 1).
 *   - Both verbs accept any non-empty profile name (M21 widens
 *     global-flags acceptance).
 *   - Token redaction across the leak canary.
 */
import { describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import {
  baseOptions,
  parseEnvelope,
  LEAK_CANARY,
  type Captured,
} from '../helpers.js';

const drive = async (
  argv: readonly string[],
  overrides: Partial<RunOptions> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    ...overrides,
  });
  const result = await run(options);
  return { exitCode: result.exitCode, captured };
};

describe('monday auth login (integration, M21 pre-flight)', () => {
  it('rejects with internal_error stub carrying the M21-pending hint', async () => {
    const { exitCode, captured } = await drive([
      'auth',
      'login',
      '--profile',
      'work',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.message).toMatch(/auth login/u);
    expect(env.error?.message).toMatch(/pre-flight stub/u);
    const details = env.error?.details as { hint?: string } | undefined;
    expect(details?.hint).toMatch(/M21 implementation/u);
  });

  it('accepts any non-empty profile name (M21 widens v0.1\'s default-only restriction)', async () => {
    for (const profileName of ['work', 'personal', 'staging-account', 'eu-tenant']) {
      const { exitCode, captured } = await drive([
        'auth',
        'login',
        '--profile',
        profileName,
        '--json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseEnvelope(captured.stderr());
      // The verb reaches its stub body — i.e., the parse path
      // accepted the profile name. usage_error here would mean
      // global-flags rejected the name pre-stub.
      expect(env.error?.code).toBe('internal_error');
    }
  });

  it('--profile is required — missing surfaces usage_error', async () => {
    const { exitCode, captured } = await drive(['auth', 'login', '--json']);
    // Commander's missing-required-option path surfaces a
    // commander error which the runner maps to usage_error → exit 1.
    expect(exitCode).toBe(1);
    expect(captured.stderr()).toMatch(/profile/u);
  });

  it('redacts the leak canary across the error envelope', async () => {
    const { captured } = await drive([
      'auth',
      'login',
      '--profile',
      'work',
      '--json',
    ]);
    const fullStderr = captured.stderr();
    const fullStdout = captured.stdout();
    expect(fullStderr).not.toContain(LEAK_CANARY);
    expect(fullStdout).not.toContain(LEAK_CANARY);
  });
});

describe('monday auth logout (integration, M21 pre-flight)', () => {
  it('rejects with internal_error stub carrying the M21-pending hint', async () => {
    const { exitCode, captured } = await drive([
      'auth',
      'logout',
      '--profile',
      'work',
      '--json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseEnvelope(captured.stderr());
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.message).toMatch(/auth logout/u);
    expect(env.error?.message).toMatch(/pre-flight stub/u);
    const details = env.error?.details as { hint?: string } | undefined;
    expect(details?.hint).toMatch(/M21 implementation/u);
    expect(details?.hint).toMatch(/deleteProfileCredentials/u);
  });

  it('--profile is required — missing surfaces usage_error', async () => {
    const { exitCode, captured } = await drive(['auth', 'logout', '--json']);
    expect(exitCode).toBe(1);
    expect(captured.stderr()).toMatch(/profile/u);
  });

  it('redacts the leak canary across the error envelope', async () => {
    const { captured } = await drive([
      'auth',
      'logout',
      '--profile',
      'work',
      '--json',
    ]);
    expect(captured.stderr()).not.toContain(LEAK_CANARY);
    expect(captured.stdout()).not.toContain(LEAK_CANARY);
  });
});
