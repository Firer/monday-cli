/**
 * `monday board describe <bid>` — full board schema (`cli-design.md`
 * §4.3, §11.2).
 *
 * The CLI's introspection endpoint for one board: every column with
 * its parsed `settings_str`, every group, the workspace + folder
 * pointers, hierarchy info (`hierarchy_type` / `is_leaf` — both raw
 * GraphQL because the SDK doesn't type them in 14.0.0), plus a per-
 * writable-column `example_set` so an agent can construct
 * `--set <token>=<value>` calls without consulting Monday's docs.
 *
 * Reads through `loadBoardMetadata` (cache-aware). The `example_set`
 * is fully derivable from `column.type` + `settings_str` so the
 * shape lives here, not in `board-metadata.ts` — that module stays
 * focused on the cache projection.
 *
 * Idempotent: yes.
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitSuccess } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { BoardIdSchema } from '../../types/ids.js';
import { parseArgv } from '../parse-argv.js';
import {
  loadBoardMetadata,
  type BoardColumn,
} from '../../api/board-metadata.js';

/**
 * v0.1 writable column types per `cli-design.md` §5.3 step 3 + §6.5
 * `unsupported_column_type`. Anything outside this allowlist gets
 * `example_set: null` + `unsupported: true` in `describe` output —
 * agents see immediately whether a `--set` call would work.
 */
const WRITABLE_TYPES = new Set<string>([
  'text',
  'long_text',
  'numbers',
  'status',
  'dropdown',
  'date',
  'people',
]);

interface StatusSettings {
  readonly labels?: Readonly<Record<string, string>>;
}

interface DropdownSettings {
  readonly labels?: readonly { readonly id: number; readonly name: string }[];
}

const tryParse = (raw: string | null): unknown => {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/**
 * Exported for unit testing. Produces a per-column suggestion list
 * the agent can copy-paste as `--set` flags. Returns `null` for
 * non-writable column types so the M3 exit's "writable + non-writable
 * round-trip" can be asserted.
 */
export const exampleSetForColumn = (column: BoardColumn): string[] | null => {
  if (!WRITABLE_TYPES.has(column.type)) return null;
  switch (column.type) {
    case 'text':
      return [`--set ${column.id}='Refactor login'`];
    case 'long_text':
      return [`--set ${column.id}='Multi-line\\ndescription text'`];
    case 'numbers':
      return [`--set ${column.id}=42`];
    case 'status': {
      const settings = (tryParse(column.settings_str) ?? {}) as StatusSettings;
      const labels = settings.labels ?? {};
      const labelEntries = Object.entries(labels);
      if (labelEntries.length === 0) {
        return [
          `--set ${column.id}=Done`,
          `--set ${column.id}=1   # by index`,
        ];
      }
      const first = labelEntries[0];
      /* c8 ignore next 6 — defensive: labelEntries was already
         length-checked above, so `first` cannot be undefined. The
         guard exists for `noUncheckedIndexedAccess` narrowing. */
      if (first === undefined) {
        return [
          `--set ${column.id}=Done`,
          `--set ${column.id}=1   # by index`,
        ];
      }
      const [firstIndex, firstLabel] = first;
      return [
        `--set ${column.id}='${firstLabel}'`,
        `--set ${column.id}=${firstIndex}   # by index`,
      ];
    }
    case 'dropdown': {
      const settings = (tryParse(column.settings_str) ?? {}) as DropdownSettings;
      const labels = settings.labels ?? [];
      if (labels.length === 0) {
        return [`--set ${column.id}='Backend,Frontend'`];
      }
      const sample = labels.slice(0, 2).map((l) => l.name).join(',');
      return [
        `--set ${column.id}='${sample}'`,
        `--set ${column.id}='${String(labels[0]?.id ?? 1)}'   # by id`,
      ];
    }
    case 'date':
      return [
        `--set ${column.id}=2026-05-01`,
        `--set ${column.id}=tomorrow`,
        `--set ${column.id}=+3d`,
      ];
    case 'people':
      return [
        `--set ${column.id}=alice@example.com`,
        `--set ${column.id}=me`,
      ];
    /* c8 ignore next 2 — unreachable: WRITABLE_TYPES gates the entry,
       so any column.type that lands here is one of the cases above. */
    default:
      return null;
  }
};

const describeColumnSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    type: z.string(),
    description: z.string().nullable(),
    archived: z.boolean().nullable(),
    width: z.number().nullable(),
    settings: z.unknown().nullable(),
    writable: z.boolean(),
    example_set: z.array(z.string()).nullable(),
  })
  .strict();

const describeGroupSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    color: z.string().nullable(),
    position: z.string().nullable(),
    archived: z.boolean().nullable(),
    deleted: z.boolean().nullable(),
  })
  .strict();

export const boardDescribeOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    state: z.string().nullable(),
    board_kind: z.string().nullable(),
    workspace_id: z.string().nullable(),
    board_folder_id: z.string().nullable(),
    url: z.string().nullable(),
    hierarchy_type: z.string().nullable(),
    is_leaf: z.boolean().nullable(),
    updated_at: z.string().nullable(),
    columns: z.array(describeColumnSchema),
    groups: z.array(describeGroupSchema),
  })
  .strict();

export type BoardDescribeOutput = z.infer<typeof boardDescribeOutputSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    includeArchived: z.boolean().optional(),
  })
  .strict();

export const boardDescribeCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardDescribeOutput
> = {
  name: 'board.describe',
  summary: 'Full board schema — columns, groups, hierarchy, example_set per writable column',
  examples: [
    'monday board describe 12345',
    'monday board describe 12345 --json --include-archived',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardDescribeOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('describe <boardId>')
      .description(boardDescribeCommand.summary)
      .option('--include-archived', 'show archived columns / groups')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardDescribeCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardDescribeCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        const result = await loadBoardMetadata({
          client,
          boardId: parsed.boardId,
          env: ctx.env,
          noCache: globalFlags.noCache,
        });

        const includeArchived = parsed.includeArchived ?? false;
        const cols = includeArchived
          ? result.metadata.columns
          : result.metadata.columns.filter((c) => c.archived !== true);
        const groups = includeArchived
          ? result.metadata.groups
          : result.metadata.groups.filter(
              (g) => g.archived !== true && g.deleted !== true,
            );

        const data: BoardDescribeOutput = {
          id: result.metadata.id,
          name: result.metadata.name,
          description: result.metadata.description,
          state: result.metadata.state,
          board_kind: result.metadata.board_kind,
          workspace_id: result.metadata.workspace_id,
          board_folder_id: result.metadata.board_folder_id,
          url: result.metadata.url,
          hierarchy_type: result.metadata.hierarchy_type,
          is_leaf: result.metadata.is_leaf,
          updated_at: result.metadata.updated_at,
          columns: cols.map((c) => ({
            id: c.id,
            title: c.title,
            type: c.type,
            description: c.description,
            archived: c.archived,
            width: c.width,
            settings: tryParse(c.settings_str),
            writable: WRITABLE_TYPES.has(c.type),
            example_set: exampleSetForColumn(c),
          })),
          groups: groups.map((g) => ({
            id: g.id,
            title: g.title,
            color: g.color,
            position: g.position,
            archived: g.archived,
            deleted: g.deleted,
          })),
        };

        ctx.meta.setSource(result.source);
        emitSuccess({
          ctx,
          data,
          schema: boardDescribeCommand.outputSchema,
          programOpts: program.opts(),
          source: result.source,
          apiVersion,
          complexity: result.complexity,
          cacheAgeSeconds: result.cacheAgeSeconds,
        });
      });
  },
};
