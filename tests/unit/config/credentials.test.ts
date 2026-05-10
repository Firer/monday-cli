/**
 * Unit tests for `src/config/credentials.ts` runtime bodies (v0.3-M21
 * implementation Part 1).
 *
 * The schemas + constants surface is unchanged from pre-flight. The
 * stub-body assertions are replaced with real I/O assertions against
 * a tmp-dir `home`.
 */

import { mkdtemp, rm, writeFile, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CREDENTIALS_DIR_NAME,
  CREDENTIALS_FILE_MODE,
  CREDENTIALS_FILE_NAME,
  CREDENTIALS_INSECURE_BITS,
  CREDENTIALS_SCHEMA_VERSION,
  credentialsFileSchema,
  deleteProfileCredentials,
  profileEntrySchema,
  readCredentials,
  resolveCredentialsPath,
  resolveProfileToken,
  setProfileCredentials,
  writeCredentials,
  type CredentialsFile,
  type ProfileEntry,
  type ProfileTokenSource,
  type ResolvedProfileToken,
} from '../../../src/config/credentials.js';
import { ConfigError } from '../../../src/utils/errors.js';

describe('credentials — constants', () => {
  it('CREDENTIALS_FILE_MODE is 0o600 (mirrors src/api/cache.ts)', () => {
    expect(CREDENTIALS_FILE_MODE).toBe(0o600);
  });

  it('CREDENTIALS_INSECURE_BITS is 0o077 (group + world bits)', () => {
    expect(CREDENTIALS_INSECURE_BITS).toBe(0o077);
  });

  it('CREDENTIALS_SCHEMA_VERSION pins to "1" for v0.3', () => {
    expect(CREDENTIALS_SCHEMA_VERSION).toBe('1');
  });

  it('CREDENTIALS_FILE_NAME is "credentials"', () => {
    expect(CREDENTIALS_FILE_NAME).toBe('credentials');
  });

  it('CREDENTIALS_DIR_NAME is ".monday-cli"', () => {
    expect(CREDENTIALS_DIR_NAME).toBe('.monday-cli');
  });
});

describe('profileEntrySchema', () => {
  it('accepts the documented §7.4.1 shape', () => {
    const entry: ProfileEntry = profileEntrySchema.parse({
      access_token: 'tok-fixture-xxxx',
      obtained_at: '2026-05-10T12:00:00Z',
      expires_at: null,
      scopes: ['boards:read', 'boards:write'],
      account_id: '34900083',
    });
    expect(entry.access_token).toBe('tok-fixture-xxxx');
    expect(entry.expires_at).toBeNull();
  });

  it('accepts string expires_at for forward-compat with future refresh-token flow', () => {
    const entry = profileEntrySchema.parse({
      access_token: 'tok-fixture-xxxx',
      obtained_at: '2026-05-10T12:00:00Z',
      expires_at: '2027-05-10T12:00:00Z',
      scopes: [],
      account_id: '34900083',
    });
    expect(entry.expires_at).toBe('2027-05-10T12:00:00Z');
  });

  it('rejects unknown keys (.strict() — defends the no-token-in-config rule by exclusion)', () => {
    expect(() =>
      profileEntrySchema.parse({
        access_token: 'tok',
        obtained_at: '2026-05-10T12:00:00Z',
        expires_at: null,
        scopes: [],
        account_id: '1',
        extra_unknown_field: 'rejected',
      }),
    ).toThrow();
  });

  it('rejects empty access_token', () => {
    expect(() =>
      profileEntrySchema.parse({
        access_token: '',
        obtained_at: '2026-05-10T12:00:00Z',
        expires_at: null,
        scopes: [],
        account_id: '1',
      }),
    ).toThrow();
  });
});

