/**
 * Integration tests for the v0.3-M21 `monday auth login` +
 * `monday auth logout` verbs.
 *
 * The OAuth flow mocks two boundary points:
 *
 *   - `/oauth2/token` exchange — `vi.stubGlobal('fetch', mockFetch)`.
 *     `exchangeCode` reads the stubbed fetch.
 *   - `account { id }` GraphQL post-exchange — `FixtureTransport`
 *     cassette via `ctx.transport`.
 *
 * The `__test_oauth_helper` env var swaps the listener for the
 * fixture-driven test seam (cli-design §7.3.4); we never bind a
 * real socket in tests.
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import {
  baseOptions,
  parseEnvelope,
  LEAK_CANARY,
  type Captured,
} from '../helpers.js';
import {
  CREDENTIALS_DIR_NAME,
  CREDENTIALS_FILE_NAME,
} from '../../../src/config/credentials.js';
import { createFixtureTransport, type Cassette } from '../../fixtures/load.js';

const ACCOUNT_ID_FIXTURE_CASSETTE: Cassette = {
  interactions: [
    {
      operation_name: 'AuthLoginAccountId',
      response: {
        data: {
          account: { id: '34900083' },
        },
      },
    },
  ],
};

interface AuthEnv {
  readonly home: string;
  readonly fixturePath: string;
}

const buildAuthTmpHome = async (
  prefix: string,
): Promise<AuthEnv> => {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const fixturePath = join(home, 'oauth-fixture.json');
  return { home, fixturePath };
};

const writeFixture = async (
  path: string,
  fixture: Record<string, unknown>,
): Promise<void> => {
  await writeFile(path, JSON.stringify(fixture), 'utf8');
};

const driveAuth = async (
  argv: readonly string[],
  env: AuthEnv,
  cassette: Cassette | undefined,
  envOverrides: Record<string, string | undefined> = {},
  overrides: Partial<RunOptions> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  // Construct env: drop MONDAY_API_TOKEN — auth login is the source
  // of credentials, not a consumer. The preAction hook also exempts
  // auth verbs from profile resolution.
  const transport =
    cassette !== undefined ? createFixtureTransport(cassette) : undefined;
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    env: {
      MONDAY_API_URL: 'https://api.monday.com/v2',
      HOME: env.home,
      __test_oauth_helper: env.fixturePath,
      ...Object.fromEntries(
        Object.entries(envOverrides).filter(
          ([, v]) => v !== undefined,
        ) as [string, string][],
      ),
    },
    ...(transport !== undefined ? { transport } : {}),
    ...overrides,
  });
  const result = await run(options);
  return { exitCode: result.exitCode, captured };
};

const buildOAuthFetchStub = (
  responseBody: Record<string, unknown> = {
    access_token: 'tok-from-monday-fixture',
    token_type: 'Bearer',
    scope: 'boards:read boards:write me:read',
  },
  status = 200,
): ReturnType<typeof vi.fn> => {
  return vi.fn((input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    if (url.includes('/oauth2/token')) {
      return Promise.resolve(
        new Response(JSON.stringify(responseBody), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.reject(new Error(`unexpected fetch call to ${url}`));
  });
};

describe('monday auth login (integration, M21 implementation)', () => {
  let env: AuthEnv;

  beforeEach(async () => {
    env = await buildAuthTmpHome('monday-cli-auth-login-');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(env.home, { recursive: true, force: true });
  });

  it('happy path: writes a 0600 credentials file + emits success envelope without the token', async () => {
    await writeFixture(env.fixturePath, { code: 'fake-auth-code' });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      ACCOUNT_ID_FIXTURE_CASSETTE,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout());
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      profile: 'work',
      account_id: '34900083',
      scopes: ['boards:read', 'boards:write', 'me:read'],
    });
    // Token NEVER in data per cli-design §7.4.3.
    expect(JSON.stringify(envelope.data)).not.toContain(
      'tok-from-monday-fixture',
    );

    // Credentials file landed at the right path with mode 0600.
    const credPath = join(
      env.home,
      CREDENTIALS_DIR_NAME,
      CREDENTIALS_FILE_NAME,
    );
    const stats = await stat(credPath);
    expect((stats.mode & 0o777).toString(8)).toBe('600');
    const onDisk: unknown = JSON.parse(await readFile(credPath, 'utf8'));
    expect(onDisk).toMatchObject({
      schema_version: '1',
      profiles: {
        work: {
          access_token: 'tok-from-monday-fixture',
          account_id: '34900083',
          expires_at: null,
          scopes: ['boards:read', 'boards:write', 'me:read'],
        },
      },
    });

    // The OAuth fetch was called once.
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('csrf_mismatch: surfaces oauth_failed without exchanging the code', async () => {
    await writeFixture(env.fixturePath, {
      code: 'fake-code',
      force_csrf_mismatch: true,
    });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('oauth_failed');
    expect(
      (envelope.error?.details as { reason?: string } | undefined)?.reason,
    ).toBe('csrf_mismatch');
    // No token-exchange wire call should have fired.
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('user_denied: surfaces oauth_failed.user_denied without exchanging', async () => {
    await writeFixture(env.fixturePath, {
      code: 'unused',
      force_user_denied: true,
    });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('oauth_failed');
    expect(
      (envelope.error?.details as { reason?: string } | undefined)?.reason,
    ).toBe('user_denied');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('authorization_failed without error_description: surfaces monday_code only', async () => {
    await writeFixture(env.fixturePath, {
      code: 'unused',
      force_authorization_failed: { error: 'temporary_unavailable' },
    });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('oauth_failed');
    const details = envelope.error?.details as
      | { reason?: string; monday_code?: string; monday_description?: string }
      | undefined;
    expect(details?.reason).toBe('authorization_failed');
    expect(details?.monday_code).toBe('temporary_unavailable');
    expect(details?.monday_description).toBeUndefined();
  });

  it('authorization_failed: surfaces monday_code + monday_description', async () => {
    await writeFixture(env.fixturePath, {
      code: 'unused',
      force_authorization_failed: {
        error: 'invalid_scope',
        error_description: 'requested scope `boards:write` not granted',
      },
    });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('oauth_failed');
    const details = envelope.error?.details as
      | {
          reason?: string;
          monday_code?: string;
          monday_description?: string;
        }
      | undefined;
    expect(details?.reason).toBe('authorization_failed');
    expect(details?.monday_code).toBe('invalid_scope');
    expect(details?.monday_description).toMatch(/boards:write/u);
  });

  it('--profile is required — missing surfaces usage_error', async () => {
    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    expect(captured.stderr()).toMatch(/profile/u);
  });

  it('redacts the leak canary when present in the env', async () => {
    await writeFixture(env.fixturePath, { code: 'fake-code' });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);

    const { captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      ACCOUNT_ID_FIXTURE_CASSETTE,
      { MONDAY_API_TOKEN: LEAK_CANARY },
    );
    expect(captured.stderr()).not.toContain(LEAK_CANARY);
    expect(captured.stdout()).not.toContain(LEAK_CANARY);
  });

  it('post-exchange GraphQL probe echoing the just-obtained token does not leak (cli-design §7.4.3)', async () => {
    // Codex M21 Part 2 P1 finding: on a fresh-install auth login,
    // neither MONDAY_API_TOKEN nor `ctx.runtimeSecrets` carries
    // the OAuth-obtained token at preAction-hook time (profile
    // resolution is skipped for auth verbs; credentials cache is
    // empty pre-login). If the post-exchange `account { id }`
    // probe surfaces a GraphQL error.message that echoes back the
    // Authorization header, the error envelope's value-scan layer
    // can only scrub it when login.ts pushes the just-obtained
    // token into `ctx.runtimeSecrets` BEFORE calling fetchAccountId.
    const justObtained = 'tok-just-obtained-canary-aabbccdd';
    await writeFixture(env.fixturePath, { code: 'fake-auth-code' });
    const fetchStub = buildOAuthFetchStub({
      access_token: justObtained,
      token_type: 'Bearer',
      scope: 'boards:read me:read',
    });
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      {
        interactions: [
          {
            operation_name: 'AuthLoginAccountId',
            http_status: 401,
            response: {
              errors: [
                {
                  // Simulate Monday echoing the Authorization
                  // header value back in the error body — what we
                  // genuinely fear when probing a freshly-issued
                  // token.
                  message: `Authentication rejected: ${justObtained}`,
                  extensions: {
                    code: 'AUTHENTICATION_ERROR',
                    presented_token: justObtained,
                  },
                },
              ],
            },
          },
        ],
      },
    );
    expect(exitCode).toBe(2);
    expect(captured.stdout()).not.toContain(justObtained);
    expect(captured.stderr()).not.toContain(justObtained);
  });

  it('exchange-failed: surfaces oauth_failed.code_exchange_failed when /oauth2/token returns 400', async () => {
    await writeFixture(env.fixturePath, { code: 'fake-code' });
    const fetchStub = buildOAuthFetchStub(
      {
        error: 'invalid_grant',
        error_description: 'authorization code has expired',
      },
      400,
    );
    vi.stubGlobal('fetch', fetchStub);

    const { exitCode, captured } = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    const envelope = parseEnvelope(captured.stderr());
    expect(envelope.error?.code).toBe('oauth_failed');
    const details = envelope.error?.details as
      | { reason?: string; monday_code?: string }
      | undefined;
    expect(details?.reason).toBe('code_exchange_failed');
    expect(details?.monday_code).toBe('invalid_grant');
  });
});

describe('monday auth logout (integration, M21 implementation)', () => {
  let env: AuthEnv;

  beforeEach(async () => {
    env = await buildAuthTmpHome('monday-cli-auth-logout-');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(env.home, { recursive: true, force: true });
  });

  it('idempotent: was_present:false when no credentials file exists', async () => {
    const { exitCode, captured } = await driveAuth(
      ['auth', 'logout', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(0);
    const envelope = parseEnvelope(captured.stdout());
    expect(envelope.data).toMatchObject({
      profile: 'work',
      was_present: false,
    });
  });

  it('was_present:true after a prior login; second invocation is a no-op', async () => {
    // First, run auth login to populate credentials.
    await writeFixture(env.fixturePath, { code: 'fake-code' });
    const fetchStub = buildOAuthFetchStub();
    vi.stubGlobal('fetch', fetchStub);
    const loginResult = await driveAuth(
      ['auth', 'login', '--profile', 'work', '--json'],
      env,
      ACCOUNT_ID_FIXTURE_CASSETTE,
    );
    expect(loginResult.exitCode).toBe(0);

    // First logout — was_present: true.
    const first = await driveAuth(
      ['auth', 'logout', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(first.exitCode).toBe(0);
    expect(parseEnvelope(first.captured.stdout()).data).toMatchObject({
      was_present: true,
    });

    // Second logout — was_present: false.
    const second = await driveAuth(
      ['auth', 'logout', '--profile', 'work', '--json'],
      env,
      undefined,
    );
    expect(second.exitCode).toBe(0);
    expect(parseEnvelope(second.captured.stdout()).data).toMatchObject({
      was_present: false,
    });

    // The credentials file still exists with empty profiles map (per
    // cli-design §7.3.2).
    const credPath = join(
      env.home,
      CREDENTIALS_DIR_NAME,
      CREDENTIALS_FILE_NAME,
    );
    const onDisk: unknown = JSON.parse(await readFile(credPath, 'utf8'));
    expect(onDisk).toEqual({ schema_version: '1', profiles: {} });
  });

  it('--profile is required — missing surfaces usage_error', async () => {
    const { exitCode, captured } = await driveAuth(
      ['auth', 'logout', '--json'],
      env,
      undefined,
    );
    expect(exitCode).toBe(1);
    expect(captured.stderr()).toMatch(/profile/u);
  });
});
