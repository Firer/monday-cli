/**
 * Files-shaped friendly `--set` dispatch (`cli-design.md` §5.3
 * writer-expansion roadmap "files" row + §13 v0.6 entry,
 * `v0.6-plan.md` §3 M38).
 *
 * **Status: pre-flight stubs (v0.6-M38 pre-flight contract diff).**
 * Runtime bodies land at M38 IMPL; pre-flight ships the dispatch
 * type signatures + the per-mutex-rejection error shape + the stub
 * fetcher signature wrapping M31's `addFileToColumn` (no new wire
 * fetcher — M38 reuses the v0.4-M31 multipart wire verbatim).
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
 * **Projected consumer counts at M38 IMPL** (pre-flight ships
 * the dispatch stub; the runtime body that actually consumes
 * these helpers lands at M38 IMPL):
 *
 *   - `addFileToColumn` projected at M38 IMPL: 1 → 2 (M31's `item
 *     upload` action body + M38's `executeFileColumnSet` runtime
 *     body). Today (pre-flight) still 1 consumer — the M38 stub
 *     throws `internal_error` before reaching the fetcher.
 *   - `MultipartTransport` via `ResolvedClient.multipart` projected
 *     at M38 IMPL: 1 → 2 (test seam pattern). Today still 1.
 *   - `sniffContentType` from `src/utils/mime.ts` projected at M38
 *     IMPL: 2 → 3 (M31's `item upload` + `update upload` + M38's
 *     `executeFileColumnSet` runtime body). Today still 2.
 *     **R-NEW-58 IMPL-kickoff lift target**: extract the file-
 *     pre-check + Blob-construction pattern (M31's `item upload`
 *     action body lines 188-261) into a shared
 *     `src/utils/file-source.ts` helper at the 3rd consumer
 *     trigger; IMPL kickoff scan applies the lift ahead-of-feat
 *     per R-NEW-29's M25 cadence.
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
import { assetSchema, type Asset } from './assets.js';
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
 * At pre-flight this is a stub signature; the runtime body lands
 * at M38 IMPL and reads:
 *
 *   1. Construct a `Blob` from the local file at
 *      `inputs.entry.filePath` (read bytes via `fs/promises.readFile`
 *      after the action body's pre-check confirmed R_OK + non-empty).
 *      `Blob.type` from `sniffContentType(inputs.entry.filename)`.
 *   2. Call `addFileToColumn({client, multipart, itemId: entry...,
 *      columnId: entry.columnId, file, filename: entry.filename,
 *      signal, retries})` — M31's fetcher already wraps the
 *      multipart dispatch in `withRetry(...)` + handles the
 *      file_too_large rewrap-inside-retry-thunk pattern.
 *   3. Project the result into `FileColumnSetOutput` shape with the
 *      `operation: 'add_file_to_column'` literal + agent-supplied
 *      slots echoed (item_id, column_id, filename, file_size_bytes).
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
 * Pre-flight stub. Runtime body lands at M38 IMPL.
 *
 * The IMPL body reads the local file at `inputs.entry.filePath`,
 * constructs a Blob with a sniffed content-type, and dispatches
 * via M31's `addFileToColumn` fetcher (cli-design §5.3 + the
 * module docstring above pin the load-bearing design).
 *
 * The action-body caller (in `item set` / `item update`) is
 * responsible for:
 *
 *   1. Parsing argv + collecting `--set` / `--set-raw` / `--name`
 *      entries.
 *   2. Resolving columns via `resolveColumnWithRefresh`.
 *   3. Calling {@link enforceSingleFileColumnSet} to detect the
 *      file-column dispatch leg + enforce the mutex rules.
 *   4. If a {@link FileColumnSetEntry} is returned, calling THIS
 *      fetcher (IMPL body) for the wire dispatch.
 *   5. Emitting the envelope per `fileColumnSetOutputSchema`.
 *
 * Status flips to "runtime body shipped at v0.6-M38 IMPL" at the
 * IMPL feat commit.
 */
