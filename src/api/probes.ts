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
 * **Mockable-seam pattern.** Each probe accepts a per-probe seam
 * (`lookupImpl` / `tcpConnectImpl` / `tlsConnectImpl` / `redactImpl`
 * etc.) so tests don't bind real sockets / open real fetch handles /
 * touch real DNS. Mirrors `src/api/transport.ts`'s `fetchImpl?` slot
 * and the M21 `__test_oauth_helper` env seam: production callers
 * leave the slot unset and the runner uses the real stdlib primitive.
 */

import { randomUUID } from 'node:crypto';
import { promises as dnsPromises } from 'node:dns';
import { createConnection } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  access,
  constants as fsConstants,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { isENOENT } from '../utils/fs.js';
import { redact as defaultRedactImpl } from '../utils/redact.js';
import { collectSecrets } from '../cli/envelope-out.js';
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
 * Cache directory name under HOME. Mirrors {@link
 * import('../config/credentials.js').CREDENTIALS_DIR_NAME} verbatim —
 * the cache + credentials share the same `~/.monday-cli/` parent.
 */
const CACHE_DIR_NAME = '.monday-cli';

/**
 * Required directory mode for the cache parent. Anything more
 * permissive than `0700` is flagged `mode_insecure`.
 */
const CACHE_DIR_REQUIRED_MODE_BITS = 0o077;

/**
 * The 6 redaction-leak contexts cli-design §7.4.3 pins for the
 * canary self-test (Codex M21 P1 ratification). Each entry's path is
 * a stable diagnostic key the probe surfaces under
 * `details.contexts_present`; the canary lives at each one.
 */
const REDACTION_LEAK_CONTEXT_KEYS = [
  'error.message',
  'error.stack',
  'error.cause.message',
  'headers.authorization',
  'url',
  'debug',
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

/** DNS lookup return shape — narrowed view of `node:dns` `LookupAddress`. */
export interface DnsLookupResult {
  readonly address: string;
  readonly family: number;
}

export interface DnsProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
  /**
   * Test seam — replaces `node:dns/promises.lookup`. Production
   * callers leave it unset and the probe binds to the OS resolver.
   */
  readonly lookupImpl?: (hostname: string) => Promise<DnsLookupResult>;
}

export interface TcpConnectArgs {
  readonly host: string;
  readonly port: number;
  readonly signal: AbortSignal;
}

export interface TcpProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
  readonly port?: number;
  /**
   * Test seam — replaces `node:net.createConnection`. Resolves on
   * successful connect, rejects with a code-bearing `Error` on
   * failure. The probe closes the underlying socket via the
   * supplied `signal` (firing when the per-probe deadline or the
   * outer signal aborts).
   */
  readonly tcpConnectImpl?: (args: TcpConnectArgs) => Promise<void>;
}

export interface TlsCertDetails {
  readonly subject: string;
  readonly issuer: string;
  readonly valid_to: string;
}

export interface TlsProbeInputs extends ProbeCommonOptions {
  readonly hostname?: string;
  readonly port?: number;
  /**
   * Test seam — replaces `node:tls.connect`. Resolves with the peer
   * cert summary on successful handshake; rejects with a code-bearing
   * `Error` on failure.
   */
  readonly tlsConnectImpl?: (args: TcpConnectArgs) => Promise<TlsCertDetails>;
}

export interface AuthProbeInputs extends ProbeCommonOptions {
  readonly transport: Transport;
  /**
   * Optional server-reported API version the probe captured from
   * the response (or its meta). When absent, the auth probe falls
   * back to the resolved pin in the command action.
   */
  readonly apiVersionHint?: string;
}

export interface CacheWritabilityProbeInputs {
  readonly env: NodeJS.ProcessEnv;
  /** Optional HOME override; tests inject a tmp dir. */
  readonly home?: string;
}

export interface RedactionSelfTestInputs {
  /**
   * Process env passed through to {@link collectSecrets}. The probe
   * exercises BOTH redaction-layer halves per cli-design §7.4.3
   * (Codex M21 P1 finding): a canary is folded into `runtimeSecrets`
   * AND the env-token value-scan path (`collectSecrets` reads
   * `env.MONDAY_API_TOKEN` to extend the scrub bag) is exercised
   * inside the same probe step. Mirrors
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
  /**
   * Test seam — replaces `src/utils/redact.ts redact`. Lets the
   * leak-path test inject a tampered redactor (one that misses the
   * canary) so the canary_leaked branch surfaces without rewriting
   * production redaction.
   */
  readonly redactImpl?: (
    value: unknown,
    options: { secrets: readonly string[] },
  ) => unknown;
}

