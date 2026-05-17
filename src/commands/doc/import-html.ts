/**
 * `monday doc import-html --workspace <wid> (--html <file|-> |
 * --html-string <s>) [--folder <fid>] [--kind public|private|share]
 * [--title <t>] [--dry-run]` — import an HTML payload as a new workdoc
 * (`cli-design.md` §4.3 DOC section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M37 + §8 D12-D13).
 *
 * **PRE-FLIGHT STUB at v0.5-M37 pre-flight.** Argv parsing + schema +
 * commander wiring + post-parse stub `internal_error` ship as the agent
 * contract surface; the wire-call leg (file/stdin read + size guard at
 * runtime layer + `importDocFromHtml` dispatch + custom-OBJECT projection
 * per D12) lands at v0.5-M37 IMPL.
 *
 * **Wire shape.** Single `import_doc_from_html(html, workspaceId,
 * kind?, folderId?, title?) → ImportDocFromHtmlResult` round-trip via
 * {@link importDocFromHtml} against `mutation ImportDocFromHtml` with
 * `operationName: 'ImportDocFromHtml'` (R-NEW-37 W2 audit-point).
 * Custom-OBJECT return shape: `{success!, doc_id?, error?}` —
 * distinct from M35's opaque-JSON projection and M36's typed-OBJECT
 * direct-unwrap (third doc-mutation return shape; see
 * `src/api/documents.ts` M37 section header for the full taxonomy).
 *
 * **camelCase wire-arg note.** `import_doc_from_html` uses camelCase
 * `workspaceId` / `folderId` on the wire (Finding 7); CLI argv stays
 * kebab-case (`--workspace <wid>` / `--folder <fid>`); error envelope
 * `details.*` keys stay snake_case (`details.workspace_id` /
 * `details.folder_id`) per cli-design §6.5. See the canonical
 * asymmetry note at `src/api/documents.ts` module header (5th
 * supporting site for R-NEW-41).
 *
 * **Argv shape.**
 *
 *   - `--workspace <wid>` — required (Monday's
 *     `import_doc_from_html.workspaceId` is `ID!`). Numeric workspace
 *     ID; brand-validated via {@link WorkspaceIdSchema} at the parse
 *     boundary.
 *   - `--html <file|->` OR `--html-string <s>` — **mutually-exclusive
 *     content source; exactly one required.** Both forms supply the
 *     HTML payload that Monday parses into a new doc; the source path
 *     vs inline-string split mirrors M13's `update reply / edit`
 *     `--body-file <path>` vs `--body <md>` shape. The file path form
 *     supports `-` for stdin (read up to EOF; cli-design §3.1 stdin
 *     discipline). The inline form caps at
 *     {@link MAX_DOC_IMPORT_PAYLOAD_BYTES} bytes at the parse
 *     boundary per D13 closure (empirical wire threshold sits
 *     between 250KB-OK and 500KB-rejected). The file/stdin form
 *     applies the same size guard at the runtime read boundary
 *     (IMPL).
 *   - `--folder <fid>` — optional (maps to wire `folderId: ID`).
 *     Numeric folder ID; brand-validated via {@link DocFolderIdSchema}.
 *     Absent → doc lands at workspace root.
 *   - `--kind <k>` — optional 3-value closed enum
 *     (`public` / `private` / `share`); maps to wire `kind: DocKind`.
 *     Absent → Monday applies the wire-side default `public` per
 *     probe description ("Defaults to 'public' if not specified").
 *   - `--title <t>` — optional, non-empty (maps to wire
 *     `title: String`). Absent → Monday infers the title from the
 *     HTML content per probe description ("If not provided, the
 *     title will be inferred from the HTML content").
 *
 * **Output envelope.** Custom-OBJECT projection per D12 — `data: {
 * doc_id, success: true }` mirroring M35's
 * {@link docMutationResultSchema} cadence so agents read a uniform
 * `{ doc_id, success }` shape across rename / delete / duplicate /
 * import-html. The `doc_id` slot carries the NEWLY-CREATED doc's id
 * (extracted from `ImportDocFromHtmlResult.doc_id`).
 *
 * **Failure mapping** per D12 closure:
 *
 *   - `success: false + populated error` → `validation_failed` with
 *     `details: { workspace_id, error, hint }`.
 *   - `success: false + empty/null error` → `internal_error` with
 *     wire-regression hint.
 *   - `success: true + missing doc_id` → `internal_error` (Monday
 *     promises a non-null `doc_id` on success).
 *   - Oversized inline payload at parse boundary → `usage_error.
 *     details.reason: 'payload_too_large'` (D13 closure).
 *   - Oversized file payload at runtime → `usage_error.details.
 *     reason: 'payload_too_large'` from the runtime read boundary
 *     (IMPL).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `import_doc_from_html`
 * operation + the resolved input fields (`workspace_id`, optional
 * `folder_id`, optional `kind`, optional `title`, `html_source`
 * descriptor — file path / `'(stdin)'` / `'(inline)'`). Does NOT
 * include the HTML payload itself (which could be hundreds of KB);
 * agents see WHAT would be sent, not the bytes. No preflight read
 * fires; `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running creates a duplicate doc with a
 * fresh id (Monday's wire does not dedupe by HTML content or title).
 * Agents that need idempotency must pair with a `monday doc list
 * --workspace <wid>` lookup first.
 *
 * **Permission-sensitive.** Tokens lacking workdoc-create scope on
 * the target workspace surface `forbidden` (mapped from Monday's
 * PERMISSION_DENIED extension).
 *
 * **R-NEW-76 discipline.** `parseArgv` (+ the mutex/length refines
 * baked into the schema) fires BEFORE the `c8 ignore start`
 * block-wrap so invalid argv surfaces `usage_error` from the parse
 * boundary, NOT `internal_error` from the c8-ignored stub throw
 * (the 11th post-graduation consumer at v0.5-M37 pre-flight).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { WorkspaceIdSchema, DocFolderIdSchema } from '../../types/ids.js';
import {
  DOC_KIND_VALUES,
  MAX_DOC_IMPORT_PAYLOAD_BYTES,
  docImportHtmlOutputSchema,
  type DocImportHtmlOutput,
} from '../../api/documents.js';
import { ApiError } from '../../utils/errors.js';

const inputSchema = z
  .object({
    workspace: WorkspaceIdSchema,
    /**
     * File path for the HTML content (`-` reads from stdin). Mutually
     * exclusive with `htmlString` — exactly one required, enforced by
     * the cross-field `.refine()` below. The size guard against
     * {@link MAX_DOC_IMPORT_PAYLOAD_BYTES} applies at the runtime
     * read boundary (IMPL) — file content size isn't known at argv-
     * parse time.
     */
    html: z.string().min(1, '--html must be a non-empty file path (use `-` for stdin)').optional(),
    /**
     * Literal HTML payload string. Mutually exclusive with `html`.
     * Capped at {@link MAX_DOC_IMPORT_PAYLOAD_BYTES} bytes (UTF-8)
     * at parse boundary per D13 closure (empirical wire threshold
     * sits between 250KB-OK and 500KB-rejected; conservative pin at
     * 250KB last-known-good).
     */
    htmlString: z
      .string()
      .min(1, '--html-string must not be empty')
      .refine(
        (s) => Buffer.byteLength(s, 'utf8') <= MAX_DOC_IMPORT_PAYLOAD_BYTES,
        {
          message: `--html-string exceeds the ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()}-byte wire-side limit (empirical probe pinned the threshold between 250KB OK and 500KB rejected; pass --html <file> with a smaller payload, or split the import across multiple calls)`,
        },
      )
      .optional(),
    folder: DocFolderIdSchema.optional(),
    kind: z.enum(DOC_KIND_VALUES).optional(),
    title: z.string().min(1, '--title must not be empty (omit the flag to let Monday infer the title from HTML)').optional(),
  })
  .strict()
  .refine(
    (v) => (v.html === undefined) !== (v.htmlString === undefined),
    {
      message:
        '--html (file path or `-` for stdin) and --html-string (literal HTML) are mutually exclusive; supply exactly one',
      path: ['html'],
    },
  );

