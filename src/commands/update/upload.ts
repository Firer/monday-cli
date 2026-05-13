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
 * **Status: PRE-FLIGHT STUB** — same shape as `item upload`. Argv
 * parsing is the real surface; everything after is c8-ignored
 * until IMPL.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { UpdateIdSchema } from '../../types/ids.js';
import {
  updateUploadOutputSchema,
  type UpdateUploadOutput,
} from '../../api/assets.js';
import { ApiError } from '../../utils/errors.js';

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
        (
          updateIdArg: unknown,
          fileArg: unknown,
        ) => {
          const parsed = parseArgv(updateUploadCommand.inputSchema, {
            updateId: updateIdArg,
            file: fileArg,
          });
          void ctx;

          /* c8 ignore start — pre-flight stub: the runtime body
             (file read + multipart dispatch + envelope emit, plus
             the dry-run `fs.stat()`-backed planned-change shape per
             D5) lands at v0.4-M31 IMPL. Surfacing `internal_error`
             keeps the stub discipline honest (no fake `ok: true`
             dry-run envelope with bogus `file_size_bytes: 0`). The
             c8 block drops with the IMPL feat per the M30 pre-
             flight cadence. */
          throw new ApiError(
            'internal_error',
            '`monday update upload` action body is a pre-flight stub; runtime body lands at v0.4-M31 IMPL',
            {
              details: {
                deferred_to: 'v0.4-M31 IMPL',
                update_id: parsed.updateId,
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
