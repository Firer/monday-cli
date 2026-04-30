/**
 * `monday item search --board <bid> --where ...` — column-value search
 * (`cli-design.md` §5.5, `v0.1-plan.md` §3 M4).
 *
 * Backed by Monday's `items_page_by_column_values` endpoint — a
 * narrower surface than `items_page`'s `query_params.rules`:
 * value-equality only, AND across columns, OR within a column's
 * values. Items matching ANY of the listed values for a given
 * column count as a hit.
 *
 * Why a separate command from `item list --where`: the endpoints
 * are different. `items_page_by_column_values` is purpose-built for
 * "find items where status=Done" lookups across the whole board,
 * which is faster than walking + filtering when the agent already
 * knows the value. `item list --where` runs the rule against
 * Monday's full filter DSL (any_of, contains_text, comparators,
 * is_empty) but pays the per-page complexity cost.
 *
 * v0.1 surface: only the `=` operator is supported via this command.
 * Multiple `--where status=A --where status=B` against the same
 * column merge into one entry with `[A, B]` (OR within column).
 * Multiple columns AND across entries. Anything else (`~=`, `<`,
 * `:is_empty`, etc.) raises `usage_error` — agents pick `item
 * list --where` for the richer surface.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { UsageError } from '../../utils/errors.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import { parseWhereSyntax, type WhereClause } from '../../api/filters.js';
import { resolveColumn, type ColumnMatch } from '../../api/columns.js';
import {
  DEFAULT_PAGE_SIZE,
  paginate,
  type PaginatedPage,
} from '../../api/pagination.js';
import {
  projectItem,
  projectedItemSchema,
  rawItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning, ColumnHead } from '../../utils/output/envelope.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import type { BoardMetadata } from '../../api/board-metadata.js';

const ITEMS_PAGE_BY_COLUMN_VALUES_QUERY = `
  query ItemsByColumnValues(
    $boardId: ID!
    $limit: Int!
    $columns: [ItemsPageByColumnValuesQuery!]!
  ) {
    items_page_by_column_values(
      board_id: $boardId
      limit: $limit
      columns: $columns
    ) {
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

const ITEMS_BY_COLUMN_VALUES_NEXT_QUERY = `
  query ItemsByColumnValuesNext($cursor: String!, $limit: Int!) {
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
  readonly items_page_by_column_values: { readonly cursor: string | null; readonly items: readonly unknown[] } | null;
}
interface NextResponse {
  readonly next_items_page: { readonly cursor: string | null; readonly items: readonly unknown[] } | null;
}

export const itemSearchOutputSchema = z.array(projectedItemSchema);
export type ItemSearchOutput = readonly ProjectedItem[];

const inputSchema = z
  .object({
    board: BoardIdSchema,
    where: z.array(z.string()).min(1),
    all: z.boolean().optional(),
    limit: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

interface ColumnQuery {
  readonly column_id: string;
  readonly column_values: readonly string[];
}

interface BuildSearchInputs {
  readonly metadata: BoardMetadata;
  readonly clauses: readonly WhereClause[];
  readonly resolveMe: () => Promise<string>;
}

interface BuildSearchResult {
  readonly columns: readonly ColumnQuery[];
  readonly warnings: readonly Warning[];
}

const buildColumnQueries = async (
  inputs: BuildSearchInputs,
): Promise<BuildSearchResult> => {
  // Group clauses by resolved column ID, preserving insertion order
  // for stable result diffs. Each clause must be `=` (any_of) — the
  // endpoint doesn't support other operators.
  const byColumn = new Map<string, string[]>();
  const warnings: Warning[] = [];
  let cachedMe: string | undefined;
  const me = async (): Promise<string> => {
    cachedMe ??= await inputs.resolveMe();
    return cachedMe;
  };

  for (const clause of inputs.clauses) {
    if (clause.operator.kind !== 'equals') {
      throw new UsageError(
        `item search supports only the = operator (got ${clause.operator.literal} ` +
          `in ${JSON.stringify(clause.raw)}); use \`item list --where\` for richer filters`,
        { details: { clause: clause.raw, operator: clause.operator.literal } },
      );
    }
    const match: ColumnMatch = resolveColumn(inputs.metadata, clause.token);
    if (match.collisionCandidates.length > 0) {
      warnings.push({
        code: 'column_token_collision',
        message:
          `Search token matched column id "${match.column.id}" and ` +
          `${String(match.collisionCandidates.length)} title(s); the ID match wins.`,
        details: {
          via: match.via,
          resolved_id: match.column.id,
          candidates: match.collisionCandidates,
        },
      });
    }
    /* c8 ignore next 4 — defensive: parser guarantees binary
       operators carry a value. */
    if (clause.value === undefined) {
      throw new UsageError(`internal: missing value for ${clause.raw}`);
    }
    let value = clause.value;
    if (match.column.type === 'people' && value.trim() === 'me') {
      value = await me();
    }
    const existing = byColumn.get(match.column.id);
    if (existing === undefined) {
      byColumn.set(match.column.id, [value]);
    } else {
      existing.push(value);
    }
  }

  const columns: ColumnQuery[] = [];
  for (const [columnId, values] of byColumn) {
    columns.push({ column_id: columnId, column_values: values });
  }
  return { columns, warnings };
};

