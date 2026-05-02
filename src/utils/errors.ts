/**
 * Typed errors for the CLI. Every thrown error carries a stable
 * `code` from `cli-design.md` §6.5 — agents key off the code, never
 * the English `message`. v0.1 froze 26 codes; `ambiguous_match` ships
 * in v0.2 M12 (`item upsert` with 2+ matches), bringing the count to
 * 27. `dev_*` codes ship in v0.3 but are listed here so the M5b agent
 * doesn't need to backfill the type.
 */

export const ERROR_CODES = [
  'usage_error',
  'confirmation_required',
  'not_found',
  'ambiguous_name',
  'ambiguous_column',
  'ambiguous_match',
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
 *
 * Exported because `monday schema` surfaces this per code so agents
 * can decide retry strategy without consuming a real error envelope
 * first (Codex review §3). Frozen so a future import can't mutate
 * the table out from under the schema emitter (the runtime view of
 * the contract should be the same one across the process lifetime).
 */
export const CODE_RETRYABLE_DEFAULT: Readonly<Record<ErrorCode, boolean>> = Object.freeze({
  usage_error: false,
  confirmation_required: false,
  not_found: false,
  ambiguous_name: false,
  ambiguous_column: false,
  ambiguous_match: false,
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
});

/**
 * Best-effort hint for the HTTP status the user would observe when
 * this error originates from Monday. Most Monday application errors
 * arrive with `200 OK` and a GraphQL `errors[]` payload, so a
 * `null` here means "no fixed expectation; check the live envelope's
 * `http_status` field". Surfaced via `monday schema` so agents can
 * pre-build retry / backoff logic without observing an error first.
 *
 * Frozen for the same reason as `CODE_RETRYABLE_DEFAULT`.
 */
export const CODE_TYPICAL_HTTP_STATUS: Readonly<Record<ErrorCode, number | null>> = Object.freeze({
  usage_error: null,
  confirmation_required: null,
  not_found: 200,
  ambiguous_name: null,
  ambiguous_column: null,
  ambiguous_match: null,
  column_not_found: null,
  user_not_found: null,
  unsupported_column_type: null,
  column_archived: 200,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 200,
  complexity_exceeded: 200,
  daily_limit_exceeded: 200,
  concurrency_exceeded: 200,
  ip_rate_limited: 200,
  resource_locked: 423,
  validation_failed: 200,
  stale_cursor: 200,
  config_error: null,
  cache_error: null,
  network_error: null,
  timeout: null,
  dev_not_configured: null,
  dev_board_misconfigured: null,
  internal_error: null,
});

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
 * Compile-time guard: forces a `never` to be reachable, so any path
 * that hits it in practice is a bug. Used as the trailing branch of
 * exhaustive switches over discriminated unions — adding a new case
 * to the union without updating the switch fails type-checking
 * locally rather than only at the call site.
 */
/* c8 ignore start — defensive guard; type system makes the `never`
   parameter unreachable. Exists so adding a new variant to a
   discriminated union without updating the consuming switch fails
   type-checking, not silently. */
const assertNever = (value: never, context: string): never => {
  throw new InternalError(
    `unreachable: ${context} reached with ${JSON.stringify(value)}`,
  );
};
/* c8 ignore stop */

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
    case 'ambiguous_match':
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
    /* c8 ignore next 2 — assertNever is an exhaustiveness guard. */
    default:
      return assertNever(code, 'exitCodeForError');
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
    /* c8 ignore next 2 — assertNever is an exhaustiveness guard. */
    default:
      return assertNever(reason, 'errorForAbortReason');
  }
};
