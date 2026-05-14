/**
 * Multipart cassette format + `MultipartFixtureTransport` for the
 * v0.4-M31 asset-upload integration suite.
 *
 * Mirrors `tests/fixtures/load.ts`'s `FixtureTransport` shape but for
 * the new `MultipartTransport` seam (`src/api/multipart-transport.ts`)
 * — JSON fixtures keyed by `operationName` and either a canned
 * `data` payload or a GraphQL `errors[]` array. Tests inject one of
 * these via the new `RunOptions.multipartTransport` slot so the M31
 * action bodies (`item upload` / `update upload`) call into a
 * deterministic multipart wire instead of `createMultipartFetchTransport`'s
 * real `fetch` dispatch.
 *
 * **Why a separate fixture rather than reusing `FixtureTransport`.**
 * The JSON cassette's `match_query` / `match_variables` apply to
 * `query` strings; multipart requests carry the GraphQL document
 * inside an `operations` JSON part PLUS a binary `Blob`. The fixture
 * captures both — the rendered FormData parts (operations + map +
 * file part metadata) plus the raw file bytes — so tests can assert
 * on the multipart wire shape, not just the operation name. Reusing
 * `FixtureTransport` would conflate two transports with different
 * invariants.
 *
 * **What gets captured per request:**
 *   - `operationName` + `query` + `variables` (the GraphQL operation
 *     payload).
 *   - `fileVariableName` (which variable the multipart `map` JSON
 *     pins the binary part to).
 *   - `filename` (the multipart part's `filename` parameter).
 *   - `fileBytes` (the file's binary content, snapshotted to a
 *     `Uint8Array` at receive time so retries that re-stream the
 *     `Blob` show up as identical bytes per attempt).
 *   - `fileSize` (length of `fileBytes`).
 *   - `fileType` (the `Blob`'s `type` — sniffed at the action body).
 *   - `signal.aborted` snapshot at receive time + a reference to the
 *     signal so tests can `expect(req.signal).toBeInstanceOf(...)`.
 *
 * **Cassette match rules** (subset of the JSON cassette's contract):
 *   - `operation_name` — must match `request.operationName`.
 *   - `match_filename` — string or RegExp checked against
 *     `request.filename`.
 *   - `match_variables` — partial deep-equal against
 *     `request.variables` (subset match — fields not specified
 *     don't have to be absent on the request).
 *
 * **Response shapes** mirror the JSON fixture's:
 *   - `response.data` / `response.errors` — written verbatim into a
 *     `{data?, errors?}` envelope; the asset-upload fetcher's
 *     `assertResponseFieldPresent` + `assetSchema.safeParse(...)`
 *     parse boundary then handles the rest.
 *   - `http_status` — non-200s rewrap as `ApiError` per the
 *     transport's error-mapping discipline.
 *   - `delay_ms` — hold the response open this long before
 *     resolving (used by the SIGINT integration test).
 *   - `repeat` — match `repeat` times before advancing (used by the
 *     retry-then-succeed test).
 */

import { ApiError } from '../../src/utils/errors.js';
import type {
  MultipartTransport,
  MultipartTransportRequest,
  MultipartTransportResponse,
} from '../../src/api/multipart-transport.js';

/**
 * Snapshot of one multipart request the fixture observed. The `file`
 * `Blob` from `MultipartTransportRequest` is read into `fileBytes`
 * synchronously-with-await at receive time — capturing bytes per
 * retry attempt rather than holding a reference that could be re-
 * read by the next attempt + return different content (defence in
 * depth around the `Blob.stream()` re-readability invariant the
 * round-7 closure pinned).
 */
export interface CapturedMultipartRequest {
  readonly operationName: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly fileVariableName: string;
  readonly filename: string;
  readonly fileBytes: Uint8Array;
  readonly fileSize: number;
  readonly fileType: string;
  /** Signal the request was issued under — same identity as the runner's combined signal. */
  readonly signal: AbortSignal;
  /** Was the signal already aborted at receive time? */
  readonly signalAbortedAtReceive: boolean;
}

export interface MultipartGraphQlErrorShape {
  readonly message: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly path?: readonly (string | number)[];
}

