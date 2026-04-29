/**
 * Monday API → CLI error code mapper (`v0.1-plan.md` §3 M2,
 * `cli-design.md` §2.5 / §6.5).
 *
 * The transport layer (`src/api/transport.ts`) already maps the
 * lowest-level failures it sees: `fetch` exceptions → `network_error`,
 * `AbortSignal.timeout` → `timeout`, malformed JSON →
 * `network_error`. Everything else — HTTP status codes, GraphQL
 * `errors[]` payloads, Monday's own application-level codes that
 * arrive on `200 OK` — is interpreted *here* against the response
 * body the transport hands back.
 *
 * Two consumers:
 *
 *  - `api/client.ts` calls `mapResponse(transportResponse)` on every
 *    request. A non-error response returns `{ ok: true, data }`; an
 *    error becomes `ApiError(<code>, ..., { httpStatus, mondayCode,
 *    retryAfterSeconds, details })` for the retry layer to inspect.
 *  - The retry layer (`api/retry.ts`) reads `error.retryable` and
 *    `error.retryAfterSeconds` to decide.
 *
 * **No English-message keying.** Monday's error code dictionary is
 * unstable across API versions; we extract the structured signals
 * (`extensions.code`, `extensions.error_code`, HTTP status,
 * `retry_in_seconds` / `Retry-After` headers) and ignore the prose.
 */

import { ApiError, type MondayCliError } from '../utils/errors.js';

/**
 * Subset of Monday's GraphQL error shape that we read. Everything
 * past `extensions` is `unknown` because Monday adds fields
 * version-by-version and we mustn't pretend to type them.
 */
export interface GraphQlError {
  readonly message: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly path?: readonly (string | number)[];
}

export interface GraphQlResponseBody {
  readonly data?: unknown;
  readonly errors?: readonly GraphQlError[];
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly error_code?: string;
  readonly error_message?: string;
  readonly status_code?: number;
}

export interface MapInput {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface MapSuccess<T = unknown> {
  readonly ok: true;
  readonly data: T;
  readonly extensions: Readonly<Record<string, unknown>> | undefined;
}

export interface MapFailure {
  readonly ok: false;
  readonly error: ApiError;
}

export type MapResult<T = unknown> = MapSuccess<T> | MapFailure;

/**
 * Reads the `Retry-After` header per RFC 7231 — either delta-seconds
 * (an integer) or an HTTP-date. We accept the integer form only;
 * date-form retries are rare in practice and computing the delta
 * client-side hides clock-skew bugs.
 */
const parseRetryAfterHeader = (
  headers: Readonly<Record<string, string>>,
): number | undefined => {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }
  const raw = lower['retry-after'];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) {
    return n;
  }
  return undefined;
};

const extractRetryInSeconds = (
  err: GraphQlError | undefined,
): number | undefined => {
  if (err === undefined) {
    return undefined;
  }
  const ext = err.extensions ?? {};
  // Monday spells this several ways across versions.
  const candidates: readonly string[] = [
    'retry_in_seconds',
    'retryInSeconds',
    'reset_in_seconds',
    'resetInSeconds',
  ];
  for (const key of candidates) {
    const v = ext[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
      return v;
    }
  }
  return undefined;
};

/**
 * Reads the `extensions.code` (preferred) or `extensions.error_code`
 * field as a string, lower-casing for case-insensitive comparison.
 * Returns undefined when the GraphQL error doesn't carry one.
 */
const extractMondayCode = (err: GraphQlError | undefined): string | undefined => {
  if (err === undefined) {
    return undefined;
  }
  const ext = err.extensions ?? {};
  for (const key of ['code', 'error_code', 'errorCode'] as const) {
    const v = ext[key];
    if (typeof v === 'string' && v.length > 0) {
      return v;
    }
  }
  return undefined;
};

/**
 * Heuristic match of a single GraphQL error against Monday's
 * documented application-level codes. The mapping intentionally
 * looks at:
 *   - `extensions.code` (Monday's structured channel)
 *   - the bare error message (substring, case-insensitive) as a
 *     fallback for older API versions or proxies that strip
 *     extensions
 *
 * Returns `undefined` when no specific code matches; the caller
 * decides whether to fall back to `validation_failed` /
 * `internal_error`.
 */
