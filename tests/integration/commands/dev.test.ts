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

// =============================================================
// M26b workflow verbs — shared cassette builders.
// =============================================================

/** Wire-shape constructor for an item_page row matching ITEM_FIELDS_FRAGMENT. */
const wireItem = (
  inputs: {
    id: string;
    name: string;
    board_id: string;
    columns?: readonly {
      id: string;
      type: string;
      title: string;
      text?: string | null;
      value?: string | null;
    }[];
  },
): Readonly<Record<string, unknown>> => ({
  id: inputs.id,
  name: inputs.name,
  state: 'active',
  url: `https://example.monday.com/boards/${inputs.board_id}/pulses/${inputs.id}`,
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-15T10:00:00Z',
  board: { id: inputs.board_id },
  group: { id: 'topics', title: 'Active' },
  parent_item: null,
  column_values: (inputs.columns ?? []).map((c) => ({
    id: c.id,
    type: c.type,
    text: c.text ?? null,
    value: c.value ?? null,
    column: { title: c.title },
  })),
});

const itemsPageResponse = (
  items: readonly Readonly<Record<string, unknown>>[],
  cursor: string | null = null,
): Readonly<Record<string, unknown>> => ({
  data: {
    boards: [
      {
        items_page: {
          cursor,
          items,
        },
      },
    ],
  },
});

const hydrateColumnsResponse = (
  boardId: string,
  columns: readonly { id: string; type: string; title: string; settings_str?: string | null }[],
): Readonly<Record<string, unknown>> => ({
  data: {
    boards: [
      {
        id: boardId,
        name: `Board ${boardId}`,
        state: 'active',
        columns: columns.map((c) => ({
          id: c.id,
          title: c.title,
          type: c.type,
          settings_str: c.settings_str ?? null,
        })),
      },
    ],
  },
});

const STOCK_STATUS_SETTINGS = JSON.stringify({
  labels: { '0': 'Working on it', '1': 'Done', '2': 'Stuck' },
});

const seedTasksOnly = async (home: string, tasksBoard: string): Promise<void> => {
  await seedConfigToml(
    home,
    [`[profiles.work.dev]`, `tasks_board = "${tasksBoard}"`].join('\n'),
  );
};

const seedFullMapping = async (home: string): Promise<void> => {
  await seedConfigToml(
    home,
    [
      `[profiles.work.dev]`,
      `tasks_board = "100"`,
      `sprints_board = "200"`,
      `epics_board = "300"`,
      `releases_board = "400"`,
      `bugs_board = "500"`,
    ].join('\n'),
  );
};

// =============================================================
// `monday dev release list`
// =============================================================
describe('monday dev release list', () => {
  it('walks the configured releases board', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevReleaseList',
          response: itemsPageResponse([
            wireItem({ id: '4001', name: 'v0.3.0', board_id: '400' }),
            wireItem({ id: '4002', name: 'v0.4.0', board_id: '400' }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string; name: string }[] };
    expect(envelope.data.length).toBe(2);
    expect(envelope.data[0]?.id).toBe('4001');
    expect(envelope.data[1]?.name).toBe('v0.4.0');
  });

  it('surfaces dev_not_configured when releases_board slot is unset', async () => {
    await seedConfigToml(
      env.home,
      '[profiles.work.dev]\ntasks_board = "100"\n',
    );
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_not_configured');
  });

  it('surfaces dev_not_configured when no dev block exists', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_not_configured');
  });

  it('surfaces config_error in implicit-v1 mode', async () => {
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      undefined,
      { MONDAY_PROFILE: undefined },
    );
    expect(exitCode).toBe(3);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('config_error');
  });
});

