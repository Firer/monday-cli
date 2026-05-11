/**
 * `monday item search [--board <bid> | --workspace <wid> | --favorites]
 * --where ...` — column-value search across one or many boards
 * (`cli-design.md` §5.5 / §13 v0.3 entry, `v0.1-plan.md` §3 M4,
 * `v0.3-plan.md` §3 M23).
 *
 * **v0.1 single-board path (`--board <bid>` set).** Backed by
 * Monday's `items_page_by_column_values` endpoint — a narrower
 * surface than `items_page`'s `query_params.rules`: value-equality
 * only, AND across columns, OR within a column's values. Items
 * matching ANY of the listed values for a given column count as a
 * hit.
 *
 * **v0.3-M23 cross-board path (`--board` omitted; `--workspace <wid>`,
 * `--favorites`, or no scoping lever set — all-accessible-boards
 * mode).** Uses a different shape on the wire: `boards(ids: [...])
 * { items_page(query_params: { rules }) }` fan-out via
 * `src/api/cross-board-search.ts`. Per-board cursors, per-board
 * column resolution, `--max-boards 25` default cap (hard cap 100
 * per Decision 5 closure `3a2f1db`). At most ONE of `--board` /
 * `--workspace` / `--favorites` may be supplied — supplying two
 * raises `usage_error` at the input-schema layer. **Pre-flight stub
 * (M23): the cross-board paths stub-reject with `internal_error`
 * + M23-pending hint; the single-board path stays the existing v0.1
 * runtime body.**
 *
 * Why a separate command from `item list --where`: the endpoints
 * are different. `items_page_by_column_values` is purpose-built for
 * "find items where status=Done" lookups across the whole board,
 * which is faster than walking + filtering when the agent already
 * knows the value. `item list --where` runs the rule against
 * Monday's full filter DSL (any_of, contains_text, comparators,
 * is_empty) but pays the per-page complexity cost.
 *
 * v0.1 single-board operator surface: only the `=` operator is
 * supported via this command. Multiple `--where status=A --where
 * status=B` against the same column merge into one entry with
 * `[A, B]` (OR within column). Multiple columns AND across entries.
 * Anything else (`~=`, `<`, `:is_empty`, etc.) raises `usage_error`
 * — agents pick `item list --where` for the richer surface. Same
 * operator surface applies to the cross-board path.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import {
  DEFAULT_MAX_BOARDS,
  HARD_CAP_MAX_BOARDS,
  crossBoardSearchOutputSchema,
  type CrossBoardSearchOutput,
} from '../../api/cross-board-search.js';
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
import { selectOutput } from '../../utils/output/select.js';
import {
  buildStreamingTrailerMeta,
  startNdjsonStream,
} from '../../utils/output/ndjson.js';
import { collectSecrets } from '../../cli/envelope-out.js';
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

/**
 * The command-registry-facing output schema. Per Codex round-2 P1-1,
 * `monday item search`'s registry-level `outputSchema` is a union of
 * the v0.1 single-board projection (`itemSearchOutputSchema` —
 * `ProjectedItem[]`) AND the v0.3-M23 cross-board projection
 * (`crossBoardSearchOutputSchema` — `CrossBoardItem[]`, each item
 * carrying its source board id+name). The action body emits via
 * the branch-specific schema (single-board uses
 * `itemSearchOutputSchema` for the existing v0.1 path; cross-board
 * uses `crossBoardSearchOutputSchema` at M23 implementation). The
 * UNION here keeps `monday schema item.search` accurate to the
 * runtime output across both branches.
 *
 * **Why a plain union and not a discriminated union.** The two
 * shapes overlap on `id` / `name` but differ on the `board` slot
 * (absent in single-board; required object in cross-board). Adding
 * an explicit `cross_board: true` discriminator to one branch
 * would carry-cost on every cross-board row for marginal agent
 * value (the presence of the `board` slot itself discriminates).
 * Agents that care can check `'board' in item`; agents that just
 * want `id`/`name` consume both shapes uniformly.
 */
export const itemSearchCommandOutputSchema = z.union([
  itemSearchOutputSchema,
  crossBoardSearchOutputSchema,
]);
export type ItemSearchCommandOutput = ItemSearchOutput | CrossBoardSearchOutput;

