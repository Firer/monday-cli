/**
 * `monday board column-create <bid> --type <type> --title <t>
 * [--description <d>] [--settings <json>] [--dry-run]` — create a new
 * column on a board (`cli-design.md` §4.3 line 875,
 * `v0.2-plan.md` §3 M16).
 *
 * **Wire shape.** Single round-trip via `create_column(board_id,
 * column_type, title, description?, defaults?)`. The CLI flag
 * `--type` maps to the wire's `column_type: ColumnType!`; the CLI
 * flag `--settings <json>` maps to the wire's `defaults: JSON`
 * (NOT `settings_str` — `settings_str` is the read-side
 * serialisation of column settings returned on `Column.settings_str`;
 * `defaults` is the write-side input parameter on `create_column`).
 * The wire mutation also accepts `id?: String` (agent-supplied
 * custom column id) and `after_column_id?: ID` (placement); M16
 * deliberately omits both — agents needing them call the wire
 * mutation via M9's `dev mutate` escape hatch.
 *
 * **`--type` validation.** The full `ColumnType` enum (~40 values)
 * per SDK 14.0.0; see §2.3. Argv-parses against the explicit string
 * literal union below (kept hand-pinned rather than imported from
 * the SDK because the SDK's enum is `declare enum`-shaped and
 * doesn't survive zod's `.enum(...)` constructor cleanly). Adding
 * a Monday-side type is SemVer-minor (this list grows); removing
 * one is SemVer-major.
 *
 * **`noncanonical_column_type` warning** (cli-design §6 stable
 * warning-code registry). When `--type` resolves to a column type
 * outside `WRITABLE_COLUMN_TYPES`, the success / dry-run envelope
 * carries a `noncanonical_column_type` warning so agents pick the
 * right write path from the per-category `suggested_write_path`:
 *   - `raw_writable` → `--set-raw <col>=<json>` (agent reaches for
 *     the v0.2 escape hatch, accepts wire-shape correctness).
 *   - `read_only_forever` → no write path (the column exists only
 *     for read-side display / mirror sources).
 *   - `files_shaped` → four write paths reach `add_file_to_column`
 *     (multipart wire): the v0.6-M38 friendly `--set <file-col>=<path>`
 *     dispatch on `monday item set` / `monday item update <iid>`
 *     (single-item); the v0.7-M42 friendly form on `monday item update
 *     --where ... --set <file-col>=<path>` (bulk per-item fan-out under
 *     `--concurrency` / `--continue-on-error`); the v0.7-M43 friendly
 *     form on `monday item create --set <file-col>=<path>` (create-time
 *     two-leg `create_item` + `add_file_to_column` dispatch under the
 *     §5.8 orphan-warn atomicity envelope); AND the v0.4-M31 verb-
 *     shaped `monday item upload <iid> --column <col> <file>`.
 *     `--set-raw <file-col>=<json>` STAYS REJECTED per D3
 *     (permanent — `change_column_value` has no JSON-shape for file
 *     columns).
 * The command STILL PROCEEDS in all cases — Monday accepts non-
 * writable types and agents may legitimately want them. The
 * categorisation lives in `api/column-types.ts` so the warning
 * shape and `--set-raw`'s reject lists agree on what's read-only-
 * forever / files-shaped.
 *
 * **`--settings <json>` validation.** Parsed at argv-parse-time:
 * malformed JSON → `usage_error` exit 1, before any network call.
 * For types in `WRITABLE_COLUMN_TYPES`, validated against a
 * per-type zod schema (status: `{labels?}`; dropdown: `{labels?}`;
 * numbers: `{unit?}`; board_relation:
 * `{boardIds?, boardId?, allowMultipleItems?, allowCreateReflectionColumn?}`;
 * dependency: `{allowMultipleItems?}` — same-board only, see below;
 * date / text / long_text / people / link / email / phone / tags:
 * empty `{}`). Type-mismatched settings (e.g.
 * `--type text --settings '{"labels":[]}'`) → `usage_error` with
 * `details: {column_type, expected_keys, actual_keys, hint}`.
 * Raw-writable / read-only-forever / files-shaped types skip
 * type-specific validation — `--settings` for these types only
 * requires well-formed JSON (Monday validates server-side).
 *
 * **`board_relation` / `dependency` create-time settings (v0.8-M48).**
 * `--settings '{"boardIds":[123,456]}'` on a `board_relation` column
 * wires the Connect-Boards link at create time. The agent passes the
 * relation config at the TOP level; the CLI wraps it under a
 * `settings` key on the wire (`defaults: {settings: {…}}`) — the M48
 * probe pinned this shape. `boardIds` / `boardId` accept either JSON
 * integers or numeric strings (agents read board IDs as branded
 * strings elsewhere) and coerce to the wire integer. `dependency`
 * diverges: it is **same-board** (Monday coerces an arbitrary target
 * to the host board), so it accepts only `allowMultipleItems`;
 * `boardIds` / `boardId` on a `dependency` `--settings` reject with a
 * `usage_error` pointing at `--type board_relation`. Monday validates
 * board existence server-side (a non-existent target → `not_found`);
 * the CLI does not pre-flight a board-existence read.
 *
 * **Live-envelope projection.** Returned `Maybe<Column>` is projected
 * through `columnProjectionSchema` (the M16 R45-lifted shared shape)
 * via `projectMutationColumn`. Sharing the schema keeps create /
 * update / delete envelopes byte-identical for the same record.
 *
 * **Dry-run shape** per cli-design §6.4 column-create variant:
 * minimal `{operation: "create_column", board_id, type, title,
 * description?, settings?}`. No preflight read fires; the dry-run
 * is purely argv-derived. `meta.source: 'none'`. The
 * `noncanonical_column_type` warning fires on dry-run too so the
 * live call's behaviour is predictable.
 *
 * **Eager invalidation** (cli-design §8 single-leg call-site
 * contract). On success, calls `invalidateBoard(boardId)` AFTER
 * the success envelope's `data` projection completes — never
 * before the wire mutation, never between mutation and projection.
 * Skipped on the error path (a failed single-leg call didn't
 * change board state). The cache entry's stale `columns: [...]`
 * list is dropped so subsequent reads in the same process see
 * fresh state without TTL eviction.
 *
 * **Idempotent: false.** Re-running creates a second column with
 * the same title (Monday auto-generates a fresh column id per
 * call). NOT destructive (no --yes gate).
 */
