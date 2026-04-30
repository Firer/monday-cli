/**
 * `monday update get <uid>` — single update by ID
 * (`cli-design.md` §4.3).
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { runByIdLookup } from '../run-by-id-lookup.js';
import { UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';

const UPDATE_GET_QUERY = `
  query UpdateGet($ids: [ID!]) {
    updates(ids: $ids) {
      id
      body
      text_body
      creator_id
      creator {
        id
        name
        email
      }
      item_id
      created_at
      updated_at
      edited_at
      replies {
        id
        body
        text_body
        creator_id
        created_at
      }
    }
  }
`;

const replySchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .strict();

const creatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  })
  .strict();

export const updateGetOutputSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    creator: creatorSchema.nullable(),
    item_id: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    edited_at: z.string().nullable(),
    replies: z.array(replySchema.nullable()),
  })
  .strict();

export type UpdateGetOutput = z.infer<typeof updateGetOutputSchema>;

const inputSchema = z.object({ updateId: UpdateIdSchema }).strict();

export const updateGetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateGetOutput
> = {
  name: 'update.get',
  summary: 'Show one update (comment) by ID',
  examples: ['monday update get 77', 'monday update get 77 --json'],
  idempotent: true,
  inputSchema,
  outputSchema: updateGetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('get <updateId>')
      .description(updateGetCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateGetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (updateId: unknown) => {
        const parsed = parseArgv(updateGetCommand.inputSchema, { updateId });
        await runByIdLookup({
          ctx,
          programOpts: program.opts(),
          query: UPDATE_GET_QUERY,
          operationName: 'UpdateGet',
          collectionKey: 'updates',
          id: parsed.updateId,
          errorDetailKey: 'update_id',
          kind: 'update',
          schema: updateGetCommand.outputSchema,
        });
      });
  },
};
