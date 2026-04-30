/**
 * `monday item list --board <bid>` — paginated item listing
 * (`cli-design.md` §2.4 / §5.5 / §5.6 / §6.3, `v0.1-plan.md` §3 M4).
 *
 * The heaviest M4 read. Pulls together every M3 / M4 foundation:
 *
 *   - `loadBoardMetadata` (M3) — needed by the filter parser to
 *     resolve `<col>` tokens and by the §6.3 column-title
 *     de-duplication slot.
 *   - `buildQueryParams` (M4 filters.ts) — turns repeatable
 *     `--where` flags into Monday's `query_params.rules` payload,
 *     or passes `--filter-json` through. `me` sugar resolves via
 *     the `client.whoami()` callback — cached for the duration of
 *     the build call.
 *   - `paginate` (M4 pagination.ts) — `items_page` + `next_items_page`
 *     walker with the §5.6 stale-cursor fail-fast contract.
 *   - `projectItem` (M4 item-projection.ts) — produces the §6.2
 *     single-item shape; titles fold into the §6.3 collection-meta
 *     `columns` slot to avoid per-row repetition.
 *
 * NDJSON streaming mode bypasses the `emitSuccess` collect-then-emit
 * path so items reach stdout as they arrive (per §6.3 / §3.1 #1 —
 * agents can `monday item list --output ndjson | jq` without
 * waiting for the whole walk). Mid-walk `stale_cursor` still emits a
 * valid NDJSON stream up to the failure point and the standard
 * §6.5 error envelope on stderr — the runner's catch-all picks up
 * the thrown ApiError and writes the error envelope with the
 * documented exit code.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, GroupIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardMetadata,
} from '../../api/board-metadata.js';
import { buildQueryParams } from '../../api/filters.js';
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
import {
  buildMeta,
  type ColumnHead,
  type Complexity,
  type Warning,
} from '../../utils/output/envelope.js';
import { selectOutput } from '../../utils/output/select.js';
import { redact } from '../../utils/redact.js';
import {
  parseGlobalFlags,
} from '../../types/global-flags.js';
import { collectSecrets } from '../../cli/envelope-out.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';

const ITEMS_PAGE_QUERY = `
  query ItemsPage(
    $boardId: ID!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, query_params: $queryParams) {
        cursor
        items {
          ${ITEM_FIELDS_FRAGMENT}
        }
      }
    }
  }
`;

/**
 * Group-scoped variant — Monday's items_page exposes a per-group
 * page when the query is rooted at `boards.groups.items_page`. The
 * top-level `items_page` doesn't accept a group filter, so the
 * group-aware path uses a separate query shape rather than a flag
 * inside `query_params`.
 */
const ITEMS_PAGE_BY_GROUP_QUERY = `
  query ItemsPageByGroup(
    $boardId: ID!
    $groupId: String!
    $limit: Int!
    $queryParams: ItemsQuery
  ) {
    boards(ids: [$boardId]) {
      groups(ids: [$groupId]) {
        items_page(limit: $limit, query_params: $queryParams) {
          cursor
          items {
            ${ITEM_FIELDS_FRAGMENT}
          }
        }
      }
    }
  }
`;

