/**
 * `monday workspace add-users <wid> --users <id|email>,... [--dry-run]`
 * — fan-out add subscribers to a workspace one wire call per user
 * (`cli-design.md` §4.3 line 498, `v0.2-plan.md` §3 M14).
 *
 * **Wire shape.** Each per-user dispatch fires `add_users_to_
 * workspace(workspace_id, user_ids: [<single>])` — a one-element
 * `user_ids` array per call. M14 omits the SDK's optional `kind?:
 * WorkspaceSubscriberKind` argument and relies on Monday's server-
 * side default (subscriber). Owner-tier and explicit subscriber-
 * kind selection are deferred to a later milestone (no v0.2
 * surface decision blocking M14).
 *
 * **`--users` parser.** Comma-separated list mixing numeric IDs
 * and emails. Numeric IDs are argv-derived (skip the resolver
 * entirely); only email tokens flow through M5a's `userByEmail`
 * (directory cache + `users(emails:)` fallback). Tokens that are
 * neither numeric nor email-shaped surface as `usage_error` at
 * argv-parse, before any network leg.
 *
 * **Partial-success envelope** per cli-design §6.4 — emits one
 * `ok: true` envelope with `data: { operation: "add_users_to_
 * workspace", results: [{user_id, ok, error?}] }`. Per-user
 * resolution failures (`user_not_found`) AND per-user dispatch
 * failures land in the per-record `error` slot rather than
 * aborting the loop; on a resolution failure `user_id` carries
 * the input token verbatim so agents can correlate retries
 * against their `--users` argument.
 *
 * **Whole-call boundary.** Top-level `error` reserved for whole-
 * call failure: couldn't reach API, OR no dispatchable user_id
 * remains after parsing/resolution (every supplied token was an
 * email AND every email failed lookup). The whole-call code is
 * **`user_not_found`** (exit 2) carrying `details.failed_tokens:
 * [...]`. Mixed calls with even one numeric ID OR one resolved
 * email stay partial-success — failed-resolution records land
 * per-record. Malformed `--users` syntax (blank/non-numeric-non-
 * email) → `usage_error` (exit 1) at argv-parse.
 *
 * **`meta.source` aggregation.** Splits dry-run vs live (cli-
 * design §6.4 partial-success-envelope rule). Dry-run sees only
 * resolver legs (all-numeric → `none`; cache → `cache`; live
 * `users(emails:)` → `live`; combos → `mixed`). Live folds in
 * every per-target mutation dispatch leg too (always `live`),
 * so all-numeric live aggregates to `live` (not `none`).
 *
 * **Idempotent: yes** — Monday is no-op on a re-add. **Admin-
 * permission-sensitive**.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { dispatchSequential } from '../../api/partial-success-mutation.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { userByEmail } from '../../api/resolvers.js';
import type { MondayClient } from '../../api/client.js';
import type { DataSource } from '../../utils/output/envelope.js';

const ADD_USERS_TO_WORKSPACE_MUTATION = `
  mutation WorkspaceAddUsers($workspaceId: ID!, $userIds: [ID!]!) {
    add_users_to_workspace(workspace_id: $workspaceId, user_ids: $userIds) {
      id
    }
  }
`;

// `--users` token validation. Numeric matches the same regex the
// branded `UserId` schema uses (`/^\d+$/`); email is a deliberately
// permissive shape (presence of `@` after a non-empty local-part —
// Monday's `users(emails:)` will reject anything malformed at the
// directory level, and we only need to distinguish "lookup this"
// from "send this id verbatim").
const NUMERIC_TOKEN_PATTERN = /^\d+$/u;
const EMAIL_TOKEN_PATTERN = /^[^@\s]+@[^@\s]+$/u;

const dispatchResponseSchema = z
  .object({
    add_users_to_workspace: z.unknown(),
  })
  .loose();

// Null-payload guard for the per-target dispatch leg. Distinguishes
// two cases per Codex M14 round-2 F1:
// - `add_users_to_workspace` key ABSENT (response shape drift, e.g.
//   Monday's GraphQL schema dropped the mutation field): surface as
//   whole-call `internal_error` (dispatchSequential re-throws this
//   code so it doesn't get papered over as per-record).
// - `add_users_to_workspace` key PRESENT but value null: surface as
//   per-record `not_found` (the documented per-target null-payload
//   path Monday returns when the membership couldn't be applied).
const assertDispatchPayloadPresent = (
  data: Readonly<Record<string, unknown>>,
  userId: string,
  workspaceId: string,
): void => {
  if (!('add_users_to_workspace' in data)) {
    throw new ApiError(
      'internal_error',
      `Monday's WorkspaceAddUsers response is missing the add_users_to_workspace root field`,
      {
        details: {
          workspace_id: workspaceId,
          user_id: userId,
          hint:
            'this is a schema-drift error in Monday\'s GraphQL response; ' +
            'verify the mutation declaration and update the response ' +
            'schema if Monday\'s contract has changed.',
        },
      },
    );
  }
  const raw = data.add_users_to_workspace;
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no payload from add_users_to_workspace for user ${userId}`,
      { details: { user_id: userId } },
    );
  }
};

const errorShape = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

// Live-envelope per-record shape. `user_id` is plain `string` (not
// branded) because resolution failures preserve the input token
// verbatim — emails aren't valid `UserId` values.
const liveResultRecordSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const workspaceAddUsersOutputSchema = z
  .object({
    operation: z.literal('add_users_to_workspace'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type WorkspaceAddUsersOutput = z.infer<typeof workspaceAddUsersOutputSchema>;

const inputSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    users: z
      .string()
      .min(1, '--users must not be empty'),
  })
  .strict();

interface ParsedToken {
  readonly raw: string;
  readonly kind: 'numeric' | 'email';
}

const parseUsersArg = (raw: string): readonly ParsedToken[] => {
  const split = raw.split(',').map((t) => t.trim());
  const malformed: string[] = [];
  const tokens: ParsedToken[] = [];
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
  if (tokens.length === 0) {
    throw new UsageError(
      '--users must contain at least one numeric id or email',
    );
  }
  return tokens;
};

interface ResolvedRecord {
  /** Branded numeric Monday user id when resolution succeeded; the
   * input token verbatim (numeric string OR email) when it failed.
   * Always non-empty.
   */
  readonly user_id: string;
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

