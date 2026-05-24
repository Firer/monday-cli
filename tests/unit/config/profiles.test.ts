/**
 * Unit tests for `src/config/profiles.ts` runtime bodies (v0.3-M21
 * implementation Part 1). Schemas + constants surface unchanged from
 * pre-flight.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  PROFILES_CONFIG_FILE_NAME,
  PROFILES_DIR_NAME,
  PROFILE_DEFAULTS_KEYS,
  loadProfilesConfig,
  mutateProfileDefaultsInPlace,
  profileDefaultsBlockSchema,
  profileDevBlockSchema,
  profileEntrySchema,
  profilesConfigSchema,
  resolveProfilesConfigPath,
  selectProfile,
  writeProfilesConfig,
  type ProfileEntry,
  type ProfilesConfig,
  type SelectProfileResult,
} from '../../../src/config/profiles.js';
import { ConfigError } from '../../../src/utils/errors.js';

describe('profiles — constants', () => {
  it('PROFILES_CONFIG_FILE_NAME is "config.toml"', () => {
    expect(PROFILES_CONFIG_FILE_NAME).toBe('config.toml');
  });

  it('PROFILES_DIR_NAME is ".monday-cli" (shared with credentials cache)', () => {
    expect(PROFILES_DIR_NAME).toBe('.monday-cli');
  });
});

describe('profileEntrySchema', () => {
  it('accepts a fully-populated entry', () => {
    const entry: ProfileEntry = profileEntrySchema.parse({
      api_token_env: 'MONDAY_API_TOKEN_WORK',
      api_version: '2026-01',
      default_workspace: '1234567',
      timezone: 'Europe/London',
      dev: {
        tasks_board: '987654',
        sprints_board: '987655',
      },
    });
    expect(entry.api_token_env).toBe('MONDAY_API_TOKEN_WORK');
    expect(entry.dev?.tasks_board).toBe('987654');
  });

  it('accepts a bare entry (no fields)', () => {
    const entry = profileEntrySchema.parse({});
    expect(entry).toEqual({});
  });

  it('rejects an entry that smuggles a token (no-token-in-config rule, structural exclusion)', () => {
    expect(() =>
      profileEntrySchema.parse({ api_token: 'tok-fixture-xxxx' }),
    ).toThrow();
    expect(() =>
      profileEntrySchema.parse({ access_token: 'tok-fixture-xxxx' }),
    ).toThrow();
    expect(() =>
      profileEntrySchema.parse({ secret: 'tok-fixture-xxxx' }),
    ).toThrow();
    expect(() =>
      profileEntrySchema.parse({ token: 'tok-fixture-xxxx' }),
    ).toThrow();
  });

  it('rejects token-looking values smuggled under api_token_env (value-level shape check)', () => {
    expect(() =>
      profileEntrySchema.parse({ api_token_env: 'tok-fixture-xxxx' }),
    ).toThrow(/env-var name/u);
    expect(() =>
      profileEntrySchema.parse({ api_token_env: 'eyJhbGciOiJIUzI1NiJ9.payload.sig' }),
    ).toThrow(/env-var name/u);
    expect(() =>
      profileEntrySchema.parse({ api_token_env: 'monday_token' }),
    ).toThrow(/env-var name/u);
    expect(() =>
      profileEntrySchema.parse({ api_token_env: '1MONDAY' }),
    ).toThrow(/env-var name/u);
  });

  it('accepts canonical env-var names', () => {
    expect(
      profileEntrySchema.parse({ api_token_env: 'MONDAY_API_TOKEN' })
        .api_token_env,
    ).toBe('MONDAY_API_TOKEN');
    expect(
      profileEntrySchema.parse({ api_token_env: 'MONDAY_API_TOKEN_WORK' })
        .api_token_env,
    ).toBe('MONDAY_API_TOKEN_WORK');
    expect(
      profileEntrySchema.parse({ api_token_env: '_LEADING_UNDERSCORE_OK' })
        .api_token_env,
    ).toBe('_LEADING_UNDERSCORE_OK');
  });

  it('regex boundary cases — single uppercase accepted, single lowercase rejected', () => {
    expect(
      profileEntrySchema.parse({ api_token_env: 'A' }).api_token_env,
    ).toBe('A');
    expect(() =>
      profileEntrySchema.parse({ api_token_env: 'a' }),
    ).toThrow(/env-var name/u);
  });

  it('rejects malformed api_version (regex enforced)', () => {
    expect(() =>
      profileEntrySchema.parse({ api_version: '2026' }),
    ).toThrow();
    expect(() =>
      profileEntrySchema.parse({ api_version: 'spring-2026' }),
    ).toThrow();
  });

  it('accepts a valid YYYY-MM api_version', () => {
    const entry = profileEntrySchema.parse({ api_version: '2026-01' });
    expect(entry.api_version).toBe('2026-01');
  });
});

describe('profileDevBlockSchema', () => {
  it('accepts the M26 dev-namespace board mappings', () => {
    const block = profileDevBlockSchema.parse({
      tasks_board: '1',
      sprints_board: '2',
      epics_board: '3',
      bugs_board: '4',
      releases_board: '5',
    });
    expect(block.tasks_board).toBe('1');
  });

  it('accepts an empty block (every field optional)', () => {
    expect(profileDevBlockSchema.parse({})).toEqual({});
  });

  it('rejects unknown keys (.strict())', () => {
    expect(() =>
      profileDevBlockSchema.parse({ unknown_dev_key: '1' }),
    ).toThrow();
  });
});

describe('profilesConfigSchema', () => {
  it('accepts the §7.2 documented shape', () => {
    const config: ProfilesConfig = profilesConfigSchema.parse({
      default_profile: 'work',
      profiles: {
        work: {
          api_token_env: 'MONDAY_API_TOKEN_WORK',
          api_version: '2026-01',
          default_workspace: '1234567',
          dev: {
            tasks_board: '987654',
          },
        },
        personal: {
          api_token_env: 'MONDAY_API_TOKEN_PERSONAL',
        },
      },
    });
    expect(config.default_profile).toBe('work');
    expect(Object.keys(config.profiles)).toEqual(['work', 'personal']);
  });

  it('accepts a config without default_profile', () => {
    const config = profilesConfigSchema.parse({
      profiles: { work: {} },
    });
    expect(config.default_profile).toBeUndefined();
  });

  it('rejects unknown top-level keys (.strict())', () => {
    expect(() =>
      profilesConfigSchema.parse({
        profiles: {},
        extra_top_level: 'x',
      }),
    ).toThrow();
  });
});

describe('profiles — type-level surface', () => {
  it('SelectProfileResult is a discriminated union over `mode`', () => {
    const named: SelectProfileResult = {
      mode: 'named',
      name: 'work',
      entry: { api_token_env: 'MONDAY_API_TOKEN_WORK' },
    };
    const implicit: SelectProfileResult = { mode: 'implicit_v1' };
    expect(named.mode).toBe('named');
    expect(implicit.mode).toBe('implicit_v1');
  });
});

describe('resolveProfilesConfigPath', () => {
  it('joins home + .monday-cli + config.toml', () => {
    expect(resolveProfilesConfigPath({ home: '/tmp/fake-home' })).toBe(
      '/tmp/fake-home/.monday-cli/config.toml',
    );
  });

  it('falls back to homedir() when home is omitted', () => {
    const path = resolveProfilesConfigPath();
    expect(path.endsWith('/.monday-cli/config.toml')).toBe(true);
  });
});

const writeConfigToml = async (home: string, content: string): Promise<void> => {
  const dir = join(home, PROFILES_DIR_NAME);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, PROFILES_CONFIG_FILE_NAME), content, 'utf8');
};

describe('loadProfilesConfig (runtime TOML parse)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-profiles-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns undefined on ENOENT (typical first-run state — implicit v1 mode)', async () => {
    await expect(loadProfilesConfig({ home })).resolves.toBeUndefined();
  });

  it('parses a §7.2 multi-profile TOML file', async () => {
    await writeConfigToml(
      home,
      [
        'default_profile = "work"',
        '',
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        'api_version = "2026-01"',
        '',
        '[profiles.personal]',
        'api_token_env = "MONDAY_API_TOKEN_PERSONAL"',
        '',
      ].join('\n'),
    );
    const config = await loadProfilesConfig({ home });
    expect(config?.default_profile).toBe('work');
    expect(Object.keys(config?.profiles ?? {})).toEqual(['work', 'personal']);
    expect(config?.profiles.work?.api_token_env).toBe('MONDAY_API_TOKEN_WORK');
  });

  it('parses [profiles.<name>.dev] sub-tables', async () => {
    await writeConfigToml(
      home,
      [
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
        '',
        '[profiles.work.dev]',
        'tasks_board = "987654"',
        'sprints_board = "987655"',
        '',
      ].join('\n'),
    );
    const config = await loadProfilesConfig({ home });
    expect(config?.profiles.work?.dev?.tasks_board).toBe('987654');
  });

  it('rejects malformed TOML with config_error', async () => {
    await writeConfigToml(home, '[profiles.work\nno-closing-bracket = "x"');
    await expect(loadProfilesConfig({ home })).rejects.toBeInstanceOf(
      ConfigError,
    );
    try {
      await loadProfilesConfig({ home });
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('config_error');
      expect((err as ConfigError).message).toMatch(/malformed TOML/u);
    }
  });

  it('rejects token smuggled under api_token_env at parse boundary', async () => {
    await writeConfigToml(
      home,
      ['[profiles.work]', 'api_token_env = "tok-fixture-xxxx"'].join('\n'),
    );
    await expect(loadProfilesConfig({ home })).rejects.toBeInstanceOf(
      ConfigError,
    );
    try {
      await loadProfilesConfig({ home });
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).message).toMatch(/env-var name/u);
    }
  });

  it('rejects unknown top-level keys with config_error', async () => {
    await writeConfigToml(
      home,
      [
        'unknown_top_level = "rejected"',
        '[profiles.work]',
        'api_token_env = "MONDAY_API_TOKEN_WORK"',
      ].join('\n'),
    );
    await expect(loadProfilesConfig({ home })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('selectProfile', () => {
  const buildConfig = (overrides: Partial<ProfilesConfig> = {}): ProfilesConfig => ({
    profiles: {
      work: { api_token_env: 'MONDAY_API_TOKEN_WORK' },
      personal: { api_token_env: 'MONDAY_API_TOKEN_PERSONAL' },
    },
    ...overrides,
  });

  it('returns implicit_v1 when nothing names a profile and no config file exists', () => {
    const result = selectProfile({
      flag: undefined,
      env: {},
      config: undefined,
    });
    expect(result.mode).toBe('implicit_v1');
  });

  it('returns implicit_v1 when config exists but no default_profile and no flag/env', () => {
    const result = selectProfile({
      flag: undefined,
      env: {},
      config: buildConfig(),
    });
    expect(result.mode).toBe('implicit_v1');
  });

  it('uses --profile flag over MONDAY_PROFILE env (precedence)', () => {
    const result = selectProfile({
      flag: 'work',
      env: { MONDAY_PROFILE: 'personal' },
      config: buildConfig(),
    });
    expect(result.mode).toBe('named');
    if (result.mode === 'named') {
      expect(result.name).toBe('work');
    }
  });

  it('uses MONDAY_PROFILE env when --profile flag is absent', () => {
    const result = selectProfile({
      flag: undefined,
      env: { MONDAY_PROFILE: 'personal' },
      config: buildConfig(),
    });
    expect(result.mode).toBe('named');
    if (result.mode === 'named') {
      expect(result.name).toBe('personal');
    }
  });

  it('uses default_profile when no flag and no env', () => {
    const result = selectProfile({
      flag: undefined,
      env: {},
      config: buildConfig({ default_profile: 'work' }),
    });
    expect(result.mode).toBe('named');
    if (result.mode === 'named') {
      expect(result.name).toBe('work');
    }
  });

  it('returns synthetic empty entry when --profile is set + no config (credentials-cache-only flow)', () => {
    const result = selectProfile({
      flag: 'work',
      env: {},
      config: undefined,
    });
    expect(result.mode).toBe('named');
    if (result.mode === 'named') {
      expect(result.name).toBe('work');
      expect(result.entry).toEqual({});
    }
  });

  it('returns synthetic empty entry when MONDAY_PROFILE is set + no config', () => {
    const result = selectProfile({
      flag: undefined,
      env: { MONDAY_PROFILE: 'work' },
      config: undefined,
    });
    expect(result.mode).toBe('named');
    if (result.mode === 'named') {
      expect(result.name).toBe('work');
      expect(result.entry).toEqual({});
    }
  });

  it('throws config_error when MONDAY_PROFILE names an unknown profile (env source branch)', () => {
    expect(() =>
      selectProfile({
        flag: undefined,
        env: { MONDAY_PROFILE: 'unknown' },
        config: buildConfig(),
      }),
    ).toThrow(ConfigError);
    try {
      selectProfile({
        flag: undefined,
        env: { MONDAY_PROFILE: 'unknown' },
        config: buildConfig(),
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.details?.source).toBe('MONDAY_PROFILE env');
    }
  });

  it('throws config_error when --profile names an unknown profile in config.profiles', () => {
    expect(() =>
      selectProfile({
        flag: 'unknown',
        env: {},
        config: buildConfig(),
      }),
    ).toThrow(ConfigError);
    try {
      selectProfile({
        flag: 'unknown',
        env: {},
        config: buildConfig(),
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.code).toBe('config_error');
      expect(ce.details?.available_profiles).toEqual(['work', 'personal']);
    }
  });

  it('throws config_error when default_profile names an unknown profile', () => {
    expect(() =>
      selectProfile({
        flag: undefined,
        env: {},
        config: buildConfig({ default_profile: 'ghost' }),
      }),
    ).toThrow(ConfigError);
  });

  it('treats empty-string flag/env as undefined (falls through)', () => {
    const result = selectProfile({
      flag: '',
      env: { MONDAY_PROFILE: '' },
      config: undefined,
    });
    expect(result.mode).toBe('implicit_v1');
  });
});

// =====================================================================
// v0.12-M55-E — profile-scoped argument defaults
// =====================================================================

describe('PROFILE_DEFAULTS_KEYS — allowlist contract', () => {
  it('enumerates exactly the 4 keys cli-design §7.2.1 pins', () => {
    expect([...PROFILE_DEFAULTS_KEYS]).toEqual([
      'board',
      'workspace',
      'output',
      'concurrency',
    ]);
  });
});

describe('profileDefaultsBlockSchema', () => {
  it('accepts a fully-populated block', () => {
    const block = profileDefaultsBlockSchema.parse({
      board: '987654',
      workspace: '1234567',
      output: 'table',
      concurrency: 4,
    });
    expect(block.board).toBe('987654');
    expect(block.concurrency).toBe(4);
  });

  it('accepts an empty block (every key optional)', () => {
    expect(profileDefaultsBlockSchema.parse({})).toEqual({});
  });

  it('rejects unknown keys via .strict() (closes spoofing path for top-level slots)', () => {
    expect(() =>
      profileDefaultsBlockSchema.parse({ api_token_env: 'X' }),
    ).toThrow();
    expect(() =>
      profileDefaultsBlockSchema.parse({ api_token: 'tok-xxxx' }),
    ).toThrow();
  });

  it('rejects non-numeric board / workspace ID (wrong_defaults_type surface)', () => {
    expect(() => profileDefaultsBlockSchema.parse({ board: 'foo' })).toThrow();
    expect(() =>
      profileDefaultsBlockSchema.parse({ workspace: 'abc123' }),
    ).toThrow();
  });

  it('rejects an output value outside OUTPUT_FORMATS', () => {
    expect(() =>
      profileDefaultsBlockSchema.parse({ output: 'yaml' }),
    ).toThrow();
  });

  it('accepts each of json|table|text|ndjson for output (full OUTPUT_FORMATS — narrowing was the Codex pre-flight R1 P2-2 catch)', () => {
    for (const value of ['json', 'table', 'text', 'ndjson'] as const) {
      const block = profileDefaultsBlockSchema.parse({ output: value });
      expect(block.output).toBe(value);
    }
  });

  it('rejects negative / zero / non-integer concurrency', () => {
    expect(() =>
      profileDefaultsBlockSchema.parse({ concurrency: -1 }),
    ).toThrow();
    expect(() =>
      profileDefaultsBlockSchema.parse({ concurrency: 0 }),
    ).toThrow();
    expect(() =>
      profileDefaultsBlockSchema.parse({ concurrency: 1.5 }),
    ).toThrow();
  });
});

describe('profileEntrySchema — defaults slot integration', () => {
  it('accepts an entry with the new defaults slot alongside existing slots', () => {
    const entry = profileEntrySchema.parse({
      api_token_env: 'MONDAY_API_TOKEN_WORK',
      defaults: { board: '987654', output: 'table' },
    });
    expect(entry.defaults?.board).toBe('987654');
    expect(entry.defaults?.output).toBe('table');
  });

  it('accepts an entry without a defaults slot (optional, M21 backwards-compatible)', () => {
    const entry = profileEntrySchema.parse({
      api_token_env: 'MONDAY_API_TOKEN_WORK',
    });
    expect(entry.defaults).toBeUndefined();
  });

  it('rejects bare-string token in the defaults slot (token-storage rule preserved at write-back)', () => {
    expect(() =>
      profileEntrySchema.parse({
        defaults: { api_token_env: 'X' },
      }),
    ).toThrow();
  });
});

describe('mutateProfileDefaultsInPlace', () => {
  const baseConfig: ProfilesConfig = {
    profiles: {
      work: {
        api_token_env: 'MONDAY_API_TOKEN_WORK',
        defaults: { board: '987654', output: 'table' },
      },
    },
  };

  it('set: adds a new key to an existing defaults block', () => {
    const { next, result } = mutateProfileDefaultsInPlace(baseConfig, {
      profile: 'work',
      mode: 'set',
      key: 'workspace',
      value: '1234567',
    });
    expect(result.previousValue).toBeUndefined();
    expect(next.profiles.work.defaults).toEqual({
      board: '987654',
      output: 'table',
      workspace: '1234567',
    });
  });

  it('set: overwrites an existing key and reports previous_value', () => {
    const { next, result } = mutateProfileDefaultsInPlace(baseConfig, {
      profile: 'work',
      mode: 'set',
      key: 'board',
      value: '12345',
    });
    expect(result.previousValue).toBe('987654');
    expect(next.profiles.work.defaults?.board).toBe('12345');
  });

  it('set: bootstraps a fresh profile entry when the named profile is absent', () => {
    const { next } = mutateProfileDefaultsInPlace(undefined, {
      profile: 'work',
      mode: 'set',
      key: 'board',
      value: '12345',
    });
    expect(next.profiles.work.defaults?.board).toBe('12345');
  });

  it('unset: removes the key and reports its prior value', () => {
    const { next, result } = mutateProfileDefaultsInPlace(baseConfig, {
      profile: 'work',
      mode: 'unset',
      key: 'board',
    });
    expect(result.previousValue).toBe('987654');
    expect(next.profiles.work.defaults).toEqual({ output: 'table' });
  });

  it('unset: drops the defaults block entirely when the last key is removed', () => {
    const single: ProfilesConfig = {
      profiles: {
        work: {
          api_token_env: 'MONDAY_API_TOKEN_WORK',
          defaults: { board: '987654' },
        },
      },
    };
    const { next } = mutateProfileDefaultsInPlace(single, {
      profile: 'work',
      mode: 'unset',
      key: 'board',
    });
    expect(next.profiles.work.defaults).toBeUndefined();
  });

  it('unset: idempotent on an absent key — returns previousValue undefined', () => {
    const { next, result } = mutateProfileDefaultsInPlace(baseConfig, {
      profile: 'work',
      mode: 'unset',
      key: 'concurrency',
    });
    expect(result.previousValue).toBeUndefined();
    expect(next.profiles.work.defaults).toEqual({
      board: '987654',
      output: 'table',
    });
  });

  it('preserves sibling slots (api_token_env, dev block) when mutating defaults', () => {
    const withDev: ProfilesConfig = {
      profiles: {
        work: {
          api_token_env: 'MONDAY_API_TOKEN_WORK',
          dev: { tasks_board: '11', sprints_board: '22' },
          defaults: { board: '987654' },
        },
      },
    };
    const { next } = mutateProfileDefaultsInPlace(withDev, {
      profile: 'work',
      mode: 'set',
      key: 'output',
      value: 'json',
    });
    expect(next.profiles.work.api_token_env).toBe('MONDAY_API_TOKEN_WORK');
    expect(next.profiles.work.dev?.tasks_board).toBe('11');
    expect(next.profiles.work.defaults?.output).toBe('json');
  });
});

describe('writeProfilesConfig — atomic round-trip', () => {
  let tmpHome: string;

  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    tmpHome = await mkdtemp(join(tmpdir(), 'profiles-config-write-'));
  });

  afterEach(async () => {
    await rm(tmpHome, { recursive: true, force: true });
  });

  it('round-trips a config write → loadProfilesConfig (canonical TOML)', async () => {
    const config: ProfilesConfig = {
      profiles: {
        work: {
          api_token_env: 'MONDAY_API_TOKEN_WORK',
          defaults: { board: '987654', concurrency: 4 },
        },
      },
    };
    await writeProfilesConfig(config, { home: tmpHome });
    const reloaded = await loadProfilesConfig({ home: tmpHome });
    expect(reloaded?.profiles.work.defaults).toEqual({
      board: '987654',
      concurrency: 4,
    });
  });

  it('writes the config file with mode 0o600 (security.md disk discipline)', async () => {
    await writeProfilesConfig(
      {
        profiles: {
          work: { defaults: { board: '987654' } },
        },
      },
      { home: tmpHome },
    );
    const { stat } = await import('node:fs/promises');
    const stats = await stat(
      join(tmpHome, PROFILES_DIR_NAME, PROFILES_CONFIG_FILE_NAME),
    );
    // Drop the file-type bits (S_IFMT), keep the permission triplet.
     
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('drops empty defaults blocks at write time (clean TOML output)', async () => {
    const { next } = mutateProfileDefaultsInPlace(
      {
        profiles: {
          work: {
            api_token_env: 'MONDAY_API_TOKEN_WORK',
            defaults: { board: '987654' },
          },
        },
      },
      { profile: 'work', mode: 'unset', key: 'board' },
    );
    await writeProfilesConfig(next, { home: tmpHome });
    const written = await readFile(
      join(tmpHome, PROFILES_DIR_NAME, PROFILES_CONFIG_FILE_NAME),
      'utf8',
    );
    expect(written).not.toContain('[profiles.work.defaults]');
    expect(written).toContain('api_token_env');
  });
});