const NEXT_ITEMS_PAGE_QUERY = `
  query NextItemsPage($cursor: String!, $limit: Int!) {
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

export const itemListOutputSchema = z.array(projectedItemSchema);
export type ItemListOutput = readonly ProjectedItem[];

const inputSchema = z
  .object({
    board: BoardIdSchema,
    group: GroupIdSchema.optional(),
    where: z.array(z.string()).optional(),
    filterJson: z.string().optional(),
    all: z.boolean().optional(),
    limit: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

interface CollectingFlags {
  readonly all: boolean;
  readonly limit: number | undefined;
}

const initialFetcher = (
  client: MondayClient,
  boardId: string,
  group: string | undefined,
  queryParams: Readonly<Record<string, unknown>> | undefined,
): ((effectiveLimit: number) => Promise<MondayResponse<InitialResponse>>) => {
  return (effectiveLimit) => {
    const variables: Record<string, unknown> = {
      boardId,
      limit: effectiveLimit,
    };
    if (queryParams !== undefined) {
      variables.queryParams = queryParams;
    }
    if (group !== undefined) {
      variables.groupId = group;
      return client.raw<InitialResponse>(ITEMS_PAGE_BY_GROUP_QUERY, variables, {
        operationName: 'ItemsPageByGroup',
      });
    }
    return client.raw<InitialResponse>(ITEMS_PAGE_QUERY, variables, {
      operationName: 'ItemsPage',
    });
  };
};

const nextFetcher = (
  client: MondayClient,
): ((cursor: string, effectiveLimit: number) => Promise<MondayResponse<NextResponse>>) => {
  return (cursor, effectiveLimit) =>
    client.raw<NextResponse>(
      NEXT_ITEMS_PAGE_QUERY,
      { cursor, limit: effectiveLimit },
      { operationName: 'NextItemsPage' },
    );
};

const extractInitial = (r: MondayResponse<InitialResponse>): PaginatedPage<unknown> => {
  const board = r.data.boards?.[0];
  // Group-scoped query: `boards[0].groups[0].items_page`.
  // Top-level query: `boards[0].items_page`.
  const page = board?.groups?.[0]?.items_page ?? board?.items_page;
  /* c8 ignore next 4 — defensive nullish-coalescing for the
     Monday-wire-shape `page` being undefined; the request always
     returns an items_page object on success, the guard exists so a
     malformed cassette / future schema drift doesn't crash. */
  return {
    cursor: page?.cursor ?? null,
    items: page?.items ?? [],
  };
};

const extractNext = (r: MondayResponse<NextResponse>): PaginatedPage<unknown> => {
  const page = r.data.next_items_page;
  /* c8 ignore next 4 — same defensive shape as extractInitial. */
  return {
    cursor: page?.cursor ?? null,
    items: page?.items ?? [],
  };
};

/**
 * Streaming NDJSON path — writes items per-arrival to stdout, then
 * the §6.3 `_meta` trailer. Bypasses `emitSuccess` because the
 * paginate-then-render shape forces collect-before-emit.
 */
interface StreamNdjsonInputs {
  readonly stream: NodeJS.WritableStream;
  readonly secrets: readonly string[];
  readonly titles: ReadonlyMap<string, string>;
  readonly columns: Readonly<Record<string, ColumnHead>>;
  readonly apiVersion: string;
  readonly cliVersion: string;
  readonly requestId: string;
  readonly retrievedAt: string;
  /** §6.1 — derived from metadata + items legs by the caller. */
  readonly source: 'live' | 'cache' | 'mixed';
  readonly cacheAgeSeconds: number | null;
}

interface StreamHandle {
  readonly onItem: (raw: unknown) => void;
  readonly writeTrailer: (params: {
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly totalReturned: number;
    readonly complexity: Complexity | null;
    readonly warnings: readonly Warning[];
  }) => void;
}

const startNdjsonStream = (inputs: StreamNdjsonInputs): StreamHandle => {
  const { stream, secrets, titles, columns } = inputs;
  return {
    onItem: (raw) => {
      const projected = projectFromRaw(raw, titles, { omitColumnTitles: true });
      const redacted = redact(projected, { secrets });
      stream.write(`${JSON.stringify(redacted)}\n`);
    },
    writeTrailer: (params) => {
      const meta = buildMeta({
        api_version: inputs.apiVersion,
        cli_version: inputs.cliVersion,
        request_id: inputs.requestId,
        source: inputs.source,
        retrieved_at: inputs.retrievedAt,
        cache_age_seconds: inputs.cacheAgeSeconds,
        complexity: params.complexity,
        next_cursor: params.nextCursor,
        has_more: params.hasMore,
        total_returned: params.totalReturned,
        columns,
      });
      const trailer = redact({ _meta: meta }, { secrets });
      stream.write(`${JSON.stringify(trailer)}\n`);
    },
  };
};

export const itemListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemListOutput
> = {
  name: 'item.list',
  summary: 'List items on a board with cursor pagination + filters',
  examples: [
    'monday item list --board 12345 --json',
    "monday item list --board 12345 --where 'status=Done' --json",
    "monday item list --board 12345 --where 'status=Done' --where 'owner=me'",
    'monday item list --board 12345 --all --output ndjson',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('list')
      .description(itemListCommand.summary)
      .requiredOption('--board <bid>', 'board ID (required)')
      .option('--group <gid>', 'restrict to one group')
      .option(
        '--where <expr>',
        'repeatable filter: <col><op><val> or <col>:is_empty',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--filter-json <json>', 'literal Monday query_params (escape hatch)')
      .option('--all', 'auto-paginate every page')
      .option('--limit <n>', 'cap total items returned across pages')
      .option('--page-size <n>', `page size (1-500, default ${String(DEFAULT_PAGE_SIZE)})`)
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(itemListCommand.inputSchema, opts);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const meta = await loadBoardMetadata({
          client,
          boardId: parsed.board,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        // Build the cache-aware refresh callback only when metadata
        // came from cache — refreshing live data wouldn't help and
        // would burn an extra request. When refresh fires, the
        // returned BoardMetadata becomes the new view for titles +
        // columnHeads.
        let activeMetadata = meta.metadata;
        const onColumnNotFound =
          meta.source === 'cache'
            ? async (): Promise<BoardMetadata> => {
                const refreshed = await refreshBoardMetadata({
                  client,
                  boardId: parsed.board,
                  env: ctx.env,
                });
                activeMetadata = refreshed.metadata;
                return refreshed.metadata;
              }
            : undefined;

        const filterResult = await buildQueryParams({
          metadata: meta.metadata,
          resolveMe: resolveMeFactory(client),
          whereClauses: parsed.where ?? [],
          filterJson: parsed.filterJson,
          ...(onColumnNotFound === undefined ? {} : { onColumnNotFound }),
        });
        const queryParams = filterResult.queryParams;
        const filterWarnings = filterResult.warnings;

        // Effective meta source per §6.1:
        //  - metadata live + items live   → live
        //  - metadata cache + items live  → mixed (filterResult.refreshed
        //    doesn't matter here — the data is still partly cache-derived)
        //  - metadata cache + refresh fired during filter resolution
        //    → mixed (the original cache was stale, refresh was forced).
        // The original cacheAgeSeconds is preserved so agents can read
        // "how stale was the cache when this ran" — same pattern as
        // resolveColumnWithRefresh per Codex M3 pass-2 §1.
        const effectiveSource: 'live' | 'cache' | 'mixed' =
          meta.source === 'live' && !filterResult.refreshed ? 'live' : 'mixed';
        const effectiveCacheAge = meta.cacheAgeSeconds;

        const titles = titleMap(activeMetadata);
        const columnHeads = collectColumnHeads(activeMetadata);
        const pageSize = parsed.pageSize ?? DEFAULT_PAGE_SIZE;
        const flags: CollectingFlags = {
          all: parsed.all === true,
          ...(parsed.limit === undefined ? { limit: undefined } : { limit: parsed.limit }),
        };

        const format = selectOutput({
          json: globalFlags.json,
          table: globalFlags.table,
          ...(globalFlags.output === undefined ? {} : { output: globalFlags.output }),
          env: ctx.env,
          isTTY: ctx.isTTY,
        });

        // Streaming NDJSON path — emit per-arrival, then the §6.3
        // trailer. Bypasses emitSuccess because the streaming
        // contract requires items hitting stdout before the walk
        // completes.
        if (format === 'ndjson') {
          const secrets = collectSecrets(ctx.env);
          const stream = startNdjsonStream({
            stream: ctx.stdout,
            secrets,
            titles,
            columns: columnHeads,
            apiVersion,
            cliVersion: ctx.cliVersion,
            requestId: ctx.requestId,
            retrievedAt: ctx.clock().toISOString(),
            source: effectiveSource,
            cacheAgeSeconds: effectiveCacheAge,
          });
          const result = await paginate<unknown, InitialResponse | NextResponse>({
            fetchInitial: initialFetcher(client, parsed.board, parsed.group, queryParams),
            fetchNext: nextFetcher(client),
            now: ctx.clock,
            extractPage: (r): PaginatedPage<unknown> => {
              if ('next_items_page' in r.data) return extractNext(r as MondayResponse<NextResponse>);
              return extractInitial(r as MondayResponse<InitialResponse>);
            },
            getId: idFromRawItem,
            all: flags.all,
            ...(flags.limit === undefined ? {} : { limit: flags.limit }),
            pageSize,
            onItem: stream.onItem,
          });
          stream.writeTrailer({
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
            totalReturned: result.totalReturned,
            complexity: result.complexity,
            warnings: filterWarnings,
          });
          return;
        }

        // Non-streaming path — collect, project, emit through the
        // standard envelope.
        const result = await paginate<unknown, InitialResponse | NextResponse>({
          fetchInitial: initialFetcher(client, parsed.board, parsed.group, queryParams),
          fetchNext: nextFetcher(client),
          now: ctx.clock,
          extractPage: (r): PaginatedPage<unknown> => {
            if ('next_items_page' in r.data) return extractNext(r as MondayResponse<NextResponse>);
            return extractInitial(r as MondayResponse<InitialResponse>);
          },
          getId: idFromRawItem,
          all: flags.all,
          ...(flags.limit === undefined ? {} : { limit: flags.limit }),
          pageSize,
        });
        const data: ItemListOutput = result.items.map((raw) =>
          projectFromRaw(raw, titles, { omitColumnTitles: true }),
        );
        const warnings: Warning[] = [...filterWarnings, ...result.warnings];
        // Re-parse the global flags so commander's runtime shape gets
        // normalised by parseGlobalFlags before emit reads it. (The
        // flags variable above is already normalised; this just keeps
        // emit's contract — programOpts is the raw shape — explicit.)
        parseGlobalFlags(program.opts(), ctx.env);

        const baseEmit = toEmit(result.lastResponse);
        emitSuccess({
          ctx,
          data,
          schema: itemListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          nextCursor: result.nextCursor,
          hasMore: result.hasMore,
          totalReturned: result.totalReturned,
          columns: columnHeads,
          warnings,
          ...baseEmit,
          // Override toEmit's `live` / `null` defaults when the
          // metadata leg came from cache. Items still came from the
          // live items_page query, so source: 'mixed' + the original
          // cacheAgeSeconds is the §6.1-correct view (Codex M4 §2).
          source: effectiveSource,
          cacheAgeSeconds: effectiveCacheAge,
        });
      });
  },
};
