/**
 * `monday update list <iid> [--with-replies]` — list updates (comments)
 * on an item; or `monday update list --board <bid> [--with-replies]`
 * — list every update across a board (M13, `cli-design.md` §4.3 lines
 * 640-643, `v0.2-plan.md` §3 M13).
 *
 * **v0.1 → v0.2 breaking change.** v0.1 silently populated each
 * update's `replies: [...]` array on every call. v0.2 makes the
 * nested selection **opt-in** — without `--with-replies`, every
 * update's `replies: []` is empty. Reason: Monday charges complexity
 * for the nested selection, and most agent flows don't need the
 * thread expansion. Tagged as the only output-shape breaking change
 * in v0.2 (CHANGELOG breaking-changes block + cli-design §4.3).
 *
 * **Two routing modes** (mutually exclusive):
 *   - **Per-item**: positional `<iid>` → `items(ids: [<iid>]).updates`.
 *   - **Per-board**: `--board <bid>` → `boards(ids: [<bid>]).updates`.
 *     Same projection shape; aggregates every update on every item
 *     in the board.
 *
 * Idempotent: yes (read).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { ApiError, UsageError } from '../../utils/errors.js';
import { BoardIdSchema, ItemIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  buildCapWarning,
  DEFAULT_MAX_PAGES,
  walkPages,
} from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

// Two GraphQL query strings — with-replies and without-replies.
// Choosing at action-time keeps the wire-side complexity charge
// linear in --with-replies presence: agents that don't pass the
// flag pay the linear `updates(limit, page)` cost; agents that do
// pay the linear cost + the nested replies fan-out.
const UPDATES_FIELDS_FRAGMENT = `
  id
  body
  text_body
  creator_id
  creator {
    id
    name
    email
  }
  created_at
  updated_at
  edited_at
`;

const UPDATES_REPLIES_FRAGMENT = `
  replies {
    id
    body
    text_body
    creator_id
    created_at
  }
`;

const buildItemQuery = (withReplies: boolean): string => `
  query UpdateList($ids: [ID!], $limit: Int, $page: Int) {
    items(ids: $ids) {
      id
      updates(limit: $limit, page: $page) {
        ${UPDATES_FIELDS_FRAGMENT}
        ${withReplies ? UPDATES_REPLIES_FRAGMENT : ''}
      }
    }
  }
`;

const buildBoardQuery = (withReplies: boolean): string => `
  query UpdateListByBoard($ids: [ID!], $limit: Int, $page: Int) {
    boards(ids: $ids) {
      id
      updates(limit: $limit, page: $page) {
        ${UPDATES_FIELDS_FRAGMENT}
        ${withReplies ? UPDATES_REPLIES_FRAGMENT : ''}
      }
    }
  }
`;

const replySchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    created_at: z.string().nullable(),
  })
  .strict();

const creatorSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    email: z.string(),
  })
  .strict();

const updateSchema = z
  .object({
    id: z.string().min(1),
    body: z.string(),
    text_body: z.string().nullable(),
    creator_id: z.string().nullable(),
    creator: creatorSchema.nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    edited_at: z.string().nullable(),
    replies: z.array(replySchema.nullable()),
  })
  .strict();

export const updateListOutputSchema = z.array(updateSchema);
export type UpdateListOutput = z.infer<typeof updateListOutputSchema>;

const inputSchema = z
  .object({
    itemId: ItemIdSchema.optional(),
    boardId: BoardIdSchema.optional(),
    withReplies: z.boolean().optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
    page: z.coerce.number().int().positive().optional(),
    all: z.boolean().optional(),
    limitPages: z.coerce.number().int().positive().max(500).optional(),
  })
  .strict()
  // Mutual exclusion — exactly one of <iid> positional or --board.
  // Both / neither → usage_error at parse-time.
  .refine((v) => (v.itemId !== undefined) !== (v.boardId !== undefined), {
    message: 'pass exactly one of <itemId> positional or --board <bid>',
  });

type Routing =
  | { readonly kind: 'item'; readonly id: string; readonly query: string }
  | { readonly kind: 'board'; readonly id: string; readonly query: string };

interface RawItemsResponse {
  readonly items?: readonly {
    readonly id?: string;
    readonly updates?: readonly unknown[];
  }[] | null;
}

interface RawBoardsResponse {
  readonly boards?: readonly {
    readonly id?: string;
    readonly updates?: readonly unknown[];
  }[] | null;
}

const extractItemUpdates = (r: { data: RawItemsResponse }): readonly unknown[] =>
  r.data.items?.[0]?.updates ?? [];

const extractBoardUpdates = (
  r: { data: RawBoardsResponse },
): readonly unknown[] => r.data.boards?.[0]?.updates ?? [];

/**
 * If --with-replies isn't passed, the GraphQL query omits the
 * `replies {...}` selection — but the projection still emits
 * `replies: []` per update (one stable shape regardless of the
 * flag, agents key off the same property). This helper enforces
 * the empty default at the projection layer.
 */
