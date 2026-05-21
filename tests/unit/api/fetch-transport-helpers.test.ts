import { describe, expect, it } from 'vitest';
import {
  combineSignals,
  describeFetchError,
  headersToRecord,
  isAbortError,
} from '../../../src/api/fetch-transport-helpers.js';

/**
 * Direct unit coverage for the shared fetch-transport helpers
 * (R-v0.8-NEW-11 lift). Before the lift, `transport.ts` +
 * `multipart-transport.ts` carried duplicate private copies, and the
 * SAME defensive arms were uncovered in BOTH — the `describeFetchError`
 * TLS `UNABLE_TO_*` arm and `combineSignals`'s empty-input guard
 * (R-v0.8-NEW-10, CI red). Driving the helpers directly here exercises
 * every arm once instead of relying on two transports to route each
 * copy through `fetch`. The transport-level tests
 * (`transport.test.ts` / `multipart-transport.test.ts`) still assert
 * the integration wiring.
 */

// errorCode() reads a string `code` property off the thrown value.
const withCode = (message: string, code: string): Error => {
  const e = new Error(message);
  Object.assign(e, { code });
  return e;
};

describe('isAbortError', () => {
  it('is true for an AbortError', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isAbortError(e)).toBe(true);
  });

  it('is true for a TimeoutError', () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    expect(isAbortError(e)).toBe(true);
  });

  it('is false for an Error with another name', () => {
    expect(isAbortError(new TypeError('boom'))).toBe(false);
  });

  it('is false for a non-Error throw', () => {
    expect(isAbortError('aborted')).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
  });
});

describe('describeFetchError — err.code mapping', () => {
  it('maps ENOTFOUND to a DNS message', () => {
    expect(describeFetchError(withCode('lookup failed', 'ENOTFOUND'))).toBe(
      'fetch failed: dns lookup failed',
    );
  });

  it('maps an EAI_-prefixed code to a DNS message', () => {
    expect(describeFetchError(withCode('again', 'EAI_AGAIN'))).toBe(
      'fetch failed: dns lookup failed',
    );
  });

  it('maps ECONNREFUSED to a connection-refused message', () => {
    expect(describeFetchError(withCode('refused', 'ECONNREFUSED'))).toBe(
      'fetch failed: connection refused',
    );
  });

  it('maps ECONNRESET to a connection-refused message', () => {
    expect(describeFetchError(withCode('reset', 'ECONNRESET'))).toBe(
      'fetch failed: connection refused',
    );
  });

  it('maps CERT_HAS_EXPIRED to a TLS message', () => {
    expect(describeFetchError(withCode('expired', 'CERT_HAS_EXPIRED'))).toBe(
      'fetch failed: tls error',
    );
  });

  // The previously-uncovered arm in BOTH copies (transport.ts:206 /
  // multipart-transport.ts:409): the `code.startsWith('UNABLE_TO_')`
  // operand of the TLS `||`. Self-signed-cert chains surface as
  // `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.
  it('maps an UNABLE_TO_-prefixed code to a TLS message', () => {
    expect(
      describeFetchError(
        withCode('self signed', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
      ),
    ).toBe('fetch failed: tls error');
  });

  it('falls through to "fetch failed" for an unrecognised code + generic message', () => {
    expect(describeFetchError(withCode('weird', 'ESOMETHINGELSE'))).toBe(
      'fetch failed',
    );
  });
});

describe('describeFetchError — message sniffing (no err.code)', () => {
  it('sniffs an econnrefused substring', () => {
    expect(
      describeFetchError(new TypeError('fetch failed: ECONNREFUSED 127.0.0.1')),
    ).toBe('fetch failed: connection refused');
  });

  it('sniffs a "connection refused" substring', () => {
    expect(describeFetchError(new Error('the connection refused us'))).toBe(
      'fetch failed: connection refused',
    );
  });

  it('sniffs a getaddrinfo substring', () => {
    expect(
      describeFetchError(new TypeError('getaddrinfo ENOTFOUND api.example')),
    ).toBe('fetch failed: dns lookup failed');
  });

  it('sniffs an eai_again substring', () => {
    expect(describeFetchError(new Error('EAI_AGAIN api.example'))).toBe(
      'fetch failed: dns lookup failed',
    );
  });

  it('returns a generic message when nothing matches', () => {
    expect(describeFetchError(new Error('socket hang up'))).toBe('fetch failed');
  });

  it('returns a generic message for a non-Error throw', () => {
    expect(describeFetchError({ not: 'an error' })).toBe('fetch failed');
    expect(describeFetchError(42)).toBe('fetch failed');
  });

  it('does not leak a URL/token embedded in the message', () => {
    const leaky = withCode(
      'connect ECONNREFUSED https://api.example/v2?token=tok-leakcheck-xxxx',
      'ECONNREFUSED',
    );
    const out = describeFetchError(leaky);
    expect(out).toBe('fetch failed: connection refused');
    expect(out).not.toContain('tok-leakcheck-xxxx');
  });
});

describe('headersToRecord', () => {
  it('flattens a Headers instance into a plain record', () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-1',
    });
    const record = headersToRecord(headers);
    // Header names are lower-cased by the Headers API.
    expect(record['content-type']).toBe('application/json');
    expect(record['x-request-id']).toBe('req-1');
  });

  it('returns an empty record for empty headers', () => {
    expect(headersToRecord(new Headers())).toEqual({});
  });
});

describe('combineSignals', () => {
  it('returns a fresh, non-aborted signal when given no signals', () => {
    const combined = combineSignals();
    expect(combined).toBeInstanceOf(AbortSignal);
    expect(combined.aborted).toBe(false);
  });

  it('treats all-undefined inputs as "no signals"', () => {
    const combined = combineSignals(undefined, undefined);
    expect(combined.aborted).toBe(false);
  });

  it('returns the lone signal unchanged when exactly one is supplied', () => {
    const ctrl = new AbortController();
    // undefined entries are filtered out, leaving a single real signal.
    expect(combineSignals(undefined, ctrl.signal)).toBe(ctrl.signal);
  });

  it('combines multiple signals so aborting any one aborts the result', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal);
    expect(combined).not.toBe(a.signal);
    expect(combined.aborted).toBe(false);
    b.abort(new Error('cancel'));
    expect(combined.aborted).toBe(true);
  });

  it('reflects an already-aborted input across the combination', () => {
    const a = new AbortController();
    a.abort(new Error('pre-aborted'));
    const b = new AbortController();
    const combined = combineSignals(a.signal, b.signal);
    expect(combined.aborted).toBe(true);
  });
});
