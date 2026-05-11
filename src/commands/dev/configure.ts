/**
 * `monday dev configure [--tasks-board <bid>] [--sprints-board
 *  <bid>] [--epics-board <bid>] [--bugs-board <bid>]
 *  [--releases-board <bid>]` — explicit per-board override of the
 * Monday Dev mapping for the active profile (cli-design §4.3 +
 * §5.9 + §11.3 + §13 v0.3 entry; v0.3-plan §3 M26).
 *
 * **Runtime body landed at M26a IMPL.** Reads the active profile's
 * existing `[profiles.<name>.dev]` block (or starts empty if absent),
 * additively merges the supplied `--<noun>-board` flags, writes back
 * via `saveDevMapping`, and emits the canonical mapping via
 * `emitMutation`.
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
import { ApiError, type ErrorCode } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitMutation } from '../emit.js';
import { BoardIdSchema } from '../../types/ids.js';
import {
  devConfigureOutputSchema,
  loadDevMapping,
  saveDevMapping,
  type DevConfigureOutput,
  type DevMapping,
} from '../../api/dev-conventions.js';
import { resolveActiveDevProfile } from './_shared.js';

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

const DEV_NOT_CONFIGURED: ErrorCode = 'dev_not_configured';

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
  attach: (program, ctx) => {
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
      .action(async (rawOpts: unknown) => {
        const opts = parseArgv(devConfigureCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());

        // Load existing dev block (additive merge — preserves any
        // slot the user supplied previously that this invocation
        // doesn't touch). Missing dev block is a normal first-write
        // case per round-1 P2-4 closure — `dev_not_configured`
        // surfaces from doctor + workflow verbs, NOT from configure.
        let existing: DevMapping;
        try {
          existing = await loadDevMapping(profile.name, profile.homeOptions);
        } catch (err) {
          if (
            err instanceof ApiError &&
            err.code === DEV_NOT_CONFIGURED
          ) {
            existing = {};
          } else {
            // Non-dev_not_configured errors bubble up; in production
            // `cli/program.ts`'s preAction hook surfaces `config_error`
            // on malformed TOML FIRST (it calls `loadProfilesConfig`
            // before the action runs), so this branch is defensive.
            /* c8 ignore next */
            throw err;
          }
        }

        const next: DevMapping = { ...existing };
        if (opts.tasksBoard !== undefined) {
          next.tasks_board = opts.tasksBoard;
        }
        if (opts.sprintsBoard !== undefined) {
          next.sprints_board = opts.sprintsBoard;
        }
        if (opts.epicsBoard !== undefined) {
          next.epics_board = opts.epicsBoard;
        }
        if (opts.bugsBoard !== undefined) {
          next.bugs_board = opts.bugsBoard;
        }
        if (opts.releasesBoard !== undefined) {
          next.releases_board = opts.releasesBoard;
        }

        await saveDevMapping(profile.name, next, profile.homeOptions);

        // Read back via loadDevMapping so the emitted envelope
        // reflects what landed on disk (Codex M21 / M25 pattern —
        // verify the write rather than echoing the input).
        const stored = await loadDevMapping(
          profile.name,
          profile.homeOptions,
        );

        const output: DevConfigureOutput = {
          profile: profile.name,
          mapping: stored,
        };

        emitMutation({
          ctx,
          data: output,
          schema: devConfigureCommand.outputSchema,
          programOpts: program.opts(),
          source: 'none',
          cacheAgeSeconds: null,
        });
      });
  },
};
