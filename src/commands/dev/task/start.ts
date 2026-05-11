/**
 * `monday dev task start <iid>` — set a task's status to
 * "Working on it" on the configured tasks board (cli-design §4.3
 * + §5.9; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `tasks_board`, resolve
 * the canonical "Working on it" label via cached `board describe`
 * metadata, and route through `executeItemMutation` (M25-prep
 * R-NEW-29 lift in `src/api/item-mutation-execute.ts`) with the
 * `change_simple_column_value` mutation against the status column.
 *
 * **Convention, not API.** This verb is pure convenience —
 * equivalent to `monday item update <iid> --board <tasks_board>
 * --set status="Working on it"`. The `dev` namespace's value is
 * naming the workflow concept (`task start`) over the CRUD
 * primitive (`item update --set status=...`).
 *
 * Idempotent: yes (re-running against an already-started task is
 * a no-op — Monday's `change_simple_column_value` is idempotent
 * on equal values).
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
  })
  .strict();

export const devTaskStartCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.task.start',
  summary: 'Set a task\'s status to "Working on it" on the configured tasks board',
  examples: [
    'monday dev task start 12345678',
    'monday dev task start 12345678 --json',
  ],
  idempotent: true,
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
      .command('start <itemId>')
      .description(devTaskStartCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devTaskStartCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (itemIdArg: unknown) => {
          parseArgv(devTaskStartCommand.inputSchema, {
            itemId: itemIdArg,
          });
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev task start not yet implemented (v0.3-M26 pre-flight stub)',
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
