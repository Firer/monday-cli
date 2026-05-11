/**
 * `monday dev sprint current` — the active sprint for the active
 * profile (cli-design §4.3 + §5.9 + §11.3; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `sprints_board` via
 * `loadDevMapping`, page through items_page filtered to sprint
 * rows whose date-range straddles `ctx.clock()`, surface the
 * winning sprint as a `ProjectedItem`. If no sprint is active,
 * throws `not_found` with a hint pointing at `monday dev sprint
 * list --state future` for upcoming sprints.
 *
 * Idempotent: yes (pure read). Output is non-deterministic at the
 * day boundary — agents polling on the cutover should expect the
 * sprint to flip mid-day if their workspace's sprints have
 * adjacent date ranges.
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const inputSchema = z.object({}).strict();

export const devSprintCurrentCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.sprint.current',
  summary: 'Show the active sprint for the configured sprints board',
  examples: [
    'monday dev sprint current',
    'monday dev sprint current --json',
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
    const sprint = ensureSubcommand(
      dev,
      'sprint',
      'Sprint workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    sprint
      .command('current')
      .description(devSprintCurrentCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintCurrentCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devSprintCurrentCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev sprint current not yet implemented (v0.3-M26 pre-flight stub)',
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
