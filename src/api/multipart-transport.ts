/**
 * Multipart transport seam for the v0.4-M31 asset-upload verbs
 * (`monday item upload` / `monday update upload`) — first v0.4
 * transport extension touching `multipart/form-data` instead of
 * the existing JSON-only `client.request` seam in `transport.ts`.
 *
 * **Why a sibling module, not an extension of `transport.ts`.** The
 * existing `Transport` interface owns three load-bearing invariants
 * (Codex M2 review §1):
 *
 *   1. Header lockdown — caller-supplied headers can NEVER override
 *      `Authorization` / `API-Version` / `Content-Type`.
 *   2. `Content-Type: application/json` is hard-coded into the
 *      transport-owned set.
 *   3. The body is always `JSON.stringify({ query, variables,
 *      operationName })`.
 *
 * Asset upload violates invariants (2) and (3): Monday's
 * `add_file_to_column` + `add_file_to_update` mutations follow the
 * standard GraphQL multipart-request specification (jaydenseric, used
 * widely across the GraphQL ecosystem). The wire envelope is
 * `multipart/form-data` with three named parts:
 *
 *   - `operations` (JSON) — `{query, variables, operationName}` where
 *     the file-typed variable's value is `null` (placeholder).
 *   - `map` (JSON) — `{"<file-index>": ["variables.<file-var-name>"]}`
 *     pointing the multipart file part at the operations variable
 *     slot the file should fill.
 *   - `<file-index>` (binary) — the file's bytes, with `filename` +
 *     `Content-Type` parameters surfacing the upload's metadata
 *     (Monday reads `name` from this `filename` parameter).
 *
 * The multipart envelope is incompatible with the JSON transport's
 * `body: JSON.stringify(...)` path; building it inside `transport.ts`
 * would have leaked multipart awareness into the JSON-only seam's
 * type signature OR introduced a discriminator on every JSON request.
 * Keeping the two transports in sibling modules:
 *
 *   - Preserves `transport.ts`'s invariants verbatim — its header
 *     lockdown + JSON body shape don't grow a multipart branch.
 *   - Makes the multipart-only invariants explicit in this module's
 *     type signature (`MultipartTransportRequest` carries a stream
 *     or buffer, not a query string).
 *   - Mirrors `docs/architecture.md` "Wire-vs-CLI semantics
 *     documentation conventions" (R-NEW-41 lift, 3rd-consumer
 *     trigger at v0.4-M31 pre-flight) — different wire shapes
 *     live in different modules, with a per-shape interface;
 *     the architecture section is the canonical cross-link
 *     target for the asymmetry enumeration.
 *
 * **What this module owns.** A `MultipartTransport` interface
 * mirroring `Transport` (request → response, with `signal` /
 * `timeout` / per-call options) + a `createMultipartFetchTransport`
 * factory that builds an instance over Node's `fetch` (the same
 * platform `fetch` `transport.ts` uses) but assembles the multipart
 * body via the `FormData` Web API instead of `JSON.stringify`.
 *
 * **Header lockdown carries over.** `Authorization` + `API-Version`
 * are transport-owned exactly the same way; `Content-Type` is set
 * automatically by `fetch` when given a `FormData` body (the
 * multipart boundary parameter requires the body builder to set
 * `Content-Type` so we don't preempt it here). Caller-supplied
 * headers with case-insensitive matches against the reserved set
 * are stripped before the spread.
 *
 * **Retry + signal contract.** The transport itself does NOT own
 * retry — callers (the asset-upload fetchers in
 * `src/api/assets.ts`) wrap the dispatch in `withRetry(...)` from
 * `src/api/retry.ts` to honor `--retry <n>` per cli-design §2.5.
 * The transport DOES own signal threading: callers pass `signal`
 * on every `request()` (required slot on
 * {@link MultipartTransportRequest}); abort propagation follows
 * the standard `AbortSignal.any(timeout, caller)` chain mirroring
 * `transport.ts`'s `combineSignals` (lands at IMPL).
 *
 * **Status: runtime body shipped at v0.4-M31 IMPL.** Wire-body
 * builder + fetch dispatch + header lockdown + signal combination +
 * fetch-error mapping all land below. Header lockdown mirrors
 * `transport.ts:createFetchTransport` (caller-supplied headers can
 * never override `Authorization` / `API-Version`); `Content-Type`
 * is intentionally NOT in the transport-owned override set —
 * `fetch` sets it from the `FormData` body's boundary parameter.
 *
 * Per empirical probe `scripts/probe/m31-asset-upload.ts`
 * (2026-05-13, API `2026-01`):
 *
 *   - `add_file_to_column(column_id: String!, file: File!,
 *     item_id: ID!) → Asset` — note `column_id: String!` (NOT
 *     `ID!`).
 *   - `add_file_to_update(file: File!, update_id: ID!) → Asset`.
 *   - `File` scalar (NOT the spec-standard `Upload!` — Monday's
 *     schema names it `File`; the multipart wire shape is otherwise
 *     compliant with the jaydenseric spec).
 *   - `Asset` returns 10 fields (`id` / `name` / `url` /
 *     `public_url` / `file_extension` / `file_size` /
 *     `created_at` / `uploaded_by` / `original_geometry` /
 *     `url_thumbnail`).
 */

