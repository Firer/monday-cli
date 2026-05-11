/**
 * `monday usage` — rolling daily Monday API operation-budget remaining
 * (cli-design §11.5 / §13 v0.3 entry; v0.3-plan §3 M22).
 *
 * **The verb's question:** "have I burned through my daily budget?"
 * Returns the rolling daily Monday API **operation** budget remaining
 * so an agent can self-throttle before fanning out a bulk operation.
 *
 * **Empirical-probe finding pinned (2026-05-10, API `2026-01`).** The
 * "daily budget" surface is `platform_api.daily_limit { base total }`
 * + `platform_api.daily_analytics.by_day [{day, usage}]` — Monday
 * tracks **operations per day** (200/day on free tier), NOT
 * complexity points. The pre-M22 cli-design §13 wording
 * ("rolling 24h API complexity budget remaining") conflated two
 * separate Monday quota systems; the M22 pre-flight reshape pins the
 * accurate envelope shape (operations) per Decision 8 closure. See
 * `src/api/usage.ts` for the load-bearing probe-finding docstring.
 *
 * **Envelope is additive-only (Decision 8 closure).** v0.3 ships
 * `{daily_limit, usage_today, usage_remaining_today, last_updated}`;
 * v0.4 may extend with per-minute complexity + concurrency-cap
 * blocks without breaking. Per cli-design §6.1: adding fields is
 * non-breaking; removing / renaming is the SemVer-major boundary.
 *
 * **`today` timezone semantics.** The pre-flight probe captured an
 * empty `by_day` list on the test account, deferring the timezone
 * pin (UTC vs account-local) to impl. The runtime threads
 * `ctx.clock().toISOString().slice(0, 10)` (UTC `YYYY-MM-DD`) into
 * `fetchUsage` — Monday's `daily_analytics.by_day[].day` field
 * appears UTC-keyed per the GraphQL `ISO8601DateTime` scalar on the
 * sibling `last_updated`. If Monday's runtime `day` field turns out
 * to be account-local, the timezone gets revised here (cli-design
 * §11.5.3 amendment); `projectUsageOutput` treats `day` as an opaque
 * equality key so the change is local to this action.
 */
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { emitSuccess } from './emit.js';
import { fetchUsage } from '../api/usage.js';
import { resolveClient } from '../api/resolve-client.js';

const inputSchema = z.object({}).strict();

const usageOutputSchema = z
  .object({
    daily_limit: z
      .object({
        base: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    usage_today: z.number().int().nonnegative(),
    usage_remaining_today: z.number().int().nonnegative(),
    last_updated: z.string().min(1),
  })
  .strict();

export type UsageOutput = z.infer<typeof usageOutputSchema>;

/**
 * Formats a `Date` as a UTC `YYYY-MM-DD` string — the format Monday's
 * `daily_analytics.by_day[].day` appears to use per the
 * `ISO8601DateTime` scalar on the sibling `last_updated` field. Pure
 * helper exported so tests can drive it without re-deriving.
 */
export const formatTodayKey = (now: Date): string =>
  now.toISOString().slice(0, 10);

export const usageCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UsageOutput
> = {
  name: 'usage',
  summary: 'Show the daily Monday API operation budget remaining',
  examples: ['monday usage', 'monday usage --json'],
  idempotent: true,
  inputSchema,
  outputSchema: usageOutputSchema,
  attach: (program, ctx) => {
    program
      .command('usage')
      .description(usageCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...usageCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        usageCommand.inputSchema.parse(opts);
        const resolved = resolveClient(ctx, program.opts());
        const today = formatTodayKey(ctx.clock());
        const usage = await fetchUsage({
          transport: resolved.transport,
          today,
          signal: ctx.signal,
        });

        emitSuccess({
          ctx,
          data: usage,
          schema: usageCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          apiVersion: resolved.apiVersion,
          cacheAgeSeconds: null,
        });
      });
  },
};
