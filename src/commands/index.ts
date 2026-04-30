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
// M2 commands — first network surface (`v0.1-plan.md` §3 M2).
import { accountWhoamiCommand } from './account/whoami.js';
import { accountInfoCommand } from './account/info.js';
import { accountVersionCommand } from './account/version.js';
import { accountComplexityCommand } from './account/complexity.js';
// M3 commands — workspace + board (incl. describe core) + user + update reads.
import { workspaceListCommand } from './workspace/list.js';
import { workspaceGetCommand } from './workspace/get.js';
import { workspaceFoldersCommand } from './workspace/folders.js';
import { boardListCommand } from './board/list.js';
import { boardGetCommand } from './board/get.js';
import { boardFindCommand } from './board/find.js';
import { boardDescribeCommand } from './board/describe.js';
import { boardSubscribersCommand } from './board/subscribers.js';
import { boardColumnsCommand } from './board/columns.js';
import { boardGroupsCommand } from './board/groups.js';
import { userListCommand } from './user/list.js';
import { userGetCommand } from './user/get.js';
import { userMeCommand } from './user/me.js';
import { updateListCommand } from './update/list.js';
import { updateGetCommand } from './update/get.js';
// M4 commands — item reads + filter DSL + cursor pagination.
import { itemGetCommand } from './item/get.js';
import { itemListCommand } from './item/list.js';
import { itemFindCommand } from './item/find.js';
import { itemSearchCommand } from './item/search.js';
import { itemSubitemsCommand } from './item/subitems.js';
// M5b commands — item mutations + update create.
import { itemSetCommand } from './item/set.js';
import { itemClearCommand } from './item/clear.js';

let cached: readonly CommandModule[] | undefined;

export const getCommandRegistry = (): readonly CommandModule[] => {
  cached ??= [
    configShowCommand,
    configPathCommand,
    cacheListCommand,
    cacheClearCommand,
    cacheStatsCommand,
    schemaCommand,
    accountWhoamiCommand,
    accountInfoCommand,
    accountVersionCommand,
    accountComplexityCommand,
    workspaceListCommand,
    workspaceGetCommand,
    workspaceFoldersCommand,
    boardListCommand,
    boardGetCommand,
    boardFindCommand,
    boardDescribeCommand,
    boardSubscribersCommand,
    boardColumnsCommand,
    boardGroupsCommand,
    userListCommand,
    userGetCommand,
    userMeCommand,
    updateListCommand,
    updateGetCommand,
    itemGetCommand,
    itemListCommand,
    itemFindCommand,
    itemSearchCommand,
    itemSubitemsCommand,
    itemSetCommand,
    itemClearCommand,
  ];
  return cached;
};

export type { CommandModule } from './types.js';
export { ensureSubcommand } from './types.js';
