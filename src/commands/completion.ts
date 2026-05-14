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
 * cli-design §1 "minimum deps" principle is binding); the M33 IMPL
 * session enumerates `program.commands` + each command's options
 * inside the templates so completions stay in sync with the registry.
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
 * **Idempotent: yes** (deterministic per shell flavour).
 *
 * **Pre-flight stub at v0.4-M33.** Argv parsing + commander wiring +
 * the `--json` output schema all ship as the real shipped surface;
 * the action body is c8-ignored and throws `internal_error` with
 * `details.deferred_to: 'v0.4-M33 IMPL'` so a premature invocation
 * surfaces a clear "not yet implemented" signal (M31 pre-flight
 * round-1 P2-2 lesson — pre-flight stubs MUST NOT emit `ok: true`
 * bogus envelopes). The per-shell hand-rolled script templates land
 * at M33 IMPL.
 */
import { z } from 'zod';
import type { CommandModule } from './types.js';
import { parseArgv } from './parse-argv.js';
import { ApiError } from '../utils/errors.js';

/**
 * Closed 3-value enum of shell flavours the CLI knows how to emit a
 * completion script for. Adding a 4th value (e.g. `powershell`,
 * `nushell`) is a SemVer-minor expansion at the M33 contract + a
 * matching hand-rolled template in M33 IMPL.
 */
export const COMPLETION_SHELLS = ['bash', 'zsh', 'fish'] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

/**
 * zod enum binding for the closed 3-value shell flavour. Exported so
 * the M33 IMPL session (and downstream `monday schema completion`
 * introspection consumers) can pin against the same enum the argv
 * parse boundary uses.
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
  attach: (program, _ctx) => {
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
        // Argv parse boundary — real shipped surface at pre-flight.
        // Validates the positional against the closed 3-value enum
        // BEFORE the deferred-feature throw fires, so a premature
        // `monday completion floppy` invocation surfaces the
        // `usage_error` from the schema (not the `internal_error`
        // from the c8-ignored stub body).
        parseArgv(completionCommand.inputSchema, { shell: shellArg });
        /* c8 ignore start */
        // Pre-flight stub — runtime body lands at v0.4-M33 IMPL. The
        // deferred_to detail keeps an early caller from confusing
        // "not yet implemented" with a wire-side internal_error.
        throw new ApiError(
          'internal_error',
          'monday completion: pre-flight stub — runtime body lands at v0.4-M33 IMPL.',
          {
            details: {
              deferred_to: 'v0.4-M33 IMPL',
              milestone: 'M33',
            },
          },
        );
        /* c8 ignore stop */
      });
  },
};
