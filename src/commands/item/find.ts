/**
 * `monday item find <name> --board <bid>` — name-based item lookup
 * (`cli-design.md` §5.7, `v0.1-plan.md` §3 M4).
 *
 * Why a client-side walk: Monday's `items_page` filter rules are
 * column-based, and item name isn't a column. The only way to find
 * an item by name is to read the board's items and match
 * client-side. Same trade-off `board find` makes for the same
 * reason. The walk caps at `--limit-pages × pageSize` to keep the
 * per-call cost bounded; agents that need to search a giant board
 * narrow the scope with `--group` first.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { findOne } from '../../api/resolvers.js';
import { BoardIdSchema, GroupIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { paginate, type PaginatedPage } from '../../api/pagination.js';
import {
  projectItem,
  projectedItemSchema,
  rawItemSchema,
  type ProjectedItem,
  type RawItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';

const ITEM_FIND_QUERY = `
  query ItemFind(
    $boardId: ID!
    $limit: Int!
    $groupIds: [String!]
  ) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit) {
        cursor
        items {
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
      groups(ids: $groupIds) { id }
    }
  }
`;

const ITEM_FIND_NEXT_QUERY = `
  query ItemFindNext($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
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
  }
`;

interface InitialResponse {
  readonly boards: readonly { readonly items_page: { readonly cursor: string | null; readonly items: readonly unknown[] } }[] | null;
}
interface NextResponse {
  readonly next_items_page: { readonly cursor: string | null; readonly items: readonly unknown[] } | null;
}

export const itemFindOutputSchema = projectedItemSchema;
export type ItemFindOutput = ProjectedItem;

const inputSchema = z
  .object({
    name: z.string().min(1),
    board: BoardIdSchema,
    group: GroupIdSchema.optional(),
    first: z.boolean().optional(),
    pageSize: z.coerce.number().int().positive().max(500).optional(),
    limitPages: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

const PAGE_SIZE = 100;
const DEFAULT_PAGES = 5;

const initialFetcher = (
  client: MondayClient,
  boardId: string,
  group: string | undefined,
  pageSize: number,
): (() => Promise<MondayResponse<InitialResponse>>) => {
  return () => {
    const variables: Record<string, unknown> = { boardId, limit: pageSize };
    if (group !== undefined) {
      variables.groupIds = [group];
    }
    return client.raw<InitialResponse>(ITEM_FIND_QUERY, variables, {
      operationName: 'ItemFind',
    });
  };
};

const nextFetcher = (
  client: MondayClient,
  pageSize: number,
): ((cursor: string) => Promise<MondayResponse<NextResponse>>) => {
  return (cursor) =>
    client.raw<NextResponse>(
      ITEM_FIND_NEXT_QUERY,
      { cursor, limit: pageSize },
      { operationName: 'ItemFindNext' },
    );
};

const extractInitial = (r: MondayResponse<InitialResponse>): PaginatedPage<unknown> => {
  const board = r.data.boards?.[0];
  const page = board?.items_page;
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

const extractNext = (r: MondayResponse<NextResponse>): PaginatedPage<unknown> => {
  const page = r.data.next_items_page;
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

export const itemFindCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemFindOutput
> = {
  name: 'item.find',
  summary: 'Find a single item on a board by name (uses findOne semantics)',
  examples: [
    'monday item find "Refactor login" --board 12345',
    'monday item find "Many matches" --board 12345 --first',
    'monday item find "In group" --board 12345 --group topics',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemFindOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('find <name>')
      .description(itemFindCommand.summary)
      .requiredOption('--board <bid>', 'board ID (required)')
      .option('--group <gid>', 'restrict scan to one group')
      .option('--first', 'on multiple matches, pick the lowest-ID match')
      .option('--page-size <n>', `page size (default ${String(PAGE_SIZE)})`)
      .option(
        '--limit-pages <n>',
        `max pages to scan (default ${String(DEFAULT_PAGES)})`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemFindCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (name: unknown, opts: unknown) => {
        const parsed = parseArgv(itemFindCommand.inputSchema, {
          name,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, toEmit } = resolveClient(ctx, program.opts());
        const pageSize = parsed.pageSize ?? PAGE_SIZE;
        const cap = parsed.limitPages ?? DEFAULT_PAGES;

        // Walk up to `cap` pages, collecting items for the client-
        // side findOne match. paginate honours --all + --limit; we
        // approximate "scan up to cap pages" by passing
        // limit = cap × pageSize.
        const result = await paginate<unknown, InitialResponse | NextResponse>({
          fetchInitial: initialFetcher(client, parsed.board, parsed.group, pageSize),
          fetchNext: nextFetcher(client, pageSize),
          extractPage: (r): PaginatedPage<unknown> => {
            if ('next_items_page' in r.data) return extractNext(r as MondayResponse<NextResponse>);
            return extractInitial(r as MondayResponse<InitialResponse>);
          },
          getId: (item) => {
            if (typeof item !== 'object' || item === null) return '';
            const v = (item as { id?: unknown }).id;
            return typeof v === 'string' ? v : '';
          },
          all: true,
          limit: cap * pageSize,
          pageSize,
        });

        // Project the haystack — findOne reads name + id only, so the
        // raw shape is enough; full projection happens once a winner
        // is selected.
        const haystack: readonly RawItem[] = result.items.map((raw) =>
          rawItemSchema.parse(raw),
        );
        const found = findOne(
          haystack,
          parsed.name,
          (i) => ({ id: i.id, name: i.name }),
          {
            kind: 'item',
            ...(parsed.first === undefined ? {} : { first: parsed.first }),
          },
        );

        const data = projectItem({ raw: found.resource });
        const warnings: Warning[] = [];
        if (found.firstOfMany) {
          warnings.push({
            code: 'first_of_many',
            message: `--first picked one of ${String(found.candidates.length)} matches`,
            details: {
              candidates: found.candidates.map((c) => ({ id: c.id, name: c.name })),
            },
          });
        }

        emitSuccess({
          ctx,
          data,
          schema: itemFindCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
