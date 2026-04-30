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
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

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
    limitPages: z.coerce.number().int().positive().max(500).optional(),
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
      .option(
        '--limit-pages <n>',
        `max pages under --all (1-500, default ${String(DEFAULT_MAX_PAGES)})`,
      )
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
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        let pageCounter = 0;
        const result = await walkPages<unknown, RawItems>({
          fetchPage: async (page) => {
            const response = await client.raw<RawItems>(
              UPDATE_LIST_QUERY,
              { itemIds: [parsed.itemId], limit, page },
              { operationName: 'UpdateList' },
            );
            pageCounter++;
            // Distinguish "item not found" (Monday returns []) from
            // "item exists with no updates" (Monday returns [{...}]
            // with empty `updates`). Only the first page hands a
            // not_found — page > 1 against a known item legitimately
            // can return zero items if the cursor walked past.
            if (pageCounter === 1 && (response.data.items ?? []).length === 0) {
              throw new ApiError(
                'not_found',
                `Monday returned no item for id ${parsed.itemId}`,
                { details: { item_id: parsed.itemId } },
              );
            }
            return response;
          },
          extractItems: (r) => r.data.items?.[0]?.updates ?? [],
          pageSize: limit,
          all: parsed.all === true,
          startPage: parsed.page ?? 1,
          maxPages,
        });
        const warnings: Warning[] = [];
        if (parsed.all === true && result.hasMore) {
          warnings.push(buildCapWarning(result.pagesFetched));
        }

        emitSuccess({
          ctx,
          data: updateListCommand.outputSchema.parse(result.items),
          schema: updateListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: result.hasMore,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
