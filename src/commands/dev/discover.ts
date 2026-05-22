/**
 * `monday dev discover [--apply]` — auto-detect Monday Dev board
 * mappings + optionally apply them to the active profile
 * (cli-design §4.3 + §11.3 + §13 v0.3 entry; v0.3-plan §3 M26).
 *
 * **Runtime body landed at M26a IMPL.** Walks the user's accessible
 * boards via `discoverDevBoards`, applies the
 * `buildDiscoverMappingFromMatches` collapse on the per-noun match
 * results, and — when `--apply` is set — additively merges the
 * heuristic findings into the active profile's
 * `[profiles.<name>.dev]` block via `saveDevMapping`. Mirrors the
 * M21 oauth-stub / M24 history-stub precedent — argv shape pinned
 * at pre-flight, runtime body filled at IMPL.
 *
 * **Additive-merge semantics on `--apply`.** Heuristic findings are
 * merged on top of any existing dev block (heuristic wins on slot
 * conflict; unset slots in the heuristic result preserve existing
 * values). This preserves user-configured slots the heuristic can't
 * fill (e.g. a workspace with no `Sprints` board where the user set
 * `sprints_board` manually).
 *
 * Idempotent: yes when `--apply` is not set (pure read). When
 * `--apply` is set: idempotent on equal mappings (re-discovery
 * against the same workspace shape rewrites the same block).
 */
import { z } from 'zod';
import { ApiError, type ErrorCode } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import {
  buildDiscoverMappingFromMatches,
  devDiscoverOutputSchema,
  discoverDevBoards,
  loadDevMapping,
  saveDevMapping,
  type DevDiscoverOutput,
  type DevMapping,
} from '../../api/dev-conventions.js';
import { resolveActiveDevProfile } from './_shared.js';

const inputSchema = z
  .object({
    apply: z.boolean().optional(),
  })
  .strict();

const DEV_NOT_CONFIGURED: ErrorCode = 'dev_not_configured';

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
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'dev');
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
      .action(async (rawOpts: unknown) => {
        const opts = parseArgv(devDiscoverCommand.inputSchema, rawOpts);
        const apply = opts.apply ?? false;

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await discoverDevBoards({ client });

        const heuristicMapping = buildDiscoverMappingFromMatches(
          result.matches,
        );

        let finalMapping: DevMapping = heuristicMapping;
        if (apply) {
          let existing: DevMapping;
          try {
            existing = await loadDevMapping(profile.name, profile.homeOptions);
          } catch (err) {
            if (
              err instanceof ApiError &&
              err.code === DEV_NOT_CONFIGURED
            ) {
              // First-write case — no existing dev block. Round-1
              // P2-4 closure: dev discover doesn't surface
              // `dev_not_configured` for itself; absence is normal.
              existing = {};
            } else {
              // Non-dev_not_configured errors from `loadDevMapping`
              // bubble up to the runner's catch-all. In production,
              // the only realistic source is `config_error` on
              // malformed TOML, which `cli/program.ts`'s preAction
              // hook surfaces FIRST (it calls `loadProfilesConfig`
              // before the action runs); this branch is defensive.
              /* c8 ignore next */
              throw err;
            }
          }
          finalMapping = { ...existing, ...heuristicMapping };
          await saveDevMapping(
            profile.name,
            finalMapping,
            profile.homeOptions,
          );
        }

        const output: DevDiscoverOutput = {
          profile: profile.name,
          mapping: finalMapping,
          matches: result.matches,
          applied: apply,
        };

        emitSuccess({
          ctx,
          data: output,
          schema: devDiscoverCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
        });
      });
  },
};
