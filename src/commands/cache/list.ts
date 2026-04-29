/**
 * `monday cache list` — emits every entry under the cache root
 * (`cli-design.md` §8). Single-resource shape for v0.1 so JSON
 * consumers can `data.entries.map(...)` and table consumers see one
 * row per file.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import {
  listEntries,
  resolveCacheRoot,
  type CacheEntryInfo,
} from '../../api/cache.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';

const entrySchema = z
  .object({
    path: z.string().min(1),
    relative_path: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    modified_at: z.iso.datetime({ offset: true }),
    age_seconds: z.number().int().nonnegative(),
    kind: z.enum(['boards', 'users', 'schema', 'other']),
    id: z.string().nullable(),
  })
  .strict();

export const cacheListOutputSchema = z
  .object({
    root: z.string().min(1),
    entries: z.array(entrySchema),
    total_entries: z.number().int().nonnegative(),
    total_bytes: z.number().int().nonnegative(),
  })
  .strict();

export type CacheListOutput = z.infer<typeof cacheListOutputSchema>;

export const formatEntry = (
  e: CacheEntryInfo,
): z.infer<typeof entrySchema> => ({
  path: e.path,
  relative_path: e.relativePath,
  size_bytes: e.sizeBytes,
  modified_at: e.modifiedAt,
  age_seconds: e.ageSeconds,
  kind: e.kind,
  id: e.id ?? null,
});

const inputSchema = z.object({}).strict();

export const cacheListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  CacheListOutput
> = {
  name: 'cache.list',
  summary: 'List cached entries (boards, users, schema)',
  examples: [
    'monday cache list',
    'monday cache list --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: cacheListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'cache', 'Cache management commands');
    noun
      .command('list')
      .description(cacheListCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...cacheListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        cacheListCommand.inputSchema.parse(opts);
        const root = resolveCacheRoot({ env: ctx.env });
        const entries = await listEntries(root, { now: ctx.clock });
        const formatted = entries.map(formatEntry);
        emitSuccess({
          ctx,
          data: {
            root,
            entries: formatted,
            total_entries: formatted.length,
            total_bytes: formatted.reduce((sum, e) => sum + e.size_bytes, 0),
          },
          schema: cacheListCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
