/**
 * `monday item update <iid> [--name <n>] [--set <col>=<val>]...` —
 * multi-column atomic update + optional rename.
 * (`cli-design.md` §4.3 line 490, §5.3, `v0.1-plan.md` §3 M5b).
 *
 * Two argv shapes:
 *
 *   1. **Single-item** (this commit): positional `<itemId>` +
 *      repeatable `--set <col>=<val>` + optional `--name <n>`.
 *      Multi-`--set` (≥2) bundles into one
 *      `change_multiple_column_values` mutation (atomic on Monday's
 *      side per §5.3 step 5). `--name` rolls into the same multi
 *      mutation when columns are also present, otherwise fires a
 *      dedicated `change_simple_column_value(column_id: "name", ...)`.
 *
 *   2. **Bulk** (next commit): `--where <expr>` repeatable + no
 *      positional `<itemId>` — applies the same `--set` / `--name`
 *      bundle to every matching item via Monday's `items_page`
 *      walker. `confirmation_required` fires without `--yes` (and
 *      without `--dry-run`) per cli-design §10.2.
 *
 * **`--name` + `--set` atomicity.** Per cli-design §5.3 step 5, the
 * design promises atomicity for multi-column updates. Bundling the
 * name into the multi mutation keeps the same atomicity guarantee
 * for `--name + --set`. Monday's
 * `change_multiple_column_values(column_values: JSON!)` accepts
 * `name` as a special key in the map. The dry-run engine produces
 * a single `PlannedChange` whose `diff` includes both column keys
 * and a `name` key when both are passed.
 *
 * **`--name` only.** Single field → `change_simple_column_value(
 * column_id: "name", value: <n>)`. Atomic by default (single
 * mutation).
 *
 * **`--create-labels-if-missing`** (cli-design §4.3) — passes
 * through to Monday's `change_*_column_value(create_labels_if_missing:
 * true)`. Tells Monday to auto-create unknown status / dropdown
 * labels rather than rejecting with `validation_failed`. Off by
 * default; agents who want labels-on-demand pass the flag
 * explicitly.
 *
 * Idempotent: yes — `change_*` mutations are idempotent. Multi-set
 * is also idempotent (re-running with the same args produces the
 * same item state).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient } from '../../api/client.js';
import {
  selectMutation,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import { executeItemMutation } from '../../api/item-mutation-execute.js';
import {
  enforceSingleFileColumnSet,
  executeFileColumnSet,
  fileColumnSetOutputSchema,
  type FileColumnSetOutput,
} from '../../api/file-column-set.js';
import { precheckLocalFile } from '../../utils/file-source.js';
import { invalidateBoard } from '../../api/cache.js';
import type { MultipartTransport } from '../../api/multipart-transport.js';
import type { EmitFromNetworkResult } from '../../api/resolve-client.js';
import type { MondayResponse } from '../../api/client.js';
import {
  parseSetRawExpression,
  type ParsedSetRawExpression,
} from '../../api/raw-write.js';
import { splitSetExpression } from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import { resolveBoardId } from '../../api/item-board-lookup.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { resolveAndTranslate } from '../../api/resolution-pass.js';
import { foldAndRemap } from '../../api/resolver-error-fold.js';
import { planChanges } from '../../api/dry-run.js';
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
import {
  ConfirmationRequiredError,
} from '../../utils/errors.js';
import type { RunContext } from '../../cli/run.js';
import type { GlobalFlags } from '../../types/global-flags.js';
import { resolveMeFactory } from '../../api/item-helpers.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import {
  runPartialSuccessBulkUpdate,
  buildPartialSuccessBulkSummary,
  partialSuccessBulkUpdateDataSchema,
  PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE,
  type PartialSuccessBulkUpdateData,
} from '../../api/partial-success-bulk.js';
import {
  MIN_CONCURRENCY,
  MAX_CONCURRENCY,
} from '../../api/parallel-dispatch.js';
import type { Warning } from '../../utils/output/envelope.js';

/**
 * Output envelope union — projected-item for the JSON translator
 * path (text / status / dropdown / date / people / etc.) +
 * file-dispatch envelope for the v0.6-M38 friendly `--set
 * <file-col>=<path>` path (single-item shape only; bulk file
 * dispatch rejects per D5). Agents discriminate on the `operation`
 * field: present (`'add_file_to_column'`) → file dispatch shape;
 * absent → projected-item shape.
 */
export const itemUpdateOutputSchema = z.union([
  projectedItemSchema,
  fileColumnSetOutputSchema,
]);
export type ItemUpdateOutput = ProjectedItem | FileColumnSetOutput;

/**
 * Input shape — supports both single-item and bulk shapes.
 *
 *   - Single-item: `itemId` positional required; `where` empty.
 *   - Bulk:        `itemId` positional omitted; `where` non-empty
 *                  AND `board` required.
 *
 * The split lives in `validateInputShape` (action body) so the zod
 * schema captures the union without the per-shape conditional logic
 * — the action layer reads the discriminator and dispatches.
 */