export interface EnvVarPickupProbeInputs {
  readonly env: NodeJS.ProcessEnv;
}

const errorCode = (err: unknown): string | undefined => {
  /* c8 ignore next 3 — non-object errors don't reach this guard via
     fs/promises/dns rejections (every rejection wraps a real Error). */
  if (typeof err !== 'object' || err === null) {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
};

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  /* c8 ignore next — non-Error throws don't reach probe error paths in
     practice; defensive fallback for the unknown-thrown case. */
  return String(err);
};

/**
 * Coerces `AbortSignal.reason` (typed `any`) into an `Error` for the
 * Promise-reject path. Standardises the abort-bubbling shape so
 * every probe seam rejects with an `Error` per the lint rule
 * `@typescript-eslint/prefer-promise-reject-errors`.
 */
const asError = (reason: unknown, fallback: string): Error => {
  if (reason instanceof Error) {
    return reason;
  }
  /* c8 ignore next — `AbortSignal.reason` is an Error in every code
     path the probes reach (timeout uses `ProbeTimeoutError`; outer
     aborts are wrapped errors). Fallback exists for the unspecified
     `ctrl.abort()` (no-arg) case. */
  return new Error(fallback);
};

const formatMode = (mode: number): string =>
  `0${(mode & 0o777).toString(8).padStart(3, '0')}`;

class ProbeTimeoutError extends Error {
  constructor(probe: ProbeName, timeoutMs: number) {
    super(`${probe} probe timed out after ${String(timeoutMs)}ms`);
    this.name = 'ProbeTimeoutError';
  }
}

interface ProbeAbortContext {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
  readonly didTimeout: () => boolean;
}

/**
 * Builds a single-fire abort controller that fires when EITHER the
 * per-probe deadline elapses OR the outer signal aborts. Each probe
 * threads `abortCtx.signal` into its seam so a timeout cleanly
 * tears down the in-flight socket / fetch handle.
 */
const createProbeAbortContext = (
  probe: ProbeName,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): ProbeAbortContext => {
  const ctrl = new AbortController();
  let timedOut = false;
  const onOuterAbort = (): void => {
    ctrl.abort(outerSignal?.reason);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort(new ProbeTimeoutError(probe, timeoutMs));
  }, timeoutMs);
  if (outerSignal !== undefined) {
    if (outerSignal.aborted) {
      ctrl.abort(outerSignal.reason);
    } else {
      outerSignal.addEventListener('abort', onOuterAbort, { once: true });
    }
  }
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    },
    didTimeout: () => timedOut,
  };
};

const ok = (
  probe: ProbeName,
  startMs: number,
  details: Readonly<Record<string, unknown>>,
): ProbeOk => ({
  kind: 'ok',
  probe,
  elapsed_ms: Date.now() - startMs,
  details,
});

const fail = (
  probe: ProbeName,
  startMs: number,
  reason: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): ProbeFail => ({
  kind: 'fail',
  probe,
  elapsed_ms: Date.now() - startMs,
  reason,
  message,
  details,
});

// Production-only path: binds to the OS resolver. Unit tests inject
// a `lookupImpl` seam; integration tests under `--no-probe` skip this
// path entirely. Real DNS-against-api.monday.com tests would be
// flaky in CI without a fixture resolver.
/* c8 ignore start */
const defaultDnsLookup = async (hostname: string): Promise<DnsLookupResult> => {
  const result = await dnsPromises.lookup(hostname, { all: false });
  return { address: result.address, family: result.family };
};
/* c8 ignore stop */

/**
 * Resolves `inputs.hostname` (default {@link DEFAULT_PROBE_HOSTNAME})
 * via `node:dns/promises.lookup` (or the injected `lookupImpl` test
 * seam). Maps `EAI_NONAME` / `ENOTFOUND` → `not_found`; `EAI_AGAIN`
 * → `temporary_failure`; timeout → `timeout`; anything else →
 * `lookup_failed`.
 */
