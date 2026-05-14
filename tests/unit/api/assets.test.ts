/**
 * Unit tests for `src/api/assets.ts` — the v0.4-M31 IMPL runtime
 * bodies of `addFileToColumn` + `addFileToUpdate` driven against a
 * stub `MultipartTransport`. Mock-at-the-network-boundary per
 * testing.md — the stub satisfies `MultipartTransport` without
 * touching `fetch` so the tests exercise the real parse-boundary +
 * retry + file-too-large rewrap path.
 *
 * Scope: schemas + mutation documents + the two fetcher runtime
 * bodies. Action-body integration coverage (file-read I/O + dry-run
 * + cache invalidation) lands in `tests/integration/commands/item-
 * upload.test.ts` + `tests/integration/commands/update-upload.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  ADD_FILE_TO_COLUMN_MUTATION,
  ADD_FILE_TO_UPDATE_MUTATION,
  addFileToColumn,
  addFileToUpdate,
  assetSchema,
  itemUploadOutputSchema,
  updateUploadOutputSchema,
  uploadedBySchema,
} from '../../../src/api/assets.js';
import { ApiError, MondayCliError } from '../../../src/utils/errors.js';
import type {
  MultipartTransport,
  MultipartTransportRequest,
  MultipartTransportResponse,
} from '../../../src/api/multipart-transport.js';
import type { MondayClient } from '../../../src/api/client.js';

// MondayClient is referenced by the fetchers as a typed input slot
// only (the multipart wire bypasses MondayClient entirely). Cast a
// minimal placeholder rather than constructing a real client — the
// fetcher's `void inputs.client` keeps this safe at runtime.
const FAKE_CLIENT = {} as unknown as MondayClient;

interface StubTransportSpec {
  readonly status?: number;
  readonly body: unknown;
  readonly delayMs?: number;
}

const stubTransport = (
  specs: readonly StubTransportSpec[],
): {
  readonly transport: MultipartTransport;
  readonly captured: readonly MultipartTransportRequest[];
  readonly remaining: () => number;
} => {
  let cursor = 0;
  const captured: MultipartTransportRequest[] = [];
  const transport: MultipartTransport = {
    request: async (
      req: MultipartTransportRequest,
    ): Promise<MultipartTransportResponse> => {
      captured.push(req);
      const spec = specs[cursor];
      if (spec === undefined) {
        throw new Error(
          `stubTransport exhausted: no spec for call ${String(cursor + 1)}`,
        );
      }
      cursor++;
      if (spec.delayMs !== undefined && spec.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, spec.delayMs));
      }
      return {
        status: spec.status ?? 200,
        headers: { 'content-type': 'application/json' },
        body: spec.body,
      };
    },
  };
  return {
    transport,
    captured,
    remaining: () => Math.max(0, specs.length - cursor),
  };
};

const SAMPLE_ASSET = {
  id: '555000111',
  name: 'screenshot.png',
  url: 'https://files.monday.com/x/screenshot.png',
  public_url: 'https://share.monday.com/x',
  file_extension: 'png',
  file_size: 41_822,
  created_at: '2026-05-13T22:55:00Z',
  uploaded_by: { id: '1', name: 'Alice' },
  original_geometry: '1920x1080',
  url_thumbnail: 'https://files.monday.com/x/screenshot_thumb.png',
};

const sampleBlob = (bytes: Uint8Array = new Uint8Array([0x89, 0x50])): Blob =>
  new Blob([bytes], { type: 'image/png' });

describe('uploadedBySchema', () => {
  it('accepts the slim {id, name} projection', () => {
    expect(() =>
      uploadedBySchema.parse({ id: '1', name: 'Alice' }),
    ).not.toThrow();
  });

  it('rejects empty id', () => {
    expect(() => uploadedBySchema.parse({ id: '', name: 'Alice' })).toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() =>
      uploadedBySchema.parse({ id: '1', name: 'Alice', email: 'a@x' }),
    ).toThrow();
  });
});

describe('assetSchema', () => {
  it('parses the canonical 10-field Asset projection', () => {
    expect(assetSchema.parse(SAMPLE_ASSET)).toMatchObject({
      id: '555000111',
      name: 'screenshot.png',
      uploaded_by: { id: '1', name: 'Alice' },
    });
  });

  it('accepts null created_at + null original_geometry + null url_thumbnail (non-image)', () => {
    expect(() =>
      assetSchema.parse({
        ...SAMPLE_ASSET,
        created_at: null,
        original_geometry: null,
        url_thumbnail: null,
      }),
    ).not.toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() =>
      assetSchema.parse({ ...SAMPLE_ASSET, future_field: 'x' }),
    ).toThrow();
  });
});

describe('itemUploadOutputSchema + updateUploadOutputSchema', () => {
  it('item upload output pins operation literal + echoed inputs + asset', () => {
    expect(() =>
      itemUploadOutputSchema.parse({
        operation: 'add_file_to_column',
        item_id: '12345',
        column_id: 'files',
        filename: 'screenshot.png',
        file_size_bytes: 41_822,
        asset: SAMPLE_ASSET,
      }),
    ).not.toThrow();
  });

  it('update upload output pins operation literal + carries update_id (no column_id)', () => {
    expect(() =>
      updateUploadOutputSchema.parse({
        operation: 'add_file_to_update',
        update_id: '987654321',
        filename: 'screenshot.png',
        file_size_bytes: 41_822,
        asset: SAMPLE_ASSET,
      }),
    ).not.toThrow();
  });

  it('item upload output rejects bad operation literal', () => {
    expect(() =>
      itemUploadOutputSchema.parse({
        operation: 'add_file_to_update',
        item_id: '12345',
        column_id: 'files',
        filename: 'screenshot.png',
        file_size_bytes: 41_822,
        asset: SAMPLE_ASSET,
      }),
    ).toThrow();
  });
});

describe('ADD_FILE_TO_COLUMN_MUTATION', () => {
  it('declares the pinned operationName + variable types', () => {
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/mutation\s+AddFileToColumn/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\$itemId:\s*ID!/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\$columnId:\s*String!/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\$file:\s*File!/);
  });

  it('selects the full 10-field Asset projection', () => {
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\bid\b/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\bname\b/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/\burl\b/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/public_url/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/file_extension/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/file_size/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/created_at/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/uploaded_by\s*\{\s*id\s+name\s*\}/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/original_geometry/);
    expect(ADD_FILE_TO_COLUMN_MUTATION).toMatch(/url_thumbnail/);
  });
});

describe('ADD_FILE_TO_UPDATE_MUTATION', () => {
  it('declares the pinned operationName + variable types (no columnId)', () => {
    expect(ADD_FILE_TO_UPDATE_MUTATION).toMatch(/mutation\s+AddFileToUpdate/);
    expect(ADD_FILE_TO_UPDATE_MUTATION).toMatch(/\$updateId:\s*ID!/);
    expect(ADD_FILE_TO_UPDATE_MUTATION).toMatch(/\$file:\s*File!/);
    expect(ADD_FILE_TO_UPDATE_MUTATION).not.toMatch(/columnId|column_id/);
  });
});

describe('addFileToColumn', () => {
  it('happy path returns the parsed Asset + source/cacheAge/complexity slots', async () => {
    const { transport, captured } = stubTransport([
      { body: { data: { add_file_to_column: SAMPLE_ASSET } } },
    ]);
    const ctrl = new AbortController();
    const result = await addFileToColumn({
      client: FAKE_CLIENT,
      multipart: transport,
      itemId: '12345',
      columnId: 'files',
      file: sampleBlob(),
      filename: 'screenshot.png',
      signal: ctrl.signal,
      retries: 0,
    });
    expect(result.asset.id).toBe('555000111');
    expect(result.source).toBe('live');
    expect(result.cacheAgeSeconds).toBeNull();
    // The asset-upload mutation doesn't return a complexity block;
    // parseComplexity returns null for absent payloads.
    expect(result.complexity).toBeNull();
    // operationName is pinned literally per R-NEW-37 W2 (not caller-
    // overridable).
    expect(captured[0]?.operationName).toBe('AddFileToColumn');
    expect(captured[0]?.fileVariableName).toBe('file');
    expect(captured[0]?.filename).toBe('screenshot.png');
    expect(captured[0]?.variables).toMatchObject({
      itemId: '12345',
      columnId: 'files',
      file: null,
    });
    expect(captured[0]?.signal).toBe(ctrl.signal);
  });

  it('null add_file_to_column response → not_found with item_id + column_id details', async () => {
    const { transport } = stubTransport([
      { body: { data: { add_file_to_column: null } } },
    ]);
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { item_id: '12345', column_id: 'files' },
    });
  });

  it('missing add_file_to_column root key → internal_error (schema drift)', async () => {
    const { transport } = stubTransport([
      // The response shape is missing the `add_file_to_column`
      // mutation root — `assertResponseFieldPresent` surfaces a
      // schema-drift internal_error rather than collapsing to
      // not_found.
      { body: { data: { unrelated: SAMPLE_ASSET } } },
    ]);
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('bad Asset shape → internal_error via assetSchema parse boundary', async () => {
    const { transport } = stubTransport([
      {
        body: {
          data: {
            add_file_to_column: {
              ...SAMPLE_ASSET,
              file_size: 'not-a-number',
            },
          },
        },
      },
    ]);
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('FILE_SIZE_LIMIT_EXCEEDED extension code → file_too_large rewrap with local file size', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [
            {
              message: 'File size limit exceeded',
              extensions: { code: 'FILE_SIZE_LIMIT_EXCEEDED' },
            },
          ],
        },
      },
    ]);
    const file = sampleBlob(new Uint8Array(123));
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file,
        filename: 'big.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: {
        reason: 'file_too_large',
        file_size_bytes: 123,
        filename: 'big.png',
      },
    });
  });

  it('HTTP 413 → file_too_large rewrap (proxy-mediated rejection without GraphQL body)', async () => {
    const { transport } = stubTransport([
      {
        status: 413,
        body: { error_message: 'Request entity too large' },
      },
    ]);
    const file = sampleBlob(new Uint8Array(999));
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file,
        filename: 'big.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: { reason: 'file_too_large', file_size_bytes: 999 },
    });
  });

  it('plain message-vocabulary fallback → file_too_large rewrap', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [
            {
              message: 'Upload exceeds the limit set on this account',
            },
          ],
        },
      },
    ]);
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: { reason: 'file_too_large' },
    });
  });

  it('non-size validation_failed bubbles unchanged (NOT rewrapped as file_too_large)', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [
            {
              message: 'Invalid item id',
              extensions: { code: 'INVALIDITEMIDEXCEPTION' },
            },
          ],
        },
      },
    ]);
    const promise = addFileToColumn({
      client: FAKE_CLIENT,
      multipart: transport,
      itemId: '12345',
      columnId: 'files',
      file: sampleBlob(),
      filename: 'x.png',
      signal: new AbortController().signal,
      retries: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(MondayCliError);
    await expect(promise).rejects.toMatchObject({ code: 'not_found' });
  });

  it('file_too_large rewrap (HTTP 413 non-JSON body) short-circuits the retry loop (round-1 P2-1)', async () => {
    // Simulates an LB-mediated 413 with HTML body: the transport's
    // JSON-parse failure throws as network_error (retryable per
    // CODE_RETRYABLE_DEFAULT). If the rewrap lived OUTSIDE
    // withRetry's catch, the loop would re-upload up to `retries`
    // times before surfacing file_too_large. With the round-1 P2-1
    // fix the rewrap fires inside the retry thunk so the resulting
    // usage_error (non-retryable) short-circuits the loop after the
    // first attempt.
    const transport: MultipartTransport = {
      request: () =>
        Promise.resolve({
          status: 413,
          headers: { 'content-type': 'text/html' },
          body: '<html>oops</html>',
        }),
    };
    let calls = 0;
    const countingTransport: MultipartTransport = {
      request: (req) => {
        calls++;
        return transport.request(req);
      },
    };
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: countingTransport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(new Uint8Array(789)),
        filename: 'big.png',
        signal: new AbortController().signal,
        retries: 3,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: { reason: 'file_too_large', file_size_bytes: 789 },
    });
    // EXACTLY one call — the rewrap inside the retry thunk produces a
    // non-retryable usage_error that withRetry surfaces immediately.
    expect(calls).toBe(1);
  });

  it('honors retries on rate_limited (succeeds on second attempt)', async () => {
    const { transport, remaining } = stubTransport([
      {
        body: {
          errors: [
            {
              message: 'Rate limit hit',
              extensions: { code: 'RATE_LIMIT_EXCEEDED' },
            },
          ],
        },
      },
      { body: { data: { add_file_to_column: SAMPLE_ASSET } } },
    ]);
    const result = await addFileToColumn({
      client: FAKE_CLIENT,
      multipart: transport,
      itemId: '12345',
      columnId: 'files',
      file: sampleBlob(),
      filename: 'x.png',
      signal: new AbortController().signal,
      retries: 3,
    });
    expect(result.asset.id).toBe('555000111');
    expect(remaining()).toBe(0);
  }, 10_000);

  it('exhausts retries on persistent rate_limited and rethrows the typed error', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [
            { message: 'Rate limit hit', extensions: { code: 'RATE_LIMIT_EXCEEDED' } },
          ],
        },
      },
      {
        body: {
          errors: [
            { message: 'Rate limit hit', extensions: { code: 'RATE_LIMIT_EXCEEDED' } },
          ],
        },
      },
    ]);
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 1,
      }),
    ).rejects.toMatchObject({ code: 'rate_limited' });
  }, 10_000);

  it('rejects a non-ApiError throw from the transport via wrapTransportError', async () => {
    const transport: MultipartTransport = {
      request: () => Promise.reject(new TypeError('unexpected SDK shape')),
    };
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });
});

describe('addFileToUpdate', () => {
  it('happy path returns the parsed Asset + threads update_id, NOT column_id', async () => {
    const { transport, captured } = stubTransport([
      { body: { data: { add_file_to_update: SAMPLE_ASSET } } },
    ]);
    const result = await addFileToUpdate({
      client: FAKE_CLIENT,
      multipart: transport,
      updateId: '987654321',
      file: sampleBlob(),
      filename: 'x.png',
      signal: new AbortController().signal,
      retries: 0,
    });
    expect(result.asset.id).toBe('555000111');
    expect(captured[0]?.operationName).toBe('AddFileToUpdate');
    expect(captured[0]?.variables).toMatchObject({
      updateId: '987654321',
      file: null,
    });
    expect(captured[0]?.variables).not.toHaveProperty('columnId');
  });

  it('null add_file_to_update → not_found with update_id details', async () => {
    const { transport } = stubTransport([
      { body: { data: { add_file_to_update: null } } },
    ]);
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'not_found',
      details: { update_id: '987654321' },
    });
  });

  it('missing add_file_to_update root key → internal_error (schema drift)', async () => {
    const { transport } = stubTransport([
      { body: { data: { unrelated: SAMPLE_ASSET } } },
    ]);
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('bad Asset shape → internal_error via assetSchema parse boundary', async () => {
    const { transport } = stubTransport([
      {
        body: {
          data: {
            add_file_to_update: {
              ...SAMPLE_ASSET,
              uploaded_by: { id: '', name: '' },
            },
          },
        },
      },
    ]);
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'internal_error' });
  });

  it('file_too_large rewrap (HTTP 413 non-JSON body) short-circuits the retry loop (round-2 P3-1 parity)', async () => {
    // Mirrors the addFileToColumn round-1 P2-1 test — both fetchers
    // own independent retry-thunk rewrap blocks so each needs its
    // own regression coverage.
    let calls = 0;
    const transport: MultipartTransport = {
      request: () => {
        calls++;
        return Promise.resolve({
          status: 413,
          headers: { 'content-type': 'text/html' },
          body: '<html>oops</html>',
        });
      },
    };
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file: sampleBlob(new Uint8Array(789)),
        filename: 'big.png',
        signal: new AbortController().signal,
        retries: 3,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: { reason: 'file_too_large', file_size_bytes: 789 },
    });
    expect(calls).toBe(1);
  });

  it('FILE_SIZE_LIMIT_EXCEEDED → file_too_large rewrap (with local file size)', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [
            { message: 'File size limit exceeded', extensions: { code: 'FILE_SIZE_LIMIT_EXCEEDED' } },
          ],
        },
      },
    ]);
    const file = sampleBlob(new Uint8Array(456));
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file,
        filename: 'big.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({
      code: 'usage_error',
      details: { reason: 'file_too_large', file_size_bytes: 456, filename: 'big.png' },
    });
  });

  it('non-size validation_failed bubbles unchanged', async () => {
    const { transport } = stubTransport([
      {
        body: {
          errors: [{ message: 'forbidden', extensions: { code: 'FORBIDDEN' } }],
        },
      },
    ]);
    await expect(
      addFileToUpdate({
        client: FAKE_CLIENT,
        multipart: transport,
        updateId: '987654321',
        file: sampleBlob(),
        filename: 'x.png',
        signal: new AbortController().signal,
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('signal abort propagation', () => {
  it('addFileToColumn — caller-aborted signal stops the retry loop', async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error('caller cancel'));
    const transport: MultipartTransport = {
      // Should never be called — withRetry's pre-call abort check fires first.
      request: () => Promise.reject(new ApiError('internal_error', 'unreachable')),
    };
    await expect(
      addFileToColumn({
        client: FAKE_CLIENT,
        multipart: transport,
        itemId: '12345',
        columnId: 'files',
        file: sampleBlob(),
        filename: 'x.png',
        signal: ctrl.signal,
        retries: 3,
      }),
    ).rejects.toMatchObject({
      code: 'internal_error',
      details: { aborted: true },
    });
  });
});
