/**
 * `monday item clear` — column-clear with single-item + bulk shapes.
 * (cli-design.md §4.3 line 489 + §10.2; v0.1-plan.md §3 M5b for the
 * single-item path, v0.2-plan.md §3 M12 for bulk `--where`).
 *
 * The dedicated "clear" verb. Per cli-design §5.3 step 3 + the
 * dropdown empty-input rejection in `column-values.ts`, `--set X=`
 * does NOT mean "clear" — it means "set to the empty-string value"
 * which is type-dependent (e.g. `{label: ""}` for status). The
 * dedicated verb is the documented escape and produces the per-type
 * "clear" wire payload:
 *
 *   - `text` / `long_text` / `numbers` → simple bare empty string
 *     (`change_simple_column_value(value: "")`).
 *   - `status` / `dropdown` / `date` / `people` → empty JSON object
 *     `{}` via `change_column_value(value: JSON!)`. Monday's
 *     "clear all column values" pattern.
 *
 * Two argv shapes:
 *
 *   1. **Single-item** (M5b): `monday item clear <iid> <col>
 *      [--board <bid>]`. Positional `<iid>` plus required `<col>`.
 *      `--board` skips the implicit item-board lookup.
 *
 *   2. **Bulk** (M12): `monday item clear --board <bid> <col>
 *      (--where <c>=<v>... | --filter-json <json>) [--yes]
 *      [--dry-run]`. No positional `<iid>` — page-walks `items_page`
 *      with the supplied filter and clears the named column on every
 *      matched item. Mirrors `item update --where`'s shape: bulk
 *      mutations without `--yes` (and without `--dry-run`) surface
 *      `confirmation_required` per cli-design §10.2.
 *
 * **Two paths.** `--dry-run` orchestrates `api/dry-run.ts planClear`
 * (single-token shape — symmetric with planChanges' multi-token shape
 * but one token in / one PlannedChange out). Live writes resolve the
 * column + build the clear payload + select the mutation + fire.
 *
 * **Resolver-warning preservation + cache-stale archived remap.**
 * Identical pattern to `item set` (R19 lift) — translator failures
 * and live `validation_failed` after cache-sourced resolution flow
 * through `foldResolverWarningsIntoError` +
 * `maybeRemapValidationFailedToArchived`. clear has no value-side
 * translator (the payload is `""` / `{}` per type, no user-supplied
 * value to interpret), so the only typed failure path on the live
 * side is Monday's mutation-time rejection — which still benefits
 * from the F4 cache-archived remap.
 *
 * Idempotent: yes — clearing an already-empty cell is a no-op write.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  ApiError,
  ConfirmationRequiredError,
  MondayCliError,
  UsageError,
} from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  selectMutation,
  translateColumnClear,
  type SelectedMutation,
} from '../../api/column-values.js';
import {
  foldAndRemap,
  foldResolverWarningsIntoError,
} from '../../api/resolver-error-fold.js';
import { reThrowDecorated } from '../../api/error-decoration.js';
import { planClear } from '../../api/dry-run.js';
import { resolveBoardId } from '../../api/item-board-lookup.js';
import { buildColumnArchivedError } from '../../api/resolution-pass.js';
import { ITEM_FIELDS_FRAGMENT, resolveMeFactory } from '../../api/item-helpers.js';
import { projectMutationItem as projectMutationItemShared } from '../../api/item-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { buildQueryParams } from '../../api/filters.js';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardMetadata,
} from '../../api/board-metadata.js';
import {
  DEFAULT_PAGE_SIZE,
  paginate,
  type PaginatedPage,
} from '../../api/pagination.js';
import {
  fetchItemsPage,
  fetchNextItemsPage,
  type ItemsPagePayload,
} from '../../api/items-page-walker.js';
import type { Warning } from '../../utils/output/envelope.js';
import type { RunContext } from '../../cli/run.js';
import type { GlobalFlags } from '../../types/global-flags.js';

// Same GraphQL surface as item set (cli-design §5.3 step 5).
// Operation names diverge (`ItemClearSimple` / `ItemClearRich`) so
// fixture cassettes + Monday's request-log telemetry can distinguish
// the source verb. The mutation bodies themselves are identical
// because Monday's `change_simple_column_value` /
// `change_column_value` accept the same arguments regardless of
// which CLI verb originated the call.
const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemClearSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemClearRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}

/**
 * Wrapped data shape for the bulk-clear-live success envelope. Same
 * shape `item update --where` ships — `summary` carries
 * `matched_count` / `applied_count` / `board_id`; `items` is the
 * per-item projected list. Defined here at module top so it's
 * available to the union output schema below.
 */
