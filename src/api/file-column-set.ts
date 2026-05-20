/**
 * Files-shaped friendly `--set` dispatch (`cli-design.md` §5.3
 * writer-expansion roadmap "files" row + §13 v0.6 entry,
 * `v0.6-plan.md` §3 M38).
 *
 * **Status: runtime bodies shipped at v0.6-M38 IMPL.** The dispatch
 * type signatures + the per-mutex-rejection error shape + the
 * fetcher wrapping M31's `addFileToColumn` all landed at pre-flight;
 * IMPL swaps the c8-ignored stub bodies for runtime logic. No new
 * wire fetcher (M38 reuses the v0.4-M31 multipart wire verbatim);
 * no new transport seam.
 *
 * **Wire surface.** Zero net change. When `monday item set <iid>
 * <file-col>=<path>` OR `monday item update <iid> --set
 * <file-col>=<path>` resolves to a `file`-typed column, the
 * command action body branches OFF the standard JSON-translator
 * path INTO M31's multipart `addFileToColumn` fetcher via
 * `executeFileColumnSet` below. The translator
 * (`translateColumnValueAsync` in `column-values.ts`) stays
 * JSON-output-shaped for the 13 existing writable types — the
 * file-column dispatch is a SIBLING leg routed at the command
 * action body level, NOT a new payload format inside the
 * translator union.
 *
 * **Why a sibling leg, not a translator widening.** Three reasons
 * pin the design (cli-design §5.3 step 4 + step 5 prose):
 *
 *   1. The wire surface is fundamentally different — multipart
 *      `add_file_to_column` vs JSON `change_column_value` /
 *      `change_multiple_column_values`. Folding the file payload
 *      into `ColumnValuePayload` would require a `format: 'file'`
 *      union variant that `selectMutation` can't bundle into the
 *      multi-mutation (each `add_file_to_column` is a single
 *      per-column multipart round-trip; bundling N file uploads
 *      into one mutation isn't a Monday wire shape).
 *   2. The atomicity contract differs — the 13 existing types
 *      bundle atomically via `change_multiple_column_values` when
 *      ≥2 columns target the same item. File-column writes are
 *      single-column-per-wire-call only on Monday's wire (each
 *      `add_file_to_column` round-trip targets one file column);
 *      mixing a file-column `--set` with any value `--set` /
 *      `--set-raw` / `--name` in the same call would force a
 *      multi-leg dispatch across the multipart + JSON wire
 *      surfaces that breaks the existing atomicity guarantee
 *      (M38 enforces the mixed-rule mutex below — D2 closure;
 *      universal on non-create callShapes, SUPPRESSED on
 *      `'item_create'` per v0.7-M43 D6 asymmetry). Multi-file
 *      `--set` CARVED OUT at v0.8-M46 (D2 fold): the CLI now
 *      routes multi-leg fan-out for the 3 reachable callShapes
 *      (`'item_update_single'` / `'item_update_bulk'` /
 *      `'item_create'`), preserving the single-column-per-wire-
 *      call invariant by firing N sequential
 *      `add_file_to_column` calls per item. The existing
 *      atomicity contract on the JSON `column_values` bundle
 *      stays intact; the multi-file dispatch's atomicity
 *      envelope (partial-failure shape per D2 closure) is
 *      separately decorated.
 *   3. The translator's input contract is "value-string-to-JSON-
 *      payload" — file columns take a file path, not a value
 *      string. Path validation + `fs.stat` + `fs.access(R_OK)` +
 *      Blob construction don't fit the translator's pure-function
 *      shape; routing the path through the sibling leg keeps each
 *      helper focused.
 *
 * **Reuse from v0.4-M31.** The wire dispatch reuses
 * `addFileToColumn` from `src/api/assets.ts` verbatim — same
 * `MultipartTransport.request(...)` round-trip, same `withRetry`
 * shape, same `file_too_large` rewrap-inside-retry-thunk pattern
 * (R-v0.4-W2 axis 7 "non-retryable rewrap placement" carries
 * through safely-by-construction since the dispatch goes through
 * the existing fetcher rather than a re-implementation).
 *
 * **Consumer counts post v0.6-M38 IMPL close** (runtime bodies
 * shipped at `e749931` + the R-v0.6-NEW-1 lift at `3c2a9b0`;
 * pre-flight stubs collapsed):
 *
 *   - `addFileToColumn` (M31): 2 consumers (M31's `item upload`
 *     action body + M38's `executeFileColumnSet` runtime body).
 *   - `MultipartTransport` via `ResolvedClient.multipart`: 2
 *     consumers (the same test seam pattern; M31's two upload
 *     verbs + M38's dispatch share the slot).
 *   - `sniffContentType` from `src/utils/mime.ts`: 2 consumers
 *     post-lift (M31's `item upload` + M31's `update upload` —
 *     both via {@link buildBlobFromPath}; M38 routes through
 *     `buildBlobFromPath` rather than calling `sniffContentType`
 *     directly).
 *   - **R-v0.6-NEW-1 SHIPPED at IMPL kickoff**: the file-pre-check
 *     + Blob-construction pattern lifted to `src/utils/file-source
 *     .ts` (`precheckLocalFile` + `buildBlobFromPath` — 3 consumers
 *     post-lift: M31's `item upload`, M31's `update upload`, M38's
 *     `executeFileColumnSet`).
 *
 * **Mutex rules (D2 closure).** Enforced at the column-resolution
 * boundary (parse-time can't know — column types only resolve
 * after metadata loads). When any resolved column has `type ===
 * 'file'`:
 *
 *   - Multi-file `--set` per call — **CARVED OUT at v0.8-M46**
 *     (D2 fold). At v0.6-M38 + v0.7 this rejected universally
 *     with `'multi_file_set_unsupported'`; v0.8-M46 lifts the
 *     CLI mutex for the 3 reachable callShapes
 *     (`'item_update_single'` / `'item_update_bulk'` /
 *     `'item_create'`) and routes through new `'file_multi'` /
 *     `'file_bulk_multi'` / `'file_create_multi'` enforcement
 *     kinds for the action body's per-item multi-leg fan-out
 *     (sequential within an item × parallel across items for
 *     bulk). Monday wire stays single-column-per-wire-call
 *     (each `add_file_to_column` round-trip targets one file
 *     column); M46 fans N CLI legs per item rather than
 *     bundling them on the wire. The throw remains for the
 *     `'item_set'` callShape as a defensive type-system
 *     ceiling — `monday item set <iid> <col>=<value>` accepts
 *     exactly one positional and is argv-incapable of
 *     expressing 2+ file `--set` entries; the throw is
 *     unreachable from production argv but kept as defense-in-
 *     depth.
 *   - NO other value `--set` / `--set-raw` / `--name` flags
 *     allowed (mixing would force non-atomic multi-leg dispatch
 *     across the multipart + JSON wire surfaces — universal on
 *     `'item_set'` / `'item_update_single'` / `'item_update_bulk'`,
 *     SUPPRESSED on `'item_create'` per v0.7-M43 D6 asymmetry).
 *   - Bulk `item update --where ... --set <file-col>=<path>` —
 *     **CARVED OUT at v0.7-M42** (D5 fold). At v0.6-M38 this was
 *     REJECTED with `'file_set_on_bulk_unsupported'`; v0.7-M42's
 *     pre-flight contract diff returns
 *     `{ kind: 'file_bulk', columnId, rawValue }` from
 *     {@link enforceSingleFileColumnSet} on the clean dispatch
 *     path so the action body can branch into the per-item
 *     multipart fan-out. Multi-file / mixed mutex rules STILL
 *     apply on bulk (those are universal).
 *   - `item create --set <file-col>=<path>` — **CARVED OUT at
 *     v0.7-M43** (D6 fold). At v0.6-M38 this was REJECTED with
 *     `'file_set_on_create_unsupported'`; v0.7-M43's pre-flight
 *     contract diff returns
 *     `{ kind: 'file_create', columnId, rawValue }` from
 *     {@link enforceSingleFileColumnSet} on the clean dispatch
 *     path so the action body can branch into the two-leg
 *     dispatch (`create_item` then `add_file_to_column`).
 *     Multi-file mutex rule STILL applies on create (universal).
 *     The mixed rule is callShape-aware: on `'item_create'` the
 *     `--name` arm + non-file value `--set` / `--set-raw` arms
 *     are SUPPRESSED (leg-1 `create_item` natively bundles
 *     `column_values` atomically + `item_name` is required on
 *     create); the D3 `--set-raw <file-col>=<json>` rejection
 *     at `raw-write.ts:translateRawColumnValue` stays in force
 *     (separate enforcement layer).
 *
 * Rejection surfaces share the `usage_error.details.reason`
 * discriminator pattern from M14 / M27 / M31:
 *
 *   - `'mixed_file_and_value_sets'` — file `--set` + any value
 *     `--set` / `--set-raw` / `--name` in same call. Applies on
 *     single-item AND bulk call shapes (universal mutex rule).
 *   - `'multi_file_set_unsupported'` — **NO LONGER SURFACES**
 *     from `'item_update_single'` / `'item_update_bulk'` /
 *     `'item_create'` callShapes at v0.8-M46 onwards (D2 carve-out
 *     fold; multi-file dispatch now routes through new `file_multi`
 *     / `file_bulk_multi` / `file_create_multi` enforcement kinds
 *     for the action body's per-item multi-leg fan-out). The
 *     discriminator literal stays RESERVED across the codebase
 *     (do not reuse for a different rejection reason; mirrors
 *     M42 / M43 reserved-literal discipline). The throw remains
 *     for the `'item_set'` callShape as a defensive type-system
 *     ceiling — the single-positional `monday item set <iid>
 *     <col>=<value>` shape is argv-incapable of expressing 2+
 *     file `--set` entries, so this rejection is argv-unreachable
 *     in practice; kept as defense-in-depth.
 *   - `'file_set_on_bulk_unsupported'` — **NO LONGER SURFACES**
 *     at v0.7-M42 onwards. Historical reference only; the
 *     discriminator literal stays reserved across the codebase
 *     (do not reuse for a different rejection reason).
 *   - `'file_set_on_create_unsupported'` — **NO LONGER SURFACES**
 *     at v0.7-M43 onwards. Historical reference only; the
 *     discriminator literal stays reserved across the codebase
 *     (do not reuse for a different rejection reason).
 *
 * **D3 closure — `--set-raw <file-col>=<json>` STAYS REJECTED.**
 * Files have no JSON wire shape Monday's `change_column_value`
 * accepts; the escape-hatch contract "user supplies the JSON
 * `change_column_value` accepts" doesn't compose with the
 * multipart wire. The existing rejection at
 * `raw-write.ts:translateRawColumnValue` stays unchanged; the
 * prose enumerates every shipped friendly write path (v0.6-M38
 * single-item, v0.7-M42 bulk, v0.7-M43 create-time, v0.4-M31
 * verb-shaped upload) so agents reading the `--set-raw`
 * rejection see the full set of working alternatives rather
 * than just the M38 single-item form.
 *
 * **D7 closure — `<path>='-'` stdin support OUT OF SCOPE.**
 * Mirrors M31 `monday item upload`'s rejection rationale — no
 * clean `--filename` companion shape pinned for `--set
 * <file-col>=-` syntax (stdin reads byte-anonymously; the
 * filename is the load-bearing handle for Monday's wire
 * `Asset.name` slot). Carry-forward candidate for v0.7.x once a
 * `--filename` companion shape is pinned.
 *
 * **No new ERROR_CODE (D8 closure; registry stays at 29).** All
 * M38-specific rejections route through existing `usage_error`
 * with `details.reason` discrimination.
 *
 * **R-NEW-41 4th supporting site filed at M38 pre-flight.** The
 * `--set` syntax is type-uniform from the agent's view
 * (`<col>=<value>`), but for file columns the value is a path
 * and the dispatch transitions silently from JSON to multipart at
 * the translator boundary. The asymmetry is at the AGENT-INPUT
 * boundary, NOT at the wire boundary (M31's multipart-vs-JSON
 * asymmetry #3 is wire-boundary-only). See `docs/architecture.md`
 * "Wire-vs-CLI semantics documentation conventions" for the
 * canonical cross-link.
 */