export const runDnsProbe = async (
  inputs: DnsProbeInputs = {},
): Promise<ProbeResult> => {
  const hostname = inputs.hostname ?? DEFAULT_PROBE_HOSTNAME;
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Production path goes through `defaultDnsLookup`; unit tests always
  // inject `lookupImpl` for deterministic + offline coverage.
  /* c8 ignore next */
  const lookupImpl = inputs.lookupImpl ?? defaultDnsLookup;
  const start = Date.now();
  const abortCtx = createProbeAbortContext('dns', timeoutMs, inputs.signal);
  try {
    // `dns.promises.lookup` doesn't accept AbortSignal — race the
    // lookup against the abort signal so the per-probe deadline still
    // bounds the wall-clock cost. The leaked underlying lookup
    // resolves into the void once the OS resolver finishes; not ideal
    // but unavoidable without binding to a different resolver lib.
    const result = await Promise.race<DnsLookupResult>([
      lookupImpl(hostname),
      new Promise<DnsLookupResult>((_, reject) => {
        if (abortCtx.signal.aborted) {
          reject(asError(abortCtx.signal.reason, 'dns probe aborted'));
          return;
        }
        abortCtx.signal.addEventListener(
          'abort',
          () => {
            reject(asError(abortCtx.signal.reason, 'dns probe aborted'));
          },
          { once: true },
        );
      }),
    ]);
    return ok('dns', start, {
      address: result.address,
      family: result.family,
    });
  } catch (err) {
    if (abortCtx.didTimeout()) {
      return fail('dns', start, 'timeout', `dns lookup of ${hostname} timed out`, {
        hostname,
        timeout_ms: timeoutMs,
      });
    }
    const code = errorCode(err);
    if (code === 'ENOTFOUND' || code === 'EAI_NONAME') {
      return fail('dns', start, 'not_found', `host ${hostname} not found`, {
        hostname,
        code,
      });
    }
    if (code === 'EAI_AGAIN') {
      return fail('dns', start, 'temporary_failure', `dns lookup temporarily failed`, {
        hostname,
        code,
      });
    }
    return fail('dns', start, 'lookup_failed', errorMessage(err), {
      hostname,
      ...(code === undefined ? {} : { code }),
    });
  } finally {
    abortCtx.dispose();
  }
};

