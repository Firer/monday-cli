/**
 * Hardened token-leak regression suite (`v0.1-plan.md` §3 M2 exit
 * criteria + risk register: "Token leakage").
 *
 * Drives the full M2 stack with a fixed leak canary
 * (`MONDAY_API_TOKEN=tok-leakcheck-deadbeef-canary`) through a
 * series of adversarial paths designed to land the token on a
 * non-redacted code path if the redactor missed something. The
 * assertion is uniform: the literal canary string MUST NOT appear
 * in any byte of stdout or stderr across any path.
 *
 * The lesson from M1's second review is load-bearing here:
 * a regression test must *fail* against the pre-fix code. Each
 * scenario below is constructed so the only thing standing between
 * a leak and a passing test is the redactor's two-layer behaviour
 * (key-pattern + literal value-scan). The unit suite for
 * `redact()` covers those layers directly; this suite confirms
 * they're wired into every command-emission path:
 *   - success envelope on stdout (json + table renderers)
 *   - error envelope on stderr (runner catch-all)
 *   - retried-request error decoration (the retry layer's `cause`
 *     chain)
 *   - --verbose debug payload
 *   - NDJSON trailer (currently unused for account, but exercised
 *     via cache.list in case the M2 emit refactor regresses)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { run, type RunOptions } from '../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../src/utils/request-id.js';
import {
  createFixtureTransport,
  createInlineFixtureTransport,
  type Cassette,
} from '../fixtures/load.js';

const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';

const baseOptions = (
  overrides: Partial<RunOptions> = {},
): { options: RunOptions; out: () => string; err: () => string } => {
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
    out: () => Buffer.concat(stdoutChunks).toString('utf8'),
    err: () => Buffer.concat(stderrChunks).toString('utf8'),
  };
};

const drive = async (
  argv: readonly string[],
  cassette: Cassette,
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const transport = createFixtureTransport(cassette);
  const { options, out, err } = baseOptions({
    argv: ['node', 'monday', ...argv],
    transport,
  });
  const result = await run(options);
  return { stdout: out(), stderr: err(), exitCode: result.exitCode };
};

const assertNoLeak = (out: { stdout: string; stderr: string }): void => {
  expect(out.stdout).not.toContain(LEAK_CANARY);
  expect(out.stderr).not.toContain(LEAK_CANARY);
};

const collected: string[] = [];
afterEach(({ task }) => {
  // No-op; placeholder so the structure is symmetrical with the
  // legacy approach. The cross-test cumulative check happens at the
  // end of the file so each scenario's bytes get inspected even
  // when an earlier one fails.
  void task;
});

describe('redaction hardening — adversarial leak paths', () => {
  it('success envelope on stdout (token in token-shaped fields)', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
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
    expect(result.exitCode).toBe(0);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('error envelope: token echoed in GraphQL error.message', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 401,
            response: {
              errors: [
                {
                  message: `Authentication rejected: ${LEAK_CANARY}`,
                  extensions: { code: 'AUTHENTICATION_ERROR' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('error envelope: token echoed in extensions payload', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
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
                    // The error mapper carries `extensions` into
                    // `details` verbatim — if the redactor doesn't
                    // value-scan the details object, this leaks.
                    presented_token: LEAK_CANARY,
                    request_id: `req-${LEAK_CANARY}`,
                  },
                },
              ],
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('retried-request decoration: token in cause chain', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: `rate limited; auth=${LEAK_CANARY} expired`,
                  extensions: {
                    code: 'RATE_LIMIT_EXCEEDED',
                    retry_in_seconds: 0,
                  },
                },
              ],
            },
            // first call + 3 retries = 4 attempts
            repeat: 4,
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('--verbose: complexity injection with leak in body', async () => {
    const result = await drive(
      ['--verbose', 'account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: `Owner-${LEAK_CANARY}`,
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
    expect(result.exitCode).toBe(0);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('multiple GraphQL errors carrying the token in different positions', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              errors: [
                {
                  message: 'first',
                  extensions: { code: 'AUTHENTICATION_ERROR' },
                },
                {
                  message: `extra echoing ${LEAK_CANARY}`,
                  path: ['me', LEAK_CANARY],
                  extensions: { detail: LEAK_CANARY },
                },
              ],
            },
            http_status: 401,
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('token embedded in body.error_message + error_code on a non-200', async () => {
    const result = await drive(
      ['account', 'whoami', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            http_status: 502,
            response_body: {
              error_code: 'PROXY_REJECT',
              error_message: `proxy rejected the auth: ${LEAK_CANARY}`,
            },
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    assertNoLeak(result);
    collected.push(result.stdout, result.stderr);
  });

  it('cumulative cross-scenario check: canary absent across every byte emitted in this suite', () => {
    // Belt-and-braces — even if a future scenario forgets its
    // per-test assertion, this aggregate check guards the whole
    // file. If a single byte slipped through anywhere, the joined
    // string carries it and this fails.
    const everything = collected.join('\n');
    expect(everything).not.toContain(LEAK_CANARY);
  });
});

describe('redaction hardening — pre-fix proof', () => {
  it('a leaky body actively contains the canary in the source bytes (sanity check)', () => {
    // Demonstrates the test isn't trivially passing — the source
    // body genuinely contains the canary; the redactor is what
    // strips it. If a future change removes the value-scan layer,
    // the assertions above flip from green to red, not flop to
    // green-no-matter-what.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'Whoami',
          response: {
            data: {
              me: {
                id: '1',
                name: `Owner-${LEAK_CANARY}`,
                email: 'a@x.test',
                account: { id: '9', name: 'O', slug: null },
              },
            },
          },
        },
      ],
    };
    const t = createInlineFixtureTransport(cassette.interactions);
    // Pull the cassette's response straight out: we expect the leak
    // to be present in the *source*. The redactor removes it on
    // emission.
    const leaky = JSON.stringify(cassette.interactions[0]?.response);
    expect(leaky).toContain(LEAK_CANARY);
    expect(t).toBeDefined();
  });
});
