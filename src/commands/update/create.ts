/**
 * `monday update create <iid> --body <md> | --body-file <path>` —
 * post a comment on an item (`cli-design.md` §4.3 line 509,
 * `v0.1-plan.md` §3 M5b).
 *
 * Monday calls these "updates"; cli-design names them comments (the
 * agent-friendly term). Mutates via `create_update(item_id, body)`
 * — body is markdown that Monday renders to HTML for display.
 *
 * **Body sources** (mutually exclusive):
 *   - `--body <md>` — inline markdown.
 *   - `--body-file <path>` — read from disk (cli-design §10.1 +
 *     cli.md "Stdin"). `--body-file -` reads from stdin (the
 *     CLI's `ctx.stdin`), letting agents pipe `git log` /
 *     `cat` etc. into a comment.
 *
 * **`--dry-run` is supported** even though `create_update` is
 * non-idempotent (re-running creates a second comment). Agents
 * preview "would post comment to item X" before committing —
 * useful for templated comment workflows where the body is
 * computed and a sanity-check pass is cheap.
 *
 * Idempotent: NO — re-running creates a duplicate comment. Agents
 * that want idempotency should either dedupe by `update.body`
 * via `monday update list <iid>` first, or use a future
 * `update upsert` (deferred to v0.2).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema, UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { readUpdateBody } from './body-source.js';

const CREATE_UPDATE_MUTATION = `
  mutation UpdateCreate($itemId: ID!, $body: String!) {
    create_update(item_id: $itemId, body: $body) {
      id
      body
      text_body
      creator_id
      creator { id name email }
      item_id
      created_at
      updated_at
    }
  }
`;

const creatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  })
  .strict();

export const updateCreateOutputSchema = z
  .object({
    id: UpdateIdSchema,
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    creator: creatorSchema.nullable(),
    item_id: ItemIdSchema.nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
  })
  .strict();

export type UpdateCreateOutput = z.infer<typeof updateCreateOutputSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    body: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_update: z.unknown(),
  })
  .loose();

export const updateCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateCreateOutput
> = {
  name: 'update.create',
  summary: 'Post a comment (update) on an item',
  examples: [
    'monday update create 12345 --body "Done — moved to QA."',
    'monday update create 12345 --body-file ./post.md',
    'cat post.md | monday update create 12345 --body-file -',
    'monday update create 12345 --body "Quick note" --dry-run --json',
  ],
  // Comment creation is non-idempotent — re-running creates a
  // duplicate comment. Agents that want idempotency should
  // dedupe via `monday update list <iid>` first.
  idempotent: false,
  inputSchema,
  outputSchema: updateCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('create <itemId>')
      .description(updateCreateCommand.summary)
      .option('--body <md>', 'inline markdown body (mutually exclusive with --body-file)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateCreateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(updateCreateCommand.inputSchema, {
          itemId,
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
            'monday update create requires either --body <md> or ' +
            '--body-file <path>. Use --body-file - to read from stdin.',
        });

        if (globalFlags.dryRun) {
          // Dry-run shape for `update create` — `data: null`,
          // `meta.dry_run: true`, `planned_changes: [{...}]`. The
          // operation is `create_update`; the diff carries the
          // outgoing body so an agent can verify what would be
          // posted. Source is `'none'` because no API call fires
          // (Codex pass-1 minor: `'live'` would imply a network
          // round-trip; the dry-run is purely argv-derived).
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'create_update',
                item_id: parsed.itemId,
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
          CREATE_UPDATE_MUTATION,
          { itemId: parsed.itemId, body },
          { operationName: 'UpdateCreate' },
        );
        const data = unwrapOrThrow(
          responseSchema.safeParse(response.data),
          {
            context: 'Monday returned a malformed UpdateCreate response',
            details: { item_id: parsed.itemId },
            hint:
              'this is a data-integrity error in Monday\'s response; ' +
              'verify the response shape and update responseSchema if ' +
              'Monday\'s contract has changed.',
          },
        );
        const projected = projectCreatedUpdate(data.create_update, parsed.itemId);

        emitMutation({
          ctx,
          data: projected,
          schema: updateCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};

const projectCreatedUpdate = (raw: unknown, itemId: string): UpdateCreateOutput => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no update payload from create_update for item ${itemId}.`,
      { details: { item_id: itemId } },
    );
  }
  return unwrapOrThrow(
    updateCreateOutputSchema.safeParse(raw),
    {
      context: `Monday returned a malformed update payload for item ${itemId}`,
      details: { item_id: itemId },
    },
  );
};