interface ResolutionOutcome {
  readonly records: readonly ResolvedRecord[];
  /** IDs the live dispatch loop should fire against (resolved,
   * `ok: true` records). Order matches the input `--users` order
   * with failed-resolution records skipped.
   */
  readonly dispatchableIds: readonly string[];
  /** Mapping from a dispatchable id back to the original record
   * index, so the live dispatch's per-target outcome can update
   * the right slot. */
  readonly dispatchableIndices: readonly number[];
  /** Tokens that failed lookup. Used for the whole-call
   * `details.failed_tokens` echo when no dispatchable id remains.
   */
  readonly failedTokens: readonly string[];
  /** `meta.source` aggregator over resolver legs only. Live path
   * folds dispatch legs into this externally. */
  readonly resolverAggregator: SourceAggregator;
  /** Whether any resolver leg fired (numeric-only paths fire none
   * — the aggregator stays empty and `meta.source` reads `'none'`
   * for dry-run). */
  readonly anyResolverLegFired: boolean;
}

const resolveTokens = async (
  client: MondayClient,
  tokens: readonly ParsedToken[],
  env: NodeJS.ProcessEnv,
  noCache: boolean,
): Promise<ResolutionOutcome> => {
  const records: ResolvedRecord[] = [];
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

export const workspaceAddUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceAddUsersOutput
> = {
  name: 'workspace.add-users',
  summary: 'Add users to a workspace as subscribers (partial-success envelope)',
  examples: [
    'monday workspace add-users 12345 --users 67890,67891',
    'monday workspace add-users 12345 --users alice@example.test,67891',
    'monday workspace add-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-adding an existing member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: workspaceAddUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('add-users <workspaceId>')
      .description(workspaceAddUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceAddUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceAddUsersCommand.inputSchema, {
          workspaceId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const tokens = parseUsersArg(parsed.users);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Phase 1: per-token resolution (numeric IDs are argv-
        // derived; emails flow through `userByEmail`). Failures
        // land per-record rather than aborting the loop.
        // `--no-cache` plumbs through so the directory cache is
        // bypassed when the agent asked.
        const resolution = await resolveTokens(
          client,
          tokens,
          ctx.env,
          globalFlags.noCache,
        );

        // Whole-call boundary — no dispatchable user_id remains.
        // Per cli-design §6.4 partial-success per-token-resolution-
        // failures: surface as top-level `user_not_found` (NOT
        // `usage_error` — directory miss is actionable distinct
        // from malformed argv) carrying `details.failed_tokens`.
        if (resolution.dispatchableIds.length === 0) {
          throw new ApiError(
            'user_not_found',
            `No dispatchable user_id remains for workspace add-users — every --users token failed lookup.`,
            {
              details: {
                workspace_id: parsed.workspaceId,
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
          // Mirror `liveResultRecordSchema` minus the `ok` rename.
          const dryResults = resolution.records.map((r) => ({
            user_id: r.user_id,
            would_apply: r.ok,
            ...(r.error === undefined ? {} : { error: r.error }),
          }));
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'add_users_to_workspace',
                workspace_id: parsed.workspaceId,
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

        // Phase 2: live dispatch — one wire call per dispatchable
        // user. Per-target failures captured into `results[i].error`
        // by `dispatchSequential`. Aggregator folds in the dispatch
        // legs (always live) on top of the resolver legs.
        const liveAggregator = resolution.resolverAggregator;
        let lastResponse: Awaited<
          ReturnType<typeof client.raw>
        > | undefined;
        const dispatchResults = await dispatchSequential(
          resolution.dispatchableIds,
          'user_id',
          async ({ targetId }) => {
            // Record the dispatch leg as 'live' BEFORE the wire
            // call — Codex M14 round-1 F1: per-target dispatch
            // failures must still count toward `meta.source`
            // because the call DID fire. Without this, an all-
            // email cache + dispatch-fails scenario would emit
            // `source: "cache"` even though a live mutation was
            // attempted.
            liveAggregator.record('live', null);
            const response = await client.raw<unknown>(
              ADD_USERS_TO_WORKSPACE_MUTATION,
              {
                workspaceId: parsed.workspaceId,
                userIds: [targetId],
              },
              { operationName: 'WorkspaceAddUsers' },
            );
            lastResponse = response;
            // Codex M14 round-1 F2: a 200 response with
            // `data.add_users_to_workspace: null` and no
            // `errors[]` is NOT a per-target success — it's a
            // null payload Monday returns when the membership
            // can't be applied (rare server-side path; observed
            // when the user id is a typo'd workspace id, etc.).
            // Throw a typed ApiError so dispatchSequential lands
            // it in `results[i].error` rather than reporting an
            // illusory ok: true.
            const data = unwrapOrThrow(
              dispatchResponseSchema.safeParse(response.data),
              {
                context:
                  'Monday returned a malformed WorkspaceAddUsers response',
                details: {
                  workspace_id: parsed.workspaceId,
                  user_id: targetId,
                },
              },
            );
            assertDispatchPayloadPresent(
              data,
              targetId,
              parsed.workspaceId,
            );
          },
        );

        // Merge dispatch outcomes back into the resolution records.
        // Pre-loop resolution failures stay as-is; dispatchable
        // records pick up the dispatch result (which may have
        // flipped `ok: true` → `ok: false` on a Monday-side error).
        const finalResults: ResolvedRecord[] = [...resolution.records];
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

        emitMutation({
          ctx,
          data: {
            operation: 'add_users_to_workspace' as const,
            results: finalResults,
          },
          schema: workspaceAddUsersCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...(lastResponse === undefined
            ? { apiVersion }
            : toEmit(lastResponse)),
          ...liveAggregator.result(),
        });
      });
  },
};
