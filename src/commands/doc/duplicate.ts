/**
 * `monday doc duplicate <doc-id> [--with-updates] [--dry-run]` —
 * duplicate an existing workdoc (`cli-design.md` §4.3 DOC section
 * + §13 v0.5 entry; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Wire shape.** Single `duplicate_doc(docId, duplicateType?)`
 * round-trip via {@link duplicateDoc} against `mutation
 * DuplicateDoc` with `operationName: 'DuplicateDoc'` (R-NEW-37 W2
 * audit-point). Returns Monday's opaque `JSON` scalar — the
 * fetcher projects to the flat `{ doc_id: <NEW>, success: true }`
 * envelope per D9. The `doc_id` echoes the **NEWLY-CREATED**
 * duplicate's id (NOT the source-doc positional id) — the IMPL
 * cassette pins the new-id extraction from the wire's JSON
 * payload.
 *
 * **`--with-updates` semantics.** Monday's `duplicate_doc.
 * duplicateType` is a 2-value enum (`duplicate_doc_with_content`
 * / `duplicate_doc_with_content_and_updates`); the wire-side
 * default is `duplicate_doc_with_content` (content-only). The
 * CLI surfaces a boolean opt-in `--with-updates`:
 *
 *   - absent → omit the wire variable (Monday's wire-side default
 *     `duplicate_doc_with_content` applies — comments and update
 *     history are NOT copied).
 *   - present → wire `duplicateType:
 *     'duplicate_doc_with_content_and_updates'` (clone body +
 *     every comment / update thread).
 *
 * The 2-value enum stays internal to the fetcher; agents see a
 * boolean opt-in, not the wire enum name.
 *
 * **No `--name <n>` slot per D8.** Monday's `duplicate_doc`
 * mutation carries no rename-on-duplicate arg on the wire — the
 * duplicate inherits Monday's auto-generated copy name (typically
 * `"Copy of <source-name>"`). Agents needing a renamed duplicate
 * pair this verb with a follow-up `monday doc rename <new-id>
 * --name <n>` call. Adding the slot speculatively was the D8
 * alternative (CLI would have wrapped a non-atomic
 * duplicate→rename sequence); pre-flight ratified the drop
 * because non-atomic cross-mutation flows leak partial-failure
 * complexity into the verb's envelope shape (one operation
 * succeeded, one failed → the verb's envelope shape doesn't fit
 * cli-design §6.1 single-mutation success/failure dichotomy).
 *
 * **Wire-name asymmetry note.** `duplicate_doc` takes camelCase
 * `docId` + `duplicateType` on the wire per Finding 7. The
 * fetcher boundary mirrors the wire shape; CLI argv stays
 * kebab-case (`<doc-id>` positional + `--with-updates` flag).
 * Error envelope `details.*` keys stay snake_case
 * (`details.doc_id`). 4th supporting site for R-NEW-41 — see
 * `src/api/documents.ts` module header for the canonical note.
 *
 * **Argv shape.**
 *
 *   - `<doc-id>` — required positional (Monday's
 *     `duplicate_doc.docId` is `ID!`). Brand-validated via
 *     {@link DocIdSchema}. Echoed in error envelopes; **NOT
 *     echoed in the success envelope** (the success envelope's
 *     `doc_id` slot carries the NEW duplicate's id per D9).
 *   - `--with-updates` — optional boolean. Absent → wire-side
 *     default `duplicate_doc_with_content`; present → wire
 *     `duplicate_doc_with_content_and_updates`.
 *
 * **Output envelope.** Projected from Monday's opaque JSON return
 * per D9 — `data: { doc_id: <NEW>, success: true }`. The
 * `doc_id` slot is the new duplicate's id, NOT the source-doc
 * positional. Source-doc id stays accessible via the argv
 * (agents script `monday doc duplicate <source-id> | jq` and
 * see the new id in the projection).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant:
 * minimal `{operation: "duplicate_doc", doc_id: <source>,
 * duplicate_type?}`. The `doc_id` slot in the dry-run echoes the
 * SOURCE id (not the new-id — Monday's wire is the only entity
 * that can mint a new DocId at duplicate-time). No preflight
 * read fires; `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running creates a SECOND duplicate
 * (Monday's wire does NOT dedupe by source-id). The source-doc's
 * `id` stays addressable; the duplicates accrete.
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema + commander
 * wiring all ship at pre-flight. Runtime body lands at v0.5-M35
 * IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { DocIdSchema } from '../../types/ids.js';
import {
  DUPLICATE_DOC_MUTATION,
  docDuplicateOutputSchema,
  type DocDuplicateOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    docId: DocIdSchema,
    withUpdates: z.boolean().optional(),
  })
  .strict();

export const docDuplicateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocDuplicateOutput
> = {
  name: 'doc.duplicate',
  summary: 'Duplicate a workdoc (content-only by default; --with-updates also clones comments + update history)',
  examples: [
    'monday doc duplicate 12345678',
    'monday doc duplicate 12345678 --with-updates',
    'monday doc duplicate 12345678 --with-updates --dry-run --json',
  ],
  // Monday's wire allows multiple duplicates per source; verb is
  // non-idempotent (each call mints a new DocId).
  idempotent: false,
  inputSchema,
  outputSchema: docDuplicateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('duplicate <docId>')
      .description(docDuplicateCommand.summary)
      .option(
        '--with-updates',
        'clone comments + update history alongside the doc body (maps to wire `duplicateType: duplicate_doc_with_content_and_updates`); absent → content-only',
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docDuplicateCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Envelope `data.doc_id` is the NEW duplicate\'s id (not the source-doc positional). Source-doc id stays available via the argv (D9 closure).',
          '  - Monday\'s wire offers no rename-on-duplicate slot; the duplicate inherits Monday\'s auto-generated copy name. Pair with `monday doc rename <new-id> --name <n>` for a renamed duplicate (D8 closure).',
          '  - `--dry-run` emits the planned `duplicate_doc` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '',
        ].join('\n'),
      )
      .action(async (docIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(docDuplicateCommand.inputSchema, {
          docId: docIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Parse global flags BEFORE the c8-ignored stub throw so
        // invalid global argv surfaces as `usage_error` from the
        // parse boundary, not masked as `internal_error` from the
        // stub. See `create-in-workspace.ts` for the canonical
        // rationale.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        void globalFlags;

        /* c8 ignore start */
        // Stub body — IMPL session lands the dry-run emit + live
        // wire-call dispatch + envelope emit. Argv parsing + schema
        // above is real-and-shipped; only the wire-call leg is
        // deferred.
        void ctx;
        void program;
        void parsed;
        void DUPLICATE_DOC_MUTATION;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc duplicate — runtime body lands at v0.5-M35 IMPL.',
          {
            details: {
              deferred_to: 'v0.5-M35 IMPL',
              hint:
                'pre-flight ships argv parsing + schema + wire mutation ' +
                'document only; the live dispatch + dry-run emit + envelope ' +
                'emit land at the IMPL session.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
