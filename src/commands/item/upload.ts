/**
 * `monday item upload <iid> --column <col> <file>` — attach a file to
 * a `file`-typed column on an item via Monday's `add_file_to_column`
 * mutation (cli-design.md §4.3 + §6.4 asset-upload sub-section +
 * §13 v0.4 entry; v0.4-plan.md §3 M31).
 *
 * **Wire shape.** Single multipart/form-data round-trip via
 * {@link addFileToColumn} against `mutation AddFileToColumn` with
 * `operationName: 'AddFileToColumn'` (R-NEW-37 W2 audit-point).
 * Uses the new `MultipartTransport` seam (`src/api/multipart-
 * transport.ts`) — first v0.4 verb that does NOT cross the wire via
 * the JSON-only `client.request` transport. See R-NEW-41 lift at
 * `docs/architecture.md` "Wire-vs-CLI semantics documentation
 * conventions" for the asymmetry context.
 *
 * **Argv shape.** Two positional args + one required flag:
 *
 *   - `<iid>` — numeric item ID; brand-validated via
 *     {@link ItemIdSchema}.
 *   - `<file>` — local file path; resolved relative to cwd. Must be
 *     a readable regular file (not a directory). M31 does NOT
 *     support stdin (`<file>='-'`) — stdin support is a
 *     v0.4.x / v0.5 contract-extension once a clean `--filename
 *     <name>` companion flag is pinned (no upload Asset.name when
 *     reading from stdin).
 *   - `--column <col>` — required; column ID on the target board
 *     (resolved at runtime against board metadata to confirm
 *     `type === 'file'`). Brand-validated via {@link ColumnIdSchema}
 *     at the parse boundary; the column-type check fires at IMPL.
 *
 * **Column-type validation.** At IMPL, the action body resolves the
 * column via the standard `resolveColumnWithRefresh` machinery and
 * confirms `type === 'file'`. Non-`file` columns surface
 * `unsupported_column_type` (matching the existing files_shaped
 * rejection in `src/api/column-values.ts`'s UNSUPPORTED_TABLE) with
 * a hint pointing at the right write path: `change_column_value` for
 * `change_column_value`-shaped types (use `monday item set` /
 * `monday item update --set-raw`); the rejection for `doc`-shaped
 * columns is deferred to a future v0.4+ doc-upload milestone.
 *
 * **Local file failures + size handling — `details.reason`
 * discrimination.** Three failure modes route through
 * `usage_error` with a discriminated `details.reason` slot:
 *
 *   - `'file_not_readable'` — local path doesn't exist
 *     (`ENOENT`), isn't readable (`EACCES`), or resolves to a
 *     directory rather than a regular file. Fires at IMPL via
 *     `fs.stat()` before any wire call.
 *   - `'file_empty'` — file exists but is zero bytes. Monday
 *     rejects empty uploads server-side; the CLI surfaces the
 *     rejection with a clearer hint via `fs.stat()` pre-check
 *     at IMPL.
 *   - `'file_too_large'` — Monday's server-side size-cap
 *     rejection rewrap (`FILE_SIZE_LIMIT_EXCEEDED` or HTTP
 *     413). The CLI does NOT pre-check file size against a
 *     hardcoded ceiling — Monday's per-file cap is plan-tier-
 *     dependent (typically 500 MB at standard tiers, larger
 *     at enterprise) and NOT exposed via the GraphQL schema
 *     (empirical probe `scripts/probe/m31-asset-upload.ts`
 *     2026-05-13 — `Plan` + `Account` carry no file-quota
 *     fields). Rewrap carries `details.file_size_bytes` from
 *     the **local `fs.stat()` measurement at upload time**
 *     (NOT a Monday error-payload field — Monday's wire
 *     rejection may not surface a size; the CLI already has
 *     the local size from the read leg and threads it into
 *     the details slot for a stable agent-keyed envelope)
 *     + `details.hint` pointing at the plan-tier dependency.
 *
 * **`--dry-run` shape** per cli-design §3.1 #6 + §6.4 asset-upload
 * variant. Strictly local-derived — no wire mutation fires. Planned
 * change carries `{operation: 'add_file_to_column', item_id,
 * column_id, file_path, filename, file_size_bytes}` (size from
 * `fs.stat()`; no file bytes are actually transmitted on a dry-
 * run). `meta.source: 'none'`.
 *
 * **Idempotency: NO** — re-running uploads the file a second time
 * minting a new `Asset` ID. Agents needing register-once semantics
 * read `Item.assets` first and skip the upload if a matching name
 * exists (read-side surface deferred to v0.4.x — see v0.4-plan §3
 * M31 Decision D6 closure).
 *
 * **Cache invalidation.** Successful upload changes the file
 * column's `FileValue` ColumnValue → cached board metadata for that
 * board stale; IMPL fires `invalidateBoard(boardId)` after success
 * per the §8 single-leg invalidation pattern.
 *
 * **Side effects.** None at IMPL — `add_file_to_column` does not
 * post an update or trigger automations beyond Monday's own
 * file-change activity log (which `item history` surfaces).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing is the shipped surface;
 * the file-read + multipart-dispatch + envelope emit are c8-ignored
 * (block-wrap) and land at v0.4-M31 IMPL when the runtime body of
 * {@link addFileToColumn} flips from stub-throws to multipart wire.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { ItemIdSchema, ColumnIdSchema } from '../../types/ids.js';
import {
  itemUploadOutputSchema,
  type ItemUploadOutput,
} from '../../api/assets.js';
import { ApiError } from '../../utils/errors.js';

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    column: ColumnIdSchema,
    file: z
      .string()
      .min(1, {
        message:
          '<file> must be a non-empty local file path; stdin (`-`) is not supported in v0.4-M31 (a future contract extension may add stdin support once a `--filename <name>` companion flag is pinned).',
      })
      .refine((p) => p !== '-', {
        message:
          '<file> cannot be `-` — stdin upload is not supported in v0.4-M31. Pass a local file path resolved relative to cwd. A future contract extension may add stdin support once a `--filename <name>` companion flag is pinned.',
      }),
  })
  .strict();

export const itemUploadCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemUploadOutput
> = {
  name: 'item.upload',
  summary:
    'Attach a file to a file-typed column on an item via add_file_to_column',
  examples: [
    'monday item upload 12345 --column files ./screenshot.png',
    'monday item upload 12345 --column attachments_3 ./report.pdf --dry-run',
  ],
  idempotent: false,
  inputSchema,
  outputSchema: itemUploadOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'item',
      'Item commands (cli-design §4.3 ITEM)',
    );
    noun
      .command('upload <itemId> <file>')
      .description(itemUploadCommand.summary)
      .requiredOption(
        '--column <c>',
        'Column ID on the target board. Must resolve to a `file`-typed column at runtime; non-`file` columns surface `unsupported_column_type` per cli-design §5.3.',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...itemUploadCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Uploads cross the wire as multipart/form-data (different transport from JSON-only verbs).',
          '  - File path is resolved relative to the cwd; stdin (`-`) is not supported in this release.',
          '  - Re-running with the same args creates a second Asset; `add_file_to_column` is not idempotent.',
          '',
        ].join('\n'),
      )
      .action(
        (
          itemIdArg: unknown,
          fileArg: unknown,
          opts: { column: string },
        ) => {
          const parsed = parseArgv(itemUploadCommand.inputSchema, {
            itemId: itemIdArg,
            file: fileArg,
            column: opts.column,
          });
          void ctx;

          /* c8 ignore start — pre-flight stub: the runtime body
             (file read + multipart dispatch + envelope emit, plus
             the dry-run `fs.stat()`-backed planned-change shape per
             D5) lands at v0.4-M31 IMPL. Surfacing `internal_error`
             rather than a fake `ok: true` envelope keeps the stub
             discipline honest — the partial runtime would otherwise
             emit a bogus `file_size_bytes: 0` dry-run plan that
             agents could mistake for the real D5 contract. The c8
             block drops with the IMPL feat per the M30 pre-flight
             cadence (and lets coverage stay below the block-wrap's
             unreachable branches). */
          throw new ApiError(
            'internal_error',
            '`monday item upload` action body is a pre-flight stub; runtime body lands at v0.4-M31 IMPL',
            {
              details: {
                deferred_to: 'v0.4-M31 IMPL',
                item_id: parsed.itemId,
                column_id: parsed.column,
                file_path: parsed.file,
                hint: 'this code path is unreachable in v0.4-M30 release surface; pre-flight stub validates argv shape only. IMPL replaces this body with the real file-read + dry-run + multipart wire dispatch per cli-design §6.4 asset-upload sub-section.',
              },
            },
          );
          /* c8 ignore stop */
        },
      );
  },
};
