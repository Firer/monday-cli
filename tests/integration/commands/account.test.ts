/**
 * Integration tests for `monday account *` (`v0.1-plan.md` §3 M2).
 *
 * Drives the runner end-to-end via `run(options)` with a
 * `FixtureTransport` injected through `options.transport` — the same
 * `commands/` → `api/` → transport path the published binary
 * exercises, just with cassette bytes instead of real network. The
 * envelope contract test (§5.2) lives at the bottom of the file and
 * runs against every emitted JSON envelope so a future schema drift
 * fails loudly across all four commands.
 */
import { describe, expect, it } from 'vitest';
import { run } from '../../../src/cli/run.js';
import {
  createInlineFixtureTransport,
  type Cassette,
  type Interaction,
} from '../../fixtures/load.js';
import {
  baseOptions,
  drive,
  parseEnvelope,
  assertEnvelopeContract,
  FIXTURE_API_URL,
  LEAK_CANARY,
  type EnvelopeShape,
} from '../helpers.js';

const whoamiInteraction: Interaction = {
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
};

const accountInteraction: Interaction = {
  operation_name: 'AccountInfo',
  response: {
    data: {
      account: {
        id: '99',
        name: 'Org',
        slug: 'org',
        country_code: 'GB',
        first_day_of_the_week: 'monday',
        active_members_count: 7,
        logo: null,
        plan: { version: 1, tier: 'pro', max_users: 100, period: 'annual' },
      },
    },
  },
};

const versionsInteraction: Interaction = {
  operation_name: 'Versions',
  response: {
    data: {
      versions: [
        { display_name: '2026-01', kind: 'current', value: '2026-01' },
        { display_name: '2025-10', kind: 'maintenance', value: '2025-10' },
      ],
    },
  },
};

const complexityInteraction: Interaction = {
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
};