export interface MultipartInteractionResponse {
  readonly data?: unknown;
  readonly errors?: readonly MultipartGraphQlErrorShape[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly error_code?: string;
  readonly error_message?: string;
}

export interface MultipartInteraction {
  readonly operation_name: string;
  /** Substring or RegExp to match against `request.filename`. */
  readonly match_filename?: string | RegExp;
  readonly match_variables?: Readonly<Record<string, unknown>>;
  readonly response?: MultipartInteractionResponse;
  readonly response_body?: unknown;
  readonly response_headers?: Readonly<Record<string, string>>;
  readonly http_status?: number;
  readonly delay_ms?: number;
  /** Default 1. */
  readonly repeat?: number;
}

export interface MultipartCassette {
  readonly interactions: readonly MultipartInteraction[];
}

export interface MultipartFixtureTransportOptions {
  /** Default true — leftover interactions raise on `assertConsumed()`. */
  readonly assertExhaustive?: boolean;
}

export interface MultipartFixtureTransport extends MultipartTransport {
  readonly assertConsumed: () => void;
  /** Captured requests in order. */
  readonly requests: readonly CapturedMultipartRequest[];
  readonly remaining: () => number;
}

const filenameMatches = (
  haystack: string,
  matcher: string | RegExp | undefined,
): boolean => {
  if (matcher === undefined) return true;
  if (typeof matcher === 'string') return haystack === matcher;
  return matcher.test(haystack);
};

const variablesMatch = (
  actual: Readonly<Record<string, unknown>>,
  expected: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (expected === undefined) return true;
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
};

interface RuntimeMultipartInteraction {
  readonly spec: MultipartInteraction;
  remaining: number;
}

const sleepWithSignal = (
  ms: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      const reason: unknown = signal.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Builds a `MultipartFixtureTransport` over an in-memory cassette.
 * Mirrors `createFixtureTransport` from `tests/fixtures/load.ts`:
 * advances strictly in order, exhausts an interaction before
 * advancing, fails loudly on cassette-mismatch / cassette-exhaustion.
 */
export const createMultipartFixtureTransport = (
  cassette: MultipartCassette,
  options: MultipartFixtureTransportOptions = {},
): MultipartFixtureTransport => {
  const queue: RuntimeMultipartInteraction[] = cassette.interactions.map(
    (spec) => ({ spec, remaining: spec.repeat ?? 1 }),
  );
  const requests: CapturedMultipartRequest[] = [];

  const transport: MultipartFixtureTransport = {
    requests,
    remaining: (): number =>
      queue.reduce((sum, i) => sum + Math.max(0, i.remaining), 0),

    request: async (
      req: MultipartTransportRequest,
    ): Promise<MultipartTransportResponse> => {
      // Capture file bytes at receive time so retries (which re-read
      // `req.file.stream()`) yield identical snapshots per attempt.
      const buffer = await req.file.arrayBuffer();
      const fileBytes = new Uint8Array(buffer);
      requests.push({
        operationName: req.operationName,
        query: req.query,
        variables: req.variables,
        fileVariableName: req.fileVariableName,
        filename: req.filename,
        fileBytes,
        fileSize: fileBytes.length,
        fileType: req.file.type,
        signal: req.signal,
        signalAbortedAtReceive: req.signal.aborted,
      });

      while (queue.length > 0 && (queue[0]?.remaining ?? 0) <= 0) {
        queue.shift();
      }
      const next = queue[0];
      if (next === undefined) {
        throw new ApiError(
          'internal_error',
          `multipart cassette exhausted: no interaction matches ` +
            `operation=${req.operationName}`,
        );
      }
      const spec = next.spec;
      if (spec.operation_name !== req.operationName) {
        throw new ApiError(
          'internal_error',
          `multipart cassette mismatch: expected operation_name=` +
            `${spec.operation_name}, got ${req.operationName}`,
        );
      }
      if (!filenameMatches(req.filename, spec.match_filename)) {
        throw new ApiError(
          'internal_error',
          `multipart cassette mismatch: filename ${JSON.stringify(req.filename)} ` +
            `did not match expected ${JSON.stringify(spec.match_filename)}`,
        );
      }
      if (!variablesMatch(req.variables, spec.match_variables)) {
        throw new ApiError(
          'internal_error',
          `multipart cassette mismatch: variables did not match expected ${ 
            JSON.stringify(spec.match_variables)}`,
        );
      }
      next.remaining--;

      if (spec.delay_ms !== undefined && spec.delay_ms > 0) {
        await sleepWithSignal(spec.delay_ms, req.signal);
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
          `multipart cassette not consumed: ${String(remaining)} ` +
            `interaction(s) left`,
        );
      }
    },
  };
  return transport;
};

/**
 * Convenience builder: creates a fixture directly from a literal
 * `MultipartInteraction[]`. Mirrors `createInlineFixtureTransport`.
 */
export const createInlineMultipartFixtureTransport = (
  interactions: readonly MultipartInteraction[],
  options: MultipartFixtureTransportOptions = {},
): MultipartFixtureTransport =>
  createMultipartFixtureTransport({ interactions }, options);
