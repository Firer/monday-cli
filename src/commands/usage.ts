/**
 * `monday usage` — rolling daily Monday API operation-budget remaining
 * (cli-design §11.5 / §13 v0.3 entry; v0.3-plan §3 M22).
 *
 * **v0.3-M22 pre-flight stub.** Registered for forward-compatibility
 * (agent scripts targeting `monday usage` are stable across the M22
 * implementation drop) and rejects every invocation today with
 * `internal_error` carrying the M22-pending hint. The argv shape
 * (no flags beyond globals) is the final shape M22 implementation
 * ships against; only the action body changes.
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
 * **What lands at M22 implementation:**
 *   - Read the runtime clock once, format `today` against Monday's
 *     `day`-field timezone (M22 implementation pins this against an
 *     account with real usage data).
 *   - Issue {@link import('../api/usage.js').USAGE_QUERY} via the
 *     resolved transport.
 *   - Parse + project via {@link import('../api/usage.js').projectUsageOutput}.
 *   - Emit the success envelope per §6.1.
 */
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { ApiError } from '../utils/errors.js';

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

export const usageCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UsageOutput
> = {
  name: 'usage',
  summary:
    'Show the daily Monday API operation budget remaining (v0.3-M22 pre-flight stub — runtime body lands at M22 implementation)',
  examples: ['monday usage', 'monday usage --json'],
  idempotent: true,
  inputSchema,
  outputSchema: usageOutputSchema,
  attach: (program) => {
    program
      .command('usage')
      .description(usageCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...usageCommand.examples.map((e) => `  ${e}`),
          '',
          'NOTE: Pre-flight stub — runtime body lands at v0.3-M22',
          'implementation. The verb registers the argv shape so agent',
          'scripts targeting `monday usage` are stable across the drop-in.',
          '',
        ].join('\n'),
      )
      // The action is async even though the body is synchronous —
      // commander routes async-rejection-shaped errors through to
      // the runner's catch-all envelope mapper, while sync throws
      // can be swallowed by commander's own error path. Mirrors the
      // M20 time-track + M21 pre-flight auth-stub async-action pattern.
      .action(async (opts: unknown) => {
        usageCommand.inputSchema.parse(opts);
        // Pre-flight stub — every invocation rejects. M22
        // implementation replaces this with the real `fetchUsage`
        // call per cli-design §11.5 / §13 v0.3.
        await Promise.reject(
          new ApiError(
            'internal_error',
            '`monday usage` is a v0.3-M22 pre-flight stub — runtime body lands at M22 implementation alongside `fetchUsage` in `src/api/usage.ts`.',
            {
              details: {
                hint: 'M22 implementation kickoff lands the runtime body alongside the `platform_api.daily_limit` + `daily_analytics.by_day` GraphQL projection.',
              },
            },
          ),
        );
      });
  },
};
