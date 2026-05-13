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
 * **File size handling — same as `item upload`.** No CLI-side
 * pre-check; Monday's runtime rejection rewraps as `usage_error`
 * with `details.reason: 'file_too_large'` at IMPL.
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
 * **Status: PRE-FLIGHT STUB** — same shape as `item upload`. Argv
 * parsing is the real surface; everything after is c8-ignored
 * until IMPL.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { UpdateIdSchema } from '../../types/ids.js';
import {
  addFileToUpdate,
  updateUploadOutputSchema,
  type UpdateUploadOutput,
} from '../../api/assets.js';
import { createMultipartFetchTransport } from '../../api/multipart-transport.js';
import { loadConfig } from '../../config/load.js';

const inputSchema = z
  .object({
    updateId: UpdateIdSchema,
    file: z
      .string()
      .min(1, {
        message:
          '<file> must be a non-empty local file path; stdin (`-`) is not supported in v0.4-M31 (a future contract extension may add stdin support once a `--filename <name>` companion flag is pinned).',
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

          /* c8 ignore start — pre-flight stub: file read + multipart
             dispatch + envelope emit land at v0.4-M31 IMPL. The c8
             ignore drops with the IMPL feat per the M30 pre-flight
             cadence. */
          const { client, globalFlags, apiVersion } = resolveClient(
            ctx,
            program.opts(),
          );
          void globalFlags;

          const filename = parsed.file;
          const fileSizeBytes = 0;
          const file = new Blob([], { type: 'application/octet-stream' });

          if (program.opts().dryRun === true) {
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [
                {
                  operation: 'add_file_to_update',
                  update_id: parsed.updateId,
                  file_path: parsed.file,
                  filename,
                  file_size_bytes: fileSizeBytes,
                },
              ],
              source: 'none',
              cacheAgeSeconds: null,
              warnings: [],
              apiVersion,
            });
            return;
          }

          const config = loadConfig(ctx.env);
          const multipart = createMultipartFetchTransport({
            endpoint: config.apiUrl,
            apiToken: config.apiToken,
            apiVersion,
            timeoutMs: config.requestTimeoutMs,
          });

          const result = await addFileToUpdate({
            client,
            multipart,
            updateId: parsed.updateId,
            file,
            filename,
          });

          emitMutation({
            ctx,
            data: {
              operation: 'add_file_to_update' as const,
              update_id: parsed.updateId,
              filename,
              file_size_bytes: fileSizeBytes,
              asset: result.asset,
            },
            schema: updateUploadCommand.outputSchema,
            programOpts: program.opts(),
            warnings: [],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            complexity: result.complexity,
            apiVersion,
          });
          /* c8 ignore stop */
        },
      );
  },
};
