/**
 * `monday update upload <uid> <file>` — attach a file to an Update
 * (comment) via Monday's `add_file_to_update` mutation
 * (cli-design.md §4.3 + §6.4 asset-upload sub-section + §13 v0.4
 * entry; v0.4-plan.md §3 M31).
 *
 * **Wire shape.** Single multipart/form-data round-trip via
 * {@link addFileToUpdate} against `mutation AddFileToUpdate` with
 * `operationName: 'AddFileToUpdate'` (R-NEW-37 W2 audit-point).
 * Same `MultipartTransport` seam as `item upload`; no column-id
 * involved (Updates carry attachments via `Update.assets` directly,
 * not via column values).
 *
 * **Argv shape.** Two positional args:
 *
 *   - `<uid>` — numeric update ID; brand-validated via
 *     {@link UpdateIdSchema}.
 *   - `<file>` — local file path (same constraints as
 *     `monday item upload`: regular readable file; stdin not
 *     supported at v0.4-M31).
 *
 * **No column-type validation needed.** Updates accept any file
 * type Monday supports — no column-shape gating like
 * `item upload`'s `file`-only check. Server-side validation handles
 * the rest (size cap, filename sanity, virus scan).
 *
 * **Local file failures + size handling — same `details.reason`
 * discrimination as `item upload`.** Three values:
 *   - `'file_not_readable'` — ENOENT / EACCES / path is a
 *     directory; fires at IMPL via `fs.stat()` pre-check.
 *   - `'file_empty'` — zero-byte file; fires via `fs.stat()`.
 *   - `'file_too_large'` — Monday's server-side size-cap
 *     rejection rewrap; carries `details.file_size_bytes`
 *     from the local `fs.stat()` measurement at upload
 *     time (NOT a Monday error-payload field — Monday's
 *     wire rejection may not surface a size; the CLI
 *     threads the locally-measured size into the details
 *     slot for a stable agent-keyed envelope).
 * No CLI-side hardcoded size pre-check; Monday's per-file cap
 * is plan-tier-dependent and not exposed via the schema.
 *
 * **`--dry-run` shape** per §6.4 asset-upload variant — emits
 * `{operation: 'add_file_to_update', update_id, file_path,
 * filename, file_size_bytes}` with `meta.source: 'none'`. No wire
 * call fires.
 *
 * **Idempotency: NO** — re-running uploads a second copy. Agents
 * needing register-once dedupe on `Update.assets` reads.
 *
 * **Cache invalidation.** N/A — Updates aren't part of the §8
 * cache scope (board-metadata-only); the upload changes the
 * Update's asset collection but nothing the cache tracks.
 *
 * **Status: runtime body shipped at v0.4-M31 IMPL** — mirrors
 * `item upload` minus the column-resolution + cache-invalidation
 * legs (Updates aren't part of the §8 cache scope; no per-column
 * type check needed because Updates accept any file type Monday
 * supports).
 */
import { z } from 'zod';
import { stat as fsStat, readFile } from 'node:fs/promises';
import { resolve as resolvePath, basename } from 'node:path';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { UpdateIdSchema } from '../../types/ids.js';
import {
  updateUploadOutputSchema,
  type UpdateUploadOutput,
  addFileToUpdate,
} from '../../api/assets.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UsageError, asError, errorCode } from '../../utils/errors.js';
import { sniffContentType } from '../../utils/mime.js';
import { emitMutation, emitDryRun } from '../emit.js';