import { z } from 'zod';
import { ensureSubcommand, type CommandModule } from '../types.js';
import { emitDryRun, emitMutation } from '../emit.js';
import { resolveClient } from '../../api/resolve-client.js';
import { parseArgv } from '../parse-argv.js';
import { UsageError } from '../../utils/errors.js';
import { isPlainObject, parseJsonArg } from '../../utils/json.js';
import { unwrapOrThrow } from '../../utils/parse-boundary.js';
import { BoardIdSchema } from '../../types/ids.js';
import { withBoardInvalidationSingleLeg } from '../../api/board-mutation-invalidation.js';
import {
  COLUMN_FIELDS_FRAGMENT,
  columnProjectionSchema,
  projectMutationColumn,
  type ColumnProjection,
} from '../../api/column-mutation-result.js';
import { assertResponseFieldPresent } from '../../api/response-root.js';
import {
  categorizeNoncanonicalColumnType,
  isWritableColumnType,
  type NoncanonicalColumnTypeCategory,
  type WritableColumnType,
} from '../../api/column-types.js';
import type { Warning } from '../../utils/output/envelope.js';

const CREATE_COLUMN_MUTATION = `
  mutation ColumnCreate(
    $boardId: ID!,
    $columnType: ColumnType!,
    $title: String!,
    $description: String,
    $defaults: JSON
  ) {
    create_column(
      board_id: $boardId,
      column_type: $columnType,
      title: $title,
      description: $description,
      defaults: $defaults
    ) {
      ${COLUMN_FIELDS_FRAGMENT}
    }
  }
`;

export const boardColumnCreateOutputSchema = columnProjectionSchema;
export type BoardColumnCreateOutput = ColumnProjection;

/**
 * The full Monday `ColumnType` enum (SDK 14.0.0; see §2.3 +
 * `node_modules/@mondaydotcomorg/api/dist/esm/lib/generated/sdk.d.ts:560`).
 * Hand-mirrored from the SDK rather than imported because the SDK's
 * `declare enum` shape doesn't compose with zod's `.enum(...)`
 * constructor (zod expects a tuple of string literals; an enum const
 * is a runtime object). Adding a Monday-side type here is SemVer-
 * minor; removing one is SemVer-major.
 *
 * NOT the same set as `WRITABLE_COLUMN_TYPES` — this is "every type
 * Monday's `create_column` accepts on the wire" (the full ColumnType
 * enum), of which `WRITABLE_COLUMN_TYPES` is the v0.2 friendly-
 * translator subset. Types outside the writable allowlist still
 * create successfully (Monday accepts them); the CLI emits a
 * `noncanonical_column_type` warning so agents know to use
 * `--set-raw` / `add_file_to_column` / no-write-at-all per
 * category.
 */
