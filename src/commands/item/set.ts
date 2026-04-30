/**
 * `monday item set <iid> <col>=<val>` — single-column write
 * (`cli-design.md` §5.3, `v0.1-plan.md` §3 M5b).
 *
 * The first M5b mutation surface. Single `<col>=<val>` positional;
 * multi-`--set` is `monday item update`'s concern (next session).
 *
 * **Two paths.** `--dry-run` orchestrates the M5a engine
 * (`api/dry-run.ts planChanges`) which reads the item state, builds
 * the §6.4 `planned_changes` shape, and emits a dry-run envelope
 * (`data: null`, `meta.dry_run: true`, `planned_changes: [{...}]`).
 * Live writes resolve the column + translate the value + select the
 * mutation + fire it directly, returning the projected item per §6.2.
 *
 * **Board resolution** (cli-design §5.3 step 1). `--board <bid>` is
 * authoritative; without it the CLI calls `items(ids:[<iid>])` to
 * read `board.id` and continues. The implicit-lookup result feeds
 * both the live write and the dry-run engine — same answer, same
 * source-of-truth (the item's current board).
 *
 * **Resolver-warning preservation.** Both paths thread collision /
 * stale-cache-refreshed warnings into the success envelope via
 * `warnings: [...]`. On error paths that surface AFTER resolution
 * succeeded (the `column_archived` case the dry-run engine pins),
 * the warnings fold into `error.details.resolver_warnings` so a
 * stale-cache-then-archived flow doesn't lose the refresh signal.
 *
 * **Mutation kind selection** (`api/column-values.ts selectMutation`).
 * Item set is single-`<col>=<val>` only:
 *   - 1 simple type (text / long_text / numbers) →
 *     `change_simple_column_value` (bare-string `value`).
 *   - 1 rich type (status / dropdown / date / people) →
 *     `change_column_value` (JSON object `value`).
 * `change_multiple_column_values` is never selected by item set —
 * that path lights up under `monday item update` (next session).
 *
 * Idempotent: yes — Monday's `change_*` mutations are idempotent
 * (re-running with the same args produces the same item state).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, MondayCliError, UsageError } from '../../utils/errors.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from '../../api/columns.js';
import type { MondayClient, MondayResponse } from '../../api/client.js';
import {
  selectMutation,
  translateColumnValueAsync,
  type DateResolutionContext,
  type PeopleResolutionContext,
  type SelectedMutation,
} from '../../api/column-values.js';
import { userByEmail } from '../../api/resolvers.js';
import { refreshBoardMetadata } from '../../api/board-metadata.js';
import { planChanges } from '../../api/dry-run.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import {
  ITEM_FIELDS_FRAGMENT,
  parseRawItem,
  resolveMeFactory,
} from '../../api/item-helpers.js';
import {
  projectItem,
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import type { Warning } from '../../utils/output/envelope.js';

const ITEM_BOARD_LOOKUP_QUERY = `
  query ItemBoardLookup($ids: [ID!]!) {
    items(ids: $ids) {
      id
      board { id }
    }
  }
`;

const CHANGE_SIMPLE_COLUMN_VALUE_MUTATION = `
  mutation ItemSetSimple(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: String!
  ) {
    change_simple_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_VALUE_MUTATION = `
  mutation ItemSetRich(
    $itemId: ID!
    $boardId: ID!
    $columnId: String!
    $value: JSON!
  ) {
    change_column_value(
      item_id: $itemId
      board_id: $boardId
      column_id: $columnId
      value: $value
    ) {
      ${ITEM_FIELDS_FRAGMENT}
    }
  }
`;

// Pass-1 finding F3: parse the board-lookup response through zod
// before reading. Pre-fix, `client.raw<BoardLookupResponse>` was a
// trusted boundary — a malformed response (Monday schema drift)
// would surface downstream as a raw ZodError from `BoardIdSchema.
// parse`, contrary to validation.md "Never bubble raw ZodError
// out of a parse boundary". Now the parse boundary lives at the
// item-set entry point with `unwrapOrThrow`.
//
// Pass-2 finding: validate id-shaped fields with the branded
// schemas (BoardIdSchema / ItemIdSchema) — a `z.string().min(1)`
// would let `"not-a-board-id"` through, escaping the parse
// boundary and surfacing downstream as a raw ZodError from
// `BoardIdSchema.parse` in `loadBoardMetadata`.
const boardLookupResponseSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: ItemIdSchema,
          board: z.object({ id: BoardIdSchema }).nullable(),
        }),
      )
      .nullable(),
  })
  .loose();
interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}

export const itemSetOutputSchema = projectedItemSchema;
export type ItemSetOutput = ProjectedItem;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    setExpr: z.string().min(1),
    board: BoardIdSchema.optional(),
  })
  .strict();

/**
 * Splits `<col>=<val>` on the FIRST `=` per cli-design §5.3 lines
 * 712-715. Tokens with `=` in the title need shell quoting plus the
 * explicit `id:` / `title:` prefix or `--filter-json`-style escape.
 * An empty token raises `usage_error`; an empty value (`status=`) is
 * accepted at this layer and propagated to the per-type translator
 * which decides whether to accept (e.g. `status= ` becomes
 * `{label: ""}`) or reject (dropdown empty-input rejects per
 * column-values.ts).
 */