describe('monday account whoami (integration)', () => {
  it('emits the projected user + envelope contract', async () => {
    const out = await drive(
      ['account', 'whoami', '--json'],
      { interactions: [whoamiInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
    expect(env.meta.api_version).toBe('2026-01');
    expect(env.meta.complexity).toBeNull();
    expect(env.data).toEqual({
      me: {
        id: '1',
        name: 'Alice',
        email: 'alice@example.test',
        account: { id: '99', name: 'Org', slug: 'org' },
      },
    });
    expect(out.stderr).toBe('');
    expect(out.remaining).toBe(0);
  });

  it('--verbose adds meta.complexity to the envelope', async () => {
    const verboseInteraction: Interaction = {
      operation_name: 'Whoami',
      // The verbose path injects complexity{...} at the operation
      // root; we don't pin the literal query here (the injector has
      // its own unit tests), only that the response gets parsed.
      response: {
        data: {
          me: {
            id: '1',
            name: 'A',
            email: 'a@x.test',
            account: { id: '9', name: 'O', slug: null },
          },
          complexity: {
            before: 5_000_000,
            after: 4_999_998,
            query: 2,
            reset_in_x_seconds: 30,
          },
        },
      },
    };
    const out = await drive(
      ['--verbose', 'account', 'whoami', '--json'],
      { interactions: [verboseInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.complexity).toEqual({
      used: 2,
      remaining: 4_999_998,
      reset_in_seconds: 30,
    });
  });

  it('--api-version is also reflected in the error envelope meta', async () => {
    // Codex M2 review §2: previously, the runner's catch-all built
    // meta from env defaults so the error envelope claimed
    // api_version: "2026-01" / source: "none" even when the
    // action attempted a live call with --api-version 2026-04.
    // The action now commits the resolved meta to ctx.meta
    // before the network goes out; the error path reads it.
    const out = await drive(
      ['--api-version', '2026-04', 'account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {},
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
    expect(env.meta.source).toBe('live');
  });

  it('--api-version overrides the API-Version on the wire and in meta', async () => {
    // Cassette asserts the request carried the override value.
    const interaction: Interaction = {
      operation_name: 'Whoami',
      // Header lockdown lives in FetchTransport (not our injected
      // FixtureTransport), so we don't expect_headers here. What
      // *is* still observable: meta.api_version reflects the
      // override.
      response: { data: { me: { id: '1', name: 'A', email: 'a@x.test', account: { id: '9', name: 'O', slug: null } } } },
    };
    const out = await drive(
      ['--api-version', '2026-04', 'account', 'whoami', '--json'],
      { interactions: [interaction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.api_version).toBe('2026-04');
  });

  it('surfaces unauthorized when Monday returns me: null', async () => {
    const out = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: { data: { me: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('unauthorized');
  });

  it('exits 3 with config_error envelope when MONDAY_API_TOKEN is missing', async () => {
    const transport = createInlineFixtureTransport([whoamiInteraction]);
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'account', 'whoami', '--json'],
      env: {}, // no token
      transport,
    });
    const result = await run(options);
    expect(result.exitCode).toBe(3);
    const env = parseEnvelope(captured.stderr());
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('config_error');
    // No bytes on stdout when an error envelope is on stderr.
    expect(captured.stdout()).toBe('');
  });
});

describe('monday account info (integration)', () => {
  it('returns the projected account fields', async () => {
    const out = await drive(
      ['account', 'info', '--json'],
      { interactions: [accountInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toMatchObject({
      id: '99',
      name: 'Org',
      country_code: 'GB',
      plan: { tier: 'pro', max_users: 100 },
    });
  });

  it('surfaces not_found when Monday returns account: null', async () => {
    const out = await drive(
      ['account', 'info', '--json'],
      {
        interactions: [
          {
            operation_name: 'AccountInfo',
            response: { data: { account: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});

describe('monday account version (integration)', () => {
  it('reports pinned + available, with sdk_default = SDK pin', async () => {
    const out = await drive(
      ['account', 'version', '--json'],
      { interactions: [versionsInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toMatchObject({
      pinned: { value: '2026-01', source: 'sdk_default', sdk_default: '2026-01' },
      available: [
        { display_name: '2026-01', kind: 'current', value: '2026-01' },
        { display_name: '2025-10', kind: 'maintenance', value: '2025-10' },
      ],
    });
  });

  it('reports pinned.source as `flag` when --api-version is passed', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'account', 'version', '--json'],
      { interactions: [versionsInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { pinned: { value: string; source: string } };
    };
    expect(env.data.pinned).toMatchObject({ value: '2026-04', source: 'flag' });
  });

  it('reports pinned.source as `env` when MONDAY_API_VERSION is set', async () => {
    const transport = createInlineFixtureTransport([versionsInteraction]);
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'account', 'version', '--json'],
      env: {
        MONDAY_API_TOKEN: LEAK_CANARY,
        MONDAY_API_VERSION: '2026-04',
        MONDAY_API_URL: FIXTURE_API_URL,
      },
      transport,
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as EnvelopeShape & {
      data: { pinned: { value: string; source: string } };
    };
    expect(env.data.pinned).toMatchObject({ value: '2026-04', source: 'env' });
  });
});

describe('monday account complexity (integration)', () => {
  it('reports the budget snapshot with renamed fields', async () => {
    const out = await drive(
      ['account', 'complexity', '--json'],
      { interactions: [complexityInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toEqual({
      before: 5_000_000,
      used: 1,
      remaining: 4_999_999,
      reset_in_seconds: 30,
    });
  });

  it('surfaces internal_error when Monday returns no complexity block', async () => {
    const out = await drive(
      ['account', 'complexity', '--json'],
      {
        interactions: [
          {
            operation_name: 'ComplexityProbe',
            response: { data: { complexity: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  // Regression: --verbose against `account complexity` previously
  // tripped the data-stripper that removes the injected `complexity`
  // field — but `account complexity`'s own payload IS the
  // `complexity` field, so removing it left `data` empty and the
  // action threw `internal_error`. The fix tracks whether the
  // injector actually added the field (it didn't here — the query
  // already selected it) and only strips when we owned the
  // injection. (Codex M2 review §1.)
  it('--verbose preserves data while populating meta.complexity', async () => {
    const out = await drive(
      ['--verbose', 'account', 'complexity', '--json'],
      { interactions: [complexityInteraction] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { before: number; used: number; remaining: number; reset_in_seconds: number };
    };
    expect(env.data).toEqual({
      before: 5_000_000,
      used: 1,
      remaining: 4_999_999,
      reset_in_seconds: 30,
    });
    expect(env.meta.complexity).toEqual({
      used: 1,
      remaining: 4_999_999,
      reset_in_seconds: 30,
    });
  });
});

describe('error code coverage (§5.6 row M2)', () => {
  // Each entry produces the named code from a cassette response.
  // Drives `monday account whoami` because it's the simplest read
  // and the error is a property of the transport response, not the
  // command logic.
  // `expectedAttempts` pins the retry-budget contract per code:
  // retryable codes (rate_limited, complexity_exceeded, ...) MUST
  // see the full N=retries+1 transport hits; non-retryable codes
  // (daily_limit_exceeded, validation_failed) MUST see exactly 1.
  // Without this, a future regression where the retry layer
  // stopped retrying entirely would still satisfy the per-code
  // exit/code assertion. (Codex M2 review §6.)
  const cases: readonly {
    readonly name: string;
    readonly cassette: Cassette;
    readonly code: string;
    readonly exit: number;
    readonly expectedAttempts: number;
  }[] = [
    {
      name: 'unauthorized — HTTP 401',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {},
          },
        ],
      },
      code: 'unauthorized',
      exit: 2,
      expectedAttempts: 1,
    },
    {
      name: 'forbidden — HTTP 403',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 403,
            response: {},
          },
        ],
      },
      code: 'forbidden',
      exit: 2,
      expectedAttempts: 1,
    },
    {
      name: 'rate_limited — Monday RATE_LIMIT_EXCEEDED',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Minute limit rate exceeded',
                  // retry_in_seconds: 0 keeps the test fast — retry layer
                  // sleeps for 0ms; with retries=0 we surface immediately.
                  extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 0 },
                },
              ],
            },
            repeat: 4, // first call + retries (default 3)
          },
        ],
      },
      code: 'rate_limited',
      exit: 2,
      expectedAttempts: 4,
    },
    {
      name: 'complexity_exceeded — Monday ComplexityException',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Complexity budget exhausted',
                  extensions: { code: 'ComplexityException', retry_in_seconds: 0 },
                },
              ],
            },
            repeat: 4,
          },
        ],
      },
      code: 'complexity_exceeded',
      exit: 2,
      expectedAttempts: 4,
    },
    {
      name: 'daily_limit_exceeded — non-retryable so single attempt',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Daily limit reached',
                  extensions: { code: 'DAILY_LIMIT_EXCEEDED' },
                },
              ],
            },
          },
        ],
      },
      code: 'daily_limit_exceeded',
      exit: 2,
      expectedAttempts: 1,
    },
    {
      name: 'concurrency_exceeded',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Concurrency limit exceeded',
                  extensions: { code: 'CONCURRENCY_LIMIT_EXCEEDED', retry_in_seconds: 0 },
                },
              ],
            },
            repeat: 4,
          },
        ],
      },
      code: 'concurrency_exceeded',
      exit: 2,
      expectedAttempts: 4,
    },
    {
      name: 'ip_rate_limited',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'IP rate limit exceeded',
                  extensions: { code: 'IP_RATE_LIMIT_EXCEEDED' },
                },
              ],
            },
            repeat: 4,
          },
        ],
      },
      code: 'ip_rate_limited',
      exit: 2,
      expectedAttempts: 4,
    },
    {
      name: 'resource_locked — HTTP 423 + Retry-After',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 423,
            // 0 keeps the retry sleep instant — the assertion is on
            // the produced code, not on the wall-clock backoff.
            response_headers: { 'retry-after': '0' },
            response: { errors: [] },
            repeat: 4,
          },
        ],
      },
      code: 'resource_locked',
      exit: 2,
      expectedAttempts: 4,
    },
    {
      name: 'validation_failed — Monday ColumnValueException',
      cassette: {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'Bad something',
                  extensions: { code: 'ColumnValueException' },
                },
              ],
            },
          },
        ],
      },
      code: 'validation_failed',
      exit: 2,
      expectedAttempts: 1,
    },
  ];

  for (const c of cases) {
    it(`produces ${c.code} in exactly ${String(c.expectedAttempts)} transport attempt(s)`, async () => {
      const out = await drive(
        ['account', 'whoami', '--json'],
        c.cassette,
      );
      expect(out.exitCode).toBe(c.exit);
      const env = parseEnvelope(out.stderr);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe(c.code);
      // Pin the retry-budget contract — without this, a future
      // regression where the retry layer stopped retrying entirely
      // would still satisfy the per-code exit/code assertion.
      // (Codex M2 review §6.)
      expect(out.requests).toBe(c.expectedAttempts);
    });
  }

  // `timeout` and `network_error` are produced by the FetchTransport
  // (the layer that owns the actual `fetch` call). The E2E suite
  // covers them against the in-process fixture server — see
  // `tests/e2e/account.test.ts`. The integration suite here mocks
  // out the transport, so the timeout path is intentionally not
  // exercised through this layer.
});

