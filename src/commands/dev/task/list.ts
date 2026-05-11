/**
 * `monday dev task list [--mine] [--status not_done]
 *  [--sprint current]` — list tasks on the configured tasks
 * board (cli-design §4.3 + §5.9; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `tasks_board`, build
 * an items_page filter from the supplied flags, and walk. The
 * filter composition:
 *
 *   - `--mine` → adds `assigned_to_user_id = me` (resolves through
 *     the existing `me` token resolver per M3).
 *   - `--status not_done` → adds `status NOT IN (Done, Cancelled)`
 *     via the friendly status filter.
 *   - `--sprint current` → resolves `dev sprint current` first +
 *     adds the configured sprint→task `board_relation` filter.
 *     `--sprint <sid>` (numeric) is also accepted.
 *
 * **Mutual exclusion: `--sprint <sid>` and `--sprint current`
 * cannot both be supplied** — argv-parse-time validation rejects
 * the conflict via `usage_error` with structured `details.issues`.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const TASK_STATUS_LITERALS = ['not_done', 'done', 'stuck', 'working_on_it'] as const;
export type TaskStatusFilter = (typeof TASK_STATUS_LITERALS)[number];

/**
 * `--sprint` accepts the literal `current` token (resolved via
 * `dev sprint current`) or a numeric sprint item ID. The schema
 * normalises both forms via z.union — runtime body branches on the
 * literal vs ID shape.
 */
const sprintFilterSchema = z.union([
  z.literal('current'),
  z.string().regex(/^\d+$/u, { message: '--sprint must be `current` or a numeric sprint ID' }),
]);

const inputSchema = z
  .object({
    mine: z.boolean().optional(),
    status: z.enum(TASK_STATUS_LITERALS).optional(),
    sprint: sprintFilterSchema.optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devTaskListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.task.list',
  summary:
    'List tasks on the configured tasks board (filter by --mine, --status, --sprint)',
  examples: [
    'monday dev task list',
    'monday dev task list --mine',
    'monday dev task list --status not_done --sprint current',
    'monday dev task list --sprint 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema,
  attach: (program) => {
    const dev = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (cli-design §2.7 — convention, not API)',
    );
    const task = ensureSubcommand(
      dev,
      'task',
      'Task workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    task
      .command('list')
      .description(devTaskListCommand.summary)
      .option(
        '--mine',
        'Restrict to tasks assigned to the connected user (resolved via the `me` token).',
      )
      .option(
        '--status <status>',
        'Filter by status: not_done | done | stuck | working_on_it. `not_done` is the agent-flow default for "tasks I still need to handle".',
      )
      .option(
        '--sprint <sprintIdOrCurrent>',
        'Filter to tasks in a specific sprint. Accepts the literal `current` (resolves via `monday dev sprint current`) or a numeric sprint item ID.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devTaskListCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev task list not yet implemented (v0.3-M26 pre-flight stub)',
            {
              details: {
                hint: 'M26 implementation lands the runtime body; see docs/v0.3-plan.md §3 M26',
              },
            },
          ));
        },
        /* c8 ignore stop */
      );
  },
};
