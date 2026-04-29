/**
 * `monday account complexity` — emits the current complexity budget
 * (`cli-design.md` §4.3, §2.5).
 *
 * GraphQL operation(s) called:
 *   - `complexity { before, after, query, reset_in_x_seconds }`
 *     (ComplexityProbe — the cheapest possible read on the API)
 *
 * Idempotent: yes — pure read.
 *
 * The output projects Monday's `query`/`after`/`reset_in_x_seconds`
 * onto the CLI's stable `used`/`remaining`/`reset_in_seconds` shape
 * (same fields `meta.complexity` carries on `--verbose`). `before`
 * is also surfaced so an agent that wants the raw budget snapshot
 * can read it without doing the math.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from './client-helper.js';
import { ApiError } from '../../utils/errors.js';

export const accountComplexityOutputSchema = z
  .object({
    before: z.number().int().nonnegative(),
    used: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    reset_in_seconds: z.number().int().nonnegative(),
  })
  .strict();

export type AccountComplexityOutput = z.infer<typeof accountComplexityOutputSchema>;

const inputSchema = z.object({}).strict();

export const accountComplexityCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AccountComplexityOutput
> = {
  name: 'account.complexity',
  summary: 'Show the current Monday complexity budget',
  examples: [
    'monday account complexity',
    'monday account complexity --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: accountComplexityOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'account', 'Account commands');
    noun
      .command('complexity')
      .description(accountComplexityCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...accountComplexityCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        accountComplexityCommand.inputSchema.parse(opts);
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await client.complexityProbe();
        const c = result.data.complexity;
        if (c === null) {
          throw new ApiError(
            'internal_error',
            'Monday returned no complexity block on the probe query',
          );
        }
        emitSuccess({
          ctx,
          data: {
            before: c.before,
            used: c.query,
            remaining: c.after,
            reset_in_seconds: c.reset_in_x_seconds,
          },
          schema: accountComplexityCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
