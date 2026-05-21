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
import type { ResolverWarning } from '../../api/columns.js';
import type { MondayClient } from '../../api/client.js';
import {
  selectMutation,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import { executeItemMutation } from '../../api/item-mutation-execute.js';
import {
  executeFileColumnSet,
  dispatchFileLegsSequentially,
  fileColumnSetOutputSchema,
  fileColumnSetMultiOutputSchema,
  preCheckM38FileDispatch,
  type FileColumnSetOutput,
  type FileColumnSetMultiOutput,
  type MultiFileLegEntry,
  type MultiFileLegAsset,
  type PreCheckM38FileDispatchResult,
} from '../../api/file-column-set.js';
import {
  precheckLocalFile,
  isStdinFileSetSource,
  readStdinFileSource,
  resolveStdinFilename,
  STDIN_FILE_SENTINEL,
} from '../../utils/file-source.js';
import { invalidateBoard } from '../../api/cache.js';
import { addFileToColumn, type Asset } from '../../api/assets.js';
import type { MultipartTransport } from '../../api/multipart-transport.js';
import {
  dispatchSequential,
  type DispatchOneTargetInputs,
  type PartialSuccessResult,
} from '../../api/partial-success-mutation.js';
import { dispatchParallel } from '../../api/parallel-dispatch.js';
import type { EmitFromNetworkResult } from '../../api/resolve-client.js';
import type { MondayResponse } from '../../api/client.js';
import {
  parseSetRawExpression,
  type ParsedSetRawExpression,
} from '../../api/raw-write.js';
import { splitSetExpression } from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import { resolveBoardId } from '../../api/item-board-lookup.js';
import {
  SourceAggregator,
  mergeCacheAge,
  mergeSource,
} from '../../api/source-aggregator.js';
import { resolveAndTranslate } from '../../api/resolution-pass.js';
import {
  foldAndRemap,
  mergeResolverWarningsIntoError,
} from '../../api/resolver-error-fold.js';
import {
  projectCauseForEnvelope,
  reThrowDecorated,
} from '../../api/error-decoration.js';
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
 * single-item file-dispatch envelopes for the friendly `--set
 * <file-col>=<path>` path: v0.6-M38 single-file (`operation:
 * 'add_file_to_column'`) + v0.8-M46 single-item multi-file
 * (`operation: 'add_files_to_columns'`; `assets[]` wraps M31's
 * `Asset` projection per file column).
 *
 * The union admits only the SINGLE-ITEM shapes. The BULK file
 * variants — v0.7-M42 (`item_update_bulk_file_set`) + v0.8-M46
 * (`item_update_bulk_file_set_multi`) — are emitted via their own
 * `bulkFileSet*DataSchema` at the `runItemUpdateBulk*FileDispatch`
 * helpers and stay OUT of this union (the bulk per-item-results
 * shape is structurally distinct from the single-resource `data`
 * payload this schema describes); agents discriminate on `operation`
 * (present + literal value identifies the variant).
 */
export const itemUpdateOutputSchema = z.union([
  projectedItemSchema,
  fileColumnSetOutputSchema,
  fileColumnSetMultiOutputSchema,
]);
export type ItemUpdateOutput =
  | ProjectedItem
  | FileColumnSetOutput
  | FileColumnSetMultiOutput;

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
    // v0.8-M47 (D7 fold): companion to a stdin file `--set
    // <file-col>=-` source — sets Monday's wire `Asset.name`. OPTIONAL
    // (probe: `add_file_to_column` accepts any non-empty filename;
    // only an EMPTY one `500`s — `.min(1)` rejects `--filename ""` at
    // the parse boundary as `usage_error`). Default when omitted on a
    // stdin source: `DEFAULT_STDIN_FILENAME` (`"blob"`). Consulted ONLY
    // on a `<file-col>=-` stdin dispatch; ignored otherwise (whether a
    // stdin source exists is only knowable after column resolution, so
    // a no-stdin `--filename` is a harmless no-op rather than a
    // resolution-coupled reject).
    filename: z.string().min(1).optional(),
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
      .option(
        '--filename <name>',
        "Asset.name for a stdin file `--set <file-col>=-` source (default \"blob\")",
      )
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
            multipart,
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

        // v0.6-M38 mutex check at the column-resolution boundary
        // (cli-design §5.3 step 5 "File-column dispatch leg —
        // mutex rules"; D2/D5/D6 closures). Pre-checks setEntries'
        // column types BEFORE calling `planChanges` /
        // `resolveAndTranslate`, so the mutex rules fire upfront
        // independent of translator-order side effects. The
        // pre-check operates on setEntries only — `--set-raw
        // <file-col>=<json>` rejection stays at
        // `translateRawColumnValue` per D3 (permanent rejection;
        // M38 dispatch never hijacks the --set-raw path).
        const m38 = await preCheckM38FileDispatch({
          client,
          boardId,
          setEntries,
          setRawCount: rawEntries.length,
          hasName: parsed.name !== undefined,
          callShape: 'item_update_single',
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        if (m38.kind === 'file') {
          // M38 dispatch path. The dry-run / live branches emit the
          // D4 envelope / M31-shaped envelope respectively, threading
          // the pre-check's resolver warnings + source aggregation
          // into the final envelope (P3-1 — IMPL round-1 fix).
          await runItemUpdateSingleFileDispatch({
            client,
            multipart,
            ctx,
            programOpts: program.opts(),
            apiVersion,
            boardId,
            itemId: dispatch.itemId,
            m38,
            isDryRun: globalFlags.dryRun,
            retries: globalFlags.retry,
            filename: parsed.filename,
            toEmit,
          });
          return;
        }

        if (m38.kind === 'file_multi') {
          // v0.8-M46 D2 carve-out fold — single-item multi-file
          // dispatch path. argv parse + pre-check (which returned
          // `kind: 'file_multi'` here) have already run as live
          // contract; the per-item multi-leg fan-out body runs N
          // sequential `add_file_to_column` legs against the single
          // item (runtime body shipped at v0.8-M46 IMPL).
          await runItemUpdateSingleFileMultiDispatch({
            client,
            multipart,
            ctx,
            programOpts: program.opts(),
            apiVersion,
            boardId,
            itemId: dispatch.itemId,
            m38,
            isDryRun: globalFlags.dryRun,
            retries: globalFlags.retry,
            toEmit,
          });
          return;
        }

        if (globalFlags.dryRun) {
          // m38.kind === 'json' — standard JSON translator path
          // applies. The pre-check's resolver warnings + source
          // aggregation seed the downstream planChanges run
          // (downstream resolveAndTranslate hits cache for the
          // already-resolved setEntries; source aggregation is
          // correct per §6.1 — both legs counted).
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
            // Round-3 P3-1 fix: fold M38 pre-check warnings into
            // the failure envelope's `details.resolver_warnings`
            // slot. The pre-check may have emitted
            // `stale_cache_refreshed` / `column_token_collision`;
            // if downstream `planChanges` throws (translator
            // error, archived column, etc.), the error's own
            // fold doesn't include the pre-check leg.
            if (err instanceof MondayCliError && m38.warnings.length > 0) {
              throw mergeResolverWarningsIntoError(err, m38.warnings);
            }
            throw err;
          }
          // Round-2 P3-1 fix: thread the pre-check's resolver
          // warnings into the dry-run envelope. A
          // `stale_cache_refreshed` or `column_token_collision`
          // emitted by the pre-check would otherwise be lost —
          // downstream `planChanges` re-resolves against the
          // now-warm cache and doesn't re-emit `stale_cache_refreshed`
          // (the refresh already ran). Dedupe by code+message+token
          // mirrors `dedupeWarnings` from the bulk path.
          //
          // **Round-3 P3-1 fix (error-path)**: the planChanges
          // call itself is wrapped above (line 483); if it throws
          // before returning, the error catch below folds
          // `m38.warnings` into `details.resolver_warnings` so
          // pre-check warnings ride into the failure envelope
          // too.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: mergeSource(m38.source, result.source),
            cacheAgeSeconds: mergeCacheAge(m38.cacheAgeSeconds, result.cacheAgeSeconds),
            warnings: dedupeWarnings([...m38.warnings, ...result.warnings]),
            apiVersion,
          });
          return;
        }

        // Live update path — three-pass resolution + translation
        // through the shared helper (R20 lift). Pre-check already
        // resolved setEntries (cache hit downstream).
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
            ...(m38.source === undefined ? {} : { initialSource: m38.source }),
            initialCacheAgeSeconds: m38.cacheAgeSeconds,
          });
        } catch (err) {
          // Round-3 P3-1 fix: fold M38 pre-check warnings into the
          // failure envelope's `details.resolver_warnings` slot. The
          // pre-check may have emitted `stale_cache_refreshed` /
          // `column_token_collision`; if downstream
          // `resolveAndTranslate` throws (translator error, archived
          // column post-cache-warm, etc.), the thrown error's own
          // resolver-warnings fold doesn't include the pre-check leg.
          if (err instanceof MondayCliError && m38.warnings.length > 0) {
            throw mergeResolverWarningsIntoError(err, m38.warnings);
          }
          throw err;
        }
        // Round-2 P3-1 fix: thread pre-check's resolver warnings
        // alongside downstream warnings, deduped by code+message+
        // token — pre-check's `stale_cache_refreshed` would
        // otherwise be lost (warm cache suppresses re-emit).
        const collectedWarnings: ResolverWarning[] = dedupeWarnings([
          ...m38.warnings,
          ...resolutionResult.warnings,
        ]) as ResolverWarning[];
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
  /**
   * Multipart transport threaded from `resolveClient(...)` at the
   * action callback level. Bulk file `--set` dispatch (v0.7-M42 D5
   * carve-out fold) consumes this for the per-item
   * `executeFileColumnSet` fan-out; the JSON-translator bulk path
   * ignores it.
   */
  readonly multipart: MultipartTransport;
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
  const { parsed, client, globalFlags, apiVersion, ctx, programOpts, multipart } = inputs;
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

  // 1.5) File-column dispatch pre-check at the column-resolution
  //      boundary, BEFORE the items_page walker + confirmation
  //      gate. The pre-check resolves setEntries against the now-
  //      warm metadata cache and runs
  //      `routeFileColumnDispatch({callShape: 'item_update_bulk'})`:
  //
  //        - Multi-file `--set` with distinct file columns →
  //          returns `kind: 'file_bulk_multi'` (v0.8-M46 D2
  //          carve-out fold; action body branches into the
  //          per-item multi-leg fan-out helper
  //          `runItemUpdateBulkFileMultiDispatch` — runtime body
  //          shipped at v0.8-M46 IMPL).
  //        - Multi-file `--set` with duplicate resolved file
  //          columns → throws `'duplicate_resolved_file_columns'`
  //          (mirrors JSON path's cross-token duplicate-resolved-
  //          ID contract; M46 R1 P2-1 fix).
  //        - File `--set` + value `--set` / `--set-raw` / `--name`
  //          → throws `'mixed_file_and_value_sets'` (universal rule;
  //          mixing forces non-atomic multi-leg dispatch).
  //        - Clean single file `--set` → returns
  //          `kind: 'file_bulk'` (v0.7-M42 D5 carve-out fold;
  //          action body branches into the per-item multipart
  //          fan-out helper `runItemUpdateBulkFileDispatch` —
  //          shipped at v0.7-M42 IMPL).
  //        - No file `--set` → returns `kind: 'json'` (standard
  //          JSON-translator path continues).
  //
  //      At v0.6-M38 the `'item_update_bulk'` callShape rejected
  //      ALL bulk file `--set` paths with
  //      `'file_set_on_bulk_unsupported'`; v0.7-M42 pre-flight
  //      contract diff (`160330b`) carved that out per D5 fold,
  //      and IMPL (`22df2fa` + R1 fix-up `968b154`) shipped the
  //      runtime body. `--set-raw <file-col>=<json>` stays at
  //      `translateRawColumnValue`'s D3 permanent rejection (the
  //      pre-check only inspects setEntries; the standard path's
  //      `translateRawColumnValue` handles --set-raw rejection
  //      unchanged).
  let m38Warnings: readonly ResolverWarning[] = [];
  let m38FileBulk: Extract<
    PreCheckM38FileDispatchResult,
    { kind: 'file_bulk' }
  > | undefined;
  let m38FileBulkMulti: Extract<
    PreCheckM38FileDispatchResult,
    { kind: 'file_bulk_multi' }
  > | undefined;
  if (setEntries.length > 0) {
    const m38 = await preCheckM38FileDispatch({
      client,
      boardId,
      setEntries,
      setRawCount: rawEntries.length,
      hasName: parsed.name !== undefined,
      callShape: 'item_update_bulk',
      env: ctx.env,
      noCache: globalFlags.noCache,
    });
    // Round-2 P3-1 fix carry-forward: capture pre-check warnings
    // to thread them into the final envelope. Pre-check resolution
    // warnings (column_token_collision / stale_cache_refreshed)
    // survive even though downstream cache hits suppress
    // re-emission.
    m38Warnings = m38.warnings;
    if (m38.kind === 'file_bulk') {
      // v0.7-M42 D5 carve-out fold. Hold the file_bulk slot for
      // the items_page-walked dispatch leg below; the items_page
      // walker still runs (collects target item IDs) + the
      // confirmation gate still applies + the dispatch loop fans
      // `executeFileColumnSet` across matched items.
      m38FileBulk = m38;
    }
    if (m38.kind === 'file_bulk_multi') {
      // v0.8-M46 D2 carve-out fold. Hold the file_bulk_multi slot
      // for the multi-leg per-item fan-out below. items_page walker
      // + confirmation gate still apply; the dispatch helper fans N
      // sequential file legs per matched item (runtime body shipped
      // at v0.8-M46 IMPL).
      m38FileBulkMulti = m38;
    }
  }

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
    // Round-2 P3-1 fix: thread M38 pre-check warnings into the
    // empty-match envelope so a pre-check `stale_cache_refreshed`
    // / `column_token_collision` survives the no-op short-circuit.
    const emptyWarnings = dedupeWarnings([
      ...filterResult.warnings,
      ...m38Warnings,
    ]);
    if (globalFlags.dryRun) {
      emitDryRun({
        ctx,
        programOpts,
        plannedChanges: [],
        source: emptyEnvelopeSource,
        cacheAgeSeconds: meta.cacheAgeSeconds,
        warnings: emptyWarnings,
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
      warnings: emptyWarnings,
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

  // v0.7-M42 D5 carve-out fold — bulk file `--set` dispatch leg.
  // When the pre-check returned `kind: 'file_bulk'`, branch into
  // the per-item multipart fan-out helper here. The branch fires
  // AFTER the items_page walker + confirmation gate (so an agent
  // sees the matched-count via `confirmation_required` before
  // the bulk file dispatch fans out) and BEFORE the JSON
  // translator path's `resolveAndTranslate` call (which has
  // nothing to translate when every `--set` is a file column).
  //
  // The helper runs single upfront `precheckLocalFile` + per-item
  // `executeFileColumnSet` (fail-fast vs `--continue-on-error`
  // per `parsed.continueOnError`; sequential vs parallel per
  // `parsed.concurrency`) + post-dispatch `invalidateBoard` +
  // envelope emit (`operation: 'item_update_bulk_file_set'`).
  if (m38FileBulk !== undefined) {
    await runItemUpdateBulkFileDispatch({
      parsed,
      client,
      multipart,
      ctx,
      programOpts,
      apiVersion,
      boardId,
      matchedItemIds,
      m38: m38FileBulk,
      metaSource: meta.source,
      metaCacheAgeSeconds: meta.cacheAgeSeconds,
      filterWarnings: filterResult.warnings,
      retries: globalFlags.retry,
      isDryRun: globalFlags.dryRun,
      noCache: globalFlags.noCache,
    });
    return;
  }

  // v0.8-M46 D2 carve-out fold — bulk multi-file `--set` dispatch.
  // The per-item multi-leg fan-out body runs N sequential file legs
  // per matched item (cross-item parallel under `--concurrency` ×
  // within-item sequential; runtime body shipped at v0.8-M46 IMPL).
  // Fires AFTER the items_page walker + confirmation gate (so an
  // agent sees the matched-count via `confirmation_required` before
  // any dispatch fans out) and BEFORE the JSON translator path's
  // `resolveAndTranslate` call.
  if (m38FileBulkMulti !== undefined) {
    await runItemUpdateBulkFileMultiDispatch({
      parsed,
      client,
      multipart,
      ctx,
      programOpts,
      apiVersion,
      boardId,
      matchedItemIds,
      m38: m38FileBulkMulti,
      metaSource: meta.source,
      metaCacheAgeSeconds: meta.cacheAgeSeconds,
      filterWarnings: filterResult.warnings,
      retries: globalFlags.retry,
      isDryRun: globalFlags.dryRun,
      noCache: globalFlags.noCache,
    });
    return;
  }

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
    // Round-2 P3-1 fix: seed `aggregatedWarnings` with pre-check
    // warnings so `stale_cache_refreshed` survives even though
    // downstream per-item planChanges cache-hits suppress
    // re-emission.
    const aggregatedWarnings: Warning[] = [
      ...filterResult.warnings,
      ...m38Warnings,
    ];
    const sourceAgg = new SourceAggregator({
      source: meta.source,
      cacheAgeSeconds: meta.cacheAgeSeconds,
    });
    for (const itemId of matchedItemIds) {
      // v0.7-M42 IMPL: clean bulk file `--set` paths branched into
      // `runItemUpdateBulkFileDispatch` above (the `m38FileBulk !==
      // undefined` arm) and returned before reaching this loop, so
      // this dry-run body only ever sees JSON-shaped paths.
      // `--set-raw <file-col>=<json>` still rejects normally via
      // `translateRawColumnValue`'s D3 permanent rejection.
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
        // Round-3 P3-1 fix: fold M38 pre-check warnings into the
        // per-item failure envelope so a pre-check
        // `stale_cache_refreshed` rides into the error's
        // `details.resolver_warnings` even when the per-item
        // planChanges throws.
        if (err instanceof MondayCliError && m38Warnings.length > 0) {
          throw mergeResolverWarningsIntoError(err, m38Warnings);
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
  // v0.6-M38 D5 file-set rejection already fired at the pre-check
  // above (step 1.5). resolveAndTranslate processes only non-file
  // setEntries here.
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
    // Round-3 P3-1 fix: fold M38 pre-check warnings into the
    // bulk-live failure envelope's `details.resolver_warnings`.
    if (err instanceof MondayCliError && m38Warnings.length > 0) {
      throw mergeResolverWarningsIntoError(err, m38Warnings);
    }
    throw err;
  }
  // Round-2 P3-1 fix: include M38 pre-check warnings in the live
  // bulk envelope's aggregated warnings. Pre-check warnings are
  // deduped against downstream resolveAndTranslate warnings so
  // `stale_cache_refreshed` surfaces exactly once.
  const collectedWarnings: Warning[] = dedupeWarnings([
    ...filterResult.warnings,
    ...m38Warnings,
    ...resolutionResult.warnings,
  ]) as Warning[];
  // Round-3 P3-2 fix: include M38 pre-check warnings in
  // `resolverWarnings`. This is the slot threaded into
  // `foldAndRemap` for fail-fast bulk errors + partial-success
  // results — without the pre-check leg, a pre-check
  // `stale_cache_refreshed` is absent from per-item failure
  // envelopes (and per-item partial-success records' error
  // details).
  const resolverWarnings: ResolverWarning[] = dedupeWarnings([
    ...m38Warnings,
    ...resolutionResult.warnings,
  ]) as ResolverWarning[];
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
        // many items mutated successfully before the failure, then
        // delegate the typed split + wire-metadata spreads to the
        // shared `reThrowDecorated` helper (R-v0.7-NEW-5).
        const existing = remapped.details ?? {};
        reThrowDecorated(remapped, {
          ...existing,
          applied_count: appliedItems.length,
          applied_to: appliedItems.map((i) => i.id),
          failed_at_item: itemId,
          matched_count: matchedItemIds.length,
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
// v0.6-M38 file-column dispatch helper (cli-design §5.3 step 5
// "File-column dispatch leg" + v0.6-plan §3 M38 D2/D4/D5/D6
// closures). The action body's `preCheckM38FileDispatch` runs
// at the column-resolution boundary BEFORE the dry-run / live
// split, resolves `setEntries`' column types, applies the mutex
// check via `routeFileColumnDispatch`, and returns either
// `kind: 'json'` (proceed with standard planChanges /
// resolveAndTranslate path) or `kind: 'file'` (call the helper
// below to dispatch). Mutex violations (D2 multi-file / mixed,
// D5 bulk, D6 create) throw `usage_error` from inside the
// pre-check with the appropriate `details.reason` discriminator.
// ============================================================

/**
 * Unified file-dispatch helper for `item update` single-item (live
 * + dry-run). The action body's pre-check
 * ({@link preCheckM38FileDispatch}) has already resolved setEntries
 * + applied the mutex check + returned `kind: 'file'` with the
 * resolved column ID, raw path, token, source aggregation, and
 * resolver warnings; this helper takes that result + dispatches
 * accordingly:
 *
 *   - Dry-run: emits the D4 envelope (`planned_changes:
 *     [{operation: 'add_file_to_column', ...}]`; no file bytes
 *     loaded; `meta.source: 'none'` per D4 — the file dispatch's
 *     dry-run is local-derived, mirroring M31 `item upload
 *     --dry-run`). The pre-check's source aggregation is discarded
 *     in favour of D4's `'none'` slot (consistent with M31 dry-run).
 *   - Live: runs {@link precheckLocalFile} + {@link executeFileColumnSet}
 *     + invalidates the board cache + emits the M31-shaped envelope.
 *     The pre-check's resolver warnings ride into the success
 *     envelope's `warnings` slot (P3-1 round-1 fix); source stays
 *     `'live'` (the multipart wire leg).
 */
interface RunItemUpdateSingleFileDispatchInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly boardId: string;
  readonly itemId: string;
  readonly m38: Extract<PreCheckM38FileDispatchResult, { kind: 'file' }>;
  readonly isDryRun: boolean;
  readonly retries: number;
  /** `--filename` for a stdin `<file-col>=-` source (v0.8-M47). */
  readonly filename: string | undefined;
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
}

const runItemUpdateSingleFileDispatch = async (
  inputs: RunItemUpdateSingleFileDispatchInputs,
): Promise<void> => {
  // v0.8-M47 (D7 fold): stdin file `--set <file-col>=-` source. The
  // pre-check (`routeFileColumnDispatch` stdin scope gate) already
  // confirmed this is the sole file entry on the single-item callShape;
  // source the Blob from stdin (via `readStdinFileSource`) instead of a
  // local path. Dry-run emits the D4 size-less echo WITHOUT consuming
  // stdin; live buffers stdin once + dispatches the pre-built Blob via
  // M31's `addFileToColumn` fetcher (the path leg's
  // `executeFileColumnSet` builds its Blob from a path — stdin's is
  // already in hand) + emits the same M31-shaped envelope.
  if (isStdinFileSetSource(inputs.m38.rawValue)) {
    const filename = resolveStdinFilename(inputs.filename);
    if (inputs.isDryRun) {
      emitDryRun({
        ctx: inputs.ctx,
        programOpts: inputs.programOpts,
        plannedChanges: [
          {
            operation: 'add_file_to_column',
            item_id: inputs.itemId,
            column_id: inputs.m38.columnId,
            file_path: STDIN_FILE_SENTINEL,
            filename,
          },
        ],
        source: 'none',
        cacheAgeSeconds: null,
        warnings: inputs.m38.warnings,
        apiVersion: inputs.apiVersion,
      });
      return;
    }
    const stdinSource = await readStdinFileSource(inputs.ctx.stdin, filename);
    const stdinResult = await addFileToColumn({
      client: inputs.client,
      multipart: inputs.multipart,
      itemId: inputs.itemId,
      columnId: inputs.m38.columnId,
      file: stdinSource.blob,
      filename: stdinSource.filename,
      signal: inputs.ctx.signal,
      retries: inputs.retries,
    });
    await invalidateBoard(inputs.boardId, inputs.ctx.env);
    const stdinData: FileColumnSetOutput = {
      operation: 'add_file_to_column',
      item_id: inputs.itemId,
      column_id: inputs.m38.columnId,
      filename: stdinSource.filename,
      file_size_bytes: stdinSource.fileSizeBytes,
      asset: stdinResult.asset,
    };
    emitMutation({
      ctx: inputs.ctx,
      data: stdinData,
      schema: fileColumnSetOutputSchema,
      programOpts: inputs.programOpts,
      warnings: inputs.m38.warnings.map((w) => ({
        code: w.code,
        message: w.message,
        details: w.details,
      })),
      ...inputs.toEmit({
        data: stdinResult.asset,
        complexity: stdinResult.complexity,
        stats: { attempts: 1, totalBackoffMs: 0 },
      }),
      source: 'live',
      cacheAgeSeconds: null,
      complexity: stdinResult.complexity,
      resolvedIds: { [inputs.m38.token]: inputs.m38.columnId },
    });
    return;
  }
  const precheck = await precheckLocalFile(inputs.m38.rawValue);
  if (inputs.isDryRun) {
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges: [
        {
          operation: 'add_file_to_column',
          item_id: inputs.itemId,
          column_id: inputs.m38.columnId,
          file_path: inputs.m38.rawValue,
          filename: precheck.filename,
          file_size_bytes: precheck.fileSizeBytes,
        },
      ],
      source: 'none',
      cacheAgeSeconds: null,
      warnings: inputs.m38.warnings,
      apiVersion: inputs.apiVersion,
    });
    return;
  }
  const result = await executeFileColumnSet({
    client: inputs.client,
    multipart: inputs.multipart,
    itemId: inputs.itemId,
    entry: {
      columnId: inputs.m38.columnId,
      columnType: 'file',
      rawValue: inputs.m38.rawValue,
      filePath: precheck.filePath,
      filename: precheck.filename,
      fileSizeBytes: precheck.fileSizeBytes,
    },
    signal: inputs.ctx.signal,
    retries: inputs.retries,
  });
  // §8 single-leg cache invalidation BEFORE emit (mirrors M31).
  await invalidateBoard(inputs.boardId, inputs.ctx.env);
  const data: FileColumnSetOutput = {
    operation: 'add_file_to_column',
    item_id: inputs.itemId,
    column_id: inputs.m38.columnId,
    filename: precheck.filename,
    file_size_bytes: precheck.fileSizeBytes,
    asset: result.asset,
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: fileColumnSetOutputSchema,
    programOpts: inputs.programOpts,
    warnings: inputs.m38.warnings.map((w) => ({
      code: w.code,
      message: w.message,
      details: w.details,
    })),
    ...inputs.toEmit({
      data: result.asset,
      complexity: result.complexity,
      stats: { attempts: 1, totalBackoffMs: 0 },
    }),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: result.complexity,
    resolvedIds: { [inputs.m38.token]: inputs.m38.columnId },
  });
};

// ============================================================
// v0.7-M42 bulk file `--set` carve-out fold (D5 closure from
// v0.6-M38). Per-item multipart fan-out over the `--where`-resolved
// item-id set, reusing v0.4-M31's `executeFileColumnSet` runtime
// body verbatim under v0.4-M30's `dispatchParallel` /
// `dispatchSequential` selector for `--concurrency` semantics.
//
// **Status: runtime body shipped at v0.7-M42 IMPL.** The pre-flight
// contract diff (commit `160330b`) shipped the argv + pre-check +
// items_page + confirmation-gate surface plus the per-item dispatch
// stub that threw `internal_error` with `details.reason:
// 'm42_preflight_stub'`; IMPL replaces the stub with the runtime
// body below. The `'m42_preflight_stub'` literal is RESERVED across
// the codebase (regression-guarded by an integration test that
// asserts the literal does not appear in stdout/stderr); a
// historical `'file_set_on_bulk_unsupported'` literal stays
// reserved alongside it.
//
// **D-list closures (v0.7-plan §3 M42 entry):**
//
//   - **D1 — `--concurrency` semantics for file dispatch.** Reuse
//     v0.4-M30's `dispatchParallel` over a shared
//     `MultipartTransport`. Each parallel worker constructs its
//     own `MultipartTransportRequest` per call; the transport
//     itself is connection-pool-shared per-token. Closes by
//     inheritance from M30 (concurrency probe pinned at
//     `scripts/probe/m30-concurrency.report.txt`) + M31 (multipart
//     wire pinned at `scripts/probe/m31-asset-upload.report.txt`).
//     No new probe required.
//
//   - **D2 — Per-item asset slot in envelope.** Per-item
//     `data.results[i].asset: { id, name, ... }` echo on success
//     (mirrors M31's `itemUploadOutputSchema`'s `asset` slot);
//     per-item failure surfaces as
//     `data.results[i].error: { code, message }` per M25
//     partial-success. Aggregate `data.summary.{matched_count,
//     applied_count, failed_count, board_id, column_id, filename,
//     file_size_bytes}` extends M25's
//     `partialSuccessBulkUpdateDataSchema` with file-dispatch slots
//     so an agent reading the envelope sees which file was
//     dispatched + where.
//
//   - **D3 — Per-item file pre-check timing.** Single upfront
//     `precheckLocalFile` call BEFORE the per-item dispatch loop —
//     the bulk shape has ONE file path (the value of the file
//     `--set`) shared across N matched items. A failed pre-check
//     surfaces upfront as `usage_error` with `details.reason:
//     'file_not_readable'` / `'file_empty'` (mirrors M31 single-
//     item shape) — this is whole-call-abort regardless of
//     `--continue-on-error`, per cli-design §5.8's "pre-checks
//     MUST fire BEFORE any wire round-trip" atomicity discipline.
//     The `--continue-on-error` flag partitions ONLY the wire-
//     dispatch failures (per-item `add_file_to_column` rejections
//     from Monday), never the local file pre-check.
//
//   - **D4 — ERROR_CODES delta.** Zero. Registry stays at 29.
//     Per-item dispatch failures route through the existing
//     `m25-shaped` per-record `error: { code, message }` shape
//     under `--continue-on-error`, or through the v0.1 fail-fast
//     decoration (`details.applied_to` + `applied_count` +
//     `failed_at_item` + `matched_count`) on the default path;
//     no new top-level code surfaces.
//
// **R-class watch-items.**
//
//   - R-v0.6-NEW-1 (file pre-check + Blob-construction helper) —
//     `precheckLocalFile` consumer count goes 3 → 4 at IMPL (M31
//     item upload + M31 update upload + M38 item set / item update
//     single + M42 bulk item update). Already-shipped helper
//     scales cleanly to consumer 4; graduation candidate at the
//     5th consumer (v0.7-M43 create-time fold likely tips it).
//   - R-v0.6-NEW-2 (`details.reason` discriminator pattern) — 4
//     instances at v0.6-M38; M42 IMPL adds zero new reasons (per
//     D4 zero-delta closure — the existing `'file_not_readable'`
//     / `'file_empty'` / `'multi_file_set_unsupported'` /
//     `'mixed_file_and_value_sets'` reasons cover every M42
//     rejection shape).
//   - R-NEW-76 (parseArgv-BEFORE-c8) — applied at pre-flight; the
//     c8-ignore boundary dropped at IMPL (runtime body fully
//     covered).
//   - R-NEW-72 (post-fix-up cross-doc grep) — apply at every
//     Codex IMPL fix-up round that flips a contract surface.
//
// **R-v0.7-NEW-5 — SHIPPED (v0.8 refactor cluster).** The fail-fast
// error-decoration block (the `usage_error → UsageError` / else →
// `ApiError` typed split + the conditional wire-metadata spreads)
// reached 4 consumers (this helper + the JSON-bulk action body + the
// M46 file-bulk-multi path + bulk clear) and was lifted to
// `reThrowDecorated` in `src/api/error-decoration.ts`. Each site now
// assembles its own `details` decoration and delegates the typed
// split; the helper carries the focused unit test that recovers the
// conditional-spread branch coverage.
// ============================================================

/**
 * Per-item dispatch result for v0.7-M42 bulk file `--set` carve-out
 * fold. Mirrors the M25 `partialSuccessBulkUpdateResultSchema` shape
 * with the file-dispatch's `asset` slot replacing the JSON path's
 * `item` projection:
 *
 *   - Success: `{ item_id, ok: true, asset: { id, name, ... } }`
 *   - Failure: `{ item_id, ok: false, error: { code, message } }`
 *
 * Schema landed at the v0.7-M42 pre-flight contract diff
 * (`160330b`); runtime body shipped at v0.7-M42 IMPL (`22df2fa`)
 * + R1 fix-up (`968b154`).
 */
export const bulkFileSetResultSchema = z.object({
  item_id: z.string().min(1),
  ok: z.boolean(),
  asset: z
    .object({
      id: z.string().min(1),
      name: z.string().min(1),
    })
    .loose()
    .optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});

export type BulkFileSetResult = z.infer<typeof bulkFileSetResultSchema>;

/**
 * Output `data` shape for the v0.7-M42 bulk file `--set` envelope.
 * Mirrors M25's `partialSuccessBulkUpdateDataSchema` structure —
 * `operation: 'item_update_bulk_file_set'` literal discriminator
 * + `summary.{matched_count, applied_count, failed_count,
 * board_id}` aggregate slots + per-item `results[]` array.
 *
 * Invariant: `matched_count === applied_count + failed_count` for
 * every emitted envelope (mirrors M25's invariant).
 */
export const bulkFileSetDataSchema = z.object({
  operation: z.literal('item_update_bulk_file_set'),
  summary: z.object({
    matched_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    board_id: z.string().min(1),
    column_id: z.string().min(1),
    filename: z.string().min(1),
    file_size_bytes: z.number().int().nonnegative(),
  }),
  results: z.array(bulkFileSetResultSchema),
});

export type BulkFileSetData = z.infer<typeof bulkFileSetDataSchema>;

/**
 * v0.8-M46 bulk multi-file `--set` per-item result schema (D6
 * closure — separate envelope shape from M42's single-file
 * `bulkFileSetResultSchema`). Per-item record carries the
 * per-leg asset projections + an `applied_file_columns` echo
 * slot (length 1..N reflecting which file columns landed
 * successfully on this item). On per-item partial failure mid-
 * multi-leg under `--continue-on-error`, `applied_file_columns`
 * length is 0..N-1 (reflecting columns that landed before the
 * failing leg) + `failed_file_column` carries the failing
 * column ID + `error` carries the leg's underlying error.
 *
 * **Status: schema landed at v0.8-M46 pre-flight contract diff
 * (Codex R1 P2-2 fix); runtime emit shipped at v0.8-M46 IMPL.**
 * `runItemUpdateBulkFileMultiDispatch` (below) emits against this
 * schema. Mirrors M42's per-item partial-success shape extended
 * with the multi-leg slots.
 */
export const bulkFileSetMultiResultSchema = z.object({
  item_id: z.string().min(1),
  ok: z.boolean(),
  /**
   * Per-leg asset projections — one per file column that landed
   * on this item. Length N on success; length 0..N-1 on per-item
   * partial failure (`ok: false` with `error` populated). Each
   * entry carries the column ID + asset shape (mirrors M31's
   * Asset projection inside a per-leg context).
   */
  assets: z
    .array(
      z
        .object({
          column_id: z.string().min(1),
          filename: z.string().min(1),
          file_size_bytes: z.number().int().nonnegative(),
          asset: z
            .object({
              id: z.string().min(1),
              name: z.string().min(1),
            })
            .loose(),
        })
        .strict(),
    )
    .optional(),
  /**
   * Echo of file column IDs that landed successfully on this
   * item, in dispatch order. Length 1..N on success; length
   * 0..N-1 on per-item partial failure (reflecting columns that
   * landed before the failing leg).
   */
  applied_file_columns: z.array(z.string().min(1)).optional(),
  /** Column ID of the failing leg on per-item partial failure. */
  failed_file_column: z.string().min(1).optional(),
  error: z
    .object({
      code: z.string().min(1),
      message: z.string().min(1),
    })
    .optional(),
});

export type BulkFileSetMultiResult = z.infer<
  typeof bulkFileSetMultiResultSchema
>;

/**
 * v0.8-M46 bulk multi-file `--set` envelope `data` shape.
 * Discriminate from M42's single-file `bulkFileSetDataSchema`
 * via `operation: 'item_update_bulk_file_set_multi'` (plural).
 * Agents reading `data.operation` branch uniformly across
 * single + multi shapes. Aggregate `summary` extends M42's
 * shape with `file_count: number` (the N file columns per item
 * the call attempted).
 *
 * Invariant: `matched_count === applied_count + failed_count`
 * (per-item rollup; mirrors M42 + M25 invariant). Per-item
 * partial failure mid-multi-leg counts toward `failed_count`
 * with the per-item record's `applied_file_columns` reflecting
 * the partial-leg success.
 *
 * **Status: schema landed at v0.8-M46 pre-flight contract diff
 * (Codex R1 P2-2 fix); runtime emit shipped at v0.8-M46 IMPL.**
 */
export const bulkFileSetMultiDataSchema = z.object({
  operation: z.literal('item_update_bulk_file_set_multi'),
  summary: z.object({
    matched_count: z.number().int().nonnegative(),
    applied_count: z.number().int().nonnegative(),
    failed_count: z.number().int().nonnegative(),
    board_id: z.string().min(1),
    file_count: z.number().int().min(2),
    file_column_ids: z.array(z.string().min(1)).min(2),
  }),
  results: z.array(bulkFileSetMultiResultSchema),
});

export type BulkFileSetMultiData = z.infer<typeof bulkFileSetMultiDataSchema>;

interface RunItemUpdateBulkFileDispatchInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly boardId: string;
  readonly matchedItemIds: readonly string[];
  readonly m38: Extract<PreCheckM38FileDispatchResult, { kind: 'file_bulk' }>;
  readonly metaSource: 'live' | 'cache' | 'mixed';
  readonly metaCacheAgeSeconds: number | null;
  readonly filterWarnings: readonly Warning[];
  readonly retries: number;
  /**
   * v0.7-M42 IMPL: dry-run vs live branching. Carries `globalFlags.dryRun`
   * from the bulk action body so the helper emits the D4 planned_changes
   * envelope (per-item `add_file_to_column` entry) without burning multipart
   * wire round-trips, or runs the per-item dispatch loop on the live path.
   * Mirrors the M38 single-file helper's `isDryRun` slot for consistency
   * across the file-dispatch family.
   */
  readonly isDryRun: boolean;
  /**
   * v0.7-M42 IMPL Codex R1 P1-1 fix: `globalFlags.noCache` threaded
   * through so `foldAndRemap` (Codex pass-1 F4 remap from `src/api/
   * resolver-error-fold.ts`) can refresh stale board metadata when a
   * cache-served file-column resolution surfaces `validation_failed`
   * post-dispatch. Without this, per-item failures bypass the
   * stable-code rule (cli-design §6.5) — `column_archived` would not
   * remap and agents would see `validation_failed` for an archived
   * file column on file-bulk dispatch while the JSON-bulk path
   * already surfaces `column_archived` for the same root cause.
   */
  readonly noCache: boolean;
}

/**
 * Bulk file `--set` per-item dispatch helper (v0.7-M42 D5 carve-out
 * fold).
 *
 * **Status: runtime body shipped at v0.7-M42 IMPL.** argv parse,
 * shape validation, board-metadata load, pre-check (which returned
 * `kind: 'file_bulk'` for callers reaching this helper), items_page
 * walk, and the confirmation gate run upstream — this helper takes
 * the resolved file-column dispatch slot + matched item-IDs and
 * fans the multipart wire across them under the partial-success vs
 * fail-fast contract.
 *
 * **Execution shape:**
 *
 *   1. Single upfront `precheckLocalFile(inputs.m38.rawValue)` —
 *      one file path shared across all matched items. Failure
 *      surfaces as `usage_error` (`file_not_readable` /
 *      `file_empty`) whole-call-abort regardless of
 *      `--continue-on-error` per D3 + cli-design §5.8 atomicity
 *      discipline (pre-checks MUST fire BEFORE any wire round-trip).
 *   2. Dry-run branch — emits the D4-shaped envelope with one
 *      `add_file_to_column` planned_change per matched item-ID
 *      (no file bytes loaded; no multipart wire). Unlike M38
 *      single-item which pins `source: 'none'` (its dry-run is
 *      pure-local), bulk dry-run carries the upstream legs'
 *      aggregated `source` (metadata load + items_page walk —
 *      `mixed` when metadata was cache-served, `live` otherwise);
 *      reaching this branch already paid for those wire legs.
 *   3. Live dispatch — two shapes per `parsed.continueOnError`:
 *      - **Fail-fast (default)** — sequential loop over matched
 *        items (no `--concurrency` per M30 D2 closure:
 *        `--concurrency requires --continue-on-error`); first
 *        per-item failure aborts whole-call with the v0.1-shaped
 *        `details.applied_to` / `applied_count` / `failed_at_item`
 *        / `matched_count` decoration so agents see how many
 *        items applied before the failure.
 *      - **`--continue-on-error`** — routes through
 *        {@link dispatchSequential} (concurrency `undefined`/`1`)
 *        or {@link dispatchParallel} (concurrency `> 1`) over a
 *        shared {@link MultipartTransport}; per-item failures
 *        land as `data.results[i].error: {code, message}` records,
 *        successes carry `data.results[i].asset` via a side-map
 *        fold keyed by `item_id`. `internal_error` re-throws
 *        whole-call via the shared dispatchers' escape hatch
 *        (M14 round-2 F1 precedent) so schema drift surfaces as
 *        top-level `ok: false` rather than per-record.
 *   4. Cache invalidation — single `invalidateBoard(boardId, env)`
 *      after the dispatch loop completes (mirrors M38's single-
 *      leg invalidate timing; one board covers every matched
 *      item's mutated `asset` slot).
 *   5. Envelope emit — `data: BulkFileSetData` with the
 *      `operation: 'item_update_bulk_file_set'` literal
 *      discriminator + per-item `results[]` + aggregate
 *      `summary.{matched_count, applied_count, failed_count,
 *      board_id, column_id, filename, file_size_bytes}`. Warnings
 *      threaded as `dedupeWarnings([...filterWarnings,
 *      ...m38.warnings])` (mirrors the JSON-bulk path); source
 *      derives from `metaSource` (cache-served metadata + live
 *      wire calls → `mixed`).
 */
export const runItemUpdateBulkFileDispatch = async (
  inputs: RunItemUpdateBulkFileDispatchInputs,
): Promise<void> => {
  // 1) Single upfront pre-check (D3 closure). Whole-call abort
  //    regardless of `--continue-on-error` per cli-design §5.8 —
  //    the local file pre-check is shared across N matched items,
  //    so failure aborts the whole call before any multipart wire
  //    leg fires. `precheckLocalFile` throws `usage_error` with
  //    `details.reason: 'file_not_readable'` / `'file_empty'`
  //    (M31 single-item discriminators reused per D4 zero-delta
  //    closure).
  const precheck = await precheckLocalFile(inputs.m38.rawValue);

  // Combined warnings list threaded into every envelope emit below.
  // Mirrors the JSON-bulk `dedupeWarnings(filter ∪ m38)` pattern at
  // the action body; key is `code+message+token` so a pre-check
  // `stale_cache_refreshed` plus a filter-time `stale_cache_refreshed`
  // for the SAME token collapse to one entry.
  const combinedWarnings = dedupeWarnings([
    ...inputs.filterWarnings,
    ...inputs.m38.warnings,
  ]);

  // Source/cache-age aggregator. Seeded with the metadata leg, then
  // folds the M38 pre-check leg + a synthetic 'live' leg representing
  // the items_page walker (always live, fired upstream before this
  // helper). On dry-run the dispatch leg never fires; on live the
  // dispatch leg adds another 'live' record (idempotent under
  // `mergeSource` since 'live' + 'live' = 'live'). Codex IMPL R1
  // P2-1 fix — pre-fix the helper dropped `inputs.m38.source` +
  // `inputs.m38.cacheAgeSeconds`, so a cache-served file-column
  // resolution after a live metadata fetch surfaced `'live'`
  // instead of `'mixed'`. Mirrors the JSON-bulk path's
  // SourceAggregator pattern at runBulk's dry-run + live legs.
  const sourceAgg = new SourceAggregator({
    source: inputs.metaSource,
    cacheAgeSeconds: inputs.metaCacheAgeSeconds,
  });
  if (inputs.m38.source !== undefined) {
    sourceAgg.record(inputs.m38.source, inputs.m38.cacheAgeSeconds);
  }
  // items_page walker always fires live before reaching the helper
  // (the empty-match short-circuit is the only path that skips it,
  // and that path emits the envelope upstream — this helper never
  // sees matchedItemIds.length === 0). Record one synthetic 'live'
  // leg so the aggregate reflects the wire round-trip cost the
  // caller already paid.
  sourceAgg.record('live', null);

  // 2) Dry-run branch — D4-shaped envelope. One
  //    `add_file_to_column` planned_change per matched item-ID;
  //    no file bytes loaded, no multipart wire round-trip. Unlike
  //    the M38 single-item dry-run (which pins `source: 'none'`
  //    because its dry-run is pure-local), bulk dry-run carries
  //    the aggregated upstream `source` — metadata load + items_page
  //    walk + M38 pre-check already paid for wire legs to reach
  //    here.
  if (inputs.isDryRun) {
    const plannedChanges = inputs.matchedItemIds.map((itemId) => ({
      operation: 'add_file_to_column' as const,
      item_id: itemId,
      column_id: inputs.m38.columnId,
      file_path: inputs.m38.rawValue,
      filename: precheck.filename,
      file_size_bytes: precheck.fileSizeBytes,
    }));
    const dryRunAgg = sourceAgg.result();
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges,
      source: dryRunAgg.source,
      cacheAgeSeconds: dryRunAgg.cacheAgeSeconds,
      warnings: combinedWarnings,
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // 3) Live dispatch. Build the shared `FileColumnSetEntry` once —
  //    every per-item leg uses the SAME local file (one path × N
  //    items), so `buildBlobFromPath` (inside `executeFileColumnSet`)
  //    re-reads the bytes per leg rather than sharing one Blob
  //    instance. Re-reading per-leg is the simpler shape; a future
  //    optimisation could memoise the bytes if profiling motivates
  //    it (~bytes × N reads vs ~bytes × 1 read + held in memory).
  const entry = {
    columnId: inputs.m38.columnId,
    columnType: 'file' as const,
    rawValue: inputs.m38.rawValue,
    filePath: precheck.filePath,
    filename: precheck.filename,
    fileSizeBytes: precheck.fileSizeBytes,
  };

  // Live dispatch is always 'live' — fold one more leg into the
  // aggregator. Idempotent if metadata + pre-check were also live
  // ('live' + 'live' = 'live'); promotes 'cache' to 'mixed' when
  // metadata/pre-check served from cache.
  sourceAgg.record('live', null);
  const liveAgg = sourceAgg.result();

  // resolved_ids slot — pre-check returned the resolved column ID
  // for the file token; echo it into the envelope's
  // `meta.resolved_ids` so agents can confirm token-to-ID resolution
  // (mirrors the M38 single-item envelope at `runItemUpdateSingleFileDispatch`).
  const resolvedIds = { [inputs.m38.token]: inputs.m38.columnId };

  // Resolution source for foldAndRemap — defaults to 'live' when
  // pre-check didn't record one (no resolveColumnWithRefresh leg
  // fired; the only path that's possible is the no-setEntries
  // shortcut, which doesn't reach this helper). The remap probe
  // refreshes board metadata + re-checks the file column's
  // `archived` flag when a Monday-side `validation_failed`
  // surfaces against cache-served file-column resolution. Codex
  // IMPL R1 P1-1 fix.
  const remapSource: 'live' | 'cache' | 'mixed' =
    inputs.m38.source ?? 'live';

  // Discriminator for the dispatch shape: fail-fast (default,
  // applied to the v0.1 fail-fast bulk path's `applied_to` decoration)
  // vs `--continue-on-error` (partial-success per-record envelope).
  // M30 D2 closure pins `--concurrency requires --continue-on-error`,
  // so fail-fast bulk file dispatch is always sequential N=1.
  const continueOnError = inputs.parsed.continueOnError === true;

  if (!continueOnError) {
    // Fail-fast bulk file dispatch. Sequential loop; first per-item
    // failure aborts whole-call. Track applied (item_id, asset)
    // pairs so the failure decoration can echo `applied_to` (matches
    // the JSON-bulk fail-fast pattern at runBulk's main loop).
    const appliedAssets: { itemId: string; asset: Asset }[] = [];
    for (const itemId of inputs.matchedItemIds) {
      try {
        const result = await executeFileColumnSet({
          client: inputs.client,
          multipart: inputs.multipart,
          itemId,
          entry,
          signal: inputs.ctx.signal,
          retries: inputs.retries,
        });
        appliedAssets.push({ itemId, asset: result.asset });
      } catch (err: unknown) {
        if (err instanceof MondayCliError) {
          // Codex IMPL R1 P2-2 fix: if any prior item applied
          // successfully, the board's asset state already mutated
          // wire-side — invalidate the cache BEFORE re-throwing the
          // fail-fast error so a follow-up read doesn't serve stale
          // metadata. Mirrors the M38 single-item invalidate-on-
          // success pattern; the JSON-bulk fail-fast path has the
          // same cache-invalidation gap (still-open lift candidate,
          // unrelated to the now-shipped R-v0.7-NEW-5 error-decoration
          // lift).
          if (appliedAssets.length > 0) {
            await invalidateBoard(inputs.boardId, inputs.ctx.env);
          }
          // Codex IMPL R1 P1-1 fix: apply `foldAndRemap` BEFORE
          // building the decoration so per-item failures inherit
          // the SAME `validation_failed` → `column_archived`
          // stale-cache remap the JSON-bulk fail-fast path applies
          // (cli-design §6.5 stable-code rule). Without this, an
          // archived file column surfaces `validation_failed` on
          // file-bulk dispatch but `column_archived` on JSON-bulk
          // dispatch — agents keying on the stable code see
          // inconsistent outcomes for the same root cause.
          const remapped = await foldAndRemap({
            err,
            warnings: inputs.m38.warnings,
            client: inputs.client,
            boardId: inputs.boardId,
            columnIds: [inputs.m38.columnId],
            env: inputs.ctx.env,
            noCache: inputs.noCache,
            resolutionSource: remapSource,
          });
          // Same decoration shape as the JSON-bulk fail-fast path in
          // `runBulk` above. Grafts `applied_count` / `applied_to` /
          // `failed_at_item` / `matched_count` onto `details`, then
          // delegates the typed split to `reThrowDecorated` (which
          // preserves the existing error class' wire-metadata fields).
          const existing = remapped.details ?? {};
          const decoration = {
            ...existing,
            applied_count: appliedAssets.length,
            applied_to: appliedAssets.map((a) => a.itemId),
            failed_at_item: itemId,
            matched_count: inputs.matchedItemIds.length,
          };
          reThrowDecorated(remapped, decoration);
        }
        // Non-CliError programmer bug — re-throw to the runner's
        // catch-all (surfaces as `internal_error` whole-call;
        // mirrors the JSON-bulk fail-fast path). The partial-
        // success invalidate above doesn't fire for this branch
        // because non-CliError throws indicate broken contract,
        // not partial-mutation state worth preserving.
        throw err;
      }
    }

    // Every item applied — single board-cache invalidate before emit
    // (mirrors M38 single-leg invalidate timing).
    await invalidateBoard(inputs.boardId, inputs.ctx.env);

    const results: BulkFileSetResult[] = appliedAssets.map(
      ({ itemId, asset }) => ({
        item_id: itemId,
        ok: true,
        asset,
      }),
    );
    const data: BulkFileSetData = {
      operation: 'item_update_bulk_file_set',
      summary: {
        matched_count: inputs.matchedItemIds.length,
        applied_count: appliedAssets.length,
        failed_count: 0,
        board_id: inputs.boardId,
        column_id: inputs.m38.columnId,
        filename: precheck.filename,
        file_size_bytes: precheck.fileSizeBytes,
      },
      results,
    };
    emitMutation({
      ctx: inputs.ctx,
      data,
      schema: bulkFileSetDataSchema,
      programOpts: inputs.programOpts,
      warnings: combinedWarnings,
      source: liveAgg.source,
      cacheAgeSeconds: liveAgg.cacheAgeSeconds,
      apiVersion: inputs.apiVersion,
      resolvedIds,
    });
    return;
  }

  // `--continue-on-error` path. Per-item failures land as per-record
  // `error: {code, message}` slots; the envelope is `ok: true`
  // regardless of how many items failed (universal partial-success
  // rule per cli-design §6.4). `internal_error` re-throws whole-call
  // via the shared dispatcher's escape hatch — schema drift in the
  // multipart response surfaces as top-level `ok: false`, not
  // papered over as a per-record slot.
  const assetById = new Map<string, Asset>();
  const perTargetDispatch = async ({
    targetId,
  }: DispatchOneTargetInputs<string>): Promise<void> => {
    try {
      const result = await executeFileColumnSet({
        client: inputs.client,
        multipart: inputs.multipart,
        itemId: targetId,
        entry,
        signal: inputs.ctx.signal,
        retries: inputs.retries,
      });
      assetById.set(targetId, result.asset);
    } catch (err: unknown) {
      if (err instanceof MondayCliError) {
        // Codex IMPL R1 P1-1 fix: apply `foldAndRemap` BEFORE
        // re-throwing into the shared dispatcher so per-record
        // `error.code` carries the SAME `column_archived` stable
        // code the JSON-bulk partial-success path emits. Mirrors
        // `runPartialSuccessBulkUpdate`'s perTargetDispatch
        // closure (src/api/partial-success-bulk.ts:431-475).
        // `foldAndRemap` NEVER converts a non-`internal_error`
        // into `internal_error`, so the dispatcher's
        // `internal_error` re-throw escape hatch (M14 round-2 F1)
        // stays intact: schema drift still surfaces as top-level
        // `ok: false` rather than papered over as a per-record
        // slot.
        const remapped = await foldAndRemap({
          err,
          warnings: inputs.m38.warnings,
          client: inputs.client,
          boardId: inputs.boardId,
          columnIds: [inputs.m38.columnId],
          env: inputs.ctx.env,
          noCache: inputs.noCache,
          resolutionSource: remapSource,
        });
        throw remapped;
      }
      // Non-CliError — programmer bug. Re-throw through
      // dispatchSequential / dispatchParallel's non-CliError
      // branch so the runner's catch-all surfaces as
      // internal_error (whole-call, not per-record).
      throw err;
    }
  };

  // Routing — `--concurrency > 1` routes through dispatchParallel
  // (bounded async-pool); absent / `=== 1` routes through
  // dispatchSequential. Both dispatchers thread the optional
  // `signal` so SIGINT-aware callers see consistent cooperative-
  // abort semantics (R-NEW-28 axis 6 — identical between routes).
  let dispatchResults: readonly PartialSuccessResult[];
  if (
    inputs.parsed.concurrency !== undefined &&
    inputs.parsed.concurrency > 1
  ) {
    dispatchResults = await dispatchParallel(
      inputs.matchedItemIds,
      'item_id',
      perTargetDispatch,
      inputs.parsed.concurrency,
      inputs.ctx.signal,
    );
  } else {
    dispatchResults = await dispatchSequential(
      inputs.matchedItemIds,
      'item_id',
      perTargetDispatch,
      inputs.ctx.signal,
    );
  }

  // Single post-dispatch invalidate. Fires even when every per-item
  // dispatch failed (failed_count === matched_count) — wire calls
  // still fired against Monday, so the metadata cache's view of the
  // file column's content count may be stale even if the asset
  // didn't land. Cheap to always fire; expensive if missed.
  await invalidateBoard(inputs.boardId, inputs.ctx.env);

  // Fold dispatcher results + side-map assets into the
  // BulkFileSetResult[] shape. Mirrors `foldPartialSuccessBulkResult`
  // (`src/api/partial-success-bulk.ts`) but with the file-dispatch's
  // `asset` slot replacing the JSON path's `item` projection.
  const results: BulkFileSetResult[] = dispatchResults.map((row) => {
    const itemIdSlot = row.item_id;
    /* c8 ignore next 8 — dispatcher contract: every result row
       carries the id-field slot (populated by the dispatch helper);
       this guard catches a contract violation that would surface as
       a programmer bug, not a Monday-side failure. */
    if (typeof itemIdSlot !== 'string' || itemIdSlot.length === 0) {
      throw new ApiError(
        'internal_error',
        'bulk file dispatch result row is missing the `item_id` field — dispatcher contract violation.',
        { details: { record_keys: Object.keys(row) } },
      );
    }
    if (row.ok) {
      const asset = assetById.get(itemIdSlot);
      /* c8 ignore next 8 — side-map invariant: every successful
         per-target dispatch records the asset; this guard catches a
         wrapper-layer miss (programmer bug). */
      if (asset === undefined) {
        throw new ApiError(
          'internal_error',
          `bulk file dispatch result row for item_id ${itemIdSlot} reported ok: true but no Asset was captured — wrapper-layer side-map miss.`,
          { details: { item_id: itemIdSlot } },
        );
      }
      return { item_id: itemIdSlot, ok: true, asset };
    }
    /* c8 ignore next 8 — dispatcher contract: every `ok: false` row
       carries the `error` slot (populated by the shared dispatcher's
       per-target error decoration). */
    if (row.error === undefined) {
      throw new ApiError(
        'internal_error',
        `bulk file dispatch result row for item_id ${itemIdSlot} reported ok: false but no error payload was captured — dispatcher contract violation.`,
        { details: { item_id: itemIdSlot } },
      );
    }
    return {
      item_id: itemIdSlot,
      ok: false,
      error: { code: row.error.code, message: row.error.message },
    };
  });

  const appliedCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;
  /* c8 ignore next 11 — invariant: every matched item produces
     exactly one result row (success or failure) under both
     dispatchers; mismatch would indicate a programmer bug in the
     dispatcher or the fold. Mirrors `buildPartialSuccessBulkSummary`'s
     defensive check. */
  if (appliedCount + failedCount !== inputs.matchedItemIds.length) {
    throw new ApiError(
      'internal_error',
      `bulk file dispatch summary invariant violated — matched_count (${String(inputs.matchedItemIds.length)}) !== applied_count (${String(appliedCount)}) + failed_count (${String(failedCount)}).`,
      {
        details: {
          matched_count: inputs.matchedItemIds.length,
          applied_count: appliedCount,
          failed_count: failedCount,
          board_id: inputs.boardId,
        },
      },
    );
  }

  const data: BulkFileSetData = {
    operation: 'item_update_bulk_file_set',
    summary: {
      matched_count: inputs.matchedItemIds.length,
      applied_count: appliedCount,
      failed_count: failedCount,
      board_id: inputs.boardId,
      column_id: inputs.m38.columnId,
      filename: precheck.filename,
      file_size_bytes: precheck.fileSizeBytes,
    },
    results,
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: bulkFileSetDataSchema,
    programOpts: inputs.programOpts,
    warnings: combinedWarnings,
    source: liveAgg.source,
    cacheAgeSeconds: liveAgg.cacheAgeSeconds,
    apiVersion: inputs.apiVersion,
    resolvedIds,
  });
};

// ============================================================
// v0.8-M46 multi-file `--set` carve-out fold (D2 closure from
// v0.6-M38). Two helpers — single-item multi-file dispatch + bulk
// per-item multi-leg fan-out — each firing N sequential
// `add_file_to_column` legs per item via the shared
// `dispatchFileLegsSequentially` helper (R-v0.8-NEW-1 lift).
//
// **Status: runtime bodies shipped at v0.8-M46 IMPL.** The
// v0.8-M46 pre-flight contract diff shipped argv parse + pre-check
// + dispatch routing as live contract plus c8-ignored stubs
// throwing `'m46_preflight_stub'`; IMPL swapped the stubs for the
// per-callShape multi-leg fan-out runtime body below. parseArgv +
// sibling parse-boundary helpers run BEFORE the wire-dispatch leg
// per R-NEW-76 (graduated v0.5-M34 pre-flight; wire-dispatch-
// anchored at v0.7-M43 IMPL) — argv-level failures surface as
// `usage_error`, not `internal_error`.
//
// **D-list closures (v0.8-plan §3 M46 entry):**
//
//   - **D1 — Per-item multi-leg ordering.** Sequential within an
//     item; cross-item parallelism reuses M42's `dispatchParallel`
//     (parallel ACROSS items × sequential WITHIN each item's file
//     legs). Sequential within-item preserves the partial-failure
//     surface accuracy (`applied_file_columns` echoes file columns
//     that landed before the failure in dispatch order).
//   - **D2 — Multi-file partial-failure envelope.** Single-item:
//     orphan-warn-style `internal_error` with
//     `details.reason: 'multi_file_update_partial_failure'` +
//     `details.applied_file_columns` + `details.failed_file_column`
//     + `details.cause`. Bulk: M25 partial-success per-item slot
//     extended with `applied_file_columns` + `failed_file_column`
//     under `--continue-on-error`; v0.1 fail-fast decoration
//     extended with `applied_file_columns_per_item` map on
//     default fail-fast path.
//   - **D3 — Pre-check ordering.** Single upfront pass over ALL N
//     file paths BEFORE any wire call (mirrors M42 D3 + M43
//     D-equivalent). Whole-call-abort regardless of
//     `--continue-on-error` per cli-design §5.8.
//   - **D4 — ERROR_CODES delta.** ZERO net change. Registry stays
//     at 29. New `details.reason` discriminator
//     `'multi_file_update_partial_failure'` extends R-v0.6-NEW-2
//     graduated pattern (6th instance — graduated helper absorbs
//     cleanly). `'multi_file_set_unsupported'` literal stays
//     RESERVED post-fold (regression-guarded by integration tests).
//
// **R-class watch-items.**
//
//   - R-v0.8-NEW-1 (per-item multi-leg file fan-out helper) —
//     RESOLVED as LIFT at M46 IMPL. The inner sequential N-leg
//     loop + partial-failure accumulator lifted to
//     `dispatchFileLegsSequentially` (src/api/file-column-set.ts);
//     3 consumers (single-item update / bulk per-item / create-
//     time). Only the per-callShape envelope decoration stayed
//     inlined (single-item `multi_file_update_partial_failure` /
//     bulk per-item-record / create orphan-warn extension).
//   - R-v0.6-NEW-1 (file-source.ts `precheckLocalFile`) —
//     already graduated at 5 consumers; M46 calls it N times per
//     item (one per file path), no new lift work triggered.
//   - R-v0.6-NEW-2 (`details.reason` discriminator pattern) —
//     graduated at 5 instances; M46 adds 1 new + extends 1
//     existing, graduated helper absorbs cleanly.
//   - R-NEW-76 (parseArgv-BEFORE-c8) — the c8-ignore boundary
//     dropped at IMPL; the parseArgv-before-wire-dispatch ordering
//     invariant it anchors stays load-bearing.
// ============================================================

interface RunItemUpdateSingleFileMultiDispatchInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly boardId: string;
  readonly itemId: string;
  readonly m38: Extract<PreCheckM38FileDispatchResult, { kind: 'file_multi' }>;
  readonly isDryRun: boolean;
  readonly retries: number;
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
}

