/**
 * Integration tests for `monday user *` (M3 §3).
 */
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';
import {
  createFixtureTransport,
  type Cassette,
} from '../../fixtures/load.js';

const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';

const baseOptions = (
  overrides: Partial<RunOptions> = {},
): {
  options: RunOptions;
  captured: { stdout: () => string; stderr: () => string };
} => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  const options: RunOptions = {
    argv: ['node', 'monday'],
    env: {
      MONDAY_API_TOKEN: LEAK_CANARY,
      MONDAY_API_URL: 'https://api.monday.com/v2',
    },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-req-id']),
    clock: () => new Date('2026-04-30T10:00:00Z'),
    ...overrides,
  };
  return {
    options,
    captured: {
      stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    },
  };
};

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: {
    readonly schema_version: '1';
    readonly api_version: string;
    readonly cli_version: string;
    readonly request_id: string;
    readonly source: string;
    readonly cache_age_seconds: number | null;
    readonly retrieved_at: string;
    readonly complexity: unknown;
    readonly total_returned?: number;
  };
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

const drive = async (
  argv: readonly string[],
  cassette: Cassette,
  overrides: Partial<RunOptions> = {},
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> => {
  const transport = createFixtureTransport(cassette);
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    transport,
    ...overrides,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
  };
};

const sampleUser = {
  id: '1',
  name: 'Alice',
  email: 'alice@example.test',
  enabled: true,
  is_guest: false,
  is_admin: false,
  is_view_only: false,
  is_pending: false,
  is_verified: true,
  title: null,
  time_zone_identifier: 'Europe/London',
  join_date: '2026-01-01',
  last_activity: '2026-04-30T09:00:00Z',
};

describe('monday user list', () => {
  it('returns the projected list with collection meta', async () => {
    const out = await drive(
      ['user', 'list', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserList',
            response: { data: { users: [sampleUser] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.total_returned).toBe(1);
    expect(env.data).toEqual([sampleUser]);
  });

  it('--api-version reaches error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'user', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'UserList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

describe('monday user get', () => {
  it('returns the projected user', async () => {
    const out = await drive(
      ['user', 'get', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserGet',
            match_variables: { ids: ['1'] },
            response: {
              data: {
                users: [
                  { ...sampleUser, url: 'https://x.monday.com/u/1', country_code: 'GB' },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({
      id: '1',
      url: 'https://x.monday.com/u/1',
      country_code: 'GB',
    });
  });

  it('not_found when no user matches', async () => {
    const out = await drive(
      ['user', 'get', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UserGet', response: { data: { users: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric user id at the parse boundary', async () => {
    const out = await drive(['user', 'get', 'xyz', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday user me', () => {
  it('mirrors account whoami output', async () => {
    const out = await drive(
      ['user', 'me', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: 'Alice',
                  email: 'alice@example.test',
                  account: { id: '99', name: 'Org', slug: 'org' },
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({
      me: { id: '1', email: 'alice@example.test' },
    });
  });

  it('surfaces unauthorized when me is null', async () => {
    const out = await drive(
      ['user', 'me', '--json'],
      {
        interactions: [
          { operation_name: 'Whoami', response: { data: { me: null } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
  });
});
