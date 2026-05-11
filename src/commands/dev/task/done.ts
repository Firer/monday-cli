/**
 * `monday dev task done <iid> [--message <m>]` — set a task's
 * status to "Done" + optionally post a completion comment on the
 * configured tasks board (cli-design §4.3 + §5.9; v0.3-plan §3
 * M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `tasks_board`, route
 * the status change through `executeItemMutation`, and — when
 * `--message <m>` is supplied — additionally fire `update create`
 * against the item with the message body. The two side-effects
 * are surfaced as `data` (the post-mutation `ProjectedItem`) +
 * the top-level `side_effects` mutation-envelope slot per
 * `src/utils/output/envelope.ts:99-117` (the `update_created`
 * entry carries the new update's ID; round-2 Codex P2-4 fix —
 * `side_effects` sits at envelope top-level, NOT under `meta`).
 *
 * **Idempotency caveat.** The status flip is idempotent (same as
 * `task start`); the optional `--message` post-create is NOT — a
 * re-run with `--message` posts a second comment. Document this
 * in `--help` so agents calling on retry loops know to omit
 * `--message` on retries.
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { ItemIdSchema } from '../../../types/ids.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    message: z.string().min(1).optional(),
  })
  .strict();

export const devTaskDoneCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.done',
  summary:
    'Set a task\'s status to "Done" on the configured tasks board (optionally post a completion comment)',
  examples: [
    'monday dev task done 12345678',
    'monday dev task done 12345678 --message "Shipped in v0.3.0"',
    'monday dev task done 12345678 --json',
  ],
  // The status flip is idempotent; the optional `--message` post
  // is NOT (see docstring). Marked false at the schema layer so
  // `monday schema` reflects the worst-case for agent retry
  // logic.
  idempotent: false,
  inputSchema,
  outputSchema: projectedItemSchema,
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
      .command('done <itemId>')
      .description(devTaskDoneCommand.summary)
      .option(
        '--message <m>',
        'Post a completion comment alongside the status change. Re-runs with --message post additional comments — omit on retries.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskDoneCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (itemIdArg: unknown, opts: { message?: string }) => {
          parseArgv(devTaskDoneCommand.inputSchema, {
            itemId: itemIdArg,
            ...(opts.message !== undefined ? { message: opts.message } : {}),
          });
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev task done not yet implemented (v0.3-M26 pre-flight stub)',
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
