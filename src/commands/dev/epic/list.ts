/**
 * `monday dev epic list [--state active|done]` — list epics
 * filtered by completion state (cli-design §4.3 + §5.9; v0.3-plan
 * §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `epics_board`, page
 * through items_page, and filter client-side by the epic's
 * status column — `active` = not `Done` / `Cancelled`; `done` =
 * `Done` / `Cancelled`. Epics with no status column fall through
 * to `active` with a `dev_board_misconfigured` warning per
 * cli-design §5.9.
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

const EPIC_STATE_LITERALS = ['active', 'done'] as const;
export type EpicState = (typeof EPIC_STATE_LITERALS)[number];

const inputSchema = z
  .object({
    state: z.enum(EPIC_STATE_LITERALS).optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devEpicListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.epic.list',
  summary: 'List epics for the configured epics board (filter by completion state)',
  examples: [
    'monday dev epic list',
    'monday dev epic list --state active',
    'monday dev epic list --state done --json',
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
    const epic = ensureSubcommand(
      dev,
      'epic',
      'Epic workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    epic
      .command('list')
      .description(devEpicListCommand.summary)
      .option(
        '--state <state>',
        'Filter epics by completion state: active | done. Without --state, returns every epic on the board.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devEpicListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devEpicListCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev epic list not yet implemented (v0.3-M26 pre-flight stub)',
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