const bulkLiveDataSchema = z.object({
  summary: z.object({
    matched_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    board_id: z.string(),
  }),
  items: z.array(projectedItemSchema),
});

type BulkLiveData = z.infer<typeof bulkLiveDataSchema>;

/**
 * `item clear`'s `data` is a discriminated union — single-item path
 * emits the §6.2 projected item; bulk path emits `{summary, items}`.
 * `monday schema item.clear` reads this schema, so agents can plan
 * against either shape without surprises (Codex round-1 F4 — pre-fix
 * the schema only described the single-item shape, leaving the bulk
 * surface invisible to schema-driven agents).
 */
export const itemClearOutputSchema = z.union([
  projectedItemSchema,
  bulkLiveDataSchema,
]);
export type ItemClearOutput = z.infer<typeof itemClearOutputSchema>;

/**
 * Input shape — supports both single-item and bulk shapes.
 *
 *   - Single-item: `itemId` positional required; `where` empty.
 *   - Bulk:        `itemId` positional omitted; `where` non-empty
 *                  AND `board` required.
 *
 * Schema accepts both shapes; the dispatch lives in
 * `validateInputShape` below so the action layer reads the
 * discriminator and dispatches.
 */
const inputSchema = z
  .object({
    itemId: ItemIdSchema.optional(),
    column: z.string().min(1),
    board: BoardIdSchema.optional(),
    where: z.array(z.string()).default([]),
    // Empty `--filter-json ''` would slip through `buildQueryParams`
    // as "no filter" while still tripping `validateInputShape`'s "bulk
    // mode" discriminator (`filterJson !== undefined`) — net effect, a
    // whole-board clear an agent likely thought was filtered. Reject
    // at the schema boundary so no network call fires. Same pattern
    // M5b's bulk `item update` ships.
    filterJson: z
      .string()
      .refine(
        (s) => s.trim().length > 0,
        '--filter-json must be a non-empty JSON object',
      )
      .optional(),
  })
  .strict();

type ParsedInput = z.infer<typeof inputSchema>;

/**
 * Discriminates between the single-item and bulk argv shapes per
 * cli-design §10.2. Single-item: positional `<iid>` present, no
 * `--where` / `--filter-json`. Bulk: no positional, `--where` (or
 * `--filter-json`) present, `--board` required.
 */
type DispatchShape =
  | { readonly kind: 'single'; readonly itemId: string }
  | { readonly kind: 'bulk' };

const validateInputShape = (parsed: ParsedInput): DispatchShape => {
  const hasItemId = parsed.itemId !== undefined;
  const hasFilter = parsed.where.length > 0 || parsed.filterJson !== undefined;
  if (hasItemId && hasFilter) {
    throw new UsageError(
      'item clear accepts either a positional <itemId> OR --where / ' +
        '--filter-json (bulk shape), not both. Pick one.',
      {
        details: {
          item_id: parsed.itemId,
          where_count: parsed.where.length,
          ...(parsed.filterJson === undefined
            ? {}
            : { filter_json: parsed.filterJson }),
        },
      },
    );
  }
  if (!hasItemId && !hasFilter) {
    throw new UsageError(
      'item clear requires either a positional <itemId> or --where / ' +
        '--filter-json for the bulk shape.',
      { details: {} },
    );
  }
  if (hasFilter && parsed.board === undefined) {
    throw new UsageError(
      'item clear --where / --filter-json requires --board <bid>. The ' +
        'bulk shape walks Monday\'s items_page on the named board.',
      { details: { where_count: parsed.where.length } },
    );
  }
  if (hasItemId) {
    /* c8 ignore next 4 — defensive: hasItemId === true means
       parsed.itemId is non-undefined; the type guard exists for TS. */
    if (parsed.itemId === undefined) {
      throw new UsageError('item clear: itemId narrowing failed');
    }
    return { kind: 'single', itemId: parsed.itemId };
  }
  return { kind: 'bulk' };
};