/* c8 ignore start — pre-flight stub; runtime body lands at v0.6-M38 IMPL */
export const executeFileColumnSet = async (
  inputs: ExecuteFileColumnSetInputs,
): Promise<ExecuteFileColumnSetResult> => {
  // Pre-flight stub: drains the inputs so TypeScript sees them
  // consumed + the lint check sees the awaited Promise.resolve()
  // (IMPL body awaits the multipart dispatch in its place).
  await Promise.resolve();
  void inputs;
  throw new ApiError(
    'internal_error',
    'executeFileColumnSet: pre-flight stub. Runtime body lands at v0.6-M38 IMPL.',
    {
      details: {
        deferred_to: 'v0.6-M38-impl',
        reason: 'pre_flight_stub',
        hint:
          'this surface is wired but not implemented at pre-flight. ' +
          'The IMPL session swaps the stub for a runtime body wrapping ' +
          'addFileToColumn from src/api/assets.ts.',
      },
    },
  );
};
/* c8 ignore stop */

/**
 * Mutex enforcement at the column-resolution boundary. Takes the
 * resolved column-type information for every `--set` / `--set-raw`
 * entry + the `--name` presence flag + the call shape (single-item
 * vs bulk vs create), and either:
 *
 *   - Returns the single resolved {@link FileColumnSetEntry} when
 *     a clean file-column dispatch path applies (exactly one file
 *     `--set`, no other value flags, single-item non-create call),
 *     paired with the agent-supplied raw value (the path) for
 *     downstream file-pre-check.
 *   - Returns `null` when NO file-column entries exist (the
 *     standard JSON translator path applies; action body proceeds
 *     unchanged).
 *   - Throws `ApiError('usage_error', ...)` with the appropriate
 *     `details.reason` discriminator when a mutex violation is
 *     detected (mixed file + value, multi-file, file-on-create,
 *     file-on-bulk). At pre-flight the stub throws
 *     `internal_error` instead; the IMPL body replaces the stub
 *     with the runtime mutex-check logic that surfaces
 *     `usage_error` for true violations.
 *
 * The function is a pure check — no I/O, no side effects. The
 * caller passes resolved column types + flag presence flags only.
 *
 * **Pre-flight scope.** The runtime body lands at M38 IMPL; the
 * pre-flight stub throws `internal_error` to surface "the dispatch
 * is wired but not implemented yet" cleanly. Per R-NEW-76
 * graduated discipline, the stub's `c8 ignore start` block-wrap
 * is positioned AFTER the caller's `parseArgv` so invalid argv
 * surfaces `usage_error` from the parse boundary, NOT
 * `internal_error` from the c8-ignored throw.
 */
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
 * Pre-flight stub. Runtime body lands at M38 IMPL.
 *
 * Returns `null` when NO file-column entries are present (the
 * standard JSON translator path applies). Returns a
 * {@link FileColumnSetEntry} when a clean file-column dispatch
 * path applies. Throws `ApiError('usage_error', ...)` on mutex
 * violations at IMPL; the pre-flight stub throws `internal_error`
 * to surface "the surface is wired but not implemented" cleanly.
 *
 * The IMPL body iterates `inputs.setEntries`, identifies entries
 * with `columnType === 'file'`, applies the mutex rules per
 * D2 / D5 / D6 closures, and returns the single resolved entry
 * (path validation deferred to a SEPARATE step at the action body
 * — this function is pure-check).
 */
/* c8 ignore start — pre-flight stub; runtime body lands at v0.6-M38 IMPL */
export const enforceSingleFileColumnSet = (
  inputs: EnforceSingleFileColumnSetInputs,
): null => {
  void inputs;
  throw new ApiError(
    'internal_error',
    'enforceSingleFileColumnSet: pre-flight stub. Runtime body lands at v0.6-M38 IMPL.',
    {
      details: {
        deferred_to: 'v0.6-M38-impl',
        reason: 'pre_flight_stub',
        hint:
          'this surface is wired but not implemented at pre-flight. ' +
          'The IMPL session swaps the stub for the runtime mutex-check + ' +
          'file-column entry construction logic per cli-design §5.3 + D2/D5/D6.',
      },
    },
  );
};
/* c8 ignore stop */
