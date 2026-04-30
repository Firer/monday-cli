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
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema, UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';

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

/**
 * Reads the body content from one of the three accepted sources:
 *
 *   1. `--body <md>` (parsed.body) — inline.
 *   2. `--body-file <path>` (globalFlags.bodyFile) — from disk.
 *   3. `--body-file -` — from stdin (`ctx.stdin`).
 *
 * Throws `usage_error` for:
 *   - Both `--body` and `--body-file` set (mutually exclusive).
 *   - Neither set (no source).
 *   - `--body-file -` with no `ctx.stdin` available (programmer
 *     wiring bug; should not happen via the binary).
 *   - Empty result after read (Monday rejects empty body strings;
 *     surface up-front rather than wait for `validation_failed`).
 */
const readBody = async (
  inlineBody: string | undefined,
  bodyFile: string | undefined,
  stdin: NodeJS.ReadableStream | undefined,
): Promise<string> => {
  if (inlineBody !== undefined && bodyFile !== undefined) {
    throw new UsageError(
      '--body and --body-file are mutually exclusive; pick one.',
      { details: { has_inline_body: true, body_file: bodyFile } },
    );
  }
  if (inlineBody !== undefined) {
    if (inlineBody.length === 0) {
      throw new UsageError(
        '--body cannot be empty. Pass markdown content or use ' +
          '--body-file <path> to read from disk / stdin.',
      );
    }
    return inlineBody;
  }
  if (bodyFile === undefined) {
    throw new UsageError(
      'monday update create requires either --body <md> or ' +
        '--body-file <path>. Use --body-file - to read from stdin.',
    );
  }
  if (bodyFile === '-') {
    if (stdin === undefined) {
      throw new UsageError(
        '--body-file - requested stdin, but no stdin is wired into ' +
          'the runner. This is a programmer wiring bug.',
      );
    }
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks).toString('utf8').trimEnd();
    if (body.length === 0) {
      throw new UsageError(
        'stdin produced an empty body. Pipe non-empty content into ' +
          '--body-file - or pass --body <md> inline.',
        { details: { body_file: '-' } },
      );
    }
    return body;
  }
  // File on disk. UTF-8 always; binary content would corrupt the
  // markdown anyway. Trim trailing whitespace so a trailing newline
  // from `cat foo.md` doesn't surface as a literal `\n` in the
  // posted comment.
  const raw = await readFile(bodyFile, 'utf8').catch((err: unknown) => {
    throw new UsageError(
      `--body-file: failed to read ${JSON.stringify(bodyFile)} (${
        err instanceof Error ? err.message : String(err)
      }).`,
      {
        cause: err,
        details: { body_file: bodyFile },
      },
    );
  });
  const body = raw.trimEnd();
  if (body.length === 0) {
    throw new UsageError(
      `--body-file: ${JSON.stringify(bodyFile)} is empty (after trim). ` +
        `Monday rejects empty comment bodies.`,
      { details: { body_file: bodyFile } },
    );
  }
  return body;
};

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

        const body = await readBody(
          parsed.body,
          globalFlags.bodyFile,
          ctx.stdin,
        );

        if (globalFlags.dryRun) {
          // Dry-run shape for `update create` — `data: null`,
          // `meta.dry_run: true`, `planned_changes: [{...}]`. The
          // operation is `create_update`; the diff carries the
          // outgoing body so an agent can verify what would be
          // posted.
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
            source: 'live',
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

