/**
 * `dateResolution` + `peopleResolution` builder, shared by every
 * mutation surface that calls into `translateColumnValueAsync` /
 * `planChanges` / `planCreate`.
 *
 * Both contexts close over `ctx.clock` + `ctx.env.MONDAY_TIMEZONE`
 * (date side) and `client` + `ctx.env` + `globalFlags.noCache`
 * (people side via `resolveMeFactory` + `userByEmail`). The
 * builder is a pure function — no caching, no memoisation; each
 * call returns a fresh pair. v0.3 is the natural home for `me`-token
 * memoisation across translate calls in one command run; lifting
 * this builder gives that change a single seam to extend.
 *
 * Lifted from four identical 12-line copies (`set.ts:327`,
 * `update.ts:450` single, `update.ts:1275` bulk, `create.ts:893`)
 * — see v0.2-plan §12 R24.
 */

import type { MondayClient } from './client.js';
import type { RunContext } from '../cli/run.js';
import type { GlobalFlags } from '../types/global-flags.js';
import type {
  DateResolutionContext,
  PeopleResolutionContext,
} from './column-values.js';
import { resolveMeFactory } from './item-helpers.js';
import { userByEmail } from './resolvers.js';

export interface BuildResolutionContextsInputs {
  readonly client: MondayClient;
  readonly ctx: RunContext;
  readonly globalFlags: GlobalFlags;
}

export interface ResolutionContexts {
  readonly dateResolution: DateResolutionContext;
  readonly peopleResolution: PeopleResolutionContext;
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
  return { dateResolution, peopleResolution };
};
