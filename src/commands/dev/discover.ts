/**
 * `monday dev discover [--apply]` — auto-detect Monday Dev board
 * mappings + optionally apply them to the active profile
 * (cli-design §4.3 + §11.3 + §13 v0.3 entry; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; the action body
 * is `c8 ignore start/stop` wrapped — it parses the argv schema +
 * resolves a client, then rejects with `internal_error`. M26
 * implementation lands the runtime body: walk the user's
 * accessible boards (optionally scoped via `--workspace <wid>` if
 * a future contract amendment opts that in), run the heuristic
 * via `groupCandidatesByDevNoun`, surface ambiguous / unmapped
 * nouns on the success envelope's `matches[]` array (zero-match
 * surfaces with `matched: []`; ambiguous surfaces with
 * `matched.length > 1`; no warning code registered at M26 pre-
 * flight — round-1 + round-2 Codex P2 fix), and — when `--apply`
 * is set — write the resulting mapping into the active profile's
 * `[profiles.<name>.dev]` block via `saveDevMapping`.
 *
 * Mirrors the M21 oauth-stub / M24 history-stub precedent — argv
 * shape pinned at pre-flight so agent scripts targeting `monday
 * dev discover` are stable across the M26 drop-in.
 *
 * Idempotent: yes when `--apply` is not set (pure read). When
 * `--apply` is set: idempotent on equal mappings (re-discovery
 * against the same workspace shape rewrites the same block).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import {
  devDiscoverOutputSchema,
  type DevDiscoverOutput,
} from '../../api/dev-conventions.js';

const inputSchema = z
  .object({
    apply: z.boolean().optional(),
  })
  .strict();

export const devDiscoverCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DevDiscoverOutput
> = {
  name: 'dev.discover',
  summary:
    'Auto-detect Monday Dev board mappings (tasks/sprints/epics/releases/bugs) and optionally write them to the active profile',
  examples: [
    'monday dev discover',
    'monday dev discover --apply',
    'monday dev discover --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: devDiscoverOutputSchema,
  attach: (program) => {
    const noun = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (cli-design §2.7 — convention, not API)',
    );
    noun
      .command('discover')
      .description(devDiscoverCommand.summary)
      .option(
        '--apply',
        "Write the detected mapping into the active profile's `[profiles.<name>.dev]` block. Without --apply, the command is a pure read and only prints the mapping.",
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devDiscoverCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devDiscoverCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev discover not yet implemented (v0.3-M26 pre-flight stub)',
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
