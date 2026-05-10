/**
 * Unit tests for `src/config/profiles.ts` runtime bodies (v0.3-M21
 * implementation Part 1). Schemas + constants surface unchanged from
 * pre-flight.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROFILES_CONFIG_FILE_NAME,
  PROFILES_DIR_NAME,
  loadProfilesConfig,
  profileDevBlockSchema,
  profileEntrySchema,
  profilesConfigSchema,
  resolveProfilesConfigPath,
  selectProfile,
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
