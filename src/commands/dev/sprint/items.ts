/**
 * `monday dev sprint items <sid>` — list the task items linked to
 * a named sprint (cli-design §4.3 + §5.9; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `tasks_board` + read
 * the configured sprint→task `board_relation` column ID (probed
 * at `dev doctor`'s `tasks_to_sprints_relation` check), then
 * page through tasks filtered by the relation. Surfaces the
 * tasks as `ProjectedItem` rows.
 *
 * **<sid> resolution.** Positional sprint ID is an item ID on the
 * sprints board (sprints are items, not first-class entities).
 * Validated via `ItemIdSchema` — invalid IDs surface
 * `usage_error` at the parse boundary.
 *
 * Idempotent: yes (pure read).
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
    sprintId: ItemIdSchema,
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devSprintItemsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.sprint.items',
  summary: 'List task items linked to a named sprint via the board_relation column',
  examples: [
    'monday dev sprint items 12345678',
    'monday dev sprint items 12345678 --json',
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
    const sprint = ensureSubcommand(
      dev,
      'sprint',
      'Sprint workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    sprint
      .command('items <sprintId>')
      .description(devSprintItemsCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintItemsCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (sprintIdArg: unknown) => {
          parseArgv(devSprintItemsCommand.inputSchema, {
            sprintId: sprintIdArg,
          });
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev sprint items not yet implemented (v0.3-M26 pre-flight stub)',
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
