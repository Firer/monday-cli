/**
 * `monday dev epic list [--state active|done]` — list epics filtered
 * by completion state (cli-design §4.3 + §5.9; v0.3-plan §3 M26b).
 *
 * **Runtime body landed at M26b IMPL.** Loads the active profile's
 * dev mapping, walks `items_page` on the configured `epics_board`,
 * and filters client-side by the per-row status column — `active` =
 * NOT `Done`/`Cancelled`; `done` = `Done`/`Cancelled`. Epics without
 * a resolvable status column fall through to the `active` bucket;
 * the structural misconfiguration is diagnosed via `dev doctor`'s
 * board-existence check (no warning code registered at M26 pre-flight
 * — see the M26 round-1 Codex P2-3 clarification).
 *
 * **Status-column heuristic.** Walks every column on a row looking for
 * the first `status` or `color` column whose projected `text` /
 * `label` field carries a non-empty string. The first such field
 * decides the row's state. Reading from `column_values` (already
 * carried on the items_page projection's columns map) means no extra
 * round-trip; the epic board's column ID isn't needed up front.
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

const EPIC_STATE_LITERALS = ['active', 'done'] as const;
export type EpicState = (typeof EPIC_STATE_LITERALS)[number];

const inputSchema = z
  .object({
    state: z.enum(EPIC_STATE_LITERALS).optional(),
  })
  .strict();

const outputSchema = z.array(projectedItemSchema);

const DONE_LABELS: ReadonlySet<string> = new Set([
  'done',
  'cancelled',
  'canceled',
]);

/**
 * Returns the projected status-label string for an item, if any.
 * Walks the projected columns looking for the first status / color
 * column with a non-empty `label` or `text`.
 */
const projectedStatusLabel = (item: ProjectedItem): string | null => {
  for (const col of Object.values(item.columns)) {
    if (col.type !== 'status' && col.type !== 'color') continue;
    if (typeof col.label === 'string' && col.label.length > 0) {
      return col.label;
    }
    if (typeof col.text === 'string' && col.text.length > 0) {
      return col.text;
    }
  }
  return null;
};

const isDoneEpic = (item: ProjectedItem): boolean => {
  const label = projectedStatusLabel(item);
  if (label === null) return false;
  return DONE_LABELS.has(label.toLocaleLowerCase('und'));
};

export const devEpicListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  readonly ProjectedItem[]
> = {
  name: 'dev.epic.list',
  summary: 'List epics for the configured epics board (filter by completion state)',
  examples: [
    'monday dev epic list',
    'monday dev epic list --state active',
    'monday dev epic list --state done --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema,
  attach: (program, ctx) => {
    const dev = ensureSubcommand(program, 'dev');
    const epic = ensureSubcommand(dev, 'epic');
    epic
      .command('list')
      .description(devEpicListCommand.summary)
      .option(
        '--state <state>',
        'Filter epics by completion state: active | done. Without --state, returns every epic on the board.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...devEpicListCommand.examples.map((e) => `  ${e}`),
          '',
        ].join('\n'),
      )
      .action(async (rawOpts: unknown) => {
        const opts = parseArgv(devEpicListCommand.inputSchema, rawOpts);

        const profile = await resolveActiveDevProfile(ctx, program.opts());
        const mapping = await loadDevMapping(profile.name, profile.homeOptions);
        const boardId = requireDevBoard(mapping, 'epics_board', profile.name);

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const { items, complexity } = await walkDevBoardItems({
          client,
          boardId,
          operationName: 'DevEpicList',
          now: ctx.clock,
        });

        const filtered = opts.state === undefined
          ? items
          : items.filter((i) =>
              opts.state === 'done' ? isDoneEpic(i) : !isDoneEpic(i),
            );

        emitSuccess({
          ctx,
          data: filtered,
          schema: devEpicListCommand.outputSchema,
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
