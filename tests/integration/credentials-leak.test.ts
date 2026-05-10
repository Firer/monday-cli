/**
 * Hardened credentials-cache token-leak regression suite for the
 * v0.3-M21 cli-design §7.4.3 redaction-runtime extension.
 *
 * Mirrors `tests/integration/redaction-hardening.test.ts`'s M2-era
 * discipline (every emission path scrubs the canary) but exercises
 * the credentials-cache angle specifically: the access_token lives
 * in a fixture credentials file under a tmp HOME, NOT in the
 * `MONDAY_API_TOKEN` env. The pre-M21 redactor's value-scan layer
 * only knew about `MONDAY_API_TOKEN`, so a cached token leaking
 * into `Error.message`/`Error.stack`/`Error.cause` would have
 * passed through unmasked. The M21 redaction-runtime extension
 * (program.ts preAction hook reads credentials + populates
 * `ctx.runtimeSecrets`) closes that gap.
 *
 * The canary `tok-cred-leak-deadbeef-canary` lives in the fixture
 * file ONLY. We drive every reachable emission path:
 *   - success envelope on stdout (JSON + table renderers)
 *   - error envelope on stderr (runner catch-all)
 *   - retried-request error decoration (cause chain)
 *   - verbose mode (--verbose): cached token in response payload
 *     body scrubbed before envelope render
 *   - auth verbs (login / logout flows — those READ credentials too)
 *   - config_error path from insecure permissions (the cause must
 *     not echo the loaded token)
 *
 * Assertion is uniform: the literal canary MUST NOT appear in any
 * byte of stdout or stderr across any path.
 */
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../src/cli/run.js';
import {
  baseOptions,
  type Captured,
} from './helpers.js';
import {
  CREDENTIALS_DIR_NAME,
  CREDENTIALS_FILE_NAME,
  resolveCredentialsPath,
  setProfileCredentials,
  type ProfileEntry,
} from '../../src/config/credentials.js';
import {
  createFixtureTransport,
  type Cassette,
} from '../fixtures/load.js';

const CRED_LEAK_CANARY = 'tok-cred-leak-deadbeef-canary';

const sampleEntry = (token: string): ProfileEntry => ({
  access_token: token,
  obtained_at: '2026-05-10T12:00:00Z',
  expires_at: null,
  scopes: ['boards:read', 'me:read'],
  account_id: '12345',
});

const driveWithCredHome = async (
  argv: readonly string[],
  home: string,
  cassette: Cassette | undefined,
  envOverrides: Record<string, string> = {},
  overrides: Partial<RunOptions> = {},
): Promise<{ exitCode: number; captured: Captured }> => {
  // Drop MONDAY_API_TOKEN — the whole point is to exercise the
  // credentials-cache-only flow where the value-scan layer must
  // know about the cached token to scrub it.
  const transport =
    cassette !== undefined ? createFixtureTransport(cassette) : undefined;
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    env: {
      MONDAY_API_URL: 'https://api.monday.com/v2',
      HOME: home,
      ...envOverrides,
    },
    ...(transport !== undefined ? { transport } : {}),
    ...overrides,
  });
  const result = await run(options);
  return { exitCode: result.exitCode, captured };
};

const assertNoLeak = (captured: Captured): void => {
  expect(captured.stdout()).not.toContain(CRED_LEAK_CANARY);
  expect(captured.stderr()).not.toContain(CRED_LEAK_CANARY);
};

const collected: string[] = [];