/**
 * Single-item multi-file `--set` dispatch helper (v0.8-M46 D2
 * carve-out fold). Runtime body shipped at v0.8-M46 IMPL.
 *
 * **Execution shape:**
 *
 *   1. Single upfront `precheckLocalFile` per file path (N pre-checks
 *      in argv order; D3 closure). Any pre-check failure aborts the
 *      whole call with `usage_error` (`file_not_readable` /
 *      `file_empty`) BEFORE any wire round-trip fires — atomicity-
 *      before-wire per cli-design §5.8.
 *   2. Dry-run branch — N `add_file_to_column` planned_changes,
 *      `source: 'none'` (pure-local, mirrors M38 single-item
 *      dry-run); no multipart wire fires.
 *   3. Live branch — sequential N legs via
 *      {@link dispatchFileLegsSequentially} (R-v0.8-NEW-1 shared
 *      helper) against the single `inputs.itemId`. On partial
 *      failure, `invalidateBoard` (any landed legs mutated the
 *      board's asset state wire-side) then `internal_error` with
 *      `details.reason: 'multi_file_update_partial_failure'` +
 *      `details.item_id` + `details.applied_file_columns` (length
 *      0..N-1) + `details.failed_file_column` + `details.cause`
 *      (M31 wire-failure surface, JSON projection) + `details.hint`.
 *      Unlike the bulk + create paths, the single-item path does NOT
 *      run `foldAndRemap` on the failing leg's cause — it mirrors the
 *      M38 single-item precedent (`runItemUpdateSingleFileDispatch`
 *      doesn't remap either); an archived file column is already
 *      rejected at the pre-check's `includeArchived` archived-column
 *      guard before dispatch.
 *   4. Full success — single `invalidateBoard` then envelope emit
 *      per `fileColumnSetMultiOutputSchema`
 *      (`operation: 'add_files_to_columns'` + `assets: [...]` +
 *      `applied_file_columns: [...]`, both length N).
 */