const normaliseReplies = (
  raw: readonly unknown[],
  withReplies: boolean,
): readonly unknown[] => {
  if (withReplies) {
    return raw;
  }
  return raw.map((u) => {
    if (typeof u !== 'object' || u === null) {
      return u;
    }
    return { ...(u as Record<string, unknown>), replies: [] };
  });
};

export const updateListCommand: CommandModule<
  z.infer<typeof inputSchema>,
  UpdateListOutput
> = {
  name: 'update.list',
  summary: 'List updates (comments) on an item or across a board',
  examples: [
    'monday update list 5001',
    'monday update list 5001 --with-replies --json',
    'monday update list --board 111 --all --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: updateListOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'update', 'Update (comment) commands');
    noun
      .command('list [itemId]')
      .description(updateListCommand.summary)
      .option('--board <boardId>', 'list every update across the given board (mutually exclusive with positional itemId)')
      .option(
        '--with-replies',
        'populate each update\'s `replies: [...]`. Default: replies omitted (v0.2 breaking change vs v0.1, which silently populated replies on every call)',
      )
      .option('--limit <n>', 'page size (1-100, default 25)')
      .option('--page <n>', '1-indexed page')
      .option('--all', 'walk every page')
      .option(
        '--limit-pages <n>',
        `max pages under --all (1-500, default ${String(DEFAULT_MAX_PAGES)})`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...updateListCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (itemId: unknown, opts: unknown) => {
        const rawOpts = opts as Readonly<Record<string, unknown>>;
        const parsed = parseArgv(updateListCommand.inputSchema, {
          ...(itemId === undefined ? {} : { itemId }),
          // commander stores `--board <boardId>` under `board` —
          // map it onto our `boardId` schema field at the boundary.
          ...(rawOpts.board === undefined ? {} : { boardId: rawOpts.board }),
          // Strip the raw `board` key so the .strict() schema doesn't
          // reject (the schema knows about `boardId`, not `board`).
          ...Object.fromEntries(
            Object.entries(rawOpts).filter(([k]) => k !== 'board'),
          ),
        });
        if (parsed.all === true && parsed.page !== undefined) {
          throw new UsageError('--all and --page are mutually exclusive');
        }
        const withReplies = parsed.withReplies === true;

        // Build the routing entry per mode. The mutual-exclusion
        // refinement on inputSchema guarantees exactly one is set;
        // the runtime check is defensive.
        let routing: Routing;
        if (parsed.itemId !== undefined) {
          routing = {
            kind: 'item',
            id: parsed.itemId,
            query: buildItemQuery(withReplies),
          };
        } else if (parsed.boardId !== undefined) {
          routing = {
            kind: 'board',
            id: parsed.boardId,
            query: buildBoardQuery(withReplies),
          };
        } else {
          // Schema refinement should have caught this. Defensive
          // throw keeps the type narrow without an unsafe cast.
          throw new UsageError(
            'pass exactly one of <itemId> positional or --board <bid>',
          );
        }

        const { client, toEmit } = resolveClient(ctx, program.opts());

        const limit = parsed.limit ?? 25;
        const maxPages = parsed.limitPages ?? DEFAULT_MAX_PAGES;
        let pageCounter = 0;
        const result = await walkPages<unknown, RawItemsResponse | RawBoardsResponse>({
          fetchPage: async (page) => {
            const response = await client.raw<RawItemsResponse | RawBoardsResponse>(
              routing.query,
              { ids: [routing.id], limit, page },
              {
                operationName:
                  routing.kind === 'item' ? 'UpdateList' : 'UpdateListByBoard',
              },
            );
            pageCounter++;
            // First-page not_found handling — distinguish "missing
            // resource" (Monday returns []) from "exists with zero
            // updates" (returns [{...}] with empty `updates`). Same
            // shape v0.1 used; widened to cover the board variant.
            if (pageCounter === 1) {
              const collection =
                routing.kind === 'item'
                  ? (response.data as RawItemsResponse).items ?? []
                  : (response.data as RawBoardsResponse).boards ?? [];
              if (collection.length === 0) {
                throw new ApiError(
                  'not_found',
                  `Monday returned no ${routing.kind} for id ${routing.id}`,
                  routing.kind === 'item'
                    ? { details: { item_id: routing.id } }
                    : { details: { board_id: routing.id } },
                );
              }
            }
            return response;
          },
          extractItems: (r) => {
            const raw =
              routing.kind === 'item'
                ? extractItemUpdates(r as { data: RawItemsResponse })
                : extractBoardUpdates(r as { data: RawBoardsResponse });
            // Normalise replies at the extraction boundary so
            // `--with-replies` absent → every update.replies is [].
            return normaliseReplies(raw, withReplies);
          },
          pageSize: limit,
          all: parsed.all === true,
          startPage: parsed.page ?? 1,
          maxPages,
        });

        const warnings: Warning[] = [];
        if (parsed.all === true && result.hasMore) {
          warnings.push(buildCapWarning(result.pagesFetched));
        }

        emitSuccess({
          ctx,
          data: updateListCommand.outputSchema.parse(result.items),
          schema: updateListCommand.outputSchema,
          programOpts: program.opts(),
          kind: 'collection',
          hasMore: result.hasMore,
          warnings,
          ...toEmit(result.lastResponse),
        });
      });
  },
};
