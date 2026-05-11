/**
 * Integration tests for the v0.3-M26a dev namespace setup verbs:
 * `monday dev discover` / `dev configure` / `dev doctor`.
 *
 * Drives the action bodies via `FixtureTransport` cassettes (mock-
 * at-the-network-boundary per testing.md), wires `HOME` to a per-
 * test tmp dir for the config.toml IO surface, and threads
 * `MONDAY_PROFILE=work` so `resolveActiveDevProfile` lands in the
 * named-profile path.
 *
 * Each verb's happy path + every documented failure mode has at
 * least one test. Covers:
 *
 *   - `dev discover` walker shape + zero-match / ambiguous surfaces.
 *   - `dev discover --apply` first-write + additive-merge with
 *     existing dev block.
 *   - `dev configure` write-back + read-back loop.
 *   - `dev doctor` per-check status surfaces + summary counts.
 *   - implicit-v1 mode `config_error` surface across verbs.
 *   - `dev_not_configured` surfaces on doctor (round-1 P2-4
 *     closure — doctor fires the code; discover/configure do not).
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import {
  baseOptions,
  parseEnvelope,
  LEAK_CANARY,
  FIXTURE_API_URL,
  type Captured,
} from '../helpers.js';
import { createFixtureTransport, type Cassette } from '../../fixtures/load.js';
import {
  setProfileCredentials,
  type ProfileEntry,
} from '../../../src/config/credentials.js';

const sampleCachedEntry: ProfileEntry = {
  access_token: LEAK_CANARY,
  obtained_at: '2026-05-10T12:00:00Z',
  expires_at: null,
  scopes: ['boards:read', 'boards:write'],
  account_id: '12345',
};

interface DevTestEnv {
  readonly home: string;
}

const buildDevTmpHome = async (): Promise<DevTestEnv> => {
  const home = await mkdtemp(join(tmpdir(), 'monday-cli-dev-int-'));
  return { home };
};

/**
 * Seeds `~/.monday-cli/config.toml` with the given content. The
 * preAction profile-resolution path picks up the token via the
 * pre-seeded credentials cache (set in `beforeEach`), so config.toml
 * only needs to carry the dev block(s).
 */
const seedConfigToml = async (
  home: string,
  content: string,
): Promise<void> => {
  const dir = join(home, '.monday-cli');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'config.toml'), content, { mode: 0o600 });
};

/**
 * Seeds the credentials cache so the preAction hook's profile
 * resolution finds a cached token for the `work` profile (mirrors
 * `tests/integration/commands/profile-resolution.test.ts`).
 */
const seedCredentialsCache = async (home: string): Promise<void> => {
  await setProfileCredentials(
    { profileName: 'work', entry: sampleCachedEntry },
    { home },
  );
};

const readConfigToml = async (home: string): Promise<string> => {
  return readFile(join(home, '.monday-cli', 'config.toml'), 'utf8');
};

const driveDev = async (
  argv: readonly string[],
  env: DevTestEnv,
  cassette: Cassette | undefined,
  envOverrides: Record<string, string | undefined> = {},
  overrides: Partial<RunOptions> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  const transport =
    cassette !== undefined ? createFixtureTransport(cassette) : undefined;
  // Build env: base keys then apply per-test overrides. `undefined`
  // override values UNSET the base key (rather than spread-as-
  // undefined which falls back to the base via the filter pattern).
  // Object-rebuild on unset avoids eslint's `no-dynamic-delete`
  // rule against `delete obj[dynamicKey]`.
  let finalEnv: Record<string, string> = {
    MONDAY_API_TOKEN: LEAK_CANARY,
    MONDAY_API_URL: FIXTURE_API_URL,
    HOME: env.home,
    MONDAY_PROFILE: 'work',
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) {
      const next: Record<string, string> = {};
      for (const [existingKey, existingValue] of Object.entries(finalEnv)) {
        if (existingKey !== k) next[existingKey] = existingValue;
      }
      finalEnv = next;
    } else {
      finalEnv[k] = v;
    }
  }
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    env: finalEnv,
    ...(transport !== undefined ? { transport } : {}),
    ...overrides,
  });
  const result = await run(options);
  return { exitCode: result.exitCode, captured };
};

let env: DevTestEnv;
beforeEach(async () => {
  env = await buildDevTmpHome();
  // Seed credentials cache so the preAction hook can resolve the
  // `work` profile's token without needing config.toml's
  // api_token_env reference. Tests that want to assert against the
  // implicit-v1 path drop MONDAY_PROFILE via envOverrides.
  await seedCredentialsCache(env.home);
});
afterEach(async () => {
  await rm(env.home, { recursive: true, force: true });
});

