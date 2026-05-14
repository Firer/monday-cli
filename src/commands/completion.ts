/* eslint-disable no-template-curly-in-string -- the bash / zsh script
 * builders emit literal shell `${VAR}` references inside JS string-
 * array elements (NOT JS template literals). The rule's heuristic
 * for "did you forget backticks?" doesn't apply here: we want the
 * dollar-brace pair in the emitted output verbatim. The file uses
 * regular single-quoted JS strings throughout for the script body
 * arrays so backticks are correctly absent. */
/**
 * `monday completion <bash|zsh|fish>` — emit a shell-completion script
 * for the named shell flavour (cli-design.md §3.1 #2 carve-out + §4.3
 * COMPLETION section + §13 v0.4 entry; v0.4-plan.md §3 M33).
 *
 * **What this verb answers:** "give me a shell-completion script I can
 * `eval` / `source` to get tab-completion for `monday <noun> <verb>`
 * + flags in my shell". Standard install flow:
 *
 *   monday completion bash >> ~/.bashrc
 *   monday completion zsh  >> ~/.zshrc
 *   monday completion fish >  ~/.config/fish/completions/monday.fish
 *
 * **Empirical-probe finding (M33 pre-flight Decision 1).** Commander
 * 14.0.3 (the SDK-pinned version) ships NO completion machinery —
 * `grep -rn 'completion\|complete' node_modules/commander/lib/
 * node_modules/commander/typings/` returned zero hits at 2026-05-14.
 * The verb hand-rolls per-shell script templates instead of shelling
 * out to a commander-provided emitter. No runtime dep added (the
 * cli-design §1 "minimum deps" principle is binding); the runtime
 * walks `program.commands` + each command's options at emit time so
 * completions stay in sync with the registry as new verbs land.
 *
 * **Output discipline carve-out (M33 pre-flight Decision 3, cli-design
 * §3.1 raw-bytes carve-out).** This is the FIRST non-envelope stdout
 * surface in the CLI. Default behaviour (no `--json` flag) emits the
 * raw script bytes on stdout regardless of TTY / pipe context — the
 * standard install flow above pipes to a file and an envelope wrap
 * would defeat the purpose. Three modes:
 *
 *   - **Default (no `--json` / no `--output`)**: raw script bytes.
 *   - **`--json` / `--output json` / `MONDAY_OUTPUT=json`**: standard
 *     §6 envelope with `data: { shell, script }`. Useful for agent
 *     introspection (e.g., `monday completion bash --json | jq -r
 *     '.data.script'` extracts the same bytes the default mode
 *     prints).
 *   - **`--table` / `--output table` / `--output text` / `--output
 *     ndjson`**: rejected as `usage_error` (no sensible non-JSON
 *     envelope view of a multi-line script blob). The `--text` and
 *     `--ndjson` shorthand flags don't exist on this CLI (only
 *     `--json` and `--table` are global shorthands per cli-design
 *     §4.4); text / ndjson are accessible only via `--output
 *     <fmt>`.
 *
 * **`shell` argv (Decision 4).** Single positional, required. Closed
 * 3-value enum `bash` / `zsh` / `fish` validated at the parse
 * boundary. Unknown values reject with `usage_error.details.issues[]`
 * carrying a `{path: 'shell', message: 'Invalid option: expected one
 * of "bash"|"zsh"|"fish"'}` entry (the shared `parseArgv` boundary
 * shape per `src/commands/parse-argv.ts:SummarisedIssue` — NOT a
 * completion-specific `details.shell` slot; the boundary's
 * `SummarisedIssue` carries only `path` + `message` + optional
 * `params`, NOT a Zod `code` field). Agents key on
 * `details.issues[].path === 'shell'` to disambiguate from other
 * parse-boundary rejections.
 *
 * **No wire surface (Decision 5).** Verb is CLI-internal — no Monday
 * API call, no `resolveClient`, no auth requirement. `meta.source:
 * "none"` (only applies to the `--json` envelope path).
 *
 * **No `--dry-run` (Decision 6).** Verb is fundamentally a "show
 * script" verb, not a mutation. The cli-design §3.1 #6 dry-run rule
 * binds mutating commands; completion has no Monday-side side-effect
 * to preview.
 *
 * **No GraphQL operation (Decision 7).** R-NEW-37 W2 audit-point
 * returns "nothing flagged" for M33 — there's no `client.raw` call to
 * pair an `operationName` against.
 *
 * **Idempotent: yes** (deterministic per shell flavour — same argv
 * against the same registry produces byte-identical scripts).
 */
