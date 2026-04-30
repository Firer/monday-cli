/**
 * `monday update list <iid>` — list updates (comments) on an item
 * (`cli-design.md` §4.3).
 *
 * GraphQL: `items(ids: [<iid>]) { updates(limit:, page:) }`. Updates
 * is paginated via Monday's `limit` + `page` (page-based, not the
 * cursor surface §5.6 calls out for `items_page`).
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const UPDATE_LIST_QUERY = `
  query UpdateList($itemIds: [ID!], $limit: Int, $page: Int) {
    items(ids: $itemIds) {
      id
      updates(limit: $limit, page: $page) {
        id
        body
        text_body
        creator_id
        creator {
          id
          name
          email
        }
        created_at
        updated_at
        edited_at
        replies {
          id
          body
          text_body
          creator_id
          created_at
        }
      }
    }
  }
`;

const replySchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .strict();

const creatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    creator: creatorSchema.nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    edited_at: z.string().nullable(),
    replies: z.array(replySchema.nullable()),
  })
  .strict();

export const updateListOutputSchema = z.array(updateSchema);
export type UpdateListOutput = z.infer<typeof updateListOutputSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
  })
  .strict();

interface RawItems {
  readonly items: readonly { readonly id?: string; readonly updates?: readonly unknown[] }[] | null;
}

export const updateListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateListOutput
> = {
  name: 'update.list',
  summary: "List updates (comments) on an item",
  examples: [
    'monday update list 5001',
    'monday update list 5001 --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: updateListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('list <itemId>')
      .description(updateListCommand.summary)
      .option('--limit <n>', 'page size (1-100, default 25)')
      .option('--page <n>', '1-indexed page')
      .option('--all', 'walk every page')
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(updateListCommand.inputSchema, {
          itemId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const { client, toEmit } = resolveClient(ctx, program.opts());

        const limit = parsed.limit ?? 25;
        const collected: unknown[] = [];
        let hasMore: boolean;
        let lastResponse: Awaited<ReturnType<typeof client.raw<RawItems>>>;
        let page = parsed.page ?? 1;
        let firstPage = true;
        for (;;) {
          const response = await client.raw<RawItems>(
            UPDATE_LIST_QUERY,
            { itemIds: [parsed.itemId], limit, page },
            { operationName: 'UpdateList' },
          );
          lastResponse = response;
          const items = response.data.items ?? [];
          // Distinguish "item not found" (Monday returns []) from
          // "item exists with no updates" (Monday returns [{...}]
          // with empty `updates`). Only do this on page 1; pagination
          // past a known item shouldn't 404 on a page that happens
          // to be empty.
          if (firstPage && items.length === 0) {
            throw new ApiError(
              'not_found',
              `Monday returned no item for id ${parsed.itemId}`,
              { details: { item_id: parsed.itemId } },
            );
          }
          firstPage = false;
          const updates = items[0]?.updates ?? [];
          if (updates.length === 0) {
            hasMore = false;
            break;
          }
          collected.push(...updates);
          hasMore = updates.length === limit;
          if (parsed.all !== true || !hasMore) break;
          page++;
        }

        emitSuccess({
          ctx,
          data: updateListCommand.outputSchema.parse(collected),
          schema: updateListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: parsed.all === true ? false : hasMore,
          ...toEmit(lastResponse),
        });
      });
  },
};
