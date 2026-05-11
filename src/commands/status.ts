/**
 * `monday status` — connectivity + auth + local-state probe matrix
 * (cli-design §11.5 / §13 v0.3 entry; v0.3-plan §3 M22).
 *
 * **The verb's question:** "is everything I need to talk to Monday
 * working, without touching account state?" Runs a short,
 * deterministic 7-probe matrix and emits the §11.5.2 envelope shape.
 *
 * **`--no-probe` per Decision 7 closure.** Default behaviour probes
 * Monday (DNS / TCP / TLS / auth). `--no-probe` opts out, skipping
 * just those four network-touching probes; the local-only probes
 * (cache writability, redaction self-test, env-var pickup) still
 * run because they don't touch account state and are the v0.3 value
 * of a "check my CLI is configured correctly" run.
 *
 * **Empirical-probe finding pinned (2026-05-10, API `2026-01`).** The
 * 401 envelope shape `monday status`'s auth probe maps against:
 * status `401`, content-type `application/json; charset=utf-8`,
 * body `{"errors":[{"message":"Not authenticated","extensions":
 * {"code":"NOT_AUTHENTICATED"}}]}`. Identical envelope for
 * missing-`Authorization` and bad-`Authorization`. Maps verbatim
 * to `unauthorized` (existing error code; NO new code needed). See
 * `src/api/probes.ts` for the load-bearing probe-finding docstring.
 *
 * **Overall rule per §11.5.2:**
 *   - `'down'` — any network probe failed, OR `redaction_self_test`
 *     failed (NEVER degraded — a redaction regression means the CLI
 *     may leak secrets), OR every network probe was skipped AND a
 *     local probe failed.
 *   - `'degraded'` — auth probe succeeded AND only soft local probes
 *     (cache_writability + env_var_pickup) failed. Exit 0.
 *   - `'ok'` — every non-skipped probe returned `'ok'`.
 *
 * **Error-code mapping when `'down'` per §11.5.1's table:**
 * `redaction_self_test → internal_error`; auth (401) →
 * `unauthorized`; auth (5xx) / dns / tcp / tls → `network_error`;
 * cache_writability → `config_error`. NO new ERROR_CODE for M22.
 *
 * **Redaction-runtime contract honored.** The redaction self-test
 * probe consults BOTH `ctx.env` AND `ctx.runtimeSecrets` (mirroring
 * `collectSecrets(env, runtimeSecrets)`'s production signature) — the
 * Codex M21 P1 ratification.
 */
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { ApiError, ConfigError } from '../utils/errors.js';
import {
  runDnsProbe,
  runTcpProbe,
  runTlsProbe,
  runAuthProbe,
  runCacheWritabilityProbe,
  runRedactionSelfTest,
  summariseEnvVarPickup,
  statusOutputSchema,
  type ProbeName,
  type ProbeResult,
  type StatusOutput,
} from '../api/probes.js';
import { emitSuccess } from './emit.js';
import { parseGlobalFlags } from '../types/global-flags.js';
import { loadConfig } from '../config/load.js';
import { createFetchTransport, type Transport } from '../api/transport.js';
import { PINNED_API_VERSION } from '../api/client.js';
import type { RunContext } from '../cli/run.js';
import type { ErrorCode } from '../utils/errors.js';

const inputSchema = z
  .object({
    no_probe: z.boolean(),
  })
  .strict();

export type { StatusOutput };

const NETWORK_PROBES: readonly ProbeName[] = ['dns', 'tcp', 'tls', 'auth'];

interface ResolvedStatusTransport {
  readonly transport: Transport;
  readonly apiVersion: string;
}

/**
 * Build the transport for the auth probe. Production resolves via
 * `loadConfig(ctx.env)` (env → .env → SDK pin); tests inject
 * `ctx.transport`. If neither is available we return a sentinel and
 * the action surfaces the auth probe as a typed failure (`no_token`)
 * rather than throwing config_error — `monday status`'s job is to
 * report state, not refuse to run.
 */
/**
 * Discriminates the "missing-token" `ConfigError` (the only failure mode
 * `monday status` downgrades to a `no_token` auth-probe result) from
 * the other config-validation failures (malformed URL / version /
 * timeout). The check reads `details.issues[].path` populated by
 * `src/config/load.ts`'s zod-wrap — a `MONDAY_API_TOKEN` issue path
 * means the token was missing or empty.
 */