const matchKnownGraphqlCode = (
  err: GraphQlError,
): MondayCliError['code'] | undefined => {
  const code = extractMondayCode(err)?.toUpperCase() ?? '';
  const message = err.message.toLowerCase();

  if (
    code === 'COMPLEXITYEXCEPTION' ||
    message.includes('complexity budget exhausted') ||
    message.includes('query has complexity')
  ) {
    return 'complexity_exceeded';
  }
  if (
    code === 'RATE_LIMIT_EXCEEDED' ||
    code === 'MINUTE_LIMIT_EXCEEDED' ||
    message.includes('minute limit rate exceeded')
  ) {
    return 'rate_limited';
  }
  if (
    code === 'DAILY_LIMIT_EXCEEDED' ||
    message.includes('daily limit')
  ) {
    return 'daily_limit_exceeded';
  }
  if (
    code === 'CONCURRENCY_LIMIT_EXCEEDED' ||
    code === 'CONCURRENCYLIMITEXCEEDED' ||
    message.includes('concurrency limit')
  ) {
    return 'concurrency_exceeded';
  }
  if (
    code === 'IP_RATE_LIMIT_EXCEEDED' ||
    message.includes('ip rate limit')
  ) {
    return 'ip_rate_limited';
  }
  if (
    code === 'UNAUTHORIZED' ||
    code === 'AUTHENTICATION_ERROR' ||
    message.includes('not authenticated') ||
    message.includes('invalid token') ||
    message.includes('invalid api token')
  ) {
    return 'unauthorized';
  }
  if (
    code === 'FORBIDDEN' ||
    code === 'PERMISSION_DENIED' ||
    code === 'NOT_AUTHORIZED' ||
    message.includes('permission denied') ||
    message.includes('not allowed')
  ) {
    return 'forbidden';
  }
  if (
    code === 'RESOURCE_NOT_FOUND' ||
    code === 'NOT_FOUND' ||
    code === 'INVALIDBOARDIDEXCEPTION' ||
    code === 'INVALIDITEMIDEXCEPTION'
  ) {
    return 'not_found';
  }
  if (
    code === 'RESOURCE_LOCKED' ||
    code === 'INUSE'
  ) {
    return 'resource_locked';
  }
  if (
    code === 'INVALID_CURSOR_EXCEPTION' ||
    code === 'CURSOREXPIREDEXCEPTION' ||
    message.includes('cursor expired') ||
    message.includes('invalid cursor')
  ) {
    return 'stale_cursor';
  }
  if (
    code === 'COLUMNVALUEEXCEPTION' ||
    code === 'INVALIDARGUMENTEXCEPTION' ||
    code === 'INVALIDCOLUMNIDEXCEPTION' ||
    code === 'VALIDATION_ERROR' ||
    code === 'BAD_USER_INPUT'
  ) {
    return 'validation_failed';
  }
  return undefined;
};

/**
 * Default human-readable message per CLI code, used when the upstream
 * error body has nothing prose-worthy to say. Frozen so a stray
 * mutation can't reshape the surface mid-process.
 */
const DEFAULT_MESSAGE_FOR_CODE: Readonly<
  Partial<Record<MondayCliError['code'], string>>
> = Object.freeze({
  unauthorized: 'Monday rejected the API token (unauthorized)',
  forbidden: 'Monday refused the request (forbidden)',
  rate_limited: 'Monday rate-limit hit — wait before retrying',
  complexity_exceeded: 'Monday complexity budget exceeded — wait before retrying',
  daily_limit_exceeded: 'Monday daily call limit exceeded',
  concurrency_exceeded:
    'Monday concurrency limit exceeded — too many in-flight requests',
  ip_rate_limited: 'Monday IP rate-limit hit — wait before retrying',
  resource_locked: 'Monday reported the resource is locked (HTTP 423)',
  validation_failed: 'Monday rejected the request payload as invalid',
  not_found: 'Monday could not find the requested resource',
  stale_cursor: 'Pagination cursor expired (60-minute lifetime)',
});