describe('credentialsFileSchema', () => {
  it('accepts a multi-profile file', () => {
    const file: CredentialsFile = credentialsFileSchema.parse({
      schema_version: '1',
      profiles: {
        work: {
          access_token: 'tok-work-xxxx',
          obtained_at: '2026-05-10T12:00:00Z',
          expires_at: null,
          scopes: ['boards:read'],
          account_id: '12345',
        },
        personal: {
          access_token: 'tok-personal-xxxx',
          obtained_at: '2026-05-09T08:30:00Z',
          expires_at: null,
          scopes: ['boards:read'],
          account_id: '67890',
        },
      },
    });
    expect(Object.keys(file.profiles)).toHaveLength(2);
    expect(file.profiles.work?.account_id).toBe('12345');
  });

  it('accepts an empty profiles map (post-logout state)', () => {
    const file = credentialsFileSchema.parse({
      schema_version: '1',
      profiles: {},
    });
    expect(file.profiles).toEqual({});
  });

  it('rejects missing schema_version', () => {
    expect(() =>
      credentialsFileSchema.parse({ profiles: {} }),
    ).toThrow();
  });

  it('rejects schema_version values other than the literal "1" (security floor)', () => {
    expect(() =>
      credentialsFileSchema.parse({
        schema_version: '2',
        profiles: {},
      }),
    ).toThrow();
    expect(() =>
      credentialsFileSchema.parse({
        schema_version: '1.0',
        profiles: {},
      }),
    ).toThrow();
    expect(() =>
      credentialsFileSchema.parse({
        schema_version: '',
        profiles: {},
      }),
    ).toThrow();
  });

  it('rejects unknown top-level keys (.strict())', () => {
    expect(() =>
      credentialsFileSchema.parse({
        schema_version: '1',
        profiles: {},
        extra_root_key: 'rejected',
      }),
    ).toThrow();
  });
});

describe('credentials — type-level surface', () => {
  it('ProfileTokenSource is one of the two source-order paths', () => {
    const a: ProfileTokenSource = 'credentials_cache';
    const b: ProfileTokenSource = 'api_token_env';
    expect(a).toBe('credentials_cache');
    expect(b).toBe('api_token_env');
  });

  it('ResolvedProfileToken carries token + source', () => {
    const r: ResolvedProfileToken = {
      token: 'tok-fixture-xxxx',
      source: 'credentials_cache',
    };
    expect(r.token).toBe('tok-fixture-xxxx');
    expect(r.source).toBe('credentials_cache');
  });
});

describe('resolveCredentialsPath', () => {
  it('joins home + .monday-cli + credentials', () => {
    expect(resolveCredentialsPath({ home: '/tmp/fake-home' })).toBe(
      '/tmp/fake-home/.monday-cli/credentials',
    );
  });

  it('falls back to homedir() when home is omitted', () => {
    // Just exercises the `?? homedir()` branch; the actual path
    // depends on the test runner's HOME so we only assert structure.
    const path = resolveCredentialsPath();
    expect(path.endsWith('/.monday-cli/credentials')).toBe(true);
  });
});

const sampleEntry = (overrides: Partial<ProfileEntry> = {}): ProfileEntry => ({
  access_token: 'tok-fixture-xxxx',
  obtained_at: '2026-05-10T12:00:00Z',
  expires_at: null,
  scopes: ['boards:read'],
  account_id: '12345',
  ...overrides,
});

