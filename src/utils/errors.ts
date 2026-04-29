/**
 * Typed errors for the CLI. Every thrown error carries a stable
 * `code` from `cli-design.md` §6.5 — agents key off the code, never
 * the English `message`. The 26 codes below are the v0.1 frozen set;
 * `dev_*` codes ship in v0.3 but are listed here so the M5b agent
 * doesn't need to backfill the type.
 */

export const ERROR_CODES = [
  'usage_error',
  'confirmation_required',
  'not_found',
  'ambiguous_name',
  'ambiguous_column',
  'column_not_found',
  'user_not_found',
  'unsupported_column_type',
  'column_archived',
  'unauthorized',
  'forbidden',
  'rate_limited',
  'complexity_exceeded',
  'daily_limit_exceeded',
  'concurrency_exceeded',
  'ip_rate_limited',
  'resource_locked',
  'validation_failed',
  'stale_cursor',
  'config_error',
  'cache_error',
  'network_error',
  'timeout',
  'dev_not_configured',
  'dev_board_misconfigured',
  'internal_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * The CLI's exit code surface (`cli-design.md` §3.1 #5).
 * Agents key off these too; never reuse a number for a different meaning.
 */
export type ExitCode = 0 | 1 | 2 | 3 | 130;

export interface MondayCliErrorOptions {
  readonly httpStatus?: number;
  readonly mondayCode?: string;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

/**
 * Base class for everything thrown out of `commands/` and `api/`.
 * The shape mirrors `cli-design.md` §6.5 one-to-one — the runner
 * builds the JSON envelope by reading these fields.
 */
export class MondayCliError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number | undefined;
  readonly mondayCode: string | undefined;
  readonly requestId: string | undefined;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: MondayCliErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.mondayCode = options.mondayCode;
    this.requestId = options.requestId;
    // `retryable` defaults from a per-code table so callers can stay
    // terse when the default matches; explicit `false`/`true` always wins.
    this.retryable = options.retryable ?? CODE_RETRYABLE_DEFAULT[code];
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.details = options.details;
  }
}

/**
 * `cli-design.md` §6.5 retryable column. Defaults only — callers
 * override when Monday's response says otherwise (e.g. a `cache_error`
 * that's auto-retried without cache becomes non-retryable to the user).
 */
const CODE_RETRYABLE_DEFAULT: Record<ErrorCode, boolean> = {
  usage_error: false,
  confirmation_required: false,
  not_found: false,
  ambiguous_name: false,
  ambiguous_column: false,
  column_not_found: false,
  user_not_found: false,
  unsupported_column_type: false,
  column_archived: false,
  unauthorized: false,
  forbidden: false,
  rate_limited: true,
  complexity_exceeded: true,
  daily_limit_exceeded: false,
  concurrency_exceeded: true,
  ip_rate_limited: true,
  resource_locked: true,
  validation_failed: false,
  stale_cursor: false,
  config_error: false,
  cache_error: true,
  network_error: true,
  timeout: true,
  dev_not_configured: false,
  dev_board_misconfigured: false,
  internal_error: false,
};

/** Bad flag / missing positional / mutually exclusive inputs. */
export class UsageError extends MondayCliError {
  constructor(message: string, options: MondayCliErrorOptions = {}) {
    super('usage_error', message, options);
  }
}

/** Destructive op without `--yes` (`cli-design.md` §3.1 #7). */
export class ConfirmationRequiredError extends MondayCliError {
  constructor(message: string, options: MondayCliErrorOptions = {}) {
    super('confirmation_required', message, options);
  }
}

/** Missing/invalid token, malformed config. Exit code 3. */
export class ConfigError extends MondayCliError {
  constructor(message: string, options: MondayCliErrorOptions = {}) {
    super('config_error', message, options);
  }
}

/** Local cache I/O failure — auto-retried without cache. */
export class CacheError extends MondayCliError {
  constructor(message: string, options: MondayCliErrorOptions = {}) {
    super('cache_error', message, options);
  }
}

/**
 * Anything originating from the Monday API or transport layer —
 * the API client (M2) maps GraphQL/HTTP/network failures to a
 * specific code via `new ApiError(code, ...)`.
 */
export class ApiError extends MondayCliError {}

/** Last-resort code for unknown errors — comes with a "report this" hint. */
export class InternalError extends MondayCliError {
  constructor(message: string, options: MondayCliErrorOptions = {}) {
    super('internal_error', message, options);
  }
}

/**
 * Abort reasons. The runner attaches one of these to the wrapper
 * AbortController's `signal.reason`; the API client / transport
 * inspects it so timeouts and SIGINT don't collapse onto a single
 * exit code (see `v0.1-plan.md` risk register).
 */
export type AbortReason =
  | { readonly kind: 'timeout'; readonly afterMs: number }
  | { readonly kind: 'sigint' }
  | { readonly kind: 'cancel'; readonly reason?: string };

/**
 * Maps an error code to the exit code documented in `cli-design.md`
 * §3.1 #5. Note `confirmation_required` is *not* exit 1 — it's a
 * usage-style error that still wants a non-zero exit, but the design
 * explicitly groups everything that's "the CLI rejected the call"
 * under exit 1.
 */
export const exitCodeForError = (code: ErrorCode): ExitCode => {
  switch (code) {
    case 'usage_error':
    case 'confirmation_required':
      return 1;
    case 'config_error':
      return 3;
    case 'not_found':
    case 'ambiguous_name':
    case 'ambiguous_column':
    case 'column_not_found':
    case 'user_not_found':
    case 'unsupported_column_type':
    case 'column_archived':
    case 'unauthorized':
    case 'forbidden':
    case 'rate_limited':
    case 'complexity_exceeded':
    case 'daily_limit_exceeded':
    case 'concurrency_exceeded':
    case 'ip_rate_limited':
    case 'resource_locked':
    case 'validation_failed':
    case 'stale_cursor':
    case 'cache_error':
    case 'network_error':
    case 'timeout':
    case 'dev_not_configured':
    case 'dev_board_misconfigured':
    case 'internal_error':
      return 2;
  }
};

/**
 * Maps an `AbortReason` to its surfaced error. SIGINT bypasses the
 * envelope entirely (exit 130, no JSON on stderr — agents reading
 * exit codes from `kill` already know why); timeouts are an `ApiError`
 * with `code: "timeout"`; explicit `cancel` is whatever the caller
 * decided when they aborted.
 */
export const errorForAbortReason = (reason: AbortReason): MondayCliError => {
  switch (reason.kind) {
    case 'timeout':
      return new ApiError(
        'timeout',
        `request timed out after ${reason.afterMs.toString()}ms`,
        { details: { timeout_ms: reason.afterMs } },
      );
    case 'sigint':
      // The runner short-circuits on SIGINT before this is read, but
      // surfacing a typed error keeps the contract symmetric.
      return new MondayCliError('internal_error', 'aborted by SIGINT', {
        details: { abort_reason: 'sigint' },
      });
    case 'cancel':
      return new MondayCliError(
        'internal_error',
        reason.reason ?? 'cancelled',
        { details: { abort_reason: 'cancel' } },
      );
  }
};
