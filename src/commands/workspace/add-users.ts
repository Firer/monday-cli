/**
 * `monday workspace add-users <wid> --users <id|email>,... [--dry-run]`
 * — fan-out add subscribers to a workspace one wire call per user
 * (`cli-design.md` §4.3 line 498, `v0.2-plan.md` §3 M14).
 *
 * **Wire shape.** Each per-user dispatch fires `add_users_to_
 * workspace(workspace_id, user_ids: [<single>])` — a one-element
 * `user_ids` array per call. M14 omits the SDK's optional `kind?:
 * WorkspaceSubscriberKind` argument and relies on Monday's server-
 * side default (subscriber). Owner-tier and explicit subscriber-
 * kind selection are deferred to a later milestone (no v0.2
 * surface decision blocking M14).
 *
 * **`--users` parser.** Comma-separated list mixing numeric IDs
 * and emails. Numeric IDs are argv-derived (skip the resolver
 * entirely); only email tokens flow through M5a's `userByEmail`
 * (directory cache + `users(emails:)` fallback). Tokens that are
 * neither numeric nor email-shaped surface as `usage_error` at
 * argv-parse, before any network leg.
 *
 * **Partial-success envelope** per cli-design §6.4 — emits one
 * `ok: true` envelope with `data: { operation: "add_users_to_
 * workspace", results: [{user_id, ok, error?}] }`. Per-user
 * resolution failures (`user_not_found`) AND per-user dispatch
 * failures land in the per-record `error` slot rather than
 * aborting the loop; on a resolution failure `user_id` carries
 * the input token verbatim so agents can correlate retries
 * against their `--users` argument.
 *
 * **Whole-call boundary.** Top-level `error` reserved for whole-
 * call failure: couldn't reach API, OR no dispatchable user_id
 * remains after parsing/resolution (every supplied token was an
 * email AND every email failed lookup). The whole-call code is
 * **`user_not_found`** (exit 2) carrying `details.failed_tokens:
 * [...]`. Mixed calls with even one numeric ID OR one resolved
 * email stay partial-success — failed-resolution records land
 * per-record. Malformed `--users` syntax (blank/non-numeric-non-
 * email) → `usage_error` (exit 1) at argv-parse.
 *
 * **`meta.source` aggregation.** Splits dry-run vs live (cli-
 * design §6.4 partial-success-envelope rule). Dry-run sees only
 * resolver legs (all-numeric → `none`; cache → `cache`; live
 * `users(emails:)` → `live`; combos → `mixed`). Live folds in
 * every per-target mutation dispatch leg too (always `live`),
 * so all-numeric live aggregates to `live` (not `none`).
 *
 * **Idempotent: yes** — Monday is no-op on a re-add. **Admin-
 * permission-sensitive**.
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

const ADD_USERS_TO_WORKSPACE_MUTATION = `
  mutation WorkspaceAddUsers($workspaceId: ID!, $userIds: [ID!]!) {
    add_users_to_workspace(workspace_id: $workspaceId, user_ids: $userIds) {
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

// Live-envelope per-record shape. `user_id` is plain `string` (not
// branded) because resolution failures preserve the input token
// verbatim — emails aren't valid `UserId` values.
const liveResultRecordSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const workspaceAddUsersOutputSchema = z
  .object({
    operation: z.literal('add_users_to_workspace'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type WorkspaceAddUsersOutput = z.infer<typeof workspaceAddUsersOutputSchema>;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    users: z
      .string()
      .min(1, '--users must not be empty'),
  })
  .strict();

export const workspaceAddUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceAddUsersOutput
> = {
  name: 'workspace.add-users',
  summary: 'Add users to a workspace as subscribers (partial-success envelope)',
  examples: [
    'monday workspace add-users 12345 --users 67890,67891',
    'monday workspace add-users 12345 --users alice@example.test,67891',
    'monday workspace add-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-adding an existing member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: workspaceAddUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('add-users <workspaceId>')
      .description(workspaceAddUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceAddUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceAddUsersCommand.inputSchema, {
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
            query: ADD_USERS_TO_WORKSPACE_MUTATION,
            operationName: 'WorkspaceAddUsers',
            rootKey: 'add_users_to_workspace',
          },
          dataOperation: 'add_users_to_workspace',
          verbDescription: 'workspace add-users',
          outputSchema: workspaceAddUsersOutputSchema,
        });
      });
  },
};
