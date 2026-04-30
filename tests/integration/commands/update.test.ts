/**
 * Integration tests for `monday update *` (M3 §3 reads only —
 * `update create` ships in M5b).
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
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const transport = createFixtureTransport(cassette);
  const { options, captured } = baseOptions({
    argv: ['node', 'monday', ...argv],
    transport,
  });
  const result = await run(options);
  return {
    exitCode: result.exitCode,
    stdout: captured.stdout(),
    stderr: captured.stderr(),
  };
};

const sampleUpdate = {
  id: '77',
  body: '<p>Looks good</p>',
  text_body: 'Looks good',
  creator_id: '1',
  creator: { id: '1', name: 'Alice', email: 'alice@example.test' },
  created_at: '2026-04-30T09:00:00Z',
  updated_at: '2026-04-30T09:01:00Z',
  edited_at: '2026-04-30T09:01:00Z',
  replies: [],
};

describe('monday update list', () => {
  it('returns the projected updates for an item', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            match_variables: { itemIds: ['5001'] },
            response: {
              data: { items: [{ id: '5001', updates: [sampleUpdate] }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([sampleUpdate]);
    expect(env.meta.total_returned).toBe(1);
  });

  it('not_found when the item itself is missing', async () => {
    const out = await drive(
      ['update', 'list', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateList', response: { data: { items: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('returns an empty list when item exists with zero updates', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateList',
            response: { data: { items: [{ id: '5001', updates: [] }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
    expect(env.meta.total_returned).toBe(0);
  });

  it('rejects --all + --page', async () => {
    const out = await drive(
      ['update', 'list', '5001', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--api-version reaches error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'update', 'list', '5001', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

describe('monday update get', () => {
  it('returns the projected update', async () => {
    const out = await drive(
      ['update', 'get', '77', '--json'],
      {
        interactions: [
          {
            operation_name: 'UpdateGet',
            match_variables: { ids: ['77'] },
            response: {
              data: {
                updates: [{ ...sampleUpdate, item_id: '5001' }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({ id: '77', item_id: '5001' });
  });

  it('not_found when the update id misses', async () => {
    const out = await drive(
      ['update', 'get', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UpdateGet', response: { data: { updates: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric update id', async () => {
    const out = await drive(['update', 'get', 'abc', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});
