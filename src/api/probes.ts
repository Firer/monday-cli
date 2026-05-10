/**
 * Per-probe primitives for the v0.3-M22 `monday status` verb
 * (cli-design §11.5 — Decision 7 closure: probe by default,
 * `--no-probe` opts out).
 *
 * **What `monday status` answers:** "is everything I need to talk to
 * Monday working, without touching account state?" The verb runs
 * a short, deterministic probe matrix:
 *
 *   1. **DNS** — resolve the configured Monday hostname.
 *   2. **TCP** — open a TCP connection to port 443.
 *   3. **TLS** — complete a TLS handshake (cert validity, SNI).
 *   4. **Auth** — issue the cheapest possible GraphQL read
 *      (`query { me { id } }`) against the resolved transport.
 *   5. **Cache writability** — verify the local cache directory
 *      (`~/.monday-cli/`) exists with mode `0700` and is writable.
 *   6. **Redaction self-test** — pass a known-fixture token through
 *      `redact()` and assert the bytes don't appear in the output.
 *   7. **Env-var pickup summary** — local-only; reports which
 *      MONDAY_* env vars influenced the run (set/unset, never
 *      values). Helps an agent diagnose "why is the wrong profile
 *      being selected?" without spelunking dotfiles.
 *
 * **`--no-probe` semantics.** Skips probes 1–4 (the network-touching
 * ones); probes 5–7 still run because they're local-only and don't
 * touch account state. Use case: offline sanity check after rotating
 * credentials, where the agent wants to confirm the cache + redaction
 * + env-var resolution without firing a real Monday API call.
 *
 * **Empirical probe findings (2026-05-10, against `api.monday.com`,
 * API version `2026-01`) — `scripts/probe/m22-status.ts`:**
 *
 *   - **401 envelope shape (auth probe).** Status `401`, content-type
 *     `application/json; charset=utf-8`, body
 *     `{"errors":[{"message":"Not authenticated","extensions":
 *     {"code":"NOT_AUTHENTICATED"}}]}`. Identical envelope for
 *     missing-`Authorization` and bad-`Authorization`. The auth-probe
 *     step maps this verbatim to `unauthorized` (existing error code;
 *     NO new code needed for M22).
 *   - **`Bearer <token>` prefix DOES work** on `api.monday.com`
 *     alongside bare `<token>`. The CLI's `.claude/rules/security.md`
 *     rule against the prefix remains precautionary (proxies / logs
 *     sometimes split on `Bearer ` differently), not API-enforced.
 *
 * **Why no new ERROR_CODE for probes.** Each probe maps cleanly to
 * an existing code: DNS / TCP / TLS / network failures →
 * `network_error`; 401 → `unauthorized`; cache-writability failure
 * → `config_error`; redaction self-test failure → `internal_error`
 * (a serious bug, not a user-facing condition). Adding a
 * `probe_failed` umbrella would widen the 29-code registry for
 * marginal benefit; each probe's failure mode is best described by
 * the existing semantic-domain code per cli-design §6.5.
 *
 * **What's stub vs runtime at the pre-flight.** Every probe runner
 * ships as a `Promise.reject(internal_error)` stub under `c8 ignore`
 * — M22 implementation lands the runtime DNS / TCP / TLS / fetch /
 * fs / redaction bodies. The type signatures, the `ProbeName` union,
 * the `ProbeResult` discriminated union, and the per-probe inputs /
 * defaults pin now so M22 implementation drops in without contract
 * drift. The mockable-seam shape mirrors the M21
 * `__test_oauth_helper` env-seam pattern: each probe accepts an
 * injectable `helper` (e.g., a fixture-resolver / fixture-transport)
 * so tests don't bind real sockets / open real fetch handles.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { Transport } from './transport.js';

/** Enum of the probe steps `monday status` runs. */
export type ProbeName =
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'auth'
  | 'cache_writability'
  | 'redaction_self_test'
  | 'env_var_pickup';