// Production-only path: binds a real TCP socket via `node:net`. Unit
// tests inject a `tcpConnectImpl` seam; integration tests run
// `--no-probe`. Real-socket test would require an ephemeral
// localhost listener + a TCP server, brittle vs. the seam-injected
// per-failure-mode matrix that already covers every reason
// discriminant.
/* c8 ignore start */
const defaultTcpConnect = ({ host, port, signal }: TcpConnectArgs): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const cleanup = (): void => {
      socket.removeAllListeners();
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
    };
    const onAbort = (): void => {
      cleanup();
      reject(asError(signal.reason, 'tcp connect aborted'));
    };
    if (signal.aborted) {
      cleanup();
      reject(asError(signal.reason, 'tcp connect aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('connect', () => {
      cleanup();
      resolve();
    });
    socket.once('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
/* c8 ignore stop */

/**
 * Opens a TCP connection to `inputs.hostname:inputs.port` (defaults
 * {@link DEFAULT_PROBE_HOSTNAME} / {@link DEFAULT_PROBE_PORT}) via
 * `node:net.createConnection` (or the injected seam). The socket is
 * destroyed in every exit path; the per-probe deadline aborts the
 * connection via the threaded signal.
 */
export const runTcpProbe = async (
  inputs: TcpProbeInputs = {},
): Promise<ProbeResult> => {
  const hostname = inputs.hostname ?? DEFAULT_PROBE_HOSTNAME;
  const port = inputs.port ?? DEFAULT_PROBE_PORT;
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Production path; unit tests inject `tcpConnectImpl`.
  /* c8 ignore next */
  const tcpConnectImpl = inputs.tcpConnectImpl ?? defaultTcpConnect;
  const start = Date.now();
  const abortCtx = createProbeAbortContext('tcp', timeoutMs, inputs.signal);
  try {
    await tcpConnectImpl({ host: hostname, port, signal: abortCtx.signal });
    return ok('tcp', start, { host: hostname, port });
  } catch (err) {
    if (abortCtx.didTimeout()) {
      return fail(
        'tcp',
        start,
        'timeout',
        `tcp connect to ${hostname}:${String(port)} timed out`,
        { host: hostname, port, timeout_ms: timeoutMs },
      );
    }
    const code = errorCode(err);
    if (code === 'ECONNREFUSED') {
      return fail('tcp', start, 'connection_refused', errorMessage(err), {
        host: hostname,
        port,
        code,
      });
    }
    if (code === 'ECONNRESET') {
      return fail('tcp', start, 'connection_reset', errorMessage(err), {
        host: hostname,
        port,
        code,
      });
    }
    if (code === 'ETIMEDOUT') {
      return fail('tcp', start, 'timeout', errorMessage(err), {
        host: hostname,
        port,
        code,
        timeout_ms: timeoutMs,
      });
    }
    return fail('tcp', start, 'connection_failed', errorMessage(err), {
      host: hostname,
      port,
      ...(code === undefined ? {} : { code }),
    });
  } finally {
    abortCtx.dispose();
  }
};

// Production-only path: binds a real TLS socket via `node:tls`. Unit
// tests inject a `tlsConnectImpl` seam; integration tests under
// `--no-probe` skip this path. A real-cert test would require a
// disposable TLS server with a self-signed cert, brittle vs. the
// seam-injected per-failure-mode coverage (cert_expired,
// cert_untrusted, cert_name_mismatch, etc.).
/* c8 ignore start */
const defaultTlsConnect = ({ host, port, signal }: TcpConnectArgs): Promise<TlsCertDetails> =>
  new Promise<TlsCertDetails>((resolve, reject) => {
    const socket = tlsConnect({
      host,
      port,
      servername: host,
      rejectUnauthorized: true,
    });
    const cleanup = (): void => {
      socket.removeAllListeners();
      signal.removeEventListener('abort', onAbort);
      socket.destroy();
    };
    const onAbort = (): void => {
      cleanup();
      reject(asError(signal.reason, 'tls handshake aborted'));
    };
    if (signal.aborted) {
      cleanup();
      reject(asError(signal.reason, 'tls handshake aborted'));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      cleanup();
      // Node's `getPeerCertificate()` types `subject`/`issuer` as
      // required objects, but the runtime can return an empty `{}`
      // when the peer didn't send a cert (which `rejectUnauthorized`
      // would reject anyway). Narrow defensively via typeof.
      const subjectCn = (cert as { subject?: { CN?: unknown } }).subject?.CN;
      const issuerCn = (cert as { issuer?: { CN?: unknown } }).issuer?.CN;
      const subject =
        typeof subjectCn === 'string' && subjectCn.length > 0 ? subjectCn : '<unknown>';
      const issuer =
        typeof issuerCn === 'string' && issuerCn.length > 0 ? issuerCn : '<unknown>';
      const validTo = typeof cert.valid_to === 'string' ? cert.valid_to : '<unknown>';
      resolve({ subject, issuer, valid_to: validTo });
    });
    socket.once('error', (err: Error) => {
      cleanup();
      reject(err);
    });
  });
/* c8 ignore stop */

/**
 * Completes a TLS handshake against `inputs.hostname:inputs.port`
 * with SNI set + cert validation on. Captures the peer cert summary
 * (`subject`/`issuer`/`valid_to`) into `details` on success; maps
 * `CERT_HAS_EXPIRED` → `cert_expired`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`
 * → `cert_untrusted`, `ERR_TLS_CERT_ALTNAME_INVALID` →
 * `cert_name_mismatch`, anything else → `tls_handshake_failed`.
 */
export const runTlsProbe = async (
  inputs: TlsProbeInputs = {},
): Promise<ProbeResult> => {
  const hostname = inputs.hostname ?? DEFAULT_PROBE_HOSTNAME;
  const port = inputs.port ?? DEFAULT_PROBE_PORT;
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  // Production path; unit tests inject `tlsConnectImpl`.
  /* c8 ignore next */
  const tlsConnectImpl = inputs.tlsConnectImpl ?? defaultTlsConnect;
  const start = Date.now();
  const abortCtx = createProbeAbortContext('tls', timeoutMs, inputs.signal);
  try {
    const cert = await tlsConnectImpl({
      host: hostname,
      port,
      signal: abortCtx.signal,
    });
    return ok('tls', start, {
      subject: cert.subject,
      issuer: cert.issuer,
      valid_to: cert.valid_to,
    });
  } catch (err) {
    if (abortCtx.didTimeout()) {
      return fail('tls', start, 'timeout', `tls handshake to ${hostname} timed out`, {
        host: hostname,
        port,
        timeout_ms: timeoutMs,
      });
    }
    const code = errorCode(err);
    if (code === 'CERT_HAS_EXPIRED') {
      return fail('tls', start, 'cert_expired', errorMessage(err), {
        host: hostname,
        port,
        code,
      });
    }
    if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      return fail('tls', start, 'cert_untrusted', errorMessage(err), {
        host: hostname,
        port,
        code,
      });
    }
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
      return fail('tls', start, 'cert_name_mismatch', errorMessage(err), {
        host: hostname,
        port,
        code,
      });
    }
    return fail('tls', start, 'tls_handshake_failed', errorMessage(err), {
      host: hostname,
      port,
      ...(code === undefined ? {} : { code }),
    });
  } finally {
    abortCtx.dispose();
  }
};

