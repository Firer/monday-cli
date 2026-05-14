/**
 * `monday doc get <did>` — read a single workdoc by ID, including
 * its rich-text block body (cli-design.md §4.3 DOC section + §13
 * v0.4 entry; v0.4-plan.md §3 M32).
 *
 * **Wire shape.** Single `Query.docs(ids: [<did>])` round-trip via
 * {@link getDocument} against `query GetDoc` with `operationName:
 * 'GetDoc'` (R-NEW-37 W2 audit-point). Monday returns `[Document]`
 * (an array even for a single-id query); the fetcher extracts
 * index 0. Empty array → `not_found` with `details.doc_id` (D8 —
 * Monday's wire surface collapses "doesn't exist" + "exists but
 * inaccessible to token" into the same shape; the CLI can't
 * distinguish them).
 *
 * **Output envelope (D9).** Direct unwrap of the Document — `data:
 * <Document with blocks>`. Mirrors the read-one-verb convention
 * (`monday board get <bid>` returns `data: <Board>`, `monday user
 * get <uid>` returns `data: <User>`). The Document's own `id`
 * field is the echoed input; no separate `doc_id` slot is needed.
 * `data.blocks: [DocumentBlock]` is the rich-text body hydrated
 * from `Document.blocks` (always present on success — never null
 * for a doc that resolved).
 *
 * **Docs are live-only at v0.4-M32** per cli-design §8 cache
 * scope. Output `meta.source: "live"`, `meta.cache_age_seconds:
 * null`. Per-doc body content is content-heavy + frequently
 * human-edited; the stale-cache risk outweighs the cache-hit
 * value.
 *
 * **Idempotent: yes** (pure read).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema + commander
 * wiring all ship at pre-flight (real shipped surface). The action
 * body's wire-call dispatch + envelope emit land at v0.4-M32 IMPL.
 * The stub throws `internal_error` post-parse so a premature
 * invocation surfaces a clear "not yet implemented" signal rather
 * than a misleading false-success envelope (M31 pre-flight round-1
 * P2-2 lesson).
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { DocIdSchema } from '../../types/ids.js';
import {
  docGetOutputSchema,
  type DocGetOutput,
} from '../../api/documents.js';

const inputSchema = z.object({ docId: DocIdSchema }).strict();

export const docGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocGetOutput
> = {
  name: 'doc.get',
  summary: 'Read a single workdoc by ID (includes block body)',
  examples: [
    'monday doc get 12345678',
    'monday doc get 12345678 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: docGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(
      program,
      'doc',
      'Document commands (workdocs; read-only at v0.4 — see cli-design §13 v0.4 entry)',
    );
    noun
      .command('get <docId>')
      .description(docGetCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docGetCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Output carries the full Document plus `blocks: [DocumentBlock]` (rich-text body).',
          '  - Non-existent + inaccessible docs both surface `not_found` (Monday\'s wire collapses both cases).',
          '',
        ].join('\n'),
      )
      .action(async (docIdArg: unknown) => {
        const parsed = parseArgv(docGetCommand.inputSchema, {
          docId: docIdArg,
        });

        /* c8 ignore start */
        // Stub body — IMPL session lands the wire call + envelope
        // emit. Argv parsing above is real-and-shipped; only the
        // wire-call leg is deferred.
        void ctx;
        void program;
        void parsed;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc get — runtime body lands at v0.4-M32 IMPL.',
          {
            details: {
              deferred_to: 'v0.4-M32 IMPL',
              hint:
                'pre-flight ships argv parsing + schema + wire query ' +
                'document only; the live dispatch + envelope emit land ' +
                'at the IMPL session.',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
