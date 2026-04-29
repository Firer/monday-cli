/**
 * Cassette format + FixtureTransport (`v0.1-plan.md` §5.2).
 *
 * A cassette is an ordered list of `Interaction` records — request
 * matchers + canned responses — that drives a `Transport` impl
 * (`FixtureTransport`) test code injects via `run({ transport })`.
 * Same format powers integration tests (in-process) and the E2E
 * fixture server (out-of-process); the loader is shared.
 *
 * Match rules per `Interaction`:
 *  - `operation_name` — fast key. When set, the request must carry
 *    `operationName: <value>` (the client sends it for typed methods).
 *  - `match_query` — substring or regex applied to the request's GraphQL
 *    document text. Tests use this to pin behaviour to a specific
 *    operation when several share an `operation_name`.
 *  - `match_variables` — partial deep-equal against the request's
 *    `variables` map. A subset match — fields not specified in the
 *    matcher don't have to be absent on the request.
 *  - `expect_headers` — assertions on caller-visible headers. Mostly
 *    used by the M2 token-leak suite to enforce that a fixture sees
 *    the exact `Authorization` header value.
 *
 * Responses:
 *  - `response.data` / `response.errors` — GraphQL-shape payload
 *    written into the fixture body verbatim. The client's error
 *    mapper (`api/errors.ts`) interprets `errors[]` as it would in
 *    production.
 *  - `http_status` — non-200 status (e.g. 423 for `resource_locked`).
 *  - `delay_ms` — hold the response open this long before resolving;
 *    used by the `timeout` regression test.
 *  - `repeat` — match `repeat` times before advancing to the next
 *    interaction. Pagination walks use this for "every page is the
 *    same shape".
 *
 * The transport advances through the list strictly in order — once
 * an interaction's `repeat` count is exhausted, it's consumed and
 * subsequent matches go to the next entry. Tests build minimal
 * cassettes; the helper records remaining interactions in a
 * post-test assertion so a forgotten one fails loudly rather than
 * silently lingering.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../src/api/transport.js';
import { ApiError } from '../../src/utils/errors.js';

const here = dirname(fileURLToPath(import.meta.url));

export interface GraphQlErrorShape {
  readonly message: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly path?: readonly (string | number)[];
}

export interface InteractionResponse {
  readonly data?: unknown;
  readonly errors?: readonly GraphQlErrorShape[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly error_code?: string;
  readonly error_message?: string;
}

export interface Interaction {
  readonly operation_name?: string;
  /** Substring or RegExp to match against `request.query`. */
  readonly match_query?: string | RegExp;
  readonly match_variables?: Readonly<Record<string, unknown>>;
  readonly expect_headers?: Readonly<Record<string, string | RegExp>>;
  readonly response?: InteractionResponse;
  readonly response_body?: unknown;
  readonly response_headers?: Readonly<Record<string, string>>;
  readonly http_status?: number;
  readonly delay_ms?: number;
  /** Default 1. */
  readonly repeat?: number;
}

export interface Cassette {
  readonly interactions: readonly Interaction[];
}

export interface FixtureTransportOptions {
  /**
   * When true, leftover interactions raise on `assertConsumed()` —
   * the default. Tests that intentionally over-cassette (the leak
   * suite drives multiple paths against one fixture) opt out by
   * setting this to false.
   */
  readonly assertExhaustive?: boolean;
}

export interface FixtureTransport extends Transport {
  /** Throws if the cassette wasn't fully consumed. */
  readonly assertConsumed: () => void;
  /** Records of the requests that came through, in order. */
  readonly requests: readonly TransportRequest[];
  /** Read-only view of remaining interactions (mainly for diagnostics). */
  readonly remaining: () => number;
}