import { z } from 'zod';
import { ApiError } from '../utils/errors.js';
import { buildBlobFromPath } from '../utils/file-source.js';
import { addFileToColumn, assetSchema, type Asset } from './assets.js';
import { resolveColumnWithRefresh, type ResolverWarning } from './columns.js';
import { foldResolverWarningsIntoError } from './resolver-error-fold.js';
import { buildColumnArchivedError } from './resolution-pass.js';
import { mergeSource, mergeCacheAge } from './source-aggregator.js';
import type { Complexity } from '../utils/output/envelope.js';
import type { MondayClient } from './client.js';
import type { MultipartTransport } from './multipart-transport.js';

/**
 * Post-resolution entry shape for a file-column `--set <col>=<path>`
 * dispatch leg. Produced by the action body's column-resolution +
 * file-pre-check pipeline; consumed by {@link executeFileColumnSet}.
 *
 * The `columnId` slot carries the RESOLVED Monday column ID (not
 * the argv token); the `rawValue` slot preserves the argv-derived
 * path (preserved for dry-run envelope echo per D4 — mirrors M31
 * `item upload`'s `parsed.file` argv-derived shape per the round-2
 * P3-2 fix).
 *
 * `filename` is `basename(filePath)` — the load-bearing handle for
 * Monday's wire `Asset.name` slot.
 *
 * `fileSizeBytes` is the local `fs.stat()` measurement captured at
 * pre-check time. Echoed in the dry-run envelope + threaded into
 * the `file_too_large` rewrap's `details.file_size_bytes` slot on
 * Monday's server-side size-cap rejection (mirrors M31's pattern).
 */
export interface FileColumnSetEntry {
  /** Resolved Monday column ID (post-`resolveColumnWithRefresh`). */
  readonly columnId: string;
  /** Resolved column type — narrowed to the files-shaped literal. */
  readonly columnType: 'file';
  /** The argv-derived path token (relative or absolute as the agent typed it). */
  readonly rawValue: string;
  /** Resolved absolute path (post `path.resolve(process.cwd(), rawValue)`). */
  readonly filePath: string;
  /** `basename(filePath)` — Monday's wire `Asset.name` source. */
  readonly filename: string;
  /** Local `fs.stat()` size at pre-check time. */
  readonly fileSizeBytes: number;
}

/**
 * Output envelope shape for the file-column `--set` dispatch leg.
 * Mirrors `itemUploadOutputSchema` from `src/api/assets.ts` so the
 * envelope shape is byte-equivalent to M31 `monday item upload` for
 * an agent reading the result — the dispatch source differs
 * (`monday item set` / `monday item update` vs `monday item upload`)
 * but the envelope payload structure is identical.
 *
 * The `operation` slot pins `'add_file_to_column'` literally
 * (mirroring M31's envelope discriminator); agents reading
 * `data.operation` can branch uniformly on the wire mutation
 * regardless of which CLI verb routed there.
 */
