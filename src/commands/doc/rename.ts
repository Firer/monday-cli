/**
 * `monday doc rename <doc-id> --name <n> [--dry-run]` — rename
 * an existing workdoc (`cli-design.md` §4.3 DOC section + §13
 * v0.5 entry; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Wire shape.** Single `update_doc_name(docId, name)` round-
 * trip via {@link renameDoc} against `mutation UpdateDocName`
 * with `operationName: 'UpdateDocName'` (R-NEW-37 W2 audit-point).
 * Returns Monday's opaque `JSON` scalar — the fetcher projects to
 * the flat `{ doc_id: <echoed>, success: true }` envelope per D9.
 *
 * **camelCase wire-arg note.** `update_doc_name` uses camelCase
 * `docId` on the wire (Finding 7); CLI argv stays kebab-case;
 * error envelope `details.*` keys stay snake_case. See the
 * canonical asymmetry note at `src/api/documents.ts` module
 * header (4th supporting site for R-NEW-41; R-v0.5-NEW-3
 * graduation candidate).
 *
 * **Argv shape.**
 *
 *   - `<doc-id>` — required positional (Monday's
 *     `update_doc_name.docId` is `ID!`). Brand-validated via
 *     {@link DocIdSchema}.
 *   - `--name <n>` — required (Monday's `update_doc_name.name`
 *     is `String!`). Empty string rejects at parse.
 *
 * **Output envelope.** Projected from Monday's opaque JSON
 * return per D9 — `data: { doc_id: <echoed>, success: true }`.
 * The `doc_id` echoes the input positional (the operation
 * targeted that specific doc); `success` is the literal `true`
 * pinned at the schema layer because Monday surfaces failure
 * via GraphQL `errors[]` (mapped to typed `ApiError`s upstream),
 * not via a wire-side success flag.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `update_doc_name`
 * operation + the resolved input fields (`doc_id`, `name`).
 * `meta.source: 'none'`.
 *
 * **Idempotent: yes.** Re-running with the same `<doc-id>` and
 * `--name <n>` produces the same end state; Monday's wire is a
 * no-op when the name matches the current value.
 *
 * **Runtime body landed at v0.5-M35 IMPL.** `parseArgv` runs
 * BEFORE `resolveClient` so invalid argv surfaces `usage_error`
 * ahead of any missing-token `config_error`; `resolveClient`
 * parses global flags internally before `loadConfig`. Dry-run
 * path emits minimal planned changes (no wire call fires); live
 * path dispatches {@link renameDoc} + projects via `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocIdSchema } from '../../types/ids.js';
import {
  renameDoc,
  docRenameOutputSchema,
  type DocRenameOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    docId: DocIdSchema,
    name: z.string().min(1, '--name must not be empty'),
  })
  .strict();

export const docRenameCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocRenameOutput
> = {
  name: 'doc.rename',
  summary: 'Rename an existing workdoc (--name required)',
  examples: [
    'monday doc rename 12345678 --name "Q4 launch plan (revised)"',
    'monday doc rename 12345678 --name "Q4 launch plan (revised)" --dry-run --json',
  ],
  // Renaming to the current name is a no-op on Monday's wire;
  // re-running idempotently converges.
  idempotent: true,
  inputSchema,
  outputSchema: docRenameOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('rename <docId>')
      .description(docRenameCommand.summary)
      .requiredOption('--name <n>', 'new doc name (Monday\'s `String!` — must not be empty)')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docRenameCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Envelope projects Monday\'s opaque JSON return to `{ doc_id, success: true }` (D9 closure).',
          '  - `--dry-run` emits the planned `update_doc_name` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '',
        ].join('\n'),
      )
      .action(async (docIdArg: unknown, opts: unknown) => {
        const parsed = parseArgv(docRenameCommand.inputSchema, {
          docId: docIdArg,
          ...(opts as Readonly<Record<string, unknown>>),
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
                operation: 'update_doc_name',
                doc_id: parsed.docId,
                name: parsed.name,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const result = await renameDoc({
          client,
          docId: parsed.docId,
          name: parsed.name,
        });
        emitMutation({
          ctx,
          data: result.result,
          schema: docRenameCommand.outputSchema,
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