const COLUMN_TYPE_VALUES = [
  'auto_number',
  'board_relation',
  'button',
  'checkbox',
  'color_picker',
  'country',
  'creation_log',
  'date',
  'dependency',
  'doc',
  'dropdown',
  'email',
  'file',
  'formula',
  'group',
  'hour',
  'integration',
  'item_assignees',
  'item_id',
  'last_updated',
  'link',
  'location',
  'long_text',
  'mirror',
  'name',
  'numbers',
  'people',
  'person',
  'phone',
  'progress',
  'rating',
  'status',
  'subtasks',
  'tags',
  'team',
  'text',
  'time_tracking',
  'timeline',
  'unsupported',
  'vote',
  'week',
  'world_clock',
] as const;

/**
 * Per-type `--settings <json>` zod schemas for the writable
 * allowlist. Pinned narrowly: only the keys agents commonly set via
 * the wire (status `labels`, dropdown `labels`, numbers `unit`)
 * appear in the schema. Empty `.strict()` schemas for the simple
 * types (text / long_text / date / people / link / email / phone)
 * reject any keys — `--settings '{"labels":[]}' --type text` is a
 * usage_error rather than a Monday-side validation_failed.
 *
 * Why narrow: Monday's accepted shapes evolve (cli-design pinned the
 * decision deliberately — over-pinning would force docs revisions
 * every time Monday adds a setting key). The contract pins the
 * SHAPE (per-type validation against a per-type schema), the M16
 * implementation owns the field set. Status / dropdown / numbers
 * cover the documented happy paths; v0.8-M48 added the
 * `board_relation` / `dependency` create-time relation config
 * (`boardRelationSettingsSchema` / `dependencySettingsSchema` —
 * probe-pinned via `get_column_type_schema`); the remaining simple
 * types (text / long_text / date / people / link / email / phone /
 * tags) reject any keys because Monday has no documented
 * `defaults: JSON` shape for them.
 *
 * Status `labels` accepts both shapes Monday tolerates: bare
 * `string[]` (the labels in order) and `Record<string,string>`
 * (the legacy index-keyed shape). Same for dropdown.
 */
const statusSettingsSchema = z
  .object({
    labels: z
      .union([
        z.array(z.string()),
        z.record(z.string(), z.string()),
      ])
      .optional(),
  })
  .strict();

const dropdownLabelObjectSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    name: z.string(),
  })
  .strict();

const dropdownSettingsSchema = z
  .object({
    labels: z
      .array(z.union([z.string(), dropdownLabelObjectSchema]))
      .optional(),
  })
  .strict();

const numbersSettingsSchema = z
  .object({
    unit: z.string().optional(),
  })
  .strict();

const emptySettingsSchema = z.object({}).strict();

/**
 * A Monday board ID as it appears inside a `board_relation`
 * `--settings` payload. Monday's `create_column.defaults.settings`
 * wants **integers** for `boardIds` / `boardId` (the M48 probe pinned
 * this — `get_column_type_schema(type: board_relation)` types them
 * `[<integer>]` / `<integer>`). Agents, however, read board IDs as
 * branded numeric *strings* everywhere else (`board describe`,
 * `BoardIdSchema`), so accept either a JSON integer or a numeric
 * string and coerce to the wire integer. Mirrors the
 * `.transform().pipe()` coercion idiom in `item/history.ts`.
 *
 * The post-coercion `Number.isSafeInteger` guard is load-bearing, not
 * cosmetic: `Number("99999999999999999999")` (or a JSON-number literal
 * above 2^53−1) silently ROUNDS to a different integer that still
 * passes `.int().positive()`, so without the guard the wire would
 * carry a corrupted board ID. Mirrors the same `Number.isSafeInteger`
 * rejection `deriveAllowedBoards` / `parseRelationItemIds` apply to
 * board-relation item IDs (`api/column-values.ts`).
 */
const relationBoardIdSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/u)])
  .transform((v) => (typeof v === 'number' ? v : Number(v)))
  .pipe(
    z
      .number()
      .int()
      .positive()
      .refine(Number.isSafeInteger, {
        message: 'board ID exceeds the safe integer range (must be ≤ 2^53−1)',
      }),
  );