// =============================================================
// `monday dev discover` (no --apply)
// =============================================================
describe('monday dev discover (read-only)', () => {
  it('walks accessible boards + reports per-noun matches', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
                { id: '200', name: 'Sprints', workspace_id: '50', type: 'board' },
                { id: '300', name: 'Epics', workspace_id: '50', type: 'board' },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & {
      data: {
        profile: string;
        mapping: Record<string, string>;
        matches: readonly { noun: string; matched: readonly unknown[] }[];
        applied: boolean;
      };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.profile).toBe('work');
    expect(envelope.data.applied).toBe(false);
    expect(envelope.data.mapping).toEqual({
      tasks_board: '100',
      sprints_board: '200',
      epics_board: '300',
    });
    expect(envelope.data.matches.length).toBe(5);
  });

  it('drops sub_items_board entries silently', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
                {
                  id: '101',
                  name: 'Subitems of Tasks',
                  workspace_id: '50',
                  type: 'sub_items_board',
                },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { mapping: Record<string, string> } };
    // Sub_items_board was filtered → single match → auto-mapped.
    expect(envelope.data.mapping.tasks_board).toBe('100');
  });

  it('does NOT write config.toml without --apply', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
              ],
            },
          },
        },
      ],
    };
    await driveDev(['dev', 'discover', '--json'], env, cassette);
    await expect(readConfigToml(env.home)).rejects.toThrow();
  });

  it('surfaces config_error in implicit-v1 mode', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--json'],
      env,
      undefined,
      { MONDAY_PROFILE: undefined },
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('config_error');
  });
});

// =============================================================
// `monday dev discover --apply`
// =============================================================
describe('monday dev discover --apply', () => {
  it('writes the heuristic mapping into a fresh config.toml', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
                { id: '200', name: 'Sprints', workspace_id: '50', type: 'board' },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--apply', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { applied: boolean; mapping: Record<string, string> } };
    expect(envelope.data.applied).toBe(true);
    expect(envelope.data.mapping).toEqual({
      tasks_board: '100',
      sprints_board: '200',
    });

    // Verify the file landed on disk.
    const content = await readConfigToml(env.home);
    expect(content).toContain('[profiles.work.dev]');
    expect(content).toContain('tasks_board');
    expect(content).toContain('100');
  });

  it('additively merges with an existing dev block (preserves slots heuristic did not fill)', async () => {
    await seedConfigToml(
      env.home,
      '[profiles.work.dev]\nreleases_board = "999"\n',
    );
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--apply', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { mapping: Record<string, string> } };
    expect(envelope.data.mapping).toEqual({
      releases_board: '999', // preserved from existing
      tasks_board: '100', // from heuristic
    });
  });

  it('re-throws non-dev_not_configured errors on --apply (config_error on malformed TOML)', async () => {
    await seedConfigToml(env.home, 'this = is = not valid toml');
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: {
            data: {
              boards: [
                { id: '100', name: 'Tasks', workspace_id: '50', type: 'board' },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--apply', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('config_error');
  });

  it('handles empty match results (no boards in workspace)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDiscoverBoards',
          response: { data: { boards: [] } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'discover', '--apply', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { applied: boolean; mapping: Record<string, string> } };
    expect(envelope.data.applied).toBe(true);
    expect(envelope.data.mapping).toEqual({});
  });
});

// =============================================================
// `monday dev configure`
// =============================================================
describe('monday dev configure', () => {
  it('writes a single board slot', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--tasks-board', '987654', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { profile: string; mapping: Record<string, string> } };
    expect(envelope.data.profile).toBe('work');
    expect(envelope.data.mapping).toEqual({ tasks_board: '987654' });

    const content = await readConfigToml(env.home);
    expect(content).toContain('tasks_board');
    expect(content).toContain('987654');
  });

  it('writes multiple board slots in one call', async () => {
    const { exitCode, captured } = await driveDev(
      [
        'dev',
        'configure',
        '--tasks-board',
        '100',
        '--sprints-board',
        '200',
        '--epics-board',
        '300',
        '--json',
      ],
      env,
      undefined,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { mapping: Record<string, string> } };
    expect(envelope.data.mapping).toEqual({
      tasks_board: '100',
      sprints_board: '200',
      epics_board: '300',
    });
  });

  it('additively merges with the existing dev block', async () => {
    await seedConfigToml(
      env.home,
      '[profiles.work.dev]\nepics_board = "555"\n',
    );
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--tasks-board', '100', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { mapping: Record<string, string> } };
    expect(envelope.data.mapping).toEqual({
      epics_board: '555',
      tasks_board: '100',
    });
  });

  it('rejects with usage_error when no --*-board flags are supplied', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });

  it('writes --bugs-board + --releases-board slots', async () => {
    const { exitCode, captured } = await driveDev(
      [
        'dev',
        'configure',
        '--bugs-board',
        '700',
        '--releases-board',
        '800',
        '--json',
      ],
      env,
      undefined,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { mapping: Record<string, string> } };
    expect(envelope.data.mapping).toEqual({
      bugs_board: '700',
      releases_board: '800',
    });
  });

  it('re-throws non-dev_not_configured errors (config_error on malformed TOML)', async () => {
    // Seed a config.toml with malformed TOML so loadDevMapping
    // surfaces config_error rather than dev_not_configured. The
    // verb's catch must re-throw the config_error (not treat it as
    // a missing-dev-block).
    await seedConfigToml(env.home, 'this = is = not valid toml');
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--tasks-board', '987', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('config_error');
  });

  it('rejects with usage_error on invalid board ID (non-numeric)', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--tasks-board', 'not-a-number', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });

  it('surfaces config_error in implicit-v1 mode', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'configure', '--tasks-board', '987', '--json'],
      env,
      undefined,
      { MONDAY_PROFILE: undefined },
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('config_error');
  });

  it('Codex round-1 P1-1: invalid global flag leaves config.toml unchanged (no write before usage_error)', async () => {
    // Seed an existing dev block so we can detect a clobbered write.
    await seedConfigToml(
      env.home,
      '[profiles.work.dev]\ntasks_board = "existing-tasks-id"\n',
    );
    const beforeWrite = await readConfigToml(env.home);
    // Invalid `--retry` value (must be a non-negative integer).
    const { exitCode, captured } = await driveDev(
      [
        '--retry',
        'not-a-number',
        'dev',
        'configure',
        '--tasks-board',
        '999',
        '--json',
      ],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
    // The config.toml MUST be untouched — `_shared.ts:
    // resolveActiveDevProfile` must surface the usage_error BEFORE
    // `saveDevMapping` runs.
    const afterWrite = await readConfigToml(env.home);
    expect(afterWrite).toBe(beforeWrite);
  });
});

