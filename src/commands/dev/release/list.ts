/**
 * `monday dev release list` — list releases for the configured
 * releases board (cli-design §4.3 + §5.9; v0.3-plan §3 M26).
 *
 * **Pre-flight stub action.** Argv schema is real; action body
 * `c8 ignore start/stop` wrapped. M26 implementation lands the
 * runtime body: load the active profile's `releases_board`, page
 * through items_page, and surface every release as a
 * `ProjectedItem`. Unlike sprints + epics, releases don't carry a
 * documented per-release-state taxonomy at v0.3 — a future
 * v0.3.x / v0.4 may add `--state shipped|upcoming` once the date-
 * column conventions stabilise.
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

const inputSchema = z.object({}).strict();

const outputSchema = z.array(projectedItemSchema);

export const devReleaseListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.release.list',
  summary: 'List releases for the configured releases board',
  examples: [
    'monday dev release list',
    'monday dev release list --json',
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
    const release = ensureSubcommand(
      dev,
      'release',
      'Release workflow verbs (three-level depth per cli-design §5.2 carve-out 1)',
    );
    release
      .command('list')
      .description(devReleaseListCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devReleaseListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(
        /* c8 ignore start -- pre-flight stub; runtime body at M26 IMPL */
        async (opts: unknown) => {
          parseArgv(devReleaseListCommand.inputSchema, opts);
          await Promise.reject(new ApiError(
            'internal_error',
            'monday dev release list not yet implemented (v0.3-M26 pre-flight stub)',
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
