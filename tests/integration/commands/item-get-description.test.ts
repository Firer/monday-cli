/**
 * Integration tests for `monday item get-description` (v0.11-M54-G).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared `useItemTestEnv` helper. Coverage:
 *   - happy path (populated description with 3 blocks; the cassette
 *     pins `match_query: /description \{/` per the v0.9-M52-graduated
 *     "Wire selection-pin for raw-GraphQL SDK-drift fields" rule —
 *     `Item.description` is SDK 14.0.0-untyped, same drift class as
 *     `Board.hierarchy_type` / `Board.views`)
 *   - wire-null description normalises to {id: null, blocks: []}
 *     sentinel
 *   - empty blocks (description created then emptied) preserved as
 *     {id: <real>, blocks: []}
 *   - `not_found` when Monday returns no item row
 *   - non-numeric ID rejected as `usage_error`
 *   - `--api-version` reaches the error envelope on HTTP 401
 *   - shape regression (`blocks` not an array) surfaces as
 *     `internal_error` with `details.item_id` + `details.issues`
 *     (R18 parse-boundary wrap via `parseItemDescription`)
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { useItemTestEnv } from './_item-fixtures.js';

const { drive } = useItemTestEnv();

const populatedDescription = {
  id: '8781640',
  blocks: [
    {
      id: 'b1',
      type: 'normal text',
      content: { deltaFormat: [{ insert: 'Refactor login flow' }] },
      position: 1024,
    },
    {
      id: 'b2',
      type: 'bulleted list',
      content: { deltaFormat: [{ insert: 'extract auth helper' }] },
      position: 2048,
    },
    {
      id: 'b3',
      type: 'check',
      content: null,
      position: 3072,
    },
  ],
};

describe('monday item get-description (v0.11-M54-G)', () => {
  it('emits the projected description envelope (cassette pins the production document selects `description { ... }`)', async () => {
    const out = await drive(
      ['item', 'get-description', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            match_variables: { ids: ['12345'] },
            // Wire selection-pin (testing.md graduated rule, v0.9-M52).
            // A future refactor dropping `description { ... }` from
            // `ITEM_DESCRIPTION_QUERY` fails this assertion before
            // reaching live API — same drift-catcher as M51's
            // `hierarchy_type` cassettes + M52's `views` cassette.
            match_query: /description \{/,
            response: {
              data: {
                items: [
                  { id: '12345', description: populatedDescription },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: typeof populatedDescription;
    };
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
    expect(env.data.id).toBe('8781640');
    expect(env.data.blocks).toHaveLength(3);
    expect(env.data.blocks[0]).toMatchObject({
      id: 'b1',
      type: 'normal text',
      position: 1024,
    });
    // JSON-scalar content surfaces as the parsed object verbatim.
    expect(env.data.blocks[0]?.content).toEqual({
      deltaFormat: [{ insert: 'Refactor login flow' }],
    });
    // null content preserved on the 3rd block.
    expect(env.data.blocks[2]?.content).toBeNull();
  });

  it('normalises wire `description: null` to the sentinel {id: null, blocks: []}', async () => {
    const out = await drive(
      ['item', 'get-description', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            match_variables: { ids: ['12345'] },
            response: {
              data: { items: [{ id: '12345', description: null }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual({ id: null, blocks: [] });
  });

  it('preserves an emptied description as {id: <real>, blocks: []} (distinct from the wire-null sentinel)', async () => {
    const out = await drive(
      ['item', 'get-description', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            match_variables: { ids: ['12345'] },
            response: {
              data: {
                items: [
                  { id: '12345', description: { id: '8781640', blocks: [] } },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string | null; blocks: unknown[] };
    };
    // Real id + empty blocks — the "created, all blocks deleted" shape.
    expect(env.data.id).toBe('8781640');
    expect(env.data.blocks).toEqual([]);
  });

  it('surfaces not_found when Monday returns no item', async () => {
    const out = await drive(
      ['item', 'get-description', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details).toMatchObject({ item_id: '99999' });
  });

  it('rejects non-numeric item IDs as usage_error', async () => {
    const out = await drive(
      ['item', 'get-description', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--api-version reaches the error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'get-description', '12345', '--json'],
      {
        interactions: [
          { operation_name: 'ItemGetDescription', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });

  it('surfaces a malformed items[0] row as internal_error (Codex R1 P2-1 W8 guard — non-object row would otherwise look like absent description)', async () => {
    const out = await drive(
      ['item', 'get-description', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            response: {
              // `items: [42]` — a scalar row instead of the expected
              // object shape. Without the guard, the verb would treat
              // this as `descriptionRaw = null` and emit the
              // "no description" sentinel — masking the shape regression.
              data: { items: [42] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details).toMatchObject({
      item_id: '12345',
      reason: 'malformed_item_row',
    });
  });

  it('wraps a malformed description payload as internal_error with details.item_id + details.issues (R18 parse-boundary)', async () => {
    const out = await drive(
      ['item', 'get-description', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGetDescription',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    // `blocks: 'not-an-array'` violates itemDescriptionSchema;
                    // surfaces with details.issues rather than a bare ZodError
                    // that the runner's catch-all would map to internal_error
                    // without the failing field path.
                    description: { id: '42', blocks: 'not-an-array' },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details).toMatchObject({ item_id: '12345' });
    expect(Array.isArray((env.error?.details as { issues?: unknown }).issues)).toBe(true);
  });
});