// =============================================================
// `monday dev doctor`
// =============================================================
describe('monday dev doctor', () => {
  it('runs all 10 checks against a fully-healthy mapping', async () => {
    await seedConfigToml(
      env.home,
      [
        '[profiles.work.dev]',
        'tasks_board = "100"',
        'sprints_board = "200"',
        'epics_board = "300"',
        'releases_board = "400"',
        'bugs_board = "500"',
      ].join('\n'),
    );
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDoctorBoards',
          response: {
            data: {
              boards: [
                {
                  id: '100',
                  name: 'Tasks',
                  state: 'active',
                  columns: [
                    {
                      id: 'status',
                      title: 'Status',
                      type: 'status',
                      settings_str: JSON.stringify({
                        labels: { '0': 'Working on it', '1': 'Done', '2': 'Stuck' },
                      }),
                    },
                    {
                      id: 'rel_s',
                      title: 'Sprint',
                      type: 'board_relation',
                      settings_str: JSON.stringify({ boardIds: ['200'] }),
                    },
                    {
                      id: 'rel_e',
                      title: 'Epic',
                      type: 'board_relation',
                      settings_str: JSON.stringify({ boardIds: ['300'] }),
                    },
                  ],
                },
                {
                  id: '200',
                  name: 'Sprints',
                  state: 'active',
                  columns: [
                    {
                      id: 'timeline',
                      title: 'Sprint Range',
                      type: 'timeline',
                      settings_str: null,
                    },
                  ],
                },
                { id: '300', name: 'Epics', state: 'active', columns: [] },
                { id: '400', name: 'Releases', state: 'active', columns: [] },
                { id: '500', name: 'Bugs', state: 'active', columns: [] },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'doctor', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & {
      data: {
        profile: string;
        mapping: Record<string, string>;
        checks: readonly { name: string; status: string }[];
        summary: { ok_count: number; warn_count: number; fail_count: number };
      };
    };
    expect(envelope.data.profile).toBe('work');
    expect(envelope.data.checks.length).toBe(10);
    expect(envelope.data.summary.fail_count).toBe(0);
    expect(envelope.data.summary.ok_count).toBe(10);
  });

  it('surfaces fail counts via summary when boards are inaccessible', async () => {
    await seedConfigToml(
      env.home,
      '[profiles.work.dev]\ntasks_board = "999"\n',
    );
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevDoctorBoards',
          response: { data: { boards: [] } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'doctor', '--json'],
      env,
      cassette,
    );
    // Exit code stays 0 — `dev doctor` reports drift via summary,
    // not via verb-level error (per the action body's docstring).
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & {
      data: { summary: { fail_count: number } };
    };
    expect(envelope.data.summary.fail_count).toBeGreaterThan(0);
  });

  it('surfaces dev_not_configured when no [profiles.<name>.dev] block exists', async () => {
    // Seed a config.toml with the profile section but no dev block.
    await seedConfigToml(env.home, '[profiles.work]\napi_token_env = "X"\n');
    const { exitCode, captured } = await driveDev(
      ['dev', 'doctor', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_not_configured');
  });

  it('surfaces dev_not_configured when no config.toml exists at all', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'doctor', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_not_configured');
  });

  it('surfaces config_error in implicit-v1 mode (profile not resolvable)', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'doctor', '--json'],
      env,
      undefined,
      { MONDAY_PROFILE: undefined },
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('config_error');
  });
});
