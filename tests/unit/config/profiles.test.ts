/**
 * Unit tests for the v0.3-M21 pre-flight `src/config/profiles.ts`
 * surface. Schemas validate the documented §7.2 TOML shape; runtime
 * bodies (TOML parse, file I/O, source-order resolution) land at M21
 * implementation.
 */

import { describe, expect, it } from 'vitest';
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
import { ApiError } from '../../../src/utils/errors.js';

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
    // The .strict() mode rejects unknown keys; this test pins the
    // structural exclusion that defends the security rule against
    // commonly-named token-bearing fields.
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
    // The Codex round-1 P2 catch: structural exclusion alone is not
    // enough — a user could write `api_token_env = "tok-fixture-xxxx"`
    // (the literal token value, not an env-var name). The regex
    // /^[A-Z_][A-Z0-9_]*$/u rejects token-looking values.
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
    // Round-2 P3: `A` is a valid (if odd) env-var name; `a` is not
    // (POSIX-style env vars are conventionally uppercase).
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

describe('profiles — pre-flight stubs', () => {
  // All stubs throw `ApiError('internal_error', ...)` per the
  // M19/M20 pre-flight discipline (Codex round-1 P2 fix-up).

  it('resolveProfilesConfigPath throws ApiError(internal_error)', () => {
    expect(() => resolveProfilesConfigPath()).toThrow(ApiError);
    try {
      resolveProfilesConfigPath();
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as ApiError).code).toBe('internal_error');
    }
  });

  it('loadProfilesConfig rejects with ApiError(internal_error)', async () => {
    await expect(loadProfilesConfig()).rejects.toBeInstanceOf(ApiError);
  });

  it('selectProfile throws ApiError(internal_error)', () => {
    expect(() =>
      selectProfile({
        flag: 'work',
        env: {},
        config: undefined,
      }),
    ).toThrow(ApiError);
  });
});
