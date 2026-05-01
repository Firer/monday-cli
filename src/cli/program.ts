/**
 * Commander program construction (M2.5 R2).
 *
 * Pulled out of `cli/run.ts` so the runner stays focused on argv
 * parsing, signal combining, and error-envelope plumbing. This
 * module owns:
 *
 *   - the program-level metadata (`name`, `description`, `version`);
 *   - the `configureOutput` adapters that route commander writes to
 *     the runner's `stdout`/`stderr` streams;
 *   - the global-flag option declarations (one source of truth — the
 *     zod-validated shape lives in `src/types/global-flags.ts`);
 *   - command attachment (registry → extras → raw `registerCommands`).
 *
 * `buildProgram` doesn't run argv through commander — that's still
 * `run()`'s job. It only constructs the configured `Command`
 * instance.
 */

import { Command } from 'commander';
import { getCommandRegistry } from '../commands/index.js';
import { parseGlobalFlags } from '../types/global-flags.js';
import { PINNED_API_VERSION } from '../api/client.js';
import type { RunContext, RunOptions } from './run.js';

/**
 * Subset of `RunOptions` `buildProgram` actually consumes. Keeping the
 * input type narrow makes the dependency obvious — adding a field to
 * `RunOptions` doesn't silently feed into program construction unless
 * it's listed here.
 */
export type BuildProgramOptions = Pick<
  RunOptions,
  | 'cliVersion'
  | 'cliDescription'
  | 'stdout'
  | 'stderr'
  | 'extraCommands'
  | 'registerCommands'
>;

export const buildProgram = (
  options: BuildProgramOptions,
  ctx: RunContext,
): Command => {
  const program = new Command();
  program
    .name('monday')
    .description(options.cliDescription ?? 'CLI for Monday.com')
    .version(options.cliVersion, '-V, --version')
    .exitOverride()
    .configureOutput({
      writeOut: (str) => {
        options.stdout.write(str);
      },
      writeErr: (str) => {
        options.stderr.write(str);
      },
      // Swallow commander's plain-text error preamble — the runner's
      // catch-all emits a §6 error envelope with the same content
      // in a stable shape. Without this, stderr would carry both
      // "error: unknown option" *and* the envelope, breaking the
      // "stderr is the envelope, period" contract.
      outputError: () => {
        // intentionally empty
      },
    });

  // Global flags — see `src/types/global-flags.ts` for the validated
  // shape. We declare the option surface here so commander knows
  // how to parse argv; refinement happens per-command via the zod
  // schema at the action boundary.
  program
    .option('--output <fmt>', 'json | table | text | ndjson')
    .option('--json', 'shorthand for --output json')
    .option('--table', 'shorthand for --output table')
    .option('--full', 'disable table value truncation')
    .option('--width <n>', 'force table target width (TTY only)')
    .option('--columns <list>', 'comma-separated visible columns')
    .option('--minimal', 'omit non-essential fields from JSON')
    .option('-q, --quiet', 'suppress stderr progress and hints')
    .option('-v, --verbose', 'debug logs to stderr (tokens redacted)')
    .option('--no-color', 'disable colour output')
    .option('--no-cache', 'skip the local board-metadata cache')
    .option('--profile <name>', 'config profile (v0.3+; "default" only in v0.1)')
    .option('--api-version <v>', 'override the API-Version header')
    .option('--timeout <ms>', 'per-request timeout in milliseconds')
    .option('--retry <n>', 'max retries on transient errors')
    .option('--dry-run', 'mutations: print planned change, do not execute')
    .option('-y, --yes', 'skip confirmation gate on destructive ops')
    .option('--body-file <path>', 'read --body content from a file (or - for stdin)');

  // Wire the static registry first, then any test-supplied extras /
  // raw hooks. Tests can swap out the registry entirely by passing
  // an empty `extraCommands` and using `registerCommands` for ad-hoc
  // commands; production callers leave both unset and pick up the
  // shipped surface.
  const modules = options.extraCommands ?? getCommandRegistry();
  for (const mod of modules) {
    mod.attach(program, ctx);
  }
  options.registerCommands?.(program, ctx);

  // Commit the resolved `--api-version` to the per-invocation meta
  // builder BEFORE any subcommand action runs. The success path
  // re-commits via `resolveClient`; this preAction hook covers the
  // pre-`resolveClient` failure surface — `parseArgv` throwing a
  // `UsageError` on a bad positional, or any other zod-rejection at
  // the action boundary. Without this, `monday --api-version 2026-04
  // item get bad-id --json` produced a usage_error envelope claiming
  // `meta.api_version: "2026-01"` (the SDK pin), losing the
  // `--api-version` agents passed (Codex M4 pass-2 §3).
  //
  // Resolution priority matches `resolveClient`: explicit flag > env
  // > SDK pin. We don't load config here (that surfaces a separate
  // `config_error` if the token is missing); the apiVersion override
  // is independent of token resolution.
  program.hook('preAction', () => {
    try {
      const flags = parseGlobalFlags(program.opts(), ctx.env);
      const resolvedVersion =
        flags.apiVersion ??
        ctx.env.MONDAY_API_VERSION ??
        PINNED_API_VERSION;
      ctx.meta.setApiVersion(resolvedVersion);
    } catch {
      // Bad global-flag shape is already a usage_error path the
      // runner's catch-all will surface; the preAction hook just
      // tries best-effort.
    }
  });

  return program;
};