/**
 * `board_relation` create-time `--settings` (v0.8-M48). Wires the
 * Connect-Boards column at its target board(s) at create time. Field
 * set pinned by the M48 probe (`get_column_type_schema(type:
 * board_relation)` + a live create+readback): `boardIds` (array) AND
 * `boardId` (scalar) are both honoured; empty `{boardIds:[]}` is an
 * accepted degenerate (unconfigured column), self-reference is
 * accepted, and Monday validates board *existence* server-side
 * (`{boardIds:[999…]}` → `Resource not found` → existing `not_found`).
 * So the CLI does NOT pre-flight a board-existence round-trip — only
 * structural / type validation. All keys optional, `.strict()`.
 *
 * The validated object is the agent's TOP-LEVEL shape; the live wire
 * leg wraps it under a `settings` key (`defaults: {settings: {…}}`) —
 * see `CREATE_TIME_SETTINGS_WRAP_TYPES`. The read-side `settings_str`
 * is the UNWRAPPED inner object, so agents see the same unwrapped
 * shape on input + read-back; the `settings` wrapper is a wire-only
 * detail (the same `--settings`-hides-`defaults` asymmetry M16 already
 * established).
 */
const boardRelationSettingsSchema = z
  .object({
    boardIds: z.array(relationBoardIdSchema).optional(),
    boardId: relationBoardIdSchema.optional(),
    allowMultipleItems: z.boolean().optional(),
    allowCreateReflectionColumn: z.boolean().optional(),
  })
  .strict();

/**
 * `dependency` create-time `--settings` (v0.8-M48, D1 — same-board).
 * The M48 probe found `dependency` DIVERGES from `board_relation`: an
 * arbitrary target `boardId` is NOT honoured — Monday coerces it to
 * the host board + auto-adds `dependencyNewInfra`. Dependency columns
 * are effectively same-board. So this schema accepts only the
 * same-board-honoured knob (`allowMultipleItems`); the cross-board
 * target keys (`boardIds` / `boardId`) reject with a targeted
 * `usage_error` BEFORE this schema runs (see
 * `rejectDependencyBoardTargets`) so agents get "use board_relation
 * for cross-board" rather than a silent host-board coercion. Auto-
 * managed keys (`dependencyNewInfra`, `dependency_mode`) are NOT
 * exposed — Monday owns them. `.strict()` rejects anything else.
 */
const dependencySettingsSchema = z
  .object({
    allowMultipleItems: z.boolean().optional(),
  })
  .strict();

/**
 * Per-writable-type schema lookup. Used by `validateWritableSettings`
 * to reject type-mismatched `--settings` payloads at argv-parse time.
 */
const WRITABLE_SETTINGS_SCHEMAS: Readonly<
  Record<WritableColumnType, z.ZodObject<z.ZodRawShape>>
> = {
  text: emptySettingsSchema,
  long_text: emptySettingsSchema,
  numbers: numbersSettingsSchema,
  status: statusSettingsSchema,
  dropdown: dropdownSettingsSchema,
  date: emptySettingsSchema,
  people: emptySettingsSchema,
  link: emptySettingsSchema,
  email: emptySettingsSchema,
  phone: emptySettingsSchema,
  // M19: `tags` ships with no documented `defaults: JSON` shape from
  // Monday — `create_column` for a tags column accepts no settings,
  // and the friendly translator owns the per-tag-name resolution at
  // write time. Conservative empty schema mirrors `link` / `email` /
  // `phone` / `date` / `people`.
  tags: emptySettingsSchema,
  // v0.8-M48: `board_relation`'s linked-board list IS configurable at
  // create time via `create_column.defaults.settings` — the M19 "no
  // documented JSON shape / UI-only" assumption was REFUTED by the M48
  // probe (`get_column_type_schema` + a live create+readback). The
  // friendly `--settings '{"boardIds":[…]}'` wires the target board(s)
  // at create time (wrapped under `defaults.settings`; read back
  // unwrapped on `settings_str`). Per-item membership validation at
  // write time (M19's `board-relation-validation.ts`) is unchanged —
  // that's the item-VALUE `--set` path, a separate surface from this
  // column-CONFIG path.
  board_relation: boardRelationSettingsSchema,
  // v0.8-M48 (D1 — same-board): `dependency` accepts only the
  // same-board-honoured knob (`allowMultipleItems`). The M48 probe
  // showed an arbitrary target `boardId` is coerced to the host board,
  // so the cross-board keys (`boardIds` / `boardId`) reject with a
  // targeted usage_error before this schema runs
  // (`rejectDependencyBoardTargets`) pointing agents at
  // `--type board_relation` for cross-board links.
  dependency: dependencySettingsSchema,
};