import { ApiError, errorCode } from '../utils/errors.js';

/**
 * One multipart request: the GraphQL operations payload (query +
 * variables + operationName) plus the binary file content and the
 * upload metadata (filename + content-type). The caller (the fetcher
 * in `src/api/assets.ts`) constructs both the GraphQL document AND
 * the file bytes; this transport only owns the wire-shape assembly
 * (FormData parts + header lockdown + fetch dispatch).
 *
 * `fileVariableName` is the GraphQL variable name in `operations.
 * variables` that the file fills — the multipart `map` JSON pins
 * the binary part at `variables.<fileVariableName>`. Currently
 * always `'file'` (both Monday upload mutations use `$file: File!`)
 * but exposed as a parameter so the spec-compliant `map` JSON
 * generation stays local to this module.
 */
export interface MultipartTransportRequest {
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly operationName: string;
  /**
   * GraphQL variable name in `variables` to populate with the
   * file's binary content. The `variables.<fileVariableName>` slot
   * in the operations payload MUST be `null` (placeholder); the
   * multipart `map` JSON points the binary part at this path.
   *
   * Monday's two upload mutations both use `$file: File!` at the
   * pinned API `2026-01`, so callers pass `'file'`; future Monday
   * surfaces (if any) with a different variable name override
   * this slot.
   */
  readonly fileVariableName: string;
  /**
   * Stream-friendly binary content. At v0.4-M31 IMPL the fetcher
   * passes a `Blob` (Node 22+ supports the Web API `Blob`); the
   * `FormData` `append(name, blob, filename)` form sets the multi-
   * part part's `filename` + inherits `Content-Type` from the blob.
   * Future stdin/streaming support would widen this to a
   * `Blob | ReadableStream` union with a separate `filename` slot.
   */
  readonly file: Blob;
  /**
   * The basename used in the multipart part's `filename` parameter.
   * Monday surfaces `Asset.name` from this field; downstream agents
   * see this string as `data.asset.name` in the success envelope.
   * Required — empty filenames are rejected by Monday's server-side
   * validation (`USER_UNAUTHORIZED` / generic validation errors).
   */
  readonly filename: string;
  /**
   * Caller-supplied signal threaded into the underlying `fetch`'s
   * `signal` option (combined with `AbortSignal.timeout(timeoutMs)`
   * at IMPL via `AbortSignal.any` mirroring `transport.ts`'s
   * `combineSignals`). Required — callers MUST pass `ctx.signal`
   * explicitly so SIGINT + `--timeout` propagate to the in-flight
   * multipart upload.
   */
  readonly signal: AbortSignal;
}

export interface MultipartTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Parsed JSON body — Monday's GraphQL multipart endpoint returns
   * the same `{data?, errors?}` JSON shape as the JSON-body endpoint
   * (the response is JSON regardless of the request being multi-
   * part). Non-JSON responses (HTML error pages, etc.) surface as
   * `ApiError('network_error')` rather than partially-decoded
   * payloads, mirroring `transport.ts:createFetchTransport`.
   */
  readonly body: unknown;
}

export interface MultipartTransport {
  readonly request: (
    req: MultipartTransportRequest,
  ) => Promise<MultipartTransportResponse>;
}

