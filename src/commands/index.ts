import type { CommandModule } from './types.js';

/**
 * Static registry of every shipped CLI command (`v0.1-plan.md` §3 M1).
 *
 * Two consumers walk this list:
 *
 *  1. `cli/run.ts` — calls `attach(program, ctx)` on each module to
 *     wire commander.
 *  2. `commands/schema/index.ts` — emits `inputSchema` + `outputSchema`
 *     as JSON Schema 2020-12 so agents introspect the surface
 *     without `--help`-scraping.
 *
 * Commands are appended as milestones land (M1 ships `config.*`,
 * `cache.*`, `schema`; M2 adds `account.*`; M3 adds
 * `workspace`/`board`/`user`/`update`; etc.). Order is meaningful
 * only for `monday schema`'s default JSON output — the entries are
 * sorted lexicographically there, so registration order has no
 * user-visible effect.
 *
 * **Why a getter, not a `const` array.** `schemaCommand` lives in a
 * sibling module that itself imports `getCommandRegistry()` so it
 * can describe every other command. A literal `const commandRegistry
 * = […, schemaCommand]` constructs the array at module-evaluation
 * time, which — under ESM's circular-import semantics — can read
 * `schemaCommand` while the schema module is still mid-evaluation
 * and bake an `undefined` slot into the array. The function defers
 * construction until first call (always after every module has
 * finished loading), which makes the order of test imports
 * irrelevant.
 */
// M1 commands — local-only, no Monday API access.
import { configShowCommand } from './config/show.js';
import { configPathCommand } from './config/path.js';
import { cacheListCommand } from './cache/list.js';
import { cacheClearCommand } from './cache/clear.js';
import { cacheStatsCommand } from './cache/stats.js';
import { schemaCommand } from './schema/index.js';

let cached: readonly CommandModule[] | undefined;

export const getCommandRegistry = (): readonly CommandModule[] => {
  cached ??= [
    configShowCommand,
    configPathCommand,
    cacheListCommand,
    cacheClearCommand,
    cacheStatsCommand,
    schemaCommand,
  ];
  return cached;
};

export type { CommandModule } from './types.js';
export { ensureSubcommand } from './types.js';
