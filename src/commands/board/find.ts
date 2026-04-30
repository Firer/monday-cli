/**
 * `monday board find <name>` — name-based lookup against `boards`
 * (`cli-design.md` §5.7).
 *
 * GraphQL: a paged `boards` walk filtered by `--workspace`/`--state`,
 * then `findOne` selects the unique match. Multi-match raises
 * `ambiguous_name` with `details.candidates`; zero matches →
 * `not_found`. `--first` opts into the lowest-ID match, with a
 * `warnings: [{ code: 'first_of_many' }]` entry attached.
 *
 * Why a client-side walk rather than a server-side filter: Monday's
 * `boards` query has no name-substring filter — the only way to
 * find by name is to read every visible board. The walk caps at
 * `--limit-pages × 100` to avoid pathological reads on giant
 * accounts; default 5 pages × 100 = 500 boards. Real-world boards-
 * per-account counts run hundreds in the heaviest cases. Agents
 * that hit the cap can pass `--workspace <wid>` to narrow.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { findOne } from '../../api/resolvers.js';
import { WorkspaceIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import { walkPages } from '../../api/walk-pages.js';
import type { Warning } from '../../utils/output/envelope.js';

const BOARD_FIND_QUERY = `
  query BoardFind(
    $limit: Int
    $page: Int
    $workspaceIds: [ID]
    $state: State
  ) {
    boards(
      limit: $limit
      page: $page
      workspace_ids: $workspaceIds
      state: $state
    ) {
      id
      name
      description
      state
      board_kind
      workspace_id
      url
    }
  }
`;

const boardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    state: z.string().nullable(),
    board_kind: z.string().nullable(),
    workspace_id: z.string().nullable(),
    url: z.string().nullable(),
  })
  .strict();

export const boardFindOutputSchema = boardSchema;
export type BoardFindOutput = z.infer<typeof boardFindOutputSchema>;

const inputSchema = z
  .object({
    name: z.string().min(1),
    workspace: WorkspaceIdSchema.optional(),
    state: z.enum(['active', 'archived', 'deleted', 'all']).optional(),
    first: z.boolean().optional(),
    limitPages: z.coerce.number().int().positive().max(50).optional(),
  })
  .strict();

interface RawBoards {
  readonly boards: readonly unknown[] | null;
}

const PAGE_SIZE = 100;
const DEFAULT_PAGES = 5;

export const boardFindCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardFindOutput
> = {
  name: 'board.find',
  summary: 'Find a single board by name (uses findOne semantics)',
  examples: [
    'monday board find "Refactor login"',
    'monday board find "Roadmap" --workspace 12345',
    'monday board find "Many matches" --first --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardFindOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('find <name>')
      .description(boardFindCommand.summary)
      .option('--workspace <wid>', 'restrict scope to one workspace')
      .option('--state <s>', 'active|archived|deleted|all (default active)')
      .option('--first', 'on multiple matches, pick the lowest-ID match')
      .option(
        '--limit-pages <n>',
        `how many 100-board pages to scan (default ${String(DEFAULT_PAGES)})`,
      )
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardFindCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (name: unknown, opts: unknown) => {
        const parsed = parseArgv(boardFindCommand.inputSchema, {
          name,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, toEmit } = resolveClient(ctx, program.opts());

        const cap = parsed.limitPages ?? DEFAULT_PAGES;
        const walked = await walkPages<unknown, RawBoards>({
          fetchPage: (page) => {
            const variables: Record<string, unknown> = {
              limit: PAGE_SIZE,
              page,
            };
            if (parsed.workspace !== undefined) {
              variables.workspaceIds = [parsed.workspace];
            }
            if (parsed.state !== undefined) variables.state = parsed.state;
            return client.raw<RawBoards>(BOARD_FIND_QUERY, variables, {
              operationName: 'BoardFind',
            });
          },
          extractItems: (r) => r.data.boards ?? [],
          pageSize: PAGE_SIZE,
          all: true,
          maxPages: cap,
        });
        const lastResponse = walked.lastResponse;

        // Strict-parse the haystack so a malformed response surfaces
        // as `internal_error` from the runner — mirrors how every
        // other M3 list-shaped command behaves.
        const haystack = z.array(boardSchema).parse(walked.items);

        const result = findOne(
          haystack,
          parsed.name,
          (b) => ({ id: b.id, name: b.name }),
          {
            kind: 'board',
            ...(parsed.first === undefined ? {} : { first: parsed.first }),
          },
        );

        const warnings: Warning[] = [];
        if (result.firstOfMany) {
          warnings.push({
            code: 'first_of_many',
            message: `--first picked one of ${String(result.candidates.length)} matches`,
            details: {
              candidates: result.candidates.map((c) => ({ id: c.id, name: c.name })),
            },
          });
        }

        emitSuccess({
          ctx,
          data: result.resource,
          schema: boardFindCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(lastResponse),
        });
      });
  },
};