import type { Command } from 'commander';
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { parseArgv } from './parse-argv.js';
import { emitSuccess } from './emit.js';
import { parseGlobalFlags } from '../types/global-flags.js';
import { UsageError } from '../utils/errors.js';

/**
 * Closed 3-value enum of shell flavours the CLI knows how to emit a
 * completion script for. Adding a 4th value (e.g. `powershell`,
 * `nushell`) is a SemVer-minor expansion at the M33 contract + a
 * matching hand-rolled template below.
 */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/**
 * zod enum binding for the closed 3-value shell flavour. Exported so
 * downstream `monday schema completion` introspection consumers can
 * pin against the same enum the argv parse boundary uses.
 */
export const shellSchema = z.enum(COMPLETION_SHELLS);

const inputSchema = z
  .object({
    shell: shellSchema,
  })
  .strict();

/**
 * `--json` envelope shape. The default mode emits raw script bytes
 * with NO envelope (see module-level carve-out note); this schema
 * applies only when `--json` / `--output json` / `MONDAY_OUTPUT=json`
 * opts into the envelope path.
 *
 * `shell` echoes the input flavour; `script` is the per-shell
 * completion script body as a single string (including trailing
 * newlines). Agents extract via `jq -r '.data.script'`.
 */
export const completionOutputSchema = z
  .object({
    shell: shellSchema,
    script: z.string().min(1),
  })
  .strict();

export type CompletionOutput = z.infer<typeof completionOutputSchema>;

/**
 * Snapshot of the commander tree at script-emit time. Each node
 * carries the bare verb name (positional placeholders stripped) +
 * recursive children + the long-form option names declared on the
 * commander Command instance (parent-scope options + global flags
 * are folded in at template-emit time per shell flavour).
 *
 * The tree is rebuilt on every invocation — emit is cheap (one walk
 * over ~100 commander nodes) and rebuilding keeps the scripts in
 * lockstep with the registry as new verbs land at v0.5+ without any
 * per-template maintenance.
 */
interface CompletionNode {
  readonly name: string;
  readonly children: readonly CompletionNode[];
  readonly options: readonly string[];
}

/**
 * Strip placeholder syntax (`get <itemId>` → `get`, `set <iid>
 * [setExpr]` → `set`) so the completion script enumerates bare
 * verbs. Commander's `Command.name()` already strips this in v14
 * but the defensive helper keeps the templates resilient to any
 * future commander shape change.
 */
const stripPlaceholders = (raw: string): string =>
  // `String.prototype.split` always returns at least one element so
  // the `?? raw` arm is unreachable from a non-empty input. The
  // commander `Command.name()` source is non-empty by construction;
  // the defensive guard stays so a future commander shape change
  // doesn't surface as an unhandled `undefined` first-token.
  /* c8 ignore next */
  raw.split(/\s+/u)[0] ?? raw;

const collectLongOptions = (cmd: Command): readonly string[] => {
  const out: string[] = [];
  for (const opt of cmd.options) {
    // Commander v14 stores the long form on `opt.long`. Every option
    // declared via `program.option('--foo …', …)` carries a non-empty
    // long-form string; the `length > 0` guard is defensive against
    // a hypothetical short-only option (not currently used anywhere
    // in `src/cli/program.ts`'s global-flag set or any verb's
    // per-command options).
    /* c8 ignore next */
    if (typeof opt.long === 'string' && opt.long.length > 0) {
      out.push(opt.long);
    }
  }
  return out;
};

const buildCompletionTree = (program: Command): CompletionNode => {
  const visit = (cmd: Command): CompletionNode => ({
    name: stripPlaceholders(cmd.name()),
    children: cmd.commands.map(visit),
    options: collectLongOptions(cmd),
  });
  return visit(program);
};

/**
 * Walk every command path from `root` down to each terminal verb,
 * yielding the dotted-path key (e.g., `''` for root, `'item'` for
 * the `item` noun, `'item get'` for the leaf verb) + the merged
 * option list at that scope (the node's own options plus root-level
 * global flags). The list is sorted lexicographically by path so
 * the emitted scripts are deterministic across runs.
 */
