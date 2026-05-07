/**
 * `monday update clear-all <iid> --yes [--dry-run]` — delete every
 * update on an item (`cli-design.md` §4.3 line 702-715,
 * `v0.2-plan.md` §3 M13).
 *
 * **Two-leg flow.** First page-walks `updates(item_id)` via
 * `walkPages` to enumerate every update on the item; then iterates
 * `delete_update(id)` once per collected update. Sequential per
 * v0.2-plan §8 decision 8 — parallel waits for v0.4 `--concurrency`.
 *
 * **Partial-success envelope** (cli-design §6.4 partial-success
 * shape; v0.2-plan §1 universal rule). Whole-call success means the
 * page-walk + dispatch ran, regardless of per-update outcomes —
 * envelope is `ok: true` with `data.results: [{update_id, ok,
 * error?}]`. Top-level `error` reserved for whole-call failure
 * (couldn't reach the API; the page-walk threw before any
 * delete_update fired; the item itself is not_found). `update
 * clear-all` is the FIRST consumer of this shape; M14 / M15 add-
 * users / remove-users reuse it via `dispatchSequential`.
 *
 * **Confirmation gate** (cli-design §3.1 #7 + §10.2). `--yes`
 * mandatory; gate fires before `resolveClient` per the M10 round-1
 * P2 ordering invariant.
 *
 * **Dry-run shape** per cli-design §6.4 update-clear-all variant:
 * page-walks for the would-delete IDs (no `delete_update` fires),
 * emits `{operation: "clear_all_updates", item_id, update_ids:
 * [...]}`. `meta.source: 'live'` — the page-walk fires real reads.
 *
 * **Idempotent: yes** — re-running on an item that's already had
 * its updates cleared produces an empty `results: []` (the page-
 * walk finds zero updates, the dispatch loop runs zero times,
 * envelope is `ok: true` with no per-update records). Mirrors the
 * "ran the dispatch and here are the per-target outcomes" contract
 * — zero outcomes is a valid outcome.
 *
 * **Why per-update fan-out instead of `clear_item_updates`** (the
 * SDK's atomic alternative). Monday DOES expose `clear_item_updates
 * (item_id)` as a single mutation that deletes all updates server-
 * side; the v0.2-plan + this implementation deliberately fan-out
 * because (a) per-update visibility is more useful to agents on
 * partial-permission failures and (b) the partial-success envelope
 * shape M14 / M15 inherit needs a real first consumer. The atomic
 * mutation is logged as a v0.3 optimisation candidate (see M13
 * post-mortem) — landing it requires empirical proof of Monday's
 * atomic-failure semantics.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ItemIdSchema, UpdateIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { parseGlobalFlags } from '../../types/global-flags.js';
import {
  ApiError,
  ConfirmationRequiredError,
} from '../../utils/errors.js';
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import { dispatchSequential } from '../../api/partial-success-mutation.js';
import { SourceAggregator } from '../../api/source-aggregator.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { assertUpdateMutationPresent } from '../../api/update-mutation-result.js';
import type { MondayClient } from '../../api/client.js';
import type { Warning } from '../../utils/output/envelope.js';

const UPDATE_IDS_QUERY = `
  query UpdateClearAllRead($itemIds: [ID!], $limit: Int, $page: Int) {
    items(ids: $itemIds) {
      id
      updates(limit: $limit, page: $page) {
        id
      }
    }
  }
`;

const DELETE_UPDATE_MUTATION = `
  mutation UpdateClearAllDelete($id: ID!) {
    delete_update(id: $id) {
      id
    }
  }
`;

interface UpdateIdsResponse {
  readonly items?: readonly {
    readonly id?: string;
    readonly updates?: readonly { readonly id?: string }[] | null;
  }[] | null;
}

// Per-update record shape: `update_id` (the id-field) + `ok` + an
// optional `error: {code, message}` slot per cli-design §6.4. The
// envelope's `data` is `{results: [...]}` regardless of per-update
// outcomes (whole-call success means dispatch ran).
const errorShape = z
  .object({
    code: z.string().min(1),
    message: z.string(),
  })
  .strict();

const resultRecordSchema = z
  .object({
    update_id: UpdateIdSchema,
    ok: z.boolean(),
    error: errorShape.optional(),
  })
  .strict();

export const updateClearAllOutputSchema = z
  .object({
    results: z.array(resultRecordSchema),
  })
  .strict();

export type UpdateClearAllOutput = z.infer<typeof updateClearAllOutputSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema,
    limitPages: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict();

const PAGE_SIZE = 100;

interface CollectedUpdates {
  readonly ids: readonly string[];
  /**
   * `true` when the page-walker hit `maxPages` on a still-full page.
   * Codex M13 F1: an item with more than `maxPages × PAGE_SIZE`
   * updates would silently truncate without this signal — agent
   * sees `ok: true` and assumes the thread was cleared, while
   * older updates linger.
   */
  readonly hasMore: boolean;
  readonly pagesFetched: number;
}

