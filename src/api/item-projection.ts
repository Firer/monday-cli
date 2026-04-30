/**
 * Shared item projection helpers (`v0.1-plan.md` §3 M4,
 * `cli-design.md` §6.2).
 *
 * Every M4 read command (`item get` / `list` / `find` / `search` /
 * `subitems`) emits the same single-resource Item shape. Centralising
 * here means the projection lives in one file and the per-command
 * action body stays focused on the GraphQL call + envelope mapping.
 *
 * Column-value projection notes:
 *
 *   - Each column carries `{id, type, title, text, value}` per §6.2.
 *     `value` is the *parsed* JSON Monday stored — Monday returns it
 *     as a JSON-encoded string on the wire and we decode at this
 *     boundary so JSON consumers can read structured payloads
 *     without re-parsing.
 *   - For known-write column types (status / date / people), a
 *     handful of *typed* fields are surfaced inline (matching the
 *     §6.2 worked example). Unknown / read-only types only carry
 *     the base shape; agents inspect `value` for structured access.
 *   - The richer per-type projection is deferred to M5a's
 *     `column-values.ts` (the writer needs the same shape and the
 *     reader can reuse it). Until then, this module hosts the
 *     read-only inline projection so the v0.1 contract surface is
 *     stable.
 */

import { z } from 'zod';

export const rawColumnValueSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    text: z.string().nullable(),
    value: z.string().nullable(),
    column: z
      .object({ title: z.string() })
      .nullable()
      .optional(),
  })
  .strict();

export type RawColumnValue = z.infer<typeof rawColumnValueSchema>;

export const rawItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().nullable(),
    url: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    board: z.object({ id: z.string() }).nullable(),
    group: z
      .object({ id: z.string(), title: z.string().nullable() })
      .nullable()
      .optional(),
    parent_item: z
      .object({ id: z.string() })
      .nullable()
      .optional(),
    creator_id: z.string().nullable().optional(),
    column_values: z.array(rawColumnValueSchema),
  })
  .strict();

export type RawItem = z.infer<typeof rawItemSchema>;

/**
 * Single-column projected shape per §6.2. Carries the base shape
 * (`id, type, title, text, value`) plus a few typed fields for the
 * v0.1-writable status / date / people types. Mirror / formula /
 * dependency columns surface as the base shape — `text` is the
 * source of truth there because the typed payload isn't writable
 * and Monday's wire shape varies.
 */
export const projectedColumnSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    title: z.string(),
    text: z.string().nullable(),
    value: z.unknown(),
    // Typed fields (optional — only set per type)
    label: z.string().nullable().optional(),
    index: z.number().int().nullable().optional(),
    date: z.string().nullable().optional(),
    time: z.string().nullable().optional(),
    people: z
      .array(
        z.object({
          id: z.string(),
          kind: z.string().nullable().optional(),
        }).loose(),
      )
      .optional(),
  })
  .loose();

export type ProjectedColumn = z.infer<typeof projectedColumnSchema>;

export const projectedItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    board_id: z.string().nullable(),
    group_id: z.string().nullable(),
    parent_item_id: z.string().nullable(),
    state: z.string().nullable(),
    url: z.string().nullable(),
    created_at: z.string().nullable(),
    updated_at: z.string().nullable(),
    columns: z.record(z.string(), projectedColumnSchema),
  })
  .strict();

export type ProjectedItem = z.infer<typeof projectedItemSchema>;

/**
 * Parses a Monday `value` string. Monday encodes structured column
 * values as JSON strings; the projector decodes once at the boundary
 * so consumers can read the structured field without re-parsing.
 *
 * Errors are swallowed: a malformed JSON string surfaces as `null`
 * (with `text` still carrying the human form). Defensive — Monday
 * occasionally returns an unparseable string for read-only column
 * types, and we don't want one weird column to fail the whole emit.
 */
export const parseColumnValue = (raw: string | null): unknown => {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const projectStatus = (value: unknown): Pick<ProjectedColumn, 'label' | 'index'> => {
  if (typeof value !== 'object' || value === null) {
    return { label: null, index: null };
  }
  const v = value as Record<string, unknown>;
  const label = typeof v.label === 'string' ? v.label : null;
  const index = typeof v.index === 'number' ? v.index : null;
  return { label, index };
};

const projectDate = (value: unknown): Pick<ProjectedColumn, 'date' | 'time'> => {
  if (typeof value !== 'object' || value === null) {
    return { date: null, time: null };
  }
  const v = value as Record<string, unknown>;
  const date = typeof v.date === 'string' ? v.date : null;
  const time = typeof v.time === 'string' ? v.time : null;
  return { date, time };
};

const projectPeople = (value: unknown): Pick<ProjectedColumn, 'people'> => {
  if (typeof value !== 'object' || value === null) {
    return { people: [] };
  }
  const v = value as Record<string, unknown>;
  const persons = Array.isArray(v.personsAndTeams) ? v.personsAndTeams : [];
  const people = persons.flatMap((p): { id: string; kind?: string }[] => {
    if (typeof p !== 'object' || p === null) return [];
    const pp = p as Record<string, unknown>;
    const id = typeof pp.id === 'number' ? String(pp.id) : typeof pp.id === 'string' ? pp.id : '';
    if (id.length === 0) return [];
    return [{ id, ...(typeof pp.kind === 'string' ? { kind: pp.kind } : {}) }];
  });
  return { people };
};

/**
 * Projects one column-value into the §6.2 shape. Pure — no I/O.
 * The board-metadata `title` is preferred over the wire-side
 * `column.title` because the metadata loader's NFC + cache rules
 * are the canonical source; `column.title` is only the fallback for
 * cross-board lists where a single board metadata isn't loaded.
 */
export const projectColumnValue = (
  raw: RawColumnValue,
  fallbackTitle: string | undefined,
): ProjectedColumn => {
  const value = parseColumnValue(raw.value);
  const title =
    fallbackTitle ?? (raw.column?.title ?? raw.id);
  const base: ProjectedColumn = {
    id: raw.id,
    type: raw.type,
    title,
    text: raw.text,
    value,
  };
  switch (raw.type) {
    case 'status':
      return { ...base, ...projectStatus(value) };
    case 'date':
      return { ...base, ...projectDate(value) };
    case 'people':
      return { ...base, ...projectPeople(value) };
    default:
      return base;
  }
};

export interface ProjectItemInputs {
  readonly raw: RawItem;
  /**
   * Per-board column titles, keyed by column ID. When supplied, the
   * projector uses these in preference to the wire-side
   * `column.title` (per §6.3 — the per-board view is canonical).
   * Cross-board lists (`item find` walking multiple boards in
   * theory) leave this undefined and fall back to the wire title.
   */
  readonly columnTitles?: ReadonlyMap<string, string>;
}

export const projectItem = (inputs: ProjectItemInputs): ProjectedItem => {
  const titles = inputs.columnTitles;
  const columns: Record<string, ProjectedColumn> = {};
  for (const cv of inputs.raw.column_values) {
    const fallback = titles?.get(cv.id);
    columns[cv.id] = projectColumnValue(cv, fallback);
  }
  return {
    id: inputs.raw.id,
    name: inputs.raw.name,
    board_id: inputs.raw.board?.id ?? null,
    group_id: inputs.raw.group?.id ?? null,
    parent_item_id: inputs.raw.parent_item?.id ?? null,
    state: inputs.raw.state,
    url: inputs.raw.url,
    created_at: inputs.raw.created_at,
    updated_at: inputs.raw.updated_at,
    columns,
  };
};
