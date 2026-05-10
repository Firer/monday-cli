/**
 * Unit tests for the v0.3-M21 pre-flight `src/config/credentials.ts`
 * surface. Stub bodies reject with `internal_error` (or throw); the
 * zod schemas + constants ship as real exports and must validate the
 * documented §7.4.1 file shape.
 */

import { describe, expect, it } from 'vitest';
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
import { ApiError } from '../../../src/utils/errors.js';

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

  it('rejects schema_version values other than the literal "1" (round-2 P2 — security floor)', () => {
    // The literal-pin defends a security-bearing surface against
    // a future-version credentials file silently passing through
    // and getting reinterpreted under the v0.3 schema. A future
    // schema_version: "2" requires an explicit reader (e.g.,
    // `readCredentialsV2`), not implicit drift.
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

describe('credentials — pre-flight stubs', () => {
  // All stubs throw `ApiError('internal_error', ...)` per the
  // M19/M20 pre-flight discipline (Codex round 1 P2 fix-up).

  it('resolveCredentialsPath throws ApiError(internal_error) (synchronous stub)', () => {
    expect(() => resolveCredentialsPath()).toThrow(ApiError);
    try {
      resolveCredentialsPath();
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
      expect(ae.message).toMatch(/pre-flight stub/u);
    }
  });

  it('readCredentials rejects with ApiError(internal_error)', async () => {
    await expect(readCredentials()).rejects.toBeInstanceOf(ApiError);
    try {
      await readCredentials();
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('internal_error');
    }
  });

  it('writeCredentials rejects with ApiError(internal_error)', async () => {
    await expect(
      writeCredentials({
        schema_version: '1',
        profiles: {},
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('setProfileCredentials rejects with ApiError(internal_error)', async () => {
    await expect(
      setProfileCredentials({
        profileName: 'work',
        entry: {
          access_token: 'tok',
          obtained_at: '2026-05-10T12:00:00Z',
          expires_at: null,
          scopes: [],
          account_id: '1',
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('deleteProfileCredentials rejects with ApiError(internal_error)', async () => {
    await expect(deleteProfileCredentials('work')).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('resolveProfileToken rejects with ApiError(internal_error)', async () => {
    await expect(
      resolveProfileToken({
        profileName: 'work',
        apiTokenEnvName: 'MONDAY_API_TOKEN_WORK',
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});
