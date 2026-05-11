/**
 * `monday dev doctor` — diagnostics for the active profile's
 * Monday Dev mapping (cli-design §4.3 + §5.9 + §11.3; v0.3-plan
 * §3 M26).
 *
 * **Runtime body landed at M26a IMPL.** Loads the active profile's
 * `[profiles.<name>.dev]` block (surfaces `dev_not_configured` if
 * absent — per round-1 P2-4, this is the verb that DOES fire the
 * code), hydrates every configured board via a single
 * `boards(ids:)` call, then runs each of the 10
 * `DEV_DOCTOR_CHECK_NAMES` checks in order. Surfaces per-check
 * status as `ok` / `warn` / `fail` in `data.checks[]`; `summary`
 * carries the roll-up counts.
 *
 * **Decision 2 closure (M26 pre-flight — doctor diagnostics).**
 * The check-name vocabulary (10 entries post-round-1 Codex
 * fix-ups; see `DEV_DOCTOR_CHECK_NAMES` in
 * `src/api/dev-conventions.ts`) is pinned at the pre-flight +
 * carries an additive-only contract (adding a check is
 * non-breaking; removing or renaming is major). Per-check
 * `details` shape is per-check additive — pinned at this IMPL
 * commit alongside the runtime body of each check.
 *
 * **Exit-code policy.** The verb's exit code stays 0 regardless of
 * per-check `fail_count` — `dev doctor`'s success is "diagnostics
 * completed"; agents inspect `data.summary.fail_count` for drift.
 * `dev_board_misconfigured` is reserved for the case where the
 * doctor itself can't complete; the per-check-level `fail` entries
 * surface in `data.checks[]` rather than as a top-level error.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import {
  devDoctorOutputSchema,
  loadDevMapping,
  runDevDoctor,
  type DevDoctorOutput,
} from '../../api/dev-conventions.js';
import { resolveActiveDevProfile } from './_shared.js';

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
  attach: (program, ctx) => {
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
      .action(async (rawOpts: unknown) => {
        parseArgv(devDoctorCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        // loadDevMapping throws `dev_not_configured` when no
        // `[profiles.<name>.dev]` block exists — doctor's contract
        // requires a configured mapping to diagnose against.
        const mapping = await loadDevMapping(
          profile.name,
          profile.homeOptions,
        );

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await runDevDoctor({
          client,
          profile: profile.name,
          mapping,
        });

        const output: DevDoctorOutput = {
          profile: profile.name,
          mapping,
          checks: result.checks,
          summary: result.summary,
        };

        emitSuccess({
          ctx,
          data: output,
          schema: devDoctorCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
        });
      });
  },
};
