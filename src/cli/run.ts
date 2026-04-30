import { CommanderError, type Command } from 'commander';
import {
  exitCodeForError,
  type AbortReason,
  type ExitCode,
} from '../utils/errors.js';
import {
  defaultRequestIdGenerator,
  type RequestIdGenerator,
} from '../utils/request-id.js';
import {
  buildBaseMeta,
  createMetaBuilder,
  toMondayError,
  writeErrorEnvelope,
  type MetaBuilder,
} from './envelope-out.js';
import { buildProgram } from './program.js';
import type { Transport } from '../api/transport.js';
import type { CommandModule } from '../commands/types.js';

/**
 * Testable CLI runner (`v0.1-plan.md` §3 M0).
 *
 * Replaces `process.argv` / `process.env` / `process.stdout` direct
 * reads in `cli/index.ts` with an injectable shape so tests exercise
 * the same envelope-conversion / exit-code / SIGINT plumbing the
 * published binary uses. The thin shebang in `cli/index.ts` forwards
 * the live process state into here. Owns the runtime core — argv →
 * commander parse, signal combining, request-id generation, error →
 * envelope conversion. Commander wiring lives in `program.ts`;
 * envelope construction in `envelope-out.ts` (M2.5 R2).
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
   * Test-only override of the static command registry. Production
   * callers leave it unset and the runner walks `commandRegistry`
   * (`src/commands/index.ts`). Tests pass a tailored list to
   * register dummy `self-test`-style commands without touching the
   * production registry — same `attach(program, ctx)` shape, same
   * envelope path, no fork in the action plumbing.
   */
  readonly extraCommands?: readonly CommandModule[];
  /**
   * Lower-level hook for tests that want to drive commander
   * directly (raw `program.command(...)` calls) without going
   * through the `CommandModule` shape. Receives the program *and*
   * the live `RunContext` so registered actions can read
   * `ctx.signal`, `ctx.transport`, `ctx.env`, etc. Production
   * callers leave it unset.
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
  /**
   * Action-resolved meta for the **error** path only. Commands that
   * commit values via `ctx.meta.setApiVersion(v)` / `setSource('live')`
   * get them reported on the error envelope if the action throws.
   * Success envelopes get the same values via `emitSuccess`'s options
   * (the `...toEmit(result)` splat from `resolveClient`); both channels
   * agree because `resolveClient` writes to both. Full rationale:
   * `envelope-out.ts` (M2.5 R2).
   */
  readonly meta: MetaBuilder;
}

const isSigintReason = (reason: unknown): boolean => {
  if (typeof reason !== 'object' || reason === null) {
    return false;
  }
  const tagged = reason as { kind?: unknown };
  return tagged.kind === 'sigint';
};

export const run = async (options: RunOptions): Promise<RunResult> => {
  const requestId = (
    options.requestIdGenerator ?? defaultRequestIdGenerator
  )();
  const clock = options.clock ?? (() => new Date());
  const retrievedAt = clock().toISOString();

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

  const meta = createMetaBuilder();

  const ctx: RunContext = {
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
    meta,
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

    // commander.helpDisplayed / commander.version are success-style;
    // treat them as exit 0 with no envelope.
    if (err instanceof CommanderError && err.exitCode === 0) {
      return { exitCode: 0 };
    }

    const cliError = toMondayError(err);
    writeErrorEnvelope(cliError, {
      stderr: options.stderr,
      env: options.env,
      meta: buildBaseMeta({
        snapshot: meta.snapshot(),
        env: options.env,
        cliVersion: options.cliVersion,
        requestId,
        retrievedAt,
      }),
    });
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