/**
 * Hand-extracted documented key set per writable type — surfaces in
 * `details.expected_keys` of the type-mismatched `usage_error` so
 * agents read the accepted-keys list directly rather than having to
 * round-trip through `--help`. Mirrors `WRITABLE_SETTINGS_SCHEMAS`
 * verbatim — the two grow together.
 */
const WRITABLE_SETTINGS_EXPECTED_KEYS: Readonly<
  Record<WritableColumnType, readonly string[]>
> = {
  text: [],
  long_text: [],
  numbers: ['unit'],
  status: ['labels'],
  dropdown: ['labels'],
  date: [],
  people: [],
  link: [],
  email: [],
  phone: [],
  tags: [],
  // v0.8-M48: board_relation create-time settings (boardIds/boardId
  // are the cross-board target; allowMultipleItems +
  // allowCreateReflectionColumn the relation knobs).
  board_relation: ['boardIds', 'boardId', 'allowMultipleItems', 'allowCreateReflectionColumn'],
  // v0.8-M48 (D1 — same-board): only allowMultipleItems is honoured;
  // boardIds/boardId reject with a targeted hint before this list is
  // surfaced.
  dependency: ['allowMultipleItems'],
};

/**
 * Writable types whose validated `--settings` object must be WRAPPED
 * under a `settings` key on the wire (`defaults: {settings: {…}}`)
 * rather than passed through as `defaults` directly (v0.8-M48). The
 * M48 probe pinned this for `board_relation` / `dependency`: their
 * create-time relation config nests under `settings` inside
 * `defaults`, while the read-side `settings_str` is the UNWRAPPED
 * inner object. status / dropdown / numbers etc. pass `--settings`
 * straight through as `defaults` (no wrap). The wrap is a wire-only
 * detail — agents see the unwrapped shape on input + read-back.
 */
const CREATE_TIME_SETTINGS_WRAP_TYPES: ReadonlySet<string> = new Set([
  'board_relation',
  'dependency',
]);

/**
 * Cross-board target keys a `dependency` `--settings` payload must NOT
 * carry (v0.8-M48 D1). Rejected with a targeted `usage_error` so the
 * agent gets "dependency is same-board; use board_relation for
 * cross-board" instead of `.strict()`'s generic "unrecognized key" —
 * and crucially instead of Monday's silent coercion of the target to
 * the host board (the divergence the M48 probe found).
 */
const rejectDependencyBoardTargets = (
  parsed: Readonly<Record<string, unknown>>,
): void => {
  const rejected = (['boardIds', 'boardId'] as const).filter((k) =>
    Object.prototype.hasOwnProperty.call(parsed, k),
  );
  if (rejected.length === 0) return;
  throw new UsageError(
    `--settings: dependency columns are same-board — ` +
      `${rejected.join(', ')} ${rejected.length > 1 ? 'are' : 'is'} not ` +
      `honoured at create time (Monday wires the dependency to the host ` +
      `board regardless).`,
    {
      details: {
        column_type: 'dependency',
        rejected_keys: rejected,
        hint:
          'omit boardIds/boardId for dependency columns (they accept only ' +
          'allowMultipleItems via --settings); use `--type board_relation` ' +
          'for a cross-board link.',
      },
    },
  );
};

/**
 * Parses `--settings <json>` at argv-parse time. Two-stage:
 *   1. JSON.parse (malformed JSON → usage_error, before any network
 *      call). Monday's `defaults: JSON` argument requires a JSON
 *      object on the wire; a bare string / number / array at the
 *      top level is rejected here (mirrors `--set-raw`'s shape rule
 *      so the two escape hatches read consistently).
 *   2. For types in `WRITABLE_COLUMN_TYPES`, parse against the per-
 *      type schema. A schema failure surfaces as usage_error with
 *      `details: {column_type, expected_keys, actual_keys, hint}`.
 *      Other types skip type-specific validation per cli-design
 *      §4.3 column-create (well-formed JSON only).
 */
