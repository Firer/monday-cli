/**
 * Integration tests for `monday item history <iid>` — drives the
 * runtime two-source walker (item-board lookup + activity_logs +
 * updates) via `FixtureTransport` cassettes (cli-design §13 v0.3
 * entry; v0.3-plan §3 M24).
 *
 * Tests confirm:
 *   - ItemBoardLookup → activity_logs → updates wire-call order
 *     (envelope `data` chronologically merged).
 *   - `entity = 'pulse'` walker-side filter drops board-scoped
 *     events.
 *   - `--since` / `--until` thread through to activity_logs +
 *     filter client-side on updates.
 *   - `--kinds` narrows `data` array; warnings preserved.
 *   - `--stream` emits NDJSON per merged event + a §6.3 trailer.
 *   - `unknown_event_kind` warning shape + aggregation.
 *   - `not_found` envelope on missing item (item-board lookup
 *     short-circuit).
 *   - Stage-1 / Stage-2 parse-failure surfaces as `internal_error`.
 *   - §6.1 universal meta keys present + `meta.source: "live"`.
 *
 * Cassettes are inline `Interaction[]` per the M22/M23 precedent
 * — the history surface fits comfortably without shared fixtures.
 */
import { describe, expect, it } from 'vitest';
import { drive } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const validItemBoardLookup: Cassette['interactions'][number] = {
  operation_name: 'ItemBoardLookup',
  response: {
    data: { items: [{ id: '12345', board: { id: '67890' } }] },
  },
};

const emptyActivityLogs: Cassette['interactions'][number] = {
  operation_name: 'ItemHistoryActivityLogs',
  response: {
    data: { boards: [{ id: '67890', activity_logs: [] }] },
  },
};

const emptyUpdates: Cassette['interactions'][number] = {
  operation_name: 'ItemHistoryUpdates',
  response: {
    data: { items: [{ id: '12345', updates: [] }] },
  },
};

describe('monday item history — happy path', () => {
  it('runs ItemBoardLookup → activity_logs → updates and merges chronologically', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'update_column_value',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: JSON.stringify({
                        column_id: 'status',
                        column_type: 'status',
                        value: JSON.stringify({ label: 'Done', index: 1 }),
                        previous_value: JSON.stringify({ label: 'In progress', index: 0 }),
                        textual_value: 'Done',
                        pulse_id: '12345',
                        pulse_name: 'Refactor login',
                      }),
                    },
                    // Board-scoped — walker drops via entity check.
                    {
                      id: 'act-2',
                      event: 'create_column',
                      entity: 'board',
                      user_id: '99',
                      created_at: '2026-05-10T09:15:00Z',
                      data: '{}',
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          operation_name: 'ItemHistoryUpdates',
          response: {
            data: {
              items: [
                {
                  id: '12345',
                  updates: [
                    {
                      id: 'upd-5001',
                      body: '<p>Started the auth refactor</p>',
                      text_body: 'Started the auth refactor',
                      created_at: '2026-05-10T09:30:00Z',
                      edited_at: '2026-05-10T09:30:00Z',
                      creator_id: '12345',
                      replies: [
                        {
                          id: 'rep-7001',
                          body: '<p>+1</p>',
                          kind: 'reply',
                          text_body: '+1',
                          created_at: '2026-05-10T09:45:00Z',
                          updated_at: '2026-05-10T09:45:00Z',
                          creator_id: '67890',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    expect(result.requests).toBe(3);
    const envelope = JSON.parse(result.stdout) as {
      ok: boolean;
      data: readonly { id: string; kind: string }[];
      meta: { source: string };
      warnings?: readonly unknown[];
    };
    expect(envelope.ok).toBe(true);
    // Chronological merge order: act-1 (09:00) → upd-5001 (09:30)
    // → rep-7001 (09:45). Board-scoped create_column dropped.
    expect(envelope.data.map((e) => e.id)).toEqual([
      'act-1',
      'upd-5001',
      'rep-7001',
    ]);
    expect(envelope.data.map((e) => e.kind)).toEqual([
      'update_column_value',
      'update_posted',
      'update_replied',
    ]);
    expect(envelope.meta.source).toBe('live');
    expect(envelope.warnings ?? []).toEqual([]);
  });

  it('emits the typed update_column_value before/after via nested-JSON unwrap', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'update_column_value',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: JSON.stringify({
                        column_id: 'date4',
                        column_type: 'date',
                        value: '2026-06-01',
                        previous_value: '2026-05-01',
                        textual_value: '2026-06-01',
                        pulse_id: '12345',
                        pulse_name: 'Refactor login',
                      }),
                    },
                  ],
                },
              ],
            },
          },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      data: readonly {
        kind: string;
        column_type?: string;
        before?: unknown;
        after?: unknown;
      }[];
    };
    expect(envelope.data[0]?.kind).toBe('update_column_value');
    expect(envelope.data[0]?.before).toBe('2026-05-01');
    expect(envelope.data[0]?.after).toBe('2026-06-01');
  });
});