const isMissingTokenConfigError = (err: ConfigError): boolean => {
  const issues = (err.details as { issues?: unknown } | undefined)?.issues;
  /* c8 ignore next — `loadConfig` always populates `details.issues`
     as an array on its ConfigError throws; the guard is defensive. */
  if (!Array.isArray(issues)) return false;
  if (issues.length === 0) return false;
  // Codex M22 round-2 P2: require EVERY issue to be the
  // MONDAY_API_TOKEN path. A mixed ConfigError (token missing AND
  // MONDAY_API_URL malformed) must NOT downgrade to `no_token` —
  // the URL issue would get hidden under the auth-probe failure.
  // Token-only issues downgrade; any other path re-throws as
  // `config_error`.
  for (const issue of issues) {
    /* c8 ignore next — issues are object literals built by `loadConfig`;
       non-object entries don't occur. */
    if (typeof issue !== 'object' || issue === null) return false;
    const path = (issue as { path?: unknown }).path;
    if (path !== 'MONDAY_API_TOKEN') return false;
  }
  return true;
};

export const resolveStatusTransport = (
  ctx: RunContext,
  programOpts: unknown,
): ResolvedStatusTransport | { readonly noToken: true; readonly apiVersion: string } => {
  const flags = parseGlobalFlags(programOpts, ctx.env);
  if (ctx.transport !== undefined) {
    const apiVersion =
      flags.apiVersion ?? ctx.env.MONDAY_API_VERSION ?? PINNED_API_VERSION;
    return { transport: ctx.transport, apiVersion };
  }
  let config;
  try {
    config = loadConfig(ctx.env);
  } catch (err) {
    // Codex M22 F2: only the missing-token ConfigError downgrades to
    // a `no_token` auth-probe result. Malformed `MONDAY_API_URL`,
    // `MONDAY_API_VERSION`, or `MONDAY_REQUEST_TIMEOUT_MS` are
    // surfaced verbatim as `config_error` (exit 3) — burying those
    // under a `no_token` auth-probe failure would mislead the agent
    // toward the wrong fix.
    if (err instanceof ConfigError && isMissingTokenConfigError(err)) {
      const apiVersion =
        flags.apiVersion ?? ctx.env.MONDAY_API_VERSION ?? PINNED_API_VERSION;
      return { noToken: true, apiVersion };
    }
    throw err;
  }
  const apiVersion =
    flags.apiVersion ?? config.apiVersion ?? PINNED_API_VERSION;
  const timeoutMs = flags.timeout ?? config.requestTimeoutMs;
  const transport = createFetchTransport({
    endpoint: config.apiUrl,
    apiToken: config.apiToken,
    apiVersion,
    timeoutMs,
  });
  return { transport, apiVersion };
};

const upstreamFailedProbe = (probe: ProbeName, upstream: ProbeName): ProbeResult => ({
  kind: 'fail',
  probe,
  elapsed_ms: 0,
  reason: 'upstream_failed',
  message: `${probe} probe skipped because ${upstream} probe failed`,
  details: { upstream },
});

const skippedProbe = (probe: ProbeName, reason: string): ProbeResult => ({
  kind: 'skipped',
  probe,
  reason,
});

const noTokenAuthProbe = (): ProbeResult => ({
  kind: 'fail',
  probe: 'auth',
  elapsed_ms: 0,
  reason: 'no_token',
  message:
    'auth probe could not run — no MONDAY_API_TOKEN in env, no .env, and no credentials cache',
  details: {
    hint: 'set MONDAY_API_TOKEN, configure a .env file, or run `monday auth login --profile <name>`',
  },
});

interface DerivedOverall {
  readonly overall: 'ok' | 'degraded' | 'down';
  readonly errorCode: ErrorCode | null;
  readonly errorMessage: string;
}

/**
 * Computes `overall` per §11.5.2 + the verb-level error code per
 * §11.5.1's mapping table. `redaction_self_test` failure ALWAYS
 * promotes to `'down'` regardless of network state — security-
 * bearing invariant.
 *
 * `env_var_pickup` is structurally infallible (the probe is a pure
 * read of `inputs.env`); we don't model an `env_var_pickup`-failed
 * branch here. If a future probe addition does add a failure mode
 * for env_var_pickup, the §11.5.2 rule should be extended
 * deliberately rather than via the soft-fallback default.
 */
