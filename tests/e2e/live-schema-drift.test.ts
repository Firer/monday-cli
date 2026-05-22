/**
 * Live schema-drift smoke test (RUN_LIVE_TESTS-gated).
 *
 * The rest of the suite mocks the network boundary, so it cannot catch
 * Monday removing or renaming a field that the CLI's hand-written
 * GraphQL documents select under the pinned API version — which is
 * exactly how the v0.7.1 `is_leaf` regression shipped: Monday dropped
 * `is_leaf` from the `Board` type at API 2026-01, the canned
 * `BOARD_METADATA_QUERY` still selected it, and every board-metadata-
 * backed command (board describe/columns/groups, item list/search, all
 * `--set` column writes) 500'd against the live API while 4124 mocked
 * tests stayed green.
 *
 * This test runs the EXACT production document against the real API and
 * asserts Monday returns no GraphQL `errors`. It is skipped unless
 * `RUN_LIVE_TESTS=1` and a token is present, so normal CI is
 * unaffected. Run it as a release-prep gate:
 *
 *   RUN_LIVE_TESTS=1 MONDAY_API_TOKEN=... npm run test:e2e
 */
import { describe, expect, it } from 'vitest';
import { BOARD_METADATA_QUERY } from '../../src/api/board-metadata.js';
import { BOARD_GET_QUERY } from '../../src/commands/board/get.js';
import { BOARD_LIST_QUERY } from '../../src/commands/board/list.js';
import { PINNED_API_VERSION } from '../../src/api/client.js';

const TOKEN = process.env.MONDAY_API_TOKEN;
const LIVE =
  process.env.RUN_LIVE_TESTS === '1' && TOKEN !== undefined && TOKEN.length > 0;
// Track the production pin (the SDK's CURRENT_VERSION) so the drift-
// catcher follows the next API bump automatically; env still overrides.
const API_VERSION = process.env.MONDAY_API_VERSION ?? PINNED_API_VERSION;
const ENDPOINT = 'https://api.monday.com/v2';

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

describe.skipIf(!LIVE)('live schema drift (RUN_LIVE_TESTS)', () => {
  it('BOARD_METADATA_QUERY selects only fields the live API still serves', async () => {
    // Discover any board id so the production query has a real target.
    const discover = await post('query { boards(limit: 1) { id } }');
    expect(discover.errors, JSON.stringify(discover.errors)).toBeUndefined();
    const boards = (discover.data as { boards?: { id: string }[] } | undefined)
      ?.boards;
    const boardId = boards?.[0]?.id;
    expect(boardId).toBeDefined();

    const result = await post(BOARD_METADATA_QUERY, { ids: [boardId] });
    // A removed/renamed field surfaces here as a GraphQL validation
    // error ("Cannot query field X on type Board") — the is_leaf class
    // of regression. An empty `errors` means every selected field still
    // exists at the pinned API version.
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
  });

  it('BoardGet + BoardList production documents select only live fields (v0.9-M51 hierarchy_type)', async () => {
    // M51 added `hierarchy_type` to the shared board projection
    // (BOARD_GET_QUERY, the mutation cluster) and BOARD_LIST_QUERY via
    // raw GraphQL — the same SDK-drift class as `is_leaf`. Run the EXACT
    // production documents so a future Monday removal of `hierarchy_type`
    // (or any other selected field) surfaces here rather than silently
    // breaking board get/list/mutations live while mocked tests stay
    // green.
    const discover = await post('query { boards(limit: 1) { id } }');
    expect(discover.errors, JSON.stringify(discover.errors)).toBeUndefined();
    const boardId = (
      discover.data as { boards?: { id: string }[] } | undefined
    )?.boards?.[0]?.id;
    expect(boardId).toBeDefined();

    const get = await post(BOARD_GET_QUERY, { ids: [boardId] });
    expect(get.errors, JSON.stringify(get.errors)).toBeUndefined();

    const list = await post(BOARD_LIST_QUERY, { limit: 1, page: 1 });
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
  });
});