const splitSetExpression = (raw: string): { readonly token: string; readonly value: string } => {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new UsageError(
      `--set: expected <col>=<val> (got ${JSON.stringify(raw)}); ` +
        `use shell quoting and the id:/title: prefix when the column ` +
        `token contains "="`,
      { details: { input: raw } },
    );
  }
  return {
    token: raw.slice(0, idx),
    value: raw.slice(idx + 1),
  };
};

/**
 * Resolves the board id for the target item. `--board` is
 * authoritative; without it, Monday is queried for the item's
 * current board. Per cli-design §5.3 step 1 — "Implicit (preferred):
 * `--board <bid>` skips a lookup and is authoritative."
 */
const resolveBoardId = async (
  client: MondayClient,
  itemId: string,
  explicit: string | undefined,
): Promise<string> => {
  if (explicit !== undefined) return explicit;
  const response = await client.raw<unknown>(
    ITEM_BOARD_LOOKUP_QUERY,
    { ids: [itemId] },
    { operationName: 'ItemBoardLookup' },
  );
  // Pass-1 finding F3: parse the response shape via zod so a
  // malformed Monday payload surfaces as typed `internal_error`
  // with `details.issues` rather than a raw ZodError downstream.
  const data = unwrapOrThrow(
    boardLookupResponseSchema.safeParse(response.data),
    {
      context: `Monday returned a malformed ItemBoardLookup response for id ${itemId}`,
      details: { item_id: itemId },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update boardLookupResponseSchema if ' +
        'Monday\'s contract has changed.',
    },
  );
  const first = data.items?.[0];
  if (first === undefined) {
    throw new ApiError(
      'not_found',
      `Item ${itemId} does not exist or the token has no read access.`,
      { details: { item_id: itemId } },
    );
  }
  if (first.board === null) {
    // Defensive — Monday's items query returns board.id for every
    // visible item; a null here would mean a board the token can't
    // see. Surface as `not_found` (the item is effectively
    // inaccessible) with the item_id for triage.
    throw new ApiError(
      'not_found',
      `Item ${itemId} has no readable board; the token may not have ` +
        `permission on the item's board, or the item is in a deleted ` +
        `board.`,
      { details: { item_id: itemId } },
    );
  }
  return first.board.id;
};

/**
 * Folds resolver warnings (collision / stale_cache_refreshed) into a
 * thrown error's details.resolver_warnings slot — same pattern the
 * dry-run engine uses on `column_archived` so a stale-cache-then-
 * archived flow doesn't drop the refresh signal. Returns a NEW
 * error of the same code with merged details; the original is
 * discarded.
 *
 * Accepts any `MondayCliError` (Codex pass-1 finding F2 widened
 * scope from `ApiError` only) so translator `UsageError`s
 * (date / dropdown / people invalid input) and mutation-time
 * `ApiError(validation_failed)` from Monday all carry the
 * resolver context through to the agent's debug log.
 */
