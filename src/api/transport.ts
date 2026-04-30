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

const isAbortError = (err: unknown): boolean => {
  if (err instanceof Error) {
    return err.name === 'AbortError' || err.name === 'TimeoutError';
  }
  return false;
};

/**
 * Builds a generic, URL-free message for a thrown `fetch` exception.
 *
 * Why not `err.message`. Node's undici embeds the request URL into
 * the messages of common transport errors — `ECONNREFUSED https://
 * api.example/v2?token=...`, `getaddrinfo ENOTFOUND
 * api.example`, etc. If `MONDAY_API_URL` is misconfigured to carry
 * the token (or any other secret), the literal token lands in
 * `ApiError.message`. The runner's redactor would catch it on emit,
 * but `security.md` forbids the token entering `Error.message` in
 * the first place — the rule is defence-in-depth, not "we'll fix it
 * downstream". The original error is still attached via `cause`,
 * which a future debug log surfaces through `redact()` (key + value
 * scan) rather than verbatim.
 *
 * Maps the common shapes to short, stable codes:
 *  - DNS / hostname unresolvable  → `dns lookup failed`
 *  - ECONNREFUSED / ECONNRESET    → `connection refused`
 *  - SSL/TLS issue                → `tls error`
 *  - generic Error                → `fetch failed`
 *  - non-Error throw              → `fetch failed`
 */
const describeFetchError = (err: unknown): string => {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') {
      if (code.startsWith('ENOTFOUND') || code.startsWith('EAI_')) {
        return 'fetch failed: dns lookup failed';
      }
      if (code === 'ECONNREFUSED' || code === 'ECONNRESET') {
        return 'fetch failed: connection refused';
      }
      if (code === 'CERT_HAS_EXPIRED' || code.startsWith('UNABLE_TO_')) {
        return 'fetch failed: tls error';
      }
    }
    // Sniff the message for the same common shapes when err.code
    // isn't surfaced (older fetch impls, wrapped TypeErrors).
    const lower = err.message.toLowerCase();
    if (lower.includes('econnrefused') || lower.includes('connection refused')) {
      return 'fetch failed: connection refused';
    }
    if (
      lower.includes('enotfound') ||
      lower.includes('eai_again') ||
      lower.includes('getaddrinfo')
    ) {
      return 'fetch failed: dns lookup failed';
    }
    return 'fetch failed';
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
