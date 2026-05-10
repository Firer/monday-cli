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
} from '../../api/pagination.js';
import {
  fetchItemsPage,
  fetchNextItemsPage,
  type ItemsPagePayload,
} from '../../api/items-page-walker.js';
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
import { selectOutput } from '../../utils/output/select.js';
import {
  buildStreamingTrailerMeta,
  startNdjsonStream,
} from '../../utils/output/ndjson.js';
import {
  parseGlobalFlags,
} from '../../types/global-flags.js';
import { collectSecrets } from '../../cli/envelope-out.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';

// items_page GraphQL surface lifted into `api/items-page-walker.ts`
// per §18 R34 (post-M12). The helper builds the queries inline from
// `operationName` + `itemFields` + optional `groupId` — the
// top-level / by-group split (`boards.items_page` vs
// `boards.groups.items_page`) and the malformed-response parse
// boundary live there. `paginate.ts` stays the cursor walker for
// this command's --all / --limit / --page-size / NDJSON onItem /
// complexity tracking.

/**
 * Per-row schema is `z.unknown()` — list.ts hands raw rows to
 * `projectFromRaw` (which is the boundary that types each row).
 * Keeping the helper untyped here preserves byte-identical behaviour
 * (no per-row narrowing on the items_page page itself).
 */
const listItemSchema = z.unknown();

type WalkerResponse = MondayResponse<ItemsPagePayload<unknown>>;

export const itemListOutputSchema = z.array(projectedItemSchema);
export type ItemListOutput = readonly ProjectedItem[];

const inputSchema = z
  .object({
    board: BoardIdSchema,
    group: GroupIdSchema.optional(),
    where: z.array(z.string()).optional(),
    // Parity with `item update --filter-json` — see that file's note.
    // Read-only here so not destructive, but `''` is never a valid
    // `query_params` JSON object; reject at the schema boundary so
    // the failure surfaces as `usage_error` rather than as a confusing
    // "no filter applied" silent passthrough. `.refine(trim)` rather
    // than `.min(1)` catches whitespace-only inputs too without
    // burning a board-metadata network call first.
    filterJson: z
      .string()
      .refine(
        (s) => s.trim().length > 0,
        '--filter-json must be a non-empty JSON object',
      )
      .optional(),
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
): ((effectiveLimit: number) => Promise<WalkerResponse>) => {
  const operationName =
    group === undefined ? 'ItemsPage' : 'ItemsPageByGroup';
  return (effectiveLimit) =>
    fetchItemsPage<unknown>({
      client,
      operationName,
      boardId,
      ...(group === undefined ? {} : { groupId: group }),
      limit: effectiveLimit,
      queryParams,
      itemFields: ITEM_FIELDS_FRAGMENT,
      itemSchema: listItemSchema,
    });
};

const nextFetcher = (
  client: MondayClient,
): ((cursor: string, effectiveLimit: number) => Promise<WalkerResponse>) => {
  return (cursor, effectiveLimit) =>
    fetchNextItemsPage<unknown>({
      client,
      operationName: 'NextItemsPage',
      cursor,
      limit: effectiveLimit,
      itemFields: ITEM_FIELDS_FRAGMENT,
      itemSchema: listItemSchema,
    });
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
        // completes. R52 (M18) lifted the stream helper into
        // `utils/output/ndjson.ts`; per-call `Meta` stays at the
        // call site so per-noun trailer shape (item list/search
        // carries `meta.columns`; update list does not) lives at
        // the caller.
        if (format === 'ndjson') {
          const stream = startNdjsonStream<unknown>({
            stream: ctx.stdout,
            secrets: collectSecrets(ctx.env, ctx.runtimeSecrets),
            project: (raw) => projectFromRaw(raw, titles, { omitColumnTitles: true }),
          });
          const result = await paginate<unknown, ItemsPagePayload<unknown>>({
            fetchInitial: initialFetcher(client, parsed.board, parsed.group, queryParams),
            fetchNext: nextFetcher(client),
            now: ctx.clock,
            extractPage: (r) => r.data,
            getId: idFromRawItem,
            all: flags.all,
            ...(flags.limit === undefined ? {} : { limit: flags.limit }),
            pageSize,
            onItem: stream.onItem,
          });
          // §6.3 trailer-warnings pin: filterWarnings live on the
          // success envelope when the caller picks JSON; in NDJSON
          // they're dropped per the §6.3 "no warnings in trailer"
          // rule. If a future milestone needs them in-stream, the
          // contract path is `_meta.warnings` (extend `Meta`,
          // don't add a sibling key). Suppress the unused-variable
          // lint hint on the streaming branch with a void cast.
          void filterWarnings;
          stream.writeTrailer(
            buildStreamingTrailerMeta({
              ctx: {
                cliVersion: ctx.cliVersion,
                requestId: ctx.requestId,
                clock: ctx.clock,
              },
              apiVersion,
              source: effectiveSource,
              cacheAgeSeconds: effectiveCacheAge,
              result: {
                hasMore: result.hasMore,
                totalReturned: result.totalReturned,
                complexity: result.complexity,
                nextCursor: result.nextCursor,
              },
              columns: columnHeads,
            }),
          );
          return;
        }

        // Non-streaming path — collect, project, emit through the
        // standard envelope.
        const result = await paginate<unknown, ItemsPagePayload<unknown>>({
          fetchInitial: initialFetcher(client, parsed.board, parsed.group, queryParams),
          fetchNext: nextFetcher(client),
          now: ctx.clock,
          extractPage: (r) => r.data,
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
