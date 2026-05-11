import { describe, expect, it } from 'vitest';
import {
  ApiError,
  CacheError,
  ConfigError,
  ConfirmationRequiredError,
  ERROR_CODES,
  InternalError,
  MondayCliError,
  UsageError,
  asError,
  errorCode,
  errorForAbortReason,
  errorMessage,
  exitCodeForError,
  type AbortReason,
  type ErrorCode,
} from '../../../src/utils/errors.js';

describe('ERROR_CODES', () => {
  it('contains exactly the 29 stable codes (26 v0.1 + 1 v0.2 M12 + 1 v0.3 M19 prerequisite + 1 v0.3 M21 pre-flight)', () => {
    expect(ERROR_CODES).toHaveLength(29);
  });

  it('includes column_archived (precondition resolved per §6.5)', () => {
    expect(ERROR_CODES).toContain('column_archived');
  });

  it('includes ambiguous_match (M12 — `item upsert` matched 2+ items)', () => {
    expect(ERROR_CODES).toContain('ambiguous_match');
  });

  it('includes tag_not_found (M19+ — registered pre-M19 as the writer-expansion close prerequisite)', () => {
    expect(ERROR_CODES).toContain('tag_not_found');
  });

  it('includes oauth_failed (M21 pre-flight — `monday auth login` umbrella per cli-design §7.3.3)', () => {
    expect(ERROR_CODES).toContain('oauth_failed');
  });

  it('has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });
});

describe('MondayCliError base class', () => {
  it('exposes every documented field', () => {
    const err = new MondayCliError('rate_limited', 'slow down', {
      httpStatus: 429,
      mondayCode: 'RateLimit',
      requestId: 'req-1',
      retryAfterSeconds: 30,
      details: { limit: 'per_minute' },
    });

    expect(err.code).toBe('rate_limited');
    expect(err.message).toBe('slow down');
    expect(err.httpStatus).toBe(429);
    expect(err.mondayCode).toBe('RateLimit');
    expect(err.requestId).toBe('req-1');
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.details).toEqual({ limit: 'per_minute' });
    expect(err.retryable).toBe(true); // default for rate_limited
  });

  it('defaults `retryable` from a per-code table', () => {
    expect(new MondayCliError('rate_limited', '').retryable).toBe(true);
    expect(new MondayCliError('not_found', '').retryable).toBe(false);
    expect(new MondayCliError('network_error', '').retryable).toBe(true);
    expect(new MondayCliError('usage_error', '').retryable).toBe(false);
  });

  it('lets callers override the retryable default', () => {
    expect(
      new MondayCliError('rate_limited', '', { retryable: false }).retryable,
    ).toBe(false);
    expect(
      new MondayCliError('not_found', '', { retryable: true }).retryable,
    ).toBe(true);
  });

  it('threads `cause` through native Error semantics', () => {
    const inner = new Error('underlying');
    const err = new MondayCliError('internal_error', 'wrap', { cause: inner });
    expect(err.cause).toBe(inner);
  });

  it('omits cause when not provided', () => {
    const err = new MondayCliError('internal_error', 'no cause');
    expect(err.cause).toBeUndefined();
  });

  it('sets `name` to the subclass constructor name', () => {
    expect(new UsageError('x').name).toBe('UsageError');
    expect(new ConfigError('x').name).toBe('ConfigError');
    expect(new CacheError('x').name).toBe('CacheError');
    expect(new ApiError('not_found', 'x').name).toBe('ApiError');
    expect(new InternalError('x').name).toBe('InternalError');
    expect(new ConfirmationRequiredError('x').name).toBe(
      'ConfirmationRequiredError',
    );
  });

  it('is `instanceof MondayCliError` and `Error`', () => {
    const err = new UsageError('x');
    expect(err).toBeInstanceOf(MondayCliError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe('subclass code wiring', () => {
  it('UsageError pins code to usage_error', () => {
    expect(new UsageError('bad flag').code).toBe('usage_error');
  });

  it('ConfirmationRequiredError pins code to confirmation_required', () => {
    expect(new ConfirmationRequiredError('add --yes').code).toBe(
      'confirmation_required',
    );
  });

  it('ConfigError pins code to config_error', () => {
    expect(new ConfigError('missing token').code).toBe('config_error');
  });

  it('CacheError pins code to cache_error', () => {
    expect(new CacheError('EACCES').code).toBe('cache_error');
  });

  it('InternalError pins code to internal_error', () => {
    expect(new InternalError('bug').code).toBe('internal_error');
  });

  it('ApiError takes any code', () => {
    expect(new ApiError('rate_limited', 'slow').code).toBe('rate_limited');
    expect(new ApiError('forbidden', 'no').code).toBe('forbidden');
  });
});

describe('exitCodeForError', () => {
  it('maps usage-class codes to exit 1', () => {
    expect(exitCodeForError('usage_error')).toBe(1);
    expect(exitCodeForError('confirmation_required')).toBe(1);
    // M21 pre-flight: oauth_failed maps to exit 1 (treating it as
    // usage-shaped per the M20 Decision 4.1/4.2 reasoning — agents
    // already branch on the verb invoked, plus details.reason
    // carries the discriminant).
    expect(exitCodeForError('oauth_failed')).toBe(1);
  });

  it('maps config_error to exit 3', () => {
    expect(exitCodeForError('config_error')).toBe(3);
  });

  it('maps every other code to exit 2', () => {
    const usageOrConfig = new Set<ErrorCode>([
      'usage_error',
      'confirmation_required',
      'oauth_failed',
      'config_error',
    ]);
    for (const code of ERROR_CODES) {
      if (!usageOrConfig.has(code)) {
        expect(exitCodeForError(code)).toBe(2);
      }
    }
  });

  it('covers every ErrorCode (exhaustiveness)', () => {
    for (const code of ERROR_CODES) {
      expect([1, 2, 3]).toContain(exitCodeForError(code));
    }
  });
});

describe('errorForAbortReason', () => {
  it('produces an ApiError(timeout) for a timeout reason', () => {
    const reason: AbortReason = { kind: 'timeout', afterMs: 30_000 };
    const err = errorForAbortReason(reason);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('timeout');
    expect(err.message).toMatch(/30000ms/u);
    expect(err.details).toEqual({ timeout_ms: 30_000 });
  });

  it('produces an internal_error for a sigint reason', () => {
    const err = errorForAbortReason({ kind: 'sigint' });
    expect(err.code).toBe('internal_error');
    expect(err.details).toEqual({ abort_reason: 'sigint' });
  });

  it('produces an internal_error for an explicit cancel', () => {
    const err = errorForAbortReason({ kind: 'cancel', reason: 'user quit' });
    expect(err.code).toBe('internal_error');
    expect(err.message).toBe('user quit');
    expect(err.details).toEqual({ abort_reason: 'cancel' });
  });

  it('falls back to a default message when cancel reason is omitted', () => {
    const err = errorForAbortReason({ kind: 'cancel' });
    expect(err.message).toBe('cancelled');
  });
});

describe('errorMessage (R-NEW-14)', () => {
  it('extracts message from an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('coerces a non-Error to String(err)', () => {
    expect(errorMessage('a string error')).toBe('a string error');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(null)).toBe('null');
  });

  it('preserves subclass instances (TypeError etc.)', () => {
    expect(errorMessage(new TypeError('bad type'))).toBe('bad type');
  });
});

describe('asError (R-NEW-15)', () => {
  it('returns the same Error instance when input is an Error', () => {
    const original = new Error('original');
    expect(asError(original)).toBe(original);
  });

  it('wraps a non-Error value in a new Error with String(err) as message', () => {
    const wrapped = asError('not an error');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('not an error');
  });

  it('wraps undefined as Error("undefined")', () => {
    const wrapped = asError(undefined);
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('undefined');
  });

  it('preserves subclass instances (TypeError etc.)', () => {
    const t = new TypeError('subclass');
    expect(asError(t)).toBe(t);
  });
});

describe('errorCode (R-NEW-16)', () => {
  it('returns the string code from a Node fs-style error', () => {
    const err: NodeJS.ErrnoException = new Error('boom');
    err.code = 'ENOENT';
    expect(errorCode(err)).toBe('ENOENT');
  });

  it('returns undefined for non-object errors', () => {
    expect(errorCode('a string')).toBeUndefined();
    expect(errorCode(42)).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(errorCode(null)).toBeUndefined();
  });

  it('returns undefined when the object lacks a code field', () => {
    expect(errorCode(new Error('plain'))).toBeUndefined();
    expect(errorCode({ message: 'no code here' })).toBeUndefined();
  });

  it('returns undefined when code is non-string (numeric or boolean)', () => {
    expect(errorCode({ code: 42 })).toBeUndefined();
    expect(errorCode({ code: true })).toBeUndefined();
    expect(errorCode({ code: null })).toBeUndefined();
  });

  it('returns the code from any object with a string code property', () => {
    expect(errorCode({ code: 'EACCES' })).toBe('EACCES');
    expect(errorCode({ code: 'CUSTOM_CODE' })).toBe('CUSTOM_CODE');
  });
});