// =============================================================
// `monday dev epic list`
// =============================================================
describe('monday dev epic list', () => {
  const cassetteWithEpics = (): Cassette => ({
    interactions: [
      {
        operation_name: 'DevEpicList',
        response: itemsPageResponse([
          wireItem({
            id: '3001',
            name: 'Auth Rewrite',
            board_id: '300',
            columns: [
              {
                id: 'status',
                type: 'status',
                title: 'Status',
                text: 'Working on it',
                value: JSON.stringify({ label: 'Working on it', index: 0 }),
              },
            ],
          }),
          wireItem({
            id: '3002',
            name: 'Billing Migration',
            board_id: '300',
            columns: [
              {
                id: 'status',
                type: 'status',
                title: 'Status',
                text: 'Done',
                value: JSON.stringify({ label: 'Done', index: 1 }),
              },
            ],
          }),
          wireItem({
            id: '3003',
            name: 'No Status Epic',
            board_id: '300',
            columns: [],
          }),
        ]),
      },
    ],
  });

  it('walks the epics board', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'list', '--json'],
      env,
      cassetteWithEpics(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.length).toBe(3);
  });

  it('--state active drops done epics', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'list', '--state', 'active', '--json'],
      env,
      cassetteWithEpics(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['3001', '3003']);
  });

  it('--state done keeps only done/cancelled epics', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'list', '--state', 'done', '--json'],
      env,
      cassetteWithEpics(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['3002']);
  });

  it('surfaces usage_error on invalid --state value', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'list', '--state', 'pending', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });
});

