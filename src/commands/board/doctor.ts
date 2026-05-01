/**
 * `monday board doctor <bid>` — diagnostics on a board's shape so an
 * agent can fix problems BEFORE they surface as runtime errors
 * (`cli-design.md` §11.2; `v0.1-plan.md` §3 M6).
 *
 * Three diagnostic kinds shipped in v0.1:
 *
 *   1. **`duplicate_column_title`** — groups columns by NFC + case-
 *      folded + whitespace-collapsed title. Any group with ≥2 columns
 *      emits one diagnostic. Same normalisation rule as the §5.3
 *      column resolver — when this fires, agents writing `--set
 *      "<title>"=<value>` get `ambiguous_column` at runtime; this
 *      surfaces the gotcha up front.
 *
 *   2. **`unsupported_column_type`** — for each non-allowlisted
 *      column type, emits one diagnostic keyed by roadmap category
 *      (matches `column-values.ts unsupportedColumnTypeError`'s
 *      three-category split): `v0.2_writer_expansion`, `read_only_
 *      forever`, or `future`. Agents reading `board doctor`'s output
 *      know exactly which columns will fail `item set` / `item
 *      update`, what category each falls into, and whether to expect
 *      a write path in v0.2 vs. never.
 *
 *   3. **`broken_board_relation`** — for each `board_relation`
 *      column, parses `settings_str.boardIds` and queries each
 *      linked board via Monday's `boards(ids:)`. If a linked board
 *      is archived, deleted, or unreachable (the response omits it
 *      because the token has no read permission), emits one
 *      diagnostic per missing target. This catches the
 *      "board_relation column → archived board → silent breakage"
 *      class agents would otherwise discover only when an item
 *      mutation fails.
 *
 * **No `stale_cache` diagnostic in v0.1.** cli-design §11.2 lists
 * "stale cache vs live" as a doctor diagnostic; the `meta.source`
 * + `meta.cache_age_seconds` envelope slots already surface cache
 * provenance (and `board doctor` always force-refreshes so it
 * sees the live state). A genuine cache-drift diagnostic
 * (cache says X, live says Y) is logged for v0.2 backfill.
 *
 * **No bulk diagnostic flag**. `board doctor` runs every
 * diagnostic on every call. Future `--diagnostic <kind>` filters
 * are an additive surface.
 *
 * Idempotent: yes — pure read.
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
  type BoardMetadata,
} from '../../api/board-metadata.js';
import {
  isWritableColumnType,
  getColumnRoadmapCategory,
  parseColumnSettings,
  type ColumnRoadmapCategory,
} from '../../api/column-types.js';
import type { MondayClient } from '../../api/client.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';

/**
 * Per-diagnostic shape. Discriminated by `kind` so consumers can
 * branch on a stable string. `severity` is informational — every
 * doctor diagnostic is non-fatal (a board CAN ship with duplicate
 * column titles; the diagnostic is "this WILL bite when an agent
 * tries to title-resolve"). Agents that key off severity for an
 * exit gate can use the `error` band.
 */
const diagnosticSeverity = z.enum(['info', 'warning', 'error']);

const duplicateColumnTitleDiagnostic = z
  .object({
    kind: z.literal('duplicate_column_title'),
    severity: diagnosticSeverity,
    /** The normalised title that's shared by ≥2 columns. */
    normalised_title: z.string(),
    /** Each column that shares the normalised title. */
    columns: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string(),
            type: z.string().min(1),
          })
          .strict(),
      )
      .min(2),
    message: z.string(),
  })
  .strict();

const unsupportedColumnTypeDiagnostic = z
  .object({
    kind: z.literal('unsupported_column_type'),
    severity: diagnosticSeverity,
    /** The column ID. */
    column_id: z.string().min(1),
    /** The column title (verbatim from board metadata). */
    column_title: z.string(),
    /** The column type Monday reports. */
    column_type: z.string().min(1),
    /** Roadmap category — one of three known values. */
    category: z.enum(['v0.2_writer_expansion', 'read_only_forever', 'future']),
    message: z.string(),
  })
  .strict();