const collectUpdateIds = async (
  client: MondayClient,
  itemId: string,
  source: SourceAggregator,
  maxPages: number,
): Promise<CollectedUpdates> => {
  let pageCounter = 0;
  const result = await walkPages<{ readonly id: string }, UpdateIdsResponse>({
    fetchPage: async (page) => {
      const response = await client.raw<UpdateIdsResponse>(
        UPDATE_IDS_QUERY,
        { itemIds: [itemId], limit: PAGE_SIZE, page },
        { operationName: 'UpdateClearAllRead' },
      );
      pageCounter++;
      // Read leg fired — record 'live'. cache_age_seconds: null
      // because no cache lookup happened (this is a raw GraphQL read).
      source.record('live', null);
      // Distinguish "item not found" (Monday returns []) from "item
      // exists with no updates" (Monday returns [{...}] with empty
      // `updates`). Mirrors `update list`'s rule (list.ts:158): only
      // the first page can hand a not_found.
      if (pageCounter === 1 && (response.data.items ?? []).length === 0) {
        throw new ApiError(
          'not_found',
          `Monday returned no item for id ${itemId}`,
          { details: { item_id: itemId } },
        );
      }
      return response;
    },
    extractItems: (r) => {
      const updates = r.data.items?.[0]?.updates ?? [];
      return updates.filter(
        (u): u is { readonly id: string } => typeof u.id === 'string',
      );
    },
    pageSize: PAGE_SIZE,
    all: true,
    maxPages,
  });
  return {
    ids: result.items.map((u) => u.id),
    hasMore: result.hasMore,
    pagesFetched: result.pagesFetched,
  };
};