const parseSettingsFlag = (
  raw: string,
  columnType: string,
): Readonly<Record<string, unknown>> => {
  // R-NEW-42 lift: shared `parseJsonArg` helper (3-consumer
  // threshold; same shape `monday raw --vars` + `webhook create
  // --config` use). Pre-lift this site put `details.parse_error`
  // (redundant with `error.message`) + `details.raw` (the
  // unparseable input echo) on the envelope; both dropped since
  // neither is asserted on or contract-documented — `cause`
  // preserves the SyntaxError for debugging.
  const parsed = parseJsonArg(raw, {
    context: '--settings: malformed JSON',
    details: {
      column_type: columnType,
      hint:
        'pass a well-formed JSON object literal (e.g. ' +
        '--settings \'{"labels":["Low","Med","High"]}\'); use ' +
        'single-quote-around-double-quote shell quoting on POSIX shells.',
    },
  });
  if (!isPlainObject(parsed)) {
    throw new UsageError(
      `--settings: expected a JSON object, got ${
        Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed
      }`,
      {
        details: {
          column_type: columnType,
          raw,
          hint:
            'Monday\'s create_column `defaults: JSON` argument requires ' +
            'a JSON object — wrap the literal in {…}.',
        },
      },
    );
  }
  if (isWritableColumnType(columnType)) {
    // v0.8-M48 D1: reject dependency's cross-board target keys with a
    // targeted hint BEFORE the per-type schema (whose `.strict()`
    // would otherwise emit a generic unrecognized-key message).
    if (columnType === 'dependency') {
      rejectDependencyBoardTargets(parsed);
    }
    const schema = WRITABLE_SETTINGS_SCHEMAS[columnType];
    const result = schema.safeParse(parsed);
    if (!result.success) {
      const expectedKeys = WRITABLE_SETTINGS_EXPECTED_KEYS[columnType];
      const actualKeys = Object.keys(parsed);
      const issues = result.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      }));
      throw new UsageError(
        `--settings: payload doesn't match the schema for column type ` +
          `"${columnType}" — ${issues
            .map((i) => (i.path.length > 0 ? `${i.path}: ${i.message}` : i.message))
            .join('; ')}`,
        {
          cause: result.error,
          details: {
            column_type: columnType,
            expected_keys: expectedKeys,
            actual_keys: actualKeys,
            issues,
            hint:
              expectedKeys.length === 0
                ? `column type "${columnType}" accepts no --settings keys via M16; ` +
                  'omit --settings or use --set-raw post-creation for type-specific writes.'
                : `column type "${columnType}" accepts these --settings keys: ` +
                  `${expectedKeys.join(', ')}.`,
          },
        },
      );
    }
    return result.data;
  }
  // Raw-writable / read-only-forever / files-shaped: well-formed
  // JSON only (Monday validates server-side); skip type-specific
  // validation per cli-design §4.3 column-create.
  return parsed;
};

const inputSchema = z
  .object({
    boardId: BoardIdSchema,
    type: z.enum(COLUMN_TYPE_VALUES),
    title: z.string().refine((s) => s.trim().length > 0, {
      message: '--title must be non-empty (whitespace-only is rejected)',
    }),
    description: z.string().optional(),
    /**
     * Raw `--settings <json>` string — parsed + per-type-validated
     * inside the action body via `parseSettingsFlag` because the
     * validation depends on the resolved `--type`. Schema only
     * checks "well-formed string" here.
     */
    settings: z.string().optional(),
  })
  .strict();

const responseSchema = z
  .object({
    create_column: z.unknown(),
  })
  .loose();

/**
 * Builds the §6 `noncanonical_column_type` warning when `--type`
 * resolves to a non-canonical type. Returns `[]` for canonical types
 * so the action body can splat unconditionally. Shape matches the
 * cli-design §6 stable warning-code registry pin (column_type,
 * category, suggested_write_path).
 */
const buildNoncanonicalWarning = (columnType: string): readonly Warning[] => {
  const details = categorizeNoncanonicalColumnType(columnType);
  if (details === null) return [];
  const message = buildNoncanonicalMessage(columnType, details.category);
  return [
    {
      code: 'noncanonical_column_type',
      message,
      details: {
        column_type: columnType,
        category: details.category,
        suggested_write_path: details.suggestedWritePath,
      },
    },
  ];
};

