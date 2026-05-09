/**
 * `dateResolution` + `peopleResolution` + `tagResolution` builder,
 * shared by every mutation surface that calls into
 * `translateColumnValueAsync` / `planChanges` / `planCreate`.
 *
 * Each context closes over the shared `MondayClient` + `ctx.env` +
 * `globalFlags.noCache` (people / tag legs) and `ctx.clock` +
 * `MONDAY_TIMEZONE` (date leg). The builder is a pure function — no
 * caching, no memoisation; each call returns a fresh trio. v0.3 is
 * the natural home for `me`-token memoisation across translate calls
 * in one command run; lifting this builder gives that change a
 * single seam to extend.
 *
 * Lifted from four identical 12-line copies (`set.ts:327`,
 * `update.ts:450` single, `update.ts:1275` bulk, `create.ts:893`)
 * — see v0.2-plan §12 R24.
 *
 * **M19 widening.** Adds `tagResolution.resolveTags` (Commit 2) +
 * `relationResolution.validateItems` (Commit 3) closing over
 * `MondayClient` + `env` + `noCache`. The friendly `tags` /
 * `board_relation` / `dependency` translators consume them via the
 * matching `TranslateColumnValueAsyncInputs.*Resolution` slots.
 * `dependency` (Commit 4) reuses the same relation slot — the
 * validator's per-noun divergence is captured by the `context`
 * discriminant the translator passes through, NOT by a second
 * callback.
 */

import type { MondayClient } from './client.js';
import type { RunContext } from '../cli/run.js';
import type { GlobalFlags } from '../types/global-flags.js';
import type {
  DateResolutionContext,
  PeopleResolutionContext,
  RelationResolutionContext,
  TagResolutionContext,
} from './column-values.js';
import { resolveMeFactory } from './item-helpers.js';
import { userByEmail } from './resolvers.js';
import { resolveTags } from './tag-directory.js';
import { validateBoardRelationItems } from './board-relation-validation.js';

export interface BuildResolutionContextsInputs {
  readonly client: MondayClient;
  readonly ctx: RunContext;
  readonly globalFlags: GlobalFlags;
}

export interface ResolutionContexts {
  readonly dateResolution: DateResolutionContext;
  readonly peopleResolution: PeopleResolutionContext;
  readonly tagResolution: TagResolutionContext;
  readonly relationResolution: RelationResolutionContext;
}

export const buildResolutionContexts = (
  inputs: BuildResolutionContextsInputs,
): ResolutionContexts => {
  const { client, ctx, globalFlags } = inputs;
  const dateResolution: DateResolutionContext = {
    now: ctx.clock,
    ...(ctx.env.MONDAY_TIMEZONE === undefined
      ? {}
      : { timezone: ctx.env.MONDAY_TIMEZONE }),
  };
  const peopleResolution: PeopleResolutionContext = {
    resolveMe: resolveMeFactory(client),
    resolveEmail: async (email) => {
      const result = await userByEmail({
        client,
        email,
        env: ctx.env,
        noCache: globalFlags.noCache,
      });
      return result.user.id;
    },
  };
  const tagResolution: TagResolutionContext = {
    resolveTags: (input) =>
      resolveTags({
        client,
        input,
        env: ctx.env,
        noCache: globalFlags.noCache,
      }),
  };
  const relationResolution: RelationResolutionContext = {
    validateItems: ({ itemIds, allowedBoards, columnId, context }) =>
      validateBoardRelationItems({
        client,
        itemIds,
        allowedBoards,
        columnId,
        context,
        env: ctx.env,
        noCache: globalFlags.noCache,
      }),
  };
  return { dateResolution, peopleResolution, tagResolution, relationResolution };
};
