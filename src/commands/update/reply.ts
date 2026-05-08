/**
 * `monday update reply <uid> --body <md> | --body-file <path>` — post
 * a reply to an existing update (`cli-design.md` §4.3 line 686-693,
 * `v0.2-plan.md` §3 M13).
 *
 * Mutates via Monday's `create_update(parent_id, body)` — the same
 * mutation `update create` uses, with `parent_id: <uid>` substituted
 * for `item_id: <iid>`. Monday derives the item ID server-side from
 * the parent update.
 *
 * **Body sources** (mutually exclusive — same shape as `update
 * create`'s plumbing, lifted into `body-source.ts` per the v0.1-plan
 * §17 R-timing rule when the third consumer arrived):
 *   - `--body <md>` — inline markdown.
 *   - `--body-file <path>` — read from disk.
 *   - `--body-file -` — read from stdin.
 *
 * Idempotent: NO — re-running creates a duplicate reply. Same
 * idempotency caveat as `update create`; agents that want
 * idempotency dedupe by `update.body` via `monday update list`
 * first.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { readUpdateBody } from './body-source.js';
import {
  projectMutationUpdate,
  UPDATE_FIELDS_FRAGMENT,
  updateProjectionSchema,
} from '../../api/update-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';

const CREATE_REPLY_MUTATION = `
  mutation UpdateReply($parentId: ID!, $body: String!) {
    create_update(parent_id: $parentId, body: $body) {
      ${UPDATE_FIELDS_FRAGMENT}
    }
  }
`;

export const updateReplyOutputSchema = updateProjectionSchema
  .extend({ parent_id: UpdateIdSchema })
  .strict();

export type UpdateReplyOutput = z.infer<typeof updateReplyOutputSchema>;

const inputSchema = z
  .object({
    parentId: UpdateIdSchema,
    body: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_update: z.unknown(),
  })
  .loose();

export const updateReplyCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateReplyOutput
> = {
  name: 'update.reply',
  summary: 'Post a reply to an existing update (comment thread)',
  examples: [
    'monday update reply 77 --body "Acknowledged — looking now."',
    'monday update reply 77 --body-file ./reply.md',
    'cat reply.md | monday update reply 77 --body-file -',
    'monday update reply 77 --body "Quick ack" --dry-run --json',
  ],
  // Same non-idempotent rationale as `update create`: each call posts
  // a fresh reply; Monday has no idempotency-key surface on
  // create_update. Agents that need idempotency dedupe via
  // `monday update list <iid> --with-replies`.
  idempotent: false,
  inputSchema,
  outputSchema: updateReplyOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('reply <parentId>')
      .description(updateReplyCommand.summary)
      .option('--body <md>', 'inline markdown body (mutually exclusive with --body-file)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateReplyCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (parentId: unknown, opts: unknown) => {
        const parsed = parseArgv(updateReplyCommand.inputSchema, {
          parentId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const body = await readUpdateBody({
          inlineBody: parsed.body,
          bodyFile: globalFlags.bodyFile,
          stdin: ctx.stdin,
          verbHint:
            'monday update reply requires either --body <md> or ' +
            '--body-file <path>. Use --body-file - to read from stdin.',
        });

        if (globalFlags.dryRun) {
          // Dry-run shape per cli-design §6.4 update-reply variant:
          // operation `create_update` with `parent_id` (instead of
          // `item_id`) plus `body` + `body_length`. `meta.source:
          // 'none'` — no API call fires; the dry-run is purely
          // argv-derived.
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'create_update',
                parent_id: parsed.parentId,
                body,
                body_length: body.length,
              },
            ],
            source: 'none',
            cacheAgeSeconds: null,
            warnings: [],
            apiVersion,
          });
          return;
        }

        const response = await client.raw<unknown>(
          CREATE_REPLY_MUTATION,
          { parentId: parsed.parentId, body },
          { operationName: 'UpdateReply' },
        );
        // R42: distinguish missing-root-key (schema-drift →
        // internal_error) from null payload (per-record → not_found
        // via projectMutationUpdate). Must run BEFORE the parse.
        assertResponseFieldPresent({
          data: response.data,
          key: 'create_update',
          operationLabel: 'UpdateReply',
          details: { parent_id: parsed.parentId },
          nullHandling: 'caller_handles',
        });
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed UpdateReply response',
            details: { parent_id: parsed.parentId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        // Lift R37 (v0.2-plan §20): null-payload + strict-parse seam
        // shared with reply / edit / delete / toggle. `idKey: 'parent_id'`
        // because the argv input is the parent (not the new update);
        // the `parent_id` echo onto the success envelope stays at the
        // call site, mirroring `item duplicate`'s `duplicated_from_id`.
        const base = projectMutationUpdate({
          raw: data.create_update,
          updateId: parsed.parentId,
          mutationName: 'create_update',
          idKey: 'parent_id',
        });
        const projected: UpdateReplyOutput = {
          ...base,
          parent_id: UpdateIdSchema.parse(parsed.parentId),
        };

        emitMutation({
          ctx,
          data: projected,
          schema: updateReplyCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
