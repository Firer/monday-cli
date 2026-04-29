import { describe, it, expect } from 'vitest';
import { MondayClient, PINNED_API_VERSION } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';
import { createInlineFixtureTransport } from '../../fixtures/load.js';

const fastSleep = async (
  _ms: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) throw new Error('aborted');
  await Promise.resolve();
};

const makeClient = (
  cassette: Parameters<typeof createInlineFixtureTransport>[0],
  overrides: {
    retries?: number;
    verbose?: boolean;
    signal?: AbortSignal;
  } = {},
): {
  client: MondayClient;
  transport: ReturnType<typeof createInlineFixtureTransport>;
} => {
  const transport = createInlineFixtureTransport(cassette);
  const signal = overrides.signal ?? new AbortController().signal;
  const client = new MondayClient({
    transport,
    signal,
    retries: overrides.retries ?? 3,
    verbose: overrides.verbose ?? false,
    retrySleep: fastSleep,
    retryRandom: () => 0.5,
  });
  return { client, transport };
};

describe('MondayClient', () => {
  it('exports the SDK-pinned API version', () => {
    expect(PINNED_API_VERSION).toBe('2026-01');
  });

  it('whoami returns the typed shape on success', async () => {
    const { client, transport } = makeClient([
      {
        operation_name: 'Whoami',
        response: {
          data: {
            me: {
              id: '123',
              name: 'Alice',
              email: 'alice@example.test',
              account: { id: '99', name: 'Org', slug: 'org' },
            },
          },
        },
      },
    ]);
    const result = await client.whoami();
    expect(result.data.me.id).toBe('123');
    expect(result.complexity).toBeNull();
    expect(result.stats.attempts).toBe(1);
    expect(transport.requests[0]?.operationName).toBe('Whoami');
    expect(transport.requests[0]?.query).toContain('me {');
    transport.assertConsumed();
  });

  it('account returns the projected fields', async () => {
    const { client } = makeClient([
      {
        operation_name: 'AccountInfo',
        response: {
          data: {
            account: {
              id: '99',
              name: 'Org',
              slug: 'org',
              country_code: 'GB',
              first_day_of_the_week: 'monday',
              active_members_count: 42,
              logo: null,
              plan: { version: 1, tier: 'pro', max_users: 100, period: 'annual' },
            },
          },
        },
      },
    ]);
    const result = await client.account();
    expect(result.data.account.country_code).toBe('GB');
    expect(result.data.account.plan?.tier).toBe('pro');
  });

  it('versions returns the list shape', async () => {
    const { client } = makeClient([
      {
        operation_name: 'Versions',
        response: {
          data: {
            versions: [
              { display_name: '2026-01', kind: 'current', value: '2026-01' },
              { display_name: '2025-10', kind: 'maintenance', value: '2025-10' },
            ],
          },
        },
      },
    ]);
    const result = await client.versions();
    expect(result.data.versions).toHaveLength(2);
    expect(result.data.versions[0]?.kind).toBe('current');
  });

  it('complexityProbe returns the budget block', async () => {
    const { client } = makeClient([
      {
        operation_name: 'ComplexityProbe',
        response: {
          data: {
            complexity: {
              before: 5_000_000,
              after: 4_999_999,
              query: 1,
              reset_in_x_seconds: 30,
            },
          },
        },
      },
    ]);
    const result = await client.complexityProbe();
    expect(result.data.complexity?.after).toBe(4_999_999);
  });

  it('verbose mode injects the complexity selection and surfaces it on the result', async () => {
    const { client, transport } = makeClient(
      [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: {
                id: '1',
                name: 'A',
                email: 'a@x.test',
                account: { id: '9', name: 'O', slug: null },
              },
              complexity: { before: 5_000_000, after: 4_999_998, query: 2, reset_in_x_seconds: 30 },
            },
          },
        },
      ],
      { verbose: true },
    );
    const result = await client.whoami();
    expect(transport.requests[0]?.query).toContain('complexity {');
    expect(result.complexity).toEqual({
      used: 2,
      remaining: 4_999_998,
      reset_in_seconds: 30,
    });
  });

  it('non-verbose mode keeps complexity null and does not inject the field', async () => {
    const { client, transport } = makeClient([
      {
        operation_name: 'Whoami',
        response: {
          data: {
            me: { id: '1', name: 'A', email: 'a@x.test', account: { id: '9', name: 'O', slug: null } },
            // even if Monday returns complexity, the CLI ignores it without --verbose
            complexity: { before: 1, after: 1, query: 0, reset_in_x_seconds: 0 },
          },
        },
      },
    ]);
    const result = await client.whoami();
    expect(transport.requests[0]?.query).not.toContain('complexity {');
    expect(result.complexity).toBeNull();
  });

  it('GraphQL errors[] are surfaced as typed ApiError', async () => {
    const { client } = makeClient([
      {
        operation_name: 'Whoami',
        response: {
          errors: [
            {
              message: 'Not authenticated',
              extensions: { code: 'AUTHENTICATION_ERROR' },
            },
          ],
        },
      },
    ]);
    await expect(client.whoami()).rejects.toMatchObject({
      code: 'unauthorized',
      retryable: false,
    });
  });

  it('retries on retryable errors and reports stats', async () => {
    const { client, transport } = makeClient([
      {
        operation_name: 'Whoami',
        response: {
          errors: [
            {
              message: 'rate limited',
              extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 0 },
            },
          ],
        },
        repeat: 2,
      },
      {
        operation_name: 'Whoami',
        response: {
          data: {
            me: { id: '1', name: 'A', email: 'a@x.test', account: { id: '9', name: 'O', slug: null } },
          },
        },
      },
    ]);
    const result = await client.whoami();
    expect(result.stats.attempts).toBe(3);
    expect(transport.requests).toHaveLength(3);
  });

  it('exact-N transport-attempt regression — no double retries from a hidden layer', async () => {
    // Pure retryable failure all the way through. The plan §3 M2
    // SDK-retry-double-counting risk: this assertion catches any future
    // SDK update that re-introduces a hidden retry around our own.
    const { client, transport } = makeClient([
      {
        operation_name: 'Whoami',
        response: {
          errors: [
            {
              message: 'rate limited',
              extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 0 },
            },
          ],
        },
        repeat: 10,
      },
    ]);
    await expect(client.whoami()).rejects.toMatchObject({
      code: 'rate_limited',
    });
    // retries=3 → exactly 4 transport attempts.
    expect(transport.requests).toHaveLength(4);
  });

  it('aborts mid-flight when the signal fires', async () => {
    const ctrl = new AbortController();
    const { client } = makeClient(
      [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: { id: '1', name: 'A', email: 'a@x.test', account: { id: '9', name: 'O', slug: null } },
            },
          },
        },
      ],
      { signal: ctrl.signal },
    );
    ctrl.abort('cancelled');
    await expect(client.whoami()).rejects.toBeInstanceOf(ApiError);
  });

  it('raw allows arbitrary queries with typed variables', async () => {
    const { client, transport } = makeClient([
      {
        match_query: 'query Custom',
        match_variables: { id: '42' },
        response: { data: { items: [{ id: '42', name: 'thing' }] } },
      },
    ]);
    const result = await client.raw<{ items: { id: string; name: string }[] }>(
      'query Custom($id: ID!) { items(ids: [$id]) { id name } }',
      { id: '42' },
    );
    expect(result.data.items[0]?.name).toBe('thing');
    expect(transport.requests[0]?.variables).toEqual({ id: '42' });
  });
});