const inputSchema = z
  .object({
    updateId: UpdateIdSchema,
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

export const updateUploadCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateUploadOutput
> = {
  name: 'update.upload',
  summary:
    'Attach a file to an Update (comment) via add_file_to_update',
  examples: [
    'monday update upload 98765 ./screenshot.png',
    'monday update upload 98765 ./report.pdf --dry-run',
  ],
  idempotent: false,
  inputSchema,
  outputSchema: updateUploadOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'update',
      'Update (comment) commands (cli-design §4.3 UPDATE)',
    );
    noun
      .command('upload <updateId> <file>')
      .description(updateUploadCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...updateUploadCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Uploads cross the wire as multipart/form-data (different transport from JSON-only verbs).',
          '  - File path is resolved relative to the cwd; stdin (`-`) is not supported in this release.',
          '  - Re-running with the same args creates a second Asset; `add_file_to_update` is not idempotent.',
          '',
        ].join('\n'),
      )
      .action(
        async (
          updateIdArg: unknown,
          fileArg: unknown,
        ) => {
          const parsed = parseArgv(updateUploadCommand.inputSchema, {
            updateId: updateIdArg,
            file: fileArg,
          });

          // Same fs.stat() pre-check shape as `item upload`. Pre-
          // resolveClient so a missing-file error surfaces as
          // usage_error (exit 1) before any token check.
          const filePath = resolvePath(process.cwd(), parsed.file);
          const filename = basename(filePath);
          let fileSizeBytes: number;
          try {
            const stats = await fsStat(filePath);
            if (!stats.isFile()) {
              throw new UsageError(
                `<file> ${JSON.stringify(parsed.file)} is not a regular file ` +
                  `(resolved to ${JSON.stringify(filePath)}).`,
                {
                  details: {
                    reason: 'file_not_readable',
                    file_path: filePath,
                    hint:
                      'pass a path to a regular readable file; directories ' +
                      'and special files (sockets, devices) are rejected.',
                  },
                },
              );
            }
            fileSizeBytes = stats.size;
          } catch (err) {
            if (err instanceof UsageError) {
              throw err;
            }
            const code = errorCode(err);
            throw new UsageError(
              `<file> ${JSON.stringify(parsed.file)} cannot be read ` +
                `(resolved to ${JSON.stringify(filePath)}): ` +
                `${asError(err).message}.`,
              {
                cause: err,
                details: {
                  reason: 'file_not_readable',
                  file_path: filePath,
                  ...(code === undefined ? {} : { errno_code: code }),
                  hint:
                    'check that the path exists, is readable by the current ' +
                    'user, and isn\'t a directory.',
                },
              },
            );
          }
          if (fileSizeBytes === 0) {
            throw new UsageError(
              `<file> ${JSON.stringify(parsed.file)} is empty (0 bytes); ` +
                `Monday rejects empty uploads server-side.`,
              {
                details: {
                  reason: 'file_empty',
                  file_path: filePath,
                  filename,
                  file_size_bytes: 0,
                  hint:
                    'Monday returns FILE_SIZE_LIMIT_EXCEEDED on empty ' +
                    'uploads. Provide a non-empty file or remove the upload ' +
                    'call.',
                },
              },
            );
          }

          const { client, globalFlags, apiVersion, multipart, toEmit } =
            resolveClient(ctx, program.opts());

          if (globalFlags.dryRun) {
            // D5 closure mirror — dry-run is fs.stat()-backed; no
            // wire mutation; no file bytes loaded. `update upload`
            // dry-run carries `update_id` instead of `item_id` +
            // `column_id`; otherwise structurally identical to the
            // `item upload` dry-run shape.
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [
                {
                  operation: 'add_file_to_update',
                  update_id: parsed.updateId,
                  file_path: filePath,
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

          const bytes = await readFile(filePath);
          const file = new Blob([bytes], { type: sniffContentType(filename) });

          const result = await addFileToUpdate({
            client,
            multipart,
            updateId: parsed.updateId,
            file,
            filename,
            signal: ctx.signal,
            retries: globalFlags.retry,
          });

          // No cache invalidation per D6 — Updates aren't part of the
          // §8 cache scope (which covers board metadata only).

          const data: UpdateUploadOutput = {
            operation: 'add_file_to_update',
            update_id: parsed.updateId,
            filename,
            file_size_bytes: fileSizeBytes,
            asset: result.asset,
          };

          emitMutation({
            ctx,
            data,
            schema: updateUploadCommand.outputSchema,
            programOpts: program.opts(),
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