const brokenBoardRelationDiagnostic = z
  .object({
    kind: z.literal('broken_board_relation'),
    severity: diagnosticSeverity,
    /** The board_relation column ID. */
    column_id: z.string().min(1),
    column_title: z.string(),
    /** The linked board IDs that are archived / missing / inaccessible. */
    missing_board_ids: z.array(z.string().min(1)).min(1),
    /** Reason — `archived` (linked board.state === 'archived') or
     * `unreachable` (Monday's response omitted the board, meaning
     * the token has no read permission OR the board doesn't exist). */
    reason: z.enum(['archived', 'deleted', 'unreachable', 'mixed']),
    message: z.string(),
  })
  .strict();

const diagnosticSchema = z.discriminatedUnion('kind', [
  duplicateColumnTitleDiagnostic,
  unsupportedColumnTypeDiagnostic,
  brokenBoardRelationDiagnostic,
]);

export const boardDoctorOutputSchema = z
  .object({
    board_id: z.string().min(1),
    board_name: z.string(),
    /**
     * Total diagnostics fired. Zero means the board is healthy
     * (per the v0.1 diagnostic set). Convenience sum so an agent
     * can short-circuit on `data.total === 0` without iterating.
     */
    total: z.number().int().min(0),
    diagnostics: z.array(diagnosticSchema),
  })
  .strict();

export type BoardDoctorOutput = z.infer<typeof boardDoctorOutputSchema>;
type Diagnostic = z.infer<typeof diagnosticSchema>;

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
  })
  .strict();

/**
 * Same normalisation as the §5.3 column resolver: NFC + trim +
 * case-fold (Unicode-aware) + collapse internal whitespace. Tested
 * across the resolver / filter / writer surfaces; using one
 * function keeps doctor's "duplicate" definition aligned with the
 * runtime's "ambiguous" definition.
 */
const normaliseTitle = (raw: string): string =>
  raw
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase('und')
    .replace(/\s+/gu, ' ');

/**
 * Builds the per-category message for `unsupported_column_type`.
 * Mirrors the runtime error builder's voice so doctor output and
 * `item set` errors agree. Pre-fix the writer-expansion split (Codex
 * M5b cleanup re-review #1), this diagnostic would have called every
 * non-allowlisted type "deferred to v0.2", which doctor faithfully
 * preserves now via the category-keyed switch.
 */
const messageForCategory = (
  type: string,
  category: ColumnRoadmapCategory,
): string => {
  if (category === 'read_only_forever') {
    return (
      `Column type "${type}" is computed by Monday and is not ` +
      `writable via the API regardless of CLI version. Set the ` +
      `underlying source column instead.`
    );
  }
  if (category === 'v0_2_writer_expansion') {
    return (
      `Column type "${type}" is not in the v0.1 friendly translator ` +
      `allowlist. The v0.2 writer-expansion milestone will add it ` +
      `(plus --set-raw).`
    );
  }
  return (
    `Column type "${type}" is not in the v0.1 allowlist or the v0.2 ` +
    `writer-expansion roadmap. Track cli-design.md §5.3 for future ` +
    `coverage.`
  );
};

const collectDuplicateTitles = (
  columns: readonly BoardColumn[],
): readonly Diagnostic[] => {
  const groups = new Map<string, BoardColumn[]>();
  for (const c of columns) {
    if (c.archived === true) continue;
    const key = normaliseTitle(c.title);
    let arr = groups.get(key);
    if (arr === undefined) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(c);
  }
  const result: Diagnostic[] = [];
  for (const [normalised, group] of groups) {
    if (group.length < 2) continue;
    result.push({
      kind: 'duplicate_column_title',
      severity: 'warning',
      normalised_title: normalised,
      columns: group.map((c) => ({ id: c.id, title: c.title, type: c.type })),
      message:
        `Found ${String(group.length)} columns sharing the normalised ` +
        `title "${normalised}". Title-based --set / --where / --filter ` +
        `against this title will surface ambiguous_column; use the ` +
        `explicit id:<column_id> prefix or write to the column ID directly.`,
    });
  }
  return result;
};

