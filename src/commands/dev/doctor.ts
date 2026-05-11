/**
 * `monday dev doctor` — diagnostics for the active profile's
 * Monday Dev mapping (cli-design §4.3 + §5.9 + §11.3; v0.3-plan
 * §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: read the active profile's `[profiles.<name>.dev]`
 * block (throws `dev_not_configured` if absent), then run every
 * check in `DEV_DOCTOR_CHECK_NAMES` against the configured boards
 * — each check is one `boards(ids:)` projection or a `columns`
 * inspect against the cached board metadata. Surfaces per-check
 * status as ok/warn/fail in the `data.checks[]` array; `summary`
 * carries roll-up counts.
 *
 * **Decision 2 closure (M26 pre-flight — doctor diagnostics).**
 * The check-name vocabulary (`tasks_board_exists`,
 * `tasks_status_column_present`, `tasks_status_labels_canonical`,
 * `sprints_board_exists`, `sprints_state_column_present`,
 * `epics_board_exists`, `releases_board_exists`,
 * `tasks_to_sprints_relation`, `epics_to_releases_relation`) is
 * pinned at this pre-flight + carries an additive-only contract
 * (adding a check is non-breaking; removing or renaming is major).
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import {
  devDoctorOutputSchema,
  type DevDoctorOutput,
} from '../../api/dev-conventions.js';

const inputSchema = z.object({}).strict();

export const devDoctorCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DevDoctorOutput
> = {
  name: 'dev.doctor',
  summary:
    "Validate the active profile's Monday Dev mapping against current board shape (status columns, board_relation wiring, canonical labels)",
  examples: ['monday dev doctor', 'monday dev doctor --json'],
  idempotent: true,
  inputSchema,
  outputSchema: devDoctorOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (cli-design §2.7 — convention, not API)',
    );
    noun
      .command('doctor')
      .description(devDoctorCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devDoctorCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devDoctorCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev doctor not yet implemented (v0.3-M26 pre-flight stub)',
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
