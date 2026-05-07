/**
 * `monday workspace remove-users <wid> --users <id|email>,...
 * [--dry-run]` — fan-out remove subscribers from a workspace one
 * wire call per user (`cli-design.md` §4.3 line 529, `v0.2-plan.md`
 * §3 M14).
 *
 * **Mirrors `workspace add-users` exactly** modulo the operation
 * (`delete_users_from_workspace` rather than
 * `add_users_to_workspace`) and the dispatch mutation. Same fan-
 * out semantics (one wire call per user); same `--users` parser
 * (numeric argv-derived, email through `userByEmail`); same
 * partial-success envelope including `data.operation`; same
 * `meta.source` aggregation rule (dry-run sees only resolver legs;
 * live folds in every per-target dispatch leg too); same whole-
 * call boundary (`user_not_found` when no dispatchable id remains;
 * `usage_error` for malformed `--users` syntax).
 *
 * R-class candidate for M14 close: the two verbs share ~90% of
 * their action body. If M15 `board add-users` reuses the same
 * shape (likely — same partial-success contract per cli-design
 * §6.4), the third consumer triggers a lift into a shared
 * resolver-fronted-fan-out helper. M14 close audits the trigger
 * state.
 *
 * **Idempotent: yes** — Monday is no-op on re-removing a non-
 * member. **Admin-permission-sensitive**.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { dispatchSequential } from '../../api/partial-success-mutation.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { userByEmail } from '../../api/resolvers.js';
import type { MondayClient } from '../../api/client.js';
import type { DataSource } from '../../utils/output/envelope.js';

const REMOVE_USERS_FROM_WORKSPACE_MUTATION = `
  mutation WorkspaceRemoveUsers($workspaceId: ID!, $userIds: [ID!]!) {
    delete_users_from_workspace(workspace_id: $workspaceId, user_ids: $userIds) {
      id
    }
  }
`;

const NUMERIC_TOKEN_PATTERN = /^\d+$/u;
const EMAIL_TOKEN_PATTERN = /^[^@\s]+@[^@\s]+$/u;

const errorShape = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const liveResultRecordSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const workspaceRemoveUsersOutputSchema = z
  .object({
    operation: z.literal('delete_users_from_workspace'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type WorkspaceRemoveUsersOutput = z.infer<
  typeof workspaceRemoveUsersOutputSchema
>;

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
  readonly user_id: string;
  readonly ok: boolean;
  readonly error?: { readonly code: string; readonly message: string };
}

interface ResolutionOutcome {
  readonly records: readonly ResolvedRecord[];
  readonly dispatchableIds: readonly string[];
  readonly dispatchableIndices: readonly number[];
  readonly failedTokens: readonly string[];
  readonly resolverAggregator: SourceAggregator;
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

export const workspaceRemoveUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  WorkspaceRemoveUsersOutput
> = {
  name: 'workspace.remove-users',
  summary: 'Remove users from a workspace (partial-success envelope)',
  examples: [
    'monday workspace remove-users 12345 --users 67890,67891',
    'monday workspace remove-users 12345 --users alice@example.test,67891',
    'monday workspace remove-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-removing a non-member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: workspaceRemoveUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'workspace', 'Workspace commands');
    noun
      .command('remove-users <workspaceId>')
      .description(workspaceRemoveUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...workspaceRemoveUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (workspaceId: unknown, opts: unknown) => {
        const parsed = parseArgv(workspaceRemoveUsersCommand.inputSchema, {
          workspaceId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const tokens = parseUsersArg(parsed.users);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const resolution = await resolveTokens(
          client,
          tokens,
          ctx.env,
          globalFlags.noCache,
        );

        if (resolution.dispatchableIds.length === 0) {
          throw new ApiError(
            'user_not_found',
            `No dispatchable user_id remains for workspace remove-users — every --users token failed lookup.`,
            {
              details: {
                workspace_id: parsed.workspaceId,
                failed_tokens: resolution.failedTokens,
              },
            },
          );
        }

        if (globalFlags.dryRun) {
          const source: DataSource = resolution.anyResolverLegFired
            ? resolution.resolverAggregator.result().source
            : 'none';
          const cacheAgeSeconds = resolution.anyResolverLegFired
            ? resolution.resolverAggregator.result().cacheAgeSeconds
            : null;
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
                operation: 'delete_users_from_workspace',
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

        const liveAggregator = resolution.resolverAggregator;
        let lastResponse: Awaited<
          ReturnType<typeof client.raw>
        > | undefined;
        const dispatchResults = await dispatchSequential(
          resolution.dispatchableIds,
          'user_id',
          async ({ targetId }) => {
            const response = await client.raw<unknown>(
              REMOVE_USERS_FROM_WORKSPACE_MUTATION,
              {
                workspaceId: parsed.workspaceId,
                userIds: [targetId],
              },
              { operationName: 'WorkspaceRemoveUsers' },
            );
            lastResponse = response;
            liveAggregator.record('live', null);
          },
        );

        const finalResults: ResolvedRecord[] = [...resolution.records];
        for (let i = 0; i < resolution.dispatchableIndices.length; i++) {
          const idx = resolution.dispatchableIndices[i];
          const dispatchResult = dispatchResults[i];
          if (idx === undefined || dispatchResult === undefined) continue;
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
            operation: 'delete_users_from_workspace' as const,
            results: finalResults,
          },
          schema: workspaceRemoveUsersCommand.outputSchema,
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
