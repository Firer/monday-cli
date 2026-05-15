/**
 * `monday doc delete <doc-id> --yes [--dry-run]` — delete an
 * existing workdoc (`cli-design.md` §4.3 DOC section + §13 v0.5
 * entry; `v0.5-plan.md` §3 M35 + §8 D7-D9).
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2 + M10 round-1
 * P2 invariant). `--yes` is mandatory for the live path; without
 * `--yes` (and without `--dry-run`) the command fails fast with
 * `confirmation_required` (exit 1) carrying `details.doc_id`. The
 * gate fires BEFORE `resolveClient()` so a missing token doesn't
 * mask `confirmation_required` as `config_error` (same shape — and
 * same gate-before-resolve ordering — as M14 `workspace delete` /
 * M10 `item delete` / `update delete` / `team delete`).
 *
 * **Wire shape.** Single round-trip via `delete_doc(docId)` against
 * `mutation DeleteDoc` with `operationName: 'DeleteDoc'`
 * (R-NEW-37 W2 audit-point). Returns Monday's opaque `JSON` scalar
 * — the fetcher projects to the flat `{ doc_id: <echoed>,
 * success: true }` envelope per D9. A null `delete_doc` payload
 * surfaces `not_found` — same cadence as M14 `workspace delete`
 * + M34 `team delete` (id bogus or doc already deleted by a
 * concurrent caller).
 *
 * **camelCase wire-arg note.** `delete_doc` takes camelCase
 * `docId` on the wire (Finding 7) — see the canonical
 * asymmetry note at `src/api/documents.ts` module header (4th
 * supporting site for R-NEW-41).
 *
 * **Argv shape.**
 *
 *   - `<doc-id>` — required positional (Monday's
 *     `delete_doc.docId` is `ID!`). Brand-validated via
 *     {@link DocIdSchema}.
 *
 * **Output envelope.** Projected from Monday's opaque JSON return
 * per D9 — `data: { doc_id: <echoed>, success: true }`. Envelope
 * shape is intentionally narrower than M34 `team-delete`'s "full
 * deleted Team" projection: Monday's `delete_doc` doesn't return
 * the deleted Document (the wire return is opaque JSON), and the
 * agent contract doesn't gain from speculatively rehydrating the
 * doc on the way out.
 *
 * **Dry-run shape** per cli-design §6.4 mutation-dry-run variant:
 * minimal `{operation: "delete_doc", doc_id}`. No preflight read
 * fires; the dry-run is purely argv-derived. `meta.source: 'none'`.
 * Mirrors `workspace delete` / `team delete` — destructive-no-read
 * pattern is uniform across destructive verbs.
 *
 * **Idempotent: false.** Re-running surfaces `not_found` past the
 * first call. Same rationale as `workspace delete` / `team delete`
 * — agents can't safely retry without verifying the id still
 * names the same record.
 *
 * **Runtime body landed at v0.5-M35 IMPL.** Destructive gate fires
 * BEFORE `resolveClient` (M10 round-1 P2 invariant); dry-run path
 * emits minimal `{operation: "delete_doc", doc_id}` (no wire call);
 * live path dispatches {@link deleteDoc} + projects via
 * `emitMutation`.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import { enforceDestructiveGate } from '../../api/destructive-gate.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { DocIdSchema } from '../../types/ids.js';
import {
  deleteDoc,
  docDeleteOutputSchema,
  type DocDeleteOutput,
} from '../../api/documents.js';

const inputSchema = z.object({ docId: DocIdSchema }).strict();

export const docDeleteCommand: CommandModule<
  z.infer<typeof inputSchema>,
  DocDeleteOutput
> = {
  name: 'doc.delete',
  summary: 'Delete a workdoc — --yes required',
  examples: [
    'monday doc delete 12345678 --yes',
    'monday doc delete 12345678 --dry-run',
    'monday doc delete 12345678 --yes --json',
  ],
  // Re-deleting an already-deleted doc surfaces `not_found`;
  // re-running with the same `<doc-id>` after an interim
  // `doc create-in-workspace` would target a different record
  // (Monday mints new DocIds on create). Mark non-idempotent.
  idempotent: false,
  inputSchema,
  outputSchema: docDeleteOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'doc', 'Workdoc commands');
    noun
      .command('delete <docId>')
      .description(docDeleteCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...docDeleteCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (docId: unknown) => {
        const parsed = parseArgv(docDeleteCommand.inputSchema, { docId });

        // Gate BEFORE `resolveClient()` — M10 round-1 P2 invariant.
        // A missing `--yes` must surface as `confirmation_required`
        // per cli-design §3.1 #7's unconditional contract, never
        // masked by `config_error` when no token is configured.
        const preGateGlobalFlags = parseGlobalFlags(program.opts(), ctx.env);
        enforceDestructiveGate({
          globalFlags: preGateGlobalFlags,
          verb: 'doc delete',
          target: parsed.docId,
          detailKey: 'doc_id',
          action: 'delete the workdoc',
          hint:
            'delete is destructive — Monday\'s wire surface offers no ' +
            'restore mutation for workdocs; agents needing reversal must ' +
            'recreate via `monday doc create-in-workspace` / `create-on-' +
            'column` (lossy: new id, content must be re-imported).',
        });

        if (preGateGlobalFlags.dryRun) {
          // Minimal dry-run shape — no preflight read fires. Per
          // cli-design §6.4 mutation-dry-run variant: `operation:
          // "delete_doc"`, `doc_id`, nothing else. `meta.source:
          // 'none'` because no API call fires; live surfaces
          // `not_found` for missing ids on its own. Mirrors
          // workspace-delete + team-delete cadence.
          const { apiVersion } = resolveClient(ctx, program.opts());
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              { operation: 'delete_doc', doc_id: parsed.docId },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const { client, apiVersion } = resolveClient(ctx, program.opts());
        const result = await deleteDoc({ client, docId: parsed.docId });
        emitMutation({
          ctx,
          data: result.result,
          schema: docDeleteCommand.outputSchema,
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
