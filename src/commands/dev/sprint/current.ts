/**
 * `monday dev sprint current` — the active sprint for the active
 * profile (cli-design §4.3 + §5.9 + §11.3; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * `sprints_board`, walks `items_page`, picks the first sprint whose
 * date range straddles `ctx.clock()` (per the same date-range
 * derivation `dev sprint list` uses). Throws `not_found` when no
 * sprint is active, with a hint pointing at
 * `monday dev sprint list --state future` for upcoming sprints.
 *
 * Idempotent: yes (pure read). Output is non-deterministic at the
 * day boundary — agents polling on the cutover should expect the
 * sprint to flip mid-day if their workspace's sprints have adjacent
 * date ranges. When two sprints overlap (rare but legal), the first
 * encountered (per the items_page sort-by-id-asc walker) wins.
 */
import { z } from 'zod';
import { ApiError } from '../../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitSuccess } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import {
  classifySprint,
  dayEpoch,
  extractDateRange,
  loadDevMapping,
  walkDevBoardItems,
} from '../../../api/dev-conventions.js';
import { resolveActiveDevProfile, requireDevBoard } from '../_shared.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../../api/item-projection.js';

const inputSchema = z.object({}).strict();

export const devSprintCurrentCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ProjectedItem
> = {
  name: 'dev.sprint.current',
  summary: 'Show the active sprint for the configured sprints board',
  examples: [
    'monday dev sprint current',
    'monday dev sprint current --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: projectedItemSchema,
  attach: (program, ctx) => {
    const dev = ensureSubcommand(
      program,
      'dev',
      'Monday Dev workflow shortcuts (sprint, epic, release, task)',
    );
    const sprint = ensureSubcommand(
      dev,
      'sprint',
      'Sprint workflow verbs',
    );
    sprint
      .command('current')
      .description(devSprintCurrentCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintCurrentCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        parseArgv(devSprintCurrentCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const boardId = requireDevBoard(mapping, 'sprints_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const { items, complexity } = await walkDevBoardItems({
          client,
          boardId,
          operationName: 'DevSprintCurrent',
          now: ctx.clock,
        });

        const todayEpoch = dayEpoch(ctx.clock().toISOString());
        /* c8 ignore next 3 */
        if (todayEpoch === null) {
          throw new Error('unreachable: ctx.clock() produced an unparseable ISO string');
        }
        const active = items.find(
          (i) => classifySprint(extractDateRange(i), todayEpoch) === 'active',
        );
        if (active === undefined) {
          throw new ApiError(
            'not_found',
            `no active sprint on board ${boardId} for profile \`${profile.name}\``,
            {
              details: {
                profile: profile.name,
                board_id: boardId,
                hint: 'inspect upcoming sprints with `monday dev sprint list --state future`',
              },
            },
          );
        }

        emitSuccess({
          ctx,
          data: active,
          schema: devSprintCurrentCommand.outputSchema,
          programOpts: program.opts(),
          apiVersion,
          source: 'live',
          cacheAgeSeconds: null,
          complexity,
        });
      });
  },
};
