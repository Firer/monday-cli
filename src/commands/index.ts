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
// M19 Commit 5 (v0.3) — account.tags read verb. Closes the §6.5
// `tag_not_found.details.hint` forward-reference (4c652d5) by giving
// agents a self-fulfilling next step when a tag-name lookup misses.
import { accountTagsCommand } from './account/tags.js';
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
// M20 (v0.3) — item time-track start/stop (verb-shaped column-type
// extension per cli-design §5.2 carve-out 2). Documentation-only at
// v0.3: empirical probe (2026-05-10, API version 2026-01) confirmed
// Monday's public API does not currently support time_tracking
// column writes. The verbs ship with `usage_error` rejections so the
// CLI surface is stable when Monday eventually ships API support.
import { itemTimeTrackStartCommand } from './item/time-track/start.js';
import { itemTimeTrackStopCommand } from './item/time-track/stop.js';
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
// M21 (v0.3) — `monday auth login` + `auth logout`. Pre-flight at
// `5c07840`; runtime OAuth + credentials cache + cli-design §7.4.3
// redaction-runtime extension landed across Part 1 (`a4cb5b0`) +
// Part 2 (`e21c166`) per cli-design §7.3 / §7.4.
import { authLoginCommand } from './auth/login.js';
import { authLogoutCommand } from './auth/logout.js';
// M22 (v0.3) — `monday status` + `monday usage` diagnostics cluster.
// Pre-flight at `fbab6b0`; implementation at `3a1b465` lands the
// runtime probe matrix (DNS / TCP / TLS / auth / cache writability /
// redaction self-test / env-var pickup) + `platform_api.daily_*`
// projection per cli-design §11.5.
import { statusCommand } from './status.js';
import { usageCommand } from './usage.js';
// M23 (v0.3) — cross-board `monday item search` extension +
// `monday board favorites`. Pre-flight stub registers the verb
// shapes (mutual-exclusion at the item-search input schema, the
// favorites verb's argv-empty shape); implementation lands the
// runtime cross-board fan-out walker + the 2-stage favorites
// resolver per cli-design §13 v0.3 entries.
import { boardFavoritesCommand } from './board/favorites.js';
// M24 (v0.3) — `monday item history <iid>`. Per-item activity log
// + comment-thread merged chronologically. Two-source walker
// (`activity_logs(item_ids:)` filtered walker-side to
// `entity = 'pulse'` per Decision 2 closure `a1f3025` + `updates`
// + Reply fan-out + merge projector ordered by `created_at`)
// shipped at `d058172` with Codex impl review fix-ups at
// `5f10cda` (round 1) + `a024961` (round 2).
import { itemHistoryCommand } from './item/history.js';
// M29 (v0.4) — `monday item watch <iid>`. Polling-based event stream
// over the M24 `item-history-projection.ts` projector. Pre-flight stub
// only at this commit (cli-design §14.4 closure at `31713fb`; runtime
// body lands at M29 IMPL); stub registers the verb surface so the
// command count + agent introspection via `monday schema` reflect the
// shape without exposing the runtime to invocation.
import { itemWatchCommand } from './item/watch.js';
// M26 (v0.3) — `dev` namespace workflow shortcuts (cli-design §5.2
// carve-out 1; convention, not API per §2.7). Three-level depth:
// `dev sprint current`, `dev task done`, etc. Pre-flight stubs at
// this commit; runtime bodies + tests land at M26 IMPL.
import { devDiscoverCommand } from './dev/discover.js';
import { devConfigureCommand } from './dev/configure.js';
import { devDoctorCommand } from './dev/doctor.js';
import { devSprintCurrentCommand } from './dev/sprint/current.js';
import { devSprintListCommand } from './dev/sprint/list.js';
import { devSprintItemsCommand } from './dev/sprint/items.js';
import { devEpicListCommand } from './dev/epic/list.js';
import { devEpicItemsCommand } from './dev/epic/items.js';
import { devReleaseListCommand } from './dev/release/list.js';
import { devTaskListCommand } from './dev/task/list.js';
import { devTaskStartCommand } from './dev/task/start.js';
import { devTaskDoneCommand } from './dev/task/done.js';
import { devTaskBlockCommand } from './dev/task/block.js';
// M27 (v0.3) — `notification send` + `webhook list/create/delete`.
// Outbound writes — bundled because both are write-only, low surface
// (cli-design §4.3 + §13 v0.3 entry). Runtime bodies + integration
// tests shipped at M27 IMPL `9cb6a74` (+ 4 Codex rounds). The
// `WebhookEventType` argv validation closed Decision 9 against
// Monday's 21-value wire enum (empirical probe
// `scripts/probe/m27-create-webhook-input.ts`, 2026-05-12, API
// `2026-01`).
import { webhookListCommand } from './webhook/list.js';
import { webhookCreateCommand } from './webhook/create.js';
import { webhookDeleteCommand } from './webhook/delete.js';
import { notificationSendCommand } from './notification/send.js';
// M31 (v0.4) — asset upload (`item upload` / `update upload`). Two
// new write verbs crossing the wire via multipart/form-data (NOT
// the JSON-only `client.request` seam). Shipped end-to-end at
// v0.4-M31 (cli-design §4.3 + §6.4 asset-upload sub-section + §13
// v0.4 entry; v0.4-plan §3 M31 + §13 post-mortem). First v0.4
// transport extension; fired R-NEW-41 3rd consumer
// (`docs/architecture.md` "Wire-vs-CLI semantics documentation
// conventions" section).
import { itemUploadCommand } from './item/upload.js';
import { updateUploadCommand } from './update/upload.js';
// M32 (v0.4) — workdocs read surface (`doc list` / `doc get`).
// Read-only at v0.4 per cli-design §13 v0.4 entry; full docs CRUD
// deferred to v0.5. Pre-flight stubs at this commit (argv schema +
// wire query documents only); runtime bodies + integration tests
// land at M32 IMPL. Empirical probe at `scripts/probe/m32-docs.ts`
// (2026-05-14, API `2026-01`) pinned `Query.docs(...)` signature +
// the 14-field `Document` projection + the 9-field `DocumentBlock`
// shape + the `DocsOrderBy` 2-value enum.
import { docListCommand } from './doc/list.js';
import { docGetCommand } from './doc/get.js';
// M34 (v0.5) — team writer surface (`user team-list` / `team-get` /
// `team-create` / `team-delete` / `team-add-members` /
// `team-remove-members`). 6 new verbs under the existing `user`
// namespace; first v0.5 milestone. Pre-flight stubs at this commit
// (argv schema + wire query/mutation documents only); runtime bodies
// + integration tests land at M34 IMPL. Empirical probe at
// `scripts/probe/v0.5-team-mutations.ts` (2026-05-15, API `2026-01`)
// pinned Monday's `Query.teams` signature + the 6-field `Team`
// projection + the `CreateTeamAttributesInput` 4-field input + the
// `ChangeTeamMembershipsResult` partial-success wire envelope. No
// `update_team` mutation exists (D1 drop --description; D2 no
// team-update verb); 6 tangential team-shaped mutations
// (assign_team_owners + add_teams_to_board etc.) deferred to v0.5.x
// per D4 closure.
import { teamListCommand } from './user/team-list.js';
import { teamGetCommand } from './user/team-get.js';
import { teamCreateCommand } from './user/team-create.js';
import { teamDeleteCommand } from './user/team-delete.js';
import { teamAddMembersCommand } from './user/team-add-members.js';
import { teamRemoveMembersCommand } from './user/team-remove-members.js';
// M33 (v0.4) — `monday completion <bash|zsh|fish>`. Shell-completion
// script emitter; first non-envelope stdout surface in the CLI
// (cli-design §3.1 raw-bytes carve-out). Empirical-probe finding at
// M33 pre-flight (`grep -rn 'completion\|complete' node_modules/
// commander/lib/ node_modules/commander/typings/` 2026-05-14, commander
// 14.0.3) returned zero hits — commander has no built-in completion
// machinery, so the verb hand-rolls per-shell templates at runtime (no
// runtime dep added). Shipped end-to-end at v0.4-M33 IMPL: argv schema
// + commander wiring + `--json` envelope schema + the three-mode
// format-aware action body + three per-shell template builders that
// walk `program.commands` at emit time so completions stay in sync
// with the registry.
import { completionCommand } from './completion.js';
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
    accountTagsCommand,
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
    boardFavoritesCommand,
    userListCommand,
    userGetCommand,
    userMeCommand,
    teamListCommand,
    teamGetCommand,
    teamCreateCommand,
    teamDeleteCommand,
    teamAddMembersCommand,
    teamRemoveMembersCommand,
    updateListCommand,
    updateGetCommand,
    itemGetCommand,
    itemListCommand,
    itemFindCommand,
    itemSearchCommand,
    itemSubitemsCommand,
    itemHistoryCommand,
    itemWatchCommand,
    itemSetCommand,
    itemClearCommand,
    itemUpdateCommand,
    itemCreateCommand,
    itemArchiveCommand,
    itemDeleteCommand,
    itemDuplicateCommand,
    itemMoveCommand,
    itemUpsertCommand,
    itemTimeTrackStartCommand,
    itemTimeTrackStopCommand,
    updateCreateCommand,
    updateReplyCommand,
    updateEditCommand,
    updateDeleteCommand,
    updateLikeCommand,
    updateUnlikeCommand,
    updatePinCommand,
    updateUnpinCommand,
    updateClearAllCommand,
    authLoginCommand,
    authLogoutCommand,
    statusCommand,
    usageCommand,
    devDiscoverCommand,
    devConfigureCommand,
    devDoctorCommand,
    devSprintCurrentCommand,
    devSprintListCommand,
    devSprintItemsCommand,
    devEpicListCommand,
    devEpicItemsCommand,
    devReleaseListCommand,
    devTaskListCommand,
    devTaskStartCommand,
    devTaskDoneCommand,
    devTaskBlockCommand,
    webhookListCommand,
    webhookCreateCommand,
    webhookDeleteCommand,
    notificationSendCommand,
    itemUploadCommand,
    updateUploadCommand,
    docListCommand,
    docGetCommand,
    completionCommand,
    rawCommand,
    boardDoctorCommand,
  ];
  return cached;
};

export type { CommandModule } from './types.js';
export { ensureSubcommand } from './types.js';