/** A probe step that completed successfully. */
export interface ProbeOk {
  readonly kind: 'ok';
  readonly probe: ProbeName;
  readonly elapsed_ms: number;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * A probe step that failed. `reason` is a stable snake_case
 * discriminant per cli-design §6.5 details-shape convention. Agents
 * key off `reason`, never the English `message`.
 */
export interface ProbeFail {
  readonly kind: 'fail';
  readonly probe: ProbeName;
  readonly elapsed_ms: number;
  readonly reason: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * A probe step that was skipped (e.g., network probes under
 * `--no-probe`). Surfaces so the envelope is complete-by-probe-name
 * regardless of `--no-probe`; agents don't need to know which
 * probes were skipped at the wire level.
 */
export interface ProbeSkipped {
  readonly kind: 'skipped';
  readonly probe: ProbeName;
  readonly reason: string;
}

export type ProbeResult = ProbeOk | ProbeFail | ProbeSkipped;

/**
 * The `monday status` envelope shape (`data` payload). Each probe
 * gets one slot keyed by its {@link ProbeName}; the order is the
 * declaration order in {@link STATUS_PROBE_ORDER} for stable
 * table-formatter output on TTY.
 *
 * Additive-only per cli-design §6.1: future probes (e.g., a
 * `cache_freshness` check) land as new keys in this record without
 * breaking v0.3 consumers.
 */
export interface StatusOutput {
  readonly probes: Readonly<Record<ProbeName, ProbeResult>>;
  /**
   * Overall verdict — `'ok'` when every non-skipped probe returned
   * `'ok'`; `'degraded'` when at least one probe failed but the auth
   * probe succeeded (the CLI can still talk to Monday); `'down'` when
   * the auth probe failed or every network probe was skipped via
   * `--no-probe` AND a local probe failed.
   */
  readonly overall: 'ok' | 'degraded' | 'down';
  /**
   * Pinned API version + the version the server reports back at the
   * auth-probe step. Diverging values surface as `meta.warnings`
   * rather than blocking the verb.
   */
  readonly api_version: string;
}

/**
 * Stable iteration order for the status envelope's `probes` record.
 * Matches the cli-design §11.5 probe-matrix narrative.
 */
export const STATUS_PROBE_ORDER: readonly ProbeName[] = [
  'dns',
  'tcp',
  'tls',
  'auth',
  'cache_writability',
  'redaction_self_test',
  'env_var_pickup',
] as const;

/**
 * The set of probes a `--no-probe` invocation skips (the network
 * touching ones). Local-only probes always run.
 */
export const NO_PROBE_SKIP_SET: ReadonlySet<ProbeName> = new Set([
  'dns',
  'tcp',
  'tls',
  'auth',
]);

/**
 * The fixture canary token the redaction self-test scrubs. **Never a
 * real token** — the byte sequence is deliberately distinctive so a
 * leak-test assertion can scan every emitted byte for it.
 */
export const REDACTION_SELF_TEST_FIXTURE_TOKEN =
  'tok-probe-redaction-self-test-DO-NOT-USE';

/** Default DNS / TCP / TLS host the probe matrix targets. */
export const DEFAULT_PROBE_HOSTNAME = 'api.monday.com';

/** Default port for TCP / TLS probes. */
export const DEFAULT_PROBE_PORT = 443;

/** Default per-probe timeout (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/**
 * The MONDAY_* env-var names the env-var-pickup probe summarises.
 * Each entry maps to `{set: boolean}` in the probe's `details` —
 * the **values are never echoed**, only the set/unset signal.
 */
export const ENV_VAR_PICKUP_KEYS: readonly string[] = [
  'MONDAY_API_TOKEN',
  'MONDAY_PROFILE',
  'MONDAY_API_VERSION',
  'MONDAY_API_URL',
  'MONDAY_OUTPUT',
  'MONDAY_REQUEST_TIMEOUT_MS',
] as const;

/**
 * Common options shared by every probe — the `signal` opt lets the
 * caller cancel mid-probe (e.g., on SIGINT); the `timeoutMs` opt
 * scopes the probe-specific deadline.
 */
export interface ProbeCommonOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface DnsProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
}

export interface TcpProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface TlsProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
  readonly port?: number;
}

export interface AuthProbeInputs extends ProbeCommonOptions {
  readonly transport: Transport;
}

export interface CacheWritabilityProbeInputs {
  readonly env: NodeJS.ProcessEnv;
  /** Optional HOME override; tests inject a tmp dir. */
  readonly home?: string;
}

