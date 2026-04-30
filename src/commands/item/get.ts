/**
 * `monday item get <iid>` — single item by ID (`cli-design.md` §6.2).
 *
 * GraphQL: `items(ids: [<iid>])` with full column_values inline. The
 * Monday `items` query is the only way to fetch a single item;
 * passing exactly one ID returns at most one element. A null result
 * (item archived to a board the token can't read, or genuinely
 * non-existent) surfaces as `not_found`.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { runByIdLookup } from '../run-by-id-lookup.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  projectItem,
  projectedItemSchema,
  rawItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';

const ITEM_GET_QUERY = `
  query ItemGet($ids: [ID!]!) {
    items(ids: $ids) {
      id
      name
      state
      url
      created_at
      updated_at
      board { id }
      group { id title }
      parent_item { id }
      column_values {
        id
        type
        text
        value
        column { title }
      }
    }
  }
`;

export const itemGetOutputSchema = projectedItemSchema;
export type ItemGetOutput = ProjectedItem;

const inputSchema = z.object({ itemId: ItemIdSchema }).strict();

export const itemGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemGetOutput
> = {
  name: 'item.get',
  summary: 'Show one item by ID with full column values',
  examples: [
    'monday item get 12345',
    'monday item get 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('get <itemId>')
      .description(itemGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown) => {
        const parsed = parseArgv(itemGetCommand.inputSchema, { itemId });
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: ITEM_GET_QUERY,
          operationName: 'ItemGet',
          collectionKey: 'items',
          id: parsed.itemId,
          errorDetailKey: 'item_id',
          kind: 'item',
          schema: itemGetCommand.outputSchema,
          // Item-specific projection: parse the raw GraphQL element
          // through the wider rawItemSchema first, then derive the
          // §6.2 typed column shape via projectItem.
          project: (raw) => projectItem({ raw: rawItemSchema.parse(raw) }),
        });
      });
  },
};