const messageForCode = (
  code: MondayCliError['code'],
  err: GraphQlError | undefined,
): string => {
  if (err !== undefined) {
    return err.message;
  }
  return DEFAULT_MESSAGE_FOR_CODE[code] ?? 'Monday API error';
};

/**
 * Maps an HTTP status (with no usable GraphQL `errors`) to a CLI
 * error code. Used when Monday returns a non-200 with no structured
 * payload — usually proxies or load balancers between us and the
 * GraphQL server.
 */
const mapHttpStatus = (status: number): MondayCliError['code'] | undefined => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 423) return 'resource_locked';
  if (status === 429) return 'rate_limited';
  if (status >= 500 && status < 600) return 'network_error';
  if (status >= 400 && status < 500) return 'validation_failed';
  return undefined;
};

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const asGraphQlBody = (body: unknown): GraphQlResponseBody | undefined => {
  if (!isObject(body)) {
    return undefined;
  }
  // Structural read: the consumer reads `data` / `errors` / `extensions`
  // / top-level `error_*` slots; nothing here is asserted past
  // `unknown` until the per-field guards downstream.
  return body;
};

const collectGraphqlErrors = (
  body: GraphQlResponseBody | undefined,
): readonly GraphQlError[] => {
  if (body === undefined) return [];
  if (!Array.isArray(body.errors)) return [];
  const out: GraphQlError[] = [];
  for (const item of body.errors) {
    if (!isObject(item)) continue;
    const message = typeof item.message === 'string' ? item.message : '';
    const extensions = isObject(item.extensions) ? item.extensions : undefined;
    const path = Array.isArray(item.path)
      ? item.path.filter(
          (p): p is string | number =>
            typeof p === 'string' || typeof p === 'number',
        )
      : undefined;
    out.push({
      message,
      ...(extensions === undefined ? {} : { extensions }),
      ...(path === undefined ? {} : { path }),
    });
  }
  return out;
};

const detailsForGraphqlError = (
  err: GraphQlError,
): Readonly<Record<string, unknown>> => {
  const details: Record<string, unknown> = {};
  if (err.extensions !== undefined) {
    details.extensions = err.extensions;
  }
  if (err.path !== undefined && err.path.length > 0) {
    details.path = err.path;
  }
  return details;
};

/**
 * Maps a transport response to either a parsed `data` payload or an
 * `ApiError`. The caller (`api/client.ts`) typically destructures:
 *
 *   const result = mapResponse<MyShape>(resp);
 *   if (!result.ok) throw result.error;
 *   return result.data;
 *
 * Throwing here would force every caller to have its own try/catch;
 * returning a tagged result keeps the retry layer's loop linear.
 */
