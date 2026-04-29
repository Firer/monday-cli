/**
 * `monday cache stats` — aggregate counts/sizes/ages (`cli-design.md`
 * §8). Cheap diagnostics for an agent debugging a slow `--no-cache`
 * fallback.
 *
 * Idempotent: yes — pure read.
 */
import { z } from 'zod';
import { resolveCacheRoot, stats as readCacheStats } from '../../api/cache.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';

export const cacheStatsOutputSchema = z
  .object({
    root: z.string().min(1),
    exists: z.boolean(),
    entries: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    oldest_age_seconds: z.number().int().nonnegative().nullable(),
    newest_age_seconds: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type CacheStatsOutput = z.infer<typeof cacheStatsOutputSchema>;

const inputSchema = z.object({}).strict();

export const cacheStatsCommand: CommandModule<
  z.infer<typeof inputSchema>,
  CacheStatsOutput
> = {
  name: 'cache.stats',
  summary: 'Show cache totals and age',
  examples: ['monday cache stats', 'monday cache stats --json'],
  idempotent: true,
  inputSchema,
  outputSchema: cacheStatsOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'cache', 'Cache management commands');
    noun
      .command('stats')
      .description(cacheStatsCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...cacheStatsCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        cacheStatsCommand.inputSchema.parse(opts);
        const root = resolveCacheRoot({ env: ctx.env });
        const result = await readCacheStats(root, { now: ctx.clock });
        emitSuccess({
          ctx,
          data: {
            root: result.root,
            exists: result.exists,
            entries: result.entries,
            bytes: result.bytes,
            oldest_age_seconds: result.oldestAgeSeconds,
            newest_age_seconds: result.newestAgeSeconds,
          },
          schema: cacheStatsCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
