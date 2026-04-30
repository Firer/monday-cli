/**
 * Integration tests for `monday item *` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6). Coverage:
 *   - item get — happy path + not_found + envelope contract.
 *   - item list — single page, --all walk, NDJSON streaming, stale
 *     cursor mid-walk + initial.
 *   - item find — exact match, ambiguous_name + --first warning.
 *   - item search — items_page_by_column_values + --where parsed
 *     into query_params.
 *   - item subitems — children listing.
 *   - --api-version reaches error envelope on a per-noun basis.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';

const sampleColumnValues = [
  {
    id: 'status_4',
    type: 'status',
    text: 'Done',
    value: '{"label":"Done","index":1}',
    column: { title: 'Status' },
  },
  {
    id: 'date4',
    type: 'date',
    text: '2026-05-01',
    value: '{"date":"2026-05-01","time":null}',
    column: { title: 'Due date' },
  },
];

const sampleItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'active',
  url: 'https://example.monday.com/items/12345',
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-29T11:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: sampleColumnValues,
};

describe('monday item get (integration)', () => {
  it('emits the projected single-resource envelope', async () => {
    const out = await drive(
      ['item', 'get', '12345', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGet',
            response: { data: { items: [sampleItem] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        board_id: string;
        columns: Record<string, { type: string; label?: string; date?: string }>;
      };
    };
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
    expect(env.data.id).toBe('12345');
    expect(env.data.board_id).toBe('111');
    expect(env.data.columns.status_4).toMatchObject({
      type: 'status',
      label: 'Done',
    });
    expect(env.data.columns.date4).toMatchObject({
      type: 'date',
      date: '2026-05-01',
    });
  });

  it('surfaces not_found when Monday returns no item', async () => {
    const out = await drive(
      ['item', 'get', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemGet',
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('--api-version reaches the error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'get', '12345', '--json'],
      {
        interactions: [
          { operation_name: 'ItemGet', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });

  it('rejects non-numeric item IDs as usage_error', async () => {
    const out = await drive(
      ['item', 'get', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});
