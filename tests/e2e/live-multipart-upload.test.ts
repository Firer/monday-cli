/**
 * Live file-upload wire smoke test (RUN_LIVE_TESTS-gated).
 *
 * The whole file-upload suite mocks the multipart transport, so it
 * CANNOT catch Monday rejecting the on-the-wire multipart shape — which
 * is exactly how the upload break shipped in v0.7.0: the transport
 * emitted the Apollo / jaydenseric spec (`operations` + `map`-array +
 * part `"0"`), every mocked test stayed green, and live Monday 400'd
 * every real upload ("query not found in multipart form"). v0.8-M49
 * rewrote the seam to Monday's native shape; this test drives the EXACT
 * production transport (`createMultipartFetchTransport` → `/v2/file`,
 * native FormData) + the production mutation document against the real
 * API and asserts a real `Asset` comes back. It refines testing.md's
 * "mock at the boundary" rule (R-v0.8-NEW-9): the mock must reject what
 * the wire rejects — and where it structurally can't, a live smoke test
 * backstops it.
 *
 * Skipped unless `RUN_LIVE_TESTS=1` and a token is present, so normal
 * CI is unaffected. Run it as a release-prep / upload-change gate:
 *
 *   RUN_LIVE_TESTS=1 MONDAY_API_TOKEN=... npm run test:e2e
 *   # or, with the write-scoped probe token:
 *   DOTENV_CONFIG_PATH=.env.probe.local RUN_LIVE_TESTS=1 \
 *     npx vitest run tests/e2e/live-multipart-upload.test.ts
 *
 * MUTATES: creates one throwaway board ("M49-LIVE-DELETE-ME-*") with a
 * file column + an item, uploads a tiny file, then DELETES the board in
 * `afterAll`. Self-contained — touches no existing board.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADD_FILE_TO_COLUMN_MUTATION } from '../../src/api/assets.js';
import { createMultipartFetchTransport } from '../../src/api/multipart-transport.js';
import { PINNED_API_VERSION } from '../../src/api/client.js';

const TOKEN = process.env.MONDAY_API_TOKEN;
const LIVE =
  process.env.RUN_LIVE_TESTS === '1' && TOKEN !== undefined && TOKEN.length > 0;
const API_VERSION = process.env.MONDAY_API_VERSION ?? PINNED_API_VERSION;
const ENDPOINT = 'https://api.monday.com/v2';
const TIMEOUT_MS = 30_000;

interface GqlResponse {
  readonly data?: unknown;
  readonly errors?: readonly { readonly message: string }[];
}

const post = async (
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResponse> => {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: TOKEN!,
      'API-Version': API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      ...(variables === undefined ? {} : { variables }),
    }),
  });
  return (await res.json()) as GqlResponse;
};

const expectId = (res: GqlResponse, field: string): string => {
  expect(res.errors, JSON.stringify(res.errors)).toBeUndefined();
  const data = res.data as Record<string, { id?: string } | null> | undefined;
  const id = data?.[field]?.id;
  expect(id, `${field}.id missing`).toBeTruthy();
  return id!;
};

describe.skipIf(!LIVE)('live multipart upload (RUN_LIVE_TESTS)', () => {
  let boardId: string | undefined;
  let columnId = '';
  let itemId = '';

  beforeAll(async () => {
    const stamp = Date.now().toString();
    boardId = expectId(
      await post(
        'mutation ($n: String!) { create_board(board_name: $n, board_kind: private) { id } }',
        { n: `M49-LIVE-DELETE-ME-${stamp}` },
      ),
      'create_board',
    );
    columnId = expectId(
      await post(
        'mutation ($b: ID!) { create_column(board_id: $b, title: "Smoke File", column_type: file) { id } }',
        { b: boardId },
      ),
      'create_column',
    );
    itemId = expectId(
      await post(
        'mutation ($b: ID!) { create_item(board_id: $b, item_name: "smoke-item") { id } }',
        { b: boardId },
      ),
      'create_item',
    );
  }, TIMEOUT_MS);

  afterAll(async () => {
    if (boardId !== undefined) {
      await post('mutation ($id: ID!) { delete_board(board_id: $id) { id } }', {
        id: boardId,
      });
    }
  }, TIMEOUT_MS);

  it(
    'uploads via the production transport to /v2/file and gets a real Asset',
    async () => {
      const transport = createMultipartFetchTransport({
        endpoint: ENDPOINT,
        apiToken: TOKEN!,
        apiVersion: API_VERSION,
        timeoutMs: TIMEOUT_MS,
      });
      const response = await transport.request({
        query: ADD_FILE_TO_COLUMN_MUTATION,
        variables: { itemId, columnId, file: null },
        operationName: 'AddFileToColumn',
        fileVariableName: 'file',
        file: new Blob(['m49 live smoke\n'], { type: 'text/plain' }),
        filename: 'm49-smoke.txt',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      expect(response.status).toBe(200);
      const body = response.body as {
        data?: { add_file_to_column?: { id?: string; name?: string } };
        errors?: readonly { message: string }[];
      };
      // The Apollo-spec regression surfaced here as a 400 + `errors`;
      // a clean upload means the native wire shape parsed live.
      expect(body.errors, JSON.stringify(body.errors)).toBeUndefined();
      expect(body.data?.add_file_to_column?.id).toBeTruthy();
      expect(body.data?.add_file_to_column?.name).toBe('m49-smoke.txt');
    },
    TIMEOUT_MS,
  );
});
