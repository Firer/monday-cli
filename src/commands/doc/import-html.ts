/**
 * `monday doc import-html --workspace <wid> (--html <file|-> |
 * --html-string <s>) [--folder <fid>] [--kind public|private|share]
 * [--title <t>] [--dry-run]` — import an HTML payload as a new workdoc
 * (`cli-design.md` §4.3 DOC section + §13 v0.5 entry;
 * `v0.5-plan.md` §3 M37 + §8 D12-D13).
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
 *     (defense-in-depth via the lifted {@link readSourceContent}
 *     helper's `maxBytes` slot).
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
 *   - `success: true + missing/null doc_id` → `internal_error`
 *     (Monday promises a non-null `doc_id` on success).
 *   - Oversized inline `--html-string` at parse boundary →
 *     `usage_error.details.issues[{path: 'htmlString', message:
 *     '--html-string exceeds the 256000-byte wire-side limit ...'}]`
 *     from `parseArgv`'s zod-issues envelope (D13 closure). The
 *     `usage_error` rejection surfaces ahead of any wire dispatch.
 *   - Oversized file payload at runtime →
 *     `readSourceContent` rejects with `usage_error` carrying
 *     `details: { source: 'file' | 'stdin', size_bytes, limit_bytes,
 *     file_path? }`.
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
 * **Runtime body landed at v0.5-M37 IMPL.** `parseArgv` runs BEFORE
 * `resolveClient` so invalid argv surfaces `usage_error` ahead of any
 * missing-token `config_error`; the lifted {@link readSourceContent}
 * helper applies the same size guard at the runtime read boundary
 * (file/stdin path) that the schema's `.refine()` applies at parse
 * boundary (inline path). Dry-run emits minimal planned changes with
 * the source descriptor; live path dispatches
 * {@link importDocFromHtml} + projects via `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema, DocFolderIdSchema } from '../../types/ids.js';
import {
  DOC_KIND_VALUES,
  MAX_DOC_IMPORT_PAYLOAD_BYTES,
  docImportHtmlOutputSchema,
  importDocFromHtml,
  type DocImportHtmlOutput,
} from '../../api/documents.js';
import { readSourceContent } from '../../utils/source-content.js';

const inputSchema = z
  .object({
    workspace: WorkspaceIdSchema,
    /**
     * File path for the HTML content (`-` reads from stdin). Mutually
     * exclusive with `htmlString` — exactly one required, enforced by
     * the cross-field `.refine()` below. The size guard against
     * {@link MAX_DOC_IMPORT_PAYLOAD_BYTES} applies at the runtime
     * read boundary via {@link readSourceContent}'s `maxBytes` slot
     * — file content size isn't known at argv-parse time.
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
      .refine((s) => s.trim().length > 0, {
        message:
          '--html-string must not be whitespace-only (zero non-whitespace bytes after trim). Pass HTML content.',
      })
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

const describeHtmlSource = (
  html: string | undefined,
  htmlString: string | undefined,
): string => {
  if (htmlString !== undefined) return '(inline)';
  if (html === '-') return '(stdin)';
  // The cross-field `.refine()` guarantees exactly one of `html` /
  // `htmlString` is set at this point; the fallthrough only reaches
  // a string-valued `html`.
  if (html === undefined) {
    // Defensive — the schema's `.refine()` prevents this branch from
    // firing in production. Surface a clear internal error if a future
    // refactor weakens the invariant.
    throw new Error('describeHtmlSource: invariant violated — neither html nor htmlString set after refine');
  }
  return html;
};

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
    const noun = ensureSubcommand(program, 'doc');
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

        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Minimal dry-run shape per cli-design §6.4 mutation-
          // dry-run variant — argv-derived, no preflight read. The
          // HTML payload itself is omitted (potentially hundreds of
          // KB); agents see WHAT would be sent + the source it would
          // come from via `html_source: '(inline)' | '(stdin)' | <path>`.
          const planned: Record<string, unknown> = {
            operation: 'import_doc_from_html',
            workspace_id: parsed.workspace,
            html_source: describeHtmlSource(parsed.html, parsed.htmlString),
          };
          if (parsed.folder !== undefined) {
            planned.folder_id = parsed.folder;
          }
          if (parsed.kind !== undefined) {
            planned.kind = parsed.kind;
          }
          if (parsed.title !== undefined) {
            planned.title = parsed.title;
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

        const html = await readSourceContent({
          inline: parsed.htmlString,
          file: parsed.html,
          stdin: ctx.stdin,
          inlineFlagName: '--html-string',
          fileFlagName: '--html',
          verbHint:
            'monday doc import-html requires either --html <file|-> or ' +
            '--html-string <s>. Use --html - to read from stdin.',
          maxBytes: MAX_DOC_IMPORT_PAYLOAD_BYTES,
        });

        const result = await importDocFromHtml({
          client,
          html,
          workspaceId: parsed.workspace,
          ...(parsed.kind === undefined ? {} : { kind: parsed.kind }),
          ...(parsed.folder === undefined ? {} : { folderId: parsed.folder }),
          ...(parsed.title === undefined ? {} : { title: parsed.title }),
        });
        emitMutation({
          ctx,
          data: result.result,
          schema: docImportHtmlCommand.outputSchema,
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