const initialFetcher = (
  client: MondayClient,
  boardId: string,
  pageSize: number,
  columns: readonly ColumnQuery[],
): (() => Promise<MondayResponse<InitialResponse>>) => {
  return () =>
    client.raw<InitialResponse>(
      ITEMS_PAGE_BY_COLUMN_VALUES_QUERY,
      { boardId, limit: pageSize, columns },
      { operationName: 'ItemsByColumnValues' },
    );
};

const nextFetcher = (
  client: MondayClient,
  pageSize: number,
): ((cursor: string) => Promise<MondayResponse<NextResponse>>) => {
  return (cursor) =>
    client.raw<NextResponse>(
      ITEMS_BY_COLUMN_VALUES_NEXT_QUERY,
      { cursor, limit: pageSize },
      { operationName: 'ItemsByColumnValuesNext' },
    );
};

const extractInitial = (r: MondayResponse<InitialResponse>): PaginatedPage<unknown> => {
  const page = r.data.items_page_by_column_values;
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

const extractNext = (r: MondayResponse<NextResponse>): PaginatedPage<unknown> => {
  const page = r.data.next_items_page;
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

const resolveMeFactory = (client: MondayClient): (() => Promise<string>) => {
  return async () => {
    const response = await client.whoami();
    const me = response.data.me;
    if (me === null) {
      throw new UsageError(
        'cannot resolve `me` — token is not associated with a Monday user',
      );
    }
    return me.id;
  };
};

const titleMap = (metadata: BoardMetadata): ReadonlyMap<string, string> => {
  const out = new Map<string, string>();
  for (const c of metadata.columns) {
    out.set(c.id, c.title);
  }
  return out;
};

const collectColumnHeads = (
  metadata: BoardMetadata,
): Readonly<Record<string, ColumnHead>> => {
  const out: Record<string, ColumnHead> = {};
  for (const c of metadata.columns) {
    out[c.id] = { id: c.id, type: c.type, title: c.title };
  }
  return out;
};

export const itemSearchCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemSearchOutput
> = {
  name: 'item.search',
  summary: 'Search items by column value (any_of) on one board',
  examples: [
    "monday item search --board 12345 --where 'status=Done'",
    "monday item search --board 12345 --where 'status=Done' --where 'status=Backlog'",
    'monday item search --board 12345 --where owner=me --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemSearchOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('search')
      .description(itemSearchCommand.summary)
      .requiredOption('--board <bid>', 'board ID (required)')
      .requiredOption(
        '--where <expr>',
        'repeatable: <col>=<val> only (no <, ~=, :is_empty)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--all', 'auto-paginate every page')
      .option('--limit <n>', 'cap total items returned across pages')
      .option('--page-size <n>', `page size (1-500, default ${String(DEFAULT_PAGE_SIZE)})`)
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemSearchCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(itemSearchCommand.inputSchema, opts);
        const { client, globalFlags, toEmit } = resolveClient(ctx, program.opts());

        const meta = await loadBoardMetadata({
          client,
          boardId: parsed.board,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        const clauses = parsed.where.map(parseWhereSyntax);
        const { columns, warnings: filterWarnings } = await buildColumnQueries({
          metadata: meta.metadata,
          clauses,
          resolveMe: resolveMeFactory(client),
        });

        const titles = titleMap(meta.metadata);
        const columnHeads = collectColumnHeads(meta.metadata);
        const pageSize = parsed.pageSize ?? DEFAULT_PAGE_SIZE;

        const result = await paginate<unknown, InitialResponse | NextResponse>({
          fetchInitial: initialFetcher(client, parsed.board, pageSize, columns),
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
          all: parsed.all === true,
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          pageSize,
        });

        const data: ItemSearchOutput = result.items.map((raw) =>
          projectItem({ raw: rawItemSchema.parse(raw), columnTitles: titles }),
        );
        const warnings: Warning[] = [...filterWarnings, ...result.warnings];

        emitSuccess({
          ctx,
          data,
          schema: itemSearchCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          totalReturned: result.totalReturned,
          columns: columnHeads,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