describe('readCredentials + writeCredentials (runtime I/O)', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-creds-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('readCredentials returns undefined on ENOENT (typical first-run state)', async () => {
    await expect(readCredentials({ home })).resolves.toBeUndefined();
  });

  it('writeCredentials creates the file with mode 0600', async () => {
    const file: CredentialsFile = {
      schema_version: '1',
      profiles: { work: sampleEntry() },
    };
    await writeCredentials(file, { home });
    const path = resolveCredentialsPath({ home });
    const stats = await stat(path);
    expect((stats.mode & 0o777).toString(8)).toBe('600');
  });

  it('round-trips a credentials file', async () => {
    const file: CredentialsFile = {
      schema_version: '1',
      profiles: {
        work: sampleEntry({ access_token: 'tok-work-xxxx' }),
        personal: sampleEntry({
          access_token: 'tok-personal-xxxx',
          account_id: '67890',
        }),
      },
    };
    await writeCredentials(file, { home });
    const loaded = await readCredentials({ home });
    expect(loaded).toEqual(file);
  });

  it('readCredentials refuses a 0644 file with config_error + chmod hint', async () => {
    const path = resolveCredentialsPath({ home });
    const dir = join(home, CREDENTIALS_DIR_NAME);
    await writeCredentials(
      { schema_version: '1', profiles: { work: sampleEntry() } },
      { home },
    );
    // Loosen the file mode behind the writer's back to simulate a
    // user `chmod 644` mistake.
    await chmod(path, 0o644);
    await expect(readCredentials({ home })).rejects.toBeInstanceOf(ConfigError);
    try {
      await readCredentials({ home });
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.code).toBe('config_error');
      expect(String(ce.details?.hint)).toMatch(/chmod 600/u);
      expect(String(ce.details?.path)).toContain(dir);
    }
  });

  it('readCredentials rejects malformed JSON with config_error', async () => {
    const path = resolveCredentialsPath({ home });
    const dir = join(home, CREDENTIALS_DIR_NAME);
    // Write an empty placeholder first to ensure the dir exists +
    // mode 0600 is set; then overwrite with garbage.
    await writeCredentials(
      { schema_version: '1', profiles: {} },
      { home },
    );
    await writeFile(path, '{not valid json', { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(readCredentials({ home })).rejects.toBeInstanceOf(ConfigError);
    expect(dir).toContain('.monday-cli');
  });

  it('readCredentials rejects schema-mismatched JSON with config_error', async () => {
    const path = resolveCredentialsPath({ home });
    await writeCredentials(
      { schema_version: '1', profiles: {} },
      { home },
    );
    // Hand-write a future-version file the schema rejects.
    await writeFile(
      path,
      JSON.stringify({ schema_version: '2', profiles: {} }),
      { mode: 0o600 },
    );
    await chmod(path, 0o600);
    await expect(readCredentials({ home })).rejects.toBeInstanceOf(ConfigError);
  });

  it('atomic-replace: re-write does not leave a tmp file behind', async () => {
    const file: CredentialsFile = {
      schema_version: '1',
      profiles: { work: sampleEntry() },
    };
    await writeCredentials(file, { home });
    await writeCredentials(
      { schema_version: '1', profiles: { work: sampleEntry({ access_token: 'tok-rotated-xxxx' }) } },
      { home },
    );
    // No `.tmp` siblings should remain.
    const dir = join(home, CREDENTIALS_DIR_NAME);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dir);
    const tmpFiles = entries.filter((name) => name.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

describe('setProfileCredentials', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-creds-set-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates a fresh file with one profile when credentials don\'t exist yet', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry() },
      { home },
    );
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles.work?.access_token).toBe('tok-fixture-xxxx');
    expect(Object.keys(loaded?.profiles ?? {})).toEqual(['work']);
  });

  it('preserves other profiles when adding a new one', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry({ access_token: 'tok-work' }) },
      { home },
    );
    await setProfileCredentials(
      {
        profileName: 'personal',
        entry: sampleEntry({ access_token: 'tok-personal' }),
      },
      { home },
    );
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles.work?.access_token).toBe('tok-work');
    expect(loaded?.profiles.personal?.access_token).toBe('tok-personal');
  });

  it('overwrites the entry on re-login (idempotent at the credentials-write layer)', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry({ access_token: 'tok-old' }) },
      { home },
    );
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry({ access_token: 'tok-new' }) },
      { home },
    );
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles.work?.access_token).toBe('tok-new');
  });
});

