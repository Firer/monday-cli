/**
 * `monday item subitems <iid>` — list direct children of an item
 * (`cli-design.md` §2.8, `v0.1-plan.md` §3 M4).
 *
 * Monday's subitem hierarchy reaches up to 5 levels deep (§2.8); this
 * command surfaces just the *direct* children of one parent. Walking
 * deeper is the agent's concern (recursive `monday item subitems`
 * calls). Single-fetch — Monday returns the full subitems array
 * inline, so there's no cursor to track. The result still emits as
 * a §6.3 collection envelope with `total_returned` so the shape
 * matches `item list`.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError } from '../../utils/errors.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  idFromRawItem,
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from '../../api/item-helpers.js';
import { sortByIdAsc } from '../../api/sort.js';

const ITEM_SUBITEMS_QUERY = `
  query ItemSubitems($ids: [ID!]!) {
    items(ids: $ids) {
      id
      subitems {
        ${ITEM_FIELDS_FRAGMENT}
      }
    }
  }
`;

export const itemSubitemsOutputSchema = z.array(projectedItemSchema);
export type ItemSubitemsOutput = readonly ProjectedItem[];

const inputSchema = z.object({ itemId: ItemIdSchema }).strict();

interface RawResponse {
  readonly items:
    | readonly { readonly id: string; readonly subitems: readonly unknown[] | null }[]
    | null;
}


export const itemSubitemsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemSubitemsOutput
> = {
  name: 'item.subitems',
  summary: 'List direct subitems of one item (one level deep)',
  examples: [
    'monday item subitems 12345',
    'monday item subitems 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemSubitemsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('subitems <itemId>')
      .description(itemSubitemsCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemSubitemsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown) => {
        const parsed = parseArgv(itemSubitemsCommand.inputSchema, { itemId });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const response = await client.raw<RawResponse>(
          ITEM_SUBITEMS_QUERY,
          { ids: [parsed.itemId] },
          { operationName: 'ItemSubitems' },
        );
        const first = response.data.items?.[0];
        if (first === undefined) {
          throw new ApiError(
            'not_found',
            `Monday returned no item for id ${parsed.itemId}`,
            { details: { item_id: parsed.itemId } },
          );
        }
        const rawSubitems = first.subitems ?? [];
        // Per-page sort by ID asc — §3.1 #8. Subitems is a single
        // page so this is the only sort the result sees.
        const sorted = sortByIdAsc(rawSubitems, idFromRawItem);
        // R18 parse-boundary wrap: malformed subitem surfaces as
        // typed `internal_error` with `details.issues` plus the
        // parent-item id for triage.
        const data: ItemSubitemsOutput = sorted.map((raw) =>
          projectItem({
            raw: parseRawItem(raw, { parent_item_id: parsed.itemId }),
          }),
        );
        emitSuccess({
          ctx,
          data,
          schema: itemSubitemsCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          // Single-fetch — no cursor, no remaining pages.
          nextCursor: null,
          hasMore: false,
          totalReturned: data.length,
          ...toEmit(response),
        });
      });
  },
};
