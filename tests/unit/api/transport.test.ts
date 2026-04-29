import { describe, expect, it } from 'vitest';
import { createFetchTransport } from '../../../src/api/transport.js';
import { ApiError } from '../../../src/utils/errors.js';

const okResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Echo': 'yes' },
  });

interface CapturedCall {
  readonly url: string;
  readonly init: RequestInit;
}

const captureFetch = (
  responder: (call: CapturedCall) => Promise<Response> | Response,
): { fetch: typeof fetch; calls: CapturedCall[] } => {
  const calls: CapturedCall[] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: CapturedCall = { url, init: init ?? {} };
    calls.push(call);
    return Promise.resolve(responder(call));
  };
  return { fetch: fakeFetch, calls };
};

describe('createFetchTransport — request shape', () => {
  it('POSTs to the configured endpoint with the GraphQL JSON body', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: { ok: true } }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok-1234',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    await transport.request({
      query: 'query Q { me { id } }',
      variables: { x: 1 },
      operationName: 'Q',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.example/v2');
    expect(calls[0]!.init.method).toBe('POST');
    const sent = JSON.parse(calls[0]!.init.body as string) as Record<
      string,
      unknown
    >;
    expect(sent).toEqual({
      query: 'query Q { me { id } }',
      variables: { x: 1 },
      operationName: 'Q',
    });
  });

  it('injects Authorization (no Bearer prefix) and API-Version', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: null }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok-1234',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    await transport.request({ query: '{ me { id } }' });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('tok-1234');
    expect(headers['API-Version']).toBe('2026-01');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('lets caller-supplied headers add to the set without overriding auth', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: null }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok-1234',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    await transport.request({
      query: '{ me { id } }',
      headers: { 'X-Trace-Id': 'abc' },
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-Trace-Id']).toBe('abc');
    expect(headers.Authorization).toBe('tok-1234');
  });

  it('omits variables from the body when none supplied', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: null }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok-1234',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    await transport.request({ query: '{ me { id } }' });

    const sent = JSON.parse(calls[0]!.init.body as string) as Record<
      string,
      unknown
    >;
    expect('variables' in sent).toBe(false);
    expect('operationName' in sent).toBe(false);
  });
});

describe('createFetchTransport — response handling', () => {
  it('returns a parsed JSON body and selected response headers', async () => {
    const { fetch: fakeFetch } = captureFetch(() =>
      okResponse({ data: { x: 1 } }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    const out = await transport.request({ query: '{ me { id } }' });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ data: { x: 1 } });
    expect(out.headers['x-echo']).toBe('yes');
  });

  it('surfaces an ApiError(network_error) on non-JSON responses', async () => {
    const { fetch: fakeFetch } = captureFetch(
      () =>
        new Response('<html>oops</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    await expect(
      transport.request({ query: '{ me { id } }' }),
    ).rejects.toMatchObject({
      code: 'network_error',
      httpStatus: 502,
    });
  });
});

describe('createFetchTransport — failure shapes', () => {
  it('wraps a thrown fetch in ApiError(network_error)', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new TypeError('fetch failed'));
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok',
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    try {
      await transport.request({ query: '{ me { id } }' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('network_error');
      expect((err as ApiError).message).toBe('fetch failed');
    }
  });

  it('does not interpolate the token into the error message or cause-chain', async () => {
    const literalToken = 'tok-leakcheck-xxxx';
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new TypeError('boom'));
    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: literalToken,
      apiVersion: '2026-01',
      timeoutMs: 5_000,
      fetchImpl: fakeFetch,
    });

    try {
      await transport.request({ query: '{ me { id } }' });
    } catch (err) {
      const apiErr = err as ApiError;
      expect(apiErr.message).not.toContain(literalToken);
      expect(JSON.stringify(apiErr.details ?? {})).not.toContain(literalToken);
    }
  });

  it('surfaces a timeout as ApiError(timeout) when the deadline trips', async () => {
    const fakeFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok',
      apiVersion: '2026-01',
      timeoutMs: 50,
      fetchImpl: fakeFetch,
    });

    try {
      await transport.request({ query: '{ me { id } }' });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('timeout');
      expect((err as ApiError).details).toEqual({ timeout_ms: 50 });
    }
  });

  it('honours an externally-aborted signal (caller cancels first)', async () => {
    const ctrl = new AbortController();
    const fakeFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const transport = createFetchTransport({
      endpoint: 'https://api.example/v2',
      apiToken: 'tok',
      apiVersion: '2026-01',
      timeoutMs: 60_000,
      fetchImpl: fakeFetch,
    });

    setTimeout(() => {
      ctrl.abort(new Error('user-cancel'));
    }, 10);

    try {
      await transport.request({ query: '{ me { id } }', signal: ctrl.signal });
      expect.fail('should have thrown');
    } catch (err) {
      // The transport doesn't relabel external aborts as timeout —
      // surfacing as network_error keeps the abort-reason carrier
      // (`signal.reason`) the source of truth for the runner.
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('network_error');
    }
  });
});
