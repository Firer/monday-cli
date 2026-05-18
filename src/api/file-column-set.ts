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
 *      single-column-per-call only on Monday's wire; mixing a
 *      file-column `--set` with any value `--set` / `--set-raw` /
 *      `--name` in the same call would force a multi-leg dispatch
 *      that breaks the existing atomicity guarantee. M38 enforces
 *      single-file-only via the mutex rules below (D2 closure) —
 *      the existing atomicity contract stays intact.
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
 * **Consumer counts at M38 IMPL** (runtime bodies land here in
 * this commit; pre-flight stubs collapsed):
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
 *   - Exactly ONE file `--set` entry allowed per call (M38 single-
 *     file scope; multi-file dispatch defers to v0.6.x).
 *   - NO other value `--set` / `--set-raw` / `--name` flags
 *     allowed (mixing would force non-atomic multi-leg dispatch).
 *   - Bulk `item update --where ... --set <file-col>=<path>`
 *     REJECTED at resolution-time per D5 closure (defers to
 *     v0.6.x — per-item file dispatch + partial-success envelope +
 *     `--concurrency` interaction each carry additional design
 *     dimensions).
 *   - `item create --set <file-col>=<path>` REJECTED at resolution-
 *     time per D6 closure (defers to v0.6.x — non-atomic post-
 *     create wire shape would break §5.8 state safety).
 *
 * Rejection surfaces share the `usage_error.details.reason`
 * discriminator pattern from M14 / M27 / M31:
 *
 *   - `'mixed_file_and_value_sets'` — file `--set` + any value
 *     `--set` / `--set-raw` / `--name` in same call.
 *   - `'multi_file_set_unsupported'` — 2+ file `--set` entries
 *     in same call.
 *   - `'file_set_on_create_unsupported'` — `item create --set
 *     <file-col>=<path>`.
 *   - `'file_set_on_bulk_unsupported'` — bulk `item update
 *     --where ... --set <file-col>=<path>`.
 *
 * **D3 closure — `--set-raw <file-col>=<json>` STAYS REJECTED.**
 * Files have no JSON wire shape Monday's `change_column_value`
 * accepts; the escape-hatch contract "user supplies the JSON
 * `change_column_value` accepts" doesn't compose with the
 * multipart wire. The existing rejection at
 * `raw-write.ts:translateRawColumnValue` stays unchanged; the
 * prose flips slightly to note "M38 ships the friendly `--set
 * <file-col>=<path>` form but `--set-raw` for files stays
 * rejected".
 *
 * **D7 closure — `<path>='-'` stdin support OUT OF SCOPE.**
 * Mirrors M31 `monday item upload`'s rejection rationale — no
 * clean `--filename` companion shape pinned for `--set
 * <file-col>=-` syntax (stdin reads byte-anonymously; the
 * filename is the load-bearing handle for Monday's wire
 * `Asset.name` slot). Defers to v0.6.x extension shape.
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
 *     file-column dispatch path applies (exactly one file `--set`,
 *     no other value flags, single-item non-create call). The
 *     caller runs {@link buildBlobFromPath} via
 *     {@link precheckLocalFile} from `src/utils/file-source.ts` to
 *     build a {@link FileColumnSetEntry} + invokes
 *     {@link executeFileColumnSet}.
 *   - Throws `ApiError('usage_error', ...)` with a
 *     `details.reason` discriminator when a mutex violation is
 *     detected: `'file_set_on_bulk_unsupported'` (D5 closure),
 *     `'file_set_on_create_unsupported'` (D6 closure),
 *     `'multi_file_set_unsupported'` (D2 multi-file leg),
 *     `'mixed_file_and_value_sets'` (D2 mixed leg).
 *
 * Pure synchronous check — no I/O, no side effects. The caller
 * resolves columns first (via `resolveColumnWithRefresh` or the
 * existing `resolveAndTranslate` helper's resolution leg) and
 * passes the resolved column types here.
 *
 * **Status: runtime body shipped at v0.6-M38 IMPL.** Per R-NEW-76
 * graduated discipline, callers invoke `parseArgv` BEFORE this
 * function so argv-level failures surface as `usage_error` from
 * the parse boundary (this function itself runs AFTER argv parse
 * + column resolution).
 */
export type FileColumnSetEnforcementResult =
  | { readonly kind: 'json' }
  | { readonly kind: 'file'; readonly columnId: string; readonly rawValue: string };

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
   *     accepted; M38 mutex enforces "single file `--set` + no
   *     other value flags".
   *   - `'item_update_bulk'` — `monday item update --where ...`.
   *     Any file `--set` rejects with
   *     `'file_set_on_bulk_unsupported'` per D5.
   *   - `'item_create'` — `monday item create`. Any file `--set`
   *     rejects with `'file_set_on_create_unsupported'` per D6.
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
 * Mutex priority (ratified at M38 pre-flight, applied here in IMPL):
 *
 *   1. **callShape gates first** — `'item_update_bulk'` rejects ALL
 *      file `--set` entries with `'file_set_on_bulk_unsupported'`
 *      (D5; defers per-item file dispatch + concurrency interaction
 *      to v0.6.x). `'item_create'` rejects with
 *      `'file_set_on_create_unsupported'` (D6; defers create-time
 *      file upload to v0.6.x — non-atomic post-create wire shape
 *      breaks §5.8 state safety).
 *   2. **multi-file leg** — 2+ file `--set` entries on a non-rejected
 *      callShape surface `'multi_file_set_unsupported'` (M38 defers
 *      multi-file dispatch to v0.6.x).
 *   3. **mixed leg** — 1 file `--set` + any value `--set` /
 *      `--set-raw` / `--name` surface `'mixed_file_and_value_sets'`
 *      (mixing forces non-atomic multi-leg dispatch that breaks the
 *      existing atomicity contract).
 *   4. **clean leg** — 1 file `--set`, no other value flags, single-
 *      item non-create call → return `{ kind: 'file', columnId,
 *      rawValue }` for downstream {@link precheckLocalFile} +
 *      {@link executeFileColumnSet}.
 *
 * The function is sync + pure. No I/O. Path validation lives at a
 * SEPARATE step (`precheckLocalFile` from `src/utils/file-source.ts`)
 * that the caller runs AFTER this function returns a `kind: 'file'`
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

  // callShape gates first (D5 / D6 closures). The hint names the
  // verb-shaped M31 fallback (`monday item upload`) which IS allowed
  // on bulk + create-time flows via separate scripting.
  if (inputs.callShape === 'item_update_bulk') {
    const fe = fileSetEntries[0];
    /* c8 ignore next 3 */
    if (fe === undefined) {
      throw new ApiError('internal_error', 'enforceSingleFileColumnSet: file entry narrowing failed (bulk)');
    }
    throw new ApiError(
      'usage_error',
      `--set <file-col>=<path> is not supported on bulk \`item update ` +
        `--where\` / \`--filter-json\` at v0.6-M38 (deferred to v0.6.x ` +
        `per cli-design §13 v0.6 entry + v0.6-plan §3 M38 D5 closure). ` +
        `Per-item file dispatch + \`--continue-on-error\` partial-success ` +
        `envelope + \`--concurrency\` multipart-over-shared-transport ` +
        `semantics each carry design dimensions worth their own milestone ` +
        `cluster. Run the file write per matched item via single-item ` +
        `\`monday item set <iid> <file-col>=<path>\` or \`monday item ` +
        `upload <iid> --column <col> <file>\` (v0.4-M31; verb-shaped).`,
      {
        details: {
          reason: 'file_set_on_bulk_unsupported',
          column_id: fe.columnId,
          deferred_to: 'v0.6.x',
          hint:
            'bulk file dispatch is not supported at v0.6-M38; iterate ' +
            'matched items in your script and call `monday item set ' +
            '<iid> <file-col>=<path>` per item, or use `monday item ' +
            'upload <iid> --column <col> <file>` (v0.4-M31).',
        },
      },
    );
  }
  if (inputs.callShape === 'item_create') {
    const fe = fileSetEntries[0];
    /* c8 ignore next 3 */
    if (fe === undefined) {
      throw new ApiError('internal_error', 'enforceSingleFileColumnSet: file entry narrowing failed (create)');
    }
    throw new ApiError(
      'usage_error',
      `--set <file-col>=<path> is not supported on \`monday item create\` ` +
        `at v0.6-M38 (deferred to v0.6.x per cli-design §13 v0.6 entry + ` +
        `v0.6-plan §3 M38 D6 closure). Monday's wire has no atomic ` +
        `create-with-file mutation at API \`2026-01\`; file upload at ` +
        `create time would require a non-atomic post-create ` +
        `\`add_file_to_column\` that breaks §5.8 state safety. Create ` +
        `the item first, then attach the file with \`monday item set ` +
        `<iid> <file-col>=<path>\` or \`monday item upload <iid> ` +
        `--column <col> <file>\` (v0.4-M31; verb-shaped).`,
      {
        details: {
          reason: 'file_set_on_create_unsupported',
          column_id: fe.columnId,
          deferred_to: 'v0.6.x',
          hint:
            'create the item with non-file `--set` values, then attach ' +
            'the file with `monday item set <iid> <file-col>=<path>` ' +
            '(v0.6-M38) or `monday item upload <iid> --column <col> ' +
            '<file>` (v0.4-M31).',
        },
      },
    );
  }

  // Multi-file leg (D2). 2+ file `--set` entries on a non-bulk /
  // non-create call shape — defers to v0.6.x.
  if (fileSetEntries.length > 1) {
    throw new ApiError(
      'usage_error',
      `Multi-file \`--set <file-col>=<path>\` is not supported at ` +
        `v0.6-M38 (${String(fileSetEntries.length)} file \`--set\` ` +
        `entries detected; deferred to v0.6.x per cli-design §5.3 + ` +
        `v0.6-plan §3 M38 D2 closure). Monday's ` +
        `\`add_file_to_column\` mutation is single-column per call on ` +
        `the wire; multi-file dispatch + concurrent multipart over the ` +
        `shared transport carry design dimensions worth their own ` +
        `milestone. Pass exactly one \`--set <file-col>=<path>\` per ` +
        `call; for multiple uploads, run separate calls.`,
      {
        details: {
          reason: 'multi_file_set_unsupported',
          file_count: fileSetEntries.length,
          file_column_ids: fileSetEntries.map((e) => e.columnId),
          deferred_to: 'v0.6.x',
          hint:
            'pass exactly one `--set <file-col>=<path>` per call; ' +
            'run separate calls for multiple file uploads.',
        },
      },
    );
  }

  // Mixed leg (D2). 1 file `--set` + any value `--set` / `--set-raw`
  // / `--name` — surfaces because Monday's wire has no atomic combo
  // of multipart `add_file_to_column` + JSON `change_column_value` /
  // `change_multiple_column_values` (mixing forces non-atomic
  // multi-leg dispatch that breaks the §5.3 atomicity contract).
  const nonFileSetCount = inputs.setEntries.length - fileSetEntries.length;
  const setRawCount = inputs.setRawEntries.length;
  if (nonFileSetCount > 0 || setRawCount > 0 || inputs.hasName) {
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

  // Clean dispatch leg. Single file `--set`, no other value flags
  // on a single-item non-create call shape.
  const fe = fileSetEntries[0];
  /* c8 ignore next 3 */
  if (fe === undefined) {
    throw new ApiError('internal_error', 'enforceSingleFileColumnSet: file entry narrowing failed (clean)');
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
  // enforcement.kind === 'file'. Find the matching resolved entry
  // for the file-column token (echo into resolved_ids downstream).
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
