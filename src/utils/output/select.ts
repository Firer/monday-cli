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
