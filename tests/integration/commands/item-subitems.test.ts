/**
 * Integration tests for `monday item subitems` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - direct subitems sorted by ID asc; not_found on a missing parent.
 */
import { describe, expect, it } from 'vitest';
import {
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { item, useItemTestEnv } from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item subitems (integration)', () => {
  it('lists direct subitems sorted by ID asc', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: {
              data: {
                items: [
                  {
                    id: '12345',
                    subitems: [item('30'), item('5'), item('99')],
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string }[];
    };
    expect(env.data.map((i) => i.id)).toEqual(['5', '30', '99']);
    expect(env.meta.has_more).toBe(false);
    expect(env.meta.next_cursor).toBeNull();
  });

  it('returns empty array when item has no subitems', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: { data: { items: [{ id: '12345', subitems: [] }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: unknown[];
    };
    expect(env.data).toEqual([]);
  });

  it('handles null subitems (Monday returns null instead of [])', async () => {
    const out = await drive(
      ['item', 'subitems', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemSubitems',
            response: { data: { items: [{ id: '12345', subitems: null }] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: unknown[];
    };
    expect(env.data).toEqual([]);
  });

  it('surfaces not_found when the parent item is missing', async () => {
    const out = await drive(
      ['item', 'subitems', '99999', '--json'],
      {
        interactions: [
          { operation_name: 'ItemSubitems', response: { data: { items: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });
});
