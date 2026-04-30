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
import { ApiError } from '../../utils/errors.js';
import { paginate, type PaginatedPage } from '../../api/pagination.js';
import {
  idFromRawItem,
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
  type RawItem,
} from '../../api/item-projection.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
} from '../../api/item-helpers.js';
import type { Warning } from '../../utils/output/envelope.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';

const ITEM_FIND_QUERY = `
  query ItemFind(
    $boardId: ID!
    $limit: Int!
  ) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit) {
        cursor
        items {
          ${ITEM_FIELDS_FRAGMENT}
        }
      }
    }
  }
`;

const ITEM_FIND_BY_GROUP_QUERY = `
  query ItemFindByGroup(
    $boardId: ID!
    $groupId: String!
    $limit: Int!
  ) {
    boards(ids: [$boardId]) {
      groups(ids: [$groupId]) {
        items_page(limit: $limit) {
          cursor
          items {
            ${ITEM_FIELDS_FRAGMENT}
          }
        }
      }
    }
  }
`;

const ITEM_FIND_NEXT_QUERY = `
  query ItemFindNext($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        ${ITEM_FIELDS_FRAGMENT}
      }
    }
  }
`;

interface InitialResponse {
  readonly boards:
    | readonly {
        readonly items_page?: { readonly cursor: string | null; readonly items: readonly unknown[] };
        readonly groups?: readonly {
          readonly items_page: { readonly cursor: string | null; readonly items: readonly unknown[] };
        }[];
      }[]
    | null;
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
): ((effectiveLimit: number) => Promise<MondayResponse<InitialResponse>>) => {
  return (effectiveLimit) => {
    const variables: Record<string, unknown> = { boardId, limit: effectiveLimit };
    if (group !== undefined) {
      variables.groupId = group;
      return client.raw<InitialResponse>(ITEM_FIND_BY_GROUP_QUERY, variables, {
        operationName: 'ItemFindByGroup',
      });
    }
    return client.raw<InitialResponse>(ITEM_FIND_QUERY, variables, {
      operationName: 'ItemFind',
    });
  };
};

const nextFetcher = (
  client: MondayClient,
): ((cursor: string, effectiveLimit: number) => Promise<MondayResponse<NextResponse>>) => {
  return (cursor, effectiveLimit) =>
    client.raw<NextResponse>(
      ITEM_FIND_NEXT_QUERY,
      { cursor, limit: effectiveLimit },
      { operationName: 'ItemFindNext' },
    );
};

const extractInitial = (r: MondayResponse<InitialResponse>): PaginatedPage<unknown> => {
  const board = r.data.boards?.[0];
  const page = board?.groups?.[0]?.items_page ?? board?.items_page;
  /* c8 ignore next 2 — defensive nullish-coalescing for missing
     items_page; same rationale as item/list.ts. */
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

const extractNext = (r: MondayResponse<NextResponse>): PaginatedPage<unknown> => {
  const page = r.data.next_items_page;
  /* c8 ignore next 2 — defensive nullish-coalescing for missing
     next_items_page; same rationale as item/list.ts. */
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
          fetchInitial: initialFetcher(client, parsed.board, parsed.group),
          fetchNext: nextFetcher(client),
          now: ctx.clock,
          extractPage: (r): PaginatedPage<unknown> => {
            if ('next_items_page' in r.data) return extractNext(r as MondayResponse<NextResponse>);
            return extractInitial(r as MondayResponse<InitialResponse>);
          },
          getId: idFromRawItem,
          all: true,
          limit: cap * pageSize,
          pageSize,
        });

        // Project the haystack — findOne reads name + id only, so the
        // raw shape is enough; full projection happens once a winner
        // is selected.
        // R18 parse-boundary wrap: malformed haystack item surfaces
        // as typed `internal_error` carrying `details.issues` and
        // the find-scope `query`/`board_id` for triage.
        const haystack: readonly RawItem[] = result.items.map((raw) =>
          parseRawItem(raw, { query: parsed.name, board_id: parsed.board }),
        );
        let found;
        try {
          found = findOne(
            haystack,
            parsed.name,
            (i) => ({ id: i.id, name: i.name }),
            {
              kind: 'item',
              ...(parsed.first === undefined ? {} : { first: parsed.first }),
            },
          );
        } catch (err) {
          // Cap-hit before findOne resolved → re-throw with the cap
          // information so agents can widen --limit-pages or narrow
          // the query (Codex M4 §6: a partial scan can produce a
          // false not_found / false uniqueness, must surface).
          if (err instanceof ApiError && err.code === 'not_found' && result.hasMore) {
            throw new ApiError(
              'not_found',
              `No item matched ${JSON.stringify(parsed.name)} in the scanned ${String(result.totalReturned)} item(s); scan was capped at ${String(cap)} pages — widen --limit-pages or narrow with --group / --where.`,
              {
                details: {
                  query: parsed.name,
                  kind: 'item',
                  scan_truncated: true,
                  pages_scanned: result.pagesFetched,
                  cap_pages: cap,
                  items_scanned: result.totalReturned,
                },
              },
            );
          }
          throw err;
        }

        const data = projectItem({ raw: found.resource });
        const warnings: Warning[] = [];
        if (result.hasMore) {
          // Match resolved within the cap, but the scan was
          // truncated — uniqueness isn't guaranteed. Surface a
          // warning so agents can widen the cap if they need
          // certainty.
          warnings.push({
            code: 'pagination_cap_reached',
            message: `find scan capped at ${String(cap)} pages; uniqueness not verified — widen --limit-pages to confirm.`,
            details: {
              pages_scanned: result.pagesFetched,
              items_scanned: result.totalReturned,
              cap_pages: cap,
              hint: 'pass --limit-pages <larger> or narrow the query with --group / --where',
            },
          });
        }
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
