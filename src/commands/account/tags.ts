/**
 * `monday account tags` — emits the per-account tag directory
 * (`cli-design.md` §4.3, M19 Commit 5).
 *
 * GraphQL operation(s) called (via the cache-aware loader):
 *   - `account { tags { id, name } }` (AccountTags) — fired on cache
 *     miss / expiry / `--no-cache`.
 *
 * Idempotent: yes — pure read.
 *
 * **Why this verb is M19-fold mandatory.** The `tag_not_found` error
 * (cli-design §6.5, registered at `4c652d5`) emits a default hint
 * pointing at `monday account tags` so an agent who hits an unknown
 * tag has a self-fulfilling next step. Without this verb the hint
 * would dangle. Codex round-1 P2-9 closed this question.
 *
 * The output schema mirrors the cache-on-disk shape — `tags: [{id,
 * name}]` plus a `total` count that's redundant with `tags.length`
 * but makes table rendering one-line and saves agents the count.
 * `meta.source` / `meta.cache_age_seconds` / `meta.complexity`
 * surface through the standard envelope so an agent can verify
 * cache health on a per-call basis.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { loadAccountTags } from '../../api/tag-directory.js';

const tagSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
  })
  .strict();

export const accountTagsOutputSchema = z
  .object({
    tags: z.array(tagSchema),
    total: z.number().int().nonnegative(),
  })
  .strict();

export type AccountTagsOutput = z.infer<typeof accountTagsOutputSchema>;

const inputSchema = z.object({}).strict();

export const accountTagsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  AccountTagsOutput
> = {
  name: 'account.tags',
  summary: 'List the per-account tag directory (cache-aware)',
  examples: [
    'monday account tags',
    'monday account tags --json',
    'monday account tags --no-cache',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: accountTagsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'account', 'Account commands');
    noun
      .command('tags')
      .description(accountTagsCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...accountTagsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        accountTagsCommand.inputSchema.parse(opts);
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );
        const result = await loadAccountTags({
          client,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        ctx.meta.setSource(result.source);
        emitSuccess({
          ctx,
          data: {
            tags: [...result.tags],
            total: result.tags.length,
          },
          schema: accountTagsCommand.outputSchema,
          programOpts: program.opts(),
          source: result.source,
          apiVersion,
          complexity: result.complexity,
          cacheAgeSeconds: result.cacheAgeSeconds,
        });
      });
  },
};