interface FlatPath {
  readonly path: readonly string[];
  readonly children: readonly string[];
  readonly options: readonly string[];
}

const flattenPaths = (root: CompletionNode): readonly FlatPath[] => {
  const globalOptions = root.options;
  const acc: FlatPath[] = [];
  const recur = (node: CompletionNode, path: readonly string[]): void => {
    // Merge node-scoped options with the program-root globals so
    // every depth's flag list is self-contained (`monday item get
    // --json` works because the global `--json` lives on the root
    // commander instance, not the `get` sub-command).
    const merged = new Set<string>([...globalOptions, ...node.options]);
    acc.push({
      path,
      children: node.children.map((c) => c.name).sort(),
      options: [...merged].sort(),
    });
    for (const child of node.children) {
      recur(child, [...path, child.name]);
    }
  };
  recur(root, []);
  acc.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')));
  return acc;
};

/**
 * Encode a value for safe interpolation inside POSIX-shell
 * single-quoted strings. The only metachar to escape is the
 * single quote itself — close, escape, reopen.
 */
const shSingleQuote = (raw: string): string =>
  `'${raw.replace(/'/gu, `'\\''`)}'`;

const buildBashScript = (paths: readonly FlatPath[]): string => {
  const cases: string[] = [];
  for (const entry of paths) {
    const key = entry.path.join(' ');
    const completions = [...entry.children, ...entry.options].join(' ');
    cases.push(
      `    ${shSingleQuote(key)})\n` +
        `      COMPREPLY=( $(compgen -W ${shSingleQuote(completions)} -- "$cur") )\n` +
        `      return 0\n` +
        `      ;;`,
    );
  }
  return [
    '# monday-cli bash completion',
    '# Generated by `monday completion bash` — do not edit by hand.',
    '# Install: append the output to your bashrc, e.g.',
    '#   monday completion bash >> ~/.bashrc',
    '',
    '_monday_completion() {',
    '  local cur prev words cword',
    '  COMPREPLY=()',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    '  words=("${COMP_WORDS[@]}")',
    '  cword=$COMP_CWORD',
    '',
    '  # Build the command path from the words BEFORE the current',
    '  # cursor position. Flags (anything starting with `-`) and the',
    '  # binary name itself are skipped — only positional verbs',
    '  # contribute to the path lookup.',
    '  local path=""',
    '  local i=1',
    '  while [ $i -lt $cword ]; do',
    '    local w="${words[$i]}"',
    '    case "$w" in',
    '      -*) ;;',
    '      *)',
    '        if [ -z "$path" ]; then',
    '          path="$w"',
    '        else',
    '          path="$path $w"',
    '        fi',
    '        ;;',
    '    esac',
    '    i=$((i+1))',
    '  done',
    '',
    '  case "$path" in',
    ...cases,
    '    *)',
    '      COMPREPLY=()',
    '      return 0',
    '      ;;',
    '  esac',
    '}',
    '',
    'complete -F _monday_completion monday',
    '',
  ].join('\n');
};

const buildZshScript = (paths: readonly FlatPath[]): string => {
  // compadd takes one shell word per completion candidate after `--`,
  // so we single-quote each item individually rather than pre-joining
  // into a single space-delimited string. Quoting per-item keeps the
  // emitted compadd line resilient to verb / flag names that ever
  // contain whitespace or quoting metacharacters (none today, but
  // future v0.5+ verbs added by other agents shouldn't have to know
  // the script-emit invariant to stay correct).
  const cases = paths.map((entry) => {
    const key = entry.path.join(' ');
    const items = [...entry.children, ...entry.options]
      .map(shSingleQuote)
      .join(' ');
    return (
      `    ${shSingleQuote(key)})\n` +
      `      compadd -- ${items}\n` +
      `      return 0\n` +
      `      ;;`
    );
  });
  return [
    '#compdef monday',
    '# monday-cli zsh completion',
    '# Generated by `monday completion zsh` — do not edit by hand.',
    '# Install: append the output to your zshrc, e.g.',
    '#   monday completion zsh >> ~/.zshrc',
    '',
    '_monday() {',
    '  local -a words_arr',
    '  words_arr=("${words[@]}")',
    '  local cword=$CURRENT',
    '',
    '  # Build the command path from the words BEFORE the current',
    '  # cursor position. Flags and the binary name itself are',
    '  # skipped — only positional verbs feed the lookup.',
    '  local path=""',
    '  local i=2',
    '  while [ $i -lt $cword ]; do',
    '    local w="${words_arr[$i]}"',
    '    case "$w" in',
    '      -*) ;;',
    '      *)',
    '        if [ -z "$path" ]; then',
    '          path="$w"',
    '        else',
    '          path="$path $w"',
    '        fi',
    '        ;;',
    '    esac',
    '    i=$((i+1))',
    '  done',
    '',
    '  case "$path" in',
    ...cases,
    '    *)',
    '      return 0',
    '      ;;',
    '  esac',
    '}',
    '',
    '_monday "$@"',
    '',
  ].join('\n');
};

const buildFishScript = (paths: readonly FlatPath[]): string => {
  const lines: string[] = [
    '# monday-cli fish completion',
    '# Generated by `monday completion fish` — do not edit by hand.',
    '# Install: write the output to your fish completions dir, e.g.',
    '#   monday completion fish > ~/.config/fish/completions/monday.fish',
    '',
    '# Disable file completion globally for the monday command; per-',
    '# scope rules below re-enable suggestions where appropriate.',
    'complete -c monday -f',
    '',
  ];
  for (const entry of paths) {
    const depth = entry.path.length;
    // The condition predicate enumerates how to detect "we are at',
    // this command depth": at depth 0, no subcommand seen; at depth
    // N, every prior path token has been seen AND the next token
    // has not.
    const seenChain = entry.path
      .map((p) => `__fish_seen_subcommand_from ${p}`)
      .join('; and ');
    const cond =
      depth === 0
        ? '__fish_use_subcommand'
        : seenChain;
    // Emit one `complete -c monday -n '<cond>' -a 'name' -d 'description'`
    // per direct child (sub-noun / sub-verb).
    for (const child of entry.children) {
      const desc = `(${entry.path.length === 0 ? 'top-level' : entry.path.join(' ')} ${child})`;
      lines.push(
        `complete -c monday -n ${shSingleQuote(cond)} -a ${shSingleQuote(child)} -d ${shSingleQuote(desc)}`,
      );
    }
    // Emit one `complete -c monday -n '<cond>' -l <flag>` per option
    // long-form. Skip emitting global flags at every depth — fish
    // accepts global completes once at the root.
    if (depth === 0) {
      for (const flag of entry.options) {
        // Strip the leading `--` from the long form for fish's -l.
        // Commander's long-form always starts with `--`; the `: flag`
        // arm is defensive against a hypothetical bare-name input.
        /* c8 ignore next */
        const long = flag.startsWith('--') ? flag.slice(2) : flag;
        lines.push(`complete -c monday -l ${shSingleQuote(long)}`);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
};

const buildCompletionScript = (
  shell: CompletionShell,
  program: Command,
): string => {
  const tree = buildCompletionTree(program);
  const paths = flattenPaths(tree);
  switch (shell) {
    case 'bash':
      return buildBashScript(paths);
    case 'zsh':
      return buildZshScript(paths);
    case 'fish':
      return buildFishScript(paths);
  }
};

/**
 * Exposed for unit-test access — lets the test suite build a tree
 * against a synthetic commander program (without spinning the full
 * runner) and assert structural properties.
 */
export const _internals = {
  buildCompletionTree,
  flattenPaths,
  buildCompletionScript,
  stripPlaceholders,
};

export const completionCommand: CommandModule<
  z.infer<typeof inputSchema>,
  CompletionOutput
> = {
  name: 'completion',
  summary: 'Emit a shell-completion script (bash | zsh | fish)',
  examples: [
    'monday completion bash >> ~/.bashrc',
    'monday completion zsh  >> ~/.zshrc',
    'monday completion fish >  ~/.config/fish/completions/monday.fish',
    'monday completion bash --json',
  ],
  idempotent: true,
  inputSchema,
  outputSchema: completionOutputSchema,
  attach: (program, ctx) => {
    program
      .command('completion <shell>')
      .description(completionCommand.summary)
      .addHelpText(
        'after',
        [
          '',
          'Examples:',
          ...completionCommand.examples.map((e) => `  ${e}`),
          '',
          'Notes:',
          '  - Default output is the raw shell script on stdout (no envelope).',
          '    The standard install pipes to your rc file (see examples).',
          '  - --json wraps the script in the §6 envelope (data: { shell, script }).',
          '  - --table / --output table|text|ndjson are rejected (not applicable to a script).',
          '',
        ].join('\n'),
      )
      .action((shellArg: unknown) => {
        // Argv parse boundary — validates the positional against
        // the closed 3-value enum BEFORE the output-format dispatch
        // runs, so a premature `monday completion floppy` invocation
        // surfaces `usage_error` from the parse boundary (NOT a
        // confusing "format not applicable" message).
        const parsed = parseArgv(completionCommand.inputSchema, {
          shell: shellArg,
        });

        const globalFlags = parseGlobalFlags(program.opts(), ctx.env);

        // Detect whether the caller explicitly opted into an output
        // format. The cli-design §3.1 #2 raw-bytes carve-out is
        // explicit: default behaviour (no flag, no env) emits raw
        // bytes regardless of TTY / pipe context. Going through
        // `selectOutput` would silently collapse "no opt-in" to
        // either `table` (TTY) or `json` (pipe) — neither matches
        // the carve-out's "raw bytes by default" contract.
        const envOutput = ctx.env.MONDAY_OUTPUT;
        const envOptIn = envOutput !== undefined && envOutput !== '';
        const optedIn =
          globalFlags.json ||
          globalFlags.table ||
          globalFlags.output !== undefined ||
          envOptIn;

        if (!optedIn) {
          // Default raw-bytes mode. Writes the script directly to
          // stdout with NO envelope wrap — the standard install flow
          // `monday completion bash >> ~/.bashrc` relies on this. No
          // secret-redaction pass is needed: the script bytes are
          // built from `program.commands` + global option names,
          // both compile-time constants with no env interpolation.
          // The integration test suite pins a LEAK_CANARY assertion
          // to catch future drift.
          const script = buildCompletionScript(parsed.shell, program);
          ctx.stdout.write(script);
          return;
        }

        // Reject inapplicable formats BEFORE building the script.
        // The cli-design §3.1 #2 carve-out documents three modes:
        // default raw bytes, `--json` envelope, and rejection for
        // every other format. `text` and `ndjson` are accessible
        // only via `--output <fmt>` (NOT as standalone `--text` /
        // `--ndjson` shorthand flags — only `--json` and `--table`
        // are shorthands per §4.4).
        if (globalFlags.table) {
          throw new UsageError(
            'output format not applicable to monday completion: ' +
              '--table is rejected (the verb emits a shell script — ' +
              'raw bytes by default, JSON envelope via --json).',
          );
        }
        if (
          globalFlags.output === 'table' ||
          globalFlags.output === 'text' ||
          globalFlags.output === 'ndjson'
        ) {
          throw new UsageError(
            `output format not applicable to monday completion: ` +
              `--output ${globalFlags.output} is rejected (the verb emits ` +
              `a shell script — raw bytes by default, JSON envelope via --json).`,
          );
        }
        // Reject MONDAY_OUTPUT=<non-json> on the env path too. The
        // env opt-in is symmetric with the flag opt-in: only
        // MONDAY_OUTPUT=json maps onto the envelope mode; everything
        // else routes through this rejection.
        if (
          globalFlags.output === undefined &&
          !globalFlags.json &&
          envOptIn &&
          envOutput !== 'json'
        ) {
          throw new UsageError(
            `output format not applicable to monday completion: ` +
              `MONDAY_OUTPUT=${envOutput} is rejected (the verb emits ` +
              `a shell script — raw bytes by default, JSON envelope via --json).`,
          );
        }

        // At this point the caller opted INTO the `--json` envelope
        // path (either `--json`, `--output json`, or
        // `MONDAY_OUTPUT=json`). Build the script + emit through
        // the standard §6 envelope. `source: 'none'` mirrors
        // `monday config show` / `monday config path` cadence for
        // CLI-internal verbs — no Monday API call, no cache, so the
        // data-source field carries the same "no upstream" value.
        const script = buildCompletionScript(parsed.shell, program);
        emitSuccess({
          ctx,
          data: { shell: parsed.shell, script },
          schema: completionCommand.outputSchema,
          programOpts: program.opts(),
          source: 'none',
          cacheAgeSeconds: null,
        });
      });
  },
};