export interface RedactionSelfTestInputs {
  /**
   * Process env passed through to
   * {@link import('../cli/envelope-out.js').collectSecrets}. The
   * probe exercises BOTH redaction-layer halves per cli-design
   * §7.4.3 (Codex M21 P1 finding): a canary is folded into
   * `runtimeSecrets` AND the env-token value-scan path
   * (`collectSecrets` reads `env.MONDAY_API_TOKEN` to extend the
   * scrub bag) is exercised inside the same probe step. Mirrors
   * `collectSecrets(env, runtimeSecrets)`'s real signature so the
   * probe can't drift away from the production redaction shape.
   */
  readonly env: NodeJS.ProcessEnv;
  /**
   * Mutable runtime-secrets bag (mirrors {@link import('../cli/run.js').RunContext.runtimeSecrets}).
   * The probe folds the canary into this bag, runs a sample emission
   * through `redact()`, asserts the canary bytes are scrubbed, then
   * removes the canary again before returning.
   */
  readonly runtimeSecrets: string[];
}

export interface EnvVarPickupProbeInputs {
  readonly env: NodeJS.ProcessEnv;
}

const STUB_HINT =
  'M22 implementation lands the runtime probe body alongside `monday status`. The pre-flight surface pins the contract so commit reviews land into a stable shape.';

const stubReject = (probe: ProbeName): Promise<ProbeResult> =>
  Promise.reject(
    new ApiError(
      'internal_error',
      `${probe} probe is a v0.3-M22 pre-flight stub — runtime body lands at M22 implementation.`,
      { details: { probe, hint: STUB_HINT } },
    ),
  );

/**
 * Resolves `inputs.hostname` (default {@link DEFAULT_PROBE_HOSTNAME}).
 * M22 implementation lands `node:dns/promises.lookup(hostname, {all:
 * false})` with a timeout race. Maps `EAI_NONAME` / `ENOTFOUND` /
 * `EAI_AGAIN` to per-reason failures.
 */
// Stub: M22 implementation lands node:dns/promises.lookup with a
// timeout race. Maps reason codes to ProbeFail.reason verbatim.
/* c8 ignore start */
export const runDnsProbe = (_inputs: DnsProbeInputs = {}): Promise<ProbeResult> =>
  stubReject('dns');
/* c8 ignore stop */

/**
 * Opens a TCP connection to `inputs.hostname:inputs.port` (defaults
 * {@link DEFAULT_PROBE_HOSTNAME} / {@link DEFAULT_PROBE_PORT}). M22
 * implementation lands `node:net.createConnection` with a timeout
 * race + clean teardown (`socket.destroy()` on success / failure /
 * timeout).
 */
// Stub: M22 implementation lands node:net.createConnection with a
// timeout race + clean teardown.
/* c8 ignore start */
export const runTcpProbe = (_inputs: TcpProbeInputs = {}): Promise<ProbeResult> =>
  stubReject('tcp');
/* c8 ignore stop */

/**
 * Completes a TLS handshake against `inputs.hostname:inputs.port`
 * with SNI set + cert validation on. M22 implementation lands
 * `node:tls.connect` with a timeout race; failures surface
 * `cert_invalid` / `tls_handshake_failed` / `timeout` reasons.
 */
// Stub: M22 implementation lands node:tls.connect with SNI + cert
// validation on. Surfaces cert_invalid / tls_handshake_failed.
/* c8 ignore start */
export const runTlsProbe = (_inputs: TlsProbeInputs = {}): Promise<ProbeResult> =>
  stubReject('tls');
/* c8 ignore stop */

/**
 * Issues `query { me { id } }` against the supplied transport. M22
 * implementation maps results per cli-design §11.5.1's per-probe
 * error-code table:
 *   - `401` (empirical-probe-confirmed envelope —
 *     `{"errors":[{"message":"Not authenticated","extensions":
 *     {"code":"NOT_AUTHENTICATED"}}]}`) → `unauthorized` reason.
 *   - `5xx` HTTP status / transport failures (DNS recovery, TCP
 *     reset, TLS handshake error mid-flight) → `network_error`.
 *
 * Other Monday error codes (`complexity_exceeded`, `rate_limited`,
 * etc.) intentionally NOT mapped from the auth-probe step — the
 * probe's contract is "can we authenticate?", not "can we
 * complete a request budget-wise?". A `complexity_exceeded` from
 * the cheapest possible read (`me { id }`) implies the budget is
 * pathological; M22 implementation surfaces it as the existing
 * code via the transport-layer mapping, but `monday status`'s
 * verb-level envelope only ever surfaces `unauthorized` or
 * `network_error` for the auth probe per §11.5.1.
 */