export const itemClearCommand: CommandModule<ParsedInput, ItemClearOutput> = {
  name: 'item.clear',
  summary: 'Clear a column value on an item (single or bulk via --where)',
  examples: [
    'monday item clear 12345 status',
    'monday item clear 12345 status --board 67890',
    'monday item clear 12345 due --dry-run',
    "monday item clear status --board 67890 --where 'status=Done' --yes",
    "monday item clear status --board 67890 --where 'status=Done' --dry-run",
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemClearOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      // Two-positional declaration with the second optional. When
      // both are present, the first is the itemId and the second is
      // the column (single-item shape). When only one is present,
      // it's the column (bulk shape; --board + --where required).
      // The action body normalises the positionals before dispatch.
      .command('clear <arg1> [arg2]')
      .description(itemClearCommand.summary)
      .option('--board <bid>', 'board ID (required for bulk; skip lookup for single-item)')
      .option(
        '--where <expr>',
        'repeatable bulk filter (cli-design §10.2): <col><op><val>',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--filter-json <json>', 'literal Monday query_params for bulk')
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemClearCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(
        async (arg1: unknown, arg2: unknown, opts: unknown) => {
          // Normalise positionals: one positional → bulk shape
          // (arg1=column); two positionals → single-item shape
          // (arg1=itemId, arg2=column). Defer empty / type checks to
          // zod by passing through verbatim.
          const positional =
            arg2 === undefined
              ? { itemId: undefined, column: arg1 }
              : { itemId: arg1, column: arg2 };
          const parsed = parseArgv(itemClearCommand.inputSchema, {
            ...(positional.itemId === undefined
              ? {}
              : { itemId: positional.itemId }),
            column: positional.column,
            ...(opts as Readonly<Record<string, unknown>>),
          });
          const { client, globalFlags, apiVersion, toEmit } = resolveClient(
            ctx,
            program.opts(),
          );

          const dispatch = validateInputShape(parsed);
          if (dispatch.kind === 'bulk') {
            await runBulk({
              parsed,
              client,
              globalFlags,
              apiVersion,
              ctx,
              programOpts: program.opts(),
            });
            return;
          }

          const boardId = await resolveBoardId({
            client,
            itemId: dispatch.itemId,
            explicit: parsed.board,
          });

        if (globalFlags.dryRun) {
          const result = await planClear({
            client,
            boardId,
            itemId: dispatch.itemId,
            token: parsed.column,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live clear path. Resolution + clear-payload build + mutation.
        const resolution = await resolveColumnWithRefresh({
          client,
          boardId,
          token: parsed.column,
          includeArchived: true,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const resolverWarnings: readonly ResolverWarning[] = resolution.warnings;

        if (resolution.match.column.archived === true) {
          throw foldResolverWarningsIntoError(
            buildColumnArchivedError({
              columnId: resolution.match.column.id,
              columnTitle: resolution.match.column.title,
              columnType: resolution.match.column.type,
              boardId,
            }),
            resolverWarnings,
          );
        }

        let mutationResult;
        try {
          const translated = translateColumnClear({
            id: resolution.match.column.id,
            type: resolution.match.column.type,
          });
          const mutation: SelectedMutation = selectMutation([translated]);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: dispatch.itemId,
            boardId,
          });
        } catch (err) {
          /* c8 ignore next 4 — defensive: every error from the SDK
             transport is wrapped in MondayCliError; the
             non-MondayCliError fallthrough is reserved for
             transport-layer bugs. */
          if (!(err instanceof MondayCliError)) {
            throw err;
          }
          throw await foldAndRemap({
            err,
            warnings: resolverWarnings,
            client,
            boardId,
            columnIds: [resolution.match.column.id],
            env: ctx.env,
            noCache: globalFlags.noCache,
            resolutionSource: resolution.source,
          });
        }

        const warnings: readonly Warning[] = resolverWarnings;

        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemClearCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: resolution.source === 'cache' ? 'mixed' : resolution.source,
          cacheAgeSeconds: resolution.cacheAgeSeconds,
          // cli-design §5.3 step 2: echo resolved column ID per
          // agent input token. Same shape `item set` uses.
          resolvedIds: { [parsed.column]: resolution.match.column.id },
        });
        },
      );
  },
};

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

const executeMutation = async (
  client: MondayClient,
  inputs: {
    readonly mutation: SelectedMutation;
    readonly itemId: string;
    readonly boardId: string;
  },
): Promise<MutationExecResult> => {
  const { mutation, itemId, boardId } = inputs;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
      },
      { operationName: 'ItemClearSimple' },
    );
    assertResponseFieldPresent({
      data: response.data,
      key: 'change_simple_column_value',
      operationLabel: 'ItemClearSimple',
      details: { item_id: itemId, board_id: boardId },
      nullHandling: 'caller_handles',
    });
    return {
      projected: projectMutationItem(response.data.change_simple_column_value, itemId),
      response,
    };
  }
  /* c8 ignore start — defensive: selectMutation only emits the
     multi kind for >1 translated values; clear is single-column by
     argv shape, so the multi fallthrough is unreachable. The branch
     conditional below is wrapped in the same c8 ignore so the false
     arm doesn't drag branch coverage either. */
  if (mutation.kind !== 'change_column_value') {
    throw new ApiError(
      'internal_error',
      `item clear selected ${mutation.kind} but only the single-column ` +
        `mutations are supported here.`,
      { details: { mutation_kind: mutation.kind, item_id: itemId } },
    );
  }
  /* c8 ignore stop */
  const response = await client.raw<ChangeColumnResponse>(
    CHANGE_COLUMN_VALUE_MUTATION,
    {
      itemId,
      boardId,
      columnId: mutation.columnId,
      value: mutation.value,
    },
    { operationName: 'ItemClearRich' },
  );
  assertResponseFieldPresent({
    data: response.data,
    key: 'change_column_value',
    operationLabel: 'ItemClearRich',
    details: { item_id: itemId, board_id: boardId },
    nullHandling: 'caller_handles',
  });
  return {
    projected: projectMutationItem(response.data.change_column_value, itemId),
    response,
  };
};

