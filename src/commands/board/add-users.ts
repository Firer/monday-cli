/**
 * `monday board add-users <bid> --users <id|email>,... [--dry-run]`
 * — fan-out add subscribers to a board one wire call per user
 * (`cli-design.md` §4.3 line 770, `v0.2-plan.md` §3 M15).
 *
 * **Third partial-success-fan-out consumer** after M14's
 * `workspace add-users` / `workspace remove-users`. The shape
 * mirrors workspace-add-users near-verbatim modulo the wire
 * mutation name + target id field (`board_id` vs `workspace_id`).
 * Per v0.2-plan §22 R40, the shared resolver-fronted-fan-out
 * helper lift fired post-M15 once this third consumer's parameter
 * shape was empirically known — the body now lives in
 * `src/api/users-fan-out-mutation.ts`.
 *
 * **Wire shape.** Each per-user dispatch fires `add_users_to_
 * board(board_id, user_ids: [<single>], kind?: BoardSubscriberKind)`
 * — a one-element `user_ids` array per call. M15 omits the SDK's
 * optional `kind?` argument and relies on Monday's server-side
 * default (subscriber). Owner-tier and explicit subscriber-kind
 * selection deferred to a later milestone (mirrors M14's
 * workspace add-users `kind?: WorkspaceSubscriberKind` decision).
 *
 * **Partial-success envelope** per cli-design §6.4 — emits one
 * `ok: true` envelope with `data: { operation: "add_users_to_
 * board", results: [{user_id, ok, error?}] }`. Per-user
 * resolution failures (`user_not_found`) AND per-user dispatch
 * failures land per-record. Whole-call boundary: `user_not_found`
 * (exit 2) when no dispatchable user_id remains; `usage_error`
 * (exit 1) for malformed `--users` syntax.
 *
 * **`meta.source` aggregation.** Same rule as workspace add-
 * users (cli-design §6.4 partial-success aggregation table).
 * Dry-run sees only resolver legs (numeric-only → 'none', cache
 * → 'cache', live → 'live', combos → 'mixed'). Live folds in
 * every per-target dispatch leg (always 'live') on top.
 *
 * **Idempotent: yes** — Monday is no-op on a re-add. Not
 * destructive (no --yes gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  dispatchUsersFanOut,
  parseUsersArg,
} from '../../api/users-fan-out-mutation.js';

const ADD_USERS_TO_BOARD_MUTATION = `
  mutation BoardAddUsers($boardId: ID!, $userIds: [ID!]!) {
    add_users_to_board(board_id: $boardId, user_ids: $userIds) {
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

export const boardAddUsersOutputSchema = z
  .object({
    operation: z.literal('add_users_to_board'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type BoardAddUsersOutput = z.infer<typeof boardAddUsersOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    users: z.string().min(1, '--users must not be empty'),
  })
  .strict();

export const boardAddUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardAddUsersOutput
> = {
  name: 'board.add-users',
  summary: 'Add users to a board as subscribers (partial-success envelope)',
  examples: [
    'monday board add-users 12345 --users 67890,67891',
    'monday board add-users 12345 --users alice@example.test,67891',
    'monday board add-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-adding an existing member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: boardAddUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('add-users <boardId>')
      .description(boardAddUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardAddUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardAddUsersCommand.inputSchema, {
          boardId,
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
            id: parsed.boardId,
            key: 'board_id',
            variableKey: 'boardId',
          },
          mutation: {
            query: ADD_USERS_TO_BOARD_MUTATION,
            operationName: 'BoardAddUsers',
            rootKey: 'add_users_to_board',
          },
          dataOperation: 'add_users_to_board',
          verbDescription: 'board add-users',
          outputSchema: boardAddUsersOutputSchema,
        });
      });
  },
};
