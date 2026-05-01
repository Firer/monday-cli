/**
 * Shared integration-test scaffolding (R6, surfaced post-M3 in
 * `v0.1-plan.md` §15).
 *
 * Every M3 integration test file (account / workspace / board / user /
 * update) repeated ~50 lines of identical setup: a `baseOptions`
 * factory that wires a `PassThrough` stdout/stderr + canned token +
 * fixed clock; an `EnvelopeShape` + `parseEnvelope` + envelope-
 * contract assertions; a `drive(argv, cassette, overrides?)` shorthand
 * that constructs a `FixtureTransport`, calls `run`, and returns the
 * captured streams. M4 lands 5 more integration test files; folding
 * the duplication out before the wave hits keeps each new file at one
 * import line.
 *
 * The signatures match the M3 call sites verbatim so the migration is
 * mechanical: rename the local `baseOptions` / `drive` calls into
 * helpers from this module and delete the duplicated definitions. The
 * one variant — `board.test.ts`'s closure-captured `XDG_CACHE_HOME` —
 * is supported by passing `env:` through the existing override slot,
 * the same shape `account.test.ts` already used for its
 * config-error and env-API-version regression tests.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect } from 'vitest';
import { run, type RunOptions } from '../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../src/utils/request-id.js';
import {
  createFixtureTransport,
  type Cassette,
} from '../fixtures/load.js';

/**
 * Sentinel token threaded through every fixture so the redaction-
 * hardening regression suite (`tests/integration/redaction.test.ts`)
 * can search the entire emitted-bytes corpus for it. Kept exported
 * because new test files may want to assert on it directly.
 */
export const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';
export const FIXTURE_API_URL = 'https://api.monday.com/v2';

/** Frozen clock the M3 + M4 envelope-contract tests assert against. */
export const FIXED_CLOCK = '2026-04-30T10:00:00Z';

export interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

/**
 * Builds a `RunOptions` over a `PassThrough` stdout/stderr pair plus
 * a canned env (token, API URL), fixed clock, and fixed request-id
 * generator. `overrides` is sprayed verbatim so callers can replace
 * `argv` / `transport` / `env` / `clock` / `signal` without
 * re-deriving the rest. The shape is intentionally identical to the
 * per-file copies M3 shipped — see the module header for the
 * extraction rationale.
 */
export const baseOptions = (
  overrides: Partial<RunOptions> = {},
): { options: RunOptions; captured: Captured } => {
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
      MONDAY_API_URL: FIXTURE_API_URL,
    },
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-req-id']),
    clock: () => new Date(FIXED_CLOCK),
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

/**
 * Loose envelope shape used for cross-test assertions on
 * `cli-design.md` §6.1 + §6.3. Fields are widened so the same shape
 * accommodates both single-resource and collection envelopes; per-
 * test files cast through this to their command-specific
 * `data` shape via `as EnvelopeShape & { data: ... }`.
 */
export interface EnvelopeShape {
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
    readonly has_more?: boolean;
    readonly total_returned?: number;
    readonly next_cursor?: string | null;
  };
  readonly warnings?: readonly { readonly code: string }[];
}

export const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

/**
 * Asserts the universal §6.1 meta keys exist and have plausible
 * types. Doesn't pin specific values — that's the per-test concern.
 * Codex M0 review §10 caught a missing `meta.complexity` slot; this
 * helper keeps that regression closed across every command.
 */
export const assertEnvelopeContract = (env: EnvelopeShape): void => {
  expect(env.meta.schema_version).toBe('1');
  expect(typeof env.meta.api_version).toBe('string');
  expect(typeof env.meta.cli_version).toBe('string');
  expect(typeof env.meta.request_id).toBe('string');
  expect(typeof env.meta.source).toBe('string');
  expect(env.meta).toHaveProperty('cache_age_seconds');
  expect(env.meta).toHaveProperty('retrieved_at');
  expect(env.meta).toHaveProperty('complexity');
};

export interface DriveResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly remaining: number;
  readonly requests: number;
}

/**
 * The standard `drive(argv, cassette, overrides?)` shape: builds a
 * fresh `FixtureTransport`, prepends the argv with `['node', 'monday']`,
 * runs the CLI, and returns the captured streams + cassette state.
 * Identical signature to the per-file copies M3 shipped.
 */
export const drive = async (
  argv: readonly string[],
  cassette: Cassette,
  overrides: Partial<RunOptions> = {},
): Promise<DriveResult> => {
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
    remaining: transport.remaining(),
    requests: transport.requests.length,
  };
};

/**
 * The shape returned by `useCachedIntegrationEnv` — a `drive` bound
 * to a per-test isolated `XDG_CACHE_HOME` plus an accessor for the
 * tmp root (used by tests that want to inspect cache files directly).
 */
export interface CachedIntegrationEnv {
  readonly drive: (
    argv: readonly string[],
    cassette: Cassette,
    overrides?: Partial<RunOptions>,
  ) => Promise<DriveResult>;
  /**
   * The current per-test tmp dir. Re-evaluated each call because
   * `beforeEach` swaps it. Mirrors the pre-R11 pattern board.test.ts
   * + _item-fixtures.ts shipped (a function rather than a value
   * because the closure is registered at module-load time).
   */
  readonly xdgRoot: () => string;
}

/**
 * Registers per-test `mkdtemp` + `rm` hooks for an isolated
 * `XDG_CACHE_HOME` and returns a `drive(argv, cassette, overrides?)`
 * bound to that root. The `prefix` parameter names the tmpdir
 * directory ("monday-cli-board-int-", "monday-cli-item-int-", …)
 * so a leaked tmp dir is searchable.
 *
 * R11 lift (M5b cleanup, deferred from M3 / R14). Pre-fix the same
 * 8-line `mkdtemp` + closure pattern lived in `board.test.ts` and
 * `_item-fixtures.ts useItemTestEnv()`. The trigger fired in M5b
 * (third XDG-needing surface — item set / clear / update); R14 added
 * the item-specific helper but didn't fold board's copy into it.
 * Codex M5b finding #5 surfaced the leftover duplication.
 */
export const useCachedIntegrationEnv = (
  prefix: string,
): CachedIntegrationEnv => {
  let xdgRoot: string;
  beforeEach(async () => {
    xdgRoot = await mkdtemp(join(tmpdir(), prefix));
  });
  afterEach(async () => {
    await rm(xdgRoot, { recursive: true, force: true });
  });
  const cachedDrive = async (
    argv: readonly string[],
    cassette: Cassette,
    overrides: Partial<RunOptions> = {},
  ): Promise<DriveResult> => {
    const env = {
      MONDAY_API_TOKEN: LEAK_CANARY,
      MONDAY_API_URL: FIXTURE_API_URL,
      XDG_CACHE_HOME: xdgRoot,
    };
    return drive(argv, cassette, { env, ...overrides });
  };
  return { drive: cachedDrive, xdgRoot: () => xdgRoot };
};
