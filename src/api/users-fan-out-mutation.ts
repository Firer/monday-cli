/**
 * Resolver-fronted partial-success fan-out for the `--users <list>`
 * family — three M14 / M15 verbs share ~250 LOC of action body
 * (`v0.2-plan.md` §22 R40 lift).
 *
 * **Used by:**
 *   - `commands/workspace/add-users.ts` → `add_users_to_workspace`
 *   - `commands/workspace/remove-users.ts` → `delete_users_from_workspace`
 *   - `commands/board/add-users.ts` → `add_users_to_board`
 *
 * **What's lifted.** The token parser (`parseUsersArg`), the
 * resolver loop (`resolveTokens`), the per-target dispatch loop
 * (`dispatchSequential` callback wrapping
 * `assertResponseFieldPresent`), the dry-run path, the live-path
 * envelope assembly, and the partial-success / whole-call boundary
 * all live here. Each call site collapses from ~200 LOC of action
 * body to a single `await dispatchUsersFanOut({...})` call plus the
 * surrounding `parseArgv` + `parseUsersArg` + `resolveClient`
 * plumbing the caller already needs for error-precedence reasons
 * (a malformed `--users` must surface as `usage_error` BEFORE
 * `resolveClient`'s missing-token check fires its `config_error`).
 *
 * **Per-verb divergence — six parameters:**
 *   - `mutation.{query, operationName, rootKey}` — the GraphQL
 *     string, the PascalCase operationName for `client.raw`, and
 *     the snake_case mutation root field.
 *   - `dataOperation` — the literal echoed in `data.operation`
 *     (matches `mutation.rootKey` in the M14 / M15 family but
 *     stays a separate parameter for forward-compat).
 *   - `scope.{id, key, variableKey}` — `'workspace_id'` /
 *     `'board_id'` / actual id / `'workspaceId'` / `'boardId'`.
 *   - `verbDescription` — for the whole-call `user_not_found`
 *     message (`'workspace add-users'` etc.).
 *
 * Everything else is identical: the partial-success envelope,
 * `meta.source` aggregation rule (cli-design §6.4 — dry-run only
 * sees resolver legs; live folds in dispatch legs), the per-record
 * `{user_id, ok, error?}` shape, and the whole-call boundary
 * (`user_not_found` exit 2 when no dispatchable id remains).
 *
 * **Why the caller pre-parses tokens via `parseUsersArg` first.**
 * The original three call sites enforce a `parseArgv` →
 * `parseUsersArg` → `resolveClient` order so a malformed `--users`
 * token surfaces as `usage_error` (exit 1) BEFORE `resolveClient`'s
 * missing-token check fires `config_error` (exit 3). The helper
 * preserves that precedence by taking already-parsed tokens — the
 * caller runs `parseArgv` then `parseUsersArg` (both pure, both
 * throw `UsageError` on bad input) then `resolveClient`, then this
 * helper. Mirrors M5b's pattern: argv-shape validation runs first,
 * then config validation, then network.
 *
 * **`internal_error` re-throw escape hatch.** `dispatchSequential`
 * re-throws `internal_error` (M14 round-2 F1 / round-3 F1) so
 * schema-drift in the response surfaces as whole-call rather than
 * per-record. This helper inherits that behaviour by calling
 * `assertResponseFieldPresent` (R41 helper) inside the dispatch
 * callback — missing-root-key throws `internal_error` (re-thrown
 * by `dispatchSequential`), null-value throws `not_found` (lands
 * in `results[i].error`).
 */

import { z } from 'zod';
import { ApiError, UsageError } from '../utils/errors.js';
import { unwrapOrThrow } from '../utils/parse-boundary.js';
import { dispatchSequential } from './partial-success-mutation.js';
import { assertResponseFieldPresent } from './response-root.js';
import { SourceAggregator } from './source-aggregator.js';
import { userByEmail } from './resolvers.js';
import type { MondayClient, MondayResponse } from './client.js';
import type { DataSource } from '../utils/output/envelope.js';
import type { RunContext } from '../cli/run.js';
import type { GlobalFlags } from '../types/global-flags.js';
import type { EmitFromNetworkResult } from './resolve-client.js';
import { emitDryRun, emitMutation } from '../commands/emit.js';

// `--users` token validation. Numeric matches the same regex the
// branded `UserId` schema uses (`/^\d+$/`); email is a deliberately
// permissive shape (presence of `@` after a non-empty local-part —
// Monday's `users(emails:)` will reject anything malformed at the
// directory level, and we only need to distinguish "lookup this"
// from "send this id verbatim").
const NUMERIC_TOKEN_PATTERN = /^\d+$/u;
const EMAIL_TOKEN_PATTERN = /^[^@\s]+@[^@\s]+$/u;

