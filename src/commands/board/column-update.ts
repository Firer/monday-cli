/**
 * `monday board column-update <bid> <cid> [--title <t>]
 * [--description <d>] [--dry-run]` — change one or more column fields
 * (`cli-design.md` §4.3 line 1004, `v0.2-plan.md` §3 M16).
 *
 * **Wire shape — per-attribute fan-out across two surfaces.** Monday's
 * column-update API splits across `change_column_title(board_id,
 * column_id, title)` for `--title` and `change_column_metadata(
 * board_id, column_id, column_property?: ColumnProperty, value?:
 * String)` for `--description`. Both arguments on `change_column_
 * metadata` are optional at the wire (SDK 14.0.0 `MutationChange_
 * Column_MetadataArgs`); the CLI always supplies both whenever
 * `--description` is provided (`column_property: description`,
 * `value: <description>`). The `ColumnProperty` enum (SDK 14.0.0)
 * carries only `title` / `description` values; the CLI routes
 * `--title` to `change_column_title` (the more specific Monday
 * surface) rather than to `change_column_metadata({column_property:
 * title})`. Multi-flag invocations fan out N sequential wire calls
 * (sequential per §8 decision 8 — parallel waits for v0.4
 * `--concurrency`).
 *
 * **Whole-call envelope — no partial-success leak.** The envelope is
 * `ok: true` only when EVERY per-field call succeeded; on any per-
 * field failure the envelope is `ok: false` with the failed call's
 * error code. Mirrors `board update`'s contract from M15.
 *
 * **Live-path partial-application caveat.** Server-side state is NOT
 * transactional across per-attribute mutations: if call #1 succeeds
 * and call #2 fails, fields from #1 stay committed and are NOT
 * rolled back. Agents re-issuing after failure should re-read the
 * column to see what landed before retrying the unapplied tail.
 *
 * **Data projects from the trailing call (no force-live read leg).**
 * Monday's column-mutation responses return `Maybe<Column>` post-
 * mutation, so the trailing call's response is authoritative for
 * both fields — distinguishing column-update from `board update`
 * (which forces-live because its wire response is per-attribute
 * and a final whole-board read is needed for the projection).
 *
 * **Argv discipline.** At least one of `--title` / `--description` is
 * required — zero-flag invocation surfaces as `usage_error` (exit 1)
 * at argv-parse, before any network leg. Mirrors `board update`'s
 * "at least one of --name / --description required" rule.
 *
 * **Dry-run shape** per cli-design §6.4 column-update variant: a
 * field-level `from → to` diff per provided field. The `from` state
 * requires a preflight `board describe`-shaped read — routed
 * through `loadBoardMetadata` so cache hits are observable;
 * `meta.source: 'live' | 'cache'`. When the board doesn't exist
 * the preflight surfaces `not_found` (exit 2). When the column ID
 * isn't on the board, the dry-run surfaces `not_found` with
 * `details.column_id`. Cache-staleness caveat: the `from` snapshot
 * may lag live state up to the cache TTL; pass `--no-cache` for a
 * force-live preflight when preview freshness is critical.
 *
 * **Eager invalidation** (cli-design §8 fan-out call-site contract).
 * After the per-attribute loop settles, `invalidateBoard(boardId)`
 * fires ONCE — conditional on at least one per-attribute call having
 * succeeded (the wire-state high-water mark). On whole-call success
 * this is the same trigger as the single-leg case; on whole-call
 * partial-application failure (call N+1 fails after call N
 * succeeded), invalidation still fires because the cache must
 * reflect the partially-applied server state. Zero-legs-succeeded
 * skips invalidation (server state unchanged). The contract
 * generalises cleanly to N-leg fan-out by gating on the loop's
 * high-water-mark counter rather than per-call timing.
 *
 * **Idempotent: yes.** Re-applying the same field values is a no-op
 * on Monday's side. NOT destructive (no `--yes` gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, ColumnIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { withBoardInvalidationFanOut } from '../../api/board-mutation-invalidation.js';
import { findBoardChildOrThrow } from '../../api/board-child-finder.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  COLUMN_FIELDS_FRAGMENT,
  columnProjectionSchema,
  projectMutationColumn,
  type ColumnProjection,
} from '../../api/column-mutation-result.js';

const CHANGE_COLUMN_TITLE_MUTATION = `
  mutation ColumnChangeTitle($boardId: ID!, $columnId: String!, $title: String!) {
    change_column_title(board_id: $boardId, column_id: $columnId, title: $title) {
      ${COLUMN_FIELDS_FRAGMENT}
    }
  }
`;

const CHANGE_COLUMN_METADATA_MUTATION = `
  mutation ColumnChangeMetadata(
    $boardId: ID!,
    $columnId: String!,
    $columnProperty: ColumnProperty!,
    $value: String!
  ) {
    change_column_metadata(
      board_id: $boardId,
      column_id: $columnId,
      column_property: $columnProperty,
      value: $value
    ) {
      ${COLUMN_FIELDS_FRAGMENT}
    }
  }
`;

export const boardColumnUpdateOutputSchema = columnProjectionSchema;
export type BoardColumnUpdateOutput = ColumnProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    // Column ids are non-numeric slug strings (e.g. `status_4`,
    // `text__1`); the branded `ColumnIdSchema` in `types/ids.ts`
    // owns the slug-shape `min(1)` regex + the nominal brand so
    // a future caller can't confuse a ColumnId with a GroupId at
    // the type level.
    columnId: ColumnIdSchema,
    title: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--title must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
    description: z.string().optional(),
  })
  .strict()
  .refine((v) => v.title !== undefined || v.description !== undefined, {
    message: 'column update requires at least one of --title / --description',
  });

const titleResponseSchema = z
  .object({
    change_column_title: z.unknown(),
  })
  .loose();

const metadataResponseSchema = z
  .object({
    change_column_metadata: z.unknown(),
  })
  .loose();

interface FieldDiff {
  readonly from: unknown;
  readonly to: unknown;
}

// Deterministic dispatch order: title first, then description. The
// iteration order isn't observable on whole-call success (single
// envelope) but IS observable on partial-application failure
// (server-side state shows fields applied in order before the
// failure). Mirrors `board update`'s FIELD_DISPATCH_ORDER pin.
const FIELD_DISPATCH_ORDER = ['title', 'description'] as const;
type FanOutField = (typeof FIELD_DISPATCH_ORDER)[number];

interface DispatchEntry {
  readonly field: FanOutField;
  readonly value: string;
}

export const boardColumnUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardColumnUpdateOutput
> = {
  name: 'board.column-update',
  summary: 'Update one or more fields of a column',
  examples: [
    'monday board column-update 12345 status_4 --title "Priority"',
    'monday board column-update 12345 status_4 --description "Owner-set urgency"',
    'monday board column-update 12345 status_4 --title "Priority" --description "Owner-set urgency"',
    'monday board column-update 12345 status_4 --title "Preview" --dry-run --json',
  ],
  // Re-applying the same field values is a server-side no-op — safe
  // to retry on transient failure. Mirrors `board update`'s rationale.
  idempotent: true,
  inputSchema,
  outputSchema: boardColumnUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('column-update <boardId> <columnId>')
      .description(boardColumnUpdateCommand.summary)
      .option('--title <t>', 'new column title')
      .option('--description <d>', 'new column description')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardColumnUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, columnId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardColumnUpdateCommand.inputSchema, {
          boardId,
          columnId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const trimmedTitle = parsed.title?.trim();

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight `boards(ids:)` read via loadBoardMetadata so
          // the v0.1 board-metadata cache can serve fresh entries.
          // `meta.source: 'live' | 'cache'`. Cache-staleness caveat:
          // `from` values may lag up to TTL; agents pass `--no-cache`
          // when preview freshness is critical.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          // R51 lift — `findBoardChildOrThrow` consolidates the
          // board-level read succeeded but the column ID isn't on
          // the board → not_found-with-details.column_id carve-out
          // shared with `group-update` + `group-archive`.
          const current = findBoardChildOrThrow({
            metadata: preflight.metadata,
            kind: 'columns',
            id: parsed.columnId,
            boardId: parsed.boardId,
          });

          const diff: Record<string, FieldDiff> = {};
          if (trimmedTitle !== undefined) {
            diff.title = { from: current.title, to: trimmedTitle };
          }
          if (parsed.description !== undefined) {
            diff.description = {
              from: current.description,
              to: parsed.description,
            };
          }

          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'update_column',
                board_id: parsed.boardId,
                column_id: parsed.columnId,
                diff,
              },
            ],
            source: preflight.source,
            cacheAgeSeconds: preflight.cacheAgeSeconds,
            warnings: [],
            apiVersion,
          });
          return;
        }

        // Live path. Build the dispatch plan in deterministic order
        // (title → description) so partial-application failure modes
        // are testable.
        const dispatchPlan: DispatchEntry[] = [];
        for (const field of FIELD_DISPATCH_ORDER) {
          if (field === 'title' && trimmedTitle !== undefined) {
            dispatchPlan.push({ field: 'title', value: trimmedTitle });
          } else if (
            field === 'description' &&
            parsed.description !== undefined
          ) {
            dispatchPlan.push({ field: 'description', value: parsed.description });
          }
        }
        /* c8 ignore next 6 */
        if (dispatchPlan.length === 0) {
          throw new UsageError(
            'column update requires at least one of --title / --description',
            { details: { board_id: parsed.boardId, column_id: parsed.columnId } },
          );
        }

        // Fan-out: per-attribute calls in order. The R46 helper
        // (`withBoardInvalidationFanOut`) owns the §8 high-water-
        // mark counter and the post-loop invalidation gate; the
        // closure here just calls `recordLegSuccess()` after each
        // successful leg and returns `{data, response}` for the
        // emitMutation step below. The trailing per-attribute
        // call's response is authoritative for the projection AND
        // for `meta.request_id` / complexity.
        const { data: projected, response: lastResponse } =
          await withBoardInvalidationFanOut({
            boardId: parsed.boardId,
            env: ctx.env,
            runFanOut: async ({ recordLegSuccess }) => {
              let lastProjected: ColumnProjection | undefined;
              let trailingResponse:
                | Awaited<ReturnType<typeof client.raw<unknown>>>
                | undefined;
              for (const entry of dispatchPlan) {
                if (entry.field === 'title') {
                  const response = await client.raw<unknown>(
                    CHANGE_COLUMN_TITLE_MUTATION,
                    {
                      boardId: parsed.boardId,
                      columnId: parsed.columnId,
                      title: entry.value,
                    },
                    { operationName: 'ColumnChangeTitle' },
                  );
                  const data = unwrapOrThrow(
                    titleResponseSchema.safeParse(response.data),
                    {
                      context: 'Monday returned a malformed ColumnChangeTitle response',
                      details: {
                        board_id: parsed.boardId,
                        column_id: parsed.columnId,
                      },
                      hint:
                        "this is a data-integrity error in Monday's response; " +
                        'verify the mutation response shape and update the schema ' +
                        "if Monday's contract has changed.",
                    },
                  );
                  if (!('change_column_title' in data)) {
                    throw new ApiError(
                      'internal_error',
                      `Monday's ColumnChangeTitle response is missing the change_column_title root field`,
                      {
                        details: {
                          board_id: parsed.boardId,
                          column_id: parsed.columnId,
                          hint:
                            "this is a schema-drift error in Monday's GraphQL " +
                            'response; verify the mutation declaration and update ' +
                            "the response schema if Monday's contract has changed.",
                        },
                      },
                    );
                  }
                  // R45 lift: null-payload guard + projection.
                  // column-update's null path uses `not_found`
                  // (Monday's idiomatic missing-or-no-access
                  // response).
                  lastProjected = projectMutationColumn({
                    raw: data.change_column_title,
                    errorCode: 'not_found',
                    errorMessage: `Monday returned no column payload from change_column_title for board ${parsed.boardId} column ${parsed.columnId}`,
                    boardId: parsed.boardId,
                    columnIdKey: 'column_id',
                    columnIdValue: parsed.columnId,
                  });
                  trailingResponse = response;
                  recordLegSuccess();
                } else {
                  const response = await client.raw<unknown>(
                    CHANGE_COLUMN_METADATA_MUTATION,
                    {
                      boardId: parsed.boardId,
                      columnId: parsed.columnId,
                      columnProperty: 'description',
                      value: entry.value,
                    },
                    { operationName: 'ColumnChangeMetadata' },
                  );
                  const data = unwrapOrThrow(
                    metadataResponseSchema.safeParse(response.data),
                    {
                      context: 'Monday returned a malformed ColumnChangeMetadata response',
                      details: {
                        board_id: parsed.boardId,
                        column_id: parsed.columnId,
                      },
                      hint:
                        "this is a data-integrity error in Monday's response; " +
                        'verify the mutation response shape and update the schema ' +
                        "if Monday's contract has changed.",
                    },
                  );
                  if (!('change_column_metadata' in data)) {
                    throw new ApiError(
                      'internal_error',
                      `Monday's ColumnChangeMetadata response is missing the change_column_metadata root field`,
                      {
                        details: {
                          board_id: parsed.boardId,
                          column_id: parsed.columnId,
                          hint:
                            "this is a schema-drift error in Monday's GraphQL " +
                            'response; verify the mutation declaration and update ' +
                            "the response schema if Monday's contract has changed.",
                        },
                      },
                    );
                  }
                  lastProjected = projectMutationColumn({
                    raw: data.change_column_metadata,
                    errorCode: 'not_found',
                    errorMessage: `Monday returned no column payload from change_column_metadata for board ${parsed.boardId} column ${parsed.columnId}`,
                    boardId: parsed.boardId,
                    columnIdKey: 'column_id',
                    columnIdValue: parsed.columnId,
                  });
                  trailingResponse = response;
                  recordLegSuccess();
                }
              }
              // Defensive — TS can't narrow that the success path
              // always sets these (the loop only adds to dispatchPlan
              // when at least one flag is set, and the .refine() on
              // inputSchema enforces ≥1 flag, but the type system
              // doesn't see the cross-block invariant).
              /* c8 ignore next 6 */
              if (lastProjected === undefined || trailingResponse === undefined) {
                throw new ApiError(
                  'internal_error',
                  'column update completed without a trailing wire response — this is a CLI bug',
                  { details: { board_id: parsed.boardId, column_id: parsed.columnId } },
                );
              }
              return { data: lastProjected, response: trailingResponse };
            },
          });

        emitMutation({
          ctx,
          data: projected,
          schema: boardColumnUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(lastResponse),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