describe('monday item history — flag threading', () => {
  it('threads --since / --until into the activity_logs call', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          match_variables: {
            from: '2026-05-01T00:00:00Z',
            to: '2026-05-31T23:59:59Z',
          },
          response: { data: { boards: [] } },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      [
        'item',
        'history',
        '12345',
        '--since',
        '2026-05-01T00:00:00Z',
        '--until',
        '2026-05-31T23:59:59Z',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('threads --activity-logs-page + --updates-page + --limit into the wire vars', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          match_variables: { page: 3, limit: 200 },
          response: { data: { boards: [] } },
        },
        {
          operation_name: 'ItemHistoryUpdates',
          match_variables: { page: 5, limit: 200 },
          response: { data: { items: [] } },
        },
      ],
    };
    const result = await drive(
      [
        'item',
        'history',
        '12345',
        '--activity-logs-page',
        '3',
        '--updates-page',
        '5',
        '--limit',
        '200',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    expect(result.remaining).toBe(0);
  });

  it('--kinds narrows the data array but preserves warnings', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'update_column_value',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: JSON.stringify({
                        column_id: 'status',
                        column_type: 'status',
                        value: '{}',
                      }),
                    },
                    {
                      id: 'act-2',
                      event: 'future_kind',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:15:00Z',
                      data: '{}',
                    },
                  ],
                },
              ],
            },
          },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      [
        'item',
        'history',
        '12345',
        '--kinds',
        'update_column_value',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      data: readonly { id: string; kind: string }[];
      warnings: readonly { code: string }[];
    };
    expect(envelope.data).toHaveLength(1);
    expect(envelope.data[0]?.kind).toBe('update_column_value');
    // Filter narrows data; the unknown-event-kind warning still
    // surfaces because the filter runs after projection + warning
    // aggregation.
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]?.code).toBe('unknown_event_kind');
  });

  it('--kinds rejects an unknown literal at the parse boundary', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      ['item', 'history', '12345', '--kinds', 'not_a_real_kind', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('usage_error');
  });

  it('--since after --until is rejected at the parse boundary', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      [
        'item',
        'history',
        '12345',
        '--since',
        '2026-06-01',
        '--until',
        '2026-05-01',
        '--json',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe('usage_error');
  });

  it('--since with an invalid ISO timestamp is rejected at the parse boundary', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      ['item', 'history', '12345', '--since', 'not-a-date', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe('usage_error');
  });
});

describe('monday item history — unknown_event_kind warning', () => {
  it('aggregates repeated unknown events into one warning', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'future_kind',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: '{}',
                    },
                    {
                      id: 'act-2',
                      event: 'future_kind',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:30:00Z',
                      data: '{}',
                    },
                  ],
                },
              ],
            },
          },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      data: readonly { kind: string; event?: string }[];
      warnings: readonly {
        code: string;
        details: {
          event: string;
          entity: string;
          occurrence_count: number;
          hint: string;
        };
      }[];
    };
    // Both events surface in `data` under the unknown variant.
    expect(envelope.data.every((e) => e.kind === 'unknown')).toBe(true);
    expect(envelope.warnings).toHaveLength(1);
    expect(envelope.warnings[0]?.code).toBe('unknown_event_kind');
    expect(envelope.warnings[0]?.details.event).toBe('future_kind');
    expect(envelope.warnings[0]?.details.entity).toBe('pulse');
    expect(envelope.warnings[0]?.details.occurrence_count).toBe(2);
  });
});

describe('monday item history — not_found', () => {
  it('short-circuits on item-board lookup when item is missing', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ItemBoardLookup',
          response: { data: { items: [] } },
        },
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    // The lookup raised not_found; activity_logs + updates calls
    // did NOT fire.
    expect(result.requests).toBe(1);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as {
      ok: boolean;
      error: { code: string; details: { item_id: string } };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('not_found');
    expect(envelope.error.details.item_id).toBe('12345');
  });

  it('rejects non-numeric item ID at the parse boundary', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      ['item', 'history', 'not-numeric', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const envelope = JSON.parse(result.stderr) as { error: { code: string } };
    expect(envelope.error.code).toBe('usage_error');
  });
});