export interface UsersFanOutToken {
  readonly raw: string;
  readonly kind: 'numeric' | 'email';
}

export interface UsersFanOutResultRecord {
  /** Branded numeric Monday user id when resolution succeeded; the
   * input token verbatim (numeric string OR email) when it failed.
   * Always non-empty. */
  readonly user_id: string;
  readonly ok: boolean;
  // `| undefined` aligns with the per-verb output schema's
  // `errorShape.optional()` inferred type under
  // exactOptionalPropertyTypes — zod's optional() emits
  // `error?: T | undefined`, which the helper must accept verbatim
  // for the schema-to-helper assignability check to clear.
  readonly error?:
    | { readonly code: string; readonly message: string }
    | undefined;
}

export interface UsersFanOutEnvelope<Op extends string = string> {
  readonly operation: Op;
  readonly results: readonly UsersFanOutResultRecord[];
}

/**
 * Parses a comma-separated `--users` argument into typed tokens.
 * Throws `UsageError` (exit 1) on malformed input — the caller
 * runs this BEFORE `resolveClient` so a malformed `--users`
 * surfaces ahead of `config_error` (see file-comment rationale).
 */
export const parseUsersArg = (raw: string): readonly UsersFanOutToken[] => {
  const split = raw.split(',').map((t) => t.trim());
  const malformed: string[] = [];
  const tokens: UsersFanOutToken[] = [];
  for (const token of split) {
    if (token.length === 0) {
      malformed.push(token);
      continue;
    }
    if (NUMERIC_TOKEN_PATTERN.test(token)) {
      tokens.push({ raw: token, kind: 'numeric' });
      continue;
    }
    if (EMAIL_TOKEN_PATTERN.test(token)) {
      tokens.push({ raw: token, kind: 'email' });
      continue;
    }
    malformed.push(token);
  }
  if (malformed.length > 0) {
    throw new UsageError(
      `--users contains malformed tokens: ${malformed.map((t) => JSON.stringify(t)).join(', ')}. Each token must be a numeric Monday user id or an email.`,
      { details: { malformed_tokens: malformed } },
    );
  }
  // Defensive: unreachable in practice. Per-command
  // `inputSchema.users.min(1)` rejects empty `--users` strings,
  // and any all-empty split (e.g. ",,,") fills `malformed[]`
  // first which throws above.
  /* c8 ignore next 3 */
  if (tokens.length === 0) {
    throw new UsageError('--users must contain at least one numeric id or email');
  }
  return tokens;
};

interface ResolutionOutcome {
  readonly records: readonly UsersFanOutResultRecord[];
  /** IDs the live dispatch loop should fire against (resolved,
   * `ok: true` records). Order matches the input `--users` order
   * with failed-resolution records skipped. */
  readonly dispatchableIds: readonly string[];
  /** Mapping from a dispatchable id back to the original record
   * index, so the live dispatch's per-target outcome can update
   * the right slot. */
  readonly dispatchableIndices: readonly number[];
  /** Tokens that failed lookup. Used for the whole-call
   * `details.failed_tokens` echo when no dispatchable id remains. */
  readonly failedTokens: readonly string[];
  /** `meta.source` aggregator over resolver legs only. Live path
   * folds dispatch legs into this externally. */
  readonly resolverAggregator: SourceAggregator;
  /** Whether any resolver leg fired (numeric-only paths fire none —
   * the aggregator stays empty and `meta.source` reads `'none'`
   * for dry-run). */
  readonly anyResolverLegFired: boolean;
}