const inputSchema = z
  .object({
    itemId: ItemIdSchema.optional(),
    set: z.array(z.string()).default([]),
    // M8: --set-raw <col>=<json>... repeatable raw escape hatch.
    // Mutually exclusive per-column with --set; the duplicate-ID
    // check fires in the dry-run engine + selectMutation per
    // cli-design §5.3 line 961-972 (resolution-time, not parse-time).
    setRaw: z.array(z.string()).default([]),
    name: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
    where: z.array(z.string()).default([]),
    // Empty `--filter-json ''` would slip through `buildQueryParams`
    // as "no filter" (`hasFilterJson` is gated on `length > 0`) while
    // still tripping `validateInputShape`'s "bulk mode" discriminator
    // (`filterJson !== undefined`) — net effect, a whole-board mutation
    // an agent likely thought was filtered. Reject at the schema
    // boundary so no network call fires. Codex pass-3 of the §10.2
    // backfill PR caught this — see v0.1-plan §3 M5b session 4.
    //
    // `.refine(trim)` rather than `.min(1)` so a whitespace-only
    // `--filter-json '   '` is also caught at the schema boundary;
    // pre-fix it slipped past `.min(1)` and only failed inside
    // `parseFilterJson` AFTER board metadata loaded — same
    // ultimate `usage_error`, but a wasted network call (Codex
    // pass-1 of this fix).
    filterJson: z
      .string()
      .refine(
        (s) => s.trim().length > 0,
        '--filter-json must be a non-empty JSON object',
      )
      .optional(),
    createLabelsIfMissing: z.boolean().optional(),
    // M25 pre-flight (cli-design §6.4 "Bulk per-item partial-success"
    // sub-section). Opt-in to the partial-success bulk envelope on
    // `--where` / `--filter-json` shapes; the v0.1 fail-fast default
    // is preserved when the flag is absent. Decision 6 closed at the
    // M25 pre-flight contract diff — positive form (`--continue-on-
    // error`) keeps the flag self-describing without an agent having
    // to remember which side of the default the negative-form
    // (`--no-fail-fast`) flips.
    //
    // Argv-parse-time validation: the flag is only meaningful on
    // bulk shapes (single-item update has no per-item-failure
    // surface — a single-item failure IS the whole-call failure).
    // `validateInputShape` rejects `--continue-on-error` on the
    // single-item path with a `usage_error`.
    continueOnError: z.boolean().optional(),
    // v0.4-M30 pre-flight (cli-design §6.4 "Bulk per-item
    // partial-success — Parallel dispatch" + §9.3). Opt-in to
    // bounded parallel per-item dispatch under
    // `--continue-on-error`. `undefined` or `1` preserves the
    // M25 sequential path verbatim; `> 1` routes through
    // {@link dispatchParallel} (stub at pre-flight, runtime at
    // M30 IMPL). Range pinned at argv-parse-time to
    // `[MIN_CONCURRENCY, MAX_CONCURRENCY]` (1..32) — under any
    // plausible Monday per-account cap (cli-design §2.5).
    //
    // `validateInputShape` rejects `--concurrency` on the
    // single-item path AND rejects `--concurrency` without
    // `--continue-on-error` (the fail-fast bulk path doesn't
    // have a defined "abort N in-flight" semantic at M30; that's
    // explicitly deferred per v0.4-plan §8 D2 closure).
    concurrency: z.coerce
      .number()
      .int('--concurrency must be an integer')
      .min(MIN_CONCURRENCY, `--concurrency must be ≥ ${String(MIN_CONCURRENCY)}`)
      .max(MAX_CONCURRENCY, `--concurrency must be ≤ ${String(MAX_CONCURRENCY)}`)
      .optional(),
  })
  .strict()
  // At least one of --set / --set-raw / --name must be provided. An
  // empty call (`monday item update 12345`) is meaningless and would
  // produce a zero-mutation envelope that surprises agents. M8 widens
  // the rule to include --set-raw.
  .refine(
    (v) => v.set.length > 0 || v.setRaw.length > 0 || v.name !== undefined,
    {
      message:
        'item update requires at least one of --set / --set-raw / --name',
      path: ['set'],
    },
  );

type ParsedInput = z.infer<typeof inputSchema>;

/**
 * Discriminates between the single-item and bulk argv shapes per
 * cli-design §10.2. Single-item: positional `<iid>` present, no
 * `--where` / `--filter-json`. Bulk: no positional, `--where` (or
 * `--filter-json`) present, `--board` required. Either side: at
 * least one of `--set` / `--name` (already enforced by the zod
 * refinement above).
 */
type DispatchShape =
  | { readonly kind: 'single'; readonly itemId: string }
  | { readonly kind: 'bulk' };

const validateInputShape = (parsed: ParsedInput): DispatchShape => {
  const hasItemId = parsed.itemId !== undefined;
  const hasFilter = parsed.where.length > 0 || parsed.filterJson !== undefined;
  if (hasItemId && hasFilter) {
    throw new UsageError(
      'item update accepts either a positional <itemId> OR --where / ' +
        '--filter-json (bulk shape), not both. Pick one.',
      { details: { item_id: parsed.itemId, where_count: parsed.where.length } },
    );
  }
  if (!hasItemId && !hasFilter) {
    throw new UsageError(
      'item update requires either a positional <itemId> or --where / ' +
        '--filter-json for the bulk shape.',
      { details: {} },
    );
  }
  if (hasFilter && parsed.board === undefined) {
    throw new UsageError(
      'item update --where / --filter-json requires --board <bid>. The ' +
        'bulk shape walks Monday\'s items_page on the named board.',
      { details: { where_count: parsed.where.length } },
    );
  }
  if (hasItemId) {
    if (parsed.continueOnError === true) {
      throw new UsageError(
        '--continue-on-error is only valid on the bulk shape (--where / ' +
          '--filter-json). Single-item update has no per-item-failure ' +
          'surface — a single-item failure IS the whole-call failure.',
        { details: { item_id: parsed.itemId } },
      );
    }
    if (parsed.concurrency !== undefined) {
      throw new UsageError(
        '--concurrency is only valid on the bulk partial-success path ' +
          '(--where / --filter-json + --continue-on-error). Single-item ' +
          'update has no per-item dispatch loop to parallelise.',
        { details: { item_id: parsed.itemId } },
      );
    }
    /* c8 ignore next 4 — defensive: hasItemId === true means
       parsed.itemId is non-undefined; the type guard exists for TS. */
    if (parsed.itemId === undefined) {
      throw new UsageError('item update: itemId narrowing failed');
    }
    return { kind: 'single', itemId: parsed.itemId };
  }
  // v0.4-M30 D2 closure: `--concurrency` requires `--continue-on-error`.
  // The fail-fast bulk path (cli-design §6.4 default + §6.5 "Bulk per-
  // item failure") doesn't have a well-defined "abort N in-flight"
  // semantic — the first per-item error aborts the loop today, and a
  // parallel variant would need to decide which in-flight calls to
  // cancel + how to report `details.applied_to` against a non-
  // sequential dispatch order. That extension is deferred; M30 lands
  // only the partial-success-bulk parallel path where the universal
  // partial-success rule (cli-design §6.1) makes "let every in-flight
  // dispatch complete and capture per-record outcomes" unambiguous.
  if (parsed.concurrency !== undefined && parsed.continueOnError !== true) {
    throw new UsageError(
      '--concurrency requires --continue-on-error. The fail-fast bulk ' +
        'path does not yet support parallel dispatch (deferred per ' +
        'v0.4-plan M30 D2). Either drop --concurrency or add ' +
        '--continue-on-error to opt in to the partial-success envelope.',
      {
        details: {
          concurrency: parsed.concurrency,
        },
      },
    );
  }
  return { kind: 'bulk' };
};

