/**
 * `monday doc append-markdown <doc-id> (--markdown <file|-> |
 * --markdown-string <s>) [--after <bid>] [--dry-run]` — append a
 * parsed-markdown payload as new blocks at the tail of an existing
 * workdoc (`cli-design.md` §4.3 DOC section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M37 + §8 D12-D13).
 *
 * **Wire shape.** Single `add_content_to_doc_from_markdown(docId,
 * markdown, afterBlockId?) → DocBlocksFromMarkdownResult` round-trip
 * via {@link addContentToDocFromMarkdown} against `mutation
 * AddContentToDocFromMarkdown` with `operationName:
 * 'AddContentToDocFromMarkdown'` (R-NEW-37 W2 audit-point).
 * Custom-OBJECT return shape: `{success!, block_ids?, error?}`.
 *
 * **camelCase wire-arg note.** `add_content_to_doc_from_markdown`
 * uses camelCase `docId` / `afterBlockId` on the wire (Finding 7);
 * CLI argv stays kebab-case (`<doc-id>` positional / `--after <bid>`);
 * error envelope `details.*` keys stay snake_case (`details.doc_id` /
 * `details.after_block_id`). 5th supporting site for R-NEW-41 at the
 * canonical asymmetry note (see `src/api/documents.ts` module header).
 *
 * **Argv shape.**
 *
 *   - `<doc-id>` — required positional (Monday's
 *     `add_content_to_doc_from_markdown.docId` is `ID!`). Brand-
 *     validated via {@link DocIdSchema}.
 *   - `--markdown <file|->` OR `--markdown-string <s>` — **mutually-
 *     exclusive content source; exactly one required.** Mirrors the
 *     `import-html` `--html` / `--html-string` shape verbatim. File
 *     path form supports `-` for stdin per cli-design §3.1; inline
 *     form caps at {@link MAX_DOC_IMPORT_PAYLOAD_BYTES} bytes UTF-8
 *     at parse boundary per D13 closure (same empirical threshold
 *     as the HTML side — the wire-side cap is transport-layer-wide,
 *     not per-mutation).
 *   - `--after <bid>` — optional opaque block ID (maps to wire
 *     `afterBlockId: String`). Brand-validated via
 *     {@link DocBlockIdSchema}. Absent → markdown blocks land at the
 *     document tail (append-end semantics per Monday's probe
 *     description: "Use this to append content to the end of a
 *     document or insert content after a specific block").
 *
 * **Output envelope.** Custom-OBJECT projection per D12 — `data: {
 * doc_id (echoed input), block_ids, success: true }`. Echoes the
 * input `<doc-id>` so agents piping the envelope into a follow-up
 * `monday doc get <doc-id>` keep the parent doc context inline.
 * `block_ids` is the wire's full list of NEWLY-CREATED block ids
 * preserved in markdown-source order. **Empty `block_ids: []` IS a
 * valid success shape** (non-empty markdown that Monday parses to
 * zero convertible blocks — e.g. comments-only or whitespace-only
 * post-Monday-parse); the CLI does not rewrap empty-blocks as
 * failure. (Note: empty / whitespace-only input is rejected at the
 * parse / read boundary — `--markdown-string` rejects at parse via
 * the schema's `.refine()`; file / stdin rejects at the runtime
 * read boundary via {@link readSourceContent}'s empty-after-trim
 * check — so the empty-`block_ids` success path is only reachable
 * for non-empty input that Monday's parser collapses to zero
 * structural blocks.)
 *
 * **Failure mapping** per D12 closure:
 *
 *   - `success: false + populated error` → `validation_failed` with
 *     `details: { doc_id, error, hint }`.
 *   - `success: false + empty/null error` → `internal_error` with
 *     wire-regression hint.
 *   - `success: true + null block_ids` → `internal_error` (Monday
 *     promises a non-null `block_ids` list on success).
 *   - Oversized inline `--markdown-string` at parse boundary →
 *     `usage_error.details.issues[{path: 'markdownString', message:
 *     '--markdown-string exceeds the 256000-byte wire-side limit
 *     ...'}]` from `parseArgv`'s zod-issues envelope (D13 closure).
 *     The `usage_error` rejection surfaces ahead of any wire
 *     dispatch.
 *   - Oversized file payload at runtime →
 *     `readSourceContent` rejects with `usage_error` carrying
 *     `details: { source: 'file' | 'stdin', size_bytes, limit_bytes,
 *     file_path? }`.
 *   - Non-existent / inaccessible `<doc-id>` → bubbles via Monday's
 *     wire-side `errors[]` → typed `ApiError` (`not_found` or
 *     `forbidden`).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned
 * `add_content_to_doc_from_markdown` operation + resolved input
 * slots (`doc_id`, optional `after_block_id`, `markdown_source`
 * descriptor — file path / `'(stdin)'` / `'(inline)'`). Markdown
 * payload itself omitted (can be hundreds of KB); agents see what
 * would be sent, not the bytes. No preflight read; `meta.source:
 * 'none'`.
 *
 * **Idempotent: false.** Re-running creates a SECOND set of blocks
 * carrying the same markdown content (Monday's wire does not dedupe).
 * Agents that need idempotency must pair with a `monday doc get
 * <doc-id>` lookup first to confirm the content isn't already
 * present, OR use `monday doc block-delete` + `block-create`
 * (M36) for fine-grained per-block control.
 *
 * **Permission-sensitive.** Tokens lacking workdoc-write scope on
 * the target doc surface `forbidden`.
 *
 * **Runtime body landed at v0.5-M37 IMPL.** Same shape as
 * `import-html.ts` — `parseArgv` BEFORE `resolveClient`; lifted
 * {@link readSourceContent} for file/stdin/inline with runtime size
 * guard; dry-run emits minimal planned changes; live path dispatches
 * {@link addContentToDocFromMarkdown} + projects via `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocIdSchema, DocBlockIdSchema } from '../../types/ids.js';
import {
  MAX_DOC_IMPORT_PAYLOAD_BYTES,
  docAppendMarkdownOutputSchema,
  addContentToDocFromMarkdown,
  type DocAppendMarkdownOutput,
} from '../../api/documents.js';
import { readSourceContent } from '../../utils/source-content.js';

const inputSchema = z
  .object({
    docId: DocIdSchema,
    /**
     * File path for the markdown content (`-` reads from stdin).
     * Mutually exclusive with `markdownString` — exactly one
     * required, enforced by the cross-field `.refine()` below. Size
     * guard at runtime read boundary via {@link readSourceContent}'s
     * `maxBytes` slot.
     */
    markdown: z
      .string()
      .min(1, '--markdown must be a non-empty file path (use `-` for stdin)')
      .optional(),
    /**
     * Literal markdown payload string. Mutually exclusive with
     * `markdown`. Capped at {@link MAX_DOC_IMPORT_PAYLOAD_BYTES}
     * bytes (UTF-8) at parse boundary per D13.
     */
    markdownString: z
      .string()
      .min(1, '--markdown-string must not be empty')
      .refine((s) => s.trim().length > 0, {
        message:
          '--markdown-string must not be whitespace-only (zero non-whitespace bytes after trim). Pass markdown content.',
      })
      .refine(
        (s) => Buffer.byteLength(s, 'utf8') <= MAX_DOC_IMPORT_PAYLOAD_BYTES,
        {
          message: `--markdown-string exceeds the ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()}-byte wire-side limit (empirical probe pinned the threshold between 250KB OK and 500KB rejected; pass --markdown <file> with a smaller payload, or split the append across multiple calls)`,
        },
      )
      .optional(),
    after: DocBlockIdSchema.optional(),
  })
  .strict()
  .refine(
    (v) => (v.markdown === undefined) !== (v.markdownString === undefined),
    {
      message:
        '--markdown (file path or `-` for stdin) and --markdown-string (literal markdown) are mutually exclusive; supply exactly one',
      path: ['markdown'],
    },
  );

