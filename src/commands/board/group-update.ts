/**
 * `monday board group-update <bid> <gid> [--name <n>] [--color <c>]
 * [--dry-run]` — change one or more group fields (`cli-design.md`
 * §4.3 line 1245, `v0.2-plan.md` §3 M17).
 *
 * **Wire shape — per-attribute fan-out across a single surface.**
 * Monday's `update_group(board_id, group_id, group_attribute:
 * GroupAttributes!, new_value: String!)` per SDK 14.0.0
 * `MutationUpdate_GroupArgs`. Both `group_attribute` and `new_value`
 * are required at the wire (unlike column-update's `change_column_
 * metadata` whose arguments are both optional). Per-attribute fan-
 * out routes every `--name` / `--color` flag through the same
 * mutation with a different `group_attribute` enum value. The
 * `GroupAttributes` enum carries five values total (`title` /
 * `color` / `position` / `relative_position_after` / `relative_
 * position_before`); v0.2 surfaces only `title` (via `--name`) and
 * `color` (via `--color`). M17 deliberately OMITS the position-
 * related flags — `position` is per-changelog deprecated and the
 * literal `top|bottom` semantics through `update_group` are
 * unreliable; repositioning is deferred to v0.3 with `--before
 * <gid>` / `--after <gid>` flags mapping to the non-deprecated
 * `relative_position_after` / `relative_position_before` enum
 * values. Multi-flag invocations fan out N sequential wire calls
 * (sequential per §8 decision 8 — parallel waits for v0.4
 * `--concurrency`).
 *
 * **Whole-call envelope — no partial-success leak.** The envelope
 * is `ok: true` only when EVERY per-field call succeeded; on any
 * per-field failure the envelope is `ok: false` with the failed
 * call's error code. Mirrors `column-update` / `board-update`
 * contract.
 *
 * **Live-path partial-application caveat.** Server-side state is
 * NOT transactional across per-attribute mutations: if call #1
 * succeeds and call #2 fails, fields from #1 stay committed and
 * are NOT rolled back. Agents re-issuing after failure should re-
 * read the group to see what landed before retrying the unapplied
 * tail.
 *
 * **Data projects from the trailing call (no force-live read leg).**
 * Monday's `update_group` returns `Maybe<Group>` post-mutation with
 * the FULL Group projection — the trailing call's response is
 * authoritative for every group-metadata field. Mirrors `column-
 * update`'s no-force-live shape and DIVERGES from `board update`'s
 * force-live shape (board's per-attribute calls return the changed
 * slice only, requiring a final whole-board read leg). This is the
 * load-bearing M17-pre-flight finding (cli-design §6.4 group-update
 * partial-application caveat).
 *
 * **Argv discipline.** At least one of `--name` / `--color` is
 * required — zero-flag invocation surfaces as `usage_error` (exit
 * 1) at argv-parse, before any network leg. Mirrors `column-
 * update`'s rule.
 *
 * **Dry-run shape** per cli-design §6.4 group-update variant: a
 * field-level `from → to` diff per provided field. The `from`
 * state requires a preflight `board describe`-shaped read — routed
 * through `loadBoardMetadata` so cache hits are observable;
 * `meta.source: 'live' | 'cache'`. When the board doesn't exist
 * the preflight surfaces `not_found` (exit 2). When the group ID
 * isn't on the board, the dry-run surfaces `not_found` with
 * `details.group_id`. Cache-staleness caveat: the `from` snapshot
 * may lag live state up to the cache TTL; pass `--no-cache` for a
 * force-live preflight when preview freshness is critical.
 *
 * **Eager invalidation** (cli-design §8 fan-out call-site contract).
 * After the per-attribute loop settles, `invalidateBoard(boardId)`
 * fires ONCE — conditional on at least one per-attribute call
 * having succeeded (the wire-state high-water mark). On whole-call
 * success this is the same trigger as the single-leg case; on
 * whole-call partial-application failure (call N+1 fails after
 * call N succeeded), invalidation still fires because the cache
 * must reflect the partially-applied server state. Zero-legs-
 * succeeded skips invalidation (server state unchanged). The
 * contract generalises cleanly to N-leg fan-out by gating on the
 * loop's high-water-mark counter rather than per-call timing.
 *
 * **Idempotent: yes.** Re-applying the same field values is a
 * no-op on Monday's side (same input leaves same group metadata).
 * NOT destructive (no `--yes` gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema, GroupIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { ApiError } from '../../utils/errors.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { withBoardInvalidationFanOut } from '../../api/board-mutation-invalidation.js';
import { loadBoardMetadata } from '../../api/board-metadata.js';
import {
  GROUP_FIELDS_FRAGMENT,
  groupProjectionSchema,
  projectMutationGroup,
  type GroupProjection,
} from '../../api/group-mutation-result.js';

const UPDATE_GROUP_MUTATION = `
  mutation GroupUpdate(
    $boardId: ID!,
    $groupId: String!,
    $groupAttribute: GroupAttributes!,
    $newValue: String!
  ) {
    update_group(
      board_id: $boardId,
      group_id: $groupId,
      group_attribute: $groupAttribute,
      new_value: $newValue
    ) {
      ${GROUP_FIELDS_FRAGMENT}
    }
  }
`;

export const boardGroupUpdateOutputSchema = groupProjectionSchema;
export type BoardGroupUpdateOutput = GroupProjection;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    // Group ids are stable lower-snake-case slugs ("topics", etc.)
    // — not numeric. Branded `GroupIdSchema` in `types/ids.ts`
    // distinguishes them from ColumnId / BoardId at the type
    // level.
    groupId: GroupIdSchema,
    name: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--name must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
    color: z
      .string()
      .refine((s) => s.trim().length > 0, {
        message: '--color must be non-empty (whitespace-only is rejected)',
      })
      .optional(),
  })
  .strict()
  .refine((v) => v.name !== undefined || v.color !== undefined, {
    message: 'group update requires at least one of --name / --color',
  });

const responseSchema = z
  .object({
    update_group: z.unknown(),
  })
  .loose();

interface FieldDiff {
  readonly from: unknown;
  readonly to: unknown;
}

// Deterministic dispatch order: name (→ title) first, then color.
// The iteration order isn't observable on whole-call success
// (single envelope) but IS observable on partial-application
// failure (server-side state shows fields applied in order before
// the failure). Mirrors `column-update`'s FIELD_DISPATCH_ORDER pin.
const FIELD_DISPATCH_ORDER = ['name', 'color'] as const;
type FanOutField = (typeof FIELD_DISPATCH_ORDER)[number];

interface DispatchEntry {
  readonly field: FanOutField;
  readonly value: string;
  // GroupAttributes enum value — `title` for --name, `color` for
  // --color. Pinned per-entry so a future field addition (e.g.
  // v0.3's --before / --after mapping to relative_position_after /
  // relative_position_before) drops in cleanly.
  readonly groupAttribute: 'title' | 'color';
}

export const boardGroupUpdateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardGroupUpdateOutput
> = {
  name: 'board.group-update',
  summary: 'Update one or more fields of a group',
  examples: [
    'monday board group-update 12345 topics --name "Sprint 42"',
    'monday board group-update 12345 topics --color blue',
    'monday board group-update 12345 topics --name "Sprint 42" --color blue',
    'monday board group-update 12345 topics --name "Preview" --dry-run --json',
  ],
  // Re-applying the same field values is a server-side no-op —
  // safe to retry on transient failure. Mirrors `column-update` /
  // `board update` rationale.
  idempotent: true,
  inputSchema,
  outputSchema: boardGroupUpdateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('group-update <boardId> <groupId>')
      .description(boardGroupUpdateCommand.summary)
      .option('--name <n>', 'new group name (maps to wire group_attribute: title)')
      .option('--color <c>', 'new group color (maps to wire group_attribute: color)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardGroupUpdateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, groupId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardGroupUpdateCommand.inputSchema, {
          boardId,
          groupId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const trimmedName = parsed.name?.trim();
        const trimmedColor = parsed.color?.trim();

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        if (globalFlags.dryRun) {
          // Preflight `boards(ids:)` read via loadBoardMetadata so
          // the v0.1 board-metadata cache can serve fresh entries.
          // `meta.source: 'live' | 'cache'`. Cache-staleness
          // caveat: `from` values may lag up to TTL; agents pass
          // `--no-cache` when preview freshness is critical.
          const preflight = await loadBoardMetadata({
            client,
            boardId: parsed.boardId,
            env: ctx.env,
            noCache: globalFlags.noCache,
          });
          const current = preflight.metadata.groups.find(
            (g) => g.id === parsed.groupId,
          );
          if (current === undefined) {
            // Board-level read succeeded but the group ID isn't on
            // the board — surface not_found with details.group_id
            // so agents distinguish "wrong board id" from "wrong
            // group id" without re-reading. Mirrors `column-update`
            // §6.4 dry-run carve-out.
            throw new ApiError(
              'not_found',
              `Monday returned no group with id ${parsed.groupId} on board ${parsed.boardId}`,
              {
                details: {
                  board_id: parsed.boardId,
                  group_id: parsed.groupId,
                },
              },
            );
          }

          const diff: Record<string, FieldDiff> = {};
          if (trimmedName !== undefined) {
            // Surface the diff key as `name` (the CLI flag name)
            // even though the wire's GroupAttributes value is
            // `title` — agents reading the dry-run shouldn't need
            // to know about the wire-level rename. The current
            // value comes from the cached projection's `title`
            // field.
            diff.name = { from: current.title, to: trimmedName };
          }
          if (trimmedColor !== undefined) {
            diff.color = { from: current.color, to: trimmedColor };
          }

          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'update_group',
                board_id: parsed.boardId,
                group_id: parsed.groupId,
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
        // (name → color) so partial-application failure modes are
        // testable.
        const dispatchPlan: DispatchEntry[] = [];
        for (const field of FIELD_DISPATCH_ORDER) {
          if (field === 'name' && trimmedName !== undefined) {
            dispatchPlan.push({
              field: 'name',
              value: trimmedName,
              groupAttribute: 'title',
            });
          } else if (field === 'color' && trimmedColor !== undefined) {
            dispatchPlan.push({
              field: 'color',
              value: trimmedColor,
              groupAttribute: 'color',
            });
          }
        }

        // Fan-out: per-attribute calls in order. The R46 helper
        // (`withBoardInvalidationFanOut`) owns the §8 high-water-
        // mark counter and the post-loop invalidation gate; the
        // closure here just calls `recordLegSuccess()` after each
        // successful leg and returns `{data, response}` for the
        // emitMutation step below. The trailing per-attribute
        // call's response is authoritative for the projection AND
        // for `meta.request_id` / complexity — Monday's
        // `update_group` returns the FULL Group post-mutation, so
        // no force-live read leg fires (distinguishes group-update
        // from board-update).
        const { data: projected, response: lastResponse } =
          await withBoardInvalidationFanOut({
            boardId: parsed.boardId,
            env: ctx.env,
            runFanOut: async ({ recordLegSuccess }) => {
              let lastProjected: GroupProjection | undefined;
              let trailingResponse:
                | Awaited<ReturnType<typeof client.raw<unknown>>>
                | undefined;
              for (const entry of dispatchPlan) {
                const response = await client.raw<unknown>(
                  UPDATE_GROUP_MUTATION,
                  {
                    boardId: parsed.boardId,
                    groupId: parsed.groupId,
                    groupAttribute: entry.groupAttribute,
                    newValue: entry.value,
                  },
                  { operationName: 'GroupUpdate' },
                );
                const data = unwrapOrThrow(
                  responseSchema.safeParse(response.data),
                  {
                    context: 'Monday returned a malformed GroupUpdate response',
                    details: {
                      board_id: parsed.boardId,
                      group_id: parsed.groupId,
                    },
                    hint:
                      "this is a data-integrity error in Monday's response; " +
                      'verify the mutation response shape and update the schema ' +
                      "if Monday's contract has changed.",
                  },
                );
                if (!('update_group' in data)) {
                  throw new ApiError(
                    'internal_error',
                    `Monday's GroupUpdate response is missing the update_group root field`,
                    {
                      details: {
                        board_id: parsed.boardId,
                        group_id: parsed.groupId,
                        hint:
                          "this is a schema-drift error in Monday's GraphQL " +
                          'response; verify the mutation declaration and update ' +
                          "the response schema if Monday's contract has changed.",
                      },
                    },
                  );
                }
                // R48 lift: null-payload guard + projection. group-
                // update's null path uses `not_found` (Monday's
                // idiomatic missing-or-no-access response).
                lastProjected = projectMutationGroup({
                  raw: data.update_group,
                  errorCode: 'not_found',
                  errorMessage: `Monday returned no group payload from update_group for board ${parsed.boardId} group ${parsed.groupId}`,
                  boardId: parsed.boardId,
                  idKey: 'group_id',
                  idValue: parsed.groupId,
                });
                trailingResponse = response;
                recordLegSuccess();
              }
              // Defensive — TS can't narrow that the success path
              // always sets these (the loop only runs when at
              // least one flag is set, and the .refine() on
              // inputSchema enforces ≥1 flag, but the type system
              // doesn't see the cross-block invariant).
              /* c8 ignore next 6 */
              if (lastProjected === undefined || trailingResponse === undefined) {
                throw new ApiError(
                  'internal_error',
                  'group update completed without a trailing wire response — this is a CLI bug',
                  { details: { board_id: parsed.boardId, group_id: parsed.groupId } },
                );
              }
              return { data: lastProjected, response: trailingResponse };
            },
          });

        emitMutation({
          ctx,
          data: projected,
          schema: boardGroupUpdateCommand.outputSchema,
          programOpts: program.opts(),
          warnings: [],
          ...toEmit(lastResponse),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
