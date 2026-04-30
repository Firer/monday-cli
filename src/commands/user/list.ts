/**
 * `monday user list` — list users in the account (`cli-design.md` §4.3).
 *
 * GraphQL: `users(limit:, page:, kind:, name:, emails:)`. Page-based.
 *
 * `--kind` accepts `all`, `guests`, `non_guests` per the design (the
 * SDK enum's `UserKind` matches). `--name` and `--email` are
 * server-side filters when present.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UsageError } from '../../utils/errors.js';
import { parseArgv } from '../parse-argv.js';
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

const USER_LIST_QUERY = `
  query UserList(
    $limit: Int
    $page: Int
    $kind: UserKind
    $name: String
    $emails: [String]
  ) {
    users(
      limit: $limit
      page: $page
      kind: $kind
      name: $name
      emails: $emails
    ) {
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
    }
  }
`;

const userSchema = z
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
  })
  .strict();

export type UserListEntry = z.infer<typeof userSchema>;

export const userListOutputSchema = z.array(userSchema);
export type UserListOutput = z.infer<typeof userListOutputSchema>;

const inputSchema = z
  .object({
    name: z.string().min(1).optional(),
    email: z.string().min(1).optional(),
    kind: z.enum(['all', 'guests', 'non_guests']).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
    limitPages: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

interface RawUsers {
  readonly users: readonly unknown[] | null;
}

export const userListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UserListOutput
> = {
  name: 'user.list',
  summary: 'List users in the account',
  examples: [
    'monday user list',
    'monday user list --email alice@example.com --json',
    'monday user list --kind guests',
    'monday user list --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: userListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'user', 'User commands');
    noun
      .command('list')
      .description(userListCommand.summary)
      .option('--name <n>', 'filter by name (server-side)')
      .option('--email <e>', 'filter by exact email (server-side)')
      .option('--kind <k>', 'all|guests|non_guests')
      .option('--limit <n>', 'page size (1-100, default 25)')
      .option('--page <n>', '1-indexed page')
      .option('--all', 'walk every page')
      .option(
        '--limit-pages <n>',
        `max pages under --all (1-500, default ${String(DEFAULT_MAX_PAGES)})`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...userListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(userListCommand.inputSchema, opts);
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const limit = parsed.limit ?? 25;
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        const result = await walkPages<unknown, RawUsers>({
          fetchPage: (page) => {
            const variables: Record<string, unknown> = { limit, page };
            if (parsed.kind !== undefined) variables.kind = parsed.kind;
            if (parsed.name !== undefined) variables.name = parsed.name;
            if (parsed.email !== undefined) variables.emails = [parsed.email];
            return client.raw<RawUsers>(USER_LIST_QUERY, variables, {
              operationName: 'UserList',
            });
          },
          extractItems: (r) => r.data.users ?? [],
          pageSize: limit,
          all: parsed.all === true,
          startPage: parsed.page ?? 1,
          maxPages,
        });
        const warnings: Warning[] = [];
        if (parsed.all === true && result.hasMore) {
          warnings.push(buildCapWarning(result.pagesFetched));
        }

        emitSuccess({
          ctx,
          data: userListCommand.outputSchema.parse(result.items),
          schema: userListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: result.hasMore,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
