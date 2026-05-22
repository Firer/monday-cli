/**
 * `monday workspace remove-users <wid> --users <id|email>,...
 * [--dry-run]` — fan-out remove subscribers from a workspace one
 * wire call per user (`cli-design.md` §4.3 line 529, `v0.2-plan.md`
 * §3 M14).
 *
 * **Mirrors `workspace add-users` exactly** modulo the operation
 * (`delete_users_from_workspace` rather than
 * `add_users_to_workspace`) and the dispatch mutation. Same fan-
 * out semantics (one wire call per user); same `--users` parser
 * (numeric argv-derived, email through `userByEmail`); same
 * partial-success envelope including `data.operation`; same
 * `meta.source` aggregation rule (dry-run sees only resolver legs;
 * live folds in every per-target dispatch leg too); same whole-
 * call boundary (`user_not_found` when no dispatchable id remains;
 * `usage_error` for malformed `--users` syntax).
 *
 * **Idempotent: yes** — Monday is no-op on re-removing a non-
 * member. **Admin-permission-sensitive**.
 *
 * **R40 lift (post-M15).** The token parser, resolver loop,
 * dispatch loop, and envelope assembly live in
 * `src/api/users-fan-out-mutation.ts` — three M14 / M15 verbs
 * (workspace add-users / workspace remove-users / board add-users)
 * share the body modulo six per-verb parameters.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  dispatchUsersFanOut,
  parseUsersArg,
} from '../../api/users-fan-out-mutation.js';

const REMOVE_USERS_FROM_WORKSPACE_MUTATION = `
  mutation WorkspaceRemoveUsers($workspaceId: ID!, $userIds: [ID!]!) {
    delete_users_from_workspace(workspace_id: $workspaceId, user_ids: $userIds) {
      id
    }
  }
`;

const errorShape = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const liveResultRecordSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const workspaceRemoveUsersOutputSchema = z
  .object({
    operation: z.literal('delete_users_from_workspace'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type WorkspaceRemoveUsersOutput = z.infer<
  typeof workspaceRemoveUsersOutputSchema
>;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    users: z
      .string()
      .min(1, '--users must not be empty'),
  })
  .strict();

export const workspaceRemoveUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceRemoveUsersOutput
> = {
  name: 'workspace.remove-users',
  summary: 'Remove users from a workspace (partial-success envelope)',
  examples: [
    'monday workspace remove-users 12345 --users 67890,67891',
    'monday workspace remove-users 12345 --users alice@example.test,67891',
    'monday workspace remove-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-removing a non-member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: workspaceRemoveUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace');
    noun
      .command('remove-users <workspaceId>')
      .description(workspaceRemoveUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceRemoveUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceRemoveUsersCommand.inputSchema, {
          workspaceId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        // parseUsersArg runs BEFORE resolveClient so a malformed
        // `--users` surfaces as usage_error (exit 1) ahead of any
        // missing-token config_error (exit 3).
        const tokens = parseUsersArg(parsed.users);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        await dispatchUsersFanOut({
          client,
          ctx,
          programOpts: program.opts(),
          globalFlags,
          apiVersion,
          toEmit,
          tokens,
          scope: {
            id: parsed.workspaceId,
            key: 'workspace_id',
            variableKey: 'workspaceId',
          },
          mutation: {
            query: REMOVE_USERS_FROM_WORKSPACE_MUTATION,
            operationName: 'WorkspaceRemoveUsers',
            rootKey: 'delete_users_from_workspace',
          },
          dataOperation: 'delete_users_from_workspace',
          verbDescription: 'workspace remove-users',
          outputSchema: workspaceRemoveUsersOutputSchema,
        });
      });
  },
};
