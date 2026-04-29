import { Command, CommanderError } from 'commander';
import {
  buildError,
  buildMeta,
  type Meta,
} from '../utils/output/envelope.js';
import {
  InternalError,
  MondayCliError,
  UsageError,
  exitCodeForError,
  type ExitCode,
} from '../utils/errors.js';
import { redact } from '../utils/redact.js';
import {
  defaultRequestIdGenerator,
  type RequestIdGenerator,
} from '../utils/request-id.js';
import type { Transport } from '../api/transport.js';

/**
 * Testable CLI runner (`v0.1-plan.md` §3 M0).
 *
 * Replaces the `process.argv` / `process.env` / `process.stdout`
 * direct reads in `cli/index.ts` with an injectable shape, so tests
 * exercise the same envelope-conversion / exit-code / SIGINT plumbing
 * the published binary uses. The thin shebang in `cli/index.ts`
 * forwards the live process state into here.
 *
 * Coverage applies to this module — `cli/index.ts` stays excluded
 * because spawning the binary is what the E2E suite is for, not a
 * coverage target.
 */
export interface RunOptions {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  readonly cliVersion: string;
  readonly cliDescription?: string;
  readonly clock?: () => Date;
  readonly transport?: Transport;
  readonly requestIdGenerator?: RequestIdGenerator;
  /**
   * Hook for tests and (later) milestones to register additional
   * commands on the program. M1+ will replace this with a static
   * registry — for M0 it's the seam that keeps `run.ts` testable
   * before any command exists.
   */
  readonly registerCommands?: (program: Command) => void;
}

export interface RunResult {
  readonly exitCode: ExitCode;
}

interface RunContext {
  readonly requestId: string;
  readonly cliVersion: string;
  readonly retrievedAt: string;
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
  /**
   * Literal secret values to scrub from any string the runner emits
   * (envelopes, logs). Sourced from env at runner construction so a
   * token in `Error.message` or a fetch URL still gets redacted.
   * The list is best-effort: if the user hasn't set MONDAY_API_TOKEN,
   * there's nothing to scan for, but key-based redaction still
   * catches the common shapes.
   */
  readonly secrets: readonly string[];
}

const collectSecrets = (env: NodeJS.ProcessEnv): readonly string[] => {
  const out: string[] = [];
  const token = env.MONDAY_API_TOKEN;
  if (token !== undefined && token.length > 0) {
    out.push(token);
  }
  return out;
};

const buildBaseMeta = (ctx: RunContext): Meta =>
  buildMeta({
    api_version: ctx.env.MONDAY_API_VERSION ?? '2026-01',
    cli_version: ctx.cliVersion,
    request_id: ctx.requestId,
    source: 'none',
    retrieved_at: ctx.retrievedAt,
    cache_age_seconds: null,
  });

const writeErrorEnvelope = (
  err: MondayCliError,
  ctx: RunContext,
): void => {
  const envelope = buildError(err, buildBaseMeta(ctx));
  const redacted = redact(envelope, { secrets: ctx.secrets });
  ctx.stderr.write(`${JSON.stringify(redacted, null, 2)}\n`);
};

const isCommanderError = (err: unknown): err is CommanderError =>
  err instanceof CommanderError;

const toMondayError = (err: unknown): MondayCliError => {
  if (err instanceof MondayCliError) {
    return err;
  }
  if (isCommanderError(err)) {
    // Commander surfaces both --help/--version and parsing failures
    // as CommanderError. The success-style ones carry exitCode 0;
    // those aren't errors and we never reach this function with one.
    if (err.code === 'commander.helpDisplayed' || err.code === 'commander.version') {
      return new InternalError(`unexpected commander success: ${err.code}`);
    }
    return new UsageError(err.message);
  }
  if (err instanceof Error) {
    return new InternalError(err.message, { cause: err });
  }
  return new InternalError('unknown error', { cause: err });
};

const buildProgram = (options: RunOptions): Command => {
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
      // Swallow commander's plain-text error preamble — the catch-
      // all below emits a §6 error envelope with the same content
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
    .option('-y, --yes', 'skip confirmation gate on destructive ops');

  options.registerCommands?.(program);

  return program;
};

export const run = async (options: RunOptions): Promise<RunResult> => {
  const requestId = (
    options.requestIdGenerator ?? defaultRequestIdGenerator
  )();
  const clock = options.clock ?? (() => new Date());
  const ctx: RunContext = {
    requestId,
    cliVersion: options.cliVersion,
    retrievedAt: clock().toISOString(),
    stderr: options.stderr,
    env: options.env,
    secrets: collectSecrets(options.env),
  };

  const program = buildProgram(options);

  try {
    await program.parseAsync(options.argv);
    return { exitCode: 0 };
  } catch (err) {
    if (isCommanderError(err)) {
      // commander.helpDisplayed / commander.version are success-style;
      // treat them as exit 0 with no envelope.
      if (err.exitCode === 0) {
        return { exitCode: 0 };
      }
    }

    const cliError = toMondayError(err);
    writeErrorEnvelope(cliError, ctx);
    return { exitCode: exitCodeForError(cliError.code) };
  }
};

/**
 * Wraps `run()` with `process.on('SIGINT', ...)` so a Ctrl-C between
 * commander's parse and the command's action triggers a graceful
 * 130 exit. This is the production surface; tests call `run()`
 * directly without the signal wiring.
 */
export const runWithSignals = async (
  options: RunOptions,
): Promise<RunResult> => {
  const state: { interrupted: boolean } = { interrupted: false };
  const onInt = (): void => {
    state.interrupted = true;
  };
  process.on('SIGINT', onInt);
  try {
    const result = await run(options);
    if (state.interrupted) {
      return { exitCode: 130 };
    }
    return result;
  } finally {
    process.off('SIGINT', onInt);
  }
};