describe('deleteProfileCredentials', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-creds-del-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns wasPresent: false when no credentials file exists', async () => {
    const result = await deleteProfileCredentials('work', { home });
    expect(result.wasPresent).toBe(false);
  });

  it('returns wasPresent: false when the named profile is absent', async () => {
    await setProfileCredentials(
      { profileName: 'personal', entry: sampleEntry() },
      { home },
    );
    const result = await deleteProfileCredentials('work', { home });
    expect(result.wasPresent).toBe(false);
    // The other profile should still be there.
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles.personal).toBeDefined();
  });

  it('deletes the named profile and returns wasPresent: true', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry() },
      { home },
    );
    await setProfileCredentials(
      { profileName: 'personal', entry: sampleEntry() },
      { home },
    );
    const result = await deleteProfileCredentials('work', { home });
    expect(result.wasPresent).toBe(true);
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles.work).toBeUndefined();
    expect(loaded?.profiles.personal).toBeDefined();
  });

  it('preserves the file with empty profiles map when deleting the last profile (cli-design §7.3.2)', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry() },
      { home },
    );
    const result = await deleteProfileCredentials('work', { home });
    expect(result.wasPresent).toBe(true);
    const loaded = await readCredentials({ home });
    expect(loaded?.profiles).toEqual({});
    expect(loaded?.schema_version).toBe('1');
  });

  it('idempotent — second invocation returns wasPresent: false', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry() },
      { home },
    );
    const first = await deleteProfileCredentials('work', { home });
    const second = await deleteProfileCredentials('work', { home });
    expect(first.wasPresent).toBe(true);
    expect(second.wasPresent).toBe(false);
  });
});

describe('resolveProfileToken', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-creds-resolve-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('returns the cache entry when present (credentials cache wins per §7.4.1)', async () => {
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry({ access_token: 'tok-from-cache' }) },
      { home },
    );
    const resolved = await resolveProfileToken(
      { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
      {
        home,
        env: { MONDAY_API_TOKEN_WORK: 'tok-from-env' },
      },
    );
    expect(resolved.token).toBe('tok-from-cache');
    expect(resolved.source).toBe('credentials_cache');
  });

  it('falls back to api_token_env when no cache entry exists', async () => {
    const resolved = await resolveProfileToken(
      { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
      {
        home,
        env: { MONDAY_API_TOKEN_WORK: 'tok-from-env' },
      },
    );
    expect(resolved.token).toBe('tok-from-env');
    expect(resolved.source).toBe('api_token_env');
  });

  it('falls back to env even when other profiles have cache entries (no cross-profile leak)', async () => {
    await setProfileCredentials(
      { profileName: 'personal', entry: sampleEntry({ access_token: 'tok-personal' }) },
      { home },
    );
    const resolved = await resolveProfileToken(
      { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
      {
        home,
        env: { MONDAY_API_TOKEN_WORK: 'tok-work-env' },
      },
    );
    expect(resolved.token).toBe('tok-work-env');
    expect(resolved.source).toBe('api_token_env');
  });

  it('throws config_error when neither cache nor env yields a token', async () => {
    await expect(
      resolveProfileToken(
        { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
        { home, env: {} },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
    try {
      await resolveProfileToken(
        { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
        { home, env: {} },
      );
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.code).toBe('config_error');
      expect(String(ce.details?.hint)).toMatch(/monday auth login/u);
      expect(String(ce.details?.hint)).toMatch(/MONDAY_API_TOKEN_WORK/u);
    }
  });

  it('throws config_error when no cache + no api_token_env configured', async () => {
    await expect(
      resolveProfileToken(
        { profileName: 'work', apiTokenEnvName: undefined },
        { home, env: {} },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('falls back to process.env when no env is provided in options', async () => {
    // Exercises the `options.env ?? process.env` branch. We use an
    // env-var name unlikely to be set in the test environment.
    await expect(
      resolveProfileToken(
        {
          profileName: 'work',
          apiTokenEnvName: '__MONDAY_CLI_TEST_UNSET_ENV_VAR__',
        },
        { home },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('treats empty-string env value as unset (falls through to config_error)', async () => {
    await expect(
      resolveProfileToken(
        { profileName: 'work', apiTokenEnvName: 'MONDAY_API_TOKEN_WORK' },
        { home, env: { MONDAY_API_TOKEN_WORK: '' } },
      ),
    ).rejects.toBeInstanceOf(ConfigError);
  });
});