const collectUnsupportedTypes = (
  columns: readonly BoardColumn[],
): readonly Diagnostic[] => {
  const result: Diagnostic[] = [];
  for (const c of columns) {
    if (c.archived === true) continue;
    if (isWritableColumnType(c.type)) continue;
    const category = getColumnRoadmapCategory(c.type);
    // Map the internal category enum to the wire-stable label so the
    // doctor output is more readable than `v0_2_writer_expansion`.
    // The underscore form lives in the runtime helper only;
    // diagnostic shape uses the dotted form.
    const wireCategory =
      category === 'v0_2_writer_expansion'
        ? 'v0.2_writer_expansion'
        : category === 'read_only_forever'
          ? 'read_only_forever'
          : 'future';
    result.push({
      kind: 'unsupported_column_type',
      // Severity differs by category. Read-only-forever is "info"
      // because nothing the agent can do will change it; future / v0.2
      // are "warning" because they're temporarily blocked.
      severity: category === 'read_only_forever' ? 'info' : 'warning',
      column_id: c.id,
      column_title: c.title,
      column_type: c.type,
      category: wireCategory,
      message: messageForCategory(c.type, category),
    });
  }
  return result;
};

const BOARD_RELATION_LOOKUP_QUERY = `
  query BoardDoctorRelationLookup($ids: [ID!]!) {
    boards(ids: $ids) {
      id
      name
      state
    }
  }
`;

const boardRelationLookupResponseSchema = z.looseObject({
  boards: z
    .array(
      z
        .object({
          id: BoardIdSchema,
          name: z.string(),
          state: z.string().nullable(),
        })
        .strict(),
    )
    .nullable(),
});

interface LinkedBoardSettings {
  readonly boardIds: readonly string[];
}

/**
 * Defensive parse of `board_relation` settings_str. Monday's shape
 * is `{ "boardIds": [<numeric-string>, ...] }`; older boards may
 * omit the slot entirely. We tolerate both — the doctor only runs
 * the relation lookup when at least one boardId is present.
 */
const extractLinkedBoardIds = (settings: unknown): readonly string[] => {
  if (
    settings === null ||
    typeof settings !== 'object' ||
    Array.isArray(settings)
  ) {
    return [];
  }
  const boardIds = (settings as LinkedBoardSettings).boardIds;
  if (!Array.isArray(boardIds)) return [];
  return boardIds.filter((id): id is string => typeof id === 'string');
};