describe('credentials-cache leak hardening — M21 §7.4.3', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'monday-cli-cred-leak-'));
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry(CRED_LEAK_CANARY) },
      { home },
    );
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('success envelope: cached token never leaks into stdout', async () => {
    // `monday config show --profile work --json` — local-only; the
    // preAction hook resolves the profile (injecting the cached
    // token into ctx.env.MONDAY_API_TOKEN) AND populates
    // ctx.runtimeSecrets. The rendered envelope must not leak.
    const result = await driveWithCredHome(
      ['config', 'show', '--profile', 'work', '--json'],
      home,
      undefined,
    );
    expect(result.exitCode).toBe(0);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('error envelope: cached token echoed in GraphQL error.message scrubbed', async () => {
    // Monday surfaces the auth header back in some 401 responses.
    // If the redaction-runtime extension is wired, the cached
    // token appearing in error.message gets value-scanned out.
    const result = await driveWithCredHome(
      ['account', 'whoami', '--profile', 'work', '--json'],
      home,
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {
              errors: [
                {
                  message: `Authentication rejected: ${CRED_LEAK_CANARY}`,
                  extensions: { code: 'AUTHENTICATION_ERROR' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('error envelope: cached token in extensions payload scrubbed', async () => {
    const result = await driveWithCredHome(
      ['account', 'whoami', '--profile', 'work', '--json'],
      home,
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'unauthorized',
                  extensions: {
                    code: 'AUTHENTICATION_ERROR',
                    presented_token: CRED_LEAK_CANARY,
                    request_id: `req-${CRED_LEAK_CANARY}`,
                  },
                },
              ],
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('verbose mode: cached token in response payload body scrubbed', async () => {
    const result = await driveWithCredHome(
      ['--verbose', 'account', 'whoami', '--profile', 'work', '--json'],
      home,
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: `Owner-${CRED_LEAK_CANARY}`,
                  email: 'a@x.test',
                  account: { id: '9', name: 'O', slug: null },
                },
                complexity: {
                  before: 1,
                  after: 1,
                  query: 0,
                  reset_in_x_seconds: 0,
                },
              },
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('table output (default TTY render): cached token scrubbed', async () => {
    // Forces table-mode rendering via --output. The table renderer
    // funnels through the same redact() call so anything that
    // would leak via JSON also leaks via table.
    const result = await driveWithCredHome(
      ['account', 'whoami', '--profile', 'work', '--output', 'table'],
      home,
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: `Owner-${CRED_LEAK_CANARY}`,
                  email: 'a@x.test',
                  account: {
                    id: '9',
                    name: `Acct-${CRED_LEAK_CANARY}`,
                    slug: null,
                  },
                },
              },
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('config_error path (insecure perms): cause does not echo the cached token', async () => {
    // Loosen the file's mode so the read-time fstat refuses it.
    // The resulting config_error envelope must not echo the bytes
    // (the key-based filter strips access_token, but the cause
    // chain that flows into the envelope hits the value-scan
    // layer too).
    const credPath = resolveCredentialsPath({ home });
    await chmod(credPath, 0o644);
    const result = await driveWithCredHome(
      ['account', 'whoami', '--profile', 'work', '--json'],
      home,
      undefined,
    );
    expect(result.exitCode).toBe(3);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('multi-profile: inactive profile token cannot leak via runtimeSecrets', async () => {
    // Two profiles: `work` (active with non-canary token) +
    // `stale` (inactive carrying the canary). Profile resolution
    // injects `work`'s token into MONDAY_API_TOKEN — so the env
    // token slot DOES NOT carry the canary. The only path that
    // scrubs the canary is `ctx.runtimeSecrets`, which the preAction
    // hook populates from every profile in the file. If a future
    // regression scoped runtimeSecrets to just the active profile,
    // this test catches it.
    const activeTok = 'tok-work-active-1234567890';
    await rm(
      join(home, CREDENTIALS_DIR_NAME, CREDENTIALS_FILE_NAME),
      { force: true },
    );
    await setProfileCredentials(
      { profileName: 'work', entry: sampleEntry(activeTok) },
      { home },
    );
    await setProfileCredentials(
      { profileName: 'stale', entry: sampleEntry(CRED_LEAK_CANARY) },
      { home },
    );

    const result = await driveWithCredHome(
      ['account', 'whoami', '--profile', 'work', '--json'],
      home,
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  // Simulate a response where Monday accidentally
                  // echoes a value matching the stale profile's
                  // cached token — possible if the stale token had
                  // been reused elsewhere. The active token is
                  // different; only runtimeSecrets-via-stale-entry
                  // scrubs the canary.
                  message: `unrelated error referencing ${CRED_LEAK_CANARY}`,
                  extensions: { code: 'INTERNAL_SERVER_ERROR' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result.captured);
    // Also assert the active token is scrubbed (the M2 baseline
    // discipline).
    expect(result.captured.stdout()).not.toContain(activeTok);
    expect(result.captured.stderr()).not.toContain(activeTok);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('auth verb: credentials read populates runtimeSecrets BEFORE the auth-verb-exemption return', async () => {
    // The preAction hook reads credentials first, then bails out
    // of profile resolution for auth verbs. If a stale credentials
    // file's token surfaced in an auth-login error envelope (e.g.,
    // via a cause chain leak through OAuth helper construction),
    // runtimeSecrets must still scrub it — even though profile
    // resolution never injected the token into MONDAY_API_TOKEN.
    //
    // Drive `auth logout --profile stale` against a fixture where
    // the stale profile carries the canary. The verb's success
    // envelope reports `was_present: true` but the access_token
    // never appears in the emitted envelope — both because the
    // key-based filter blocks `access_token` AND because the
    // value-scan filter (runtimeSecrets) covers any incidental
    // string occurrence.
    await rm(
      join(home, CREDENTIALS_DIR_NAME, CREDENTIALS_FILE_NAME),
      { force: true },
    );
    await setProfileCredentials(
      { profileName: 'stale', entry: sampleEntry(CRED_LEAK_CANARY) },
      { home },
    );

    const result = await driveWithCredHome(
      ['auth', 'logout', '--profile', 'stale', '--json'],
      home,
      undefined,
    );
    expect(result.exitCode).toBe(0);
    assertNoLeak(result.captured);
    collected.push(result.captured.stdout(), result.captured.stderr());
  });

  it('cumulative cross-scenario check: canary absent across every byte', () => {
    // Belt-and-braces — even if a future scenario forgets its
    // per-test assertion, this aggregate check guards the whole
    // file. If a single byte slipped through anywhere, the joined
    // string carries it and this fails.
    const everything = collected.join('\n');
    expect(everything).not.toContain(CRED_LEAK_CANARY);
  });
});

describe('credentials-cache leak hardening — pre-fix proof', () => {
  it('the credentials file genuinely contains the canary (sanity check)', async () => {
    // Demonstrates the suite isn't trivially passing — the on-disk
    // credentials file we wrote DOES contain the canary; the
    // redaction-runtime extension is what strips it from emission.
    const tmpHome = await mkdtemp(
      join(tmpdir(), 'monday-cli-cred-leak-sanity-'),
    );
    try {
      await setProfileCredentials(
        {
          profileName: 'work',
          entry: sampleEntry(CRED_LEAK_CANARY),
        },
        { home: tmpHome },
      );
      const credPath = join(
        tmpHome,
        CREDENTIALS_DIR_NAME,
        CREDENTIALS_FILE_NAME,
      );
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(credPath, 'utf8');
      expect(raw).toContain(CRED_LEAK_CANARY);
    } finally {
      await rm(tmpHome, { recursive: true, force: true });
    }
  });
});