/**
 * Issues `query { me { id } }` against the supplied transport. Maps
 * the empirical-probe-confirmed 401 envelope to `unauthorized`;
 * 5xx HTTP status / transport failures (DNS recovery, TCP reset, TLS
 * handshake error mid-flight) to `network_error` per cli-design
 * §11.5.1's per-probe error-code table.
 *
 * The probe's contract is "can we authenticate?", not "can we
 * complete a request budget-wise?". A `complexity_exceeded` from
 * `me { id }` would mean the budget is pathological; the auth probe
 * surfaces it as `auth_failed` rather than mapping into the §11.5.1
 * table's two reasons, so the verb-level envelope reads cleanly.
 */
export const runAuthProbe = async (
  inputs: AuthProbeInputs,
): Promise<ProbeResult> => {
  const timeoutMs = inputs.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const start = Date.now();
  const abortCtx = createProbeAbortContext('auth', timeoutMs, inputs.signal);
  try {
    const response = await inputs.transport.request({
      query: 'query MondayStatusAuth { me { id } }',
      operationName: 'MondayStatusAuth',
      signal: abortCtx.signal,
    });
    if (response.status === 401) {
      return fail('auth', start, 'unauthorized', 'Monday returned 401', {
        http_status: 401,
      });
    }
    if (response.status >= 500) {
      return fail(
        'auth',
        start,
        'network_error',
        `Monday returned HTTP ${String(response.status)}`,
        { http_status: response.status },
      );
    }
    if (response.status !== 200) {
      return fail(
        'auth',
        start,
        'network_error',
        `unexpected HTTP status ${String(response.status)} from auth probe`,
        { http_status: response.status },
      );
    }
    const body = response.body;
    if (typeof body !== 'object' || body === null) {
      return fail(
        'auth',
        start,
        'network_error',
        'auth probe response was not a JSON object',
        { http_status: response.status },
      );
    }
    const bodyRecord = body as Record<string, unknown>;
    const errorsField = bodyRecord.errors;
    if (Array.isArray(errorsField) && errorsField.length > 0) {
      // §11.5.1 unauthorized-mapping is "any errors[] entry carries
      // an auth code", not "the first entry". Scan every entry so a
      // mixed-error response (e.g., complexity warning followed by
      // an auth-token expiration) still maps to `unauthorized` — the
      // security-bearing reading wins over the first-error read.
      // Codex M22 W2 ratified.
      const extractCode = (entry: unknown): string | undefined => {
        if (typeof entry !== 'object' || entry === null) return undefined;
        const ext = (entry as { extensions?: unknown }).extensions;
        if (typeof ext !== 'object' || ext === null) return undefined;
        const code = (ext as { code?: unknown }).code;
        return typeof code === 'string' ? code : undefined;
      };
      const extractMessage = (entry: unknown): string | undefined => {
        if (typeof entry !== 'object' || entry === null) return undefined;
        const m = (entry as { message?: unknown }).message;
        return typeof m === 'string' ? m : undefined;
      };
      const errorsList = errorsField as unknown[];
      const authEntry: unknown = errorsList.find((e: unknown) => {
        const code = extractCode(e);
        return code === 'NOT_AUTHENTICATED' || code === 'UNAUTHENTICATED';
      });
      if (authEntry !== undefined) {
        const code = extractCode(authEntry) as 'NOT_AUTHENTICATED' | 'UNAUTHENTICATED';
        const msg = extractMessage(authEntry) ?? 'auth probe rejected';
        return fail('auth', start, 'unauthorized', msg, {
          http_status: response.status,
          monday_code: code,
        });
      }
      const first: unknown = errorsList[0];
      const firstCode = extractCode(first);
      const firstMsg = extractMessage(first) ?? 'auth probe rejected';
      return fail('auth', start, 'auth_failed', firstMsg, {
        http_status: response.status,
        ...(firstCode === undefined ? {} : { monday_code: firstCode }),
      });
    }
    const data = bodyRecord.data;
    /* c8 ignore next 9 — defensive: Monday's GraphQL surface always
       returns `data: {...}` on a 200, and the errors[] branch above
       handles the `data: null` case. This guard exists for hypothetical
       transport shapes that 200-without-data; not reproducible from
       a fixture cassette that returns a valid GraphQL envelope. */
    if (typeof data !== 'object' || data === null) {
      return fail(
        'auth',
        start,
        'network_error',
        'auth probe response missing `data`',
        { http_status: response.status },
      );
    }
    const me = (data as { me?: unknown }).me;
    if (typeof me !== 'object' || me === null) {
      return fail('auth', start, 'unauthorized', 'auth probe returned null `me`', {
        http_status: response.status,
      });
    }
    const meId = (me as { id?: unknown }).id;
    if (typeof meId !== 'string' || meId.length === 0) {
      return fail(
        'auth',
        start,
        'network_error',
        'auth probe response had unexpected `me` shape',
        { http_status: response.status },
      );
    }
    const details: Record<string, unknown> = { me_id: meId };
    if (inputs.apiVersionHint !== undefined) {
      details.api_version = inputs.apiVersionHint;
    }
    return ok('auth', start, details);
  } catch (err) {
    if (abortCtx.didTimeout()) {
      return fail('auth', start, 'timeout', 'auth probe timed out', {
        timeout_ms: timeoutMs,
      });
    }
    if (err instanceof ApiError) {
      if (err.code === 'unauthorized') {
        return fail('auth', start, 'unauthorized', err.message, {
          http_status: err.httpStatus ?? 401,
        });
      }
      return fail('auth', start, 'network_error', err.message, {
        ...(err.httpStatus === undefined ? {} : { http_status: err.httpStatus }),
        error_code: err.code,
      });
    }
    return fail('auth', start, 'network_error', errorMessage(err), {});
  } finally {
    abortCtx.dispose();
  }
};

