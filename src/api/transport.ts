import { ApiError } from '../utils/errors.js';
import {
  combineSignals,
  describeFetchError,
  headersToRecord,
  isAbortError,
} from './fetch-transport-helpers.js';

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
      // Header lockdown: caller-supplied headers spread first so the
      // transport-owned set (`Authorization`, `API-Version`,
      // `Content-Type`) always wins. The previous order let any
      // caller — including a buggy command or an injected
      // `FixtureTransport` request — override auth or the API
      // version pin silently. We also strip any case-variant of
      // those names from the caller bag so a lowercase
      // `authorization` can't sneak past the literal-key spread.
      const reservedHeaderLowerNames = new Set([
        'authorization',
        'api-version',
        'content-type',
      ]);
      const callerHeaders = headers ?? {};
      const safeCallerHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(callerHeaders)) {
        if (!reservedHeaderLowerNames.has(key.toLowerCase())) {
          safeCallerHeaders[key] = value;
        }
      }
      const requestHeaders: Record<string, string> = {
        ...safeCallerHeaders,
        Authorization: config.apiToken,
        'API-Version': config.apiVersion,
        'Content-Type': 'application/json',
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
        // Don't interpolate `config.endpoint` into the message —
        // a misconfigured URL containing the token (e.g. someone
        // setting MONDAY_API_URL=...?token=...) would land here.
        // The redactor would catch it on emit, but security.md
        // explicitly forbids putting the token into Error.message
        // in the first place. (Codex M2 review §4.)
        throw new ApiError(
          'network_error',
          `non-JSON response (status ${String(response.status)})`,
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
