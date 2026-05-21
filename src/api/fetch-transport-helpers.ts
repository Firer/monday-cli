/**
 * Shared fetch-transport helpers (R-v0.8-NEW-11, v0.8). Both transport
 * seams — the JSON `client.request`-over-`fetch` seam in
 * `transport.ts` and the multipart `add_file_to_column`-over-`/v2/file`
 * seam in `multipart-transport.ts` — need the same four primitives:
 * a URL-/token-free fetch-error descriptor, an abort-vs-real-error
 * discriminator, a `Headers` → record flattener, and an N-way
 * `AbortSignal` combiner. Before this lift each module carried a
 * verbatim-or-near-verbatim private copy; the multipart docstrings
 * literally read "Mirrors `transport.ts:describeFetchError`" /
 * "Mirrors `transport.ts:combineSignals`".
 *
 * **Why consolidate — not just tidy-up dedupe:**
 *
 *   1. **One test set covers the shared defensive branches once.** The
 *      `describeFetchError` TLS `UNABLE_TO_*` arm + `combineSignals`'s
 *      empty-input guard were uncovered in BOTH copies — duplicated
 *      uncovered branches that dragged global branch coverage below the
 *      95.45% floor (R-v0.8-NEW-10, CI red). A single direct unit test
 *      on the shared module exercises every arm once instead of
 *      relying on two transports to drive each copy through `fetch`.
 *   2. **The two `combineSignals` had already DRIFTED.**
 *      `transport.ts` hedged behind `typeof AbortSignal.any ===
 *      'function'` + a legacy Node-<19 controller fallback;
 *      `multipart-transport.ts` assumed `AbortSignal.any` exists. The
 *      lift keeps `transport.ts`'s fallback — the safer SUPERSET — so a
 *      downstream embedder on an older Node still gets correct signal
 *      combination (R-v0.8-NEW-11 over-fit watch: the divergence is
 *      real, not cosmetic; do NOT collapse to multipart's narrower
 *      form).
 *   3. **The fetch-error vocabulary is a contract surface.** Agents
 *      reading either transport's `error.message` see the SAME
 *      `connection refused` / `dns lookup failed` / `tls error`
 *      strings regardless of which seam issued the call — convergence
 *      was already an explicit goal in the old multipart docstring
 *      ("keep messaging stable across the JSON + multipart paths").
 *
 * This is helper-sharing, NOT a merge of the two transport seams —
 * they keep separate modules + separate `Transport` /
 * `MultipartTransport` interfaces per their different bodies (JSON
 * `body: JSON.stringify(...)` vs `FormData` multipart). See
 * `docs/architecture.md` "Wire-vs-CLI semantics documentation
 * conventions" (R-NEW-41) for why the seams stay split.
 */

import { errorCode } from '../utils/errors.js';

/**
 * True for `fetch` rejections that mean "the request was aborted"
 * (caller cancellation OR `AbortSignal.timeout`) rather than a real
 * network failure. Callers use it to discriminate timeout from
 * network_error: the timeout signal won iff the caller's own signal
 * didn't fire first.
 */
export const isAbortError = (err: unknown): boolean => {
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
 * api.example/v2?token=...`, `getaddrinfo ENOTFOUND api.example`, etc.
 * If `MONDAY_API_URL` is misconfigured to carry the token (or any
 * other secret), the literal token lands in `ApiError.message`. The
 * runner's redactor would catch it on emit, but `security.md` forbids
 * the token entering `Error.message` in the first place — the rule is
 * defence-in-depth, not "we'll fix it downstream". The original error
 * is still attached via `cause`, which a future debug log surfaces
 * through `redact()` (key + value scan) rather than verbatim.
 *
 * Maps the common shapes to short, stable codes:
 *  - DNS / hostname unresolvable  → `dns lookup failed`
 *  - ECONNREFUSED / ECONNRESET    → `connection refused`
 *  - SSL/TLS issue                → `tls error`
 *  - generic Error                → `fetch failed`
 *  - non-Error throw              → `fetch failed`
 */
export const describeFetchError = (err: unknown): string => {
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

/**
 * Flattens a `fetch` `Headers` instance into a plain record so the
 * transport's `TransportResponse` / `MultipartTransportResponse` carry
 * an inert snapshot (not a live `Headers` object) past the transport
 * boundary.
 */
export const headersToRecord = (
  headers: Headers,
): Readonly<Record<string, string>> => {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
};

/**
 * Combines N optional `AbortSignal`s into one. The repo's Node 22+ pin
 * always provides the platform `AbortSignal.any`, so that is the live,
 * tested path; a legacy controller fallback ({@link combineSignalsLegacy})
 * is kept for hypothetical downstream embedders on Node < 19.
 *
 * The fallback is `transport.ts`'s original — the safer SUPERSET kept
 * deliberately over `multipart-transport.ts`'s narrower "assume
 * `AbortSignal.any` exists" form (R-v0.8-NEW-11 over-fit watch). Only
 * the feature-detect guard + the unreachable fallback are c8-ignored;
 * the reachable `AbortSignal.any(real)` path stays counted so a
 * regression in the multi-signal combination surfaces in coverage
 * (Codex R1 P2-1).
 */
export const combineSignals = (
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
  // Node 22+ always has `AbortSignal.any`; the feature-detect guard +
  // its legacy branch are unreachable on the pin, so the guard line is
  // c8-ignored — but `AbortSignal.any(real)` below is NOT, so the
  // multi-signal path is still coverage-counted.
  /* c8 ignore next 3 */
  if (typeof AbortSignal.any !== 'function') {
    return combineSignalsLegacy(real);
  }
  return AbortSignal.any(real);
};

/**
 * Pre-`AbortSignal.any` controller fallback (Node < 19). Unreachable on
 * the repo's Node 22+ pin — kept as the safer superset for downstream
 * embedders and c8-ignored as a block (testing.md block-wrap rule).
 */
/* c8 ignore start */
const combineSignalsLegacy = (
  real: readonly AbortSignal[],
): AbortSignal => {
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
/* c8 ignore stop */