// Stub: M22 implementation issues `me { id }` via the transport and
// maps the 401 envelope (probe-confirmed at 2026-05-10) to
// reason: "unauthorized" verbatim.
/* c8 ignore start */
export const runAuthProbe = (_inputs: AuthProbeInputs): Promise<ProbeResult> =>
  stubReject('auth');
/* c8 ignore stop */

/**
 * Verifies the local cache directory (`<HOME>/.monday-cli/`) exists,
 * is mode `0700`, and is writable by the current process. M22
 * implementation lands `fs.stat` + `fs.access(W_OK)` + a probe-write
 * (`<dir>/.probe-<rand>`) → delete dance to confirm true writability
 * (`access(W_OK)` is advisory on some Unix filesystems).
 */
// Stub: M22 implementation lands the fs.stat + access(W_OK) +
// probe-write + cleanup dance.
/* c8 ignore start */
export const runCacheWritabilityProbe = (
  _inputs: CacheWritabilityProbeInputs,
): Promise<ProbeResult> => stubReject('cache_writability');
/* c8 ignore stop */

/**
 * Folds {@link REDACTION_SELF_TEST_FIXTURE_TOKEN} into
 * `inputs.runtimeSecrets`, runs a sample object (carrying the
 * canary in `error.message`, `error.stack`, a nested
 * `error.cause.message`, a URL, and a lowercase
 * `authorization` header value) through `redact()`, and asserts
 * the canary is absent from every byte of the redacted output.
 * Removes the canary from `runtimeSecrets` before returning so the
 * caller's state is unchanged.
 *
 * Failure here indicates a regression in the redaction layer
 * itself (a serious bug); the probe surfaces `internal_error`-class
 * fail rather than a user-facing reason.
 */
// Stub: M22 implementation lands the canary-leak self-test against
// redact(). Failure indicates a redaction-layer regression.
/* c8 ignore start */
export const runRedactionSelfTest = (
  _inputs: RedactionSelfTestInputs,
): Promise<ProbeResult> => stubReject('redaction_self_test');
/* c8 ignore stop */

/**
 * Summarises which of {@link ENV_VAR_PICKUP_KEYS} are set on
 * `inputs.env`. The probe is **synchronous + pure** in behaviour;
 * still wrapped in a Promise so callers can `Promise.allSettled`
 * the full matrix without special-casing this step. The
 * `details` payload reports `{set: boolean}` per key — **values are
 * NEVER included** (an env var's value is potentially a token).
 */
// Stub: M22 implementation reads inputs.env, builds the set-map,
// and returns ProbeOk. Pure + synchronous behaviour.
/* c8 ignore start */
export const summariseEnvVarPickup = (
  _inputs: EnvVarPickupProbeInputs,
): Promise<ProbeResult> => stubReject('env_var_pickup');
/* c8 ignore stop */

/**
 * Schema validating an individual probe result for the
 * `monday status` envelope. Mirrors the runtime
 * {@link ProbeResult} union so the envelope is parse-safe at every
 * emission path (in particular `monday schema` introspection).
 */
export const probeResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ok'),
    probe: z.string().min(1),
    elapsed_ms: z.number().nonnegative(),
    details: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('fail'),
    probe: z.string().min(1),
    elapsed_ms: z.number().nonnegative(),
    reason: z.string().min(1),
    message: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal('skipped'),
    probe: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

/**
 * Top-level `monday status` envelope-data schema. `probes` requires
 * every {@link STATUS_PROBE_ORDER} entry to be populated (default
 * run AND `--no-probe` run — `--no-probe` emits `ProbeSkipped` slots
 * for the four network probes; local probes still produce real
 * entries). Catchall allows additive future probes (per cli-design
 * §6.1) WITHOUT a schema-version bump; missing-slot drift gets
 * caught at parse time.
 */
export const statusOutputSchema = z
  .object({
    probes: z
      .object({
        dns: probeResultSchema,
        tcp: probeResultSchema,
        tls: probeResultSchema,
        auth: probeResultSchema,
        cache_writability: probeResultSchema,
        redaction_self_test: probeResultSchema,
        env_var_pickup: probeResultSchema,
      })
      .catchall(probeResultSchema),
    overall: z.enum(['ok', 'degraded', 'down']),
    api_version: z.string().min(1),
  })
  .strict();
