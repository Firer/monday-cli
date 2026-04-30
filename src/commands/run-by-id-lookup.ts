/**
 * Shared get-by-id action helper (R7, surfaced post-M3 in
 * `v0.1-plan.md` §15).
 *
 * Six v0.1 commands share a near-identical action shape:
 *
 *   1. `parseArgv` against the per-command input schema (positional
 *      ID arg).
 *   2. `resolveClient(ctx, program.opts())`.
 *   3. `client.raw<{ <plural>: unknown[] | null }>(QUERY, {ids:[id]},
 *      {operationName})`.
 *   4. Extract `first = data.<plural>?.[0]` and raise `not_found` if
 *      undefined / null.
 *   5. Project (`schema.parse(first)` or a custom projector — `item
 *      get` injects the column-value projection here).
 *   6. `emitSuccess({...toEmit(response)})`.
 *
 * The helper compresses steps 2-6 so each command's action body is
 * `parseArgv → runByIdLookup`. Per the trigger in §15, M4's
 * `item get` was the 6th example — the helper's project-callback
 * shape was the only design knob `item get` exercised that the M3
 * five didn't. Item get fits cleanly via the optional `project`
 * callback; the other five commands omit it (defaulting to
 * `schema.parse`).
 *
 * Scoped narrowly to the get-by-id sub-shape; list / find /
 * describe / page-walking commands stay explicit. The broader
 * `defineNetworkCommand` factory (M2.5 R4) remains deferred — R7's
 * narrower scope is the genuinely-identical cluster, and the wider
 * factory would freeze the wrong abstraction at this milestone.
 */

import type { z } from 'zod';
import type { RunContext } from '../cli/run.js';
import { ApiError } from '../utils/errors.js';
import { resolveClient } from '../api/resolve-client.js';
import { emitSuccess } from './emit.js';

export interface RunByIdLookupInputs<O> {
  readonly ctx: RunContext;
  /** `program.opts()` from the commander action body. */
  readonly programOpts: unknown;
  readonly query: string;
  readonly operationName: string;
  /**
   * Plural collection name in Monday's response shape:
   * `'workspaces'`, `'boards'`, `'users'`, `'updates'`, `'items'`.
   * Picked by string-key rather than a typed projector to keep the
   * helper untyped on the response field — the per-command schema
   * already validates the element shape.
   */
  readonly collectionKey: string;
  /** The branded ID to send in `ids: [<id>]`. */
  readonly id: string;
  /**
   * snake_case detail key on the `not_found` envelope's `details`,
   * matching the resource (`workspace_id`, `item_id`, etc.).
   * Documented per command in `cli-design.md` §6.5.
   */
  readonly errorDetailKey: string;
  /**
   * Singular kind name used in the `not_found` message
   * (`workspace`, `item`, …). Stylistic — agents key off `code`,
   * but humans read the message.
   */
  readonly kind: string;
  readonly schema: z.ZodType<O>;
  /**
   * Optional projector. Defaults to `schema.parse`. `item get` wires
   * this to a parse-then-project step — the raw GraphQL element
   * goes through `rawItemSchema.parse` first, then `projectItem` to
   * derive the §6.2 typed column shape.
   */
  readonly project?: (raw: unknown) => O;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const runByIdLookup = async <O>(
  inputs: RunByIdLookupInputs<O>,
): Promise<void> => {
  const { client, toEmit } = resolveClient(inputs.ctx, inputs.programOpts);
  const response = await client.raw<unknown>(
    inputs.query,
    { ids: [inputs.id] },
    { operationName: inputs.operationName },
  );
  const data = response.data;
  // The response shape is `{ <plural>: unknown[] | null }`; we read
  // structurally so the helper can serve every command without a
  // separately-typed RawXxx interface per noun.
  const collection = isObject(data) ? data[inputs.collectionKey] : null;
  const first: unknown = Array.isArray(collection) ? collection[0] : undefined;
  if (first === undefined || first === null) {
    throw new ApiError(
      'not_found',
      `Monday returned no ${inputs.kind} for id ${inputs.id}`,
      { details: { [inputs.errorDetailKey]: inputs.id } },
    );
  }
  const project =
    inputs.project ?? ((raw: unknown): O => inputs.schema.parse(raw));
  const projected = project(first);
  emitSuccess({
    ctx: inputs.ctx,
    data: projected,
    schema: inputs.schema,
    programOpts: inputs.programOpts,
    ...toEmit(response),
  });
};