const resolveTokens = async (
  client: MondayClient,
  tokens: readonly UsersFanOutToken[],
  env: NodeJS.ProcessEnv,
  noCache: boolean,
): Promise<ResolutionOutcome> => {
  const records: UsersFanOutResultRecord[] = [];
  const dispatchableIds: string[] = [];
  const dispatchableIndices: number[] = [];
  const failedTokens: string[] = [];
  const aggregator = new SourceAggregator();
  let anyResolverLegFired = false;
  for (const token of tokens) {
    if (token.kind === 'numeric') {
      const idx = records.length;
      records.push({ user_id: token.raw, ok: true });
      dispatchableIds.push(token.raw);
      dispatchableIndices.push(idx);
      continue;
    }
    // Email — flows through userByEmail. Catch resolution failure
    // per-token rather than aborting (partial-success contract).
    try {
      const resolved = await userByEmail({
        client,
        email: token.raw,
        env,
        noCache,
      });
      anyResolverLegFired = true;
      aggregator.record(resolved.source, resolved.cacheAgeSeconds);
      const idx = records.length;
      records.push({ user_id: resolved.user.id, ok: true });
      dispatchableIds.push(resolved.user.id);
      dispatchableIndices.push(idx);
    } catch (err: unknown) {
      anyResolverLegFired = true;
      // userByEmail records the live `users(emails:)` lookup as
      // 'live' — we lost the source signal in the throw path, but
      // a resolver leg DID fire, so reflect it in the aggregate.
      aggregator.record('live', null);
      if (err instanceof ApiError && err.code === 'user_not_found') {
        records.push({
          user_id: token.raw,
          ok: false,
          error: { code: err.code, message: err.message },
        });
        failedTokens.push(token.raw);
        continue;
      }
      // Non-`user_not_found` ApiError (e.g. `internal_error` on a
      // malformed Monday response) is a whole-call failure that
      // shouldn't be swallowed into a per-record slot — re-throw.
      /* c8 ignore next */
      throw err;
    }
  }
  return {
    records,
    dispatchableIds,
    dispatchableIndices,
    failedTokens,
    resolverAggregator: aggregator,
    anyResolverLegFired,
  };
};

// Schema for the wire response shape. Keys aren't required at the
// schema level — `assertResponseFieldPresent` enforces the per-verb
// `mutation.rootKey` check downstream. Equivalent at runtime to the
// per-verb `z.object({ <rootKey>: z.unknown() }).loose()` shape each
// pre-lift call site used (zod treats `z.unknown()` keys as
// runtime-optional, so both schemas accept the same inputs).
const wireResponseSchema = z.object({}).loose();

export interface UsersFanOutScope {
  readonly id: string;
  readonly key: 'workspace_id' | 'board_id';
  readonly variableKey: 'workspaceId' | 'boardId';
}

export interface UsersFanOutMutation {
  readonly query: string;
  readonly operationName: string;
  readonly rootKey: string;
}

export interface DispatchUsersFanOutInputs<
  Output extends UsersFanOutEnvelope<Op>,
  Op extends string = Output['operation'],
> {
  readonly client: MondayClient;
  readonly ctx: RunContext;
  readonly programOpts: unknown;
  readonly globalFlags: GlobalFlags;
  readonly apiVersion: string;
  readonly toEmit: <T>(response: MondayResponse<T>) => EmitFromNetworkResult;
  readonly tokens: readonly UsersFanOutToken[];
  readonly scope: UsersFanOutScope;
  readonly mutation: UsersFanOutMutation;
  readonly dataOperation: Op;
  readonly verbDescription: string;
  readonly outputSchema: z.ZodType<Output>;
}

/**
 * Drives the resolver → dispatch → emit pipeline shared by the
 * three `--users <list>` partial-success verbs. Returns void —
 * the helper owns emit (both dry-run and live envelopes) so the
 * call site collapses to argv-parse + scope/mutation config + this
 * call.
 */
export const dispatchUsersFanOut = async <
  Output extends UsersFanOutEnvelope<Op>,
  Op extends string = Output['operation'],