const describeMarkdownSource = (
  markdown: string | undefined,
  markdownString: string | undefined,
): string => {
  if (markdownString !== undefined) return '(inline)';
  if (markdown === '-') return '(stdin)';
  if (markdown === undefined) {
    // Defensive — schema's `.refine()` prevents this in production.
    throw new Error('describeMarkdownSource: invariant violated — neither markdown nor markdownString set after refine');
  }
  return markdown;
};

export const docAppendMarkdownCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocAppendMarkdownOutput
> = {
  name: 'doc.append-markdown',
  summary: 'Append parsed-markdown blocks to an existing workdoc (--markdown|--markdown-string required)',
  examples: [
    'monday doc append-markdown 88010 --markdown-string \'# Heading\\n\\nBody.\'',
    'monday doc append-markdown 88010 --markdown ./changelog.md',
    'cat notes.md | monday doc append-markdown 88010 --markdown - --after blk_abc123',
    'monday doc append-markdown 88010 --markdown-string \'# H\' --dry-run --json',
  ],
  // Re-running creates a SECOND block-set with the same content —
  // Monday's wire does not dedupe append operations. Non-idempotent.
  idempotent: false,
  inputSchema,
  outputSchema: docAppendMarkdownOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('append-markdown <docId>')
      .description(docAppendMarkdownCommand.summary)
      .option('--markdown <file>', 'file path containing the markdown payload (use `-` to read from stdin); mutually exclusive with --markdown-string')
      .option('--markdown-string <s>', `literal markdown payload (maps to wire \`markdown: String!\`); capped at ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()} bytes UTF-8 per D13 empirical threshold; mutually exclusive with --markdown`)
      .option('--after <bid>', 'optional opaque block ID anchor (maps to wire `afterBlockId: String`); blocks insert immediately after this block; absent → blocks land at document tail (append-end semantics)')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docAppendMarkdownCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          `  - Inline --markdown-string is capped at ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()} bytes (~250KB) at parse boundary per D13 closure; file path / stdin forms apply the same cap at runtime.`,
          '  - Re-running creates duplicate blocks; this verb is non-idempotent. For fine-grained per-block control use `monday doc block-create` (M36).',
          '  - Non-empty markdown that Monday parses to zero convertible blocks returns a success envelope with `block_ids: []`. Empty / whitespace-only input rejects at the parse / read boundary as `usage_error` (`--markdown-string` rejects at parse; file / stdin rejects at runtime read) and never reaches the wire.',
          '  - `--dry-run` emits the planned `add_content_to_doc_from_markdown` operation + resolved input slots (markdown payload omitted; only its source descriptor is logged).',
          '',
        ].join('\n'),
      )
      .action(async (docIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
          docId: docIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          const planned: Record<string, unknown> = {
            operation: 'add_content_to_doc_from_markdown',
            doc_id: parsed.docId,
            markdown_source: describeMarkdownSource(parsed.markdown, parsed.markdownString),
          };
          if (parsed.after !== undefined) {
            planned.after_block_id = parsed.after;
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

        const markdown = await readSourceContent({
          inline: parsed.markdownString,
          file: parsed.markdown,
          stdin: ctx.stdin,
          inlineFlagName: '--markdown-string',
          fileFlagName: '--markdown',
          verbHint:
            'monday doc append-markdown requires either --markdown <file|-> ' +
            'or --markdown-string <s>. Use --markdown - to read from stdin.',
          maxBytes: MAX_DOC_IMPORT_PAYLOAD_BYTES,
        });

        const result = await addContentToDocFromMarkdown({
          client,
          docId: parsed.docId,
          markdown,
          ...(parsed.after === undefined
            ? {}
            : { afterBlockId: parsed.after }),
        });
        emitMutation({
          ctx,
          data: result.result,
          schema: docAppendMarkdownCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          source: result.source,
          cacheAgeSeconds: result.cacheAgeSeconds,
          complexity: result.complexity,
          apiVersion,
        });
      });
  },
};