const collectBrokenBoardRelations = async (
  client: MondayClient,
  metadata: BoardMetadata,
): Promise<readonly Diagnostic[]> => {
  // Build a per-column map of linked-board IDs. Skip archived
  // columns — they're not actionable. Aggregate ALL linked boards
  // into one `boards(ids:)` call so we don't fan out per column.
  const perColumn = new Map<string, readonly string[]>();
  const allIds = new Set<string>();
  for (const c of metadata.columns) {
    if (c.archived === true) continue;
    if (c.type !== 'board_relation') continue;
    const settings = parseColumnSettings(c.settings_str);
    const ids = extractLinkedBoardIds(settings);
    if (ids.length === 0) continue;
    perColumn.set(c.id, ids);
    for (const id of ids) {
      allIds.add(id);
    }
  }
  if (allIds.size === 0) return [];

  const response = await client.raw<unknown>(
    BOARD_RELATION_LOOKUP_QUERY,
    { ids: [...allIds] },
    { operationName: 'BoardDoctorRelationLookup' },
  );
  const data = unwrapOrThrow(
    boardRelationLookupResponseSchema.safeParse(response.data),
    {
      context:
        'Monday returned a malformed BoardDoctorRelationLookup response',
      details: { board_id: metadata.id },
      hint:
        'this is a data-integrity error in Monday\'s response; verify ' +
        'the response shape and update boardRelationLookupResponseSchema ' +
        'if Monday\'s contract has changed.',
    },
  );
  const reachable = new Map<string, { state: string | null }>();
  for (const b of data.boards ?? []) {
    reachable.set(b.id, { state: b.state });
  }

  const result: Diagnostic[] = [];
  for (const [columnId, linkedIds] of perColumn) {
    const archived: string[] = [];
    const unreachable: string[] = [];
    for (const id of linkedIds) {
      const live = reachable.get(id);
      if (live === undefined) {
        unreachable.push(id);
        continue;
      }
      if (live.state === 'archived' || live.state === 'deleted') {
        archived.push(id);
      }
    }
    if (archived.length === 0 && unreachable.length === 0) continue;
    const column = metadata.columns.find((c) => c.id === columnId);
    /* c8 ignore next 5 — defensive: columnId came from the same
       metadata.columns walk that built `perColumn`, so this lookup
       always finds the column. The branch exists to satisfy
       `noUncheckedIndexedAccess` without forcing a non-null
       assertion at every read. */
    if (column === undefined) continue;
    const reason: 'archived' | 'unreachable' | 'mixed' =
      archived.length > 0 && unreachable.length > 0
        ? 'mixed'
        : archived.length > 0
          ? 'archived'
          : 'unreachable';
    result.push({
      kind: 'broken_board_relation',
      severity: 'warning',
      column_id: columnId,
      column_title: column.title,
      missing_board_ids: [...archived, ...unreachable],
      reason,
      message:
        `board_relation column "${column.title}" (${columnId}) links to ` +
        `${String(archived.length + unreachable.length)} board(s) that ` +
        `are not active: ${archived.length > 0 ? `${String(archived.length)} archived/deleted` : ''}${archived.length > 0 && unreachable.length > 0 ? ', ' : ''}${unreachable.length > 0 ? `${String(unreachable.length)} unreachable (token may lack permission, or the board doesn't exist)` : ''}.`,
    });
  }
  return result;
};

export const boardDoctorCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardDoctorOutput
> = {
  name: 'board.doctor',
  summary: 'Diagnose a board for column / relation issues that bite at runtime',
  examples: [
    'monday board doctor 12345',
    'monday board doctor 12345 --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: boardDoctorOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('doctor <boardId>')
      .description(boardDoctorCommand.summary)
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardDoctorCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardDoctorCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const { client, globalFlags, apiVersion } = resolveClient(
          ctx,
          program.opts(),
        );

        // Force-refresh so doctor sees the live state (cache hits
        // would mean diagnostics describe stale data; the whole
        // value of doctor is current correctness).
        const result = await loadBoardMetadata({
          client,
          boardId: parsed.boardId,
          env: ctx.env,
          noCache: globalFlags.noCache,
          refresh: true,
        });

        const dups = collectDuplicateTitles(result.metadata.columns);
        const unsupported = collectUnsupportedTypes(result.metadata.columns);
        const broken = await collectBrokenBoardRelations(client, result.metadata);

        const diagnostics: readonly Diagnostic[] = [
          ...dups,
          ...unsupported,
          ...broken,
        ];

        const data: BoardDoctorOutput = {
          board_id: result.metadata.id,
          board_name: result.metadata.name,
          total: diagnostics.length,
          diagnostics: [...diagnostics],
        };

        // Doctor always force-refreshes; meta.source is always 'live'.
        ctx.meta.setSource('live');
        emitSuccess({
          ctx,
          data,
          schema: boardDoctorCommand.outputSchema,
          programOpts: program.opts(),
          source: 'live',
          apiVersion,
          complexity: result.complexity,
          cacheAgeSeconds: null,
        });
      });
  },
};