// Thin wrapper around `api/item-mutation-result.ts projectMutationItem`
// (R28). M5b's `internal_error` + "no item payload" semantics for an
// empty-payload mutation success are preserved; the wrapper keeps the
// existing `(raw, itemId)` call signature so the executeMutation arms
// stay untouched.
const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem =>
  projectMutationItemShared({
    raw,
    itemId,
    errorCode: 'internal_error',
    errorMessage:
      `Monday returned no item payload from the mutation for id ${itemId}.`,
  });

// ============================================================
// Bulk path (cli-design §10.2 — `--where` / `--filter-json`).
// Mirrors `item update --where`'s runBulk shape verbatim — same
// items_page walker (lifted into `api/items-page-walker.ts` per
// §18 R34 post-M12), same confirmation gate, same per-item failure
// decoration. The single-column scope keeps the pipeline thinner
// (one column to resolve, one clear payload to build, one mutation
// per item) but the orchestration shape is identical.
// ============================================================

// Tight per-row schema. The shared walker wraps it in the
// `items_page` envelope; schema drift surfaces as `internal_error`
// with the failing field path on `details.issues` rather than
// collapsing to a silent "0 matched, 0 applied" success.
const bulkItemSchema = z.object({ id: ItemIdSchema }).loose();
type BulkItem = z.infer<typeof bulkItemSchema>;