/**
 * Verifies the local cache directory (`<HOME>/.monday-cli/`) exists,
 * is mode `0700`, and is writable. Stat + access(W_OK) + probe-write
 * (`<dir>/.probe-<rand>`) → delete dance — `access(W_OK)` is advisory
 * on some Unix filesystems, so a probe-write confirms true writability.
 */
export const runCacheWritabilityProbe = async (
  inputs: CacheWritabilityProbeInputs,
): Promise<ProbeResult> => {
  const home = inputs.home ?? inputs.env.HOME ?? homedir();
  const cacheDir = join(home, CACHE_DIR_NAME);
  const start = Date.now();

  let stats;
  try {
    stats = await stat(cacheDir);
  } catch (err) {
    if (isENOENT(err)) {
      return fail(
        'cache_writability',
        start,
        'dir_missing',
        `cache directory ${cacheDir} does not exist`,
        {
          path: cacheDir,
          hint: 'run `monday auth login --profile <name>` or any cache-writing command to create it',
        },
      );
    }
    // Non-ENOENT stat failures (EACCES on the parent dir, etc.) aren't
    // reproducible without root or chroot; ENOENT is the only failure
    // mode tests can drive against a tmp dir.
    /* c8 ignore start */
    return fail(
      'cache_writability',
      start,
      'stat_failed',
      `cannot stat cache directory ${cacheDir}: ${errorMessage(err)}`,
      { path: cacheDir },
    );
    /* c8 ignore stop */
  }

  if (!stats.isDirectory()) {
    return fail(
      'cache_writability',
      start,
      'not_a_directory',
      `cache path ${cacheDir} is not a directory`,
      { path: cacheDir },
    );
  }

  if ((stats.mode & CACHE_DIR_REQUIRED_MODE_BITS) !== 0) {
    return fail(
      'cache_writability',
      start,
      'mode_insecure',
      `cache directory ${cacheDir} has insecure permissions ${formatMode(stats.mode)}`,
      {
        path: cacheDir,
        mode: formatMode(stats.mode),
        hint: `run \`chmod 700 ${cacheDir}\` to tighten`,
      },
    );
  }

  try {
    await access(cacheDir, fsConstants.W_OK);
  } catch (err) {
    // access(W_OK) failure requires the dir to exist but be non-writable
    // — needs root + ownership manipulation to reproduce against a
    // tmp dir owned by the test user. Production-only.
    /* c8 ignore start */
    return fail(
      'cache_writability',
      start,
      'permission_denied',
      `cache directory ${cacheDir} is not writable: ${errorMessage(err)}`,
      { path: cacheDir, mode: formatMode(stats.mode) },
    );
    /* c8 ignore stop */
  }

  const probeFile = join(cacheDir, `.probe-${randomUUID()}`);
  try {
    await writeFile(probeFile, '', { mode: 0o600 });
  } catch (err) {
    // writeFile failure when access(W_OK) succeeded is a TOCTOU race
    // (between the access check and the write), filesystem-full, or
    // similar runtime-rare condition. Production-only.
    return fail(
      'cache_writability',
      start,
      'write_failed',
      `probe write to ${cacheDir} failed: ${errorMessage(err)}`,
      { path: cacheDir, mode: formatMode(stats.mode) },
    );
    /* c8 ignore stop */
  }
  // Best-effort cleanup; if unlink fails we still succeed because the
  // write succeeded — a leaked probe file is harmless.
  await unlink(probeFile).catch(() => undefined);

  return ok('cache_writability', start, {
    path: cacheDir,
    mode: formatMode(stats.mode),
  });
};