describe('monday item history — parse-failure surface', () => {
  it('emits internal_error when activity_logs shape drifts', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: { data: { boards: 'not-an-array' } },
        },
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as {
      error: { code: string; message: string; details: { hint: string } };
    };
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/activity_logs/);
  });

  it('emits internal_error when updates shape drifts', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: { boards: [{ id: '67890', activity_logs: [] }] },
          },
        },
        {
          operation_name: 'ItemHistoryUpdates',
          response: { data: { items: 'not-an-array' } },
        },
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stderr) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toMatch(/updates/);
  });
});

describe('monday item history — streaming (--stream / --output ndjson)', () => {
  it('--stream alone forces NDJSON without --output (Codex P1-1)', async () => {
    // The --stream flag must drive NDJSON even when --output isn't
    // passed. Without the explicit override the action falls
    // through to the global output flag (defaults to non-streaming),
    // and the documented `--stream` example silently emits a
    // buffered envelope.
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'update_column_value',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: JSON.stringify({
                        column_id: 'status',
                        column_type: 'status',
                        value: '{}',
                      }),
                    },
                  ],
                },
              ],
            },
          },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--stream'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.length > 0);
    // 1 event + 1 trailer = 2 lines. If --stream were ignored the
    // output would be a single JSON envelope (lines.length === 1
    // with no trailer sentinel).
    expect(lines).toHaveLength(2);
    const trailer = JSON.parse(lines[1]!) as { _meta: { source: string } };
    expect(trailer._meta.source).toBe('live');
  });

  it('emits NDJSON one event per line + §6.3 trailer', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemHistoryActivityLogs',
          response: {
            data: {
              boards: [
                {
                  id: '67890',
                  activity_logs: [
                    {
                      id: 'act-1',
                      event: 'update_column_value',
                      entity: 'pulse',
                      user_id: '99',
                      created_at: '2026-05-10T09:00:00Z',
                      data: JSON.stringify({
                        column_id: 'status',
                        column_type: 'status',
                        value: '{}',
                      }),
                    },
                  ],
                },
              ],
            },
          },
        },
        emptyUpdates,
      ],
    };
    const result = await drive(
      ['item', 'history', '12345', '--output', 'ndjson'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const lines = result.stdout
      .split('\n')
      .filter((line) => line.length > 0);
    // One event + one trailer = 2 lines.
    expect(lines).toHaveLength(2);
    const event = JSON.parse(lines[0]!) as { kind: string; id: string };
    expect(event.kind).toBe('update_column_value');
    expect(event.id).toBe('act-1');
    const trailer = JSON.parse(lines[1]!) as {
      _meta: {
        source: string;
        total_returned: number;
        has_more: boolean;
        complexity: unknown;
      };
    };
    expect(trailer._meta.source).toBe('live');
    expect(trailer._meta.total_returned).toBe(1);
    expect(trailer._meta.has_more).toBe(false);
  });
});

describe('monday item history — envelope contract', () => {
  it('emits the standard §6.1 meta keys', async () => {
    const cassette: Cassette = {
      interactions: [validItemBoardLookup, emptyActivityLogs, emptyUpdates],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout) as {
      meta: {
        schema_version: string;
        api_version: string;
        request_id: string;
        source: string;
        cache_age_seconds: number | null;
        retrieved_at: string;
        complexity: unknown;
      };
    };
    expect(envelope.meta.schema_version).toBe('1');
    expect(envelope.meta.api_version).toBe('2026-01');
    expect(envelope.meta.request_id).toBeTruthy();
    expect(envelope.meta.source).toBe('live');
    expect(envelope.meta.cache_age_seconds).toBe(null);
    expect(envelope.meta.retrieved_at).toBeTruthy();
    expect(envelope.meta).toHaveProperty('complexity');
  });

  it('emits has_more=false + total_returned in the success envelope', async () => {
    const cassette: Cassette = {
      interactions: [validItemBoardLookup, emptyActivityLogs, emptyUpdates],
    };
    const result = await drive(
      ['item', 'history', '12345', '--json'],
      cassette,
    );
    const envelope = JSON.parse(result.stdout) as {
      data: readonly unknown[];
      meta: { has_more: boolean; total_returned: number };
    };
    expect(envelope.data).toEqual([]);
    expect(envelope.meta.has_more).toBe(false);
    expect(envelope.meta.total_returned).toBe(0);
  });

  it('rejects unknown flags via commander argv parse', async () => {
    const cassette: Cassette = { interactions: [] };
    const result = await drive(
      ['item', 'history', '12345', '--unknown-flag', '--json'],
      cassette,
    );
    expect(result.exitCode).toBeGreaterThan(0);
  });
});
