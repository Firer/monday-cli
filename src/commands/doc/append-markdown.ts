/**
 * `monday doc append-markdown <doc-id> (--markdown <file|-> |
 * --markdown-string <s>) [--after <bid>] [--dry-run]` — append a
 * parsed-markdown payload as new blocks at the tail of an existing
 * workdoc (`cli-design.md` §4.3 DOC section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M37 + §8 D12-D13).
 *
 * **PRE-FLIGHT STUB at v0.5-M37 pre-flight.** Argv parsing + schema +
 * commander wiring + post-parse stub `internal_error` ship as the
 * agent contract surface; the wire-call leg (file/stdin read + size
 * guard at runtime + `addContentToDocFromMarkdown` dispatch +
 * custom-OBJECT projection per D12) lands at v0.5-M37 IMPL.
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
 * valid success shape** (markdown payload contained no convertible
 * blocks — e.g. an empty file or markdown that parsed to zero
 * blocks); the CLI does not rewrap empty-blocks as failure.
 *
 * **Failure mapping** per D12 closure:
 *
 *   - `success: false + populated error` → `validation_failed` with
 *     `details: { doc_id, error, hint }`.
 *   - `success: false + empty/null error` → `internal_error` with
 *     wire-regression hint.
 *   - `success: true + missing block_ids` → `internal_error` (Monday
 *     promises a non-null `block_ids` list on success).
 *   - Oversized inline payload at parse boundary → `usage_error.
 *     details.reason: 'payload_too_large'` (D13 closure).
 *   - Oversized file payload at runtime → `usage_error.details.
 *     reason: 'payload_too_large'` from the runtime read boundary
 *     (IMPL).
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
 * **R-NEW-76 discipline.** `parseArgv` fires BEFORE the c8-ignored
 * stub body — 12th post-graduation consumer at v0.5-M37 pre-flight.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { DocIdSchema, DocBlockIdSchema } from '../../types/ids.js';
import {
  MAX_DOC_IMPORT_PAYLOAD_BYTES,
  docAppendMarkdownOutputSchema,
  type DocAppendMarkdownOutput,
} from '../../api/documents.js';
import { ApiError } from '../../utils/errors.js';

const inputSchema = z
  .object({
    docId: DocIdSchema,
    /**
     * File path for the markdown content (`-` reads from stdin).
     * Mutually exclusive with `markdownString` — exactly one
     * required, enforced by the cross-field `.refine()` below. Size
     * guard at runtime read boundary (IMPL).
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
    // `ctx` reserved for IMPL — runtime body lands here at v0.5-M37
    // IMPL alongside `resolveClient(ctx, ...)` + `emitDryRun(...)` /
    // `emitMutation(...)`. Pre-flight stub doesn't use ctx; the void
    // statement keeps `noUnusedParameters` from rejecting the slot
    // before IMPL fills it.
    void ctx;
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
          '  - Empty markdown payload (zero convertible blocks) returns a success envelope with `block_ids: []`.',
          '  - `--dry-run` emits the planned `add_content_to_doc_from_markdown` operation + resolved input slots (markdown payload omitted; only its source descriptor is logged).',
          '',
        ].join('\n'),
      )
      .action(async (docIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(docAppendMarkdownCommand.inputSchema, {
          docId: docIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // R-NEW-76 graduated discipline: `parseArgv` fires BEFORE the
        // c8-ignored stub body so invalid argv surfaces `usage_error`
        // from the parse boundary (mutual-exclusion of --markdown /
        // --markdown-string, oversized --markdown-string, malformed
        // <doc-id> / --after brands) — NOT `internal_error` from the
        // c8-ignored stub throw. Runtime body lands at v0.5-M37 IMPL.
        /* c8 ignore start */
        // Stub body — same shape as `import-html.ts`.
        void parsed;
        void program;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc append-markdown runtime body is a pre-flight stub; lands at v0.5-M37 IMPL alongside integration tests.',
          {
            details: {
              deferred_to: 'v0.5-M37 IMPL',
              hint:
                'agent contract surface (argv schema + parse-boundary rejections + ' +
                'dry-run envelope) ships at pre-flight; the wire-call leg lands at IMPL.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