/**
 * Folds {@link REDACTION_SELF_TEST_FIXTURE_TOKEN} into
 * `inputs.runtimeSecrets`, runs a sample object (carrying the
 * canary in `error.message`, `error.stack`, a nested
 * `error.cause.message`, a URL, and a lowercase
 * `authorization` header value, plus a mixed-content debug string)
 * through `redact()` with `collectSecrets(env, runtimeSecrets)`, and
 * asserts the canary is absent from every byte of the redacted
 * output. Removes the canary from `runtimeSecrets` before returning
 * so the caller's state is unchanged.
 *
 * Failure here indicates a regression in the redaction layer
 * itself (a serious bug); the probe surfaces `canary_leaked` with
 * `details.contexts_leaked` listing which §7.4.3 enumerated
 * carrier paths still hold the canary.
 */
export const runRedactionSelfTest = (
  inputs: RedactionSelfTestInputs,
): Promise<ProbeResult> => Promise.resolve(runRedactionSelfTestSync(inputs));

const runRedactionSelfTestSync = (
  inputs: RedactionSelfTestInputs,
): ProbeResult => {
  const start = Date.now();
  const canary = REDACTION_SELF_TEST_FIXTURE_TOKEN;
  // Production path; the leak-path test injects a tampered redactor.
  /* c8 ignore next */
  const redactImpl = inputs.redactImpl ?? defaultRedactImpl;

  inputs.runtimeSecrets.push(canary);
  try {
    const innerError = new Error(`inner failure carrying ${canary}`);
    const outerError = new Error(`outer failure carrying ${canary}`);
    (outerError as { cause?: unknown }).cause = innerError;

    const sample = {
      error: {
        message: outerError.message,
        // `Error.stack` is always populated under V8; the fallback is a
        // defensive guard for embedders with custom error constructors.
        /* c8 ignore next */
        stack: outerError.stack ?? '',
        cause: {
          message: innerError.message,
        },
      },
      headers: {
        authorization: canary,
      },
      url: `https://api.monday.com/v2?bogus=${canary}`,
      debug: `auth=${canary} expired`,
    };

    const redacted = redactImpl(sample, {
      secrets: collectSecrets(inputs.env, inputs.runtimeSecrets),
    });
    const serialised = JSON.stringify(redacted);

    if (serialised.includes(canary)) {
      const leakedContexts: string[] = [];
      const redactedRecord = redacted as Record<string, unknown>;
      const stringAt = (path: readonly string[]): string | undefined => {
        let cur: unknown = redactedRecord;
        for (const segment of path) {
          /* c8 ignore next — defensive: paths into the fixture-built
             sample object are always traversable when the redactor is
             identity-mapped; non-object hops only happen when a
             future redactor materially changes the shape. */
          if (typeof cur !== 'object' || cur === null) return undefined;
          cur = (cur as Record<string, unknown>)[segment];
        }
        /* c8 ignore next — fixture leaves canary as a string at every
           path; non-string terminals only appear via a rewriting
           redactor. */
        return typeof cur === 'string' ? cur : undefined;
      };
      const checks: readonly { readonly key: (typeof REDACTION_LEAK_CONTEXT_KEYS)[number]; readonly path: readonly string[] }[] = [
        { key: 'error.message', path: ['error', 'message'] },
        { key: 'error.stack', path: ['error', 'stack'] },
        { key: 'error.cause.message', path: ['error', 'cause', 'message'] },
        { key: 'headers.authorization', path: ['headers', 'authorization'] },
        { key: 'url', path: ['url'] },
        { key: 'debug', path: ['debug'] },
      ];
      for (const check of checks) {
        const value = stringAt(check.path);
        /* c8 ignore next — `value?.includes(canary)` short-circuits
           on `value === undefined`; defensive false-arm. */
        if (value?.includes(canary) === true) {
          leakedContexts.push(check.key);
        }
      }
      return fail(
        'redaction_self_test',
        start,
        'canary_leaked',
        'redaction self-test canary leaked through redact()',
        {
          fixture_count: REDACTION_LEAK_CONTEXT_KEYS.length,
          contexts_leaked: leakedContexts,
        },
      );
    }

    return ok('redaction_self_test', start, {
      fixture_count: REDACTION_LEAK_CONTEXT_KEYS.length,
    });
  } finally {
    const idx = inputs.runtimeSecrets.lastIndexOf(canary);
    // Defensive: we just pushed the canary at the top of the try; the
    // only way idx === -1 is if the test removed it mid-call (which
    // it doesn't). Kept defensive so the splice is safe.
    /* c8 ignore next */
    if (idx !== -1) {
      inputs.runtimeSecrets.splice(idx, 1);
    }
  }
};