export const itemUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemUpdateOutput
> = {
  name: 'item.update',
  summary: 'Update one or more columns on an item (atomic)',
  examples: [
    'monday item update 12345 --set status=Done',
    'monday item update 12345 --set status=Done --set owner=alice@example.com',
    'monday item update 12345 --name "New title"',
    'monday item update 12345 --name "New title" --set status=Done',
    'monday item update 12345 --set tags=Backend,Frontend --create-labels-if-missing',
    'monday item update 12345 --set status=Done --dry-run --json',
    "monday item update 12345 --set-raw status='{\"label\":\"Done\"}'",
    "monday item update 12345 --set status=Done --set-raw tags_1='{\"tag_ids\":[1,2]}'",
    'monday item update --board 67890 --where status=Backlog --set status=Working --continue-on-error --concurrency 8 --yes',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('update [itemId]')
      .description(itemUpdateCommand.summary)
      .option(
        '--set <expr>',
        'repeatable <col>=<val> column write',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option(
        '--set-raw <expr>',
        'repeatable <col>=<json> raw write (escape hatch — bypasses friendly translator)',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--name <n>', 'rename the item')
      .option('--board <bid>', 'board ID (required for bulk; skip lookup for single-item)')
      .option(
        '--where <expr>',
        'repeatable bulk filter (cli-design §10.2): <col><op><val>',
        (value: string, prev: readonly string[]) => [...prev, value],
        [] as readonly string[],
      )
      .option('--filter-json <json>', 'literal Monday query_params for bulk')
      // `--yes` is a GLOBAL flag (`src/cli/program.ts`); read it via
      // `globalFlags.yes` rather than redeclaring on this subcommand
      // so the flag stays single-source-of-truth across every M5b /
      // M6 mutation surface (and so commander doesn't dispatch the
      // value to a per-subcommand slot that diverges from the
      // global one).
      .option(
        '--create-labels-if-missing',
        'auto-create unknown status / dropdown labels (Monday flag)',
      )
      .option(
        '--continue-on-error',
        'bulk only: attempt every matched item and emit a partial-success envelope with per-item {item_id, ok, error?} records (v0.3-M25)',
      )
      .option(
        '--concurrency <n>',
        `bulk + --continue-on-error only: fan out at most N (${String(MIN_CONCURRENCY)}..${String(MAX_CONCURRENCY)}) per-item dispatches in parallel; default 1 = sequential (v0.4-M30)`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(itemUpdateCommand.inputSchema, {
          ...(itemId === undefined ? {} : { itemId }),
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, multipart, toEmit } =
          resolveClient(ctx, program.opts());

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

        // Argv-parse-time failures fire BEFORE board lookup / metadata
        // fetch. Splits + JSON parse run on pure strings; surfacing here
        // means a malformed --set or --set-raw fails fast without
        // burning an `ItemBoardLookup` round-trip when `--board` was
        // omitted (Codex M8 finding #4 — pre-fix this parse ran AFTER
        // resolveBoardId, contradicting the argv-boundary contract used
        // by `item set` and the bulk path).
        const setEntries = parsed.set.map(splitSetExpression);
        const rawEntries: readonly ParsedSetRawExpression[] =
          parsed.setRaw.map(parseSetRawExpression);

        const boardId = await resolveBoardId({
          client,
          itemId: dispatch.itemId,
          explicit: parsed.board,
        });

        const { dateResolution, peopleResolution, tagResolution, relationResolution } =
          buildResolutionContexts({ client, ctx, globalFlags });

        if (globalFlags.dryRun) {
          // v0.6-M38 catch-and-route: planChanges' translator
          // surfaces `unsupported_column_type` with
          // `details.type === 'file'` for files-shaped columns;
          // the action body intercepts that rejection and routes
          // through the M38 mutex check + D4 dry-run envelope.
          // Cleanly handles all four mutex outcomes (clean
          // single-item / multi-file / mixed-set-and-other / no-op
          // for non-file paths). Mirrors `item set` dry-run's
          // catch-and-rewrap pattern (cli-design §5.3 step 5 + D4
          // closure; R-v0.6-NEW-4 documents the shim).
          let result;
          try {
            result = await planChanges({
              client,
              boardId,
              itemId: dispatch.itemId,
              setEntries,
              ...(rawEntries.length === 0 ? {} : { rawEntries }),
              ...(parsed.name === undefined ? {} : { nameChange: parsed.name }),
              dateResolution,
              peopleResolution,
              tagResolution,
              relationResolution,
              env: ctx.env,
              noCache: globalFlags.noCache,
            });
          } catch (err) {
            if (
              err instanceof ApiError &&
              err.code === 'unsupported_column_type' &&
              err.details?.type === 'file'
            ) {
              await runItemUpdateSingleFileDispatchDryRun({
                client,
                boardId,
                itemId: dispatch.itemId,
                setEntries,
                rawEntries,
                hasName: parsed.name !== undefined,
                env: ctx.env,
                noCache: globalFlags.noCache,
                ctx,
                programOpts: program.opts(),
                apiVersion,
              });
              return;
            }
            throw err;
          }
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

        // Live update path — three-pass resolution + translation
        // through the shared helper (R20 lift).
        let resolutionResult;
        try {
          resolutionResult = await resolveAndTranslate({
            client,
            boardId,
            setEntries,
            rawEntries,
            dateResolution,
            peopleResolution,
            tagResolution,
            relationResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
        } catch (err) {
          if (
            err instanceof ApiError &&
            err.code === 'unsupported_column_type' &&
            err.details?.type === 'file'
          ) {
            await runItemUpdateSingleFileDispatchLive({
              client,
              multipart,
              ctx,
              programOpts: program.opts(),
              boardId,
              itemId: dispatch.itemId,
              setEntries,
              rawEntries,
              hasName: parsed.name !== undefined,
              env: ctx.env,
              noCache: globalFlags.noCache,
              retries: globalFlags.retry,
              toEmit,
            });
            return;
          }
          throw err;
        }
        const collectedWarnings: ResolverWarning[] = [
          ...resolutionResult.warnings,
        ];
        const resolvedIds = resolutionResult.resolvedIds;
        const sourceAgg = new SourceAggregator();
        if (resolutionResult.source !== undefined) {
          sourceAgg.record(
            resolutionResult.source,
            resolutionResult.cacheAgeSeconds,
          );
        }
        const translated: readonly TranslatedColumnValue[] =
          resolutionResult.translated;

        // Build the final SelectedMutation. When `--name` is set,
        // a synthetic translated value (columnId: "name",
        // columnType: "text") joins the array so `selectMutation`
        // dispatches uniformly: name-only → simple; columns + name
        // (or ≥2 columns) → multi.
        const allTranslated: readonly TranslatedColumnValue[] =
          parsed.name === undefined
            ? translated
            : [
                {
                  columnId: 'name',
                  columnType: 'text',
                  rawInput: parsed.name,
                  payload: { format: 'simple', value: parsed.name },
                  resolvedFrom: null,
                  peopleResolution: null,
                  tagResolution: null,
                  relationResolution: null,
                  translatorResolution: null,
                },
                ...translated,
              ];

        let mutationResult;
        try {
          const mutation: SelectedMutation = selectMutation(allTranslated);
          mutationResult = await executeItemMutation(client, {
            mutation,
            itemId: dispatch.itemId,
            boardId,
            createLabelsIfMissing: parsed.createLabelsIfMissing,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            // F4 remap: cache-sourced resolution + Monday rejecting
            // as validation_failed → check live archived state.
            // Codex M5b finding #3: pass every translated column ID so
            // a multi-column update where a LATER target was archived
            // (post stale-cache read) still remaps.
            // Codex pass-1 F2: pass the actual aggregated resolution
            // source (live / cache / mixed) so plain cache hits
            // without `stale_cache_refreshed` warnings still trigger
            // the remap.
            throw await foldAndRemap({
              err,
              warnings: collectedWarnings,
              client,
              boardId,
              columnIds: translated.map((t) => t.columnId),
              env: ctx.env,
              noCache: globalFlags.noCache,
              resolutionSource: resolutionResult.source ?? 'live',
            });
          }
          throw err;
        }

        const warnings: readonly Warning[] = collectedWarnings;
        // The mutation leg is always live — fold it into the
        // aggregator so a cache-served resolution + live mutation
        // surfaces as `mixed`. Mirrors the bulk path's terminal
        // `record('live', null)` (Codex M5b finding #2; the
        // warning-only inference pre-fix missed plain cache hits).
        sourceAgg.record('live', null);
        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          ...sourceAgg.result(),
          // resolved_ids — same shape as `item set`. The synthetic
          // `name` field doesn't appear here because the slot only
          // echoes RESOLVED tokens (those that went through the
          // column resolver); `name` skipped that step.
          resolvedIds,
        });
      });
  },
};

/**
 * Bulk dry-run aggregates per-item resolver warnings — the same
 * `stale_cache_refreshed` / `column_token_collision` signals fire
 * once per item the first time they're triggered (subsequent items
 * hit the now-warm cache). De-duplicates by `code + message +
 * details.token` so an agent reading the dry-run envelope sees
 * each unique warning once rather than N copies. Order-preserving:
 * the first occurrence wins.
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

// ============================================================
// Bulk path (cli-design §10.2 — `--where` / `--filter-json`).
// items_page walker lifted into `api/items-page-walker.ts` per §18
// R34 (post-M12) — the helper builds the GraphQL queries inline +
// parses the response with the per-row schema below, surfacing
// schema drift as `internal_error` with the failing field path on
// `details.issues` rather than collapsing to a silent "0 matched,
// 0 applied" success (the F6 pass-2 hardening lifts to all four
// items_page consumers automatically).
// ============================================================

const bulkItemSchema = z.object({ id: ItemIdSchema }).loose();
type BulkItem = z.infer<typeof bulkItemSchema>;

/**
 * Wrapped data shape for the bulk-live success envelope. cli-design
 * §10.2 doesn't pin a specific shape for `data`, so we fold the
 * matched / applied counts into a `summary` slot alongside the
 * per-item projected list. Agents read `data.applied_count` for the
 * "did it work?" probe and `data.items` for the post-mutation state.
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

interface RunBulkInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly globalFlags: GlobalFlags;
  readonly apiVersion: string;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
}

/**
 * Bulk path orchestrator (cli-design §10.2). Walks `items_page` to
 * collect every matched item, then dispatches:
 *
 *   1. Without `--yes` AND without `--dry-run` → throw
 *      `confirmation_required` with the matched count. Per
 *      cli-design §3.1 #7: "destructive ops without `--yes` fail
 *      fast." Bulk multi-item mutations qualify.
 *   2. With `--dry-run` → per-item `planChanges` → emit N-element
 *      `planned_changes`. cli-design §10.2 line 1456-1457: "both
 *      single-item and bulk forms use the same envelope".
 *   3. With `--yes` (and not `--dry-run`) → per-item live mutation
 *      via `executeMutation`. Fail-fast on first error; the error
 *      envelope's `details.applied_to` lists IDs of items that
 *      successfully mutated before the failure.
 *
 * **Why per-item planChanges / executeMutation rather than a
 * single bulk mutation.** Monday has no true bulk-update mutation
 * in 2026-01; the CLI walks items + fires N `change_*` calls. The
 * column resolution + translation work is done once, then reused
 * across every per-item mutation.
 *
 * **Sequential execution.** cli-design §9.3 mandates one-at-a-time
 * requests in v0.1-v0.3; the per-item loop respects that. v0.4's
 * `--concurrency` flag is the future extension point.
 */
const runBulk = async (inputs: RunBulkInputs): Promise<void> => {
  const { parsed, client, globalFlags, apiVersion, ctx, programOpts } = inputs;
  /* c8 ignore next 6 — defensive: validateInputShape guarantees
     parsed.board is non-undefined when shape is bulk; the type
     guard exists for TS. */
  if (parsed.board === undefined) {
    throw new UsageError('item update bulk path: --board is required');
  }
  const boardId = parsed.board;

  // 0) Argv-parse-time failures before any network call. Splits +
  //    JSON parse run on pure strings; surfacing here means a
  //    malformed --set or malformed --set-raw fails fast without
  //    burning a board-metadata fetch + items_page walk + the
  //    confirmation prompt. M8 finding from review pass: pre-fix the
  //    parse ran AFTER the walk, so a malformed JSON paid two
  //    GraphQL round-trips before the agent saw the parse error.
  const setEntries = parsed.set.map(splitSetExpression);
  const rawEntries: readonly ParsedSetRawExpression[] =
    parsed.setRaw.map(parseSetRawExpression);

  // 1) Load board metadata (cache-aware, refresh on column-not-found
  //    during filter parsing per §5.3 step 5).
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
  //    per-page sort + §5.6 `stale_cursor` enrichment.
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
  //    Emit a success envelope before the confirmation gate fires
  //    (Codex pass-1 F1: `--yes` shouldn't be required to confirm
  //    "no items matched"). Filter warnings still surface so the
  //    agent sees `column_token_collision` / `stale_cache_refreshed`
  //    if the empty result was filter-resolved post-refresh.
  //
  // Codex pass-2: source / cacheAgeSeconds aggregate from the metadata
  // load + the items_page walk (always live). Cache-sourced metadata
  // + live walk → `mixed`; pure-cache metadata stays `cache` only on
  // the impossible no-walk path. The live items_page walk forces the
  // aggregate to `mixed` when metadata was cache-served.
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
      schema: bulkLiveDataSchema,
      programOpts,
      warnings: filterResult.warnings,
      source: emptyEnvelopeSource,
      cacheAgeSeconds: meta.cacheAgeSeconds,
      apiVersion,
    });
    return;
  }

  // 4) Confirmation gate. Bulk mutations without --yes (and without
  //    --dry-run) surface `confirmation_required` per §3.1 #7 +
  //    §6.5. Agents read the matched-item count and re-run with
  //    --yes after reviewing. `--yes` is a global flag (program.ts).
  if (!globalFlags.dryRun && !globalFlags.yes) {
    throw new ConfirmationRequiredError(
      `Bulk item update would mutate ${String(matchedItemIds.length)} ` +
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

  // setEntries + rawEntries pre-parsed at the top of runBulk for the
  // fail-fast invariant. (See step 0 above — moving the parse there
  // means a malformed --set / --set-raw doesn't pay for the metadata
  // load + items_page walk first.)

  const { dateResolution, peopleResolution, tagResolution, relationResolution } =
    buildResolutionContexts({ client, ctx, globalFlags });

  // 5) Dry-run path: per-item planChanges. Column resolution is
  //    cached after the first call; per-item state read fires per
  //    item (no item-state cache in v0.1).
  //
  // Codex pass-1 F4: aggregate per-item warnings + source + cache
  // age across the batch. Pre-fix, bulk dry-run dropped per-item
  // results' `warnings` and hardcoded `source: 'mixed'`, losing
  // `column_token_collision` / `stale_cache_refreshed` signals
  // the resolver-warning preservation pattern is meant to keep.
  if (globalFlags.dryRun) {
    const allPlanned: Readonly<Record<string, unknown>>[] = [];
    const aggregatedWarnings: Warning[] = [...filterResult.warnings];
    const sourceAgg = new SourceAggregator({
      source: meta.source,
      cacheAgeSeconds: meta.cacheAgeSeconds,
    });
    for (const itemId of matchedItemIds) {
      let result;
      try {
        result = await planChanges({
          client,
          boardId,
          itemId,
          setEntries,
          ...(rawEntries.length === 0 ? {} : { rawEntries }),
          ...(parsed.name === undefined ? {} : { nameChange: parsed.name }),
          dateResolution,
          peopleResolution,
          tagResolution,
          relationResolution,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
      } catch (err) {
        // v0.6-M38 D5 closure: bulk file-set REJECTS at the column-
        // resolution boundary. planChanges' resolveAndTranslate
        // surfaces `unsupported_column_type` with `details.type:
        // 'file'` for files-shaped columns; the catch rewraps as
        // `usage_error.details.reason: 'file_set_on_bulk_unsupported'`
        // per D5. Fires on the FIRST matched item's planChanges
        // call when any --set token resolves to a file column;
        // subsequent items wouldn't reach this loop body anyway.
        if (
          err instanceof ApiError &&
          err.code === 'unsupported_column_type' &&
          err.details?.type === 'file'
        ) {
          throw buildBulkFileRejection(err);
        }
        throw err;
      }
      for (const plan of result.plannedChanges) {
        allPlanned.push(plan as unknown as Readonly<Record<string, unknown>>);
      }
      // Resolver warnings can fire per item (the cache-miss-refresh
      // dance is per-token). Most fire on the first item only (cache
      // populated for subsequent items), but the helper deduplicates
      // by code+message+token below for compactness.
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

  // 5) Live path: per-item mutation. Resolve columns once, translate
  //    once, then fire the same SelectedMutation against every
  //    matched item.
  //
  // Three-pass resolution (Codex M8 finding #2): resolve every token
  // first, run the cross-token duplicate-resolved-ID check, then
  // translate. Pre-fix, translation ran inline, so a `--set X=bad`
  // alongside a `--set-raw X={...}` could surface the translation
  // `usage_error` instead of the mutual-exclusion `usage_error` per
  // cli-design §5.3 line 961-972.
  //
  // Three-pass resolution + translation through the shared helper
  // (R20 lift). The board-metadata leg's source / cacheAge seed the
  // aggregator so a cache-served metadata fetch promotes the final
  // envelope source to `mixed` when subsequent resolution legs hit
  // live (Codex M8 finding #3).
  //
  // `collectedWarnings` is the union of filter warnings + resolver
  // warnings, surfaced on the success envelope. `resolverWarnings`
  // is the narrowed subset used by foldResolverWarningsIntoError —
  // the helper's contract is to fold collision / stale_cache_refreshed
  // signals, not generic Warning types.
  let resolutionResult;
  try {
    resolutionResult = await resolveAndTranslate({
      client,
      boardId,
      setEntries,
      rawEntries,
      dateResolution,
      peopleResolution,
      tagResolution,
      relationResolution,
      env: ctx.env,
      noCache: globalFlags.noCache,
      initialSource: meta.source,
      initialCacheAgeSeconds: meta.cacheAgeSeconds,
    });
  } catch (err) {
    // v0.6-M38 D5 closure: bulk file-set REJECTS at the column-
    // resolution boundary. Same rewrap as the dry-run loop above.
    if (
      err instanceof ApiError &&
      err.code === 'unsupported_column_type' &&
      err.details?.type === 'file'
    ) {
      throw buildBulkFileRejection(err);
    }
    throw err;
  }
  const collectedWarnings: Warning[] = [
    ...filterResult.warnings,
    ...resolutionResult.warnings,
  ];
  const resolverWarnings: ResolverWarning[] = [...resolutionResult.warnings];
  const resolvedIds = resolutionResult.resolvedIds;
  // resolveAndTranslate was seeded with meta.source / meta.cacheAge
  // above, so resolutionResult.source is always defined post-helper.
  // The `?? meta.source` fallback preserves the pre-R30 c8-ignored
  // defensive widening; flow then folds the per-item mutation legs
  // (always live) at emit time via `sourceAgg.record('live', null)`.
  const sourceAgg = new SourceAggregator();
  /* c8 ignore next 3 — defensive: initialSource seeded above so
     resolutionResult.source is always defined post-helper. */
  const remapSource: 'live' | 'cache' | 'mixed' =
    resolutionResult.source ?? meta.source;
  sourceAgg.record(remapSource, resolutionResult.cacheAgeSeconds);
  const translated: readonly TranslatedColumnValue[] =
    resolutionResult.translated;

  const allTranslated: readonly TranslatedColumnValue[] =
    parsed.name === undefined
      ? translated
      : [
          {
            columnId: 'name',
            columnType: 'text',
            rawInput: parsed.name,
            payload: { format: 'simple', value: parsed.name },
            resolvedFrom: null,
            peopleResolution: null,
            tagResolution: null,
            relationResolution: null,
            translatorResolution: null,
          },
          ...translated,
        ];

  const mutation: SelectedMutation = selectMutation(allTranslated);

  // M25 (cli-design §6.4 "Bulk per-item partial-success"). The
  // `--continue-on-error` flag routes through the partial-success
  // bulk dispatch helper at `src/api/partial-success-bulk.ts`
  // instead of the fail-fast loop below. Runtime body landed at
  // M25 implementation; the c8-ignore-wrapped routing branch from
  // the pre-flight contract diff (`d5839a9`) has dropped. The
  // fail-fast bulk path below stays unchanged — the v0.2 envelope
  // shape (top-level `error` with `details.applied_to` decoration
  // on per-item failure) is preserved for agents who haven't
  // migrated to read `data.results[]`.
  if (parsed.continueOnError === true) {
    // Codex round-1 P1-1 fix: thread the foldAndRemap context
    // through to the wrapper so per-item failures inherit the
    // same `validation_failed` → `column_archived` stale-cache
    // remap the fail-fast path applies. Without this, the
    // per-record `error.code` in `data.results[]` would carry
    // `validation_failed` for archived-column failures even
    // though the v0.1 fail-fast path surfaces the stable
    // `column_archived` code at the top level for the same
    // root cause. Same `remapColumnIds` + `resolverWarnings` +
    // `env` + `noCache` + `resolutionSource` the fail-fast
    // loop below threads into `foldAndRemap`.
    const partialResult = await runPartialSuccessBulkUpdate({
      client,
      boardId,
      matchedItemIds,
      mutation,
      createLabelsIfMissing: parsed.createLabelsIfMissing,
      resolverWarnings,
      remapColumnIds: translated.map((t) => t.columnId),
      env: ctx.env,
      noCache: globalFlags.noCache,
      resolutionSource: remapSource,
      // v0.4-M30: thread the argv `--concurrency` slot through.
      // `undefined` (default) preserves the M25 sequential dispatch;
      // `> 1` routes through dispatchParallel (bounded async-pool).
      // Argv parser pinned the value to
      // [MIN_CONCURRENCY, MAX_CONCURRENCY] (1..32) before reaching here.
      concurrency: parsed.concurrency,
      // v0.4-M30: SIGINT during a parallel dispatch aborts the pool's
      // scheduler at the next worker-loop iteration; in-flight wire
      // calls abort via the MondayClient.signal. Sequential route
      // sees the same signal so cooperative-abort semantics match
      // (R-NEW-28 axis 6).
      signal: ctx.signal,
    });
    // Per-item dispatch leg is always live — fold into the
    // aggregator. Mirrors the fail-fast path's terminal
    // `sourceAgg.record('live', null)` (cli-design §6.4 +
    // SourceAggregator precedent).
    sourceAgg.record(PARTIAL_SUCCESS_BULK_DISPATCH_SOURCE, null);
    const summary = buildPartialSuccessBulkSummary({
      matchedCount: matchedItemIds.length,
      boardId,
      results: partialResult.results,
    });
    const partialData: PartialSuccessBulkUpdateData = {
      operation: 'item_update',
      summary,
      results: partialResult.results,
    };
    emitMutation({
      ctx,
      data: partialData,
      schema: partialSuccessBulkUpdateDataSchema,
      programOpts,
      warnings: collectedWarnings,
      ...sourceAgg.result(),
      apiVersion,
      resolvedIds,
    });
    return;
  }

  const appliedItems: ProjectedItem[] = [];
  // Codex pass-1 F3: F4's `validation_failed` → `column_archived`
  // remap must fire on bulk per-item failures too — agents key off
  // the stable `column_archived` code regardless of whether the
  // mutation came from item set / item update single / item update
  // bulk. Pre-fix, bulk failures only ran the resolver-warning
  // fold + bulk-progress decoration; the remap was missing.
  // Codex M5b finding #3: probe every translated column id, not
  // just the first, so a multi-column bulk update where a LATER
  // target was archived after a stale cache read still surfaces
  // `column_archived`. Single-column bulk passes a one-element
  // array, same as before.
  const remapColumnIds: readonly string[] = translated.map((t) => t.columnId);
  for (const itemId of matchedItemIds) {
    try {
      const result = await executeItemMutation(client, {
        mutation,
        itemId,
        boardId,
        createLabelsIfMissing: parsed.createLabelsIfMissing,
      });
      appliedItems.push(result.projected);
    } catch (err) {
      if (err instanceof MondayCliError) {
        // Apply fold + F4 remap before bulk-progress decoration. The
        // remap returns the original error unchanged when its
        // preconditions aren't met (non-validation_failed, live
        // source, refresh failure, post-refresh column still
        // active). When it DOES fire, the remapped error keeps the
        // resolver_warnings slot we just folded in.
        const remapped = await foldAndRemap({
          err,
          warnings: resolverWarnings,
          client,
          boardId,
          columnIds: remapColumnIds,
          env: ctx.env,
          noCache: globalFlags.noCache,
          resolutionSource: remapSource,
        });
        // Decorate with bulk-progress details so agents can see how
        // many items mutated successfully before the failure.
        const existing = remapped.details ?? {};
        if (remapped.code === 'usage_error') {
          throw new UsageError(remapped.message, {
            ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
            details: {
              ...existing,
              applied_count: appliedItems.length,
              applied_to: appliedItems.map((i) => i.id),
              failed_at_item: itemId,
              matched_count: matchedItemIds.length,
            },
          });
        }
        throw new ApiError(remapped.code, remapped.message, {
          ...(remapped.cause === undefined ? {} : { cause: remapped.cause }),
          ...(remapped.httpStatus === undefined ? {} : { httpStatus: remapped.httpStatus }),
          ...(remapped.mondayCode === undefined ? {} : { mondayCode: remapped.mondayCode }),
          ...(remapped.requestId === undefined ? {} : { requestId: remapped.requestId }),
          retryable: remapped.retryable,
          ...(remapped.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: remapped.retryAfterSeconds }),
          details: {
            ...existing,
            applied_count: appliedItems.length,
            applied_to: appliedItems.map((i) => i.id),
            failed_at_item: itemId,
            matched_count: matchedItemIds.length,
          },
        });
      }
      throw err;
    }
  }

  // Codex pass-2: aggregate `meta.source` + `cache_age_seconds`
  // properly per cli-design §6.1. Pre-fix, source was inferred from
  // warning presence — a plain cache hit (no warning) on metadata
  // would surface as `live` even though the resolver served from
  // cache. M4 pinned this exact regression for read commands; the
  // bulk write path replicated the bug.
  //
  // The items_page walk and per-item mutations always fire live —
  // record one terminal `live` leg so a fully-cached metadata +
  // column-resolution path still surfaces as `mixed` (cache-served
  // metadata + live wire calls). N per-item mutations collapse to
  // one `record('live', null)` because mergeSource is idempotent
  // for a constant second leg. Mirrors the empty-match no-op
  // path's `emptyEnvelopeSource` derivation.
  sourceAgg.record('live', null);
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
    schema: bulkLiveDataSchema,
    programOpts,
    warnings: collectedWarnings,
    ...sourceAgg.result(),
    apiVersion,
    resolvedIds,
  });
};

// ============================================================
// v0.6-M38 file-column dispatch helpers (cli-design §5.3 step 5
// "File-column dispatch leg" + v0.6-plan §3 M38 D2/D4/D5
// closures). The single-item live + dry-run helpers below catch
// the translator's `unsupported_column_type` rejection on a file
// column, re-resolve all `--set` / `--set-raw` entries against
// the (now warm) board-metadata cache to apply the mutex check
// via `enforceSingleFileColumnSet`, and either dispatch
// (clean path) or surface the appropriate D2 reason
// discriminator. `buildBulkFileRejection` short-circuits the
// bulk path's catch handler with `file_set_on_bulk_unsupported`
// (D5) without re-resolution because the bulk callShape rejects
// ALL file --set unconditionally.
// ============================================================

interface RunItemUpdateSingleFileDispatchDryRunInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly itemId: string;
  readonly setEntries: readonly { token: string; value: string }[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly hasName: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
}

const runItemUpdateSingleFileDispatchDryRun = async (
  inputs: RunItemUpdateSingleFileDispatchDryRunInputs,
): Promise<void> => {
  // Re-resolve all setEntries + setRawEntries against the
  // (now warm) metadata cache. The translator's rejection above
  // confirmed at least one --set is a file column, but the mutex
  // check needs to know which entries are file vs non-file +
  // setRaw context + hasName to discriminate
  // multi_file_set_unsupported vs mixed_file_and_value_sets per D2.
  const resolvedSet = await Promise.all(
    inputs.setEntries.map(async (entry) => {
      const r = await resolveColumnWithRefresh({
        client: inputs.client,
        boardId: inputs.boardId,
        token: entry.token,
        includeArchived: true,
        env: inputs.env,
        noCache: inputs.noCache,
      });
      return {
        columnId: r.match.column.id,
        columnType: r.match.column.type,
        rawValue: entry.value,
      };
    }),
  );
  const resolvedSetRaw = await Promise.all(
    inputs.rawEntries.map(async (entry) => {
      const r = await resolveColumnWithRefresh({
        client: inputs.client,
        boardId: inputs.boardId,
        token: entry.token,
        includeArchived: true,
        env: inputs.env,
        noCache: inputs.noCache,
      });
      return {
        columnId: r.match.column.id,
        columnType: r.match.column.type,
      };
    }),
  );
  const enforcement = enforceSingleFileColumnSet({
    callShape: 'item_update_single',
    setEntries: resolvedSet,
    setRawEntries: resolvedSetRaw,
    hasName: inputs.hasName,
  });
  /* c8 ignore next 4 — defensive: caller routes here only after
     the translator rejected a file column, so kind === 'file' is
     the only reachable outcome. */
  if (enforcement.kind === 'json') {
    throw new ApiError('internal_error', 'item update file dispatch: enforcement returned json kind unexpectedly');
  }
  const precheck = await precheckLocalFile(enforcement.rawValue);
  // D4 dry-run envelope shape — single-entry planned_changes
  // mirroring M31 `item upload --dry-run` verbatim; no file
  // bytes loaded; `meta.source: 'none'`.
  emitDryRun({
    ctx: inputs.ctx,
    programOpts: inputs.programOpts,
    plannedChanges: [
      {
        operation: 'add_file_to_column',
        item_id: inputs.itemId,
        column_id: enforcement.columnId,
        file_path: enforcement.rawValue,
        filename: precheck.filename,
        file_size_bytes: precheck.fileSizeBytes,
      },
    ],
    source: 'none',
    cacheAgeSeconds: null,
    apiVersion: inputs.apiVersion,
  });
};

interface RunItemUpdateSingleFileDispatchLiveInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly boardId: string;
  readonly itemId: string;
  readonly setEntries: readonly { token: string; value: string }[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly hasName: boolean;
  readonly env: NodeJS.ProcessEnv;
  readonly noCache: boolean;
  readonly retries: number;
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
}

const runItemUpdateSingleFileDispatchLive = async (
  inputs: RunItemUpdateSingleFileDispatchLiveInputs,
): Promise<void> => {
  const resolvedSet = await Promise.all(
    inputs.setEntries.map(async (entry) => {
      const r = await resolveColumnWithRefresh({
        client: inputs.client,
        boardId: inputs.boardId,
        token: entry.token,
        includeArchived: true,
        env: inputs.env,
        noCache: inputs.noCache,
      });
      return {
        columnId: r.match.column.id,
        columnType: r.match.column.type,
        rawValue: entry.value,
        token: entry.token,
      };
    }),
  );
  const resolvedSetRaw = await Promise.all(
    inputs.rawEntries.map(async (entry) => {
      const r = await resolveColumnWithRefresh({
        client: inputs.client,
        boardId: inputs.boardId,
        token: entry.token,
        includeArchived: true,
        env: inputs.env,
        noCache: inputs.noCache,
      });
      return {
        columnId: r.match.column.id,
        columnType: r.match.column.type,
      };
    }),
  );
  const enforcement = enforceSingleFileColumnSet({
    callShape: 'item_update_single',
    setEntries: resolvedSet,
    setRawEntries: resolvedSetRaw,
    hasName: inputs.hasName,
  });
  /* c8 ignore next 4 */
  if (enforcement.kind === 'json') {
    throw new ApiError('internal_error', 'item update file dispatch: enforcement returned json kind unexpectedly');
  }
  const precheck = await precheckLocalFile(enforcement.rawValue);
  const result = await executeFileColumnSet({
    client: inputs.client,
    multipart: inputs.multipart,
    itemId: inputs.itemId,
    entry: {
      columnId: enforcement.columnId,
      columnType: 'file',
      rawValue: enforcement.rawValue,
      filePath: precheck.filePath,
      filename: precheck.filename,
      fileSizeBytes: precheck.fileSizeBytes,
    },
    signal: inputs.ctx.signal,
    retries: inputs.retries,
  });
  // §8 single-leg cache invalidation BEFORE emit (mirrors M31).
  await invalidateBoard(inputs.boardId, inputs.env);
  const data: FileColumnSetOutput = {
    operation: 'add_file_to_column',
    item_id: inputs.itemId,
    column_id: enforcement.columnId,
    filename: precheck.filename,
    file_size_bytes: precheck.fileSizeBytes,
    asset: result.asset,
  };
  // resolved_ids echo: token → resolved column ID for the file
  // entry's token (mirrors `item set`'s single-token echo).
  const matchingEntry = resolvedSet.find(
    (r) => r.columnId === enforcement.columnId && r.columnType === 'file',
  );
  /* c8 ignore next 3 */
  const resolvedIds: Readonly<Record<string, string>> =
    matchingEntry === undefined ? {} : { [matchingEntry.token]: enforcement.columnId };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: fileColumnSetOutputSchema,
    programOpts: inputs.programOpts,
    warnings: [],
    ...inputs.toEmit({
      data: result.asset,
      complexity: result.complexity,
      stats: { attempts: 1, totalBackoffMs: 0 },
    }),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: result.complexity,
    resolvedIds,
  });
};

/**
 * Rewraps a translator `unsupported_column_type` rejection on a
 * file-typed column as the v0.6-M38 D5 closure's
 * `file_set_on_bulk_unsupported` reason discriminator. Fires from
 * BOTH the bulk dry-run loop's first-iteration planChanges catch
 * AND the bulk live path's resolveAndTranslate catch — both reach
 * the translator's files-shaped rejection on the same code path.
 * The hint names the verb-shaped M31 fallback so agents have a
 * clear next step.
 */
const buildBulkFileRejection = (err: ApiError): ApiError => {
  const columnId =
    typeof err.details?.column_id === 'string' ? err.details.column_id : null;
  return new ApiError(
    'usage_error',
    `--set <file-col>=<path> is not supported on bulk \`item update ` +
      `--where\` / \`--filter-json\` at v0.6-M38 (deferred to v0.6.x ` +
      `per cli-design §13 v0.6 entry + v0.6-plan §3 M38 D5 closure). ` +
      `Per-item file dispatch + \`--continue-on-error\` partial-success ` +
      `envelope + \`--concurrency\` multipart-over-shared-transport ` +
      `semantics each carry design dimensions worth their own milestone ` +
      `cluster. Iterate matched items in your script and run single-item ` +
      `\`monday item set <iid> <file-col>=<path>\` or \`monday item ` +
      `upload <iid> --column <col> <file>\` (v0.4-M31; verb-shaped) ` +
      `per item.`,
    {
      cause: err,
      details: {
        reason: 'file_set_on_bulk_unsupported',
        ...(columnId === null ? {} : { column_id: columnId }),
        deferred_to: 'v0.6.x',
        hint:
          'bulk file dispatch is not supported at v0.6-M38; iterate ' +
          'matched items in your script and call `monday item set <iid> ' +
          '<file-col>=<path>` per item, or use `monday item upload <iid> ' +
          '--column <col> <file>` (v0.4-M31).',
      },
    },
  );
};