describe('token-leak hardening', () => {
  // The leak canary `tok-leakcheck-deadbeef-canary` is set as
  // MONDAY_API_TOKEN in baseOptions. Each adversarial path exercises
  // a place a token could end up in the output if the redactor
  // missed it. We assert the literal canary is absent from every
  // emitted byte across stdout and stderr.

  it('redacts the token from a successful envelope', async () => {
    const out = await drive(
      ['account', 'whoami', '--json'],
      { interactions: [whoamiInteraction] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('redacts the token from an unauthorized error envelope', async () => {
    const out = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {
              errors: [
                {
                  message: `Bad token: ${LEAK_CANARY}`,
                  extensions: { code: 'AUTHENTICATION_ERROR' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('redacts the token from a retried-request error path', async () => {
    // Simulates a retryable error where the upstream message echoes
    // the token. The retry decorator wraps the final error with
    // details.attempts; the chain (cause + cause.cause) goes through
    // the redactor before bytes are emitted.
    const out = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 429,
            response: {
              errors: [
                {
                  message: `rate limited; auth=${LEAK_CANARY}`,
                  extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 0 },
                },
              ],
            },
            repeat: 4,
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });

  it('redacts the token from --verbose output even with a partially-leaky body', async () => {
    const out = await drive(
      ['--verbose', 'account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: `User ${LEAK_CANARY}`,
                  email: 'a@x.test',
                  account: { id: '9', name: 'O', slug: null },
                },
                complexity: { before: 1, after: 1, query: 0, reset_in_x_seconds: 0 },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    // Even the leaky `name` field gets the canary scrubbed by the
    // value-scan layer of `redact()`.
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});