export const fileColumnSetOutputSchema = z
  .object({
    operation: z.literal('add_file_to_column'),
    item_id: z.string().min(1),
    column_id: z.string().min(1),
    filename: z.string().min(1),
    file_size_bytes: z.number().int().nonnegative(),
    asset: assetSchema,
  })
  .strict();

export type FileColumnSetOutput = z.infer<typeof fileColumnSetOutputSchema>;

/**
 * Output envelope shape for the v0.8-M46 multi-file `--set` dispatch
 * leg on single-item `monday item update <iid> --set f1=p1 --set
 * f2=p2 ...`. Discriminate from M38's single-file envelope via the
 * new `operation: 'add_files_to_columns'` literal (plural) — agents
 * branch on `data.operation` to handle single vs multi shapes
 * uniformly.
 *
 * Per-file slot mirrors M31's `Asset` shape verbatim wrapped under
 * a `column_id` + `filename` + `file_size_bytes` per-entry context.
 * The `applied_file_columns` slot echoes the file columns that
 * landed on success (length N; always present on multi-file success
 * envelopes).
 *
 * **Status: schema landed at v0.8-M46 pre-flight contract diff;
 * runtime emit lifted at v0.8-M46 IMPL.** Pre-flight runtime path
 * throws `'m46_preflight_stub'` from the c8-ignored stub helper;
 * the schema is the contract IMPL builds against.
 */
export const fileColumnSetMultiOutputSchema = z
  .object({
    operation: z.literal('add_files_to_columns'),
    item_id: z.string().min(1),
    assets: z
      .array(
        z
          .object({
            column_id: z.string().min(1),
            filename: z.string().min(1),
            file_size_bytes: z.number().int().nonnegative(),
            asset: assetSchema,
          })
          .strict(),
      )
      .min(2),
    applied_file_columns: z.array(z.string().min(1)).min(2),
  })
  .strict();

export type FileColumnSetMultiOutput = z.infer<
  typeof fileColumnSetMultiOutputSchema
>;

/**
 * Inputs for the M38 file-column dispatch fetcher. Wraps M31's
 * `addFileToColumn` (`src/api/assets.ts`) verbatim — no new wire
 * mutation, no new transport seam.
 *
 * The runtime body (below in this module) reads:
 *
 *   1. Construct a `Blob` from the local file at
 *      `inputs.entry.filePath` via {@link buildBlobFromPath} (read
 *      bytes via `fs/promises.readFile` + sniff content-type from
 *      filename); the caller already ran {@link precheckLocalFile}
 *      so the path is known good + size known non-zero.
 *   2. Call `addFileToColumn({client, multipart, itemId, columnId,
 *      file, filename, signal, retries})` — M31's fetcher already
 *      wraps the multipart dispatch in `withRetry(...)` + handles
 *      the file_too_large rewrap-inside-retry-thunk pattern.
 *   3. Project the result into {@link FileColumnSetOutput} shape
 *      with the `operation: 'add_file_to_column'` literal +
 *      agent-supplied slots (item_id, column_id, filename,
 *      file_size_bytes) — emitted by the action body after this
 *      fetcher returns.
 */
export interface ExecuteFileColumnSetInputs {
  readonly client: MondayClient;
  readonly multipart: MultipartTransport;
  readonly itemId: string;
  readonly entry: FileColumnSetEntry;
  /** Combined runner signal — same threading as M31's `addFileToColumn`. */
  readonly signal: AbortSignal;
  /** Retry budget — threaded into `withRetry(...)` at IMPL via M31's fetcher. */
  readonly retries: number;
}

/**
 * Result of the M38 file-column dispatch fetcher. Mirrors M31's
 * `AddFileToColumnResult` shape — the dispatch is a thin wrapper
 * around M31's existing fetcher so the result projection stays
 * identical.
 */
export interface ExecuteFileColumnSetResult {
  readonly asset: Asset;
  readonly source: 'live';
  readonly cacheAgeSeconds: null;
  readonly complexity: Complexity | null;
}

/**
 * Reads the local file at `inputs.entry.filePath`, constructs a Blob
 * via {@link buildBlobFromPath} (with `Content-Type` sniffed from the
 * filename), and dispatches the multipart upload through M31's
 * {@link addFileToColumn} fetcher (cli-design §5.3 step 5 + the
 * module docstring above pin the load-bearing design).
 *
 * **Status: runtime body shipped at v0.6-M38 IMPL.** Wraps M31's
 * fetcher verbatim — same `operationName: 'AddFileToColumn'`, same
 * `withRetry(...)` retry semantics, same rewrap-inside-retry-thunk
 * pattern for `file_too_large` (R-v0.4-W2 axis 7 carries through
 * safely-by-construction since the dispatch goes through the
 * existing fetcher rather than a re-implementation).
 *
 * The action-body caller (in `item set` / `item update`) is
 * responsible for:
 *
 *   1. Parsing argv + collecting `--set` / `--set-raw` / `--name`
 *      entries.
 *   2. Resolving columns via `resolveColumnWithRefresh`.
 *   3. Calling {@link enforceSingleFileColumnSet} to detect the
 *      file-column dispatch leg + enforce the mutex rules.
 *   4. Running {@link precheckLocalFile} from
 *      `src/utils/file-source.ts` on the agent-supplied path to
 *      build a {@link FileColumnSetEntry} (the precheck surfaces
 *      `usage_error.details.reason: 'file_not_readable'` /
 *      `'file_empty'` before any wire activity per the M31
 *      ordering invariant).
 *   5. Calling this fetcher for the wire dispatch.
 *   6. Emitting the envelope per `fileColumnSetOutputSchema`
 *      (mirrors M31 `item upload` envelope verbatim).
 */
export const executeFileColumnSet = async (
  inputs: ExecuteFileColumnSetInputs,
): Promise<ExecuteFileColumnSetResult> => {
  const blob = await buildBlobFromPath({
    filePath: inputs.entry.filePath,
    filename: inputs.entry.filename,
    fileSizeBytes: inputs.entry.fileSizeBytes,
  });
  const result = await addFileToColumn({
    client: inputs.client,
    multipart: inputs.multipart,
    itemId: inputs.itemId,
    columnId: inputs.entry.columnId,
    file: blob,
    filename: inputs.entry.filename,
    signal: inputs.signal,
    retries: inputs.retries,
  });
  return {
    asset: result.asset,
    source: 'live',
    cacheAgeSeconds: null,
    complexity: result.complexity,
  };
};

