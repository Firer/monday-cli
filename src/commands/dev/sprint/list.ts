/**
 * `monday dev sprint list [--state active|past|future]` — list
 * sprints filtered by date-range state (cli-design §4.3 + §5.9 +
 * §11.3; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `sprints_board`, page
 * through items_page, and filter client-side by date-range against
 * `ctx.clock()` — `active` = today within [start, end]; `past` =
 * end < today; `future` = start > today. Sprints without
 * resolvable date columns are surfaced under `past` with a
 * `sprint_dates_missing` warning per cli-design §6.1.
 *
 * **NaN-guard discipline.** Date parses (`Date.parse(startDate)`)
 * MUST `Number.isNaN`-guard before comparison — Monday's date
 * columns may surface partial / empty / malformed values.
 * Defensive comparison falls through to "no resolvable date" path
 * rather than emitting NaN-shaped category buckets (M24 round-2
 * P3-1 precedent — `4c83860`).
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

const SPRINT_STATE_LITERALS = ['active', 'past', 'future'] as const;
export type SprintState = (typeof SPRINT_STATE_LITERALS)[number];

const inputSchema = z
  .object({
    state: z.enum(SPRINT_STATE_LITERALS).optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devSprintListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.sprint.list',
  summary: 'List sprints for the configured sprints board (filter by date-range state)',
  examples: [
    'monday dev sprint list',
    'monday dev sprint list --state active',
    'monday dev sprint list --state future --json',
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
      .command('list')
      .description(devSprintListCommand.summary)
      .option(
        '--state <state>',
        'Filter sprints by date-range state: active | past | future. Without --state, returns every sprint on the board.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devSprintListCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev sprint list not yet implemented (v0.3-M26 pre-flight stub)',
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
