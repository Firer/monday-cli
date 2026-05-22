/**
 * `monday doc block-create <doc-id> --type <DocBlockContentType>
 * --content <json> [--after <bid>] [--parent <bid>] [--dry-run]` —
 * create a new rich-text block inside an existing workdoc
 * (`cli-design.md` §4.3 DOC section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M36 + §8 D10-D11).
 *
 * **Wire shape.** Single `create_doc_block(doc_id, type, content,
 * after_block_id?, parent_block_id?) → DocumentBlock` round-trip
 * via {@link createDocBlock} against `mutation CreateDocBlock`
 * with `operationName: 'CreateDocBlock'` (R-NEW-37 W2 audit-point).
 * Returns the full 9-field `DocumentBlock` shape per the M32 probe
 * (id / type / content / position / parent_block_id / doc_id /
 * created_at / created_by / updated_at). OBJECT-return cadence
 * (distinct from M35's opaque-JSON projection cadence).
 *
 * **Snake_case wire arg names.** M36's wire uses snake_case
 * (`doc_id`, `after_block_id`, `parent_block_id`) — back to Monday's
 * standard cadence after the M35 camelCase asymmetry. The fetcher's
 * GraphQL document maps camelCase variables to snake_case wire args
 * (`doc_id: $docId`); CLI argv stays kebab-case (`--after <bid>` /
 * `--parent <bid>`); error envelope `details.*` keys stay
 * snake_case per cli-design §6.5. NOT a new R-NEW-41 supporting
 * site — M36 is the symmetric path, M35 was the asymmetric one.
 *
 * **Argv shape.**
 *
 *   - `<doc-id>` — required positional (Monday's
 *     `create_doc_block.doc_id` is `ID!`). Brand-validated via
 *     {@link DocIdSchema}.
 *   - `--type <t>` — required closed enum (16 values per the M36
 *     empirical probe; see {@link DOC_BLOCK_CONTENT_TYPE_VALUES}).
 *     Maps to wire `type: DocBlockContentType!`. Unknown values
 *     reject at the parse boundary with `usage_error.details.
 *     issues[]` per D10 closure.
 *   - `--content <json>` — required JSON-string slot. Parsed once
 *     at the argv boundary via `parseJsonArg` (R-NEW-42 helper, 4th
 *     consumer; same shape `monday raw --vars` /
 *     `board column-create --settings` / `webhook create --config`
 *     use). The parsed JS value is passed through to Monday's wire
 *     `JSON` scalar unmodified. **Per-type content payload
 *     structure** varies across the 16 `DocBlockContentType`
 *     variants per D11 — `docs/output-shapes.md` "Per-block content
 *     shapes" reference table marks cassette-pinned shapes and
 *     TBD / inferred variants pending live-probe cassettes. The CLI
 *     accepts every variant + dispatches unmodified; a shape-
 *     incompatible `--content` for the chosen `--type` surfaces
 *     `validation_failed` from Monday at the live path. The CLI
 *     doesn't pre-validate the inner content shape.
 *   - `--after <bid>` — optional opaque-string block id (maps to
 *     wire `after_block_id: String`). Brand-validated via
 *     {@link DocBlockIdSchema}. Absent → block inserted at the
 *     document head (Monday's wire default per probe description).
 *   - `--parent <bid>` — optional opaque-string block id (maps to
 *     wire `parent_block_id: String`). Brand-validated via
 *     {@link DocBlockIdSchema}. Absent → block lands at the
 *     document root level (no parent nesting).
 *
 * **Output envelope.** Direct unwrap of the created DocumentBlock
 * — `data: <DocumentBlock>` per cli-design §6.1 single-record
 * convention. Mirrors M35 `doc create-in-workspace` /
 * `create-on-column` cadence (full Document direct-unwrap on
 * create); M36 returns the per-block shape instead.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `create_doc_block`
 * operation + the resolved input fields (`doc_id`, `type`,
 * `content`, optional `after_block_id`, optional `parent_block_id`).
 * No preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running `doc block-create` creates a
 * SECOND block under the same anchor (Monday's wire allows
 * duplicate content blocks within a doc). Agents that need
 * idempotency must pair with a `doc get <doc-id>` lookup first to
 * verify the block doesn't already exist.
 *
 * **Runtime body landed at v0.5-M36 IMPL.** `parseArgv` +
 * `parseJsonArg` fire BEFORE `resolveClient` so invalid argv
 * surfaces `usage_error` ahead of any missing-token `config_error`
 * (R-NEW-76 graduated discipline). Dry-run path emits minimal
 * planned changes (no wire call fires); live path dispatches
 * {@link createDocBlock} + projects via `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseJsonArg } from '../../utils/json.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocIdSchema, DocBlockIdSchema } from '../../types/ids.js';
import {
  createDocBlock,
  DOC_BLOCK_CONTENT_TYPE_VALUES,
  docBlockCreateOutputSchema,
  type DocBlockCreateOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    docId: DocIdSchema,
    type: z.enum(DOC_BLOCK_CONTENT_TYPE_VALUES),
    content: z.string().min(1, '--content must not be empty'),
    after: DocBlockIdSchema.optional(),
    parent: DocBlockIdSchema.optional(),
  })
  .strict();

export const docBlockCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocBlockCreateOutput
> = {
  name: 'doc.block-create',
  summary: 'Create a new rich-text block inside a workdoc (--type + --content required)',
  examples: [
    'monday doc block-create 88010 --type normal_text --content \'{"alignment":"left","content":"Hello"}\'',
    'monday doc block-create 88010 --type code --content \'{"language":"ts","code":"console.log(1)"}\' --after blk_abc123',
    'monday doc block-create 88010 --type bulleted_list --content \'{"items":["a","b"]}\' --parent blk_layout1',
    'monday doc block-create 88010 --type divider --content \'{}\' --dry-run --json',
  ],
  // Monday allows duplicate content blocks within a doc — re-running
  // creates a second block at the same anchor. Mark non-idempotent
  // so agents don't naively retry on transient failures.
  idempotent: false,
  inputSchema,
  outputSchema: docBlockCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc');
    noun
      .command('block-create <docId>')
      .description(docBlockCreateCommand.summary)
      .requiredOption(
        `--type <${DOC_BLOCK_CONTENT_TYPE_VALUES.join('|')}>`,
        'block content type (maps to wire `type: DocBlockContentType!`); 16 closed values',
      )
      .requiredOption(
        '--content <json>',
        'block content payload (JSON-encoded string parsed at argv boundary; shape varies per --type per Monday\'s `JSON` scalar)',
      )
      .option(
        '--after <bid>',
        'optional opaque block ID (maps to wire `after_block_id: String`); absent → block inserted at document head',
      )
      .option(
        '--parent <bid>',
        'optional opaque parent block ID (maps to wire `parent_block_id: String`); absent → block lands at document root',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docBlockCreateCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - `--content` must be a valid JSON string; per-block content shapes are documented in `output-shapes.md` "Per-block content shapes" reference table.',
          '  - Monday allows duplicate blocks at the same anchor; this verb is non-idempotent.',
          '  - `--dry-run` emits the planned `create_doc_block` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '',
        ].join('\n'),
      )
      .action(
        async (
          docIdArg: unknown,
          opts: {
            type: string;
            content: string;
            after?: string;
            parent?: string;
          },
        ) => {
          const parsed = parseArgv(docBlockCreateCommand.inputSchema, {
            docId: docIdArg,
            type: opts.type,
            content: opts.content,
            ...(opts.after === undefined ? {} : { after: opts.after }),
            ...(opts.parent === undefined ? {} : { parent: opts.parent }),
          });

          // Parse the opaque `--content` JSON string once at the
          // boundary. Threading the raw string to Monday's `JSON`
          // scalar would double-encode (Monday sees a JSON-string-of-
          // a-string); parsing to a JS value first sends the intended
          // shape. R-NEW-42 lift: shared `parseJsonArg` helper.
          const parsedContent = parseJsonArg(parsed.content, {
            context: '--content must be a valid JSON-encoded string',
            details: {
              doc_id: parsed.docId,
              type: parsed.type,
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
            const planned: Record<string, unknown> = {
              operation: 'create_doc_block',
              doc_id: parsed.docId,
              type: parsed.type,
              content: parsedContent,
            };
            if (parsed.after !== undefined) {
              planned.after_block_id = parsed.after;
            }
            if (parsed.parent !== undefined) {
              planned.parent_block_id = parsed.parent;
            }
            emitDryRun({
              ctx,
              programOpts: program.opts(),
              plannedChanges: [planned],
              source: 'none',
              cacheAgeSeconds: null,
              warnings: [],
              apiVersion,
            });
            return;
          }

          const result = await createDocBlock({
            client,
            docId: parsed.docId,
            type: parsed.type,
            content: parsedContent,
            ...(parsed.after === undefined ? {} : { afterBlockId: parsed.after }),
            ...(parsed.parent === undefined ? {} : { parentBlockId: parsed.parent }),
          });
          emitMutation({
            ctx,
            data: result.block,
            schema: docBlockCreateCommand.outputSchema,
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
