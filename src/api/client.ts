/**
 * Monday GraphQL client over the injected `Transport`
 * (`v0.1-plan.md` §3 M2).
 *
 * Why not the SDK's `ApiClient`. The plan's wording is
 * "wraps `@mondaydotcomorg/api`'s `ApiClient`" but the SDK's
 * `request()` doesn't accept an external `AbortSignal` — it builds
 * its own controller per-call, which means the runner's SIGINT-ware
 * abort can't cancel an in-flight request. Tests also need to swap
 * the network stack without monkey-patching SDK internals (Codex
 * review §2 of M0). Both problems are solved by the existing
 * `Transport` interface, so the client routes every call through
 * `transport.request()` and uses the SDK only for *types* — `Account`,
 * `User`, `Complexity`, `Version`, `CURRENT_VERSION`.
 *
 * Header injection (`Authorization`, `API-Version`, `Content-Type`)
 * lives in `FetchTransport` and is locked down (Codex review M0 §1
 * follow-up). Caller-supplied headers can't override it; this client
 * passes only operation-name and any future trace headers.
 *
 * Internal callers see `Record<string, unknown>` for variables. The
 * SDK's `QueryVariables = Record<string, any>` boundary leak is
 * contained at this module's edge — no `any` flows into `commands/*`.
 */

import { AvailableVersions } from '@mondaydotcomorg/api';
import { mapResponse, wrapTransportError } from './errors.js';
import { withRetry, type RetryStats } from './retry.js';
import { injectComplexity, parseComplexity } from './complexity.js';
import type { Transport } from './transport.js';
import type { Complexity } from '../utils/output/envelope.js';

/**
 * The Monday API version pinned to the SDK install. Re-exported so
 * the production runner and `monday account version` read the same
 * source of truth — bumping the SDK is the only way this changes.
 */
export const PINNED_API_VERSION: string = AvailableVersions.CURRENT_VERSION;

export interface MondayClientConfig {
  readonly transport: Transport;
  readonly signal: AbortSignal;
  /**
   * Maximum retries per request. Comes from `--retry` (default 3).
   * Passed through to `withRetry`; the retry layer respects
   * `error.retryable` + `retry_after_seconds`.
   */
  readonly retries: number;
  /**
   * When true, every request injects the `complexity { ... }`
   * selection at the outermost selection set and parses the result
   * onto `Complexity`. Comes from `--verbose`.
   */
  readonly verbose: boolean;
  /**
   * Test hooks — production wires these to defaults. Documented in
   * `api/retry.ts` (`RetryOptions`).
   */
  readonly retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly retryRandom?: () => number;
}

export interface MondayRequestOptions {
  /**
   * Marker passed to the transport for a friendlier `body.operationName`
   * — Monday's logs surface this when triaging issues. Defaults to
   * the typed-method's name (e.g. `"whoami"`).
   */
  readonly operationName?: string;
}

export interface MondayResponse<T> {
  readonly data: T;
  /**
   * Always present — null when the response carried no `complexity`
   * block, an object otherwise. Matches `cli-design.md` §6.1's rule
   * for `meta.complexity`.
   */
  readonly complexity: Complexity | null;
  /** How many transport calls happened (1 = first attempt succeeded). */
  readonly stats: RetryStats;
}

/**
 * Subset of Monday's `User` we surface on `monday account whoami` /
 * `monday user me`. The SDK's full `User` type (~30 fields) is too
 * wide — we project to the slim shape `cli-design.md` calls out.
 */
export interface WhoamiData {
  readonly me: {
    readonly id: string;
    readonly name: string;
    readonly email: string;
    readonly account: {
      readonly id: string;
      readonly name: string;
      readonly slug: string | null;
    };
  };
}

export interface AccountData {
  readonly account: {
    readonly id: string;
    readonly name: string;
    readonly slug: string | null;
    readonly country_code: string | null;
    readonly first_day_of_the_week: string | null;
    readonly active_members_count: number | null;
    readonly logo: string | null;
    readonly plan: {
      readonly version: number;
      readonly tier: string;
      readonly max_users: number;
      readonly period: string | null;
    } | null;
  };
}

export interface VersionsData {
  readonly versions: readonly {
    readonly display_name: string;
    readonly kind: string;
    readonly value: string;
  }[];
}

