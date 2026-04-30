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
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardMetadata,
} from '../../api/board-metadata.js';
import { parseWhereSyntax, type WhereClause } from '../../api/filters.js';
import { resolveColumnsAcrossClauses } from '../../api/columns.js';
import { isMeToken } from '../../api/me-token.js';
import {
  DEFAULT_PAGE_SIZE,
  paginate,
  type PaginatedPage,
} from '../../api/pagination.js';
import {
  idFromRawItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import {
  ITEM_FIELDS_FRAGMENT,
  collectColumnHeads,
  projectFromRaw,
  resolveMeFactory,
  titleMap,
} from '../../api/item-helpers.js';
import type { Warning } from '../../utils/output/envelope.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';

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
        ${ITEM_FIELDS_FRAGMENT}
      }
    }
  }
`;

const ITEMS_BY_COLUMN_VALUES_NEXT_QUERY = `
  query ItemsByColumnValuesNext($cursor: String!, $limit: Int!) {
    next_items_page(limit: $limit, cursor: $cursor) {
      cursor
      items {
        ${ITEM_FIELDS_FRAGMENT}
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
  readonly onColumnNotFound?: () => Promise<BoardMetadata>;
}

interface BuildSearchResult {
  readonly columns: readonly ColumnQuery[];
  readonly warnings: readonly Warning[];
  readonly refreshed: boolean;
  readonly metadata: BoardMetadata;
}

const buildColumnQueries = async (
  inputs: BuildSearchInputs,
): Promise<BuildSearchResult> => {
  // Reject non-equality operators upfront — the endpoint doesn't
  // support them and validating before resolution avoids burning a
  // metadata refresh on a doomed call.
  for (const clause of inputs.clauses) {
    if (clause.operator.kind !== 'equals') {
      throw new UsageError(
        `item search supports only the = operator (got ${clause.operator.literal} ` +
          `in ${JSON.stringify(clause.raw)}); use \`item list --where\` for richer filters`,
        { details: { clause: clause.raw, operator: clause.operator.literal } },
      );
    }
  }

  // R12 lift: cache-miss-refresh + collision-warning collection are
  // shared with `api/filters.ts buildFilterRules`. The helper
  // resolves every clause's column token; per-clause value resolution
  // (`me` for people) stays here.
  const resolved = await resolveColumnsAcrossClauses({
    metadata: inputs.metadata,
    tokens: inputs.clauses.map((c) => c.token),
    ...(inputs.onColumnNotFound === undefined
      ? {}
      : { onColumnNotFound: inputs.onColumnNotFound }),
  });

  let cachedMe: string | undefined;
  const me = async (): Promise<string> => {
    cachedMe ??= await inputs.resolveMe();
    return cachedMe;
  };

  // Group clauses by resolved column ID, preserving insertion order
  // for stable result diffs.
  const byColumn = new Map<string, string[]>();
  for (let i = 0; i < inputs.clauses.length; i++) {
    const clause = inputs.clauses[i];
    const match = resolved.matches[i];
    /* c8 ignore next 6 — defensive: matches.length === clauses.length
       by helper contract; the index guard exists for
       noUncheckedIndexedAccess narrowing only. */
    if (clause === undefined || match === undefined) {
      throw new UsageError(
        `buildColumnQueries: lost clause/match alignment at index ${String(i)}`,
      );
    }
    /* c8 ignore next 4 — defensive: parser guarantees binary
       operators carry a value. */
    if (clause.value === undefined) {
      throw new UsageError(`internal: missing value for ${clause.raw}`);
    }
    let value = clause.value;
    // `isMeToken` is the shared (`api/me-token.ts`, R15) recogniser
    // used by all three `me`-aware surfaces — `--where Owner=me`
    // in filters.ts, `--set Owner=me` in api/people.ts, and this
    // search-side filter. One rule across read filters and `--set`
    // writes per cli-design §5.3 step 3 line 704-707.
    if (match.column.type === 'people' && isMeToken(value)) {
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
  return {
    columns,
    // ResolverWarning widens cleanly to envelope.Warning (narrower
    // code literal, required details). Same straight assignment
    // filters.ts uses post-R12.
    warnings: resolved.warnings,
    refreshed: resolved.refreshed,
    metadata: resolved.metadata,
  };
};

const initialFetcher = (
  client: MondayClient,
  boardId: string,
  columns: readonly ColumnQuery[],
): ((effectiveLimit: number) => Promise<MondayResponse<InitialResponse>>) => {
  return (effectiveLimit) =>
    client.raw<InitialResponse>(
      ITEMS_PAGE_BY_COLUMN_VALUES_QUERY,
      { boardId, limit: effectiveLimit, columns },
      { operationName: 'ItemsByColumnValues' },
    );
};

const nextFetcher = (
  client: MondayClient,
): ((cursor: string, effectiveLimit: number) => Promise<MondayResponse<NextResponse>>) => {
  return (cursor, effectiveLimit) =>
    client.raw<NextResponse>(
      ITEMS_BY_COLUMN_VALUES_NEXT_QUERY,
      { cursor, limit: effectiveLimit },
      { operationName: 'ItemsByColumnValuesNext' },
    );
};

const extractInitial = (r: MondayResponse<InitialResponse>): PaginatedPage<unknown> => {
  const page = r.data.items_page_by_column_values;
  /* c8 ignore next 2 — defensive nullish-coalescing for missing
     items_page_by_column_values; same rationale as item/list.ts. */
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
};

const extractNext = (r: MondayResponse<NextResponse>): PaginatedPage<unknown> => {
  const page = r.data.next_items_page;
  /* c8 ignore next 2 — defensive nullish-coalescing for missing
     next_items_page; same rationale as item/list.ts. */
  return { cursor: page?.cursor ?? null, items: page?.items ?? [] };
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
        const onColumnNotFound =
          meta.source === 'cache'
            ? async (): Promise<BoardMetadata> => {
                const refreshed = await refreshBoardMetadata({
                  client,
                  boardId: parsed.board,
                  env: ctx.env,
                });
                return refreshed.metadata;
              }
            : undefined;
        const queryResult = await buildColumnQueries({
          metadata: meta.metadata,
          clauses,
          resolveMe: resolveMeFactory(client),
          ...(onColumnNotFound === undefined ? {} : { onColumnNotFound }),
        });
        const { columns, warnings: filterWarnings } = queryResult;

        const titles = titleMap(queryResult.metadata);
        const columnHeads = collectColumnHeads(queryResult.metadata);
        const pageSize = parsed.pageSize ?? DEFAULT_PAGE_SIZE;
        const effectiveSource: 'live' | 'cache' | 'mixed' =
          meta.source === 'live' && !queryResult.refreshed ? 'live' : 'mixed';
        const effectiveCacheAge = meta.cacheAgeSeconds;

        const result = await paginate<unknown, InitialResponse | NextResponse>({
          fetchInitial: initialFetcher(client, parsed.board, columns),
          fetchNext: nextFetcher(client),
          now: ctx.clock,
          extractPage: (r): PaginatedPage<unknown> => {
            if ('next_items_page' in r.data) return extractNext(r as MondayResponse<NextResponse>);
            return extractInitial(r as MondayResponse<InitialResponse>);
          },
          getId: idFromRawItem,
          all: parsed.all === true,
          ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
          pageSize,
        });

        const data: ItemSearchOutput = result.items.map((raw) =>
          // §6.3 same-board title de-dup: titles live in meta.columns,
          // not on each row.
          projectFromRaw(raw, titles, { omitColumnTitles: true }),
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
          source: effectiveSource,
          cacheAgeSeconds: effectiveCacheAge,
        });
      });
  },
};