const foldResolverWarningsIntoError = (
  err: MondayCliError,
  resolverWarnings: readonly ResolverWarning[],
): MondayCliError => {
  if (resolverWarnings.length === 0) return err;
  const detailWarnings = resolverWarnings.map((w) => ({
    code: w.code,
    message: w.message,
    details: w.details,
  }));
  // Reconstruct via the typed-error constructor that matches
  // `err.code` so the new error stays the same class. Pre-fix
  // (pass-1 only-ApiError fold), a UsageError translator failure
  // bypassed the fold and lost the resolver context.
  const cls =
    err.code === 'usage_error'
      ? UsageError
      : err.code === 'config_error' || err.code === 'cache_error'
        ? null
        : ApiError;
  // For codes outside the ApiError / UsageError pair (config/cache),
  // construct a base MondayCliError. The cli-design surface for
  // item set never triggers those classes — but keep the shape
  // open so the helper remains general.
  return cls === UsageError
    ? new UsageError(err.message, mergeDetails(err, detailWarnings))
    : cls === ApiError
      ? new ApiError(err.code, err.message, mergeDetails(err, detailWarnings))
      : new MondayCliError(err.code, err.message, mergeDetails(err, detailWarnings));
};

/**
 * Pass-1 finding F4: archived-column guarantee was cache-stale in
 * one direction — when cached metadata said active but Monday had
 * since archived the column, the live mutation fired and surfaced
 * as `validation_failed`, not the stable `column_archived` code
 * agents key off (cli-design §6.5).
 *
 * This helper inspects a thrown `validation_failed` after a cache-
 * sourced resolution and remaps it to `column_archived` if a
 * forced-fresh metadata refresh confirms the column is archived.
 * Resolver warnings — already folded by
 * `foldResolverWarningsIntoError` — survive the remap.
 *
 * Why scoped to cache-sourced resolution: a live resolution
 * already saw the live archived flag, so a `validation_failed`
 * after live resolution is genuine (label typo, schema mismatch,
 * etc.). Only cache-sourced resolution can be wrong about
 * archived state.
 *
 * Returns the original error unchanged when the code isn't
 * `validation_failed`, or when the post-refresh column is still
 * active. The cache write that `refreshBoardMetadata` performs is
 * a useful side-effect — agents retrying after the failure see
 * the corrected metadata.
 */
const maybeRemapValidationFailedToArchived = async (
  err: MondayCliError,
  inputs: {
    readonly client: MondayClient;
    readonly boardId: string;
    readonly columnId: string;
    readonly token: string;
    readonly env: NodeJS.ProcessEnv;
    readonly noCache: boolean;
    readonly resolutionSource: 'live' | 'cache' | 'mixed';
  },
): Promise<MondayCliError> => {
  if (err.code !== 'validation_failed') return err;
  if (inputs.resolutionSource === 'live') return err;
  let refreshed;
  try {
    refreshed = await refreshBoardMetadata({
      client: inputs.client,
      boardId: inputs.boardId,
      env: inputs.env,
      noCache: inputs.noCache,
    });
  } catch {
    // Refresh failed — propagate the original validation_failed
    // unchanged rather than masking with an unrelated refresh
    // error. The agent's retry loop will hit the same path.
    return err;
  }
  const live = refreshed.metadata.columns.find(
    (c) => c.id === inputs.columnId,
  );
  if (live?.archived !== true) return err;
  // Confirmed archived. Build a column_archived error preserving
  // the original error's resolver_warnings.
  const existing = err.details ?? {};
  return new ApiError(
    'column_archived',
    `Column ${JSON.stringify(inputs.columnId)} on board ` +
      `${inputs.boardId} is archived (Monday rejected the mutation as ` +
      `validation_failed; a forced metadata refresh confirmed the ` +
      `archived state). Un-archive the column in Monday or pick a ` +
      `different target.`,
    {
      cause: err,
      details: {
        ...existing,
        column_id: inputs.columnId,
        column_title: live.title,
        column_type: live.type,
        board_id: inputs.boardId,
        remapped_from: 'validation_failed',
        hint:
          'cache-sourced resolution missed the archived flag; the CLI ' +
          'forced a live refresh after the mutation failed and confirmed ' +
          'the column is now archived. Resolver warnings (if any) carry ' +
          'the pre-refresh state.',
      },
    },
  );
};

const mergeDetails = (
  err: MondayCliError,
  detailWarnings: readonly { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> }[],
): {
  readonly cause: unknown;
  readonly httpStatus?: number;
  readonly mondayCode?: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly details: Readonly<Record<string, unknown>>;
} => ({
  cause: err.cause,
  ...(err.httpStatus === undefined ? {} : { httpStatus: err.httpStatus }),
  ...(err.mondayCode === undefined ? {} : { mondayCode: err.mondayCode }),
  ...(err.requestId === undefined ? {} : { requestId: err.requestId }),
  retryable: err.retryable,
  ...(err.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: err.retryAfterSeconds }),
  details: {
    ...(err.details ?? {}),
    resolver_warnings: detailWarnings,
  },
});