export const deriveOverall = (
  probes: Readonly<Record<ProbeName, ProbeResult>>,
): DerivedOverall => {
  const isFailed = (probe: ProbeName): boolean => probes[probe].kind === 'fail';
  const isSkipped = (probe: ProbeName): boolean => probes[probe].kind === 'skipped';

  // Hard halt: redaction failure is always 'down'.
  if (isFailed('redaction_self_test')) {
    return {
      overall: 'down',
      errorCode: 'internal_error',
      errorMessage:
        'monday status: redaction self-test FAILED — the CLI may leak secrets in error output',
    };
  }

  // Network failures (the first one in STATUS_PROBE_ORDER drives the
  // verb-level error code; upstream_failed cascades carry the
  // discriminant via the per-probe `details.upstream` slot).
  const failedNetwork = NETWORK_PROBES.find((p) => isFailed(p));
  if (failedNetwork !== undefined) {
    const probe = probes[failedNetwork] as Extract<ProbeResult, { kind: 'fail' }>;
    const auth401 =
      failedNetwork === 'auth' &&
      (probe.reason === 'unauthorized' || probe.reason === 'no_token');
    const code: ErrorCode = auth401 ? 'unauthorized' : 'network_error';
    return {
      overall: 'down',
      errorCode: code,
      errorMessage: `monday status: ${failedNetwork} probe FAILED — ${probe.message}`,
    };
  }

  // Cache writability fail under --no-probe is 'down' per §11.5.2 —
  // without an auth-success signal we can't safely degrade.
  const allNetworkSkipped = NETWORK_PROBES.every(isSkipped);
  if (allNetworkSkipped && isFailed('cache_writability')) {
    const probe = probes.cache_writability as Extract<ProbeResult, { kind: 'fail' }>;
    return {
      overall: 'down',
      errorCode: 'config_error',
      errorMessage: `monday status: cache_writability probe FAILED — ${probe.message}`,
    };
  }
  if (allNetworkSkipped) {
    return { overall: 'ok', errorCode: null, errorMessage: '' };
  }

  // Auth succeeded path: soft-local failures degrade.
  if (isFailed('cache_writability')) {
    return { overall: 'degraded', errorCode: null, errorMessage: '' };
  }

  return { overall: 'ok', errorCode: null, errorMessage: '' };
};

/**
 * Probe runners injected into {@link orchestrateStatusProbes}.
 * Defaults are the production runners; tests substitute fake
 * implementations to drive the network-probe branches without
 * binding to real DNS / TCP / TLS / fetch.
 */
export interface StatusProbeRunners {
  readonly runDnsProbe: typeof runDnsProbe;
  readonly runTcpProbe: typeof runTcpProbe;
  readonly runTlsProbe: typeof runTlsProbe;
  readonly runAuthProbe: typeof runAuthProbe;
  readonly runCacheWritabilityProbe: typeof runCacheWritabilityProbe;
  readonly runRedactionSelfTest: typeof runRedactionSelfTest;
  readonly summariseEnvVarPickup: typeof summariseEnvVarPickup;
}

export interface OrchestrateStatusProbesInputs {
  readonly noProbe: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeSecrets: string[];
  readonly signal?: AbortSignal;
  readonly transportResolution:
    | ResolvedStatusTransport
    | { readonly noToken: true; readonly apiVersion: string };
  readonly runners?: Partial<StatusProbeRunners>;
}

export interface OrchestrateStatusProbesResult {
  readonly probes: Record<ProbeName, ProbeResult>;
  readonly apiVersion: string;
}

const defaultRunners: StatusProbeRunners = {
  runDnsProbe,
  runTcpProbe,
  runTlsProbe,
  runAuthProbe,
  runCacheWritabilityProbe,
  runRedactionSelfTest,
  summariseEnvVarPickup,
};

/**
 * Orchestrates the §11.5.1 probe matrix: network probes short-circuit
 * on first failure (TCP/TLS/auth surface `upstream_failed` once an
 * earlier probe fails); local probes always run; under `--no-probe`
 * the four network probes uniformly skip. Pure with respect to its
 * inputs — the only side effect is the redaction probe's transient
 * push/pop onto `runtimeSecrets` (which it restores before returning).
 */
