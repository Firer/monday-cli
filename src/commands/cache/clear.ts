/**
 * `monday cache clear` — removes cache entries (`cli-design.md` §8).
 *
 *   monday cache clear                  → wipe everything
 *   monday cache clear --board <bid>    → drop one board's metadata
 *
 * Idempotent: yes — clearing an already-empty cache is a no-op
 * (reports zero removals rather than failing).
 *
 * Stays read-write-safe: the cache root is never traversed outside
 * `resolveCacheRoot()`'s output. `--board <bid>` is validated with
 * the safe-identifier regex inside `cacheKeyToRelativePath`, so a
 * caller-supplied `../etc/passwd` returns `cache_error` rather than
 * deleting anything outside the cache directory.
 */
import { z } from 'zod';
import { clearAll, clearEntry, resolveCacheRoot } from '../../api/cache.js';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { BoardIdSchema } from '../../types/ids.js';
import { UsageError } from '../../utils/errors.js';

export const cacheClearOutputSchema = z
  .object({
    root: z.string().min(1),
    scope: z.enum(['board', 'all']),
    board_id: z.string().nullable(),
    removed: z.number().int().nonnegative(),
    bytes_freed: z.number().int().nonnegative(),
  })
  .strict();

export type CacheClearOutput = z.infer<typeof cacheClearOutputSchema>;

const inputSchema = z
  .object({
    board: z.string().optional(),
  })
  .strict();

export const cacheClearCommand: CommandModule<
  z.infer<typeof inputSchema>,
  CacheClearOutput
> = {
  name: 'cache.clear',
  summary: 'Clear cached entries (all, or one board)',
  examples: [
    'monday cache clear',
    'monday cache clear --board 12345',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: cacheClearOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'cache', 'Cache management commands');
    noun
      .command('clear')
      .description(cacheClearCommand.summary)
      .option('--board <id>', 'clear only the named board\'s cache entry')
      .addHelpText(
        'after',
        ['', 'Examples:', ...cacheClearCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (opts: unknown) => {
        const parsed = cacheClearCommand.inputSchema.parse(opts);
        const root = resolveCacheRoot({ env: ctx.env });

        if (parsed.board === undefined) {
          const result = await clearAll(root);
          emitSuccess({
            ctx,
            data: {
              root,
              scope: 'all',
              board_id: null,
              removed: result.removed,
              bytes_freed: result.bytesFreed,
            },
            schema: cacheClearCommand.outputSchema,
            programOpts: program.opts(),
          });
          return;
        }

        // Validate the board id against the branded schema before
        // letting it cross into the cache layer; surfaces invalid
        // input as `usage_error` (exit 1), not `cache_error` (exit 2).
        const boardResult = BoardIdSchema.safeParse(parsed.board);
        if (!boardResult.success) {
          throw new UsageError(
            `--board must be a numeric board ID (got "${parsed.board}")`,
            {
              cause: boardResult.error,
              details: { issues: boardResult.error.issues },
            },
          );
        }
        const result = await clearEntry(root, {
          kind: 'board',
          boardId: boardResult.data,
        });
        emitSuccess({
          ctx,
          data: {
            root,
            scope: 'board',
            board_id: boardResult.data,
            removed: result.removed,
            bytes_freed: result.bytesFreed,
          },
          schema: cacheClearCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
