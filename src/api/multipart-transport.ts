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
 * **Status: PRE-FLIGHT STUB.** Wire-body builder + fetch dispatch
 * land at v0.4-M31 IMPL. The exported factory currently returns a
 * transport whose `request()` throws `internal_error` with
 * `details.deferred_to: "v0.4-M31 IMPL"`. The type signature +
 * named-operation contract are pinned at pre-flight so the
 * `src/api/assets.ts` fetcher module can land its argv-validation
 * + envelope-shape surface against a stable interface.
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

import { ApiError } from '../utils/errors.js';

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

/* c8 ignore start — stub body throws at pre-flight; IMPL replaces
   the body with the real `FormData` assembly + fetch dispatch +
   error-shape mapping (the same `wrapTransportError` /
   `describeFetchError` shapes `transport.ts` uses), and the c8
   ignore drops with the IMPL feat. */
/**
 * **PRE-FLIGHT STUB.** Builds a `MultipartTransport` over Node's
 * `fetch` using the Web `FormData` API to assemble the multipart
 * body (operations + map + file parts). Header lockdown mirrors
 * `createFetchTransport`'s discipline: caller-supplied headers
 * never override `Authorization` / `API-Version`; `Content-Type`
 * is set by `fetch` from the `FormData` body's boundary, so it
 * is NOT in the transport-owned override set (different from the
 * JSON transport).
 *
 * IMPL replaces this body with:
 *   - construct `FormData` with `operations` + `map` + the file
 *     part (`name='0'`, `Blob` with `filename` + content-type);
 *   - merge the timeout signal with the caller-supplied signal
 *     (mirrors `combineSignals`);
 *   - dispatch via `fetch` with method=POST + headers (no
 *     Content-Type — fetch sets it from FormData);
 *   - parse the response JSON + map errors per `ApiError` codes.
 */
export const createMultipartFetchTransport = (
  config: MultipartFetchTransportConfig,
): MultipartTransport => {
  // PRE-FLIGHT STUB — return a transport whose request() throws
  // `internal_error` so callers can wire the seam at pre-flight
  // without the runtime body. Reference `config` so the lint rule
  // doesn't flag the parameter as unused.
  void config;
  return {
    request: () => {
      return Promise.reject(
        new ApiError(
          'internal_error',
          'multipart transport stub — runtime body lands at v0.4-M31 IMPL',
          {
            details: {
              deferred_to: 'v0.4-M31 IMPL',
              hint: 'this code path is unreachable in v0.4-M30 release surface; pre-flight stub lands the type signature before the runtime body.',
            },
          },
        ),
      );
    },
  };
};
/* c8 ignore stop */
