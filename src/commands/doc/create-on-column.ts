/**
 * `monday doc create-on-column --item <iid> --column <cid>
 * [--dry-run]` — create a new workdoc embedded into a doc-column
 * on an existing item (`cli-design.md` §4.3 DOC section + §13
 * v0.5 entry; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Wire shape.** Single `create_doc(location: {board: ...})`
 * round-trip via {@link createDocOnColumn} against `mutation
 * CreateDocOnColumn` with `operationName: 'CreateDocOnColumn'`
 * (R-NEW-37 W2 audit-point). Returns the created `Document`.
 * The wire's `CreateDocInput` is mutually-exclusive between
 * `board` (item-scoped) and `workspace` (workspace-scoped)
 * variants per D7; this verb supplies only the `board` slot.
 * The sibling verb `monday doc create-in-workspace` covers the
 * workspace variant.
 *
 * **Argv shape.**
 *
 *   - `--item <iid>` — required (Monday's
 *     `CreateDocBoardInput.item_id` is `ID!`). Numeric item ID;
 *     brand-validated via {@link ItemIdSchema}.
 *   - `--column <cid>` — required (Monday's
 *     `CreateDocBoardInput.column_id` is `ID!`). Column ID slug;
 *     brand-validated via {@link ColumnIdSchema}. The column must
 *     be a doc-typed column on the item's board — CLI doesn't
 *     pre-check column-type compatibility (mirrors M8's
 *     `change_column_value` cadence); incompatible columns
 *     surface `validation_failed` at the wire.
 *
 * **Output envelope.** Direct unwrap of the created Document —
 * `data: <Document>`. Same shape as
 * `monday doc create-in-workspace` per the create-variant
 * symmetry.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant.
 * Minimal envelope listing the planned `create_doc` operation +
 * the resolved input fields (`item_id`, `column_id`). No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`.
 *
 * **Idempotent: false.** Re-running creates a SECOND doc on the
 * same column slot (Monday's wire allows multiple docs to attach
 * to one item-column pair). Agents that need idempotency must
 * pair with a column-value read first.
 *
 * **Status: PRE-FLIGHT STUB.** Argv parsing + schema + commander
 * wiring all ship at pre-flight. Runtime body lands at v0.5-M35
 * IMPL.
 */
import { z } from 'zod';
import { ApiError } from '../../utils/errors.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { ItemIdSchema, ColumnIdSchema } from '../../types/ids.js';
import {
  CREATE_DOC_ON_COLUMN_MUTATION,
  docCreateOnColumnOutputSchema,
  type DocCreateOnColumnOutput,
} from '../../api/documents.js';

const inputSchema = z
  .object({
    item: ItemIdSchema,
    column: ColumnIdSchema,
  })
  .strict();

export const docCreateOnColumnCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocCreateOnColumnOutput
> = {
  name: 'doc.create-on-column',
  summary: 'Create a workdoc embedded on a doc-column of an existing item (--item + --column required)',
  examples: [
    'monday doc create-on-column --item 12345 --column doc_column_1',
    'monday doc create-on-column --item 12345 --column doc_column_1 --dry-run --json',
  ],
  // Monday allows multiple docs on the same item-column slot
  // (the column is a one-to-many holder); creates are
  // non-idempotent against the column slot.
  idempotent: false,
  inputSchema,
  outputSchema: docCreateOnColumnOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('create-on-column')
      .description(docCreateOnColumnCommand.summary)
      .requiredOption('--item <iid>', 'numeric item ID (maps to wire `item_id: ID!`)')
      .requiredOption('--column <cid>', 'column ID slug (maps to wire `column_id: ID!`); column must be a doc-typed column on the item\'s board')
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docCreateOnColumnCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - The column must be a doc-typed column on the item\'s board; incompatible columns surface `validation_failed` at the wire (CLI does not pre-check column type).',
          '  - `--dry-run` emits the planned `create_doc` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '  - For workspace-scoped docs use `monday doc create-in-workspace --workspace <wid> --name <n>`.',
          '',
        ].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = parseArgv(docCreateOnColumnCommand.inputSchema, opts);

        /* c8 ignore start */
        // Stub body — IMPL session lands the dry-run emit + live
        // wire-call dispatch + envelope emit. Argv parsing + schema
        // above is real-and-shipped; only the wire-call leg is
        // deferred.
        void ctx;
        void program;
        void parsed;
        void CREATE_DOC_ON_COLUMN_MUTATION;
        await Promise.resolve();
        throw new ApiError(
          'internal_error',
          'monday doc create-on-column — runtime body lands at v0.5-M35 IMPL.',
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