// =============================================================
// `monday dev sprint list` + `dev sprint current` + `dev sprint items`
// =============================================================
describe('monday dev sprint list', () => {
  // FIXED_CLOCK is 2026-04-30T10:00:00Z; classification anchors on
  // 2026-04-30.
  const sprintCassette = (): Cassette => ({
    interactions: [
      {
        operation_name: 'DevSprintList',
        response: itemsPageResponse([
          wireItem({
            id: '2001',
            name: 'Sprint Past',
            board_id: '200',
            columns: [
              {
                id: 'timeline',
                type: 'timeline',
                title: 'Timeline',
                text: '2026-04-01 - 2026-04-15',
                value: JSON.stringify({ from: '2026-04-01', to: '2026-04-15' }),
              },
            ],
          }),
          wireItem({
            id: '2002',
            name: 'Sprint Active',
            board_id: '200',
            columns: [
              {
                id: 'timeline',
                type: 'timeline',
                title: 'Timeline',
                text: '2026-04-25 - 2026-05-05',
                value: JSON.stringify({ from: '2026-04-25', to: '2026-05-05' }),
              },
            ],
          }),
          wireItem({
            id: '2003',
            name: 'Sprint Future',
            board_id: '200',
            columns: [
              {
                id: 'timeline',
                type: 'timeline',
                title: 'Timeline',
                text: '2026-05-10 - 2026-05-20',
                value: JSON.stringify({ from: '2026-05-10', to: '2026-05-20' }),
              },
            ],
          }),
        ]),
      },
    ],
  });

  it('walks the sprints board (no filter)', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--json'],
      env,
      sprintCassette(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.length).toBe(3);
  });

  it('--state active picks straddling sprint', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'active', '--json'],
      env,
      sprintCassette(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2002']);
  });

  it('--state past picks past-end sprints', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'past', '--json'],
      env,
      sprintCassette(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2001']);
  });

  it('--state future picks pre-start sprints', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'future', '--json'],
      env,
      sprintCassette(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2003']);
  });

  it('rejects invalid --state value with usage_error', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'frozen', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });

  it('falls back to past bucket when date range is malformed (NaN guard)', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintList',
          response: itemsPageResponse([
            wireItem({
              id: '2099',
              name: 'Broken',
              board_id: '200',
              columns: [
                {
                  id: 'timeline',
                  type: 'timeline',
                  title: 'Timeline',
                  text: 'invalid',
                  value: JSON.stringify({ from: 'NOTADATE', to: '????' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'past', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2099']);
  });

  it('supports split date columns (start/end pair)', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintList',
          response: itemsPageResponse([
            wireItem({
              id: '2010',
              name: 'Split Active',
              board_id: '200',
              columns: [
                {
                  id: 'date_a',
                  type: 'date',
                  title: 'Start',
                  text: '2026-04-25',
                  value: JSON.stringify({ date: '2026-04-25' }),
                },
                {
                  id: 'date_b',
                  type: 'date',
                  title: 'End',
                  text: '2026-05-05',
                  value: JSON.stringify({ date: '2026-05-05' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'active', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2010']);
  });
});

describe('monday dev sprint current', () => {
  it('returns the active sprint', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintCurrent',
          response: itemsPageResponse([
            wireItem({
              id: '2001',
              name: 'Past Sprint',
              board_id: '200',
              columns: [
                {
                  id: 'timeline',
                  type: 'timeline',
                  title: 'Timeline',
                  text: '2026-04-01 - 2026-04-15',
                  value: JSON.stringify({ from: '2026-04-01', to: '2026-04-15' }),
                },
              ],
            }),
            wireItem({
              id: '2002',
              name: 'Active Sprint',
              board_id: '200',
              columns: [
                {
                  id: 'timeline',
                  type: 'timeline',
                  title: 'Timeline',
                  text: '2026-04-25 - 2026-05-05',
                  value: JSON.stringify({ from: '2026-04-25', to: '2026-05-05' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'current', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { id: string; name: string } };
    expect(envelope.data.id).toBe('2002');
    expect(envelope.data.name).toBe('Active Sprint');
  });

  it('throws not_found when no sprint is active', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintCurrent',
          response: itemsPageResponse([
            wireItem({
              id: '2001',
              name: 'Past',
              board_id: '200',
              columns: [
                {
                  id: 'timeline',
                  type: 'timeline',
                  title: 'Timeline',
                  text: '2026-04-01 - 2026-04-15',
                  value: JSON.stringify({ from: '2026-04-01', to: '2026-04-15' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'current', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('not_found');
  });
});

describe('monday dev sprint items', () => {
  const buildSprintItemsCassette = (): Cassette => ({
    interactions: [
      {
        operation_name: 'DevSprintItemsHydrate',
        response: hydrateColumnsResponse('100', [
          {
            id: 'rel_sprint',
            type: 'board_relation',
            title: 'Sprint',
            settings_str: JSON.stringify({ boardIds: ['200'] }),
          },
        ]),
      },
      {
        operation_name: 'DevSprintItemsWalk',
        response: itemsPageResponse([
          wireItem({
            id: '1001',
            name: 'Linked task',
            board_id: '100',
            columns: [
              {
                id: 'rel_sprint',
                type: 'board_relation',
                title: 'Sprint',
                text: 'Sprint 24',
                value: JSON.stringify({
                  linkedPulseIds: [{ linkedPulseId: 2002 }],
                }),
              },
            ],
          }),
          wireItem({
            id: '1002',
            name: 'Other sprint task',
            board_id: '100',
            columns: [
              {
                id: 'rel_sprint',
                type: 'board_relation',
                title: 'Sprint',
                text: 'Sprint 25',
                value: JSON.stringify({
                  linkedPulseIds: [{ linkedPulseId: 2003 }],
                }),
              },
            ],
          }),
          wireItem({
            id: '1003',
            name: 'Unlinked task',
            board_id: '100',
            columns: [],
          }),
        ]),
      },
    ],
  });

  it('filters tasks by the configured relation column', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'items', '2002', '--json'],
      env,
      buildSprintItemsCassette(),
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('supports item_ids relation shape', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintItemsHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_sprint',
              type: 'board_relation',
              title: 'Sprint',
              settings_str: JSON.stringify({ boardIds: ['200'] }),
            },
          ]),
        },
        {
          operation_name: 'DevSprintItemsWalk',
          response: itemsPageResponse([
            wireItem({
              id: '1099',
              name: 'New-shape linked',
              board_id: '100',
              columns: [
                {
                  id: 'rel_sprint',
                  type: 'board_relation',
                  title: 'Sprint',
                  text: 'Sprint 24',
                  value: JSON.stringify({ item_ids: [2002] }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'items', '2002', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1099']);
  });

  it('surfaces dev_board_misconfigured when no matching relation column', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintItemsHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_other',
              type: 'board_relation',
              title: 'Other',
              settings_str: JSON.stringify({ boardIds: ['999'] }),
            },
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'items', '2002', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('rejects non-numeric sprint id with usage_error', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'items', 'not-a-number', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });
});

describe('monday dev epic items', () => {
  it('filters tasks by the tasks_to_epics_relation column', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevEpicItemsHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_epic',
              type: 'board_relation',
              title: 'Epic',
              settings_str: JSON.stringify({ boardIds: ['300'] }),
            },
          ]),
        },
        {
          operation_name: 'DevEpicItemsWalk',
          response: itemsPageResponse([
            wireItem({
              id: '1010',
              name: 'Linked task',
              board_id: '100',
              columns: [
                {
                  id: 'rel_epic',
                  type: 'board_relation',
                  title: 'Epic',
                  text: 'Auth Rewrite',
                  value: JSON.stringify({
                    linkedPulseIds: [{ linkedPulseId: 3001 }],
                  }),
                },
              ],
            }),
            wireItem({
              id: '1011',
              name: 'Unrelated',
              board_id: '100',
              columns: [
                {
                  id: 'rel_epic',
                  type: 'board_relation',
                  title: 'Epic',
                  text: '',
                  value: JSON.stringify({ linkedPulseIds: [] }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'items', '3001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1010']);
  });

  it('surfaces dev_board_misconfigured when no matching relation column', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevEpicItemsHydrate',
          response: hydrateColumnsResponse('100', []),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'items', '3001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });
});

// =============================================================
// `monday dev task list`
// =============================================================
describe('monday dev task list', () => {
  const taskRow = (
    id: string,
    name: string,
    statusLabel: string,
    extras: readonly { id: string; type: string; title: string; text?: string | null; value?: string | null }[] = [],
  ): Readonly<Record<string, unknown>> =>
    wireItem({
      id,
      name,
      board_id: '100',
      columns: [
        {
          id: 'status',
          type: 'status',
          title: 'Status',
          text: statusLabel,
          value: JSON.stringify({ label: statusLabel }),
        },
        ...extras,
      ],
    });

  it('walks the tasks board (no filters)', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'A', 'Working on it'),
            taskRow('1002', 'B', 'Done'),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.length).toBe(2);
  });

  it('--status not_done drops Done/Cancelled', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'In progress', 'Working on it'),
            taskRow('1002', 'Finished', 'Done'),
            taskRow('1003', 'Blocked', 'Stuck'),
            taskRow('1004', 'Killed', 'Cancelled'),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--status', 'not_done', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001', '1003']);
  });

  it('--status stuck picks Stuck only', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'A', 'Working on it'),
            taskRow('1002', 'B', 'Stuck'),
            taskRow('1003', 'C', 'Done'),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--status', 'stuck', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1002']);
  });

  it('--mine filters by the resolved user id', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: {
                id: '99',
                name: 'Test User',
                email: 'test@example.com',
                account: { id: '1', name: 'Test', slug: 'test' },
              },
            },
          },
        },
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'Mine', 'Working on it', [
              {
                id: 'owner',
                type: 'people',
                title: 'Owner',
                text: 'Test User',
                value: JSON.stringify({
                  personsAndTeams: [{ id: 99, kind: 'person' }],
                }),
              },
            ]),
            taskRow('1002', 'Theirs', 'Working on it', [
              {
                id: 'owner',
                type: 'people',
                title: 'Owner',
                text: 'Other',
                value: JSON.stringify({
                  personsAndTeams: [{ id: 42, kind: 'person' }],
                }),
              },
            ]),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--mine', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('--sprint <sid> filters by board_relation', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskListHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_sprint',
              type: 'board_relation',
              title: 'Sprint',
              settings_str: JSON.stringify({ boardIds: ['200'] }),
            },
          ]),
        },
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'In sprint', 'Working on it', [
              {
                id: 'rel_sprint',
                type: 'board_relation',
                title: 'Sprint',
                text: 'Sprint 24',
                value: JSON.stringify({
                  linkedPulseIds: [{ linkedPulseId: 2002 }],
                }),
              },
            ]),
            taskRow('1002', 'Other sprint', 'Working on it', [
              {
                id: 'rel_sprint',
                type: 'board_relation',
                title: 'Sprint',
                text: 'Sprint 25',
                value: JSON.stringify({
                  linkedPulseIds: [{ linkedPulseId: 2003 }],
                }),
              },
            ]),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', '2002', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('--sprint current resolves the active sprint first', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskListHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_sprint',
              type: 'board_relation',
              title: 'Sprint',
              settings_str: JSON.stringify({ boardIds: ['200'] }),
            },
          ]),
        },
        {
          operation_name: 'DevTaskListSprintCurrent',
          response: itemsPageResponse([
            wireItem({
              id: '2002',
              name: 'Active Sprint',
              board_id: '200',
              columns: [
                {
                  id: 'timeline',
                  type: 'timeline',
                  title: 'Timeline',
                  text: '2026-04-25 - 2026-05-05',
                  value: JSON.stringify({ from: '2026-04-25', to: '2026-05-05' }),
                },
              ],
            }),
          ]),
        },
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            taskRow('1001', 'In active sprint', 'Working on it', [
              {
                id: 'rel_sprint',
                type: 'board_relation',
                title: 'Sprint',
                text: 'Sprint 24',
                value: JSON.stringify({
                  linkedPulseIds: [{ linkedPulseId: 2002 }],
                }),
              },
            ]),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', 'current', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('--sprint current throws not_found when no active sprint', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskListHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_sprint',
              type: 'board_relation',
              title: 'Sprint',
              settings_str: JSON.stringify({ boardIds: ['200'] }),
            },
          ]),
        },
        {
          operation_name: 'DevTaskListSprintCurrent',
          response: itemsPageResponse([]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', 'current', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('not_found');
  });

  it('rejects malformed --sprint with usage_error', async () => {
    await seedFullMapping(env.home);
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', 'bogus', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });
});

// =============================================================
// `monday dev task start/done/block`
// =============================================================
const taskHydrate = (operation: string): Cassette['interactions'][number] => ({
  operation_name: operation,
  response: hydrateColumnsResponse('100', [
    {
      id: 'status',
      type: 'status',
      title: 'Status',
      settings_str: STOCK_STATUS_SETTINGS,
    },
  ]),
});

const projectedTaskResponse = (
  id: string,
  statusLabel: string,
): Readonly<Record<string, unknown>> => ({
  data: {
    change_simple_column_value: wireItem({
      id,
      name: `Task ${id}`,
      board_id: '100',
      columns: [
        {
          id: 'status',
          type: 'status',
          title: 'Status',
          text: statusLabel,
          value: JSON.stringify({ label: statusLabel }),
        },
      ],
    }),
  },
});

describe('monday dev task start', () => {
  it('flips status to "Working on it"', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskStartHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'Working on it' },
          response: projectedTaskResponse('5001', 'Working on it'),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: { id: string; columns: Record<string, { label?: string }> } };
    expect(envelope.data.id).toBe('5001');
    expect(envelope.data.columns.status?.label).toBe('Working on it');
  });

  it('case-insensitively resolves the canonical label', async () => {
    await seedTasksOnly(env.home, '100');
    // Status column labels in lowercase — verb must resolve "Working
    // on it" → "working on it" exact form and flip with that.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskStartHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'status',
              type: 'status',
              title: 'Status',
              settings_str: JSON.stringify({
                labels: { '0': 'working on it', '1': 'done', '2': 'stuck' },
              }),
            },
          ]),
        },
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'working on it' },
          response: projectedTaskResponse('5001', 'working on it'),
        },
      ],
    };
    const { exitCode } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
  });

  it('surfaces dev_board_misconfigured when no status column', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskStartHydrate',
          response: hydrateColumnsResponse('100', []),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('surfaces dev_board_misconfigured when canonical label missing', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskStartHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'status',
              type: 'status',
              title: 'Status',
              // No "Working on it" label.
              settings_str: JSON.stringify({
                labels: { '0': 'Done', '1': 'Stuck' },
              }),
            },
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('surfaces dev_board_misconfigured when tasks board is not accessible', async () => {
    await seedTasksOnly(env.home, '999');
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskStartHydrate',
          response: { data: { boards: [] } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('rejects non-numeric item id with usage_error', async () => {
    await seedTasksOnly(env.home, '100');
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', 'not-a-number', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });
});

describe('monday dev task done', () => {
  it('flips status to "Done" without --message (no side-effect)', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskDoneHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'Done' },
          response: projectedTaskResponse('5001', 'Done'),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'done', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      data: { columns: Record<string, { label?: string }> };
      side_effects?: readonly unknown[];
    };
    expect(envelope.data.columns.status?.label).toBe('Done');
    expect(envelope.side_effects).toBeUndefined();
  });

  it('fires create_update side-effect when --message is supplied', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskDoneHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'Done' },
          response: projectedTaskResponse('5001', 'Done'),
        },
        {
          operation_name: 'DevTaskDoneCreateUpdate',
          match_variables: { body: 'Shipped in v0.3.0' },
          response: {
            data: { create_update: { id: '90001' } },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      [
        'dev',
        'task',
        'done',
        '5001',
        '--message',
        'Shipped in v0.3.0',
        '--json',
      ],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      side_effects: readonly { kind: string; update_id: string; body: string }[];
    };
    expect(envelope.side_effects).toBeDefined();
    expect(envelope.side_effects[0]?.kind).toBe('update_created');
    expect(envelope.side_effects[0]?.update_id).toBe('90001');
    expect(envelope.side_effects[0]?.body).toBe('Shipped in v0.3.0');
  });

  it('surfaces internal_error when create_update returns null', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskDoneHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Done'),
        },
        {
          operation_name: 'DevTaskDoneCreateUpdate',
          response: { data: { create_update: null } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'done', '5001', '--message', 'note', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('internal_error');
  });
});

