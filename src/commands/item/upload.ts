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
 * board stale; the action body fires `invalidateBoard(boardId, env)`
 * after success per the §8 single-leg invalidation pattern (BEFORE
 * `emitMutation` so a cache-unlink failure surfaces through the
 * runner's catch-all rather than double-emitting after a success
 * envelope already hit stdout).
 *
 * **Side effects.** None at IMPL — `add_file_to_column` does not
 * post an update or trigger automations beyond Monday's own
 * file-change activity log (which `item history` surfaces).
 *
 * **Status: runtime body shipped at v0.4-M31 IMPL.** Argv parsing
 * + file-read + dry-run + multipart-dispatch + envelope emit + cache
 * invalidation all land below.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { ItemIdSchema, ColumnIdSchema } from '../../types/ids.js';
import {
  itemUploadOutputSchema,
  type ItemUploadOutput,
  addFileToColumn,
} from '../../api/assets.js';
import { resolveClient } from '../../api/resolve-client.js';
import { resolveColumnWithRefresh } from '../../api/columns.js';
import { lookupItemBoard } from '../../api/item-board-lookup.js';
import { invalidateBoard } from '../../api/cache.js';
import { foldResolverWarningsIntoError } from '../../api/resolver-error-fold.js';
import { ApiError } from '../../utils/errors.js';
import {
  precheckLocalFile,
  buildBlobFromPath,
} from '../../utils/file-source.js';
import { emitMutation, emitDryRun } from '../emit.js';

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    column: ColumnIdSchema,
    file: z
      .string()
      .min(1, {
        message:
          '<file> must be a non-empty local file path; `monday item upload` is path-only. To upload from stdin, use the friendly `--set` path: `cat file | monday item set <iid> <file-col>=- [--filename <name>]`.',
      })
      .refine((p) => p !== '-', {
        message:
          '<file> cannot be `-` — `monday item upload` is path-only. To stream from stdin, use `cat file | monday item set <iid> <file-col>=- [--filename <name>]` (v0.8-M47); pass a local file path here.',
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
          '  - File path is resolved relative to the cwd; `upload` is path-only. For stdin, use `cat file | monday item set <iid> <file-col>=- [--filename <name>]` (v0.8-M47).',
          '  - Re-running with the same args creates a second Asset; `add_file_to_column` is not idempotent.',
          '',
        ].join('\n'),
      )
      .action(
        async (
          itemIdArg: unknown,
          fileArg: unknown,
          opts: { column: string },
        ) => {
          const parsed = parseArgv(itemUploadCommand.inputSchema, {
            itemId: itemIdArg,
            file: fileArg,
            column: opts.column,
          });

          // Pre-check existence + type + read-permission + emptiness
          // BEFORE resolveClient so a missing/unreadable-file error
          // surfaces as usage_error (exit 1) rather than getting
          // tangled up with config_error (exit 3) on a token miss
          // OR firing AFTER `lookupItemBoard` /
          // `resolveColumnWithRefresh` Monday wire calls (round-1
          // P2-2 fix). Lifted at v0.6-M38 IMPL kickoff per
          // R-v0.6-NEW-1 (3-consumer trigger).
          const { filePath, filename, fileSizeBytes } =
            await precheckLocalFile(parsed.file);

          const { client, globalFlags, apiVersion, multipart, toEmit } =
            resolveClient(ctx, program.opts());

          if (globalFlags.dryRun) {
            // D5 closure: dry-run is fs.stat()-backed (NOT a 0-byte
            // stub). Planned-change carries `{operation, item_id,
            // column_id, file_path, filename, file_size_bytes}` from
            // the local stat; no wire mutation fires; no file bytes
            // loaded into memory. `meta.source: 'none'`.
            //
            // `file_path` is the **argv-derived** path the agent
            // passed (relative or absolute), preserving the
            // invocation surface — matches cli-design §6.4 +
            // output-shapes which sample `./screenshot.png` (round-2
            // P3-2 fix). Agents that need an absolute path can
            // resolve from cwd + `file_path` themselves; the
            // resolved absolute path lives in `details.file_path`
            // on `usage_error.details.reason: 'file_not_readable'` /
            // `'file_empty'` rejections (where the absolute is
            // useful for diagnosing path resolution mismatches).
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [
                {
                  operation: 'add_file_to_column',
                  item_id: parsed.itemId,
                  column_id: parsed.column,
                  file_path: parsed.file,
                  filename,
                  file_size_bytes: fileSizeBytes,
                },
              ],
              source: 'none',
              cacheAgeSeconds: null,
              apiVersion,
            });
            return;
          }

          // Live path. Resolve the parent board so we can (a) pin the
          // column-type check to the right board metadata and (b) fire
          // cache invalidation on the right board after a successful
          // upload (D6 single-leg per §8). `lookupItemBoard` throws
          // `not_found` on a missing item or null-board, so a bad
          // <iid> surfaces a typed envelope before file BYTES are
          // loaded — the local `fs.stat()` + `fs.access()` pre-check
          // above already ran (round-3 P3-2 prose precision; ordering
          // stays "argv parse → local file pre-check → wire lookup →
          // column resolution → file bytes → multipart dispatch →
          // cache invalidation → emit").
          const { boardId } = await lookupItemBoard({
            client,
            itemId: parsed.itemId,
          });

          const resolution = await resolveColumnWithRefresh({
            client,
            boardId,
            token: parsed.column,
            includeArchived: true,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          const resolverWarnings = resolution.warnings;
          const resolvedColumn = resolution.match.column;

          if (resolvedColumn.archived === true) {
            throw foldResolverWarningsIntoError(
              new ApiError(
                'column_archived',
                `Column ${JSON.stringify(resolvedColumn.title)} ` +
                  `(id ${resolvedColumn.id}) on board ${boardId} is ` +
                  `archived; un-archive the column before uploading to it.`,
                {
                  details: {
                    column_id: resolvedColumn.id,
                    column_title: resolvedColumn.title,
                    column_type: resolvedColumn.type,
                    board_id: boardId,
                  },
                },
              ),
              resolverWarnings,
            );
          }

          if (resolvedColumn.type !== 'file') {
            throw foldResolverWarningsIntoError(
              new ApiError(
                'unsupported_column_type',
                `Column ${JSON.stringify(resolvedColumn.title)} ` +
                  `(id ${resolvedColumn.id}) has type ` +
                  `${JSON.stringify(resolvedColumn.type)}, which Monday ` +
                  `writes via change_column_value not add_file_to_column. ` +
                  `monday item upload only accepts file-typed columns.`,
                {
                  details: {
                    column_id: resolvedColumn.id,
                    column_title: resolvedColumn.title,
                    type: resolvedColumn.type,
                    board_id: boardId,
                    hint:
                      'use `monday item set` / `monday item update --set` ' +
                      'against this column; `monday item upload` only ' +
                      'accepts file-typed columns (cli-design §5.3 ' +
                      'writer-expansion roadmap "files" row).',
                  },
                },
              ),
              resolverWarnings,
            );
          }

          // Read the file bytes into a Blob with a sniffed content-
          // type. Done AFTER column-type validation so a non-`file`
          // column rejection doesn't pay for the full read.
          const file = await buildBlobFromPath({
            filePath,
            filename,
            fileSizeBytes,
          });

          const result = await addFileToColumn({
            client,
            multipart,
            itemId: parsed.itemId,
            columnId: resolvedColumn.id,
            file,
            filename,
            signal: ctx.signal,
            retries: globalFlags.retry,
          });

          // §8 single-leg cache invalidation (D6). Fired BEFORE
          // emitMutation so a cache-unlink failure surfaces through
          // the runner's catch-all rather than double-emitting after
          // the success envelope already hit stdout.
          await invalidateBoard(boardId, ctx.env);

          const data: ItemUploadOutput = {
            operation: 'add_file_to_column',
            item_id: parsed.itemId,
            column_id: resolvedColumn.id,
            filename,
            file_size_bytes: fileSizeBytes,
            asset: result.asset,
          };

          // `toEmit` carries `source: 'live'` + the resolved
          // `apiVersion`. Splat first; override `complexity` with the
          // multipart wire's projection (Monday's asset-upload
          // mutations don't return a complexity block today, but
          // honoring the slot mirrors the JSON-fetcher pattern).
          emitMutation({
            ctx,
            data,
            schema: itemUploadCommand.outputSchema,
            programOpts: program.opts(),
            warnings: resolverWarnings.map((w) => ({
              code: w.code,
              message: w.message,
              details: w.details,
            })),
            ...toEmit({
              data: result.asset,
              complexity: result.complexity,
              stats: { attempts: 1, totalBackoffMs: 0 },
            }),
            source: 'live',
            cacheAgeSeconds: null,
            complexity: result.complexity,
          });
        },
      );
  },
};
