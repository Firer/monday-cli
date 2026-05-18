/**
 * `monday item set <iid> (<col>=<val> | --set-raw <col>=<json>)` —
 * single-column write (`cli-design.md` §4.3 + §5.3 + §5.3 escape-
 * hatch, `v0.1-plan.md` §3 M5b, `v0.2-plan.md` §3 M8).
 *
 * Two argv shapes (mutually exclusive — exactly one fires per call):
 *   1. **Friendly** — positional `<col>=<val>`. Resolves the column,
 *      translates the value through `column-values.ts
 *      translateColumnValueAsync`, dispatches via `selectMutation`.
 *   2. **Raw** — `--set-raw <col>=<json>` (M8). Resolves the column,
 *      runs the read-only-forever / files-shaped reject lists from
 *      `raw-write.ts translateRawColumnValue`, dispatches via the
 *      same `selectMutation` (always `change_column_value` for
 *      single-column raw — never the simple variant per cli-design
 *      §5.3 line 898-901).
 *
 * **Two paths.** `--dry-run` orchestrates the M5a engine
 * (`api/dry-run.ts planChanges`) which reads the item state, builds
 * the §6.4 `planned_changes` shape, and emits a dry-run envelope
 * (`data: null`, `meta.dry_run: true`, `planned_changes: [{...}]`).
 * Live writes resolve the column + translate the value + select the
 * mutation + fire it directly, returning the projected item per §6.2.
 * Both shapes go through the same dry-run + live paths.
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
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../api/column-values.js';
import {
  parseSetRawExpression,
  translateRawColumnValue,
} from '../../api/raw-write.js';
import { splitSetExpression } from '../../api/set-expression.js';
import { buildResolutionContexts } from '../../api/resolution-context.js';
import { resolveBoardId } from '../../api/item-board-lookup.js';
import { buildColumnArchivedError } from '../../api/resolution-pass.js';
import {
  foldAndRemap,
  foldResolverWarningsIntoError,
} from '../../api/resolver-error-fold.js';
import { mergeSource, mergeCacheAge } from '../../api/source-aggregator.js';
import { planChanges } from '../../api/dry-run.js';
import { ITEM_FIELDS_FRAGMENT } from '../../api/item-helpers.js';
import { projectMutationItem as projectMutationItemShared } from '../../api/item-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import {
  projectedItemSchema,
  type ProjectedItem,
} from '../../api/item-projection.js';
import {
  executeFileColumnSet,
  fileColumnSetOutputSchema,
  type FileColumnSetOutput,
} from '../../api/file-column-set.js';
import { precheckLocalFile } from '../../utils/file-source.js';
import { invalidateBoard } from '../../api/cache.js';
import type { Warning } from '../../utils/output/envelope.js';

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

interface ChangeSimpleResponse {
  readonly change_simple_column_value: unknown;
}
interface ChangeColumnResponse {
  readonly change_column_value: unknown;
}

/**
 * Output envelope union — projected-item for the JSON translator
 * path (text / status / dropdown / date / people / etc.) +
 * file-dispatch envelope for the v0.6-M38 friendly `--set
 * <file-col>=<path>` path. Agents discriminate on the `operation`
 * field: present (`'add_file_to_column'`) → file dispatch shape;
 * absent → projected-item shape (mirrors §6.2 single-record).
 */
