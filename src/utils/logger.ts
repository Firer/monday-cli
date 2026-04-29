import { redact, type RedactOptions } from './redact.js';

/**
 * stderr-only structured logger. Stdout carries the result; stderr
 * is for human-only signal (`cli-design.md` §3.1 rule 1). Every
 * payload runs through `redact()` first so the Monday API token
 * never reaches a log line under any verbosity.
 *
 * Level matrix (`cli-design.md` §3.1, §4.4):
 * - `error` — always emitted; even `--quiet` keeps these.
 * - `warn`  — suppressed by `--quiet`; otherwise stderr text.
 * - `info`  — TTY-only (follow-up hints, progress). Off when piped.
 * - `debug` — `--verbose` only (request bodies, complexity cost).
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LoggerOptions {
  readonly stderr: NodeJS.WritableStream;
  readonly isTTY: boolean;
  readonly verbose: boolean;
  readonly quiet: boolean;
  readonly redactOptions?: RedactOptions;
}

export interface Logger {
  error: (payload: unknown) => void;
  warn: (payload: unknown) => void;
  info: (payload: unknown) => void;
  debug: (payload: unknown) => void;
}

const formatPayload = (payload: unknown): string => {
  if (typeof payload === 'string') {
    return payload;
  }
  if (payload === undefined) {
    return 'undefined';
  }
  return JSON.stringify(payload);
};

export const createLogger = (options: LoggerOptions): Logger => {
  const { stderr, isTTY, verbose, quiet, redactOptions } = options;

  const write = (level: LogLevel, payload: unknown): void => {
    const redacted = redact(payload, redactOptions);
    stderr.write(`monday: [${level}] ${formatPayload(redacted)}\n`);
  };

  return {
    error: (payload) => {
      write('error', payload);
    },
    warn: (payload) => {
      if (!quiet) {
        write('warn', payload);
      }
    },
    info: (payload) => {
      if (isTTY && !quiet) {
        write('info', payload);
      }
    },
    debug: (payload) => {
      if (verbose) {
        write('debug', payload);
      }
    },
  };
};
