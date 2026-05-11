/**
 * `monday dev configure [--tasks-board <bid>] [--sprints-board
 *  <bid>] [--epics-board <bid>] [--bugs-board <bid>]
 *  [--releases-board <bid>]` — explicit per-board override of the
 * Monday Dev mapping for the active profile (cli-design §4.3 +
 * §5.9 + §11.3 + §13 v0.3 entry; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: validate the supplied board IDs against current
 * board shape, merge into the active profile's
 * `[profiles.<name>.dev]` block (additive — unset slots stay
 * unset), and write back via `saveDevMapping`. At least one of the
 * five `--<noun>-board` flags MUST be supplied (no-op invocations
 * are usage_error).
 *
 * **Argv → TOML key mapping.** Commander's option-name camelCase
 * → the TOML config's snake_case slots:
 *   --tasks-board    → `tasks_board`
 *   --sprints-board  → `sprints_board`
 *   --epics-board    → `epics_board`
 *   --bugs-board     → `bugs_board`
 *   --releases-board → `releases_board`
 *
 * Idempotent: yes (writing the same mapping is a no-op).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { BoardIdSchema } from '../../types/ids.js';
import {
  devConfigureOutputSchema,
  type DevConfigureOutput,
} from '../../api/dev-conventions.js';

const inputSchema = z
  .object({
    tasksBoard: BoardIdSchema.optional(),
    sprintsBoard: BoardIdSchema.optional(),
    epicsBoard: BoardIdSchema.optional(),
    bugsBoard: BoardIdSchema.optional(),
    releasesBoard: BoardIdSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const anySet =
      value.tasksBoard !== undefined ||
      value.sprintsBoard !== undefined ||
      value.epicsBoard !== undefined ||
      value.bugsBoard !== undefined ||
      value.releasesBoard !== undefined;
    if (!anySet) {
      ctx.addIssue({
        code: 'custom',
        message:
          'monday dev configure requires at least one of --tasks-board / --sprints-board / --epics-board / --bugs-board / --releases-board (run `monday dev discover` to auto-detect)',
        path: [],
      });
    }
  });

export const devConfigureCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DevConfigureOutput
> = {
  name: 'dev.configure',
  summary:
    "Explicitly set Monday Dev board mappings on the active profile (alternative to `monday dev discover`)",
  examples: [
    'monday dev configure --tasks-board 987654 --sprints-board 987655',
    'monday dev configure --epics-board 987656 --releases-board 987657',
    'monday dev configure --tasks-board 987654 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: devConfigureOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (cli-design §2.7 — convention, not API)',
    );
    noun
      .command('configure')
      .description(devConfigureCommand.summary)
      .option('--tasks-board <bid>', 'Board ID for the Tasks board')
      .option('--sprints-board <bid>', 'Board ID for the Sprints board')
      .option('--epics-board <bid>', 'Board ID for the Epics board')
      .option('--bugs-board <bid>', 'Board ID for the Bugs board')
      .option('--releases-board <bid>', 'Board ID for the Releases board')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devConfigureCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devConfigureCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev configure not yet implemented (v0.3-M26 pre-flight stub)',
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