const buildNoncanonicalMessage = (
  columnType: string,
  category: NoncanonicalColumnTypeCategory,
): string => {
  switch (category) {
    case 'raw_writable':
      return (
        `Column type "${columnType}" was created successfully but is not ` +
        `in the v0.2 writable allowlist (cli-design §5.3). Use ` +
        `\`--set-raw <col>=<json>\` to write to this column post-creation.`
      );
    case 'read_only_forever':
      return (
        `Column type "${columnType}" was created successfully but Monday ` +
        `computes its value server-side and never makes it writable via ` +
        `the API. The column exists for read-side display / mirror ` +
        `sources only; \`--set\` and \`--set-raw\` against it surface ` +
        `unsupported_column_type.`
      );
    case 'files_shaped':
      return (
        `Column type "${columnType}" was created successfully but the ` +
        `write path is \`add_file_to_column\` (multipart upload). ` +
        `Four paths reach the multipart wire: the v0.6-M38 friendly ` +
        `\`monday item set <iid> <file-col>=<path>\` / ` +
        `\`monday item update <iid> --set <file-col>=<path>\` ` +
        `dispatch (single-item); the v0.7-M42 friendly \`monday item ` +
        `update --where ... --set <file-col>=<path>\` dispatch ` +
        `(bulk per-item fan-out under --concurrency / ` +
        `--continue-on-error); the v0.7-M43 friendly \`monday item ` +
        `create --set <file-col>=<path>\` dispatch (create-time ` +
        `two-leg \`create_item\` + \`add_file_to_column\` under the ` +
        `§5.8 orphan-warn atomicity envelope); AND the v0.4-M31 ` +
        `verb-shaped \`monday item upload <iid> --column <col> ` +
        `<file>\`. \`--set-raw <file-col>=<json>\` STAYS REJECTED ` +
        `per D3 — permanent because \`change_column_value\` has no ` +
        `JSON-shape for file columns.`
      );
  }
};

export const boardColumnCreateCommand: CommandModule<
  z.infer<typeof inputSchema>,
  BoardColumnCreateOutput
