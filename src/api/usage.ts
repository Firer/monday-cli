/**
 * Usage-budget primitives for the v0.3-M22 `monday usage` verb
 * (cli-design §11.5 / §13 v0.3 entry).
 *
 * **Empirical probe findings (2026-05-10, against `api.monday.com`,
 * API version `2026-01`) — `scripts/probe/m22-usage*.ts`:**
 *
 *   - Monday's daily-budget surface lives at `platform_api.daily_limit`
 *     + `platform_api.daily_analytics.by_day` — **NOT**
 *     `account.complexity` (the field doesn't exist on the `Account`
 *     type; the cli-design pre-M22 wording that called it that was
 *     loose). `query { account { complexity { ... } } }` returns
 *     `Cannot query field "complexity" on type "Account".`
 *   - `platform_api.daily_limit { base: Int, total: Int }`. For the
 *     probe account (free-tier), both fields read as `200` — i.e.,
 *     200 **operations** per day (not complexity points).
 *     `base` is Monday's plan-baseline allotment; `total` is the
 *     effective limit after any account-specific upgrades; v0.3
 *     surfaces both verbatim so an agent on a paid tier can see the
 *     overage offset.
 *   - `platform_api.daily_analytics { last_updated, by_day, by_app,
 *     by_user }`. `by_day` is `[{ day: String!, usage: Int! }!]`.
 *     `last_updated` is an `ISO8601DateTime` scalar. Empty `by_day`
 *     list on accounts with no recent activity.
 *   - Per-minute complexity points (10M/min on enterprise) are a
 *     SEPARATE Monday quota system already surfaced by v0.1's
 *     `account complexity` (top-level `complexity { before after
 *     query reset_in_x_seconds }`). The v0.3 `monday usage` envelope
 *     intentionally separates the two surfaces: daily operation
 *     count today vs. per-minute complexity. Folding both into one
 *     verb is a v0.4 envelope extension (Decision 8 closure).
 *
 * **Additive-only envelope (Decision 8 closure).** The v0.3 shape
 * pins `{daily_limit, usage_today, usage_remaining_today,
 * last_updated}`. v0.4 may extend with `per_minute_complexity` +
 * `concurrency` blocks WITHOUT breaking the v0.3 surface. Adding
 * fields is non-breaking per cli-design §6.1; removing / renaming
 * is the SemVer-major boundary.
 *
 * **What's stub vs runtime at the pre-flight.** `fetchUsage` ships as
 * a `Promise.reject(internal_error)` stub under `c8 ignore` — M22
 * implementation lands the runtime body alongside the `monday usage`
 * verb's action. The schema definitions, type exports, the
 * `USAGE_QUERY` GraphQL document, and the pure-helper
 * `sumUsageForDay` projection ship as real implementations so the
 * pre-flight Codex review can verify the wire query + projection
 * shape against the empirical probe findings inline.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { MondayClient } from './client.js';
import type { Transport } from './transport.js';

/**
 * The raw `platform_api.daily_limit` shape — Monday GraphQL types
 * `base` and `total` as `Int!`.
 */
export interface RawDailyLimit {
  readonly base: number;
  readonly total: number;
}

/**
 * The raw `platform_api.daily_analytics.by_day[]` entry — Monday
 * GraphQL types `day` as `String!` and `usage` as `Int!`. The
 * `day`-field timezone semantics (UTC vs account-local) are
 * **deferred to M22 implementation kickoff** — the pre-flight probe
 * captured an empty `by_day` list on the test account, so the
 * runtime timezone confirmation requires either an account with
 * usage activity OR a one-off bootstrap call to populate the
 * series before re-probing. Pure projection logic
 * ({@link sumUsageForDay}) treats `day` as an opaque equality key;
 * the caller is responsible for supplying the matching "today"
 * string in the same timezone.
 */
export interface RawDailyAnalyticsByDay {
  readonly day: string;
  readonly usage: number;
}

/**
 * The CLI's projected `monday usage` envelope shape (`data`
 * payload). Additive-only per Decision 8 closure.
 */
export interface UsageOutput {
  readonly daily_limit: RawDailyLimit;
  readonly usage_today: number;
  readonly usage_remaining_today: number;
  readonly last_updated: string;
}

/**
 * `.loose()` so a Monday-side extension field (e.g., a future
 * `peak_usage`) doesn't fail the parse. Forward-compatible
 * widening: extension fields land in a v0.4 amendment that
 * surfaces them.
 */
export const rawDailyLimitSchema = z
  .object({
    base: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  })
  .loose();

export const rawDailyAnalyticsByDaySchema = z
  .object({
    day: z.string().min(1),
    usage: z.number().int().nonnegative(),
  })
  .loose();

export const rawDailyAnalyticsSchema = z
  .object({
    last_updated: z.string().min(1),
    by_day: z.array(rawDailyAnalyticsByDaySchema),
  })
  .loose();

export const usageQueryResponseSchema = z
  .object({
    platform_api: z
      .object({
        daily_limit: rawDailyLimitSchema,
        daily_analytics: rawDailyAnalyticsSchema,
      })
      .loose(),
  })
  .loose();

