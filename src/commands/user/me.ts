/**
 * `monday user me` — alias for `monday account whoami`
 * (`cli-design.md` §4.3).
 *
 * Two routes to the same query so agent-flavoured workflows reading
 * the §13 v0.3 dev-namespace's "tasks assigned to me" don't have to
 * remember which noun the identity sits under.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError } from '../../utils/errors.js';
import { whoamiOutputSchema, type WhoamiOutput } from '../account/whoami.js';
import { parseArgv } from '../parse-argv.js';

const inputSchema = z.object({}).strict();

export const userMeCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WhoamiOutput
> = {
  name: 'user.me',
  summary: 'Show the connected user (alias for account whoami)',
  examples: ['monday user me', 'monday user me --json'],
  idempotent: true,
  inputSchema,
  outputSchema: whoamiOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('me')
      .description(userMeCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...userMeCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        parseArgv(userMeCommand.inputSchema, opts);
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const result = await client.whoami();
        if (result.data.me === null) {
          throw new ApiError(
            'unauthorized',
            'Monday returned no `me` for the supplied token (guest or disabled account?)',
          );
        }
        emitSuccess({
          ctx,
          data: result.data,
          schema: userMeCommand.outputSchema,
          programOpts: program.opts(),
          ...toEmit(result),
        });
      });
  },
};
