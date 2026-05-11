/**
 * `monday dev task block <iid> --reason <r>` — set a task's
 * status to "Stuck" + post the blocking reason as a comment on
 * the configured tasks board (cli-design §4.3 + §5.9; v0.3-plan
 * §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `tasks_board`, route
 * the status change to "Stuck" via `executeItemMutation`, then
 * fire `update create` with the supplied `--reason <r>` body. The
 * two side-effects are surfaced in `data` (post-mutation
 * `ProjectedItem`) + `meta.side_effects` (`update_created` entry).
 *
 * **`--reason` is required.** Unlike `task done`'s optional
 * `--message`, blocking ALWAYS posts a comment with the reason —
 * the audit trail is the load-bearing value of `task block` over
 * a bare status flip. Argv-parse-time validation rejects missing
 * `--reason` via `usage_error`.
 *
 * **Idempotency caveat.** The status flip is idempotent; the
 * `update create` post is NOT — re-runs post additional comments.
 * Document in `--help` so agents on retry loops handle accordingly.
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
    reason: z.string().min(1),
  })
  .strict();

export const devTaskBlockCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.block',
  summary:
    'Set a task\'s status to "Stuck" + post the blocking reason as a comment on the configured tasks board',
  examples: [
    'monday dev task block 12345678 --reason "Waiting on legal review"',
    'monday dev task block 12345678 --reason "API rate limit until tomorrow" --json',
  ],
  // status flip idempotent; `update create` is NOT (see docstring).
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
      .command('block <itemId>')
      .description(devTaskBlockCommand.summary)
      .requiredOption(
        '--reason <r>',
        'Blocking reason posted as a comment on the task. Required — the audit trail is the load-bearing value of `task block` over a bare status flip.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskBlockCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (itemIdArg: unknown, opts: { reason: string }) => {
          parseArgv(devTaskBlockCommand.inputSchema, {
            itemId: itemIdArg,
            reason: opts.reason,
          });
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev task block not yet implemented (v0.3-M26 pre-flight stub)',
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