export interface MultipartFetchTransportConfig {
  readonly endpoint: string;
  readonly apiToken: string;
  readonly apiVersion: string;
  readonly timeoutMs: number;
  /** Override for tests; defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Builds a `MultipartTransport` over Node's `fetch` using the Web
 * `FormData` API to assemble the multipart body (operations + map
 * + file parts per the standard GraphQL multipart-request
 * specification). Header lockdown mirrors `createFetchTransport`'s
 * discipline: caller-supplied headers never override `Authorization`
 * / `API-Version`; `Content-Type` is set by `fetch` from the
 * `FormData` body's boundary parameter, so it is NOT in the
 * transport-owned override set (different from the JSON transport's
 * hard-coded `application/json`).
 *
 * Pipeline per request:
 *
 *   1. Strip caller-supplied headers whose lowercase names match the
 *      reserved set (`authorization`, `api-version`); spread the safe
 *      remainder into the request bag, then append the transport-
 *      owned `Authorization` + `API-Version` so they always win.
 *   2. Build the `FormData` body — `operations` JSON part with the
 *      query + variables + operationName (the file variable's value
 *      is `null` at the caller's request, per spec) + `map` JSON
 *      part pointing the file part at
 *      `variables.<fileVariableName>` + the file `Blob` keyed by
 *      index `'0'` with the caller-supplied `filename`.
 *   3. Combine the caller's `signal` with `AbortSignal.timeout
 *      (timeoutMs)` so SIGINT + per-request timeout both propagate
 *      to the in-flight upload.
 *   4. Dispatch via `fetch` with `method: 'POST'` + the assembled
 *      body + the merged signal. Don't set `Content-Type` — fetch
 *      derives it from the FormData boundary.
 *   5. Parse the JSON response body. Non-JSON (HTML error page,
 *      etc.) surfaces as `ApiError('network_error')` mirroring
 *      `transport.ts`'s discipline; abort vs timeout discrimination
 *      follows the same rule (the timeout signal wins iff the
 *      caller's signal didn't fire first).
 *
 * The transport does NOT own retry — the asset-upload fetchers in
 * `src/api/assets.ts` wrap the `request(...)` call in `withRetry
 * (...)` per cli-design §2.5; Web `Blob.stream()` returns a fresh
 * `ReadableStream` per call so the FormData body re-assembles
 * cleanly on each retry attempt without buffering.
 */
export const createMultipartFetchTransport = (
  config: MultipartFetchTransportConfig,
): MultipartTransport => {
  const fetchImpl = config.fetchImpl ?? fetch;

  return {
    request: async ({
      query,
      variables,
      operationName,
      fileVariableName,
      file,
      filename,
      signal,
    }) => {
      // Header lockdown — same intent as `transport.ts`'s reserved-
      // header set, but `MultipartTransportRequest` carries NO
      // `headers` slot, so the lockdown is closed-by-construction:
      // there's no way for a caller to inject headers that could
      // override the transport-owned `Authorization` / `API-Version`.
      // `Content-Type` is intentionally absent from this bag — fetch
      // sets it from the FormData body's boundary parameter, and
      // preempting it would corrupt the multipart envelope (the
      // boundary delimiter encoded in the header MUST match the one
      // FormData chose internally).
      const requestHeaders: Record<string, string> = {
        Authorization: config.apiToken,
        'API-Version': config.apiVersion,
      };

      // Build the multipart body per the spec. The operations JSON
      // carries `null` in the file variable's slot (the caller
      // already populated `variables[fileVariableName] = null`
      // before reaching the transport). The `map` JSON pins the
      // binary part at `variables.<fileVariableName>` so Monday's
      // multipart parser can route the bytes to the right slot.
      const operations: Record<string, unknown> = { query, variables };
      operations.operationName = operationName;
      const formData = new FormData();
      formData.append('operations', JSON.stringify(operations));
      formData.append(
        'map',
        JSON.stringify({ '0': [`variables.${fileVariableName}`] }),
      );
      formData.append('0', file, filename);

      const combinedSignal = combineSignals(
        signal,
        AbortSignal.timeout(config.timeoutMs),
      );

      let response: Response;
      try {
        response = await fetchImpl(config.endpoint, {
          method: 'POST',
          headers: requestHeaders,
          body: formData,
          signal: combinedSignal,
        });
      } catch (err) {
        if (isAbortError(err) && combinedSignal.reason !== signal.reason) {
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
 * Mirrors `transport.ts:describeFetchError`. Extracted to keep
 * messaging stable across the JSON + multipart paths — agents
 * reading either envelope's `error.message` see the same vocabulary
 * for connection / DNS / TLS failures regardless of which transport
 * issued the call.
 */
const describeFetchError = (err: unknown): string => {
  if (err instanceof Error) {
    const code = errorCode(err);
    if (code !== undefined) {
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
 * Mirrors `transport.ts:combineSignals` — prefer the platform
 * `AbortSignal.any` when available (Node 22+ pin always satisfies
 * this) and synthesise a controller for the legacy fallback path.
 */
const combineSignals = (
  ...signals: readonly (AbortSignal | undefined)[]
): AbortSignal => {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  const [first, ...rest] = real;
  /* c8 ignore next 3 — defensive guard; production callers always
     pass at least one signal (the caller's `ctx.signal` is REQUIRED
     on `MultipartTransportRequest`). */
  if (first === undefined) {
    return new AbortController().signal;
  }
  /* c8 ignore next 3 — production callers always combine the
     caller's signal with `AbortSignal.timeout(...)`, so this branch
     is unreachable from the request() pipeline. */
  if (rest.length === 0) {
    return first;
  }
  return AbortSignal.any(real);
};