/**
 * Mutex enforcement at the column-resolution boundary. Takes the
 * resolved column-type information for every `--set` / `--set-raw`
 * entry + the `--name` presence flag + the call shape (single-item
 * vs bulk vs create), and either:
 *
 *   - Returns `{ kind: 'json' }` when NO file-column entries are
 *     present in `setEntries` — the standard JSON translator path
 *     applies and the action body proceeds unchanged.
 *   - Returns `{ kind: 'file', columnId, rawValue }` when a clean
 *     file-column dispatch path applies on a single-item non-
 *     create call (exactly one file `--set`, no other value
 *     flags). The caller runs {@link buildBlobFromPath} via
 *     {@link precheckLocalFile} from `src/utils/file-source.ts`
 *     to build a {@link FileColumnSetEntry} + invokes
 *     {@link executeFileColumnSet}.
 *   - Returns `{ kind: 'file_bulk', columnId, rawValue }` when a
 *     clean bulk file-column dispatch path applies (v0.7-M42 D5
 *     carve-out fold). Action body branches into the per-item
 *     multipart fan-out helper.
 *   - Returns `{ kind: 'file_create', columnId, rawValue }` when a
 *     clean create-time file-column dispatch path applies
 *     (v0.7-M43 D6 carve-out fold). Action body branches into the
 *     two-leg `create_item` then `add_file_to_column` dispatch
 *     helper.
 *   - Throws `ApiError('usage_error', ...)` with a
 *     `details.reason` discriminator when a mutex violation is
 *     detected: `'multi_file_set_unsupported'` (defensive throw
 *     on `'item_set'` callShape only — argv-unreachable; v0.8-M46
 *     D2 fold lifted the multi-file gate on the 3 reachable
 *     callShapes) OR `'duplicate_resolved_file_columns'` (v0.8-
 *     M46 multi-file leg — 2+ file `--set` entries resolving to
 *     the same column ID; mirrors JSON path's cross-token
 *     duplicate-resolved-ID contract) OR `'mixed_file_and_value_sets'`
 *     (D2 mixed leg — universal on non-create callShapes;
 *     SUPPRESSED on `'item_create'` per the D6 mixed-rule
 *     asymmetry since `create_item` natively bundles
 *     `column_values` atomically + `item_name` is required on
 *     create).
 *
 * Three reserved-literal discriminators NO LONGER SURFACE from
 * this function on the reachable callShape paths:
 *
 *   - `'file_set_on_bulk_unsupported'` (v0.6-M38 D5) → folded at
 *     v0.7-M42; returns `kind: 'file_bulk'` on clean dispatch.
 *   - `'file_set_on_create_unsupported'` (v0.6-M38 D6) → folded
 *     at v0.7-M43; returns `kind: 'file_create'` on clean
 *     dispatch.
 *   - `'multi_file_set_unsupported'` (v0.6-M38 D2 universal) →
 *     folded at v0.8-M46 for the 3 reachable callShapes; returns
 *     `kind: 'file_multi'` / `'file_bulk_multi'` /
 *     `'file_create_multi'` on clean multi-file dispatch. Throw
 *     remains on `'item_set'` defensively (argv-unreachable).
 *
 * All three literals stay RESERVED in docstrings as historical
 * reference; do not re-introduce as runtime rejections without
 * fresh contract decisions.
 *
 * Pure synchronous check — no I/O, no side effects. The caller
 * resolves columns first (via `resolveColumnWithRefresh` or the
 * existing `resolveAndTranslate` helper's resolution leg) and
 * passes the resolved column types here.
 *
 * **Status: runtime body shipped at v0.6-M38 IMPL; extended at
 * v0.7-M42 pre-flight contract diff for the D5 carve-out fold.**
 * Per R-NEW-76 graduated discipline, callers invoke `parseArgv`
 * BEFORE this function so argv-level failures surface as
 * `usage_error` from the parse boundary (this function itself
 * runs AFTER argv parse + column resolution).
 */
export type FileColumnSetEnforcementResult =
  | { readonly kind: 'json' }
  | { readonly kind: 'file'; readonly columnId: string; readonly rawValue: string }
  // v0.7-M42 carve-out fold (D5 closure). Bulk `item update --where
  // ... --set <file-col>=<path>` returns this variant on the clean
  // dispatch path so the action body branches into the per-item
  // multipart fan-out. The slot shape mirrors `kind: 'file'` —
  // resolved column ID + agent-supplied raw path; per-item dispatch
  // happens at the action layer (one local file pre-check upfront +
  // N parallel/sequential `executeFileColumnSet` calls per matched
  // item).
  | { readonly kind: 'file_bulk'; readonly columnId: string; readonly rawValue: string }
  // v0.7-M43 carve-out fold (D6 closure). Create-time `monday item
  // create --set <file-col>=<path>` returns this variant on the clean
  // dispatch path so the action body branches into the two-leg
  // helper (`create_item` then `add_file_to_column`). The slot shape
  // mirrors `kind: 'file'` — resolved column ID + agent-supplied raw
  // path; the action body bundles the non-file `--set` / `--set-raw`
  // entries into leg-1's `create_item.column_values`, then dispatches
  // leg-2 against the freshly-created item ID. Atomicity-envelope
  // shape per cli-design §5.8 — orphan-warn surfaces leg-1's item
  // ID via `internal_error.details.created_item_id` when leg-2 fails
  // (D1 closure).
  | { readonly kind: 'file_create'; readonly columnId: string; readonly rawValue: string }
  // v0.8-M46 carve-out fold (D2 closure — multi-file `--set` per
  // call). 2+ file `--set` entries on `'item_update_single'` route
  // to this variant; the action body branches into
  // `runItemUpdateSingleFileMultiDispatch` (in `commands/item/
  // update.ts`) which runs an upfront `precheckLocalFile` per path,
  // then sequences N `executeFileColumnSet` calls per the single
  // target item ID. The `entries` slot carries the resolved file
  // columns + agent-supplied raw paths in argv order (length ≥ 2;
  // single-file routes to `kind: 'file'` per the existing path).
  // Mutex rules at v0.8-M46: mixed-rule UNCHANGED (still rejects
  // file + value `--set` / `--set-raw` / `--name` per the universal
  // rule on `'item_update_single'` callShape).
  | {
      readonly kind: 'file_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
      }[];
    }
  // v0.8-M46 carve-out fold (D2 closure). 2+ file `--set` entries
  // on `'item_update_bulk'` route to this variant; the action body
  // branches into `runItemUpdateBulkFileMultiDispatch` which runs
  // an upfront pre-check pass over ALL file paths once + fans out
  // N legs per matched item under `--concurrency` (cross-item
  // parallel) × within-item sequential (D1 closure). Per-item
  // partial failure mid-multi-leg surfaces via M42's partial-
  // success envelope extended with `applied_file_columns` +
  // `failed_file_column` slots (D2 closure).
  | {
      readonly kind: 'file_bulk_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
      }[];
    }
  // v0.8-M46 carve-out fold (D2 closure). 2+ file `--set` entries
  // on `'item_create'` route to this variant; the action body
  // branches into `runItemCreateFileMultiDispatch` which runs
  // upfront `precheckLocalFile` per path, leg-1 `create_item` with
  // bundled non-file `column_values`, then N sequential
  // `add_file_to_column` legs (legs 2..N+1) against the new item
  // ID. Atomicity envelope extends M43's orphan-warn:
  // `create_then_file_upload_partial_failure` extended with
  // `applied_file_columns` always-present slot (length 0..N-1)
  // reflecting file columns that landed before the failing leg.
  | {
      readonly kind: 'file_create_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
      }[];
    };