/**
 * Summarises which of {@link ENV_VAR_PICKUP_KEYS} are set on
 * `inputs.env`. **Values are NEVER included** — an env var's value
 * is potentially a token. Wrapped in a Promise so callers can
 * `Promise.allSettled` the full matrix without special-casing this
 * step.
 */
export const summariseEnvVarPickup = (
  inputs: EnvVarPickupProbeInputs,
): Promise<ProbeResult> => {
  const start = Date.now();
  const set: Record<string, boolean> = {};
  for (const key of ENV_VAR_PICKUP_KEYS) {
    const value = inputs.env[key];
    set[key] = value !== undefined && value.length > 0;
  }
  return Promise.resolve(ok('env_var_pickup', start, { set }));
};

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

/**
 * The `monday status` envelope shape (`data` payload). Derived from
 * {@link statusOutputSchema} above per `.claude/rules/validation.md`
 * "schema-driven types" — the schema is the source of truth.
 *
 * `probes` is keyed by {@link ProbeName} with every
 * {@link STATUS_PROBE_ORDER} entry required; additional probe names
 * land via the schema's `catchall` so future probes (e.g.,
 * `cache_freshness`) are additive per cli-design §6.1. `overall`
 * rules + the per-probe error-code mapping live in cli-design §11.5.2
 * + §11.5.1's table; the auth probe captures the resolved
 * `api_version` so agents detect drift between the pin and server.
 */
export type StatusOutput = z.infer<typeof statusOutputSchema>;
