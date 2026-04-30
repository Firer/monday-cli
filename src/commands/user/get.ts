/**
 * `monday user get <uid>` — single user by ID (`cli-design.md` §4.3).
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { runByIdLookup } from '../run-by-id-lookup.js';
import { UserIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const USER_GET_QUERY = `
  query UserGet($ids: [ID!]) {
    users(ids: $ids) {
      id
      name
      email
      enabled
      is_guest
      is_admin
      is_view_only
      is_pending
      is_verified
      title
      time_zone_identifier
      join_date
      last_activity
      url
      country_code
    }
  }
`;

export const userGetOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
    enabled: z.boolean(),
    is_guest: z.boolean().nullable(),
    is_admin: z.boolean().nullable(),
    is_view_only: z.boolean().nullable(),
    is_pending: z.boolean().nullable(),
    is_verified: z.boolean().nullable(),
    title: z.string().nullable(),
    time_zone_identifier: z.string().nullable(),
    join_date: z.string().nullable(),
    last_activity: z.string().nullable(),
    url: z.string().nullable(),
    country_code: z.string().nullable(),
  })
  .strict();

export type UserGetOutput = z.infer<typeof userGetOutputSchema>;

const inputSchema = z.object({ userId: UserIdSchema }).strict();

export const userGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UserGetOutput
> = {
  name: 'user.get',
  summary: 'Show one user by ID',
  examples: ['monday user get 12345', 'monday user get 12345 --json'],
  idempotent: true,
  inputSchema,
  outputSchema: userGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('get <userId>')
      .description(userGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...userGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (userId: unknown) => {
        const parsed = parseArgv(userGetCommand.inputSchema, { userId });
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: USER_GET_QUERY,
          operationName: 'UserGet',
          collectionKey: 'users',
          id: parsed.userId,
          errorDetailKey: 'user_id',
          kind: 'user',
          schema: userGetCommand.outputSchema,
        });
      });
  },
};