// `bulkLiveDataSchema` + `BulkLiveData` are defined at module top
// (next to `itemClearOutputSchema`) so the union shape is the single
// source of truth `monday schema item.clear` reads.

interface RunBulkInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly globalFlags: GlobalFlags;
  readonly apiVersion: string;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
}

/**
 * Bulk clear orchestrator (cli-design §10.2). Walks `items_page` to
 * collect every matched item, then dispatches the same way bulk
 * `item update --where` does:
 *
 *   1. Without `--yes` AND without `--dry-run` → throw
 *      `confirmation_required` with the matched count.
 *   2. With `--dry-run` → per-item `planClear` → emit N-element
 *      `planned_changes` array.
 *   3. With `--yes` (and not `--dry-run`) → per-item live mutation.
 *      Fail-fast on first error; the error envelope's
 *      `details.applied_to` lists IDs of items cleared before the
 *      failure.
 *
 * **Sequential execution.** cli-design §9.3 mandates one-at-a-time
 * requests in v0.1-v0.3; the per-item loop respects that.
 */
const runBulk = async (inputs: RunBulkInputs): Promise<void> => {
  const { parsed, client, globalFlags, apiVersion, ctx, programOpts } = inputs;
  /* c8 ignore next 6 — defensive: validateInputShape guarantees
     parsed.board is non-undefined when shape is bulk; the type guard
     exists for TS. */
  if (parsed.board === undefined) {
    throw new UsageError('item clear bulk path: --board is required');
  }
  const boardId = parsed.board;

  // 1) Load board metadata (cache-aware, refresh on column-not-found
  //    during filter parsing per §5.3 step 5). The per-item planClear
  //    / resolveColumnWithRefresh calls reuse the populated cache.
  const meta = await loadBoardMetadata({
    client,
    boardId,
    env: ctx.env,
    noCache: globalFlags.noCache,
  });
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

  const filterResult = await buildQueryParams({
    metadata: meta.metadata,
    resolveMe: resolveMeFactory(client),
    whereClauses: parsed.where,
    filterJson: parsed.filterJson,
    ...(onColumnNotFound === undefined ? {} : { onColumnNotFound }),
  });

  // 2) Walk items_page collecting matched item IDs. The §18 R34
  //    helper (`fetchItemsPage` / `fetchNextItemsPage`) supplies the
  //    GraphQL + parse boundary; `paginate.ts` keeps the §3.1 #8
  //    per-page sort + §5.6 `stale_cursor` enrichment. Same pattern
  //    `item list` uses post-lift.
  const matchedItemIds: string[] = [];
  await paginate<BulkItem, ItemsPagePayload<BulkItem>>({
    fetchInitial: () =>
      fetchItemsPage<BulkItem>({
        client,
        operationName: 'ItemsPage',
        boardId,
        limit: DEFAULT_PAGE_SIZE,
        queryParams: filterResult.queryParams,
        itemFields: 'id',
        itemSchema: bulkItemSchema,
      }),
    fetchNext: (cursor) =>
      fetchNextItemsPage<BulkItem>({
        client,
        operationName: 'NextItemsPage',
        cursor,
        limit: DEFAULT_PAGE_SIZE,
        itemFields: 'id',
        itemSchema: bulkItemSchema,
      }),
    now: ctx.clock,
    extractPage: (r): PaginatedPage<BulkItem> => r.data,
    getId: (item) => item.id,
    all: true,
    onItem: (item) => {
      matchedItemIds.push(item.id);
    },
  });

  // 3) Empty match set — both dry-run and live are clean no-ops.
  //    Same handling as bulk update — emit a success envelope before
  //    the confirmation gate fires (`--yes` shouldn't be required to
  //    confirm "no items matched"). Filter warnings still surface.
  const emptyEnvelopeSource: 'live' | 'cache' | 'mixed' =
    meta.source === 'cache' ? 'mixed' : 'live';
  if (matchedItemIds.length === 0) {
    if (globalFlags.dryRun) {
      emitDryRun({
        ctx,
        programOpts,
        plannedChanges: [],
        source: emptyEnvelopeSource,
        cacheAgeSeconds: meta.cacheAgeSeconds,
        warnings: filterResult.warnings,
        apiVersion,
      });
      return;
    }
    emitMutation({
      ctx,
      data: {
        summary: { matched_count: 0, applied_count: 0, board_id: boardId },
        items: [],
      } satisfies BulkLiveData,
      schema: itemClearOutputSchema,
      programOpts,
      warnings: filterResult.warnings,
      source: emptyEnvelopeSource,
      cacheAgeSeconds: meta.cacheAgeSeconds,
      apiVersion,
    });
    return;
  }

  // 4) Confirmation gate. Bulk clears without --yes (and without
  //    --dry-run) surface `confirmation_required` per §3.1 #7 +
  //    §6.5. Same shape bulk update uses.
  if (!globalFlags.dryRun && !globalFlags.yes) {
    throw new ConfirmationRequiredError(
      `Bulk item clear would mutate ${String(matchedItemIds.length)} ` +
        `matched item(s). Re-run with --yes to confirm, or --dry-run to ` +
        `preview.`,
      {
        details: {
          board_id: boardId,
          matched_count: matchedItemIds.length,
          where_clauses: parsed.where,
          ...(parsed.filterJson === undefined
            ? {}
            : { filter_json: parsed.filterJson }),
          hint:
            'Use --dry-run to inspect the planned_changes for every ' +
            'matched item before applying.',
        },
      },
    );
  }

  // 5) Dry-run path: per-item planClear. Same shape bulk update's
  //    dry-run uses — N planned_changes aggregated into one array,
  //    deduped warnings, source aggregated across legs.
  if (globalFlags.dryRun) {
    const allPlanned: Readonly<Record<string, unknown>>[] = [];
    const aggregatedWarnings: Warning[] = [...filterResult.warnings];
    const sourceAgg = new SourceAggregator({
      source: meta.source,
      cacheAgeSeconds: meta.cacheAgeSeconds,
    });
    for (const itemId of matchedItemIds) {
      const result = await planClear({
        client,
        boardId,
        itemId,
        token: parsed.column,
        env: ctx.env,
        noCache: globalFlags.noCache,
      });
      for (const plan of result.plannedChanges) {
        allPlanned.push(plan as unknown as Readonly<Record<string, unknown>>);
      }
      for (const w of result.warnings) {
        aggregatedWarnings.push(w);
      }
      sourceAgg.record(result.source, result.cacheAgeSeconds);
    }
    emitDryRun({
      ctx,
      programOpts,
      plannedChanges: allPlanned,
      ...sourceAgg.result(),
      warnings: dedupeWarnings(aggregatedWarnings),
      apiVersion,
    });
    return;
  }

  // 6) Live path: resolve the column once + per-item clear. The
  //    column resolves against the shared metadata view; the
  //    archived-column gate fires before any mutation.
  const resolution = await resolveColumnWithRefresh({
    client,
    boardId,
    token: parsed.column,
    includeArchived: true,
    env: ctx.env,
    noCache: globalFlags.noCache,
  });
  const resolverWarnings: readonly ResolverWarning[] = resolution.warnings;

  if (resolution.match.column.archived === true) {
    throw foldResolverWarningsIntoError(
      buildColumnArchivedError({
        columnId: resolution.match.column.id,
        columnTitle: resolution.match.column.title,
        columnType: resolution.match.column.type,
        boardId,
      }),
      resolverWarnings,
    );
  }

  // SourceAggregator seeds with the metadata leg + records the
  // resolution leg + the per-item mutations (always live). Mirrors
  // bulk update's aggregation shape.
  const sourceAgg = new SourceAggregator({
    source: meta.source,
    cacheAgeSeconds: meta.cacheAgeSeconds,
  });
  sourceAgg.record(resolution.source, resolution.cacheAgeSeconds);

  const translated = translateColumnClear({
    id: resolution.match.column.id,
    type: resolution.match.column.type,
  });
  const mutation: SelectedMutation = selectMutation([translated]);
  const appliedItems: ProjectedItem[] = [];
  const remapColumnIds: readonly string[] = [resolution.match.column.id];

  for (const itemId of matchedItemIds) {
    try {
      const result = await executeMutation(client, {
        mutation,
        itemId,
        boardId,
      });
      appliedItems.push(result.projected);
    } catch (err) {
      /* c8 ignore next 4 — defensive: every error from the SDK
         transport is wrapped in MondayCliError; the non-MondayCliError
         fallthrough is reserved for transport-layer bugs. */
      if (!(err instanceof MondayCliError)) {
        throw err;
      }
      // Same fold + remap shape bulk update uses (Codex M5b
      // finding #3 + pass-1 F3). column_archived remap, then
      // bulk-progress decoration.
      {
        const remapped = await foldAndRemap({
          err,
          warnings: resolverWarnings,
          client,
          boardId,
          columnIds: remapColumnIds,
          env: ctx.env,
          noCache: globalFlags.noCache,
          resolutionSource: resolution.source,
        });
        /* c8 ignore next — defensive: foldAndRemap copies the
           original error's details unchanged when the remap
           preconditions don't fire; details is therefore always a
           defined record. The fallback covers the contrived no-
           details edge case. */
        const existing = remapped.details ?? {};
        // The typed split (usage_error → UsageError, else → ApiError)
        // plus the conditional wire-metadata spreads now live in the
        // shared `reThrowDecorated` helper (R-v0.7-NEW-5); bulk clear
        // assembles its own bulk-progress decoration and delegates.
        // The usage_error arm is unreachable here (bulk clear has no
        // --set / --set-raw to translate) but the helper covers both
        // arms in its focused unit test, so this site no longer needs
        // the c8-ignore the inlined split carried.
        reThrowDecorated(remapped, {
          ...existing,
          applied_count: appliedItems.length,
          applied_to: appliedItems.map((i) => i.id),
          failed_at_item: itemId,
          matched_count: matchedItemIds.length,
        });
      }
    }
  }

  // Per-item mutations always fire live; record one terminal `live`
  // leg so cache-served metadata + live mutations collapse to
  // `mixed`. Mirrors bulk update's tail record pattern.
  sourceAgg.record('live', null);
  const aggregatedWarnings: readonly Warning[] = [
    ...filterResult.warnings,
    ...resolverWarnings,
  ];
  emitMutation({
    ctx,
    data: {
      summary: {
        matched_count: matchedItemIds.length,
        applied_count: appliedItems.length,
        board_id: boardId,
      },
      items: appliedItems,
    } satisfies BulkLiveData,
    schema: itemClearOutputSchema,
    programOpts,
    warnings: aggregatedWarnings,
    ...sourceAgg.result(),
    apiVersion,
    resolvedIds: { [parsed.column]: resolution.match.column.id },
  });
};

/**
 * Bulk dry-run aggregates per-item resolver warnings — the same
 * `stale_cache_refreshed` / `column_token_collision` signals fire
 * once per item the first time they're triggered (subsequent items
 * hit the now-warm cache). De-duplicates by `code + message +
 * details.token` so an agent reading the dry-run envelope sees each
 * unique warning once. Order-preserving: the first occurrence wins.
 *
 * Same shape bulk update's dedupeWarnings uses.
 */
const dedupeWarnings = (warnings: readonly Warning[]): readonly Warning[] => {
  const seen = new Set<string>();
  const out: Warning[] = [];
  for (const w of warnings) {
    const tokenKey =
      typeof w.details?.token === 'string'
        ? w.details.token
        : '';
    const key = `${w.code}|${w.message}|${tokenKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
};