export const loadCassette = async (
  relativePath: string,
): Promise<Cassette> => {
  const resolved = join(here, relativePath);
  const raw = await readFile(resolved, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return normaliseCassette(parsed);
};

const normaliseCassette = (input: unknown): Cassette => {
  if (!isObject(input) || !Array.isArray(input.interactions)) {
    throw new Error('cassette: expected `{interactions: [...]}`');
  }
  return { interactions: input.interactions as readonly Interaction[] };
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const queryMatches = (
  haystack: string,
  matcher: string | RegExp | undefined,
): boolean => {
  if (matcher === undefined) return true;
  if (typeof matcher === 'string') return haystack.includes(matcher);
  return matcher.test(haystack);
};

const variablesMatch = (
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (expected === undefined) return true;
  for (const [key, value] of Object.entries(expected)) {
    if (actual === undefined) return false;
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
};

const headersMatch = (
  actual: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string | RegExp>> | undefined,
): boolean => {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(actual)) {
    lower[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(expected)) {
    const got = lower[k.toLowerCase()];
    if (got === undefined) return false;
    if (typeof v === 'string' && got !== v) return false;
    if (v instanceof RegExp && !v.test(got)) return false;
  }
  return true;
};

interface RuntimeInteraction {
  readonly spec: Interaction;
  remaining: number;
}

/**
 * Builds a `FixtureTransport` over an in-memory `Cassette`. The
 * shape mirrors `FetchTransport` (same `request(req)` signature) so
 * tests inject this via `run({ transport })` without touching any
 * other layer — header injection / retry / error mapping all run
 * against the canned response bytes.
 */
export const createFixtureTransport = (
  cassette: Cassette,
  options: FixtureTransportOptions = {},
): FixtureTransport => {
  const queue: RuntimeInteraction[] = cassette.interactions.map((spec) => ({
    spec,
    remaining: spec.repeat ?? 1,
  }));
  const requests: TransportRequest[] = [];

  const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) {
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new Error('aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        const reason: unknown = signal?.reason;
        reject(reason instanceof Error ? reason : new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return {
    requests,
    remaining: (): number =>
      queue.reduce((sum, i) => sum + Math.max(0, i.remaining), 0),

    request: async (req: TransportRequest): Promise<TransportResponse> => {
      requests.push(req);
      while (queue.length > 0 && (queue[0]?.remaining ?? 0) <= 0) {
        queue.shift();
      }
      const next = queue[0];
      if (next === undefined) {
        throw new ApiError(
          'internal_error',
          `cassette exhausted: no interaction matches operation=${
            req.operationName ?? '<anon>'
          }`,
        );
      }
      const spec = next.spec;
      if (
        spec.operation_name !== undefined &&
        spec.operation_name !== req.operationName
      ) {
        throw new ApiError(
          'internal_error',
          `cassette mismatch: expected operation_name=${spec.operation_name}, ` +
            `got ${req.operationName ?? '<anon>'}`,
        );
      }
      if (!queryMatches(req.query, spec.match_query)) {
        throw new ApiError(
          'internal_error',
          'cassette mismatch: match_query did not match the request query',
        );
      }
      if (!variablesMatch(req.variables, spec.match_variables)) {
        throw new ApiError(
          'internal_error',
          `cassette mismatch: variables did not match expected ${JSON.stringify(
            spec.match_variables,
          )}`,
        );
      }
      if (!headersMatch(req.headers, spec.expect_headers)) {
        throw new ApiError(
          'internal_error',
          `cassette mismatch: headers did not match expected ${JSON.stringify(
            spec.expect_headers,
          )}`,
        );
      }
      next.remaining--;

      if (spec.delay_ms !== undefined && spec.delay_ms > 0) {
        await sleep(spec.delay_ms, req.signal);
      }

      const status = spec.http_status ?? 200;
      const body =
        spec.response_body !== undefined ? spec.response_body : spec.response;
      const headers: Readonly<Record<string, string>> = {
        'content-type': 'application/json',
        ...(spec.response_headers ?? {}),
      };
      return { status, headers, body };
    },

    assertConsumed: (): void => {
      if (options.assertExhaustive === false) {
        return;
      }
      const remaining = queue.reduce(
        (sum, i) => sum + Math.max(0, i.remaining),
        0,
      );
      if (remaining > 0) {
        throw new Error(
          `cassette not consumed: ${String(remaining)} interaction(s) left`,
        );
      }
    },
  };
};

/**
 * Convenience builder: creates a `FixtureTransport` directly from a
 * literal `Interaction[]`. Used in tests where the shape is small
 * enough that loading from a JSON file would just add ceremony.
 */
export const createInlineFixtureTransport = (
  interactions: readonly Interaction[],
  options: FixtureTransportOptions = {},
): FixtureTransport =>
  createFixtureTransport({ interactions }, options);
