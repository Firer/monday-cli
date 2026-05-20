/**
 * Unit tests for `src/api/multipart-transport.ts` — the v0.4-M31
 * IMPL runtime body of `createMultipartFetchTransport` driven via a
 * stubbed `fetchImpl`. Mock-at-the-platform-boundary per testing.md
 * — the stub returns a real `Response` so the transport's body
 * encoding (FormData wire shape) + header lockdown + signal
 * combination + JSON parse + error mapping all run in-process.
 *
 * Mirrors `tests/unit/api/transport.test.ts`'s shape for the JSON
 * transport — same `captureFetch` pattern, same `okResponse` builder.
 */

import { describe, expect, it } from 'vitest';
import { createMultipartFetchTransport } from '../../../src/api/multipart-transport.js';
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

const sampleConfig = (
  fetchImpl: typeof fetch,
  overrides: Partial<{
    endpoint: string;
    apiToken: string;
    apiVersion: string;
    timeoutMs: number;
  }> = {},
): Parameters<typeof createMultipartFetchTransport>[0] => ({
  endpoint: 'https://api.example/v2',
  apiToken: 'tok-1234',
  apiVersion: '2026-01',
  timeoutMs: 5_000,
  fetchImpl,
  ...overrides,
});

const sampleBlob = (bytes: Uint8Array = new Uint8Array([1, 2, 3])): Blob =>
  new Blob([bytes], { type: 'image/png' });

const baseRequest = (
  overrides: Partial<{
    query: string;
    variables: Readonly<Record<string, unknown>>;
    operationName: string;
    fileVariableName: string;
    file: Blob;
    filename: string;
    signal: AbortSignal;
  }> = {},
): Parameters<
  ReturnType<typeof createMultipartFetchTransport>['request']
>[0] => ({
  query: 'mutation AddFileToColumn($file: File!) { add_file_to_column(file: $file) { id } }',
  variables: { itemId: '1', columnId: 'files', file: null },
  operationName: 'AddFileToColumn',
  fileVariableName: 'file',
  file: sampleBlob(),
  filename: 'screenshot.png',
  signal: new AbortController().signal,
  ...overrides,
});

describe('createMultipartFetchTransport — wire shape', () => {
  it('POSTs to the derived /file endpoint with a FormData body', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: { add_file_to_column: { id: '99' } } }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(baseRequest());
    expect(calls).toHaveLength(1);
    // Monday's documented file endpoint = the GraphQL base + `/file`.
    expect(calls[0]!.url).toBe('https://api.example/v2/file');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body).toBeInstanceOf(FormData);
  });

  it('FormData carries Monday-native query + variables + string-map + named file part', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: { add_file_to_column: { id: '99' } } }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(
      baseRequest({
        variables: { itemId: '12345', columnId: 'files', file: null },
      }),
    );
    const fd = calls[0]!.init.body as FormData;

    // `query` is a top-level text part (NOT nested inside `operations`).
    const query = fd.get('query');
    expect(typeof query).toBe('string');
    expect(query as string).toMatch(/AddFileToColumn/);

    // `variables` is a sibling JSON part carrying the non-file vars.
    const variables = fd.get('variables');
    expect(typeof variables).toBe('string');
    expect(JSON.parse(variables as string)).toEqual({
      itemId: '12345',
      columnId: 'files',
      file: null,
    });

    // `map` value is a STRING `variables.file` (not a `['variables.file']`
    // array), keyed by the file part's name.
    const map = fd.get('map');
    expect(typeof map).toBe('string');
    expect(JSON.parse(map as string)).toEqual({ file: 'variables.file' });

    // file part named to match the map key (`file`), carrying the filename.
    const filePart = fd.get('file');
    expect(filePart).toBeInstanceOf(Blob);
    expect((filePart as File).name).toBe('screenshot.png');

    // Regression guard (R-v0.8-NEW-9): the Apollo/jaydenseric spec parts
    // (`operations` JSON, `map`-array, file part `'0'`) — which live
    // Monday rejects — must NOT appear. A revert to that shape fails here.
    expect(fd.get('operations')).toBeNull();
    expect(fd.get('0')).toBeNull();
    expect(fd.get('operationName')).toBeNull();
  });

  it('honors a custom fileVariableName in the map JSON + file part name', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: { x: { id: '1' } } }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(
      baseRequest({
        fileVariableName: 'attachment',
        variables: { attachment: null },
      }),
    );
    const fd = calls[0]!.init.body as FormData;
    expect(JSON.parse(fd.get('map') as string)).toEqual({
      attachment: 'variables.attachment',
    });
    // The binary part is named to match the map key.
    expect(fd.get('attachment')).toBeInstanceOf(Blob);
  });

  it('preserves the file bytes on the wire', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: { add_file_to_column: { id: '99' } } }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG header magic
    await transport.request(baseRequest({ file: sampleBlob(bytes) }));
    const fd = calls[0]!.init.body as FormData;
    const filePart = fd.get('file') as Blob;
    const received = new Uint8Array(await filePart.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(bytes));
  });
});

