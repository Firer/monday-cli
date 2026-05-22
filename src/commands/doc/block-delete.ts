/**
 * `monday doc block-delete <block-id> --yes [--dry-run]` — delete
 * an existing rich-text block from a workdoc (`cli-design.md`
 * §4.3 DOC section + §13 v0.5 entry; `v0.5-plan.md` §3 M36 +
 * §8 D10-D11).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2 + M10 round-1
 * P2 invariant). `--yes` is mandatory for the live path; without
 * `--yes` (and without `--dry-run`) the command fails fast with
 * `confirmation_required` (exit 1) carrying `details.block_id`. The
 * gate fires BEFORE `resolveClient()` so a missing token doesn't
 * mask `confirmation_required` as `config_error` (same shape — and
 * same gate-before-resolve ordering — as M14 `workspace delete` /
 * M10 `item delete` / `update delete` / `team delete` / `doc delete`).
 *
 * **Wire shape.** Single `delete_doc_block(block_id) →
 * DocumentBlockIdOnly` round-trip via {@link deleteDocBlock}
 * against `mutation DeleteDocBlock` with `operationName:
 * 'DeleteDocBlock'` (R-NEW-37 W2 audit-point). Returns a single-
 * field OBJECT (`{id: String!}`) — Monday's wire mints a typed
 * shape distinct from `DocumentBlock` (the deletion endpoint only
 * confirms the id, doesn't echo the pre-delete content).
 *
 * **Snake_case wire arg names.** M36's wire uses snake_case
 * (`block_id`) — back to Monday's standard cadence after the M35
 * camelCase asymmetry. NOT a new R-NEW-41 supporting site.
 *
 * **Argv shape.**
 *
 *   - `<block-id>` — required positional (Monday's
 *     `delete_doc_block.block_id` is `String!`). Brand-validated
 *     via {@link DocBlockIdSchema} (opaque non-empty string).
 *
 * **Output envelope.** Direct unwrap of the
 * {@link documentBlockIdOnlySchema} shape — `data: { id }`. Envelope
 * is intentionally narrower than the create/update variants
 * because Monday's `delete_doc_block` wire only returns the id
 * (NOT the full pre-delete block); the agent contract doesn't
 * gain from speculatively rehydrating the block on the way out.
 * Mirrors M35 `doc delete`'s narrow `{doc_id, success: true}`
 * envelope-narrower-than-create rationale.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant:
 * minimal `{operation: "delete_doc_block", block_id}`. No
 * preflight read fires; the dry-run is purely argv-derived.
 * `meta.source: 'none'`. Mirrors `workspace delete` /
 * `team delete` / `doc delete` — destructive-no-read pattern is
 * uniform across destructive verbs.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past the
 * first call (Monday's `delete_doc_block` wire returns null
 * payload for already-deleted blocks; the fetcher rewraps to
 * `not_found` per the standard delete cadence). Same rationale
 * as `workspace delete` / `team delete` / `doc delete` — agents
 * can't safely retry without verifying the id still names the
 * same record.
 *
 * **Runtime body landed at v0.5-M36 IMPL.** Destructive gate fires
 * BEFORE `resolveClient` (M10 round-1 P2 invariant); dry-run path
 * emits minimal `{operation: "delete_doc_block", block_id}` (no wire
 * call); live path dispatches {@link deleteDocBlock} + projects via
 * `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocBlockIdSchema } from '../../types/ids.js';
import {
  deleteDocBlock,
  docBlockDeleteOutputSchema,
  type DocBlockDeleteOutput,
} from '../../api/documents.js';

const inputSchema = z.object({ blockId: DocBlockIdSchema }).strict();

export const docBlockDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocBlockDeleteOutput
> = {
  name: 'doc.block-delete',
  summary: 'Delete a rich-text block from a workdoc — --yes required',
  examples: [
    'monday doc block-delete blk_abc123 --yes',
    'monday doc block-delete blk_abc123 --dry-run',
    'monday doc block-delete blk_abc123 --yes --json',
  ],
  // Re-deleting an already-deleted block surfaces `not_found`;
  // re-running with the same `<block-id>` after an interim
  // `doc block-create` would target a different record (Monday
  // mints new block IDs on create). Mark non-idempotent.
  idempotent: false,
  inputSchema,
  outputSchema: docBlockDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc');
    noun
      .command('block-delete <blockId>')
      .description(docBlockDeleteCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...docBlockDeleteCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Destructive — Monday\'s wire offers no restore mutation for blocks; agents needing reversal must recreate via `monday doc block-create` (lossy: new id, new position).',
          '  - Envelope projects Monday\'s `DocumentBlockIdOnly` wire return to `{ id }` — narrower than create/update because Monday\'s delete endpoint doesn\'t echo block content.',
          '  - `--dry-run` emits the planned `delete_doc_block` operation + resolved input fields (no wire call fires; `meta.source: "none"`).',
          '',
        ].join('\n'),
      )
      .action(async (blockIdArg: unknown) => {
        const parsed = parseArgv(docBlockDeleteCommand.inputSchema, {
          blockId: blockIdArg,
        });

        // Gate BEFORE `resolveClient()` — M10 round-1 P2 invariant.
        // A missing `--yes` must surface as `confirmation_required`
        // per cli-design §3.1 #7's unconditional contract, never
        // masked by `config_error` when no token is configured.
        const preGateGlobalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags: preGateGlobalFlags,
          verb: 'doc block-delete',
          target: parsed.blockId,
          detailKey: 'block_id',
          action: 'delete the doc block',
          hint:
            'block-delete is destructive — Monday\'s wire surface offers ' +
            'no restore mutation for doc blocks; agents needing reversal ' +
            'must recreate via `monday doc block-create` (lossy: new id, ' +
            'new position; content must be re-supplied).',
        });

        if (preGateGlobalFlags.dryRun) {
          // Minimal dry-run shape — no preflight read fires. Mirrors
          // `doc delete` / `team delete` / `workspace delete` cadence.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              { operation: 'delete_doc_block', block_id: parsed.blockId },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await deleteDocBlock({
          client,
          blockId: parsed.blockId,
        });
        emitMutation({
          ctx,
          data: result.block,
          schema: docBlockDeleteCommand.outputSchema,
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
