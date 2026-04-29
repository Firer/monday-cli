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
  /**
   * Process env, used to auto-collect known sensitive values for
   * the redactor's value-scan layer. When set, the logger pulls
   * `MONDAY_API_TOKEN` (if non-empty) and merges it into
   * `redactOptions.secrets`. This is the default-safe path for
   * `--verbose` debug output — without it, a future caller that
   * forgets to thread `redactOptions.secrets` through would leak
   * the token verbatim into stderr (Codex M2 review §5).
   */
  readonly env?: NodeJS.ProcessEnv;
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
  const { stderr, isTTY, verbose, quiet, redactOptions, env } = options;

  // Re-read env at write-time so a token loaded by `loadConfig`'s
  // dotenv after the logger was constructed still gets scrubbed —
  // matches the runner's collectSecrets-on-emit pattern.
  const envForSecrets = env;
  const write = (level: LogLevel, payload: unknown): void => {
    const explicitSecrets = redactOptions?.secrets ?? [];
    const envToken = envForSecrets?.MONDAY_API_TOKEN;
    const envSecrets =
      typeof envToken === 'string' && envToken.length > 0 ? [envToken] : [];
    const mergedSecrets = [...explicitSecrets, ...envSecrets];
    const effectiveOptions: RedactOptions =
      mergedSecrets.length > 0
        ? { ...(redactOptions ?? {}), secrets: mergedSecrets }
        : redactOptions ?? {};
    const redacted = redact(payload, effectiveOptions);
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