const runItemUpdateSingleFileMultiDispatch = async (
  inputs: RunItemUpdateSingleFileMultiDispatchInputs,
): Promise<void> => {
  // 1) Upfront pre-check per file path, in argv order. A bad path
  //    surfaces `usage_error` (exit 1) whole-call-abort before any
  //    multipart wire leg fires (cli-design §5.8). R-v0.6-NEW-1
  //    `precheckLocalFile` called N times (one per file column).
  const legEntries: MultiFileLegEntry[] = [];
  for (const entry of inputs.m38.entries) {
    const precheck = await precheckLocalFile(entry.rawValue);
    legEntries.push({
      columnId: entry.columnId,
      rawValue: entry.rawValue,
      filePath: precheck.filePath,
      filename: precheck.filename,
      fileSizeBytes: precheck.fileSizeBytes,
    });
  }

  const warnings = inputs.m38.warnings.map((w) => ({
    code: w.code,
    message: w.message,
    details: w.details,
  }));
  const resolvedIds: Readonly<Record<string, string>> = Object.fromEntries(
    inputs.m38.entries.map((e) => [e.token, e.columnId]),
  );

  // 2) Dry-run branch — N planned_changes; pure-local, `source: 'none'`
  //    (mirrors M38 single-item dry-run).
  if (inputs.isDryRun) {
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges: legEntries.map((leg) => ({
        operation: 'add_file_to_column' as const,
        item_id: inputs.itemId,
        column_id: leg.columnId,
        file_path: leg.rawValue,
        filename: leg.filename,
        file_size_bytes: leg.fileSizeBytes,
      })),
      source: 'none',
      cacheAgeSeconds: null,
      warnings,
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // 3) Live branch — sequential N-leg fan-out against the single item.
  const dispatch = await dispatchFileLegsSequentially({
    client: inputs.client,
    multipart: inputs.multipart,
    itemId: inputs.itemId,
    entries: legEntries,
    signal: inputs.ctx.signal,
    retries: inputs.retries,
  });

  if (dispatch.failure !== undefined) {
    // Partial failure. If any leg landed, the board's asset state
    // mutated wire-side — invalidate before re-throwing so a
    // follow-up read doesn't serve stale metadata (mirrors M42's
    // fail-fast invalidate-on-partial-apply).
    if (dispatch.appliedColumns.length > 0) {
      await invalidateBoard(inputs.boardId, inputs.ctx.env);
    }
    const cause = dispatch.failure.cause;
    const causeProjection = projectCauseForEnvelope(cause);
    throw new ApiError(
      'internal_error',
      `Multi-file \`--set\` on item ${inputs.itemId} partially failed: ` +
        `${String(dispatch.appliedColumns.length)} of ` +
        `${String(legEntries.length)} file column(s) landed before column ` +
        `${dispatch.failure.failedColumn} failed ` +
        `(${cause.code}: ${cause.message}). The applied file columns ` +
        `persist on Monday; retry only the unfailed columns with ` +
        `\`monday item set ${inputs.itemId} <file-col>=<path>\`, or reissue ` +
        `all ${String(legEntries.length)} \`--set\` entries.`,
      {
        cause,
        details: {
          reason: 'multi_file_update_partial_failure',
          item_id: inputs.itemId,
          applied_file_columns: dispatch.appliedColumns,
          failed_file_column: dispatch.failure.failedColumn,
          cause: causeProjection,
          hint:
            `${String(dispatch.appliedColumns.length)} file column(s) ` +
            `already landed on item ${inputs.itemId}; retry the unfailed ` +
            `columns alone with \`monday item set ${inputs.itemId} ` +
            `<file-col>=<path>\`, or reissue every \`--set\` entry (the ` +
            `landed columns will be overwritten with the same files).`,
        },
      },
    );
  }

  // 4) Full success — single board-cache invalidate before emit
  //    (mirrors M38 single-leg invalidate timing; one board covers
  //    every leg's mutated asset slot).
  await invalidateBoard(inputs.boardId, inputs.ctx.env);
  const data: FileColumnSetMultiOutput = {
    operation: 'add_files_to_columns',
    item_id: inputs.itemId,
    assets: dispatch.assets.map((a) => ({
      column_id: a.column_id,
      filename: a.filename,
      file_size_bytes: a.file_size_bytes,
      asset: a.asset,
    })),
    applied_file_columns: [...dispatch.appliedColumns],
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: fileColumnSetMultiOutputSchema,
    programOpts: inputs.programOpts,
    warnings,
    ...inputs.toEmit({
      data: dispatch.assets,
      complexity: dispatch.lastComplexity,
      stats: { attempts: 1, totalBackoffMs: 0 },
    }),
    source: 'live',
    cacheAgeSeconds: null,
    complexity: dispatch.lastComplexity,
    resolvedIds,
  });
};