export const mapResponse = <T = unknown>(input: MapInput): MapResult<T> => {
  const body = asGraphQlBody(input.body);
  const errors = collectGraphqlErrors(body);
  const httpRetryAfter = parseRetryAfterHeader(input.headers);

  // 1. HTTP 423 always maps to resource_locked (Monday's documented
  //    contract — `cli-design.md` §2.5). This wins over any GraphQL
  //    error array because 423 is a load-balancer / coordination
  //    signal, not an application-level failure.
  if (input.status === 423) {
    const firstErr = errors[0];
    const lockOpts: {
      httpStatus: number;
      mondayCode?: string;
      retryAfterSeconds?: number;
      details: Record<string, unknown>;
    } = {
      httpStatus: input.status,
      details: {
        ...(firstErr === undefined ? {} : detailsForGraphqlError(firstErr)),
        ...(httpRetryAfter === undefined ? {} : { retry_after_seconds: httpRetryAfter }),
      },
    };
    const lockMondayCode = firstErr === undefined ? undefined : extractMondayCode(firstErr);
    if (lockMondayCode !== undefined) {
      lockOpts.mondayCode = lockMondayCode;
    }
    if (httpRetryAfter !== undefined) {
      lockOpts.retryAfterSeconds = httpRetryAfter;
    }
    return {
      ok: false,
      error: new ApiError(
        'resource_locked',
        firstErr?.message ?? 'Monday reported the resource is locked (HTTP 423)',
        lockOpts,
      ),
    };
  }

  // 2. GraphQL `errors[]` — present on most Monday application
  //    failures, including ones that arrive on HTTP 200.
  const [first] = errors;
  if (first !== undefined) {
    const matched = matchKnownGraphqlCode(first);
    let code: MondayCliError['code'];
    if (matched !== undefined) {
      code = matched;
    } else {
      // Last-resort fallback. Most unmapped Monday errors are
      // user-input validation failures (bad column id, missing
      // argument). Validation surfaces as exit 2 / non-retryable,
      // matching the §6.5 contract.
      code = 'validation_failed';
    }
    const retryInSeconds = extractRetryInSeconds(first) ?? httpRetryAfter;
    const mondayCode = extractMondayCode(first);
    const details: Record<string, unknown> = {
      ...detailsForGraphqlError(first),
    };
    if (errors.length > 1) {
      details.additional_errors = errors.slice(1).map((e) => ({
        message: e.message,
        ...(e.extensions === undefined ? {} : { extensions: e.extensions }),
        ...(e.path === undefined || e.path.length === 0 ? {} : { path: e.path }),
      }));
    }
    if (retryInSeconds !== undefined) {
      details.retry_after_seconds = retryInSeconds;
    }
    return {
      ok: false,
      error: new ApiError(code, messageForCode(code, first), {
        httpStatus: input.status,
        ...(mondayCode === undefined ? {} : { mondayCode }),
        ...(retryInSeconds === undefined ? {} : { retryAfterSeconds: retryInSeconds }),
        details,
      }),
    };
  }

  // 3. Non-success HTTP without GraphQL errors. Treat the body as
  //    opaque (it might be an HTML error page from a proxy).
  if (input.status < 200 || input.status >= 300) {
    const fallback = mapHttpStatus(input.status) ?? 'network_error';
    const details: Record<string, unknown> = {};
    // Monday occasionally returns top-level `error_code` /
    // `error_message` for non-200s.
    if (body?.error_code !== undefined) {
      details.error_code = body.error_code;
    }
    if (body?.error_message !== undefined) {
      details.error_message = body.error_message;
    }
    if (httpRetryAfter !== undefined) {
      details.retry_after_seconds = httpRetryAfter;
    }
    const errOpts: {
      httpStatus: number;
      retryAfterSeconds?: number;
      mondayCode?: string;
      details: Record<string, unknown>;
    } = {
      httpStatus: input.status,
      details,
    };
    if (httpRetryAfter !== undefined) {
      errOpts.retryAfterSeconds = httpRetryAfter;
    }
    if (typeof body?.error_code === 'string' && body.error_code.length > 0) {
      errOpts.mondayCode = body.error_code;
    }
    return {
      ok: false,
      error: new ApiError(
        fallback,
        body?.error_message !== undefined && body.error_message.length > 0
          ? body.error_message
          : `Monday API returned HTTP ${String(input.status)}`,
        errOpts,
      ),
    };
  }

  // 4. Success path. `body.data` may legitimately be `null` (Monday
  //    returns `null` for missing-by-id queries with no errors); we
  //    pass it through and the command-level zod parser is the next
  //    line of defence.
  const data = (body?.data ?? null) as T;
  return {
    ok: true,
    data,
    ...(body?.extensions === undefined ? { extensions: undefined } : { extensions: body.extensions }),
  };
};

/**
 * Re-maps an unknown error caught around a transport call to a typed
 * `MondayCliError`. The transport already throws `ApiError` for
 * network/timeout failures; anything else (a bug in the SDK, a
 * malformed cassette, a future SDK retry layer leaking a custom
 * error type) falls through to `internal_error` so the runner's
 * envelope still carries something agents can act on.
 */
export const wrapTransportError = (err: unknown): ApiError => {
  if (err instanceof ApiError) {
    return err;
  }
  const message = err instanceof Error ? err.message : String(err);
  const opts: { cause: unknown } = { cause: err };
  return new ApiError('internal_error', `unexpected transport error: ${message}`, opts);
};
