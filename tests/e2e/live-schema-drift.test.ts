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
import { ITEM_DESCRIPTION_QUERY } from '../../src/api/item-description.js';
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

    // v0.9-M52: assert the `views` key is PRESENT (not array-only —
    // `Board.views` is wire-nullable per the pre-flight probe, so the
    // value can be `array | null`). The mocks supply views; this is
    // the live equivalent that catches a Monday `views` removal —
    // dropping the field would still parse as a valid GraphQL query
    // but the response wouldn't carry the key. Codex pre-flight R2
    // pinned the key-presence shape over array-only.
    const board = (
      result.data as { boards?: Record<string, unknown>[] } | undefined
    )?.boards?.[0];
    expect(board).toBeDefined();
    expect(board).toHaveProperty('views');
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
    // Assert the field is actually SELECTED + returned, not just that
    // the query validates — removing `hierarchy_type` from the document
    // would leave a valid query, so the `errors`-only check can't catch
    // a selection regression.
    const getBoard = (get.data as { boards?: Record<string, unknown>[] } | undefined)
      ?.boards?.[0];
    expect(getBoard).toHaveProperty('hierarchy_type');

    const list = await post(BOARD_LIST_QUERY, { limit: 1, page: 1 });
    expect(list.errors, JSON.stringify(list.errors)).toBeUndefined();
    const listBoard = (list.data as { boards?: Record<string, unknown>[] } | undefined)
      ?.boards?.[0];
    expect(listBoard).toHaveProperty('hierarchy_type');
  });

  it('ITEM_DESCRIPTION_QUERY production document selects only live fields (v0.11-M54-G Item.description)', async () => {
    // v0.11-M54-G added `Item.description { id, blocks { id type
    // content position } }` via raw GraphQL — the same SDK-drift
    // class as `is_leaf` / `hierarchy_type` / `views`
    // (`@mondaydotcomorg/api` 14.0.0 doesn't expose `ItemDescription`
    // on the typed surface). Run the EXACT production document
    // against the live API so a future Monday removal of `description`
    // (or any selected DocumentBlock field) surfaces here rather than
    // silently breaking `monday item get-description` live while
    // mocked tests stay green.
    //
    // 3rd consumer of R-v0.9-NEW-6 (graduated v0.9-M52 into
    // .claude/rules/testing.md): the two-layer guard pattern
    // (cassette match_query + this live-smoke toHaveProperty).
    const discover = await post(
      'query { boards(limit: 25) { id items_page(limit: 1) { items { id } } } }',
    );
    expect(discover.errors, JSON.stringify(discover.errors)).toBeUndefined();
    const boards = (discover.data as {
      boards?: { items_page?: { items?: { id: string }[] } }[];
    } | undefined)?.boards ?? [];
    const itemId = boards
      .flatMap((b) => b.items_page?.items ?? [])
      .map((i) => i.id)
      .find((id) => typeof id === 'string');
    expect(itemId, 'no items reachable to this token for the description-smoke probe').toBeDefined();

    const result = await post(ITEM_DESCRIPTION_QUERY, { ids: [itemId] });
    // Removed/renamed field would surface here as "Cannot query
    // field X on type Y" — the `is_leaf` regression class.
    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();

    // Key-presence check (Item.description is wire-nullable per the
    // 2026-01 probe — value can be `null` for items with no
    // description set). A future Monday removal of `description`
    // would drop the key from the response without erroring on the
    // query, so the toHaveProperty assertion catches that drift.
    const item = (
      result.data as { items?: Record<string, unknown>[] } | undefined
    )?.items?.[0];
    expect(item).toBeDefined();
    expect(item).toHaveProperty('description');
  });
});
