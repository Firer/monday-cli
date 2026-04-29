import { describe, it, expect } from 'vitest';
import { ApiError } from '../../../src/utils/errors.js';
import { mapResponse, wrapTransportError } from '../../../src/api/errors.js';

const okHeaders = (extra?: Record<string, string>): Record<string, string> => ({
  'content-type': 'application/json',
  ...(extra ?? {}),
});

describe('mapResponse', () => {
  it('passes data through on a clean 200', () => {
    const result = mapResponse<{ me: { id: string } }>({
      status: 200,
      headers: okHeaders(),
      body: { data: { me: { id: '1' } } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ me: { id: '1' } });
      expect(result.extensions).toBeUndefined();
    }
  });

  it('threads extensions through when Monday returns them', () => {
    const result = mapResponse<{ me: null }>({
      status: 200,
      headers: okHeaders(),
      body: { data: { me: null }, extensions: { complexity: { query: 1 } } },
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.extensions).toEqual({ complexity: { query: 1 } });
  });

  it('treats body.data === null on a clean 200 as a success path', () => {
    const result = mapResponse({ status: 200, headers: okHeaders(), body: { data: null } });
    if (!result.ok) throw new Error('expected ok');
    expect(result.data).toBeNull();
  });

  describe('GraphQL errors → CLI codes', () => {
    const cases = [
      {
        name: 'ComplexityException',
        ext: { code: 'ComplexityException', retry_in_seconds: 30 },
        message: 'Complexity budget exhausted, retry in 30 seconds',
        expected: { code: 'complexity_exceeded', retry: 30, retryable: true },
      },
      {
        name: 'rate limit',
        ext: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 12 },
        message: 'Minute limit rate exceeded',
        expected: { code: 'rate_limited', retry: 12, retryable: true },
      },
      {
        name: 'daily limit',
        ext: { code: 'DAILY_LIMIT_EXCEEDED' },
        message: 'Daily limit reached',
        expected: { code: 'daily_limit_exceeded', retry: undefined, retryable: false },
      },
      {
        name: 'concurrency',
        ext: { code: 'CONCURRENCY_LIMIT_EXCEEDED', retry_in_seconds: 1 },
        message: 'Concurrency limit exceeded',
        expected: { code: 'concurrency_exceeded', retry: 1, retryable: true },
      },
      {
        name: 'ip rate',
        ext: { code: 'IP_RATE_LIMIT_EXCEEDED' },
        message: 'IP rate limit exceeded',
        expected: { code: 'ip_rate_limited', retry: undefined, retryable: true },
      },
      {
        name: 'unauthorized via extensions code',
        ext: { code: 'AUTHENTICATION_ERROR' },
        message: 'You must be authenticated',
        expected: { code: 'unauthorized', retry: undefined, retryable: false },
      },
      {
        name: 'forbidden via message',
        ext: undefined,
        message: 'Permission denied',
        expected: { code: 'forbidden', retry: undefined, retryable: false },
      },
      {
        name: 'cursor expired',
        ext: { code: 'CursorExpiredException' },
        message: 'Cursor expired',
        expected: { code: 'stale_cursor', retry: undefined, retryable: false },
      },
      {
        name: 'validation (column value exception)',
        ext: { code: 'ColumnValueException' },
        message: 'Bad status label "Foo"',
        expected: { code: 'validation_failed', retry: undefined, retryable: false },
      },
      {
        name: 'unknown code → validation_failed fallback',
        ext: { code: 'UNHEARDOF' },
        message: 'something broke',
        expected: { code: 'validation_failed', retry: undefined, retryable: false },
      },
    ] as const;
    for (const c of cases) {
      it(`maps ${c.name} → ${c.expected.code}`, () => {
        const result = mapResponse({
          status: 200,
          headers: okHeaders(),
          body: {
            errors: [
              {
                message: c.message,
                ...(c.ext === undefined ? {} : { extensions: c.ext }),
              },
            ],
          },
        });
        if (result.ok) throw new Error('expected error');
        expect(result.error).toBeInstanceOf(ApiError);
        expect(result.error.code).toBe(c.expected.code);
        expect(result.error.retryable).toBe(c.expected.retryable);
        expect(result.error.retryAfterSeconds).toBe(c.expected.retry);
        expect(result.error.httpStatus).toBe(200);
      });
    }
  });

  it('extracts mondayCode + retry_after_seconds onto the error', () => {
    const result = mapResponse({
      status: 200,
      headers: okHeaders(),
      body: {
        errors: [
          {
            message: 'rate limited',
            extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 7 },
          },
        ],
      },
    });
    if (result.ok) throw new Error('expected error');
    expect(result.error.mondayCode).toBe('RATE_LIMIT_EXCEEDED');
    expect(result.error.retryAfterSeconds).toBe(7);
    expect(result.error.details).toMatchObject({
      extensions: { code: 'RATE_LIMIT_EXCEEDED', retry_in_seconds: 7 },
      retry_after_seconds: 7,
    });
  });

  it('records additional_errors when more than one is returned', () => {
    const result = mapResponse({
      status: 200,
      headers: okHeaders(),
      body: {
        errors: [
          { message: 'first', extensions: { code: 'ComplexityException' } },
          { message: 'second' },
        ],
      },
    });
    if (result.ok) throw new Error('expected error');
    expect(result.error.code).toBe('complexity_exceeded');
    const details = result.error.details!;
    expect(details).toHaveProperty('additional_errors');
    const additional = details.additional_errors as readonly { message: string }[];
    expect(additional).toHaveLength(1);
    expect(additional[0]?.message).toBe('second');
  });

  describe('HTTP status without GraphQL errors', () => {
    it('423 → resource_locked with Retry-After header', () => {
      const result = mapResponse({
        status: 423,
        headers: okHeaders({ 'retry-after': '5' }),
        body: { errors: [] },
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('resource_locked');
      expect(result.error.retryAfterSeconds).toBe(5);
      expect(result.error.httpStatus).toBe(423);
    });

    it('423 with a GraphQL error — still resource_locked', () => {
      const result = mapResponse({
        status: 423,
        headers: okHeaders({ 'Retry-After': '11' }),
        body: { errors: [{ message: 'item is locked', extensions: { code: 'INUSE' } }] },
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('resource_locked');
      expect(result.error.message).toBe('item is locked');
      expect(result.error.mondayCode).toBe('INUSE');
      expect(result.error.retryAfterSeconds).toBe(11);
    });

    it('401 → unauthorized', () => {
      const result = mapResponse({ status: 401, headers: okHeaders(), body: {} });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('unauthorized');
      expect(result.error.httpStatus).toBe(401);
    });

    it('403 → forbidden', () => {
      const result = mapResponse({ status: 403, headers: okHeaders(), body: {} });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('forbidden');
    });

    it('429 → rate_limited with Retry-After', () => {
      const result = mapResponse({
        status: 429,
        headers: okHeaders({ 'retry-after': '3' }),
        body: {},
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('rate_limited');
      expect(result.error.retryAfterSeconds).toBe(3);
    });

    it('500 → network_error', () => {
      const result = mapResponse({ status: 502, headers: okHeaders(), body: '' });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('network_error');
      expect(result.error.httpStatus).toBe(502);
    });

    it('429 with body.error_code IP_RATE_LIMIT_EXCEEDED → ip_rate_limited (not rate_limited)', () => {
      // Codex M2 review §3 — the body's top-level error_code is a
      // higher-priority signal than the bare HTTP status.
      const result = mapResponse({
        status: 429,
        headers: okHeaders({ 'retry-after': '9' }),
        body: {
          error_code: 'IP_RATE_LIMIT_EXCEEDED',
          error_message: 'ip cap',
        },
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('ip_rate_limited');
      expect(result.error.mondayCode).toBe('IP_RATE_LIMIT_EXCEEDED');
      expect(result.error.retryAfterSeconds).toBe(9);
    });

    it('429 without body.error_code → rate_limited fallback', () => {
      const result = mapResponse({
        status: 429,
        headers: okHeaders({ 'retry-after': '3' }),
        body: {},
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('rate_limited');
    });

    it('400 with body.error_message → validation_failed with mondayCode', () => {
      const result = mapResponse({
        status: 400,
        headers: okHeaders(),
        body: { error_code: 'BAD_REQUEST', error_message: 'malformed' },
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.code).toBe('validation_failed');
      expect(result.error.message).toBe('malformed');
      expect(result.error.mondayCode).toBe('BAD_REQUEST');
    });

    it('Retry-After of "abc" is dropped silently', () => {
      const result = mapResponse({
        status: 423,
        headers: okHeaders({ 'retry-after': 'tomorrow' }),
        body: {},
      });
      if (result.ok) throw new Error('expected error');
      expect(result.error.retryAfterSeconds).toBeUndefined();
    });
  });
});

describe('wrapTransportError', () => {
  it('returns ApiError unchanged', () => {
    const original = new ApiError('network_error', 'fetch failed');
    expect(wrapTransportError(original)).toBe(original);
  });

  it('wraps generic errors as internal_error', () => {
    const original = new Error('weird');
    const wrapped = wrapTransportError(original);
    expect(wrapped).toBeInstanceOf(ApiError);
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).toContain('weird');
    expect(wrapped.cause).toBe(original);
  });

  it('wraps non-Error throws by stringifying', () => {
    const wrapped = wrapTransportError('string-thrown');
    expect(wrapped.code).toBe('internal_error');
    expect(wrapped.message).toContain('string-thrown');
  });
});
