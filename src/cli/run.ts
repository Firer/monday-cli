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
  type AbortReason,
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
   * External abort source. `runWithSignals` provides one tied to
   * `SIGINT`; tests pass their own to drive the cancel path
   * deterministically. The runner combines this with its own
   * controller so either side can trigger a clean shutdown.
   */
  readonly signal?: AbortSignal;
  /**
   * Hook for tests and (later) milestones to register additional
   * commands on the program. Receives the program *and* the live
   * `RunContext` so registered actions can read `ctx.signal`,
   * `ctx.transport`, `ctx.env`, etc. Codex review §9 caught the
   * earlier (program-only) shape: `transport` was on `RunOptions`
   * but never reachable from a registered action.
   *
   * M1+ replaces this hook with a static command registry; the
   * `RunContext` argument stays.
   */
  readonly registerCommands?: (program: Command, ctx: RunContext) => void;
}

export interface RunResult {
  readonly exitCode: ExitCode;
}

/**
 * Public per-invocation context every command receives. Built by
 * `run()` once per call; threaded into `registerCommands(program,
 * ctx)` so actions can pull the signal, transport, env, and logging
 * surfaces without re-deriving them.
 */
export interface RunContext {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
  readonly stdin?: NodeJS.ReadableStream;
  readonly isTTY: boolean;
  readonly clock: () => Date;
  readonly transport: Transport | undefined;
  readonly requestId: string;
  readonly cliVersion: string;
  /**
   * Aborts when the runner is shutting down — caller cancel,
   * SIGINT, or future timeout. Commands awaiting long work should
   * thread this into `transport.request({signal})` and bail
   * cooperatively when the signal fires.
   */
  readonly signal: AbortSignal;
}

/** Internal extension of `RunContext` with envelope-building bits. */
interface InternalContext extends RunContext {
  readonly retrievedAt: string;
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

const buildBaseMeta = (ctx: InternalContext): Meta =>
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
  ctx: InternalContext,
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

const isSigintReason = (reason: unknown): boolean => {
  if (typeof reason !== 'object' || reason === null) {
    return false;
  }
  const tagged = reason as { kind?: unknown };
  return tagged.kind === 'sigint';
};

const buildProgram = (options: RunOptions, ctx: RunContext): Command => {
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
    .option('-y, --yes', 'skip confirmation gate on destructive ops')
    .option('--body-file <path>', 'read --body content from a file (or - for stdin)')
    .option('--query-file <path>', 'monday raw: read GraphQL query from a file (or -)')
    .option('--vars-file <path>', 'monday raw: read GraphQL variables from a file (or -)');

  options.registerCommands?.(program, ctx);

  return program;
};

export const run = async (options: RunOptions): Promise<RunResult> => {
  const requestId = (
    options.requestIdGenerator ?? defaultRequestIdGenerator
  )();
  const clock = options.clock ?? (() => new Date());

  // Internal abort controller, optionally combined with a caller-
  // supplied signal so either side can trigger shutdown. Commands
  // read `ctx.signal`; the runner inspects `signal.reason` after
  // the action returns to distinguish SIGINT (exit 130) from other
  // aborts (caller-defined).
  const internalAbort = new AbortController();
  const combinedSignal: AbortSignal =
    options.signal === undefined
      ? internalAbort.signal
      : AbortSignal.any([options.signal, internalAbort.signal]);

  const ctx: InternalContext = {
    env: options.env,
    stdout: options.stdout,
    stderr: options.stderr,
    ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
    isTTY: options.isTTY,
    clock,
    transport: options.transport,
    requestId,
    cliVersion: options.cliVersion,
    signal: combinedSignal,
    retrievedAt: clock().toISOString(),
    secrets: collectSecrets(options.env),
  };

  const program = buildProgram(options, ctx);

  try {
    await program.parseAsync(options.argv);
    if (combinedSignal.aborted && isSigintReason(combinedSignal.reason)) {
      return { exitCode: 130 };
    }
    return { exitCode: 0 };
  } catch (err) {
    // SIGINT-during-action takes precedence: the design says exit
    // 130 with no envelope on stderr. The action's thrown error is
    // a downstream consequence of the abort; surfacing it would
    // muddle the contract.
    if (combinedSignal.aborted && isSigintReason(combinedSignal.reason)) {
      return { exitCode: 130 };
    }

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
 * Wraps `run()` with `process.on('SIGINT', ...)` so a Ctrl-C
 * triggers a real abort: an `AbortController` fires with reason
 * `{kind:'sigint'}` and the signal is threaded into `ctx.signal`
 * via `RunOptions.signal`. Commands awaiting transport requests
 * see the abort and can bail; the runner then returns 130 without
 * an envelope per `cli-design.md` §3.1 #5.
 *
 * This is the production surface; unit tests typically call `run()`
 * directly with their own `signal` to deterministically drive the
 * cancel path.
 */
export const runWithSignals = async (
  options: RunOptions,
): Promise<RunResult> => {
  const ctrl = new AbortController();
  const onInt = (): void => {
    const reason: AbortReason = { kind: 'sigint' };
    ctrl.abort(reason);
  };
  process.on('SIGINT', onInt);
  try {
    return await run({ ...options, signal: ctrl.signal });
  } finally {
    process.off('SIGINT', onInt);
  }
};
