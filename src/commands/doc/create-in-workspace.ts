/**
 * `monday doc create-in-workspace --workspace <wid> --name <n>
 * [--folder <fid>] [--kind public|private|share] [--dry-run]` —
 * create a new workspace-scoped workdoc (`cli-design.md` §4.3
 * DOC section + §13 v0.5 entry; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Wire shape.** Single `create_doc(location: {workspace: ...})`
 * round-trip via {@link createDocInWorkspace} against `mutation
 * CreateDocInWorkspace` with `operationName:
 * 'CreateDocInWorkspace'` (R-NEW-37 W2 audit-point). Returns the
 * created `Document` with `id` populated post-create. The wire's
 * `CreateDocInput` is mutually-exclusive between `board` (item-
 * scoped) and `workspace` (workspace-scoped) variants per D7; this
 * verb supplies only the `workspace` slot. The sibling verb
 * `monday doc create-on-column` covers the board variant.
 *
 * **Argv shape.**
 *
 *   - `--workspace <wid>` — required (Monday's
 *     `CreateDocWorkspaceInput.workspace_id` is `ID!`). Numeric
 *     workspace ID; brand-validated via {@link WorkspaceIdSchema}
 *     at the parse boundary.
 *   - `--name <n>` — required (Monday's
 *     `CreateDocWorkspaceInput.name` is `String!`). Empty string
 *     rejects at parse.
 *   - `--folder <fid>` — optional (maps to wire `folder_id: ID`).
 *     Numeric folder ID; brand-validated via the existing folder-
 *     id brand. Absent → omitted (doc lands at workspace root).
 *   - `--kind <k>` — optional 3-value closed enum
 *     (`public` / `private` / `share`); maps to wire
 *     `kind: BoardKind`. Absent → omitted (Monday's wire applies
 *     the workspace-default kind).
 *
 * **Output envelope.** Direct unwrap of the created Document —
 * `data: <Document>`. Mirrors M32 `doc get` cadence (sans the
 * `blocks` slot — Monday returns `blocks: null` on a fresh create).
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `create_doc` operation +
 * the resolved input fields (`workspace_id`, `name`, optional
 * `folder_id`, optional `kind`). No preflight read fires; the
 * dry-run is purely argv-derived. `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running `doc create-in-workspace
 * --name foo` creates a SECOND doc with the same name (Monday
 * allows duplicate doc names within a workspace). Agents that
 * need idempotency must pair with a `doc list` lookup first.
 *
 * **Permission-sensitive.** Tokens lacking workdoc-create scope
 * on the target workspace surface `forbidden` (mapped from
 * Monday's PERMISSION_DENIED extension).
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema + commander
 * wiring all ship at pre-flight (real shipped surface). The
 * action body's wire-call dispatch + dry-run emit + envelope
 * emit land at v0.5-M35 IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { WorkspaceIdSchema, DocFolderIdSchema } from '../../types/ids.js';
import {
  CREATE_DOC_IN_WORKSPACE_MUTATION,
  DOC_KIND_VALUES,
  docCreateInWorkspaceOutputSchema,
  type DocCreateInWorkspaceOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    workspace: WorkspaceIdSchema,
    name: z.string().min(1, '--name must not be empty'),
    folder: DocFolderIdSchema.optional(),
    kind: z.enum(DOC_KIND_VALUES).optional(),
  })
  .strict();

export const docCreateInWorkspaceCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocCreateInWorkspaceOutput
> = {
  name: 'doc.create-in-workspace',
  summary: 'Create a workspace-scoped workdoc (--workspace + --name required)',
  examples: [
    'monday doc create-in-workspace --workspace 5555 --name "Q4 launch plan"',
    'monday doc create-in-workspace --workspace 5555 --name "Q4 launch plan" --folder 12345',
    'monday doc create-in-workspace --workspace 5555 --name "Q4 launch plan" --kind private',
    'monday doc create-in-workspace --workspace 5555 --name "Q4 launch plan" --dry-run --json',
  ],
  // Re-running creates a duplicate-named doc — Monday's wire does
  // NOT dedupe by name within a workspace. Mark non-idempotent so
  // agents don't naively retry on transient failures.
  idempotent: false,
  inputSchema,
  outputSchema: docCreateInWorkspaceOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('create-in-workspace')
      .description(docCreateInWorkspaceCommand.summary)
      .requiredOption('--workspace <wid>', 'numeric workspace ID (maps to wire `workspace_id: ID!`)')
      .requiredOption('--name <n>', 'doc name (Monday\'s `String!` — must not be empty)')
      .option('--folder <fid>', 'optional numeric folder ID (maps to wire `folder_id: ID`); absent → doc lands at workspace root')
      .option(
        `--kind <${DOC_KIND_VALUES.join('|')}>`,
        `optional doc kind (maps to wire \`kind: BoardKind\`); absent → Monday's workspace-default kind applies`,
      )
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docCreateInWorkspaceCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Monday allows duplicate doc names within a workspace; this verb is non-idempotent.',
          '  - `--dry-run` emits the planned `create_doc` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '  - For item-scoped docs use `monday doc create-on-column --item <iid> --column <cid>`.',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(docCreateInWorkspaceCommand.inputSchema, opts);

        // Parse global flags BEFORE the c8-ignored stub throw so
        // invalid global argv (e.g. `--json --table` conflict,
        // unknown `--output` value) surfaces as `usage_error` from
        // the parse boundary rather than masked as `internal_error`
        // from the stub. R-NEW-76 extends to global-flag parsing,
        // not just `parseArgv`. The parsed value is `void`ed until
        // the IMPL session wires it through `resolveClient`.
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
        void CREATE_DOC_IN_WORKSPACE_MUTATION;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc create-in-workspace — runtime body lands at v0.5-M35 IMPL.',
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