>(
  inputs: DispatchUsersFanOutInputs<Output, Op>,
): Promise<void> => {
  const {
    client,
    ctx,
    programOpts,
    globalFlags,
    apiVersion,
    toEmit,
    tokens,
    scope,
    mutation,
    dataOperation,
    verbDescription,
    outputSchema,
  } = inputs;

  // Phase 1: per-token resolution (numeric IDs are argv-derived;
  // emails flow through `userByEmail`). Failures land per-record
  // rather than aborting the loop. `--no-cache` plumbs through so
  // the directory cache is bypassed when the agent asked.
  const resolution = await resolveTokens(
    client,
    tokens,
    ctx.env,
    globalFlags.noCache,
  );

  // Whole-call boundary — no dispatchable user_id remains.
  // Per cli-design §6.4 partial-success per-token-resolution-
  // failures: surface as top-level `user_not_found` (NOT
  // `usage_error` — directory miss is actionable distinct from
  // malformed argv) carrying `details.failed_tokens`.
  if (resolution.dispatchableIds.length === 0) {
    throw new ApiError(
      'user_not_found',
      `No dispatchable user_id remains for ${verbDescription} — every --users token failed lookup.`,
      {
        details: {
          [scope.key]: scope.id,
          failed_tokens: resolution.failedTokens,
        },
      },
    );
  }

  if (globalFlags.dryRun) {
    // Dry-run: only resolver legs count toward `meta.source`.
    // Numeric-only `--users` fires zero resolver legs → 'none'.
    const source: DataSource = resolution.anyResolverLegFired
      ? resolution.resolverAggregator.result().source
      : 'none';
    const cacheAgeSeconds = resolution.anyResolverLegFired
      ? resolution.resolverAggregator.result().cacheAgeSeconds
      : null;
    // Per-record dry-run shape: `{user_id, would_apply, error?}`.
    // Mirrors the live record shape minus the `ok` rename.
    const dryResults = resolution.records.map((r) => ({
      user_id: r.user_id,
      would_apply: r.ok,
      ...(r.error === undefined ? {} : { error: r.error }),
    }));
    emitDryRun({
      ctx,
      programOpts,
      plannedChanges: [
        {
          operation: dataOperation,
          [scope.key]: scope.id,
          results: dryResults,
        },
      ],
      source,
      cacheAgeSeconds,
      warnings: [],
      apiVersion,
    });
    return;
  }

  // Phase 2: live dispatch — one wire call per dispatchable user.
  // Per-target failures captured into `results[i].error` by
  // `dispatchSequential`. Aggregator folds in dispatch legs
  // (always live) on top of resolver legs.
  const liveAggregator = resolution.resolverAggregator;
  let lastResponse: Awaited<ReturnType<typeof client.raw>> | undefined;
  const dispatchResults = await dispatchSequential(
    resolution.dispatchableIds,
    'user_id',
    async ({ targetId }) => {
      // Record the dispatch leg as 'live' BEFORE the wire call —
      // M14 round-1 F1: per-target dispatch failures must still
      // count toward `meta.source` because the call DID fire.
      // Without this, an all-email cache + dispatch-fails scenario
      // would emit `source: "cache"` even though a live mutation
      // was attempted.
      liveAggregator.record('live', null);
      const response = await client.raw<unknown>(
        mutation.query,
        {
          [scope.variableKey]: scope.id,
          userIds: [targetId],
        },
        { operationName: mutation.operationName },
      );
      lastResponse = response;
      // M14 round-1 F2: a 200 with `data.<rootKey>: null` and no
      // `errors[]` is NOT a per-target success — it's a null
      // payload Monday returns when the membership can't be
      // applied (rare server-side path). Throw a typed ApiError
      // so dispatchSequential lands it in `results[i].error`
      // rather than reporting an illusory ok: true.
      const data = unwrapOrThrow(
        wireResponseSchema.safeParse(response.data),
        {
          context: `Monday returned a malformed ${mutation.operationName} response`,
          details: {
            [scope.key]: scope.id,
            user_id: targetId,
          },
        },
      );
      // R41 lift (api/response-root.ts): distinguishes missing-
      // root-key (internal_error, whole-call re-thrown by
      // dispatchSequential) from null payload (not_found, per-
      // record). Generalised at R42 to share the helper with single-
      // target mutation verbs; this 'throw_not_found' mode preserves
      // the M14 contract (null → not_found landed in per-target
      // slot).
      assertResponseFieldPresent({
        data,
        key: mutation.rootKey,
        operationLabel: mutation.operationName,
        details: {
          [scope.key]: scope.id,
          user_id: targetId,
        },
        nullHandling: 'throw_not_found',
        notFoundTarget: { key: 'user_id', id: targetId },
      });
    },
  );

  // Merge dispatch outcomes back into the resolution records.
  // Pre-loop resolution failures stay as-is; dispatchable records
  // pick up the dispatch result (which may have flipped
  // `ok: true` → `ok: false` on a Monday-side error).
  const finalResults: UsersFanOutResultRecord[] = [...resolution.records];
  for (let i = 0; i < resolution.dispatchableIndices.length; i++) {
    const idx = resolution.dispatchableIndices[i];
    const dispatchResult = dispatchResults[i];
    if (idx === undefined || dispatchResult === undefined) continue;
    // dispatchSequential builds a record with our id-field
    // (`user_id`) plus `ok` + optional `error`. Lift the
    // success/error info onto the resolution slot.
    finalResults[idx] = {
      user_id: resolution.records[idx]?.user_id ?? '',
      ok: dispatchResult.ok,
      ...(dispatchResult.error === undefined
        ? {}
        : { error: dispatchResult.error }),
    };
  }

  emitMutation<Output>({
    ctx,
    // The cast widens through `unknown` because Output is a
    // subtype-bounded generic (`Output extends UsersFanOutEnvelope
    // <Op>`) — TS can't prove the literal matches an unknown
    // subtype, but the schema's runtime parse inside emitMutation
    // is the authoritative check.
    data: {
      operation: dataOperation,
      results: finalResults,
    } as unknown as Output,
    schema: outputSchema,
    programOpts,
    warnings: [],
    ...(lastResponse === undefined
      ? { apiVersion }
      : toEmit(lastResponse)),
    ...liveAggregator.result(),
  });
};
