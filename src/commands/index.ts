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
import { itemUpdateCommand } from './item/update.js';
import { updateCreateCommand } from './update/create.js';
// M13 (v0.2) — update mutations: reply / edit / delete / like /
// unlike / pin / unpin / clear-all.
import { updateReplyCommand } from './update/reply.js';
import { updateEditCommand } from './update/edit.js';
import { updateDeleteCommand } from './update/delete.js';
import { updateLikeCommand } from './update/like.js';
import { updateUnlikeCommand } from './update/unlike.js';
import { updatePinCommand } from './update/pin.js';
import { updateUnpinCommand } from './update/unpin.js';
import { updateClearAllCommand } from './update/clear-all.js';
// M9 (v0.2) — item create + subitem create.
import { itemCreateCommand } from './item/create.js';
// M10 (v0.2) — item lifecycle: archive + delete + duplicate.
import { itemArchiveCommand } from './item/archive.js';
import { itemDeleteCommand } from './item/delete.js';
import { itemDuplicateCommand } from './item/duplicate.js';
// M11 (v0.2) — item move (group + cross-board).
import { itemMoveCommand } from './item/move.js';
// M12 (v0.2) — item upsert (idempotency-cluster verb).
import { itemUpsertCommand } from './item/upsert.js';
// M14 (v0.2) — workspace lifecycle: create / update / delete /
// add-users / remove-users.
import { workspaceCreateCommand } from './workspace/create.js';
import { workspaceUpdateCommand } from './workspace/update.js';
import { workspaceDeleteCommand } from './workspace/delete.js';
import { workspaceAddUsersCommand } from './workspace/add-users.js';
import { workspaceRemoveUsersCommand } from './workspace/remove-users.js';
// M15 (v0.2) — board lifecycle: create / update / archive / delete /
// duplicate / add-users.
import { boardCreateCommand } from './board/create.js';
import { boardUpdateCommand } from './board/update.js';
import { boardArchiveCommand } from './board/archive.js';
import { boardDeleteCommand } from './board/delete.js';
import { boardDuplicateCommand } from './board/duplicate.js';
import { boardAddUsersCommand } from './board/add-users.js';
// M16 (v0.2) — board columns + eager-invalidation contract:
// column-create / column-update / column-delete.
import { boardColumnCreateCommand } from './board/column-create.js';
import { boardColumnUpdateCommand } from './board/column-update.js';
import { boardColumnDeleteCommand } from './board/column-delete.js';
// M17 (v0.2) — board groups: group-create / group-update /
// group-archive / group-duplicate / group-delete.
import { boardGroupCreateCommand } from './board/group-create.js';
import { boardGroupUpdateCommand } from './board/group-update.js';
import { boardGroupArchiveCommand } from './board/group-archive.js';
import { boardGroupDuplicateCommand } from './board/group-duplicate.js';
import { boardGroupDeleteCommand } from './board/group-delete.js';
// M6 commands — diagnostics + GraphQL escape hatch + agent-flow E2E.
import { rawCommand } from './raw/index.js';
import { boardDoctorCommand } from './board/doctor.js';

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
    workspaceCreateCommand,
    workspaceUpdateCommand,
    workspaceDeleteCommand,
    workspaceAddUsersCommand,
    workspaceRemoveUsersCommand,
    boardCreateCommand,
    boardUpdateCommand,
    boardArchiveCommand,
    boardDeleteCommand,
    boardDuplicateCommand,
    boardAddUsersCommand,
    boardColumnCreateCommand,
    boardColumnUpdateCommand,
    boardColumnDeleteCommand,
    boardGroupCreateCommand,
    boardGroupUpdateCommand,
    boardGroupArchiveCommand,
    boardGroupDuplicateCommand,
    boardGroupDeleteCommand,
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
    itemUpdateCommand,
    itemCreateCommand,
    itemArchiveCommand,
    itemDeleteCommand,
    itemDuplicateCommand,
    itemMoveCommand,
    itemUpsertCommand,
    updateCreateCommand,
    updateReplyCommand,
    updateEditCommand,
    updateDeleteCommand,
    updateLikeCommand,
    updateUnlikeCommand,
    updatePinCommand,
    updateUnpinCommand,
    updateClearAllCommand,
    rawCommand,
    boardDoctorCommand,
  ];
  return cached;
};

export type { CommandModule } from './types.js';
export { ensureSubcommand } from './types.js';
