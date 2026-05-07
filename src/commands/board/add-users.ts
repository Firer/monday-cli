/**
 * `monday board add-users <bid> --users <id|email>,... [--dry-run]`
 * — fan-out add subscribers to a board one wire call per user
 * (`cli-design.md` §4.3 line 770, `v0.2-plan.md` §3 M15).
 *
 * **Third partial-success-fan-out consumer** after M14's
 * `workspace add-users` / `workspace remove-users`. The shape
 * mirrors workspace-add-users near-verbatim modulo the wire
 * mutation name + target id field (`board_id` vs `workspace_id`).
 * Per v0.2-plan §22 R40, the shared resolver-fronted-fan-out
 * helper lift fires at M15 close once this third consumer's
 * parameter shape is empirically known — this file is the third
 * copy that triggers the lift.
 *
 * **Wire shape.** Each per-user dispatch fires `add_users_to_
 * board(board_id, user_ids: [<single>], kind?: BoardSubscriberKind)`
 * — a one-element `user_ids` array per call. M15 omits the SDK's
 * optional `kind?` argument and relies on Monday's server-side
 * default (subscriber). Owner-tier and explicit subscriber-kind
 * selection deferred to a later milestone (mirrors M14's
 * workspace add-users `kind?: WorkspaceSubscriberKind` decision).
 *
 * **Partial-success envelope** per cli-design §6.4 — emits one
 * `ok: true` envelope with `data: { operation: "add_users_to_
 * board", results: [{user_id, ok, error?}] }`. Per-user
 * resolution failures (`user_not_found`) AND per-user dispatch
 * failures land per-record. Whole-call boundary: `user_not_found`
 * (exit 2) when no dispatchable user_id remains; `usage_error`
 * (exit 1) for malformed `--users` syntax.
 *
 * **`meta.source` aggregation.** Same rule as workspace add-
 * users (cli-design §6.4 partial-success aggregation table).
 * Dry-run sees only resolver legs (numeric-only → 'none', cache
 * → 'cache', live → 'live', combos → 'mixed'). Live folds in
 * every per-target dispatch leg (always 'live') on top.
 *
 * **Idempotent: yes** — Monday is no-op on a re-add. Not
 * destructive (no --yes gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { dispatchSequential } from '../../api/partial-success-mutation.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { userByEmail } from '../../api/resolvers.js';
import type { MondayClient } from '../../api/client.js';
import type { DataSource } from '../../utils/output/envelope.js';

const ADD_USERS_TO_BOARD_MUTATION = `
  mutation BoardAddUsers($boardId: ID!, $userIds: [ID!]!) {
    add_users_to_board(board_id: $boardId, user_ids: $userIds) {
      id
    }
  }
`;

// Token validation patterns mirror workspace add-users (M14).
const NUMERIC_TOKEN_PATTERN = /^\d+$/u;
const EMAIL_TOKEN_PATTERN = /^[^@\s]+@[^@\s]+$/u;

const dispatchResponseSchema = z
  .object({
    add_users_to_board: z.unknown(),
  })
  .loose();

// Null-payload guard: distinguishes "key absent" (schema-drift →
// internal_error, whole-call) from "value null" (per-record
// not_found). Mirrors M14 round-2 F1 + round-3 F1 contract.
const assertDispatchPayloadPresent = (
  data: Readonly<Record<string, unknown>>,
  userId: string,
  boardId: string,
): void => {
  if (!('add_users_to_board' in data)) {
    throw new ApiError(
      'internal_error',
      `Monday's BoardAddUsers response is missing the add_users_to_board root field`,
      {
        details: {
          board_id: boardId,
          user_id: userId,
          hint:
            'this is a schema-drift error in Monday\'s GraphQL response; ' +
            'verify the mutation declaration and update the response ' +
            'schema if Monday\'s contract has changed.',
        },
      },
    );
  }
  const raw = data.add_users_to_board;
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'not_found',
      `Monday returned no payload from add_users_to_board for user ${userId}`,
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

const liveResultRecordSchema = z
  .object({
    user_id: z.string().min(1),
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const boardAddUsersOutputSchema = z
  .object({
    operation: z.literal('add_users_to_board'),
    results: z.array(liveResultRecordSchema),
  })
  .strict();

export type BoardAddUsersOutput = z.infer<typeof boardAddUsersOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    users: z.string().min(1, '--users must not be empty'),
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
  /* c8 ignore next 3 */
  if (tokens.length === 0) {
    throw new UsageError('--users must contain at least one numeric id or email');
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

export const boardAddUsersCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardAddUsersOutput
> = {
  name: 'board.add-users',
  summary: 'Add users to a board as subscribers (partial-success envelope)',
  examples: [
    'monday board add-users 12345 --users 67890,67891',
    'monday board add-users 12345 --users alice@example.test,67891',
    'monday board add-users 12345 --users 67890 --dry-run --json',
  ],
  // Re-adding an existing member is a no-op on Monday's side; mark
  // idempotent so agents can retry on transient failure.
  idempotent: true,
  inputSchema,
  outputSchema: boardAddUsersOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('add-users <boardId>')
      .description(boardAddUsersCommand.summary)
      .requiredOption('--users <list>', 'comma-separated numeric ids and/or emails')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardAddUsersCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardAddUsersCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const tokens = parseUsersArg(parsed.users);
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Phase 1: per-token resolution.
        const resolution = await resolveTokens(
          client,
          tokens,
          ctx.env,
          globalFlags.noCache,
        );

        // Whole-call boundary: no dispatchable user_id remains.
        // Surface as `user_not_found` (exit 2), NOT `usage_error`.
        if (resolution.dispatchableIds.length === 0) {
          throw new ApiError(
            'user_not_found',
            `No dispatchable user_id remains for board add-users — every --users token failed lookup.`,
            {
              details: {
                board_id: parsed.boardId,
                failed_tokens: resolution.failedTokens,
              },
            },
          );
        }

        if (globalFlags.dryRun) {
          // Dry-run: only resolver legs count toward meta.source.
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
                operation: 'add_users_to_board',
                board_id: parsed.boardId,
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
        // user. Per-target failures captured into results[i].error
        // by dispatchSequential. Aggregator folds in dispatch legs
        // (always live) on top of resolver legs.
        const liveAggregator = resolution.resolverAggregator;
        let lastResponse: Awaited<ReturnType<typeof client.raw>> | undefined;
        const dispatchResults = await dispatchSequential(
          resolution.dispatchableIds,
          'user_id',
          async ({ targetId }) => {
            // Record dispatch leg as 'live' BEFORE the wire call —
            // M14 round-1 F1: per-target failures must still count
            // toward meta.source because the call DID fire.
            liveAggregator.record('live', null);
            const response = await client.raw<unknown>(
              ADD_USERS_TO_BOARD_MUTATION,
              {
                boardId: parsed.boardId,
                userIds: [targetId],
              },
              { operationName: 'BoardAddUsers' },
            );
            lastResponse = response;
            // M14 round-1 F2: a 200 with null payload + no errors
            // is a per-target failure, not illusory success.
            const data = unwrapOrThrow(
              dispatchResponseSchema.safeParse(response.data),
              {
                context:
                  'Monday returned a malformed BoardAddUsers response',
                details: {
                  board_id: parsed.boardId,
                  user_id: targetId,
                },
              },
            );
            assertDispatchPayloadPresent(data, targetId, parsed.boardId);
          },
        );

        // Merge dispatch outcomes back into resolution records.
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
            operation: 'add_users_to_board' as const,
            results: finalResults,
          },
          schema: boardAddUsersCommand.outputSchema,
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