export const updateClearAllCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateClearAllOutput
> = {
  name: 'update.clear-all',
  summary: 'Delete every update on an item — --yes required',
  examples: [
    'monday update clear-all 12345 --yes',
    'monday update clear-all 12345 --dry-run',
    'monday update clear-all 12345 --yes --json',
  ],
  // Idempotent: re-running on an already-cleared item produces empty
  // `data.results` (zero per-target outcomes). The "dispatch ran" half
  // of the contract holds even when the page-walk finds nothing — the
  // envelope still emits `ok: true` with `results: []`.
  idempotent: true,
  inputSchema,
  outputSchema: updateClearAllOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('clear-all <itemId>')
      .description(updateClearAllCommand.summary)
      .option(
        '--limit-pages <n>',
        `max pages to walk for the page-walk leg (1-500, default ${String(DEFAULT_MAX_PAGES)}). On a thread bigger than the cap, the walker surfaces a pagination_cap_reached warning + the live dispatch covers only the collected prefix; agents re-run after the prefix clears.`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateClearAllCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const parsed = parseArgv(updateClearAllCommand.inputSchema, {
          itemId,
          ...(opts as Readonly<Record<string, unknown>>),
        });

        // Gate BEFORE `resolveClient()` — Codex M10 round-1 P2.
        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);
        if (!globalFlags.dryRun && !globalFlags.yes) {
          throw new ConfirmationRequiredError(
            `monday update clear-all ${parsed.itemId} would delete every ` +
              `update on the item. Re-run with --yes to confirm, or ` +
              `--dry-run to preview the would-delete IDs.`,
            {
              details: {
                item_id: parsed.itemId,
                hint:
                  'destructive — clears the entire comment thread. ' +
                  'Monday retains deleted updates in the trash for ~30 ' +
                  'days but exposes no bulk-restore mutation. Per-update ' +
                  'failures land in `data.results[i].error` rather than ' +
                  'aborting the whole call.',
              },
            },
          );
        }

        const { client, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        // Aggregate source across the page-walk + delete legs. Page-
        // walk is always live; per-update deletes are always live;
        // aggregate stays 'live'. cache_age_seconds: null throughout.
        const sourceAgg = new SourceAggregator();
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        const collected = await collectUpdateIds(
          client,
          parsed.itemId,
          sourceAgg,
          maxPages,
        );

        // Codex M13 F1 (P2): the page-walker's `hasMore` signal must
        // surface to the agent. On a thread with more updates than
        // `maxPages × PAGE_SIZE`, the walker truncates and the
        // dispatch only covers the collected prefix; without a
        // warning the agent thinks "all cleared" while older updates
        // linger. Per the v0.1 walkPages contract, surface
        // `pagination_cap_reached` so the agent knows to re-run (or
        // pass `--limit-pages` to extend the cap).
        const warnings: Warning[] = [];
        if (collected.hasMore) {
          warnings.push(buildCapWarning(collected.pagesFetched));
        }

        if (globalFlags.dryRun) {
          // Dry-run: report would-delete IDs after the page-walk.
          // `meta.source: 'live'` because the page-walk fired real
          // reads (the dry-run is a preview-of-state-change, not a
          // preview-of-payload).
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [
              {
                operation: 'clear_all_updates',
                item_id: parsed.itemId,
                update_ids: collected.ids,
              },
            ],
            ...sourceAgg.result(),
            warnings,
            apiVersion,
          });
          return;
        }

        // Live path: sequential `delete_update` per id. Per-update
        // failures captured into `results[i].error` rather than thrown
        // — `dispatchSequential` handles the partial-success
        // discipline so per-target failure doesn't abort the loop.
        let lastResponse: Awaited<
          ReturnType<typeof client.raw>
        > | undefined;
        const results = await dispatchSequential(
          collected.ids,
          'update_id',
          async ({ targetId }) => {
            const response = await client.raw<unknown>(
              DELETE_UPDATE_MUTATION,
              { id: targetId },
              { operationName: 'UpdateClearAllDelete' },
            );
            lastResponse = response;
            sourceAgg.record('live', null);
            // Validate the wire shape per-call so a Monday-side bug
            // (e.g. `delete_update: null`) surfaces as a per-update
            // not_found rather than corrupting the envelope. The
            // result record's `error` slot will pick this up via
            // `dispatchSequential`'s catch arm.
            const data = unwrapOrThrow(
              z
                .object({ delete_update: z.unknown() })
                .loose()
                .safeParse(response.data),
              {
                context:
                  'Monday returned a malformed UpdateClearAllDelete response',
                details: { update_id: targetId },
              },
            );
            // Lift R37 (v0.2-plan §20): null-check-only seam shared
            // with the four full-projection sites (reply / edit /
            // delete / toggle). Clear-all stays narrow because the
            // per-target `DELETE_UPDATE_MUTATION` selects only `{ id }`
            // — projection would force widening the wire payload.
            assertUpdateMutationPresent(data.delete_update, {
              updateId: targetId,
              mutationName: 'delete_update',
            });
          },
        );

        // Emit the one success envelope. `ok: true` even when every
        // per-update delete failed — the call's contract is "I ran
        // the dispatch and here are the per-target outcomes." The
        // emit schema parses through `updateClearAllOutputSchema`
        // which validates the per-record shape (update_id branded,
        // ok boolean, optional error{code, message}); the results
        // array is spread into a mutable shape because zod's parsed
        // type is mutable while `dispatchSequential` returns readonly.
        emitMutation({
          ctx,
          data: updateClearAllOutputSchema.parse({
            results: [...results],
          }),
          schema: updateClearAllCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...(lastResponse === undefined
            ? { apiVersion }
            : toEmit(lastResponse)),
          ...sourceAgg.result(),
        });
      });
  },
};