describe('monday dev task block', () => {
  it('flips status to "Stuck" + posts the --reason as a side-effect', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskBlockHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'Stuck' },
          response: projectedTaskResponse('5001', 'Stuck'),
        },
        {
          operation_name: 'DevTaskBlockCreateUpdate',
          match_variables: { body: 'Waiting on legal review' },
          response: { data: { create_update: { id: '90002' } } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      [
        'dev',
        'task',
        'block',
        '5001',
        '--reason',
        'Waiting on legal review',
        '--json',
      ],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      data: { columns: Record<string, { label?: string }> };
      side_effects: readonly { kind: string; update_id: string; body: string }[];
    };
    expect(envelope.data.columns.status?.label).toBe('Stuck');
    expect(envelope.side_effects[0]?.kind).toBe('update_created');
    expect(envelope.side_effects[0]?.update_id).toBe('90002');
    expect(envelope.side_effects[0]?.body).toBe('Waiting on legal review');
  });

  it('rejects missing --reason with usage_error', async () => {
    await seedTasksOnly(env.home, '100');
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'block', '5001', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('usage_error');
  });

  it('surfaces internal_error when create_update returns null', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskBlockHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Stuck'),
        },
        {
          operation_name: 'DevTaskBlockCreateUpdate',
          response: { data: { create_update: null } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'block', '5001', '--reason', 'why', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('internal_error');
  });
});