export const docImportHtmlCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocImportHtmlOutput
> = {
  name: 'doc.import-html',
  summary: 'Import an HTML payload as a new workdoc (--workspace + --html|--html-string required)',
  examples: [
    'monday doc import-html --workspace 5555 --html-string \'<h1>Plan</h1><p>Body</p>\'',
    'monday doc import-html --workspace 5555 --html ./plan.html --title "Q4 launch plan"',
    'cat plan.html | monday doc import-html --workspace 5555 --html - --kind private',
    'monday doc import-html --workspace 5555 --html-string \'<p>x</p>\' --folder 12345 --dry-run --json',
  ],
  // Re-running creates a fresh duplicate doc — Monday's wire does not
  // dedupe by HTML content or title. Mark non-idempotent so agents
  // don't naively retry on transient failures.
  idempotent: false,
  inputSchema,
  outputSchema: docImportHtmlOutputSchema,
  attach: (program, ctx) => {
    // `ctx` reserved for IMPL — runtime body lands here at v0.5-M37
    // IMPL alongside `resolveClient(ctx, ...)` + `emitDryRun(...)` /
    // `emitMutation(...)`. Pre-flight stub doesn't use ctx; the void
    // statement keeps `noUnusedParameters` from rejecting the slot
    // before IMPL fills it.
    void ctx;
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('import-html')
      .description(docImportHtmlCommand.summary)
      .requiredOption('--workspace <wid>', 'numeric workspace ID (maps to wire `workspaceId: ID!`)')
      .option('--html <file>', 'file path containing the HTML payload (use `-` to read from stdin); mutually exclusive with --html-string')
      .option('--html-string <s>', `literal HTML payload (maps to wire \`html: String!\`); capped at ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()} bytes UTF-8 per D13 empirical threshold; mutually exclusive with --html`)
      .option('--folder <fid>', 'optional numeric folder ID (maps to wire `folderId: ID`); absent → doc lands at workspace root')
      .option(
        `--kind <${DOC_KIND_VALUES.join('|')}>`,
        'optional doc kind (maps to wire `kind: DocKind`); absent → Monday\'s wire-side default `public` applies',
      )
      .option('--title <t>', 'optional doc title (maps to wire `title: String`); absent → Monday infers the title from the HTML content')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docImportHtmlCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          `  - Inline --html-string is capped at ${MAX_DOC_IMPORT_PAYLOAD_BYTES.toString()} bytes (~250KB) at parse boundary per D13 closure; file path / stdin forms apply the same cap at runtime.`,
          '  - Re-running creates a duplicate doc; this verb is non-idempotent.',
          '  - `--dry-run` emits the planned `import_doc_from_html` operation + resolved input slots (HTML payload omitted; only its source descriptor is logged).',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(docImportHtmlCommand.inputSchema, opts);

        // R-NEW-76 graduated discipline: `parseArgv` fires BEFORE the
        // c8-ignored stub body so invalid argv surfaces `usage_error`
        // from the parse boundary (mutual-exclusion of --html /
        // --html-string, oversized --html-string, malformed brand on
        // --workspace / --folder, unknown --kind) — NOT
        // `internal_error` from the c8-ignored stub throw. Runtime
        // body (file/stdin read + size guard + wire dispatch +
        // projection per D12) lands at v0.5-M37 IMPL.
        /* c8 ignore start */
        // Stub body — IMPL session lands the dry-run emit + file/stdin
        // read leg + size-guard at runtime + `importDocFromHtml`
        // dispatch + custom-OBJECT projection. Argv parsing + schema +
        // mutex `.refine()` + byte-length `.refine()` above are real-
        // and-shipped; only the wire-call leg is deferred.
        void parsed;
        void program;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc import-html runtime body is a pre-flight stub; lands at v0.5-M37 IMPL alongside integration tests.',
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