export const itemSetCommand: CommandModule<
  z.infer<typeof inputSchema>,
  ItemSetOutput
> = {
  name: 'item.set',
  summary: 'Write a single column value on an item',
  examples: [
    'monday item set 12345 status=Done',
    'monday item set 12345 status=Done --board 67890',
    "monday item set 12345 owner=alice@example.com --dry-run",
    'monday item set 12345 due=+1w --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemSetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      .command('set <itemId> <setExpr>')
      .description(itemSetCommand.summary)
      .option('--board <bid>', 'board ID (skip implicit lookup)')
      // `--dry-run` is a global flag (`src/cli/program.ts`) — read
      // it via `globalFlags.dryRun` rather than redeclaring on this
      // subcommand so the flag stays single-source-of-truth across
      // every M5b mutation surface.
      .addHelpText(
        'after',
        ['', 'Examples:', ...itemSetCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, setExpr: unknown, opts: unknown) => {
        const parsed = parseArgv(itemSetCommand.inputSchema, {
          itemId,
          setExpr,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const { token, value } = splitSetExpression(parsed.setExpr);

        const boardId = await resolveBoardId(
          client,
          parsed.itemId,
          parsed.board,
        );

        // Resolution contexts. `MONDAY_TIMEZONE` env override threads
        // to date.parseDateInput per cli-design §5.3 line 765;
        // `resolveMe` + `resolveEmail` cover the people branch's
        // `me` token and email-lookup paths per §5.3 line 728-734.
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

        if (globalFlags.dryRun) {
          const result = await planChanges({
            client,
            boardId,
            itemId: parsed.itemId,
            setEntries: [{ token, value }],
            dateResolution,
            peopleResolution,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            // PlannedChange is a closed-shape interface; the dry-run
            // envelope's `planned_changes` field is `unknown[]` per
            // §6.4 (extensions land additively). Widen here.
            plannedChanges: result.plannedChanges as unknown as readonly Readonly<Record<string, unknown>>[],
            source: result.source,
            cacheAgeSeconds: result.cacheAgeSeconds,
            warnings: result.warnings,
            apiVersion,
          });
          return;
        }

        // Live write path. Resolution + translation + mutation,
        // mirroring planChanges' resolver-warnings preservation but
        // without the item-state read (which the live mutation
        // doesn't need — the mutation response carries the updated
        // item).
        const resolution = await resolveColumnWithRefresh({
          client,
          boardId,
          token,
          includeArchived: true,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });
        const resolverWarnings: readonly ResolverWarning[] = resolution.warnings;

        if (resolution.match.column.archived === true) {
          throw foldResolverWarningsIntoError(
            new ApiError(
              'column_archived',
              `Column ${JSON.stringify(resolution.match.column.id)} on board ` +
                `${boardId} is archived. Monday rejects mutations against ` +
                `archived columns; un-archive the column in Monday or pick a ` +
                `different target.`,
              {
                details: {
                  column_id: resolution.match.column.id,
                  column_title: resolution.match.column.title,
                  column_type: resolution.match.column.type,
                  board_id: boardId,
                },
              },
            ),
            resolverWarnings,
          );
        }

        // Translator + mutation-selection + live mutation all share
        // the same resolver-warnings preservation rule. Any typed
        // failure (UsageError from date/dropdown/people invalid
        // input, ApiError(validation_failed) from Monday on the
        // mutation) gets the collected collision /
        // stale_cache_refreshed warnings folded into
        // details.resolver_warnings — pass-1 finding F2 widened the
        // fold from ApiError-only to MondayCliError to cover the
        // full error surface.
        let translated;
        let mutationResult;
        try {
          translated = await translateColumnValueAsync({
            column: {
              id: resolution.match.column.id,
              type: resolution.match.column.type,
            },
            value,
            dateResolution,
            peopleResolution,
          });
          const mutation: SelectedMutation = selectMutation([translated]);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: parsed.itemId,
            boardId,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            throw await maybeRemapValidationFailedToArchived(
              foldResolverWarningsIntoError(err, resolverWarnings),
              {
                client,
                boardId,
                columnId: resolution.match.column.id,
                token,
                env: ctx.env,
                noCache: globalFlags.noCache,
                resolutionSource: resolution.source,
              },
            );
          }
          throw err;
        }

        // Resolver warnings ride into the success envelope's
        // top-level warnings so an agent reading a successful write
        // still sees that the cache was stale or that the token
        // collided with another column's title. Same shape filter
        // reads use post-R12.
        // ResolverWarning widens to envelope.Warning structurally
        // (narrower code literal, required details). Same shape
        // filters.ts and search.ts use post-R12.
        const warnings: readonly Warning[] = resolverWarnings;

        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemSetCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          // Resolution may have served from cache (and refreshed if
          // the column wasn't there); thread the resolved source +
          // age through. The mutation itself is always live, so a
          // pure-cache leg never happens here — but the resolver's
          // `mixed` outcome still surfaces as `mixed`.
          source: resolution.source === 'cache' ? 'mixed' : resolution.source,
          cacheAgeSeconds: resolution.cacheAgeSeconds,
          // cli-design §5.3 step 2: echo the resolved column ID so
          // an agent's "set then re-read" loop can use the resolved
          // ID without consulting metadata twice. Keyed by the raw
          // input token (the slot is `Record<string, string>` so
          // multi-`--set` in M5b's item update extends naturally).
          resolvedIds: { [token]: resolution.match.column.id },
        });
      });
  },
};

