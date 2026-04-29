import { ApiError } from '../utils/errors.js';

/**
 * Transport interface (`v0.1-plan.md` §2 pre-flight, §5.2).
 *
 * Sits between `commands/*` and the network. The injected
 * `Transport` is what `run({ transport })` swaps under tests — a
 * `FixtureTransport` substitutes for `FetchTransport` so the same
 * commands → api → transport stack runs in tests as in production
 * (header injection, abort handling, timeout, retry mapping). The
 * alternative — `vi.spyOn`'ing the SDK's `request` method — was
 * the original plan and got rejected in the Codex review because
 * it bypasses too many layers.
 *
 * The transport does **not** map GraphQL errors to CLI error codes;
 * that's `api/errors.ts` in M2. Network-level failures (refused
 * connection, timeout, malformed JSON) become `ApiError`s here so
 * the runner never sees a raw `fetch` exception.
 */
export interface TransportRequest {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly operationName?: string;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Parsed JSON body. GraphQL responses are JSON; if the upstream
   * returns something else (HTML error page, etc.) the transport
   * surfaces an `ApiError(network_error)` rather than a partially-
   * decoded payload.
   */
  readonly body: unknown;
}

export interface Transport {
  readonly request: (req: TransportRequest) => Promise<TransportResponse>;
}

export interface FetchTransportConfig {
  readonly endpoint: string;
  readonly apiToken: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** Override for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Builds a `Transport` over `fetch`. Owns:
 *  - `Authorization: <token>` (no `Bearer ` prefix per Monday's API).
 *  - `API-Version: <pinned>` per `cli-design.md` §2.
 *  - `Content-Type: application/json`.
 *  - Per-request timeout via `AbortSignal.timeout` chained with the
 *    caller's signal so external cancellation still wins.
 *
 * The token never reaches an error message, log line, or URL.
 */
export const createFetchTransport = (
  config: FetchTransportConfig,
): Transport => {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    request: async ({
      query,
      variables,
      headers,
      signal,
      operationName,
    }) => {
      const requestHeaders: Record<string, string> = {
        Authorization: config.apiToken,
        'API-Version': config.apiVersion,
        'Content-Type': 'application/json',
        ...headers,
      };

      const body: Record<string, unknown> = { query };
      if (variables !== undefined) {
        body.variables = variables;
      }
      if (operationName !== undefined) {
        body.operationName = operationName;
      }

      const combinedSignal = combineSignals(
        signal,
        AbortSignal.timeout(config.timeoutMs),
      );

      let response: Response;
      try {
        response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify(body),
          signal: combinedSignal,
        });
      } catch (err) {
        // Don't ever interpolate the token into the error string —
        // `requestHeaders` stays out of the message; `cause` carries
        // the raw error (which the redactor will scrub before emit).
        if (isAbortError(err) && combinedSignal.reason !== signal?.reason) {
          throw new ApiError(
            'timeout',
            `request timed out after ${String(config.timeoutMs)}ms`,
            { cause: err, details: { timeout_ms: config.timeoutMs } },
          );
        }
        throw new ApiError('network_error', describeFetchError(err), {
          cause: err,
        });
      }

      const responseHeaders = headersToRecord(response.headers);
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch (err) {
        throw new ApiError(
          'network_error',
          `non-JSON response from ${config.endpoint} (status ${String(response.status)})`,
          { cause: err, httpStatus: response.status },
        );
      }

      return {
        status: response.status,
        headers: responseHeaders,
        body: parsed,
      };
    },
  };
};

const isAbortError = (err: unknown): boolean => {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  return false;
};

const describeFetchError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  return 'fetch failed';
};

const headersToRecord = (
  headers: Headers,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/**
 * Mirrors `AbortSignal.any` in environments that don't have it yet.
 * Prefers the platform implementation when available so tests
 * exercise the real path.
 */
const combineSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal => {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  const [first, ...rest] = real;
  if (first === undefined) {
    return new AbortController().signal;
  }
  if (rest.length === 0) {
    return first;
  }
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(real);
  }
  const ctrl = new AbortController();
  for (const s of real) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener(
      'abort',
      () => {
        ctrl.abort(s.reason);
      },
      { once: true },
    );
  }
  return ctrl.signal;
};