describe('createMultipartFetchTransport — header lockdown', () => {
  it('sets Authorization + API-Version on every request', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: {} }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(baseRequest());
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      Authorization: 'tok-1234',
      'API-Version': '2026-01',
    });
  });

  it('does NOT set Content-Type — fetch derives it from FormData boundary', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: {} }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(baseRequest());
    const headers = calls[0]!.init.headers as Record<string, string>;
    // Pre-empting Content-Type would corrupt the multipart envelope
    // (the boundary in the header has to match FormData's internal
    // one). cli-design §6.4 + R-NEW-41 architecture conventions pin
    // this asymmetry.
    expect(headers).not.toHaveProperty('Content-Type');
    expect(headers).not.toHaveProperty('content-type');
  });

  it('header bag has no slot for caller-supplied headers (lockdown closed-by-construction)', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: {} }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await transport.request(baseRequest());
    const headers = calls[0]!.init.headers as Record<string, string>;
    // Only the two transport-owned keys; nothing else can sneak in
    // because MultipartTransportRequest doesn't carry a `headers` slot.
    expect(Object.keys(headers).sort()).toEqual(['API-Version', 'Authorization']);
  });
});

describe('createMultipartFetchTransport — signal combination', () => {
  it('threads the caller signal into fetch via combined AbortSignal', async () => {
    const { fetch: fakeFetch, calls } = captureFetch(() =>
      okResponse({ data: {} }),
    );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    const ctrl = new AbortController();
    await transport.request(baseRequest({ signal: ctrl.signal }));
    const passed = calls[0]!.init.signal as AbortSignal | undefined;
    expect(passed).toBeInstanceOf(AbortSignal);
    expect(passed?.aborted).toBe(false);
  });

  it('caller abort wins → fetch sees aborted signal; thrown error is mapped to network_error', async () => {
    // Simulate fetch raising AbortError when the combined signal fires
    // (matches undici / browser fetch behaviour).
    const fakeFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        const onAbort = (): void => {
          const err = new Error(
            (sig?.reason as Error | undefined)?.message ?? 'aborted',
          );
          err.name = 'AbortError';
          reject(err);
        };
        if (sig?.aborted === true) {
          onAbort();
          return;
        }
        sig?.addEventListener('abort', onAbort, { once: true });
      });
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    const ctrl = new AbortController();
    const promise = transport.request(baseRequest({ signal: ctrl.signal }));
    ctrl.abort(new Error('caller cancel'));
    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({ code: 'network_error' });
  });

  it('timeout signal wins → throws ApiError(timeout)', async () => {
    // Fake fetch never resolves; the transport's
    // AbortSignal.timeout(timeoutMs) fires inside the combined
    // signal, fetch raises TimeoutError, the transport rewraps as
    // ApiError(timeout).
    const fakeFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        const onAbort = (): void => {
          const reason: unknown = sig?.reason;
          const err = new Error(
            reason instanceof Error ? reason.message : 'timeout',
          );
          err.name = 'TimeoutError';
          reject(err);
        };
        sig?.addEventListener('abort', onAbort, { once: true });
      });
    const transport = createMultipartFetchTransport(
      sampleConfig(fakeFetch, { timeoutMs: 30 }),
    );
    const ctrl = new AbortController(); // never aborted by caller
    await expect(
      transport.request(baseRequest({ signal: ctrl.signal })),
    ).rejects.toMatchObject({
      code: 'timeout',
      details: { timeout_ms: 30 },
    });
  });
});