// =============================================================
// Branch-coverage backfills (M26b)
// =============================================================
describe('M26b branch-coverage backfills', () => {
  it('task list --status done picks Done + Cancelled rows', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            wireItem({
              id: '1001',
              name: 'A',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Done',
                  value: JSON.stringify({ label: 'Done' }),
                },
              ],
            }),
            wireItem({
              id: '1002',
              name: 'B',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Working on it',
                  value: JSON.stringify({ label: 'Working on it' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--status', 'done', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('task list --status working_on_it picks Working on it rows', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            wireItem({
              id: '1001',
              name: 'A',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Working on it',
                  value: JSON.stringify({ label: 'Working on it' }),
                },
              ],
            }),
            wireItem({
              id: '1002',
              name: 'B',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Done',
                  value: JSON.stringify({ label: 'Done' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--status', 'working_on_it', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('task list --sprint <sid> surfaces dev_board_misconfigured when no relation column targets sprints_board', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskListHydrate',
          response: hydrateColumnsResponse('100', []),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', '999', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('epic list resolves state via the projected `text` fallback when `label` is absent', async () => {
    await seedFullMapping(env.home);
    // Project a status column with non-null text + empty label.
    // Tests epic/list.ts:66-67 (text fallback branch).
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevEpicList',
          response: itemsPageResponse([
            wireItem({
              id: '3001',
              name: 'Text-only Done',
              board_id: '300',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Done',
                  // `value` JSON with no `label` field — projector
                  // surfaces `label: null` so the text-fallback path
                  // fires.
                  value: JSON.stringify({}),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'list', '--state', 'done', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['3001']);
  });

  it('sprint list supports single date column (single-day range)', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintList',
          response: itemsPageResponse([
            wireItem({
              id: '2030',
              name: 'Single-day sprint',
              board_id: '200',
              columns: [
                {
                  id: 'date_a',
                  type: 'date',
                  title: 'Date',
                  text: '2026-04-30',
                  value: JSON.stringify({ date: '2026-04-30' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'active', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2030']);
  });

  it('sprint list reorders reversed date columns (start > end gets swapped)', async () => {
    await seedFullMapping(env.home);
    // Column id alphabetic order puts the LATER date first; the
    // extractor must order-normalise (sprint/list.ts:115).
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevSprintList',
          response: itemsPageResponse([
            wireItem({
              id: '2040',
              name: 'Reversed-pair Sprint',
              board_id: '200',
              columns: [
                {
                  id: 'date_a_end',
                  type: 'date',
                  title: 'End',
                  text: '2026-05-05',
                  value: JSON.stringify({ date: '2026-05-05' }),
                },
                {
                  id: 'date_b_start',
                  type: 'date',
                  title: 'Start',
                  text: '2026-04-25',
                  value: JSON.stringify({ date: '2026-04-25' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'sprint', 'list', '--state', 'active', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['2040']);
  });

  it('epic items skips tasks without the relation column', async () => {
    await seedFullMapping(env.home);
    // epic/items.ts:127 — `if (relCol === undefined) return false;`
    // exercised by a task row missing the configured relation
    // column entirely.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevEpicItemsHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_epic',
              type: 'board_relation',
              title: 'Epic',
              settings_str: JSON.stringify({ boardIds: ['300'] }),
            },
          ]),
        },
        {
          operation_name: 'DevEpicItemsWalk',
          response: itemsPageResponse([
            wireItem({
              id: '1010',
              name: 'No relation column',
              board_id: '100',
              columns: [],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'epic', 'items', '3001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly unknown[] };
    expect(envelope.data.length).toBe(0);
  });

  it('task list --status falls back to text when projected label is null', async () => {
    await seedFullMapping(env.home);
    // Exercises task/list.ts:73-75 — when the status value JSON
    // doesn't carry `label`, the projector surfaces `label: null`
    // and the fallback reads `text`.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            wireItem({
              id: '1001',
              name: 'Done via text',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Done',
                  value: JSON.stringify({}),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--status', 'done', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly { id: string }[] };
    expect(envelope.data.map((d) => d.id)).toEqual(['1001']);
  });

  it('task start echoes resolved_ids.status (Codex round-1 P2-1)', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskStartHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          match_variables: { value: 'Working on it' },
          response: projectedTaskResponse('5001', 'Working on it'),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'start', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      resolved_ids: Record<string, string>;
    };
    expect(envelope.resolved_ids).toEqual({ status: 'status' });
  });

  it('task done echoes resolved_ids.status (Codex round-1 P2-1)', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskDoneHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Done'),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'done', '5001', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      resolved_ids: Record<string, string>;
    };
    expect(envelope.resolved_ids).toEqual({ status: 'status' });
  });

  it('task block echoes resolved_ids.status (Codex round-1 P2-1)', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskBlockHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Stuck'),
        },
        {
          operation_name: 'DevTaskBlockCreateUpdate',
          response: { data: { create_update: { id: '90099' } } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'block', '5001', '--reason', 'why', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.stdout()) as {
      resolved_ids: Record<string, string>;
    };
    expect(envelope.resolved_ids).toEqual({ status: 'status' });
  });

  it('task block create_update wire query is named to match the operationName (Codex round-2 P1-1)', async () => {
    await seedTasksOnly(env.home, '100');
    // The cassette match_query string asserts the GraphQL document
    // carries the named operation `DevTaskBlockCreateUpdate`, which
    // MUST match the operationName field on the wire body.
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskBlockHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Stuck'),
        },
        {
          operation_name: 'DevTaskBlockCreateUpdate',
          match_query: 'mutation DevTaskBlockCreateUpdate',
          response: { data: { create_update: { id: '90201' } } },
        },
      ],
    };
    const { exitCode } = await driveDev(
      ['dev', 'task', 'block', '5001', '--reason', 'reason', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
  });

  it('task done create_update wire query is named to match the operationName (Codex round-2 P1-1)', async () => {
    await seedTasksOnly(env.home, '100');
    const cassette: Cassette = {
      interactions: [
        taskHydrate('DevTaskDoneHydrate'),
        {
          operation_name: 'ItemUpdateSimple',
          response: projectedTaskResponse('5001', 'Done'),
        },
        {
          operation_name: 'DevTaskDoneCreateUpdate',
          match_query: 'mutation DevTaskDoneCreateUpdate',
          response: { data: { create_update: { id: '90202' } } },
        },
      ],
    };
    const { exitCode } = await driveDev(
      ['dev', 'task', 'done', '5001', '--message', 'done!', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
  });

  it('walkDevBoardItems lets genuine schema drift surface as internal_error, not dev_board_misconfigured (Codex round-2 P2-1)', async () => {
    await seedFullMapping(env.home);
    // Boards array has one entry but items_page is malformed
    // (missing cursor key). Parse-boundary issue is NOT
    // `boards`/`too_small` → walkDevBoardItems must NOT rewrap.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevReleaseList',
          response: {
            data: {
              boards: [
                {
                  items_page: {
                    // missing `cursor` key — schema rejects
                    items: [],
                  },
                },
              ],
            },
          },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('internal_error');
  });

  it('release list surfaces dev_board_misconfigured when configured board is inaccessible (Codex round-1 P2-2)', async () => {
    await seedFullMapping(env.home);
    // Monday returns `{boards: []}` when the configured board ID
    // can't be hydrated (deleted / access revoked / never existed).
    // walkDevBoardItems rewraps `internal_error` → `dev_board_misconfigured`.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevReleaseList',
          response: { data: { boards: [] } },
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'release', 'list', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(2);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('dev_board_misconfigured');
  });

  it('task list --sprint <sid> skips tasks without the relation column', async () => {
    await seedFullMapping(env.home);
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DevTaskListHydrate',
          response: hydrateColumnsResponse('100', [
            {
              id: 'rel_sprint',
              type: 'board_relation',
              title: 'Sprint',
              settings_str: JSON.stringify({ boardIds: ['200'] }),
            },
          ]),
        },
        {
          operation_name: 'DevTaskList',
          response: itemsPageResponse([
            wireItem({
              id: '1001',
              name: 'No relation column',
              board_id: '100',
              columns: [
                {
                  id: 'status',
                  type: 'status',
                  title: 'Status',
                  text: 'Working on it',
                  value: JSON.stringify({ label: 'Working on it' }),
                },
              ],
            }),
          ]),
        },
      ],
    };
    const { exitCode, captured } = await driveDev(
      ['dev', 'task', 'list', '--sprint', '999', '--json'],
      env,
      cassette,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout()) as ReturnType<
      typeof parseEnvelope
    > & { data: readonly unknown[] };
    expect(envelope.data.length).toBe(0);
  });
});