export interface ComplexityProbeData {
  readonly complexity: {
    readonly before: number;
    readonly after: number;
    readonly query: number;
    readonly reset_in_x_seconds: number;
  } | null;
}

const ME_QUERY = `
  query Whoami {
    me {
      id
      name
      email
      account {
        id
        name
        slug
      }
    }
  }
`;

const ACCOUNT_QUERY = `
  query AccountInfo {
    account {
      id
      name
      slug
      country_code
      first_day_of_the_week
      active_members_count
      logo
      plan {
        version
        tier
        max_users
        period
      }
    }
  }
`;

const VERSIONS_QUERY = `
  query Versions {
    versions {
      display_name
      kind
      value
    }
  }
`;

const COMPLEXITY_PROBE_QUERY = `
  query ComplexityProbe {
    complexity {
      before
      after
      query
      reset_in_x_seconds
    }
  }
`;

export class MondayClient {
  private readonly transport: Transport;
  private readonly signal: AbortSignal;
  private readonly retries: number;
  private readonly verbose: boolean;
  private readonly retrySleep:
    | ((ms: number, signal: AbortSignal) => Promise<void>)
    | undefined;
  private readonly retryRandom: (() => number) | undefined;

  constructor(config: MondayClientConfig) {
    this.transport = config.transport;
    this.signal = config.signal;
    this.retries = config.retries;
    this.verbose = config.verbose;
    this.retrySleep = config.retrySleep;
    this.retryRandom = config.retryRandom;
  }

  /**
   * Low-level escape hatch (`v0.1-plan.md` §3 M2 deliverable).
   * `commands/raw` (M6) calls this directly; M2 commands use the
   * typed wrappers. Returns the parsed `data` plus the per-request
   * complexity meta and retry stats.
   *
   * Variables are typed `Record<string, unknown>` rather than the
   * SDK's `any`-laced `QueryVariables` so the surface stays sealed.
   */
  readonly raw = async <T>(
    query: string,
    variables: Readonly<Record<string, unknown>> | undefined,
    options: MondayRequestOptions = {},
  ): Promise<MondayResponse<T>> => {
    const finalQuery = this.verbose ? injectComplexity(query) : query;
    const operationName = options.operationName;

    const result = await withRetry(
      async () => {
        try {
          const response = await this.transport.request({
            query: finalQuery,
            ...(variables === undefined ? {} : { variables }),
            ...(operationName === undefined ? {} : { operationName }),
            signal: this.signal,
          });
          const mapped = mapResponse<T>({
            status: response.status,
            headers: response.headers,
            body: response.body,
          });
          if (!mapped.ok) {
            throw mapped.error;
          }
          // Parse complexity off the *original* body — not the
          // mapped data, which is shaped to the typed leaf.
          const complexity = this.verbose
            ? parseComplexity(response.body)
            : null;
          return { data: mapped.data, complexity };
        } catch (err) {
          // ApiError passes through unchanged; anything else (a bug
          // in the transport, a rogue throw from a future SDK retry
          // layer) becomes internal_error with cause set. The retry
          // layer reads .retryable to decide.
          throw wrapTransportError(err);
        }
      },
      {
        retries: this.retries,
        signal: this.signal,
        ...(this.retrySleep === undefined ? {} : { sleep: this.retrySleep }),
        ...(this.retryRandom === undefined ? {} : { random: this.retryRandom }),
      },
    );
    return {
      data: result.value.data,
      complexity: result.value.complexity,
      stats: result.stats,
    };
  };

  readonly whoami = (): Promise<MondayResponse<WhoamiData>> =>
    this.raw<WhoamiData>(ME_QUERY, undefined, { operationName: 'Whoami' });

  readonly account = (): Promise<MondayResponse<AccountData>> =>
    this.raw<AccountData>(ACCOUNT_QUERY, undefined, { operationName: 'AccountInfo' });

  readonly versions = (): Promise<MondayResponse<VersionsData>> =>
    this.raw<VersionsData>(VERSIONS_QUERY, undefined, { operationName: 'Versions' });

  /**
   * Cheapest possible call: just selects the `complexity` field with
   * no payload. Used by `monday account complexity` to probe the
   * budget without any other side-effect.
   */
  readonly complexityProbe = (): Promise<MondayResponse<ComplexityProbeData>> =>
    this.raw<ComplexityProbeData>(
      COMPLEXITY_PROBE_QUERY,
      undefined,
      { operationName: 'ComplexityProbe' },
    );
}
