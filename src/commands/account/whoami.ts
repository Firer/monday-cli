/**
 * `monday account whoami` — emits the connected user + their account
 * (`cli-design.md` §4.3, §6.2).
 *
 * GraphQL operation(s) called:
 *   - `me { id, name, email, account { id, name, slug } }` (Whoami)
 *
 * Idempotent: yes — pure read.
 *
 * The output schema is the smaller, projected shape the design
 * documents. The SDK's full `User` type carries ~30 fields; we surface
 * only the ones an agent needs to identify itself + correlate against
 * Monday's UI. Adding fields later is a non-breaking schema_version=1
 * change; renaming is breaking.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from './client-helper.js';
import { ApiError } from '../../utils/errors.js';

const accountSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string().nullable(),
  })
  .strict();

export const whoamiOutputSchema = z
  .object({
    me: z
      .object({
        id: z.string().min(1),
        name: z.string(),
        email: z.string(),
        account: accountSchema,
      })
      .strict(),
  })
  .strict();

export type WhoamiOutput = z.infer<typeof whoamiOutputSchema>;

const inputSchema = z.object({}).strict();

export const accountWhoamiCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WhoamiOutput
> = {
  name: 'account.whoami',
  summary: 'Show the connected user and their account',
  examples: [
    'monday account whoami',
    'monday account whoami --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: whoamiOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'account', 'Account commands');
    noun
      .command('whoami')
      .description(accountWhoamiCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...accountWhoamiCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        accountWhoamiCommand.inputSchema.parse(opts);
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await client.whoami();
        if (result.data.me === null) {
          // Monday returns `me: null` when the token is valid but
          // belongs to a guest / disabled user — surface as
          // `unauthorized` so agents handle it the same way.
          throw new ApiError(
            'unauthorized',
            'Monday returned no `me` for the supplied token (guest or disabled account?)',
          );
        }
        emitSuccess({
          ctx,
          data: result.data,
          schema: accountWhoamiCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