const inputSchema = z
  .object({
    // v0.1 single-board scoping lever. v0.3-M23 makes this optional
    // — when omitted, one of `workspace` / `favorites` / neither (=
    // all-accessible-boards mode) picks the cross-board path.
    board: BoardIdSchema.optional(),
    // v0.3-M23 cross-board scoping levers (mutually exclusive with
    // `--board` AND with each other per `.superRefine` below).
    workspace: WorkspaceIdSchema.optional(),
    favorites: z.boolean().optional(),
    // v0.3-M23 cross-board fan-out cap (Decision 5 closure
    // `3a2f1db`). Default 25, hard cap 100. Only meaningful when
    // the cross-board path runs; with `--board` the flag is
    // silently ignored. Codex P2-2 fix: the hard-cap enforcement
    // is CONDITIONAL — applied only when `board` is absent (the
    // cross-board path). On the single-board path the v0.1 user-
    // facing contract is "flag is ignored", so we accept any
    // positive integer there to honour that wording rather than
    // rejecting agents that pass the flag harmlessly under
    // `--board`.
    maxBoards: z.coerce.number().int().positive().optional(),
    where: z.array(z.string()).min(1),
    all: z.boolean().optional(),
    limit: z.coerce.number().int().positive().max(10_000).optional(),
    pageSize: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // v0.3-M23 mutual-exclusion rule per cli-design §13 v0.3 entry.
    // At most ONE of `--board` / `--workspace` / `--favorites` may
    // be supplied; supplying two surfaces a usage_error at the
    // parse boundary rather than letting the runtime resolver
    // surface a confusing error.
    //
    // Codex P2-3 fix: the path on the issue is empty (`[]`)
    // because the conflict is about the COMBINATION of fields,
    // not one specific field. The message + an explicit
    // `conflicting_flags` slot in details carries the named
    // levers for agent introspection.
    const scopingLevers = [
      value.board !== undefined ? 'board' : null,
      value.workspace !== undefined ? 'workspace' : null,
      value.favorites === true ? 'favorites' : null,
    ].filter((s): s is string => s !== null);
    if (scopingLevers.length > 1) {
      ctx.addIssue({
        code: 'custom',
        message: `at most one of --board / --workspace / --favorites may be supplied; got: ${scopingLevers.join(', ')}`,
        path: [],
        params: { conflicting_flags: scopingLevers },
      });
    }
    // Codex P2-2 fix: cap only applies on the cross-board path.
    // On the single-board path (board set), `--max-boards` is
    // documented as ignored — accept any positive integer.
    if (
      value.board === undefined &&
      value.maxBoards !== undefined &&
      value.maxBoards > HARD_CAP_MAX_BOARDS
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `--max-boards exceeds the hard cap of ${String(HARD_CAP_MAX_BOARDS)} (wall-clock fan-out latency cap, not a complexity-budget cap; the cap protects against the 30s request timeout per Decision 5 \`3a2f1db\`); narrow the cross-board set with --workspace or --favorites`,
        path: ['maxBoards'],
      });
    }
  });

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
  ItemSearchCommandOutput
