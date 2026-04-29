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

/**
 * Numeric-string board id at the input boundary. The runtime layer
 * additionally brands the value via `BoardIdSchema` before it crosses
 * into the cache primitives; the schema here mirrors the runtime so
 * `monday schema cache.clear` reports the actual accepted shape and
 * agents don't get told `{ board: "../etc" }` is valid.
 *
 * Codex review §1 caught the original drift: the input declared
 * `board?: string` (any non-empty string) while the runtime narrowed
 * to a numeric regex. The lesson is the same as M0 review §4–§6 —
 * the executable input schema must match the real boundary.
 */
const boardArgSchema = z
  .string()
  .regex(/^\d+$/u, { message: 'expected a numeric board ID' });

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
    board: boardArgSchema.optional(),
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
        const result = cacheClearCommand.inputSchema.safeParse(opts);
        if (!result.success) {
          throw new UsageError(
            `invalid --board: ${result.error.issues.map((i) => i.message).join('; ')}`,
            { cause: result.error, details: { issues: result.error.issues } },
          );
        }
        const parsed = result.data;
        const root = resolveCacheRoot({ env: ctx.env });

        if (parsed.board === undefined) {
          const cleared = await clearAll(root);
          emitSuccess({
            ctx,
            data: {
              root,
              scope: 'all',
              board_id: null,
              removed: cleared.removed,
              bytes_freed: cleared.bytesFreed,
            },
            schema: cacheClearCommand.outputSchema,
            programOpts: program.opts(),
          });
          return;
        }

        // Brand the validated string at the boundary so cache-layer
        // callers receive a `BoardId`, not a plain string.
        const boardId = BoardIdSchema.parse(parsed.board);
        const cleared = await clearEntry(root, {
          kind: 'board',
          boardId,
        });
        emitSuccess({
          ctx,
          data: {
            root,
            scope: 'board',
            board_id: boardId,
            removed: cleared.removed,
            bytes_freed: cleared.bytesFreed,
          },
          schema: cacheClearCommand.outputSchema,
          programOpts: program.opts(),
        });
      });
  },
};