describe('createMultipartFetchTransport — error mapping', () => {
  it('non-JSON response → ApiError(network_error) with httpStatus', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        new Response('<html>oops</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      httpStatus: 502,
    });
  });

  it('ECONNREFUSED-shaped fetch error → "fetch failed: connection refused"', async () => {
    const fakeFetch: typeof fetch = () => {
      const err = new Error('Something broke') as Error & { code: string };
      err.code = 'ECONNREFUSED';
      return Promise.reject(err);
    };
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('connection refused') as unknown,
    });
  });

  it('ENOTFOUND-shaped fetch error → "fetch failed: dns lookup failed"', async () => {
    const fakeFetch: typeof fetch = () => {
      const err = new Error('getaddrinfo ENOTFOUND api.example') as Error & {
        code: string;
      };
      err.code = 'ENOTFOUND';
      return Promise.reject(err);
    };
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('dns lookup failed') as unknown,
    });
  });

  it('CERT_HAS_EXPIRED-shaped fetch error → "fetch failed: tls error"', async () => {
    const fakeFetch: typeof fetch = () => {
      const err = new Error('cert expired') as Error & { code: string };
      err.code = 'CERT_HAS_EXPIRED';
      return Promise.reject(err);
    };
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('tls error') as unknown,
    });
  });

  it('message-fallback ECONNREFUSED (no err.code) maps via message sniff', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error('connection refused at upstream'));
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('connection refused') as unknown,
    });
  });

  it('message-fallback ENOTFOUND (no err.code) maps via message sniff', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error('getaddrinfo on api.example failed'));
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: expect.stringContaining('dns lookup failed') as unknown,
    });
  });

  it('generic Error → "fetch failed" (no specific shape)', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error('weird transport bug'));
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: 'fetch failed',
    });
  });

  it('non-Error throw → "fetch failed"', async () => {
    const fakeFetch: typeof fetch = () =>
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the test exercises the non-Error-throw fallback in describeFetchError; using a real Error would defeat the assertion.
      Promise.reject('weird');
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
      message: 'fetch failed',
    });
  });

  it('does not include the API token in the error message even on a misconfigured endpoint', async () => {
    // Defence in depth: security.md forbids the token entering
    // Error.message even though the redactor would scrub it. The
    // transport surfaces a URL-free fetch description.
    const fakeFetch: typeof fetch = () =>
      Promise.reject(new Error('ECONNREFUSED https://x?token=tok-1234'));
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    await expect(transport.request(baseRequest())).rejects.toMatchObject({
      code: 'network_error',
    });
    try {
      await transport.request(baseRequest());
    } catch (err) {
      expect((err as Error).message).not.toContain('tok-1234');
    }
  });
});

describe('createMultipartFetchTransport — response shape', () => {
  it('returns parsed JSON body + status + headers', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(okResponse({ data: { add_file_to_column: { id: '99' } } }));
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    const response = await transport.request(baseRequest());
    expect(response.status).toBe(200);
    expect(response.headers).toMatchObject({
      'content-type': 'application/json',
      'x-echo': 'yes',
    });
    expect(response.body).toEqual({
      data: { add_file_to_column: { id: '99' } },
    });
  });

  it('200 with GraphQL errors[] passes through to the caller (mapResponse handles it)', async () => {
    const fakeFetch: typeof fetch = () =>
      Promise.resolve(
        okResponse({
          errors: [{ message: 'boom', extensions: { code: 'VALIDATION_ERROR' } }],
        }),
      );
    const transport = createMultipartFetchTransport(sampleConfig(fakeFetch));
    const response = await transport.request(baseRequest());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      errors: [{ message: 'boom' }],
    });
  });
});

describe('createMultipartFetchTransport — production fetch fallback', () => {
  it('uses global fetch when fetchImpl is omitted', async () => {
    // Smoke test the default branch — point at a localhost URL with no
    // listener so the call surfaces as a network_error (no need to
    // start a real server).
    const transport = createMultipartFetchTransport({
      endpoint: 'http://127.0.0.1:1/',
      apiToken: 'tok-1234',
      apiVersion: '2026-01',
      timeoutMs: 250,
    });
    await expect(transport.request(baseRequest())).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