interface RunItemUpdateBulkFileMultiDispatchInputs {
  readonly parsed: ParsedInput;
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly apiVersion: string;
  readonly boardId: string;
  readonly matchedItemIds: readonly string[];
  readonly m38: Extract<
    PreCheckM38FileDispatchResult,
    { kind: 'file_bulk_multi' }
  >;
  readonly metaSource: 'live' | 'cache' | 'mixed';
  readonly metaCacheAgeSeconds: number | null;
  readonly filterWarnings: readonly Warning[];
  readonly retries: number;
  readonly isDryRun: boolean;
  readonly noCache: boolean;
}

/**
 * Bulk multi-file `--set` per-item dispatch helper (v0.8-M46 D2
 * carve-out fold). Runtime body shipped at v0.8-M46 IMPL.
 *
 * **Execution shape (extends M42's `runItemUpdateBulkFileDispatch`
 * single-file bulk path to N file legs per item):**
 *
 *   1. Single upfront `precheckLocalFile` pass over ALL N file paths
 *      (D3 — N pre-checks total, shared across the M matched items,
 *      NOT N×M). Any failure aborts the whole call with `usage_error`
 *      regardless of `--continue-on-error` per cli-design §5.8.
 *   2. Dry-run branch — N×M `add_file_to_column` planned_changes
 *      (one per (item, file column) pair); source aggregates the
 *      upstream metadata + items_page legs per M42's pattern.
 *   3. Live branch — cross-item parallel via M42's `dispatchParallel`
 *      / `dispatchSequential` (under `--concurrency`) × within-item
 *      sequential N legs via {@link dispatchFileLegsSequentially}
 *      (D1). Two shapes per `parsed.continueOnError`:
 *      - **Fail-fast (default)** — sequential over matched items;
 *        first per-item failure aborts whole-call with
 *        `details.applied_to` (items where ALL legs landed) +
 *        `details.applied_file_columns_per_item` (the failed item's
 *        partial-leg map) + `details.failed_at_item` +
 *        `details.failed_file_column`.
 *      - **`--continue-on-error`** — per-item failures land as
 *        `data.results[i].error` extended with
 *        `applied_file_columns` + `failed_file_column`; partially-
 *        landed assets carry on `data.results[i].assets`.
 *   4. Post-dispatch `invalidateBoard` + emit per
 *      `bulkFileSetMultiDataSchema`
 *      (`operation: 'item_update_bulk_file_set_multi'` +
 *      `summary.{file_count, file_column_ids}`).
 *
 * Per-item failures route through `foldAndRemap` BEFORE the per-item
 * record / fail-fast decoration so the stable-code rule (cli-design
 * §6.5) surfaces `column_archived` for cache-served file-column
 * resolution against an archived column — mirrors M42's bulk
 * single-file remap.
 */