export type UsageQueryResponse = z.infer<typeof usageQueryResponseSchema>;

/**
 * The GraphQL document `fetchUsage` issues. Surfaces only the v0.3
 * envelope fields — `by_app` + `by_user` (per-app / per-user
 * breakdowns from `daily_analytics`) are intentionally NOT
 * requested so the query stays at the cheapest complexity cost.
 * Per-app / per-user breakdowns become v0.4 surface if an agent
 * needs them (`monday usage --by-app` / `--by-user`).
 */
export const USAGE_QUERY = `query MondayUsage {
  platform_api {
    daily_limit { base total }
    daily_analytics {
      last_updated
      by_day { day usage }
    }
  }
}`;

/**
 * Sums `by_day[].usage` entries whose `day` field equals `today`.
 * Pure helper — no I/O. The caller supplies `today` in whatever
 * format matches Monday's `day` field; the helper does simple
 * string equality.
 *
 * Returns `0` on an empty list (an account with no tracked usage
 * yet — confirmed empirically against the test account at
 * pre-flight probe time).
 */
export const sumUsageForDay = (
  byDay: readonly RawDailyAnalyticsByDay[],
  today: string,
): number => {
  let total = 0;
  for (const entry of byDay) {
    if (entry.day === today) {
      total += entry.usage;
    }
  }
  return total;
};

/**
 * Projects a parsed {@link UsageQueryResponse} + a caller-supplied
 * `today` string into the v0.3 {@link UsageOutput} envelope shape.
 * Pure helper — used by {@link fetchUsage} at M22 implementation
 * and by tests at pre-flight to verify the projection shape against
 * empirical-probe fixtures.
 *
 * `usage_remaining_today` is clamped at zero — Monday's reported
 * `usage` is best-effort and may briefly exceed `daily_limit.total`
 * on a near-cap account (the limit gate is enforced server-side at
 * request time, not per-day-boundary). Surfacing a negative
 * `usage_remaining_today` would mislead agents into thinking they
 * have negative budget; clamp instead.
 */
export const projectUsageOutput = (
  parsed: UsageQueryResponse,
  today: string,
): UsageOutput => {
  const dailyLimit: RawDailyLimit = {
    base: parsed.platform_api.daily_limit.base,
    total: parsed.platform_api.daily_limit.total,
  };
  const usageToday = sumUsageForDay(
    parsed.platform_api.daily_analytics.by_day,
    today,
  );
  const remaining = Math.max(0, dailyLimit.total - usageToday);
  return {
    daily_limit: dailyLimit,
    usage_today: usageToday,
    usage_remaining_today: remaining,
    last_updated: parsed.platform_api.daily_analytics.last_updated,
  };
};

/**
 * Inputs to {@link fetchUsage}. The pre-flight pins the shape so M22
 * implementation just fills in the body. `today` is supplied by the
 * caller so the helper stays pure — the command action reads the
 * runtime clock once and threads the formatted string through.
 */
export interface FetchUsageInputs {
  readonly transport: Transport;
  readonly today: string;
  readonly signal?: AbortSignal;
}

/**
 * Issues the {@link USAGE_QUERY} via `transport`, parses the response
 * through {@link usageQueryResponseSchema}, and projects via
 * {@link projectUsageOutput}.
 *
 * Throws `ApiError('internal_error')` with `details.issues` when the
 * response doesn't match the empirical-probe-pinned shape — a parse
 * failure means Monday changed the `platform_api` surface, which is
 * a v0.3.x amendment (not a routine failure).
 *
 * The `today` string is opaque equality-key for `by_day[].day`
 * matching; the caller picks the format that matches Monday's
 * runtime `day` field. The pre-flight probe captured an empty
 * `by_day` list on the test account so the timezone semantics
 * (UTC vs account-local) are confirmed at impl kickoff against an
 * account with live activity.
 */
export const fetchUsage = async (
  inputs: FetchUsageInputs,
): Promise<UsageOutput> => {
  // Per-call client construction — `MondayClient` requires a `signal`
  // for cooperative cancellation; production threads `ctx.signal`
  // through. retries=0 because the auth probe is idempotent and the
  // command-level retry policy doesn't apply to a usage read (one
  // GraphQL call, no side effects). verbose=false because the
  // `meta.complexity` budget for a `monday usage` call is itself
  // best-effort meta — surfacing it via --verbose would re-trigger
  // the GraphQL `complexity` budget the verb is reporting on.
  const client = new MondayClient({
    transport: inputs.transport,
    signal: inputs.signal ?? new AbortController().signal,
    retries: 0,
    verbose: false,
  });
  const response = await client.raw<unknown>(USAGE_QUERY, undefined, {
    operationName: 'MondayUsage',
  });
  const parsed = usageQueryResponseSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new ApiError(
      'internal_error',
      'Monday usage response did not match the expected `platform_api` shape',
      {
        cause: parsed.error,
        details: {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
          hint: 'Monday may have amended the `platform_api.daily_*` surface — re-probe via `scripts/probe/m22-usage-by-day.ts` and amend cli-design §11.5.3 if so',
        },
      },
    );
  }
  return projectUsageOutput(parsed.data, inputs.today);
};
