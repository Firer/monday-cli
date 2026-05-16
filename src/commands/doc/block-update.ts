/**
 * `monday doc block-update <block-id> --content <json> [--dry-run]`
 * — replace the content payload of an existing rich-text block
 * inside a workdoc (`cli-design.md` §4.3 DOC section + §13 v0.5
 * entry; `v0.5-plan.md` §3 M36 + §8 D10-D11).
 *
 * **Wire shape.** Single `update_doc_block(block_id, content) →
 * DocumentBlock` round-trip via {@link updateDocBlock} against
 * `mutation UpdateDocBlock` with `operationName: 'UpdateDocBlock'`
 * (R-NEW-37 W2 audit-point). Returns the full 9-field
 * `DocumentBlock` shape per the M32 probe (id / type / content /
 * position / parent_block_id / doc_id / created_at / created_by /
 * updated_at). OBJECT-return cadence (distinct from M35's opaque-
 * JSON projection cadence).
 *
 * **Snake_case wire arg names.** M36's wire uses snake_case
 * (`block_id`) — back to Monday's standard cadence after the M35
 * camelCase asymmetry. NOT a new R-NEW-41 supporting site.
 *
 * **No `--type` slot on the wire.** Monday's `update_doc_block`
 * mutation has no `type` arg — content type is fixed at creation
 * time. Agents needing to switch a block's content type must
 * `block-delete` + `block-create` (lossy: new id, new position).
 * The CLI surface mirrors the wire constraint exactly — no
 * client-side "change type" shim that papers over the destructive
 * recreate.
 *
 * **Argv shape.**
 *
 *   - `<block-id>` — required positional (Monday's
 *     `update_doc_block.block_id` is `String!`). Brand-validated
 *     via {@link DocBlockIdSchema} (opaque non-empty string —
 *     distinct from `DocId`'s numeric shape).
 *   - `--content <json>` — required JSON-string slot. Parsed once
 *     at the argv boundary via `parseJsonArg` (R-NEW-42 helper, 5th
 *     consumer; same shape `monday raw --vars` /
 *     `board column-create --settings` /
 *     `webhook create --config` / `doc block-create --content`
 *     use). The parsed JS value passes through to Monday's wire
 *     `JSON` scalar unmodified. The new content payload MUST match
 *     the existing block's `DocBlockContentType` shape (Monday's
 *     wire rejects shape-incompatible payloads with
 *     `validation_failed`); the CLI doesn't pre-validate.
 *
 * **Output envelope.** Direct unwrap of the updated DocumentBlock
 * — `data: <DocumentBlock>` per cli-design §6.1 single-record
 * convention. Mirrors `block-create`'s output shape — Monday's
 * wire returns the full post-update block.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant:
 * minimal `{operation: "update_doc_block", block_id, content}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Idempotent: yes.** Re-running with the same `<block-id>` and
 * `--content` produces the same end state; Monday's wire is a
 * no-op when the content value matches.
 *
 * **Runtime body landed at v0.5-M36 IMPL.** `parseArgv` +
 * `parseJsonArg` fire BEFORE `resolveClient` so invalid argv
 * surfaces `usage_error` ahead of any missing-token `config_error`
 * (R-NEW-76 graduated discipline). Dry-run path emits minimal
 * planned changes (no wire call fires); live path dispatches
 * {@link updateDocBlock} + projects via `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseJsonArg } from '../../utils/json.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocBlockIdSchema } from '../../types/ids.js';
import {
  updateDocBlock,
  docBlockUpdateOutputSchema,
  type DocBlockUpdateOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    blockId: DocBlockIdSchema,
    content: z.string().min(1, '--content must not be empty'),
  })
  .strict();

export const docBlockUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocBlockUpdateOutput
> = {
  name: 'doc.block-update',
  summary: 'Replace the content payload of an existing doc block (--content required)',
  examples: [
    'monday doc block-update blk_abc123 --content \'{"alignment":"center","content":"Hi"}\'',
    'monday doc block-update blk_abc123 --content \'{"items":["x","y","z"]}\' --dry-run --json',
  ],
  // Re-running with the same content is a no-op on Monday's wire;
  // re-running converges idempotently.
  idempotent: true,
  inputSchema,
  outputSchema: docBlockUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('block-update <blockId>')
      .description(docBlockUpdateCommand.summary)
      .requiredOption(
        '--content <json>',
        'new block content payload (JSON-encoded string parsed at argv boundary; shape must match the block\'s existing content type)',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docBlockUpdateCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Monday\'s wire has no `type` arg on `update_doc_block`; content type is fixed at block creation. Agents needing to change type use `doc block-delete` + `doc block-create` (lossy: new id, new position).',
          '  - Per-block content shapes are documented in `output-shapes.md` "Per-block content shapes" reference table.',
          '  - `--dry-run` emits the planned `update_doc_block` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '',
        ].join('\n'),
      )
      .action(
        async (
          blockIdArg: unknown,
          opts: { content: string },
        ) => {
          const parsed = parseArgv(docBlockUpdateCommand.inputSchema, {
            blockId: blockIdArg,
            content: opts.content,
          });

          // Parse the opaque `--content` JSON string once at the
          // boundary (R-NEW-42 lift).
          const parsedContent = parseJsonArg(parsed.content, {
            context: '--content must be a valid JSON-encoded string',
            details: {
              block_id: parsed.blockId,
              hint:
                'check the JSON syntax — strings need double-quotes; the ' +
                'shell may consume quotes if --content is not single-quoted',
            },
          });

          const { client, globalFlags, apiVersion } = resolveClient(
            ctx,
            program.opts(),
          );

          if (globalFlags.dryRun) {
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [
                {
                  operation: 'update_doc_block',
                  block_id: parsed.blockId,
                  content: parsedContent,
                },
              ],
              source: 'none',
              cacheAgeSeconds: null,
              warnings: [],
              apiVersion,
            });
            return;
          }

          const result = await updateDocBlock({
            client,
            blockId: parsed.blockId,
            content: parsedContent,
          });
          emitMutation({
            ctx,
            data: result.block,
            schema: docBlockUpdateCommand.outputSchema,
            programOpts: program.opts(),
            warnings: [],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            complexity: result.complexity,
            apiVersion,
          });
        },
      );
  },
};
