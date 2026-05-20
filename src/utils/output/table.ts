import Table from 'cli-table3';

/**
 * Table renderer for TTY output (`cli-design.md` §3.2).
 *
 * Two layouts:
 *  - **Single resource** — key/value rows (one row per top-level
 *    field of `data`).
 *  - **Collection** — N-column table; columns are the union of keys
 *    across rows, in first-seen order; header row is the column names.
 *
 * Truncation is honoured here and only here — JSON / NDJSON callers
 * never reach this code, so the §3.2 invariant "truncation never
 * affects JSON output" is enforced by construction.
 *
 * Truncation rules (matching the design):
 *  - Per-column floor of 12 chars before the ellipsis kicks in.
 *  - Trailing ellipsis is a single `…` character (U+2026).
 *  - `--full` disables truncation.
 *  - `--width <N>` forces the target terminal width.
 *  - `--columns <c1,c2,...>` restricts the visible column set.
 */

const ELLIPSIS = '…';
export const COLUMN_FLOOR = 12;
const FALLBACK_WIDTH = 80;
const DEFAULT_PADDING = 2;

export interface TableOptions {
  /** Disable truncation (the `--full` flag). */
  readonly full?: boolean;
  /** Target terminal width. Falls back to 80 when not provided. */
  readonly width?: number;
  /**
   * Restrict to these columns, by key. Order is preserved. Unknown
   * keys are silently dropped — the command-layer caller validated
   * already, and a truncated header is more useful than an error here.
   */
  readonly columns?: readonly string[];
  /**
   * Whether ANSI colour may be emitted. cli-table3 colours its
   * borders + header grey/red by default regardless of TTY-ness, so a
   * `--output table` forced through a pipe leaks escape codes. When
   * `false` (the default — callers opt INTO colour), border + head
   * style arrays are emptied so the table is plain text. The
   * command layer computes this via `resolveColorEnabled`.
   */
  readonly color?: boolean;
}

export interface SingleResourceTableInput {
  readonly kind: 'single';
  readonly data: Readonly<Record<string, unknown>>;
  readonly options?: TableOptions;
}

export interface CollectionTableInput {
  readonly kind: 'collection';
  readonly data: readonly Readonly<Record<string, unknown>>[];
  readonly options?: TableOptions;
}

export type TableInput = SingleResourceTableInput | CollectionTableInput;

const formatCell = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
};

/**
 * Truncates `value` to fit within `width` characters. The width
 * floor (per `cli-design.md` §3.2) is honoured by callers — this
 * function only does the cut.
 */
export const truncate = (value: string, width: number): string => {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return ELLIPSIS;
  }
  return value.slice(0, width - 1) + ELLIPSIS;
};

/**
 * Splits the available horizontal budget across `columnCount`
 * columns, each at least `COLUMN_FLOOR` wide. Returns the per-column
 * width (in characters of cell content). cli-table3 adds borders +
 * padding around what we hand it; account for that up front so the
 * rendered table actually fits.
 */
const computeColumnWidth = (
  columnCount: number,
  width: number,
): number => {
  // Each cell carries 2 padding chars + 1 border char; an extra +1
  // border closes off the right edge.
  const overhead = columnCount * (DEFAULT_PADDING + 1) + 1;
  const usable = Math.max(width - overhead, columnCount * COLUMN_FLOOR);
  return Math.max(Math.floor(usable / columnCount), COLUMN_FLOOR);
};

const filterAndOrderKeys = (
  keys: readonly string[],
  selected: readonly string[] | undefined,
): readonly string[] => {
  if (selected === undefined) {
    return keys;
  }
  const present = new Set(keys);
  return selected.filter((k) => present.has(k));
};

const collectKeysInOrder = (
  rows: readonly Readonly<Record<string, unknown>>[],
): readonly string[] => {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push(key);
      }
    }
  }
  return ordered;
};

/**
 * cli-table3 colours its `head` (red) and `border` (grey) by default,
 * emitting ANSI even when stdout isn't a TTY. When colour is off we
 * empty both style arrays so the rendered table is plain text. Colour
 * defaults to OFF here — callers opt in via `options.color`, which the
 * emit layer computes from `resolveColorEnabled`.
 */
const colourStyle = (
  color: boolean | undefined,
): { style: { head: string[]; border: string[] } } | Record<string, never> =>
  color === true ? {} : { style: { head: [], border: [] } };

const renderSingle = (input: SingleResourceTableInput): string => {
  const { data, options = {} } = input;
  const { full = false, width = FALLBACK_WIDTH, columns, color } = options;

  const allKeys = Object.keys(data);
  const keys = filterAndOrderKeys(allKeys, columns);

  const valueColWidth = full ? Number.POSITIVE_INFINITY : computeColumnWidth(2, width);

  const table = new Table({
    head: ['field', 'value'],
    ...colourStyle(color),
  });
  for (const key of keys) {
    const cell = formatCell(data[key]);
    table.push([
      full ? key : truncate(key, valueColWidth),
      full ? cell : truncate(cell, valueColWidth),
    ]);
  }
  return table.toString();
};

const renderCollection = (input: CollectionTableInput): string => {
  const { data, options = {} } = input;
  const { full = false, width = FALLBACK_WIDTH, columns, color } = options;

  const allKeys = collectKeysInOrder(data);
  const keys = filterAndOrderKeys(allKeys, columns);

  if (keys.length === 0) {
    // Empty collection still emits a table-shaped sentinel; an empty
    // string would let the renderer-selection bug ride silently.
    return new Table({ head: [], ...colourStyle(color) }).toString();
  }

  const colWidth = full ? Number.POSITIVE_INFINITY : computeColumnWidth(keys.length, width);
  const table = new Table({
    head: full ? [...keys] : keys.map((k) => truncate(k, colWidth)),
    ...colourStyle(color),
  });
  for (const row of data) {
    table.push(
      keys.map((key) => {
        const formatted = formatCell(row[key]);
        return full ? formatted : truncate(formatted, colWidth);
      }),
    );
  }
  return table.toString();
};

export const renderTable = (
  input: TableInput,
  stream: NodeJS.WritableStream,
): void => {
  const text = input.kind === 'single' ? renderSingle(input) : renderCollection(input);
  stream.write(`${text}\n`);
};