export const itemSetOutputSchema = z.union([
  projectedItemSchema,
  fileColumnSetOutputSchema,
]);
export type ItemSetOutput = ProjectedItem | FileColumnSetOutput;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    // Positional `<col>=<val>` is optional in M8 — `--set-raw` is the
    // alternative shape per cli-design §4.3 line 492-494. Exactly one
    // of `setExpr` / `setRaw` must be present (validated below).
    setExpr: z.string().min(1).optional(),
    setRaw: z.string().min(1).optional(),
    board: BoardIdSchema.optional(),
  })
  .strict()
  .refine(
    (v) => (v.setExpr === undefined) !== (v.setRaw === undefined),
    {
      message:
        'item set requires exactly one of <col>=<val> (positional) or ' +
        '--set-raw <col>=<json>',
      path: ['setExpr'],
    },
  );

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
    "monday item set 12345 --set-raw status='{\"label\":\"Done\"}'",
    "monday item set 12345 --set-raw tags='{\"tag_ids\":[1,2]}' --board 67890",
  ],
  idempotent: true,
  inputSchema,
  outputSchema: itemSetOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'item', 'Item commands');
    noun
      // Positional `[setExpr]` optional so the parser accepts the
      // `--set-raw`-only invocation per cli-design §4.3 line 492-494.
      // The zod refinement enforces "exactly one of setExpr / setRaw".
      .command('set <itemId> [setExpr]')
      .description(itemSetCommand.summary)
      .option('--board <bid>', 'board ID (skip implicit lookup)')
      .option(
        '--set-raw <expr>',
        '<col>=<json> raw write (escape hatch — bypasses friendly translator)',
      )
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
          ...(setExpr === undefined ? {} : { setExpr }),
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion, multipart, toEmit } =
          resolveClient(ctx, program.opts());

        // Exactly one of setExpr / setRaw is present (zod refinement
        // enforces XOR). Discriminate to keep the downstream code
        // shape clear.
        const isRaw = parsed.setRaw !== undefined;
        const friendly =
          parsed.setExpr === undefined ? null : splitSetExpression(parsed.setExpr);
        const rawParsed =
          parsed.setRaw === undefined ? null : parseSetRawExpression(parsed.setRaw);
        // The token under either shape — used for resolved_ids echo +
        // dry-run engine input.
        const token = friendly?.token ?? rawParsed?.token;
        /* c8 ignore next 5 — defensive: zod refinement guarantees one
           of friendly / rawParsed is non-null, so token is non-undefined.
           The guard exists for `noUncheckedIndexedAccess` narrowing. */
        if (token === undefined) {
          throw new UsageError('item set: token narrowing failed');
        }

        const boardId = await resolveBoardId({
          client,
          itemId: parsed.itemId,
          explicit: parsed.board,
        });

        // Resolution contexts. `MONDAY_TIMEZONE` env override threads
        // to date.parseDateInput per cli-design §5.3 line 765;
        // `resolveMe` + `resolveEmail` cover the people branch's
        // `me` token and email-lookup paths per §5.3 line 728-734.
        const { dateResolution, peopleResolution, tagResolution, relationResolution } =
          buildResolutionContexts({ client, ctx, globalFlags });

        if (globalFlags.dryRun) {
          // v0.6-M38 (cli-design §5.3 step 5 "File-column dispatch
          // leg" + D4 closure). Friendly `--set <file-col>=<path>`
          // fires for BOTH dry-run and live paths. The dry-run
          // entry point routes through `planChanges`, which runs
          // column resolution inside the planner; if the resolved
          // column has `type === 'file'`, the translator's
          // `UNSUPPORTED_TABLE.files_shaped` row surfaces
          // `unsupported_column_type` with `details.type: 'file'`
          // + `details.column_id`. The action body catches and
          // rewraps as the D4 dry-run envelope shape (a single-
          // entry `planned_changes` matching M31 `item upload
          // --dry-run` verbatim; size from local `fs.stat()` via
          // `precheckLocalFile`; no file bytes loaded into memory;
          // `meta.source: 'none'`).
          //
          // **Why catch-and-rewrap over upfront column resolution.**
          // First-pass M38 pre-flight fix moved column resolution
          // upfront BEFORE the dry-run / live split, which caused
          // the dry-run envelope's `source` to flip from `'live'`
          // to `'mixed'` on non-file paths via `planChanges`'
          // second resolution hitting cache (caught by
          // `tests/integration/envelope-snapshots.test.ts` as a
          // snapshot regression). The catch-and-rewrap pattern
          // preserves source aggregation semantics for non-file
          // paths (resolution + planner state read happen exactly
          // once via `planChanges`) and only diverts to the D4
          // envelope when the translator's pre-existing
          // files-shaped rejection fires. R-v0.6-NEW-4 documents
          // the shim pattern + alternative trade-offs.
          //
          // `--set-raw <file-col>=<json>` stays REJECTED at
          // `raw-write.ts:translateRawColumnValue` per D3
          // (permanent rejection — Monday's wire has no JSON-shape
          // for `change_column_value` on file columns; the
          // catch-and-rewrap only fires when `!isRaw`).
          let result;
          try {
            result = await planChanges({
              client,
              boardId,
              itemId: parsed.itemId,
              setEntries: friendly === null ? [] : [friendly],
              ...(rawParsed === null ? {} : { rawEntries: [rawParsed] }),
              dateResolution,
              peopleResolution,
              tagResolution,
              relationResolution,
              env: ctx.env,
              noCache: globalFlags.noCache,
            });
          } catch (err) {
            if (
              !isRaw &&
              friendly !== null &&
              err instanceof ApiError &&
              err.code === 'unsupported_column_type' &&
              err.details?.type === 'file'
            ) {
              const columnId = err.details.column_id;
              /* c8 ignore next 4 */
              if (typeof columnId !== 'string') {
                throw err;
              }
              const precheck = await precheckLocalFile(friendly.value);
              emitDryRun({
                ctx,
                programOpts: program.opts(),
                plannedChanges: [
                  {
                    operation: 'add_file_to_column',
                    item_id: parsed.itemId,
                    column_id: columnId,
                    // `file_path` is the **argv-derived** path the
                    // agent passed (relative or absolute) per cli-
                    // design §6.4 + M31 `item upload --dry-run`
                    // sample shape (`./report.pdf`). The resolved
                    // absolute path lives in `details.file_path`
                    // on `usage_error.details.reason:
                    // 'file_not_readable'` / `'file_empty'`
                    // rejections (where it's useful for diagnosing
                    // path-resolution mismatches).
                    file_path: friendly.value,
                    filename: precheck.filename,
                    file_size_bytes: precheck.fileSizeBytes,
                  },
                ],
                // D4: dry-run for the file-column dispatch is
                // local-derived; no wire mutation fires. `'none'`
                // mirrors M31 `item upload --dry-run`.
                source: 'none',
                cacheAgeSeconds: null,
                apiVersion,
              });
              return;
            }
            throw err;
          }
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
            buildColumnArchivedError({
              columnId: resolution.match.column.id,
              columnTitle: resolution.match.column.title,
              columnType: resolution.match.column.type,
              boardId,
            }),
            resolverWarnings,
          );
        }

        // v0.6-M38: file-column dispatch leg on the LIVE path
        // (cli-design §5.3 step 5 "File-column dispatch leg" +
        // `src/api/file-column-set.ts` module docstring). When the
        // resolved column has `type === 'file'` AND the call shape
        // is friendly `--set` (NOT `--set-raw`), the action body
        // branches OFF the JSON-translator path INTO Monday's
        // multipart `add_file_to_column` wire via M31's existing
        // `addFileToColumn` fetcher (wrapped by
        // `executeFileColumnSet` in `src/api/file-column-set.ts`).
        //
        // The `--set-raw <file-col>=<json>` rejection stays
        // unchanged per D3 — `translateRawColumnValue` (below)
        // surfaces `unsupported_column_type` for files-shaped types
        // because Monday's wire has no JSON-shape for
        // `change_column_value` on file columns.
        if (resolution.match.column.type === 'file' && !isRaw) {
          /* c8 ignore next 3 — defensive: !isRaw means friendly is
             non-null per the discriminator above; type-narrow for TS. */
          if (friendly === null) {
            throw new UsageError('item set: friendly narrowing failed (file dispatch)');
          }
          // Local file pre-check via `precheckLocalFile` (lifted at
          // R-v0.6-NEW-1; 3-consumer helper). Runs AFTER column
          // resolution + archive check so a non-`file` column or
          // archived-column rejection doesn't pay for the stat call
          // — mirrors M31 `item upload`'s "pre-check before bytes"
          // discipline (the bytes load happens inside
          // `executeFileColumnSet` via `buildBlobFromPath`).
          const precheck = await precheckLocalFile(friendly.value);
          const result = await executeFileColumnSet({
            client,
            multipart,
            itemId: parsed.itemId,
            entry: {
              columnId: resolution.match.column.id,
              columnType: 'file',
              rawValue: friendly.value,
              filePath: precheck.filePath,
              filename: precheck.filename,
              fileSizeBytes: precheck.fileSizeBytes,
            },
            signal: ctx.signal,
            retries: globalFlags.retry,
          });
          // §8 single-leg cache invalidation. Fired BEFORE
          // `emitMutation` so a cache-unlink failure surfaces
          // through the runner's catch-all rather than double-
          // emitting after the success envelope already hit stdout
          // (mirrors M31 `item upload`'s ordering per the §8
          // single-leg invalidation pattern).
          await invalidateBoard(boardId, ctx.env);
          const data: FileColumnSetOutput = {
            operation: 'add_file_to_column',
            item_id: parsed.itemId,
            column_id: resolution.match.column.id,
            filename: precheck.filename,
            file_size_bytes: precheck.fileSizeBytes,
            asset: result.asset,
          };
          emitMutation({
            ctx,
            data,
            schema: fileColumnSetOutputSchema,
            programOpts: program.opts(),
            warnings: resolverWarnings.map((w) => ({
              code: w.code,
              message: w.message,
              details: w.details,
            })),
            ...toEmit({
              data: result.asset,
              complexity: result.complexity,
              stats: { attempts: 1, totalBackoffMs: 0 },
            }),
            source: 'live',
            cacheAgeSeconds: null,
            complexity: result.complexity,
            resolvedIds: { [token]: resolution.match.column.id },
          });
          return;
        }

        // Translator + mutation-selection + live mutation all share
        // the same resolver-warnings preservation rule. Any typed
        // failure (UsageError from date/dropdown/people invalid
        // input, ApiError(validation_failed) from Monday on the
        // mutation) gets the collected collision /
        // stale_cache_refreshed warnings folded into
        // details.resolver_warnings — pass-1 finding F2 widened the
        // fold from ApiError-only to MondayCliError to cover the
        // full error surface. M8: --set-raw branch uses the same
        // shape — `translateRawColumnValue` runs the read-only-
        // forever / files-shaped reject lists, then dispatch.
        let translated: TranslatedColumnValue;
        let mutationResult;
        try {
          if (isRaw) {
            /* c8 ignore next 4 — defensive: isRaw === true means
               rawParsed is non-null per the discriminator above. */
            if (rawParsed === null) {
              throw new UsageError('item set: rawParsed narrowing failed');
            }
            translated = translateRawColumnValue(
              {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
              },
              rawParsed.value,
              rawParsed.rawJson,
            );
          } else {
            /* c8 ignore next 4 — defensive: isRaw === false means
               friendly is non-null per the discriminator above. */
            if (friendly === null) {
              throw new UsageError('item set: friendly narrowing failed');
            }
            translated = await translateColumnValueAsync({
              column: {
                id: resolution.match.column.id,
                type: resolution.match.column.type,
                // M19+: relation/dependency translators (Commit 3 / 4)
                // read `column.settingsStr` for allowed-board derivation.
                // Always passed even on `item set` (single-column verb)
                // so a board_relation / dependency target on this path
                // resolves the same way the multi-target paths do.
                settingsStr: resolution.match.column.settings_str,
              },
              value: friendly.value,
              dateResolution,
              peopleResolution,
              tagResolution,
              relationResolution,
            });
          }
          const mutation: SelectedMutation = selectMutation([translated]);
          mutationResult = await executeMutation(client, {
            mutation,
            itemId: parsed.itemId,
            boardId,
          });
        } catch (err) {
          if (err instanceof MondayCliError) {
            throw await foldAndRemap({
              err,
              warnings: resolverWarnings,
              client,
              boardId,
              columnIds: [resolution.match.column.id],
              env: ctx.env,
              noCache: globalFlags.noCache,
              resolutionSource: resolution.source,
            });
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

        // Source aggregation across three legs (M19 widening of the
        // pre-M19 column-resolution-only path):
        //   1. Column metadata resolution (cache | live | mixed).
        //   2. Translator resolution. `tags` reads the per-account
        //      directory; `people` (M19→M20 cleanup-window) threads
        //      `userByEmail`'s per-leg source (`me` always 'live',
        //      each email per cache hit/miss); relation translators
        //      are always live. Carried on
        //      `translated.translatorResolution`; `null` for
        //      translators with no cache leg (date / status /
        //      dropdown / simple types / link / email / phone /
        //      --set-raw escape).
        //   3. The mutation itself — always live.
        // mergeSource handles the precedence: any 'live' + 'cache'
        // mix produces 'mixed'; any 'live' alone stays 'live'.
        let aggSource: 'live' | 'cache' | 'mixed' = resolution.source;
        const translatorSource = translated.translatorResolution?.source ?? null;
        if (translatorSource !== null) {
          aggSource = mergeSource(aggSource, translatorSource);
        }
        // The mutation is always live — fold it in last.
        aggSource = mergeSource(aggSource, 'live');
        const aggCacheAge = mergeCacheAge(
          resolution.cacheAgeSeconds,
          translated.translatorResolution?.cacheAgeSeconds ?? null,
        );

        emitMutation({
          ctx,
          data: mutationResult.projected,
          schema: itemSetCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(mutationResult.response),
          source: aggSource,
          cacheAgeSeconds: aggCacheAge,
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
    assertResponseFieldPresent({
      data: response.data,
      key: 'change_simple_column_value',
      operationLabel: 'ItemSetSimple',
      details: { item_id: itemId, board_id: boardId },
      nullHandling: 'caller_handles',
    });
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
    assertResponseFieldPresent({
      data: response.data,
      key: 'change_column_value',
      operationLabel: 'ItemSetRich',
      details: { item_id: itemId, board_id: boardId },
      nullHandling: 'caller_handles',
    });
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

// Thin wrapper around `api/item-mutation-result.ts projectMutationItem`
// (R28). M5b chose `internal_error` + "no item payload" to flag a
// mutation that succeeded server-side but returned an empty payload
// (rare server-side glitch); M10's destructive verbs use `not_found`
// for Monday's idiomatic null-for-missing behaviour. Both shapes flow
// through the shared helper; the wrapper preserves M5b's call-site
// signature so update-/clear-/set-style call sites stay untouched.
const projectMutationItem = (raw: unknown, itemId: string): ProjectedItem =>
  projectMutationItemShared({
    raw,
    itemId,
    errorCode: 'internal_error',
    errorMessage:
      `Monday returned no item payload from the mutation for id ${itemId}.`,
  });