interface MutationExecResult {
  readonly projected: ProjectedItem;
  readonly response: MondayResponse<unknown>;
}

/**
 * Issues the live mutation Monday's `change_simple_column_value` /
 * `change_column_value` accept. Returns the projected item per §6.2
 * — Monday returns the full item shape on the mutation's payload, so
 * one round-trip lands the write + the post-write item state. The
 * raw response object is also returned so the caller can thread its
 * `complexity` field through `toEmit`.
 */
const executeMutation = async (
  client: MondayClient,
  inputs: {
    readonly mutation: SelectedMutation;
    readonly itemId: string;
    readonly boardId: string;
  },
): Promise<MutationExecResult> => {
  const { mutation, itemId, boardId } = inputs;
  if (mutation.kind === 'change_simple_column_value') {
    const response = await client.raw<ChangeSimpleResponse>(
      CHANGE_SIMPLE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        value: mutation.value,
      },
      { operationName: 'ItemSetSimple' },
    );
    return {
      projected: projectMutationItem(response.data.change_simple_column_value, itemId),
      response,
    };
  }
  if (mutation.kind === 'change_column_value') {
    const response = await client.raw<ChangeColumnResponse>(
      CHANGE_COLUMN_VALUE_MUTATION,
      {
        itemId,
        boardId,
        columnId: mutation.columnId,
        // Monday's `change_column_value(value: JSON!)` accepts a
        // plain object — the SDK / fetch layer handles the wire
        // stringification at the GraphQL `JSON` scalar boundary.
        // Per cli-design §5.3 step 4: the translator emits a plain
        // JS object; the wire layer handles the JSON.stringify.
        value: mutation.value,
      },
      { operationName: 'ItemSetRich' },
    );
    return {
      projected: projectMutationItem(response.data.change_column_value, itemId),
      response,
    };
  }
  // change_multiple_column_values — reachable only when item set's
  // single-`<col>=<val>` becomes multi-`--set` in v0.1's `item update`.
  // Defensive guard: M5b's item set never selects multi.
  /* c8 ignore next 9 — defensive: selectMutation only emits this
     kind for >1 translated values; item set is single-`<col>=<val>`
     by argv shape, so this branch is unreachable. */
  throw new ApiError(
    'internal_error',
    `item set selected ${mutation.kind} but only the single-column ` +
      `mutations are supported here; bundling >1 set targets is item ` +
      `update's surface.`,
    { details: { mutation_kind: mutation.kind, item_id: itemId } },
  );
};

const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem => {
  if (raw === null || raw === undefined) {
    throw new ApiError(
      'internal_error',
      `Monday returned no item payload from the mutation for id ${itemId}.`,
      { details: { item_id: itemId } },
    );
  }
  return projectItem({ raw: parseRawItem(raw, { item_id: itemId }) });
};
