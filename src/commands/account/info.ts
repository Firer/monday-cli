/**
 * `monday account info` — emits account-level info (`cli-design.md`
 * §4.3).
 *
 * GraphQL operation(s) called:
 *   - `account { id, name, slug, country_code, first_day_of_the_week,
 *               active_members_count, logo, plan { ... } }`
 *
 * Idempotent: yes — pure read.
 *
 * Plan limits (max_users, tier, period) are surfaced because agents
 * planning bulk writes use them to size their work — `pro` accounts
 * have higher complexity budgets and concurrency caps than `free`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError } from '../../utils/errors.js';

const planSchema = z
  .object({
    version: z.number().int(),
    tier: z.string(),
    max_users: z.number().int(),
    period: z.string().nullable(),
  })
  .strict();

export const accountInfoOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string().nullable(),
    country_code: z.string().nullable(),
    first_day_of_the_week: z.string().nullable(),
    active_members_count: z.number().int().nullable(),
    logo: z.string().nullable(),
    plan: planSchema.nullable(),
  })
  .strict();

export type AccountInfoOutput = z.infer<typeof accountInfoOutputSchema>;

const inputSchema = z.object({}).strict();

export const accountInfoCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AccountInfoOutput
> = {
  name: 'account.info',
  summary: 'Show account name, slug, plan, and member count',
  examples: [
    'monday account info',
    'monday account info --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: accountInfoOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'account', 'Account commands');
    noun
      .command('info')
      .description(accountInfoCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...accountInfoCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        accountInfoCommand.inputSchema.parse(opts);
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await client.account();
        if (result.data.account === null) {
          throw new ApiError(
            'not_found',
            'Monday returned no account for the supplied token',
          );
        }
        emitSuccess({
          ctx,
          data: result.data.account,
          schema: accountInfoCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