const runItemUpdateBulkFileMultiDispatch = async (
  inputs: RunItemUpdateBulkFileMultiDispatchInputs,
): Promise<void> => {
  // 1) Single upfront pre-check pass over ALL N file paths (D3).
  //    Shared across the M matched items — N pre-checks, NOT N×M.
  //    Whole-call abort regardless of `--continue-on-error` per
  //    cli-design §5.8 (`precheckLocalFile` throws `usage_error`
  //    with `file_not_readable` / `file_empty`).
  const legEntries: MultiFileLegEntry[] = [];
  for (const entry of inputs.m38.entries) {
    const precheck = await precheckLocalFile(entry.rawValue);
    legEntries.push({
      columnId: entry.columnId,
      rawValue: entry.rawValue,
      filePath: precheck.filePath,
      filename: precheck.filename,
      fileSizeBytes: precheck.fileSizeBytes,
    });
  }

  const fileColumnIds = legEntries.map((leg) => leg.columnId);
  const combinedWarnings = dedupeWarnings([
    ...inputs.filterWarnings,
    ...inputs.m38.warnings,
  ]);
  const resolvedIds: Readonly<Record<string, string>> = Object.fromEntries(
    inputs.m38.entries.map((e) => [e.token, e.columnId]),
  );

  // Source aggregator — mirrors M42's bulk single-file pattern.
  // Seeds the metadata leg, folds the M38 pre-check leg + a synthetic
  // 'live' leg for the items_page walker (always fired upstream).
  const sourceAgg = new SourceAggregator({
    source: inputs.metaSource,
    cacheAgeSeconds: inputs.metaCacheAgeSeconds,
  });
  if (inputs.m38.source !== undefined) {
    sourceAgg.record(inputs.m38.source, inputs.m38.cacheAgeSeconds);
  }
  sourceAgg.record('live', null);

  // 2) Dry-run branch — N×M planned_changes (one `add_file_to_column`
  //    per (item, file column) pair). No file bytes loaded, no
  //    multipart wire. Source carries the aggregated upstream legs
  //    (mirrors M42's bulk dry-run, which is NOT pure-local).
  if (inputs.isDryRun) {
    const plannedChanges = inputs.matchedItemIds.flatMap((itemId) =>
      legEntries.map((leg) => ({
        operation: 'add_file_to_column' as const,
        item_id: itemId,
        column_id: leg.columnId,
        file_path: leg.rawValue,
        filename: leg.filename,
        file_size_bytes: leg.fileSizeBytes,
      })),
    );
    const dryRunAgg = sourceAgg.result();
    emitDryRun({
      ctx: inputs.ctx,
      programOpts: inputs.programOpts,
      plannedChanges,
      source: dryRunAgg.source,
      cacheAgeSeconds: dryRunAgg.cacheAgeSeconds,
      warnings: combinedWarnings,
      apiVersion: inputs.apiVersion,
    });
    return;
  }

  // 3) Live dispatch. Record the dispatch leg as 'live'.
  sourceAgg.record('live', null);
  const liveAgg = sourceAgg.result();
  const remapSource: 'live' | 'cache' | 'mixed' = inputs.m38.source ?? 'live';
  const fileCount = legEntries.length;
  const continueOnError = inputs.parsed.continueOnError === true;

  if (!continueOnError) {
    // Fail-fast bulk multi-file dispatch. Sequential over matched
    // items (M30 D2: `--concurrency requires --continue-on-error`).
    // Each item fans out N sequential file legs; first per-item
    // failure aborts whole-call.
    const fullyApplied: { itemId: string; assets: readonly MultiFileLegAsset[] }[] =
      [];
    for (const itemId of inputs.matchedItemIds) {
      const dispatch = await dispatchFileLegsSequentially({
        client: inputs.client,
        multipart: inputs.multipart,
        itemId,
        entries: legEntries,
        signal: inputs.ctx.signal,
        retries: inputs.retries,
      });
      if (dispatch.failure !== undefined) {
        // Any prior item fully applied OR this item landed ≥1 leg →
        // the board's asset state mutated wire-side; invalidate
        // before re-throwing (mirrors M42 fail-fast invalidate).
        if (fullyApplied.length > 0 || dispatch.appliedColumns.length > 0) {
          await invalidateBoard(inputs.boardId, inputs.ctx.env);
        }
        const remapped = await foldAndRemap({
          err: dispatch.failure.cause,
          warnings: inputs.m38.warnings,
          client: inputs.client,
          boardId: inputs.boardId,
          columnIds: fileColumnIds,
          env: inputs.ctx.env,
          noCache: inputs.noCache,
          resolutionSource: remapSource,
        });
        const existing = remapped.details ?? {};
        const decoration = {
          ...existing,
          applied_count: fullyApplied.length,
          applied_to: fullyApplied.map((a) => a.itemId),
          applied_file_columns_per_item: {
            [itemId]: dispatch.appliedColumns,
          },
          failed_at_item: itemId,
          failed_file_column: dispatch.failure.failedColumn,
          matched_count: inputs.matchedItemIds.length,
          file_count: fileCount,
          file_column_ids: fileColumnIds,
        };
        reThrowDecorated(remapped, decoration);
      }
      fullyApplied.push({ itemId, assets: dispatch.assets });
    }

    // Every item applied all N legs — single board-cache invalidate
    // before emit.
    await invalidateBoard(inputs.boardId, inputs.ctx.env);
    const results: BulkFileSetMultiResult[] = fullyApplied.map(
      ({ itemId, assets }) => ({
        item_id: itemId,
        ok: true,
        assets: assets.map((a) => ({
          column_id: a.column_id,
          filename: a.filename,
          file_size_bytes: a.file_size_bytes,
          asset: a.asset,
        })),
        applied_file_columns: [...fileColumnIds],
      }),
    );
    const data: BulkFileSetMultiData = {
      operation: 'item_update_bulk_file_set_multi',
      summary: {
        matched_count: inputs.matchedItemIds.length,
        applied_count: fullyApplied.length,
        failed_count: 0,
        board_id: inputs.boardId,
        file_count: fileCount,
        file_column_ids: [...fileColumnIds],
      },
      results,
    };
    emitMutation({
      ctx: inputs.ctx,
      data,
      schema: bulkFileSetMultiDataSchema,
      programOpts: inputs.programOpts,
      warnings: combinedWarnings,
      source: liveAgg.source,
      cacheAgeSeconds: liveAgg.cacheAgeSeconds,
      apiVersion: inputs.apiVersion,
      resolvedIds,
    });
    return;
  }

  // `--continue-on-error` path. Per-item failures land as per-record
  // slots; the envelope is `ok: true` regardless of how many items
  // failed (universal partial-success rule). Each item's within-item
  // fan-out is sequential; a partial mid-multi-leg failure records
  // the landed assets + applied_file_columns + failed_file_column on
  // the per-item record. `internal_error` (or non-CliError) re-throws
  // whole-call via the shared dispatcher's escape hatch.
  const successById = new Map<string, readonly MultiFileLegAsset[]>();
  const partialById = new Map<
    string,
    {
      readonly assets: readonly MultiFileLegAsset[];
      readonly appliedColumns: readonly string[];
      readonly failedColumn: string;
    }
  >();
  const perTargetDispatch = async ({
    targetId,
  }: DispatchOneTargetInputs<string>): Promise<void> => {
    const dispatch = await dispatchFileLegsSequentially({
      client: inputs.client,
      multipart: inputs.multipart,
      itemId: targetId,
      entries: legEntries,
      signal: inputs.ctx.signal,
      retries: inputs.retries,
    });
    if (dispatch.failure !== undefined) {
      // Record the partial state (landed assets + applied columns +
      // failing column) keyed by item_id, then re-throw the remapped
      // error so the shared dispatcher captures it as `ok: false` +
      // `error: {code, message}`. `foldAndRemap` NEVER converts a
      // non-`internal_error` into `internal_error`, so the
      // dispatcher's `internal_error` escape hatch stays intact.
      partialById.set(targetId, {
        assets: dispatch.assets,
        appliedColumns: dispatch.appliedColumns,
        failedColumn: dispatch.failure.failedColumn,
      });
      const remapped = await foldAndRemap({
        err: dispatch.failure.cause,
        warnings: inputs.m38.warnings,
        client: inputs.client,
        boardId: inputs.boardId,
        columnIds: fileColumnIds,
        env: inputs.ctx.env,
        noCache: inputs.noCache,
        resolutionSource: remapSource,
      });
      throw remapped;
    }
    successById.set(targetId, dispatch.assets);
  };

  let dispatchResults: readonly PartialSuccessResult[];
  if (
    inputs.parsed.concurrency !== undefined &&
    inputs.parsed.concurrency > 1
  ) {
    dispatchResults = await dispatchParallel(
      inputs.matchedItemIds,
      'item_id',
      perTargetDispatch,
      inputs.parsed.concurrency,
      inputs.ctx.signal,
    );
  } else {
    dispatchResults = await dispatchSequential(
      inputs.matchedItemIds,
      'item_id',
      perTargetDispatch,
      inputs.ctx.signal,
    );
  }

  // Single post-dispatch invalidate (fires even when every item
  // failed — wire calls still fired against Monday).
  await invalidateBoard(inputs.boardId, inputs.ctx.env);

  const results: BulkFileSetMultiResult[] = dispatchResults.map((row) => {
    const itemIdSlot = row.item_id;
    /* c8 ignore next 8 — dispatcher contract: every result row carries
       the id-field slot; this guard catches a contract violation that
       would surface as a programmer bug, not a Monday-side failure. */
    if (typeof itemIdSlot !== 'string' || itemIdSlot.length === 0) {
      throw new ApiError(
        'internal_error',
        'bulk multi-file dispatch result row is missing the `item_id` field — dispatcher contract violation.',
        { details: { record_keys: Object.keys(row) } },
      );
    }
    if (row.ok) {
      const assets = successById.get(itemIdSlot);
      /* c8 ignore next 8 — side-map invariant: every successful
         per-target dispatch records its assets; this guard catches a
         wrapper-layer miss (programmer bug). */
      if (assets === undefined) {
        throw new ApiError(
          'internal_error',
          `bulk multi-file dispatch result row for item_id ${itemIdSlot} reported ok: true but no assets were captured — wrapper-layer side-map miss.`,
          { details: { item_id: itemIdSlot } },
        );
      }
      return {
        item_id: itemIdSlot,
        ok: true,
        assets: assets.map((a) => ({
          column_id: a.column_id,
          filename: a.filename,
          file_size_bytes: a.file_size_bytes,
          asset: a.asset,
        })),
        applied_file_columns: [...fileColumnIds],
      };
    }
    /* c8 ignore next 8 — dispatcher contract: every `ok: false` row
       carries the `error` slot (populated by the shared dispatcher's
       per-target error decoration). */
    if (row.error === undefined) {
      throw new ApiError(
        'internal_error',
        `bulk multi-file dispatch result row for item_id ${itemIdSlot} reported ok: false but no error payload was captured — dispatcher contract violation.`,
        { details: { item_id: itemIdSlot } },
      );
    }
    const partial = partialById.get(itemIdSlot);
    /* c8 ignore next 8 — side-map invariant: every per-target failure
       routes through `perTargetDispatch`'s `partialById.set` before
       re-throwing; a miss is a wrapper-layer programmer bug. */
    if (partial === undefined) {
      throw new ApiError(
        'internal_error',
        `bulk multi-file dispatch result row for item_id ${itemIdSlot} reported ok: false but no partial-leg state was captured — wrapper-layer side-map miss.`,
        { details: { item_id: itemIdSlot } },
      );
    }
    return {
      item_id: itemIdSlot,
      ok: false,
      assets: partial.assets.map((a) => ({
        column_id: a.column_id,
        filename: a.filename,
        file_size_bytes: a.file_size_bytes,
        asset: a.asset,
      })),
      applied_file_columns: [...partial.appliedColumns],
      failed_file_column: partial.failedColumn,
      error: { code: row.error.code, message: row.error.message },
    };
  });

  const appliedCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;
  /* c8 ignore next 11 — invariant: every matched item produces exactly
     one result row under both dispatchers; mismatch indicates a
     programmer bug in the dispatcher or the fold. */
  if (appliedCount + failedCount !== inputs.matchedItemIds.length) {
    throw new ApiError(
      'internal_error',
      `bulk multi-file dispatch summary invariant violated — matched_count (${String(inputs.matchedItemIds.length)}) !== applied_count (${String(appliedCount)}) + failed_count (${String(failedCount)}).`,
      {
        details: {
          matched_count: inputs.matchedItemIds.length,
          applied_count: appliedCount,
          failed_count: failedCount,
          board_id: inputs.boardId,
        },
      },
    );
  }

  const data: BulkFileSetMultiData = {
    operation: 'item_update_bulk_file_set_multi',
    summary: {
      matched_count: inputs.matchedItemIds.length,
      applied_count: appliedCount,
      failed_count: failedCount,
      board_id: inputs.boardId,
      file_count: fileCount,
      file_column_ids: [...fileColumnIds],
    },
    results,
  };
  emitMutation({
    ctx: inputs.ctx,
    data,
    schema: bulkFileSetMultiDataSchema,
    programOpts: inputs.programOpts,
    warnings: combinedWarnings,
    source: liveAgg.source,
    cacheAgeSeconds: liveAgg.cacheAgeSeconds,
    apiVersion: inputs.apiVersion,
    resolvedIds,
  });
};