export interface EnforceSingleFileColumnSetInputs {
  /**
   * The call shape — determines which mutex rejections apply.
   *
   *   - `'item_set'` — single-column `monday item set`. Only the
   *     single positional `<col>=<value>` is in play; the rejection
   *     surface is limited to the file-vs-set-raw mutex (`--set-raw
   *     <file-col>=<json>` stays rejected by `raw-write.ts:
   *     translateRawColumnValue` per D3 — no new mutex needed here).
   *   - `'item_update_single'` — single-item `monday item update
   *     <iid>`. Multiple `--set` + `--set-raw` + `--name` flags are
   *     accepted. M38 originally enforced "single file `--set` +
   *     no other value flags"; v0.8-M46 D2 carve-out fold lifts
   *     the multi-file gate — clean multi-file dispatch returns
   *     `kind: 'file_multi'` for the action body's per-item
   *     multi-leg fan-out helper. Duplicate resolved file-column
   *     IDs reject with `'duplicate_resolved_file_columns'`.
   *     Mixed-rule (file + value `--set` / `--set-raw` /
   *     `--name`) STILL rejects on this callShape per the
   *     universal mixed mutex.
   *   - `'item_update_bulk'` — `monday item update --where ...`.
   *     At v0.6-M38 this rejected with `'file_set_on_bulk_unsupported'`;
   *     v0.7-M42 carves out the D5 closure — clean single-file
   *     bulk-file dispatch returns `kind: 'file_bulk'` for the
   *     action body's per-item multipart fan-out. v0.8-M46 D2
   *     carve-out fold lifts the multi-file gate — clean multi-
   *     file dispatch returns `kind: 'file_bulk_multi'` for the
   *     per-item multi-leg fan-out (sequential within an item ×
   *     parallel across items). Monday wire stays single-column-
   *     per-wire-call (each `add_file_to_column` round-trip
   *     targets one file column); M46 fans N legs per item over
   *     the same single-column-per-wire-call surface. Mixed-rule
   *     STILL rejects per the universal mixed mutex.
   *   - `'item_create'` — `monday item create`. At v0.6-M38 this
   *     rejected with `'file_set_on_create_unsupported'`;
   *     v0.7-M43 carves out the D6 closure — clean single-file
   *     create-time dispatch returns `kind: 'file_create'` for the
   *     action body's two-leg `create_item` then
   *     `add_file_to_column` helper. v0.8-M46 D2 carve-out fold
   *     lifts the multi-file gate — clean multi-file dispatch
   *     returns `kind: 'file_create_multi'` for the action body's
   *     two-leg-group helper (leg-1 `create_item` with bundled
   *     non-file `column_values` + N sequential file legs).
   *     Mixed-rule SUPPRESSED on create per D6 asymmetry
   *     (`create_item` natively bundles non-file `column_values`
   *     atomically + `--name` is required on create).
   *     `--set-raw <file-col>=<json>` stays rejected at
   *     `raw-write.ts:translateRawColumnValue` per D3 (separate
   *     enforcement layer).
   */
  readonly callShape:
    | 'item_set'
    | 'item_update_single'
    | 'item_update_bulk'
    | 'item_create';
  /**
   * Resolved column entries — one per `--set` token, in argv order.
   * Each carries the resolved column ID + type discriminator + the
   * agent-supplied raw value (path or value-string).
   */
  readonly setEntries: readonly {
    readonly columnId: string;
    readonly columnType: string;
    readonly rawValue: string;
  }[];
  /**
   * Resolved `--set-raw` entries — one per `--set-raw` token, in
   * argv order. Carries the resolved column ID + type (after
   * `resolveColumnWithRefresh`). Used for the mutex check ONLY —
   * the actual `--set-raw` rejection for file types stays in
   * `raw-write.ts:translateRawColumnValue` per D3.
   */
  readonly setRawEntries: readonly {
    readonly columnId: string;
    readonly columnType: string;
  }[];
  /** True when `--name <n>` was passed (`item update` only). */
  readonly hasName: boolean;
}

/**
 * Iterates `inputs.setEntries`, identifies entries with
 * `columnType === 'file'`, applies the mutex rules per D2 / D5 / D6
 * closures, and returns either `{ kind: 'json' }` (no file entries),
 * `{ kind: 'file', columnId, rawValue }` (clean dispatch path), or
 * throws `ApiError('usage_error', ...)` on a mutex violation.
 *
 * Mutex priority (ratified at M38 pre-flight; updated at v0.7-M42
 * + v0.7-M43 pre-flights to fold the D5 bulk + D6 create carve-outs;
 * updated at v0.8-M46 pre-flight to fold the D2 multi-file carve-out):
 *
 *   1. **callShape gate — ONLY `'item_set'` defensive throw remains**
 *      post-v0.8-M46. The v0.6-M38 `'item_update_bulk'` (D5 fold at
 *      v0.7-M42) and `'item_create'` (D6 fold at v0.7-M43) short-
 *      circuit-throws have been removed; the v0.6-M38 universal
 *      multi-file throw FOLDED at v0.8-M46 (D2) for the 3 reachable
 *      callShapes. The `'item_set'` callShape's multi-file throw
 *      stays as defensive type-system ceiling — the single-
 *      positional `monday item set <iid> <col>=<value>` verb is
 *      argv-incapable of expressing 2+ file `--set` entries, so
 *      this branch is argv-unreachable in practice; kept as
 *      defense-in-depth.
 *   2. **multi-file leg (`'item_set'` only post-fold)** — 2+ file
 *      `--set` entries on `'item_set'` callShape surface
 *      `'multi_file_set_unsupported'` (argv-unreachable defensive).
 *      The other 3 reachable callShapes (`'item_update_single'` /
 *      `'item_update_bulk'` / `'item_create'`) fall through to the
 *      mixed gate + clean leg for the multi-file dispatch routing.
 *   3. **mixed leg** — 1+ file `--set` + any value `--set` /
 *      `--set-raw` / `--name` surfaces `'mixed_file_and_value_sets'`
 *      on `'item_set'` / `'item_update_single'` / `'item_update_bulk'`.
 *      Universal rule on those callShapes: mixing forces non-atomic
 *      multi-leg dispatch across the multipart + JSON wire surfaces.
 *      **SUPPRESSED on `'item_create'`** per v0.7-M43 D6 mixed-rule
 *      asymmetry — `create_item` natively bundles non-file
 *      `column_values` atomically into leg-1, and `--name` is
 *      required on create.
 *   4. **clean leg** — ≥1 file `--set`, no mutex violation. Branches
 *      on N (single vs multi) then callShape:
 *      - N=1 (single-file path):
 *        - `'item_update_single'` / `'item_set'` → `{ kind: 'file',
 *          columnId, rawValue }` (M38 path; unchanged).
 *        - `'item_update_bulk'` → `{ kind: 'file_bulk', ... }`
 *          (v0.7-M42 D5 carve-out fold).
 *        - `'item_create'` → `{ kind: 'file_create', ... }`
 *          (v0.7-M43 D6 carve-out fold).
 *      - N>1 (multi-file path — v0.8-M46 D2 carve-out fold):
 *        - `'item_update_single'` → `{ kind: 'file_multi', entries }`
 *          for the single-item multi-leg fan-out helper.
 *        - `'item_update_bulk'` → `{ kind: 'file_bulk_multi',
 *          entries }` for the bulk per-item multi-leg fan-out.
 *        - `'item_create'` → `{ kind: 'file_create_multi', entries }`
 *          for the create-time two-leg-group multi-file helper.
 *
 * The function is sync + pure. No I/O. Path validation lives at a
 * SEPARATE step (`precheckLocalFile` from `src/utils/file-source.ts`)
 * that the caller runs AFTER this function returns a `kind: 'file*'`
 * result.
 */