> = {
  name: 'item.search',
  summary:
    'Search items by column value (any_of) on one board (v0.1) or across many boards (v0.3-M23 — --workspace / --favorites / no-scoping-lever)',
  examples: [
    "monday item search --board 12345 --where 'status=Done'",
    "monday item search --board 12345 --where 'status=Done' --where 'status=Backlog'",
    'monday item search --board 12345 --where owner=me --json',
    'monday item search --board 12345 --where status=Done --all --output ndjson',
    'monday item search --favorites --where status=Done                     # v0.3-M23',
    'monday item search --workspace 67890 --where status=Done --max-boards 50  # v0.3-M23',
  ],
  idempotent: true,
  inputSchema,
  // Codex round-2 P1-1: command-registry-facing schema is the union
  // of single-board + cross-board projections. The action body emits
  // via the branch-specific schema below (existing v0.1 path uses
  // `itemSearchOutputSchema` directly; M23 cross-board impl uses
  // `crossBoardSearchOutputSchema`). The union keeps
  // `monday schema item.search` accurate across both branches.
  outputSchema: itemSearchCommandOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('search')
      .description(itemSearchCommand.summary)
      // v0.3-M23: `--board` is now optional (v0.1 path still works when
      // supplied; cross-board path runs when omitted). Mutual-exclusion
      // with `--workspace` / `--favorites` enforced at the schema layer
      // (`.superRefine`); missing-all-of-three is treated as
      // "all-accessible-boards" cross-board mode at M23 implementation.
      .option('--board <bid>', 'board ID (v0.1 single-board path; omit for v0.3 cross-board)')
      .option(
        '--workspace <wid>',
        'workspace ID (v0.3-M23 cross-board scoping lever; mutually exclusive with --board / --favorites)',
      )
      .option(
        '--favorites',
        "v0.3-M23 cross-board scoping lever — use the current user's `board favorites` set; mutually exclusive with --board / --workspace",
      )
      .option(
        '--max-boards <n>',
        `v0.3-M23 cross-board fan-out cap (default ${String(DEFAULT_MAX_BOARDS)}, hard cap ${String(HARD_CAP_MAX_BOARDS)}; ignored on the single-board path)`,
      )
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

        // v0.3-M23 cross-board path. Pre-flight stub — reject every
        // cross-board invocation with `internal_error` + M23-pending
        // hint. M23 implementation lands the runtime fan-out walker
        // via `src/api/cross-board-search.ts` + the per-board column-
        // resolution pre-pass + the `board favorites` / `boards
        // (workspace_ids:)` resolver branches.
        if (parsed.board === undefined) {
          // The scoping-lever discrimination is for the M23
          // implementation's hint payload — at pre-flight every
          // branch rejects identically, but the M23 impl will
          // dispatch on the lever so the rejection narrative is
          // plumbed. Command-action stub bodies are NOT c8-wrapped
          // per testing.md — integration tests drive each branch via
          // commander argv and assert on the rejection envelope.
          const lever =
            parsed.workspace !== undefined
              ? 'workspace'
              : parsed.favorites === true
                ? 'favorites'
                : 'all-accessible-boards';
          throw new ApiError(
            'internal_error',
            '`monday item search` cross-board path is a v0.3-M23 pre-flight stub — runtime fan-out lands at M23 implementation.',
            {
              details: {
                scoping_lever: lever,
                max_boards: parsed.maxBoards ?? DEFAULT_MAX_BOARDS,
                hard_cap: HARD_CAP_MAX_BOARDS,
                cap_rationale:
                  'wall-clock fan-out latency cap (~0.5-1.5s per call at small N scaling linearly; N=25 lands ~12-18s under the 30s MONDAY_REQUEST_TIMEOUT_MS default per Decision 5 `3a2f1db` empirical-probe finding)',
                hint: 'M23 implementation kickoff lands the boards(ids:) { items_page(query_params:) } fan-out walker via src/api/cross-board-search.ts; until then, supply --board <bid> to use the v0.1 single-board path.',
              },
            },
          );
        }

        // v0.3-M23: `parsed.board` is now `BoardId | undefined` at
        // the schema layer; the cross-board branch above threw so
        // `board` is `BoardId` here, but the narrowing doesn't carry
        // through inner closures (the `onColumnNotFound` lambda
        // captures the original optional type). Bind to a local
        // before the single-board path so every reference inside
        // closures sees the narrowed type.
        const boardId = parsed.board;

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const meta = await loadBoardMetadata({
          client,
          boardId,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        const clauses = parsed.where.map(parseWhereSyntax);
        const onColumnNotFound =
          meta.source === 'cache'
            ? async (): Promise<BoardMetadata> => {
                const refreshed = await refreshBoardMetadata({
                  client,
                  boardId,
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

        const format = selectOutput({
          json: globalFlags.json,
          table: globalFlags.table,
          ...(globalFlags.output === undefined ? {} : { output: globalFlags.output }),
          env: ctx.env,
          isTTY: ctx.isTTY,
        });

        // Streaming NDJSON path — emit per-arrival, then the §6.3
        // trailer (matches item list's shape; both go through
        // `paginate.onItem` and project through the same
        // `projectFromRaw` callback). Bypasses emitSuccess because
        // the streaming contract requires items hitting stdout
        // before the walk completes. M18.
        if (format === 'ndjson') {
          const stream = startNdjsonStream<unknown>({
            stream: ctx.stdout,
            secrets: collectSecrets(ctx.env, ctx.runtimeSecrets),
            project: (raw) => projectFromRaw(raw, titles, { omitColumnTitles: true }),
          });
          const result = await paginate<unknown, InitialResponse | NextResponse>({
            fetchInitial: initialFetcher(client, boardId, columns),
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
            onItem: stream.onItem,
          });
          // §6.3 trailer-warnings pin: filterWarnings live on the
          // success envelope when the caller picks JSON; in NDJSON
          // they're dropped per the §6.3 "no warnings in trailer"
          // rule. Same shape as item list's streaming branch.
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