> = {
  name: 'board.column-create',
  summary: 'Create a new column on a board',
  examples: [
    'monday board column-create 12345 --type text --title "Notes"',
    'monday board column-create 12345 --type status --title "Priority" --settings \'{"labels":["Low","Med","High"]}\'',
    'monday board column-create 12345 --type numbers --title "Cost" --settings \'{"unit":"USD"}\' --description "Budgeted cost"',
    'monday board column-create 12345 --type board_relation --title "Linked Sprints" --settings \'{"boardIds":[67890],"allowMultipleItems":true}\'',
    'monday board column-create 12345 --type country --title "Region" --json',
    'monday board column-create 12345 --type text --title "Preview" --dry-run --json',
  ],
  // create_column is non-idempotent — re-running creates a second
  // column with the same title (Monday auto-generates a fresh column
  // id per call). Mirrors `board create` / `workspace create` /
  // `item create` rationale.
  idempotent: false,
  inputSchema,
  outputSchema: boardColumnCreateOutputSchema,
  attach: (program, ctx) => {
    const noun = ensureSubcommand(program, 'board', 'Board commands');
    noun
      .command('column-create <boardId>')
      .description(boardColumnCreateCommand.summary)
      .requiredOption('--type <type>', 'column type (e.g. text, status, numbers — full ColumnType enum)')
      .requiredOption('--title <t>', 'column title')
      .option('--description <d>', 'column description')
      .option('--settings <json>', 'type-specific settings JSON (status/dropdown labels, numbers unit, board_relation boardIds, etc.)')
      .addHelpText(
        'after',
        ['', 'Examples:', ...boardColumnCreateCommand.examples.map((e) => `  ${e}`), ''].join('\n'),
      )
      .action(async (boardId: unknown, opts: unknown) => {
        const parsed = parseArgv(boardColumnCreateCommand.inputSchema, {
          boardId,
          ...(opts as Readonly<Record<string, unknown>>),
        });
        const title = parsed.title.trim();
        // Parse + per-type-validate --settings ahead of resolveClient
        // so a malformed payload surfaces as usage_error (exit 1)
        // before any token check (config_error, exit 3) — same
        // ordering invariant the destructive-gate verbs preserve.
        const settings =
          parsed.settings === undefined
            ? undefined
            : parseSettingsFlag(parsed.settings, parsed.type);

        const { client, globalFlags, apiVersion, toEmit } = resolveClient(
          ctx,
          program.opts(),
        );

        const warnings = buildNoncanonicalWarning(parsed.type);

        if (globalFlags.dryRun) {
          // Per cli-design §6.4 column-create variant: minimal
          // `{operation, board_id, type, title, description?,
          // settings?}`. No preflight read fires — purely argv-
          // derived; meta.source: 'none'. The `noncanonical_column_
          // type` warning fires on dry-run too so the live call's
          // behaviour is predictable.
          const planned: Record<string, unknown> = {
            operation: 'create_column',
            board_id: parsed.boardId,
            type: parsed.type,
            title,
          };
          if (parsed.description !== undefined) {
            planned.description = parsed.description;
          }
          if (settings !== undefined) {
            planned.settings = settings;
          }
          emitDryRun({
            ctx,
            programOpts: program.opts(),
            plannedChanges: [planned],
            source: 'none',
            cacheAgeSeconds: null,
            warnings,
            apiVersion,
          });
          return;
        }

        // Live path. Send each optional arg only when the agent
        // provided one — passing `null` would explicitly clear /
        // reject Monday's server-side default.
        const variables: Record<string, unknown> = {
          boardId: parsed.boardId,
          columnType: parsed.type,
          title,
        };
        if (parsed.description !== undefined) {
          variables.description = parsed.description;
        }
        if (settings !== undefined) {
          // v0.8-M48: board_relation / dependency create-time settings
          // nest under a `settings` key inside `defaults` on the wire
          // (`defaults: {settings: {…}}`) — the probe-confirmed shape
          // (`get_column_type_schema` + a live create+readback). The
          // validated `settings` object is the agent's UNWRAPPED top-
          // level shape (same as the read-side `settings_str`), so the
          // wrap is a wire-only detail. status / dropdown / numbers /
          // etc. pass `--settings` straight through as `defaults` (no
          // wrap). `boardIds`/`boardId` were int-coerced + safe-integer
          // -guarded at parse time, so the wire carries integers.
          variables.defaults = CREATE_TIME_SETTINGS_WRAP_TYPES.has(parsed.type)
            ? { settings }
            : settings;
        }

        // §8 single-leg call-site contract via `withBoardInvalidation
        // SingleLeg` (R46): the helper invalidates AFTER the closure
        // returns (i.e. after `data` projection completes). On the
        // error path the closure's throw bypasses invalidation —
        // matching the §8 "skip on error" rule. Ordered BEFORE
        // emitMutation so a cache-unlink failure surfaces through
        // the runner's catch-all rather than double-emitting after
        // a success envelope hit stdout.
        const { data: projected, response } = await withBoardInvalidationSingleLeg({
          boardId: parsed.boardId,
          env: ctx.env,
          perform: async () => {
            const wireResponse = await client.raw<unknown>(
              CREATE_COLUMN_MUTATION,
              variables,
              { operationName: 'ColumnCreate' },
            );
            const data = unwrapOrThrow(
              responseSchema.safeParse(wireResponse.data),
              {
                context: 'Monday returned a malformed ColumnCreate response',
                details: { board_id: parsed.boardId, title },
                hint:
                  "this is a data-integrity error in Monday's response; " +
                  'verify the response shape and update responseSchema if ' +
                  "Monday's contract has changed.",
              },
            );
            // R42: consolidate the inline missing-key check onto
            // `assertResponseFieldPresent`. Distinguishes missing-
            // root-key (schema-drift → internal_error) from null
            // payload (handled by projectMutationColumn).
            assertResponseFieldPresent({
              data,
              key: 'create_column',
              operationLabel: 'ColumnCreate',
              details: { board_id: parsed.boardId, title },
              nullHandling: 'caller_handles',
            });
            // R45 lift (api/column-mutation-result.ts): null-payload
            // guard + projection. Create's null path uses
            // `internal_error` because the contract is "every
            // successful call returns a Column"; the helper carries
            // the agent-supplied `title` in `details` (paired with
            // `board_id`) because the new column id doesn't exist
            // yet on the null path.
            const projection = projectMutationColumn({
              raw: data.create_column,
              errorCode: 'internal_error',
              errorMessage: `Monday returned no column payload from create_column for board ${parsed.boardId} title ${JSON.stringify(title)}.`,
              boardId: parsed.boardId,
              columnIdKey: 'title',
              columnIdValue: title,
            });
            return { data: projection, response: wireResponse };
          },
        });

        emitMutation({
          ctx,
          data: projected,
          schema: boardColumnCreateCommand.outputSchema,
          programOpts: program.opts(),
          warnings,
          ...toEmit(response),
          source: 'live',
          cacheAgeSeconds: null,
        });
      });
  },
};