export const enforceSingleFileColumnSet = (
  inputs: EnforceSingleFileColumnSetInputs,
): FileColumnSetEnforcementResult => {
  const fileSetEntries = inputs.setEntries.filter(
    (e) => e.columnType === 'file',
  );
  if (fileSetEntries.length === 0) {
    return { kind: 'json' };
  }

  // callShape gate — NO callShape short-circuits at this layer
  // post v0.7-M43. The v0.6-M38 `'item_create'` short-circuit-throw
  // (`'file_set_on_create_unsupported'`) FOLDED at v0.7-M43 (D6):
  // create-time file `--set` falls through to the universal multi-
  // file gate + a callShape-aware mixed gate, then returns
  // `{ kind: 'file_create', ... }` on the clean path. The discriminator
  // literal `'file_set_on_create_unsupported'` stays RESERVED in
  // docstrings + regression-guard tests; do not re-introduce it as a
  // runtime rejection without a fresh contract decision. (Parallels
  // the v0.7-M42 fold of `'file_set_on_bulk_unsupported'` for
  // `'item_update_bulk'`.)

  // Multi-file leg (D2 multi). v0.8-M46 D2 carve-out fold: lifted
  // on the 3 reachable callShapes (`'item_update_single'`,
  // `'item_update_bulk'`, `'item_create'`); the action body routes
  // the multi-file dispatch into the per-callShape multi-leg
  // helper via the new `file_multi` / `file_bulk_multi` /
  // `file_create_multi` enforcement kinds (see clean-leg block
  // below).
  //
  // The `'item_set'` callShape's defensive throw stays in force —
  // the single-positional `monday item set <iid> <col>=<value>`
  // verb is argv-incapable of expressing 2+ file `--set` entries,
  // so this branch is argv-unreachable in practice; kept as
  // defense-in-depth + type-system ceiling. The
  // `'multi_file_set_unsupported'` discriminator literal stays
  // RESERVED across the codebase post-fold (mirrors v0.7-M42 D5
  // fold of `'file_set_on_bulk_unsupported'` + v0.7-M43 D6 fold of
  // `'file_set_on_create_unsupported'` reserved-literal discipline).
  if (fileSetEntries.length > 1 && inputs.callShape === 'item_set') {
    throw new ApiError(
      'usage_error',
      `Multi-file \`--set <file-col>=<path>\` is not supported on the ` +
        `\`monday item set\` single-positional verb (argv-unreachable ` +
        `defensive guard — \`item set <iid> <col>=<value>\` accepts ` +
        `exactly one positional). For multi-file dispatch, use ` +
        `\`monday item update <iid> --set <file-col>=<path> --set ` +
        `<file-col2>=<path2> ...\` (v0.8-M46 single-item multi-file ` +
        `path) or \`monday item create --board <bid> --set ` +
        `<file-col>=<path> --set <file-col2>=<path2> ...\` ` +
        `(v0.8-M46 create-time multi-file path).`,
      {
        details: {
          reason: 'multi_file_set_unsupported',
          file_count: fileSetEntries.length,
          file_column_ids: fileSetEntries.map((e) => e.columnId),
          call_shape: inputs.callShape,
          hint:
            'use `monday item update <iid> --set ...` or `monday item ' +
            'create --set ...` for multi-file dispatch (v0.8-M46 ' +
            'carve-out fold).',
        },
      },
    );
  }

  // Mixed leg (D2). 1 file `--set` + any value `--set` / `--set-raw`
  // / `--name` — surfaces because Monday's wire has no atomic combo
  // of multipart `add_file_to_column` + JSON `change_column_value` /
  // `change_multiple_column_values` (mixing forces non-atomic
  // multi-leg dispatch that breaks the §5.3 atomicity contract).
  //
  // v0.7-M43 callShape carve-out (D6 mixed-rule asymmetry): on
  // `'item_create'` the two-leg dispatch (`create_item` with bundled
  // non-file column_values then `add_file_to_column`) absorbs the
  // mixed scenarios into leg-1 atomicity for the non-file values +
  // leg-2 atomicity for the file. `--name` is REQUIRED on create
  // (not an opt-in rename like on update), so the universal `hasName`
  // arm would auto-reject every M43 path; suppress on `'item_create'`.
  // Non-file value `--set` + `--set-raw` entries are ALSO allowed on
  // create-time mixed (they bundle into leg-1's `column_values`); the
  // separate D3 `--set-raw <file-col>=<json>` rejection still applies
  // at `raw-write.ts:translateRawColumnValue` for `file`-typed raw
  // tokens, so the action-body path stays safe. The non-create
  // callShapes ('item_set' / 'item_update_single' / 'item_update_bulk')
  // keep the universal mixed rule unchanged.
  const nonFileSetCount = inputs.setEntries.length - fileSetEntries.length;
  const setRawCount = inputs.setRawEntries.length;
  const mixedApplies =
    inputs.callShape !== 'item_create' &&
    (nonFileSetCount > 0 || setRawCount > 0 || inputs.hasName);
  if (mixedApplies) {
    const fe = fileSetEntries[0];
    /* c8 ignore next 3 */
    if (fe === undefined) {
      throw new ApiError('internal_error', 'enforceSingleFileColumnSet: file entry narrowing failed (mixed)');
    }
    throw new ApiError(
      'usage_error',
      `Mixing a file \`--set <file-col>=<path>\` with value \`--set\` / ` +
        `\`--set-raw\` / \`--name\` in the same call is not supported at ` +
        `v0.6-M38 (per cli-design §5.3 + v0.6-plan §3 M38 D2 closure). ` +
        `Monday's wire has no atomic combo of multipart ` +
        `\`add_file_to_column\` + JSON \`change_column_value\` / ` +
        `\`change_multiple_column_values\`; mixing would force a non-` +
        `atomic multi-leg dispatch that breaks the existing atomicity ` +
        `contract. Run the file dispatch in its own call.`,
      {
        details: {
          reason: 'mixed_file_and_value_sets',
          column_id: fe.columnId,
          non_file_set_count: nonFileSetCount,
          set_raw_count: setRawCount,
          has_name: inputs.hasName,
          hint:
            'run the file `--set` alone (e.g., `monday item set <iid> ' +
            '<file-col>=<path>`); apply value writes / rename in a ' +
            'separate call (e.g., `monday item update <iid> --set ' +
            'status=Done --name "..."`).',
        },
      },
    );
  }

  // Clean dispatch leg. ≥1 file `--set`, no mutex violation.
  // Branches on N (single vs multi) then on callShape:
  //   N=1 (single-file path):
  //     - `'item_update_single'` / `'item_set'` → `kind: 'file'`
  //       (M38 single-item path; unchanged).
  //     - `'item_update_bulk'` → `kind: 'file_bulk'` (v0.7-M42 D5
  //       carve-out fold; action body's per-item multipart fan-out).
  //     - `'item_create'` → `kind: 'file_create'` (v0.7-M43 D6
  //       carve-out fold; action body's two-leg `create_item` then
  //       `add_file_to_column` dispatch with orphan-warn atomicity
  //       envelope per D1 closure).
  //   N>1 (multi-file path — v0.8-M46 D2 carve-out fold):
  //     - `'item_update_single'` → `kind: 'file_multi'` (single-item
  //       N-leg fan-out helper `runItemUpdateSingleFileMultiDispatch`).
  //     - `'item_update_bulk'` → `kind: 'file_bulk_multi'` (per-item
  //       N-leg fan-out helper `runItemUpdateBulkFileMultiDispatch`;
  //       cross-item parallel × within-item sequential).
  //     - `'item_create'` → `kind: 'file_create_multi'` (two-leg-
  //       group helper `runItemCreateFileMultiDispatch`; leg-1
  //       `create_item` then N sequential `add_file_to_column`
  //       legs). The `'item_set'` callShape is argv-unreachable
  //       (single-positional; cannot express 2+ file `--set`) and
  //       throws the defensive `'multi_file_set_unsupported'` above.
  if (fileSetEntries.length > 1) {
    // v0.8-M46 Codex R1 P2-1 fix: reject duplicate resolved file-
    // column IDs across multi-file entries (mirrors JSON path's
    // existing cross-token duplicate-resolved-ID contract at
    // `src/api/resolution-pass.ts` + `docs/output-shapes.md`).
    // Without this guard, `--set attachments=/p/a --set
    // id:attachments=/p/b` (two distinct argv tokens that resolve
    // to the same file column ID) would either silently dispatch
    // two `add_file_to_column` legs against the same column (the
    // second leg's file replaces the first wire-side — surprising
    // behavior) or downstream `projectedEntries` token-by-find
    // logic in `preCheckM38FileDispatch` would lose token identity
    // (map both entries to the first token's slot). Rejecting at
    // the enforcement layer is the simplest contract that aligns
    // with the JSON path's existing behavior + sidesteps the
    // token-identity edge case.
    const seenColumnIds = new Set<string>();
    for (const entry of fileSetEntries) {
      if (seenColumnIds.has(entry.columnId)) {
        throw new ApiError(
          'usage_error',
          `Multiple \`--set\` entries resolve to the same file column ` +
            `\`${entry.columnId}\` (v0.8-M46 multi-file dispatch requires ` +
            `each file column to appear at most once per call). Monday's ` +
            `\`add_file_to_column\` is single-column per call on the wire; ` +
            `two legs against the same column would either silently ` +
            `replace the first file or surface non-deterministic ` +
            `wire-side ordering. Drop one of the duplicate entries or ` +
            `target distinct file columns.`,
          {
            details: {
              reason: 'duplicate_resolved_file_columns',
              column_id: entry.columnId,
              file_count: fileSetEntries.length,
              file_column_ids: fileSetEntries.map((e) => e.columnId),
              hint:
                'each file column may appear at most once across `--set` ' +
                'entries; drop the duplicate or target distinct file ' +
                'columns.',
            },
          },
        );
      }
      seenColumnIds.add(entry.columnId);
    }
    const entries = fileSetEntries.map((e) => ({
      columnId: e.columnId,
      rawValue: e.rawValue,
    }));
    if (inputs.callShape === 'item_update_bulk') {
      return { kind: 'file_bulk_multi', entries };
    }
    if (inputs.callShape === 'item_create') {
      return { kind: 'file_create_multi', entries };
    }
    // `'item_update_single'` (and `'item_set'` defensively — the
    // multi-file gate above already threw on `'item_set'`, so this
    // branch only fires for `'item_update_single'` in practice).
    return { kind: 'file_multi', entries };
  }
  const fe = fileSetEntries[0];
  /* c8 ignore next 3 */
  if (fe === undefined) {
    throw new ApiError('internal_error', 'enforceSingleFileColumnSet: file entry narrowing failed (clean)');
  }
  if (inputs.callShape === 'item_update_bulk') {
    return { kind: 'file_bulk', columnId: fe.columnId, rawValue: fe.rawValue };
  }
  if (inputs.callShape === 'item_create') {
    return { kind: 'file_create', columnId: fe.columnId, rawValue: fe.rawValue };
  }
  return { kind: 'file', columnId: fe.columnId, rawValue: fe.rawValue };
};

