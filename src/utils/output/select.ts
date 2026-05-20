import { UsageError } from '../errors.js';

/**
 * Output-format selection (`cli-design.md` §3.1 #2, §4.4).
 *
 * Resolution priority (first match wins):
 *  1. `--json` / `--table` shorthand flags (mutually exclusive).
 *  2. `--output <fmt>` explicit choice.
 *  3. `MONDAY_OUTPUT` env override (sticky agent contexts).
 *  4. `process.stdout.isTTY` — table when typing in a terminal,
 *     JSON when piped or redirected so `monday item list | jq`
 *     just works.
 */
export const OUTPUT_FORMATS = ['json', 'table', 'text', 'ndjson'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export interface SelectOutputInput {
  readonly json?: boolean;
  readonly table?: boolean;
  readonly output?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
}

const isOutputFormat = (value: string): value is OutputFormat =>
  (OUTPUT_FORMATS as readonly string[]).includes(value);

export const selectOutput = (input: SelectOutputInput): OutputFormat => {
  const { json = false, table = false, output, env, isTTY } = input;

  if (json && table) {
    throw new UsageError('--json and --table are mutually exclusive');
  }

  if (output !== undefined && !isOutputFormat(output)) {
    throw new UsageError(
      `--output must be one of ${OUTPUT_FORMATS.join(', ')} (got "${output}")`,
    );
  }

  if (json && output !== undefined && output !== 'json') {
    throw new UsageError(
      `--json conflicts with --output ${output} (use one or the other)`,
    );
  }
  if (table && output !== undefined && output !== 'table') {
    throw new UsageError(
      `--table conflicts with --output ${output} (use one or the other)`,
    );
  }

  if (json) {
    return 'json';
  }
  if (table) {
    return 'table';
  }
  if (output !== undefined) {
    return output;
  }

  const fromEnv = env?.MONDAY_OUTPUT;
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!isOutputFormat(fromEnv)) {
      throw new UsageError(
        `MONDAY_OUTPUT must be one of ${OUTPUT_FORMATS.join(', ')} (got "${fromEnv}")`,
      );
    }
    return fromEnv;
  }

  return isTTY ? 'table' : 'json';
};

export interface ResolveColorInput {
  /** `--no-color` flag (commander-inverted `globalFlags.noColor`). */
  readonly noColor: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly isTTY: boolean;
}

/**
 * Decides whether presentation output (cli-table3 borders/headers,
 * any future styled text) may emit ANSI colour. Unlike `selectOutput`,
 * this is a hard gate the renderers must honour: cli-table3 colours its
 * borders unconditionally otherwise, so a `--output table` forced
 * through a pipe leaks `^[[90m`/`^[[39m` into captured output
 * (`cli-design.md` §3.2 / `cli.md` "Respect NO_COLOR"). Default is the
 * stdout TTY-ness so a normal pipe gets clean text without a flag.
 *
 * Resolution priority (first match wins):
 *  1. `--no-color` → off (explicit user intent, strongest).
 *  2. `FORCE_COLOR` (present, not `0`/`false`) → on, even off-TTY.
 *  3. `NO_COLOR` (present, non-empty) → off.
 *  4. fall back to `isTTY`.
 */
export const resolveColorEnabled = (input: ResolveColorInput): boolean => {
  const { noColor, env, isTTY } = input;
  if (noColor) {
    return false;
  }
  const force = env?.FORCE_COLOR;
  if (force !== undefined && force !== '' && force !== '0' && force !== 'false') {
    return true;
  }
  const no = env?.NO_COLOR;
  if (no !== undefined && no !== '') {
    return false;
  }
  return isTTY;
};
