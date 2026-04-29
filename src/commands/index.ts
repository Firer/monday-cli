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
 */
// M1 commands — local-only, no Monday API access.
import { configShowCommand } from './config/show.js';
import { configPathCommand } from './config/path.js';

export const commandRegistry: readonly CommandModule[] = [
  configShowCommand,
  configPathCommand,
];

export type { CommandModule } from './types.js';
export { ensureSubcommand } from './types.js';
