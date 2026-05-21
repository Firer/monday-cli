/**
 * `monday dev release list` — list releases for the configured
 * releases board (cli-design §4.3 + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * dev mapping, walks `items_page` on the configured `releases_board`,
 * and surfaces every release as a {@link ProjectedItem}. No per-state
 * filter at v0.3 — releases don't carry a documented per-release-
 * state taxonomy yet; a future v0.3.x / v0.4 may add
 * `--state shipped|upcoming` once the date-column conventions
 * stabilise.
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitSuccess } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import {
  loadDevMapping,
  walkDevBoardItems,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
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
  attach: (program, ctx) => {
    const dev = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (sprint, epic, release, task)',
    );
    const release = ensureSubcommand(
      dev,
      'release',
      'Release workflow verbs',
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
      .action(async (rawOpts: unknown) => {
        parseArgv(devReleaseListCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const boardId = requireDevBoard(mapping, 'releases_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const { items, complexity } = await walkDevBoardItems({
          client,
          boardId,
          operationName: 'DevReleaseList',
          now: ctx.clock,
        });

        emitSuccess({
          ctx,
          data: items,
          schema: devReleaseListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity,
        });
      });
  },
};