export const orchestrateStatusProbes = async (
  inputs: OrchestrateStatusProbesInputs,
): Promise<OrchestrateStatusProbesResult> => {
  const runners: StatusProbeRunners = { ...defaultRunners, ...inputs.runners };
  const probes: Record<ProbeName, ProbeResult> = {} as Record<
    ProbeName,
    ProbeResult
  >;
  const apiVersion = inputs.transportResolution.apiVersion;

  const signalOpt =
    inputs.signal === undefined ? {} : { signal: inputs.signal };

  if (inputs.noProbe) {
    for (const probe of NETWORK_PROBES) {
      probes[probe] = skippedProbe(probe, 'no_probe_flag');
    }
  } else {
    probes.dns = await runners.runDnsProbe({ ...signalOpt });
    if (probes.dns.kind === 'fail') {
      probes.tcp = upstreamFailedProbe('tcp', 'dns');
      probes.tls = upstreamFailedProbe('tls', 'dns');
      probes.auth = upstreamFailedProbe('auth', 'dns');
    } else {
      probes.tcp = await runners.runTcpProbe({ ...signalOpt });
      if (probes.tcp.kind === 'fail') {
        probes.tls = upstreamFailedProbe('tls', 'tcp');
        probes.auth = upstreamFailedProbe('auth', 'tcp');
      } else {
        probes.tls = await runners.runTlsProbe({ ...signalOpt });
        if (probes.tls.kind === 'fail') {
          probes.auth = upstreamFailedProbe('auth', 'tls');
        } else if ('noToken' in inputs.transportResolution) {
          probes.auth = noTokenAuthProbe();
        } else {
          probes.auth = await runners.runAuthProbe({
            transport: inputs.transportResolution.transport,
            apiVersionHint: apiVersion,
            ...signalOpt,
          });
        }
      }
    }
  }

  probes.cache_writability = await runners.runCacheWritabilityProbe({
    env: inputs.env,
  });
  probes.redaction_self_test = await runners.runRedactionSelfTest({
    env: inputs.env,
    runtimeSecrets: inputs.runtimeSecrets,
  });
  probes.env_var_pickup = await runners.summariseEnvVarPickup({
    env: inputs.env,
  });

  return { probes, apiVersion };
};

export const statusCommand: CommandModule<
  z.infer<typeof inputSchema>,
  StatusOutput
> = {
  name: 'status',
  summary: 'Run the connectivity + auth + local-state probe matrix',
  examples: [
    'monday status',
    'monday status --json',
    'monday status --no-probe        # skip network probes; run local-only',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: statusOutputSchema,
  attach: (program, ctx) => {
    program
      .command('status')
      .description(statusCommand.summary)
      .option(
        '--no-probe',
        'Skip network probes (DNS / TCP / TLS / auth); run local-only probes (cache / redaction / env-var)',
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...statusCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      // Commander's `--no-probe` declaration produces `{probe: false}`
      // on the opts object (the `--no-X` form negates `X`); the action
      // normalises to `{no_probe: !opts.probe}` so the input schema
      // mirrors the user-facing flag name.
      .action(async (rawOpts: unknown) => {
        const opts = rawOpts as { probe?: boolean };
        const noProbe = opts.probe === false;
        statusCommand.inputSchema.parse({ no_probe: noProbe });

        const transportResolution = resolveStatusTransport(ctx, program.opts());

        // Commit meta.source BEFORE the orchestrate call so an error
        // envelope (overall='down' on a wire failure) reports the
        // accurate `source: 'live'` rather than the runner's `'none'`
        // default — Codex M22 F1 ratified. Under --no-probe the
        // wire is never touched, so `'none'` is correct.
        const source = noProbe ? 'none' : 'live';
        ctx.meta.setApiVersion(transportResolution.apiVersion);
        ctx.meta.setSource(source);

        const { probes, apiVersion } = await orchestrateStatusProbes({
          noProbe,
          env: ctx.env,
          runtimeSecrets: ctx.runtimeSecrets,
          signal: ctx.signal,
          transportResolution,
        });

        const data: StatusOutput = {
          probes: {
            dns: probes.dns,
            tcp: probes.tcp,
            tls: probes.tls,
            auth: probes.auth,
            cache_writability: probes.cache_writability,
            redaction_self_test: probes.redaction_self_test,
            env_var_pickup: probes.env_var_pickup,
          },
          overall: 'ok',
          api_version: apiVersion,
        };

        const derived = deriveOverall(probes);

        if (derived.overall === 'down') {
          // The verb's error code is determined by which probe drove
          // the 'down' verdict. The `details.probes` map carries the
          // full per-probe surface so agents read the same data they
          // would on the success envelope.
          /* c8 ignore next 2 — derived.overall === 'down' guarantees errorCode is set. */
          const code = derived.errorCode ?? 'internal_error';
          throw new ApiError(code, derived.errorMessage, {
            details: {
              probes: data.probes,
              overall: derived.overall,
              api_version: apiVersion,
            },
          });
        }

        emitSuccess({
          ctx,
          data: { ...data, overall: derived.overall },
          schema: statusCommand.outputSchema,
          programOpts: program.opts(),
          source,
          apiVersion,
          cacheAgeSeconds: null,
        });
      });
  },
};
