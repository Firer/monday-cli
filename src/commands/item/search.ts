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
import { resolveColumn, type ColumnMatch } from '../../api/columns.js';
import { isMeToken } from '../../api/me-token.js';
import { ApiError } from '../../utils/errors.js';
import {
  DEFAULT_PAGE_SIZE,
  paginate,
  type PaginatedPage,
} from '../../api/pagination.js';
import {
  idFromRawItem,
  projectItem,
  projectedItemSchema,
  rawItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning, ColumnHead } from '../../utils/output/envelope.js';
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

  let metadata = inputs.metadata;
  let refreshed = false;

  for (const clause of inputs.clauses) {
    if (clause.operator.kind !== 'equals') {
      throw new UsageError(
        `item search supports only the = operator (got ${clause.operator.literal} ` +
          `in ${JSON.stringify(clause.raw)}); use \`item list --where\` for richer filters`,
        { details: { clause: clause.raw, operator: clause.operator.literal } },
      );
    }
    let match: ColumnMatch;
    try {
      match = resolveColumn(metadata, clause.token);
    } catch (err) {
      // Same cache-miss-refresh shape as filters.ts buildFilterRules
      // (Codex M4 §1).
      const isMissing =
        err instanceof ApiError && err.code === 'column_not_found';
      if (
        !isMissing ||
        inputs.onColumnNotFound === undefined ||
        refreshed
      ) {
        throw err;
      }
      metadata = await inputs.onColumnNotFound();
      refreshed = true;
      warnings.push({
        code: 'stale_cache_refreshed',
        message:
          'Cache miss for filter token; refreshed board metadata to resolve.',
        details: { token: clause.token, board_id: metadata.id },
      });
      match = resolveColumn(metadata, clause.token);
    }
    /* c8 ignore next 13 — collision warnings are exercised by
       tests/unit/api/filters.test.ts against the same column-
       resolution surface; duplicating the assertion through the
       items_page_by_column_values endpoint would be a fixture-only
       regression test, not a real-path one. */
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
  return { columns, warnings, refreshed, metadata };
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

const resolveMeFactory = (client: MondayClient): (() => Promise<string>) => {
  return async () => {
    const response = await client.whoami();
    const me = response.data.me;
    /* c8 ignore next 5 — defensive guard; same rationale as
       item/list.ts. */
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
          projectItem({
            raw: rawItemSchema.parse(raw),
            columnTitles: titles,
            // §6.3 same-board title de-dup: titles live in
            // meta.columns, not on each row.
            omitColumnTitles: true,
          }),
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
