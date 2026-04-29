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
  errorForAbortReason,
  exitCodeForError,
  type AbortReason,
  type ErrorCode,
} from '../../../src/utils/errors.js';

describe('ERROR_CODES', () => {
  it('contains exactly the 26 v0.1 stable codes', () => {
    expect(ERROR_CODES).toHaveLength(26);
  });

  it('includes column_archived (precondition resolved per §6.5)', () => {
    expect(ERROR_CODES).toContain('column_archived');
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
  });

  it('maps config_error to exit 3', () => {
    expect(exitCodeForError('config_error')).toBe(3);
  });

  it('maps every other code to exit 2', () => {
    const usageOrConfig = new Set<ErrorCode>([
      'usage_error',
      'confirmation_required',
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