/**
 * Argv-level setEntry shape (`<token>=<value>` split, pre-resolution).
 * Used as input to {@link preCheckM38FileDispatch}.
 */
export interface ArgvSetEntry {
  readonly token: string;
  readonly value: string;
}

/**
 * Result of {@link preCheckM38FileDispatch}. On the `'json'` branch
 * the action body proceeds with the standard `resolveAndTranslate` /
 * `planChanges` path (cache is warm from this pre-check). On the
 * `'file'` branch the action body runs {@link precheckLocalFile} +
 * {@link executeFileColumnSet} for the live path, or emits the D4
 * dry-run envelope.
 *
 * `warnings` + `source` + `cacheAgeSeconds` aggregate the
 * resolveColumnWithRefresh legs the pre-check fired; callers thread
 * these into the downstream success envelope (json branch into the
 * standard path's existing aggregation seeds; file branch into the
 * file-dispatch envelope's `warnings` + `meta.source` slots).
 */
export type PreCheckM38FileDispatchResult =
  | {
      readonly kind: 'json';
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  | {
      readonly kind: 'file';
      readonly columnId: string;
      readonly rawValue: string;
      readonly token: string;
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  // v0.7-M42 carve-out fold (D5 closure). Mirrors `kind: 'file'`
  // verbatim; the action body branches on `kind` and routes
  // `'file_bulk'` into the per-item multipart fan-out helper
  // {@link runItemUpdateBulkFileDispatch} (in `commands/item/
  // update.ts`).
  | {
      readonly kind: 'file_bulk';
      readonly columnId: string;
      readonly rawValue: string;
      readonly token: string;
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  // v0.7-M43 carve-out fold (D6 closure). Mirrors `kind: 'file'`
  // verbatim; the action body branches on `kind` and routes
  // `'file_create'` into the two-leg create-then-file helper
  // {@link runItemCreateFileDispatch} (in `commands/item/create.ts`).
  // The non-file `--set` / `--set-raw` entries that the mixed-rule
  // suppression on `'item_create'` callShape passes through (see
  // {@link enforceSingleFileColumnSet}) are NOT carried on this
  // result — the action body holds the original `--set` / `--set-raw`
  // token lists and bundles them into leg-1's `create_item.column_values`
  // independently. The pre-check returns only the file-column slot
  // (the load-bearing input to the two-leg dispatch helper).
  | {
      readonly kind: 'file_create';
      readonly columnId: string;
      readonly rawValue: string;
      readonly token: string;
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  // v0.8-M46 carve-out fold (D2 closure — multi-file `--set`). The
  // three variants below mirror the single-file `'file'` /
  // `'file_bulk'` / `'file_create'` shapes but carry a list of
  // resolved file-column entries (length ≥ 2, in argv order). The
  // action body branches on `kind` and routes into the per-callShape
  // multi-leg helper. Each entry carries the resolved column ID +
  // raw path + argv token (echoed downstream into `resolved_ids`
  // for the envelope's wire-shape mirror).
  | {
      readonly kind: 'file_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
        readonly token: string;
      }[];
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  | {
      readonly kind: 'file_bulk_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
        readonly token: string;
      }[];
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    }
  | {
      readonly kind: 'file_create_multi';
      readonly entries: readonly {
        readonly columnId: string;
        readonly rawValue: string;
        readonly token: string;
      }[];
      readonly warnings: readonly ResolverWarning[];
      readonly source: 'live' | 'cache' | 'mixed' | undefined;
      readonly cacheAgeSeconds: number | null;
    };

export interface PreCheckM38FileDispatchInputs {
  readonly client: MondayClient;
  readonly boardId: string;
  readonly setEntries: readonly ArgvSetEntry[];
  /**
   * Count of `--set-raw` entries the call carries. Only the count
   * matters for the mutex check ("file --set + ANY --set-raw"); the
   * setRawEntries' column types do NOT need pre-resolution here.
   * `--set-raw <file-col>=<json>` rejection stays at
   * `translateRawColumnValue` per D3 (permanent rejection); the
   * pre-check never routes a `--set-raw` path through M38 dispatch.
   */
  readonly setRawCount: number;
  readonly hasName: boolean;
  readonly callShape:
    | 'item_update_single'
    | 'item_update_bulk'
    | 'item_create';
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

/**
 * Resolves `setEntries` column types and runs the v0.6-M38 mutex
 * check (per cli-design §5.3 step 5 "File-column dispatch leg —
 * mutex rules"). The discipline: **enforce mutex at the column-
 * resolution boundary**, not at the translator-rejection boundary.
 * Pre-flight P2-1 + IMPL round-1 P2-2 both surfaced the
 * translator-order-dependent priority drift that this resolution-
 * boundary check fixes.
 *
 * **Why the pre-check fires at the action-body level rather than
 * inside `resolveAndTranslate`.** The shared resolver helper is
 * used by 5 sites (item set, item update single + bulk, item
 * create); the M38 dispatch only applies to 3 (item update single
 * + bulk + item create — item set has its own column resolution at
 * the action body level for the single-positional shape). Folding
 * M38 dispatch into `resolveAndTranslate` would couple the
 * resolver helper to the file-dispatch leg; the action-body level
 * pre-check keeps `resolveAndTranslate` translator-only.
 *
 * **Discriminating friendly `--set` vs `--set-raw`** — the
 * pre-check operates on setEntries only. `--set-raw <file-col>=<json>`
 * rejections come from `translateRawColumnValue` (D3 permanent
 * rejection); the pre-check returns `kind: 'json'` for `--set-raw`
 * file paths and the standard path's `resolveAndTranslate` /
 * `planChanges` then surfaces the D3 `unsupported_column_type`
 * rejection. The pre-check NEVER hijacks `--set-raw` paths into
 * M38 dispatch.
 *
 * **Source aggregation contract.** Each resolveColumnWithRefresh
 * call returns its own `source` / `cacheAgeSeconds`; the pre-check
 * aggregates across `setEntries`. On the `'json'` branch the
 * downstream `resolveAndTranslate` will re-resolve setEntries
 * (cache hit) and produce another aggregation leg — the action
 * body merges both aggregations so the final envelope reflects
 * every wire / cache leg that fired. The `meta.source` of a
 * non-file path with a single `--set` may surface as `'mixed'`
 * (live pre-check + cache downstream) rather than `'live'`; this
 * is correct per §6.1 source-aggregation rules — the second leg
 * IS a cache hit.
 */
export const preCheckM38FileDispatch = async (
  inputs: PreCheckM38FileDispatchInputs,
): Promise<PreCheckM38FileDispatchResult> => {
  const resolved: {
    readonly columnId: string;
    readonly columnType: string;
    readonly rawValue: string;
    readonly token: string;
  }[] = [];
  let aggregateSource: 'live' | 'cache' | 'mixed' | undefined;
  let aggregateCacheAge: number | null = null;
  const warnings: ResolverWarning[] = [];
  for (const entry of inputs.setEntries) {
    const r = await resolveColumnWithRefresh({
      client: inputs.client,
      boardId: inputs.boardId,
      token: entry.token,
      includeArchived: true,
      ...(inputs.env === undefined ? {} : { env: inputs.env }),
      ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
    });
    aggregateSource = mergeSource(aggregateSource, r.source);
    aggregateCacheAge = mergeCacheAge(aggregateCacheAge, r.cacheAgeSeconds);
    warnings.push(...r.warnings);

    // Archived-column guard (mirrors `resolveAndTranslate`'s
    // pass-(a) check). `includeArchived: true` above surfaces
    // archived columns via the resolver rather than dropping them;
    // the M38 dispatch must reject archived file columns with the
    // stable `column_archived` error so agents key on the canonical
    // shape regardless of write path. Round-2 P2-1 surfacing event:
    // without this guard, `--set <archived_file_col>=<path>` on
    // item update / create reached the M38 dispatch (emitting a
    // successful file `planned_change` on dry-run, or local
    // precheck + multipart dispatch on live) instead of the
    // `column_archived` rejection.
    if (r.match.column.archived === true) {
      throw foldResolverWarningsIntoError(
        buildColumnArchivedError({
          columnId: r.match.column.id,
          columnTitle: r.match.column.title,
          columnType: r.match.column.type,
          boardId: inputs.boardId,
        }),
        warnings,
      );
    }

    resolved.push({
      columnId: r.match.column.id,
      columnType: r.match.column.type,
      rawValue: entry.value,
      token: entry.token,
    });
  }
  // Synthesize setRawEntries inputs from the count — only length
  // matters for the mutex check; columnId / columnType slots are
  // unused on the mixed-set discriminator path.
  const setRawEntries = Array.from(
    { length: inputs.setRawCount },
    () => ({ columnId: '', columnType: '' }),
  );
  const enforcement = enforceSingleFileColumnSet({
    callShape: inputs.callShape,
    setEntries: resolved.map((r) => ({
      columnId: r.columnId,
      columnType: r.columnType,
      rawValue: r.rawValue,
    })),
    setRawEntries,
    hasName: inputs.hasName,
  });
  if (enforcement.kind === 'json') {
    return {
      kind: 'json',
      warnings,
      source: aggregateSource,
      cacheAgeSeconds: aggregateCacheAge,
    };
  }
  // v0.8-M46 multi-file branches (D2 closure). The enforcement
  // result carries a list of resolved file-column entries (length
  // ≥ 2, argv order). Map each entry back to its argv token by
  // matching (columnId, rawValue) against the pre-check's
  // `resolved` list — the token is the load-bearing handle for
  // the dispatch envelope's `resolved_ids` slot.
  if (
    enforcement.kind === 'file_multi' ||
    enforcement.kind === 'file_bulk_multi' ||
    enforcement.kind === 'file_create_multi'
  ) {
    const projectedEntries = enforcement.entries.map((entry) => {
      const fileResolved = resolved.find(
        (r) =>
          r.columnType === 'file' &&
          r.columnId === entry.columnId &&
          r.rawValue === entry.rawValue,
      );
      /* c8 ignore next 6 — defensive: enforcement returned entries
         the pre-check passed in; every find must succeed. */
      if (fileResolved === undefined) {
        throw new ApiError(
          'internal_error',
          'preCheckM38FileDispatch: multi-file entry not found in resolved set after enforcement',
        );
      }
      return {
        columnId: entry.columnId,
        rawValue: entry.rawValue,
        token: fileResolved.token,
      };
    });
    return {
      kind: enforcement.kind,
      entries: projectedEntries,
      warnings,
      source: aggregateSource,
      cacheAgeSeconds: aggregateCacheAge,
    };
  }
  // Single-file branches: `'file'` (M38) / `'file_bulk'` (M42) /
  // `'file_create'` (M43). Find the matching resolved entry for
  // the file-column token (echo into resolved_ids downstream).
  const fileResolved = resolved.find(
    (r) =>
      r.columnType === 'file' &&
      r.columnId === enforcement.columnId &&
      r.rawValue === enforcement.rawValue,
  );
  /* c8 ignore next 5 — defensive: enforcement returned the same
     entry the pre-check passed in; the find must succeed. */
  if (fileResolved === undefined) {
    throw new ApiError(
      'internal_error',
      'preCheckM38FileDispatch: file entry not found in resolved set after enforcement',
    );
  }
  if (enforcement.kind === 'file_bulk') {
    return {
      kind: 'file_bulk',
      columnId: enforcement.columnId,
      rawValue: enforcement.rawValue,
      token: fileResolved.token,
      warnings,
      source: aggregateSource,
      cacheAgeSeconds: aggregateCacheAge,
    };
  }
  if (enforcement.kind === 'file_create') {
    return {
      kind: 'file_create',
      columnId: enforcement.columnId,
      rawValue: enforcement.rawValue,
      token: fileResolved.token,
      warnings,
      source: aggregateSource,
      cacheAgeSeconds: aggregateCacheAge,
    };
  }
  return {
    kind: 'file',
    columnId: enforcement.columnId,
    rawValue: enforcement.rawValue,
    token: fileResolved.token,
    warnings,
    source: aggregateSource,
    cacheAgeSeconds: aggregateCacheAge,
  };
};
