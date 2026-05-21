/**
 * `monday dev sprint list [--state active|past|future]` — list
 * sprints filtered by date-range state (cli-design §4.3 + §5.9 +
 * §11.3; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * dev mapping, walks `items_page` on the configured `sprints_board`,
 * and filters client-side by date-range against `ctx.clock()`:
 *   - `active` = today within `[start, end]`
 *   - `past`   = `end < today`
 *   - `future` = `start > today`
 *
 * Sprints without a resolvable date-range column fall through to
 * `past` (defensive — the structural misconfiguration is diagnosed
 * via `dev doctor`'s `sprints_date_columns_present` check; no
 * warning code registered at M26 pre-flight). NaN-guards on
 * `Date.parse` returns per the M24 round-2 P3-1 precedent
 * (`4c83860`) prevent NaN-shaped state buckets.
 *
 * **Date-range extraction.** Prefers the `timeline` column when
 * present (single column carrying `value.from` + `value.to`); falls
 * back to the first two `date` columns (sorted by id, treating the
 * lower id as start). When only one date column is present, the
 * sprint counts as `active` if today equals the date, `past` if
 * date is before today, `future` otherwise (1-day-wide range).
 *
 * Idempotent: yes (pure read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../../types.js';
import { parseArgv } from '../../parse-argv.js';
import { emitSuccess } from '../../emit.js';
import { resolveClient } from '../../../api/resolve-client.js';
import {
  SPRINT_STATE_LITERALS,
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

export type { SprintState } from '../../../api/dev-conventions.js';

const inputSchema = z
  .object({
    state: z.enum(SPRINT_STATE_LITERALS).optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

export const devSprintListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.sprint.list',
  summary: 'List sprints for the configured sprints board (filter by date-range state)',
  examples: [
    'monday dev sprint list',
    'monday dev sprint list --state active',
    'monday dev sprint list --state future --json',
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
    const sprint = ensureSubcommand(
      dev,
      'sprint',
      'Sprint workflow verbs',
    );
    sprint
      .command('list')
      .description(devSprintListCommand.summary)
      .option(
        '--state <state>',
        'Filter sprints by date-range state: active | past | future. Without --state, returns every sprint on the board.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devSprintListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        const opts = parseArgv(devSprintListCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const boardId = requireDevBoard(mapping, 'sprints_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const { items, complexity } = await walkDevBoardItems({
          client,
          boardId,
          operationName: 'DevSprintList',
          now: ctx.clock,
        });

        let result: readonly ProjectedItem[] = items;
        if (opts.state !== undefined) {
          const todayEpoch = dayEpoch(ctx.clock().toISOString());
          // `dayEpoch` is non-null for a real Date.toISOString() output
          // — the guard is for the symmetric type signature.
          /* c8 ignore next 3 */
          if (todayEpoch === null) {
            throw new Error('unreachable: ctx.clock() produced an unparseable ISO string');
          }
          result = items.filter(
            (i) => classifySprint(extractDateRange(i), todayEpoch) === opts.state,
          );
        }

        emitSuccess({
          ctx,
          data: result,
          schema: devSprintListCommand.outputSchema,
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

