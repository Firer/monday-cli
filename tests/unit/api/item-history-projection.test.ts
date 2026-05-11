/**
 * Surface tests for `src/api/item-history-projection.ts` — the
 * v0.3-M24 runtime body for the two-source merged item-history
 * walker (cli-design §13 v0.3 entry; Decision 2 closure
 * `a1f3025`).
 *
 * Scope: GraphQL document constants + schemas + pure helpers
 * (`mergeByCreatedAt`, `buildUnknownEventKindWarning`,
 * `toEnvelopeWarnings`) + per-row projectors
 * (`projectActivityLogRow`, `projectUpdateRow`, `projectReplyRow`)
 * + the runtime `fetchItemHistory` two-source walker driven via a
 * seam-injected `MondayClient` stub (mock-at-the-network-boundary
 * per testing.md; R-NEW-20 3rd consumer trigger).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ACTIVITY_LOGS_QUERY,
  DEFAULT_HISTORY_PAGE_SIZE,
  HARD_CAP_HISTORY_PAGE_SIZE,
  ITEM_SCOPED_ENTITY,
  UPDATES_QUERY,
  buildUnknownEventKindWarning,
  fetchItemHistory,
  historyEventSchema,
  mergeByCreatedAt,
  projectActivityLogRow,
  projectReplyRow,
  projectUpdateRow,
  rawActivityLogRowSchema,
  rawReplyRowSchema,
  rawUpdateRowSchema,
  toEnvelopeWarnings,
  unknownEventKindWarningSchema,
  type HistoryEvent,
} from '../../../src/api/item-history-projection.js';
import { ApiError } from '../../../src/utils/errors.js';
import type {
  MondayClient,
  MondayResponse,
} from '../../../src/api/client.js';
import type { Complexity } from '../../../src/utils/output/envelope.js';
import { ItemIdSchema, type ItemId } from '../../../src/types/ids.js';

const iid = (n: string): ItemId => ItemIdSchema.parse(n);

describe('ITEM_SCOPED_ENTITY', () => {
  it('pins the literal "pulse" string per Decision 2 closure', () => {
    expect(ITEM_SCOPED_ENTITY).toBe('pulse');
  });
});

describe('page-size constants', () => {
  it('pins default at 100 per Monday\'s per-call ceiling heuristic', () => {
    expect(DEFAULT_HISTORY_PAGE_SIZE).toBe(100);
  });

  it('pins hard cap at Monday\'s documented 10000 ceiling', () => {
    expect(HARD_CAP_HISTORY_PAGE_SIZE).toBe(10_000);
  });

  it('default is strictly less than hard cap', () => {
    expect(DEFAULT_HISTORY_PAGE_SIZE).toBeLessThan(HARD_CAP_HISTORY_PAGE_SIZE);
  });
});

describe('ACTIVITY_LOGS_QUERY', () => {
  it('selects every load-bearing ActivityLogType field per Decision 2', () => {
    // The empirical-probe introspection captured 7 NON_NULL String
    // fields; the projector reads 6 of them (account_id carries
    // no item-history signal). All 6 must appear in the selection.
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\bid\b/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\bevent\b/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\bentity\b/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\buser_id\b/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\bcreated_at\b/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/\bdata\b/);
  });

  it('threads item_ids + from/to wall-clock filters', () => {
    expect(ACTIVITY_LOGS_QUERY).toMatch(/item_ids:\s*\$iid/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/from:\s*\$from/);
    expect(ACTIVITY_LOGS_QUERY).toMatch(/to:\s*\$to/);
  });

  it('does NOT select complexity unconditionally', () => {
    // MondayClient.raw injects complexity only under --verbose;
    // hard-coding the selection would leak the field outside
    // --verbose, contradicting cli-design §6.1.
    expect(ACTIVITY_LOGS_QUERY).not.toMatch(/complexity/);
  });
});

describe('UPDATES_QUERY', () => {
  it('selects every load-bearing Update + Reply field', () => {
    expect(UPDATES_QUERY).toMatch(/updates\(/);
    expect(UPDATES_QUERY).toMatch(/text_body/);
    expect(UPDATES_QUERY).toMatch(/edited_at/);
    expect(UPDATES_QUERY).toMatch(/replies\s*{/);
    // Reply.kind — separate taxonomy from activity_logs.event per
    // the Decision 2 closure probe finding.
    expect(UPDATES_QUERY).toMatch(/\bkind\b/);
  });

  it('does NOT select complexity unconditionally', () => {
    expect(UPDATES_QUERY).not.toMatch(/complexity/);
  });
});

describe('rawActivityLogRowSchema', () => {
  it('parses a fully-populated row', () => {
    expect(() =>
      rawActivityLogRowSchema.parse({
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: '{}',
      }),
    ).not.toThrow();
  });

  it('rejects empty event slot', () => {
    expect(() =>
      rawActivityLogRowSchema.parse({
        id: 'act-1',
        event: '',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: '{}',
      }),
    ).toThrow();
  });

  it('is loose — additive Monday surface fields pass through', () => {
    expect(() =>
      rawActivityLogRowSchema.parse({
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: '{}',
        future_field: 'whatever',
      }),
    ).not.toThrow();
  });
});

describe('rawUpdateRowSchema', () => {
  it('parses an Update with nullable created_at + non-null edited_at', () => {
    expect(() =>
      rawUpdateRowSchema.parse({
        id: 'upd-1',
        body: 'body',
        text_body: null,
        created_at: null,
        edited_at: '2026-05-10T10:00:00Z',
        creator_id: null,
        replies: null,
      }),
    ).not.toThrow();
  });

  it('parses an Update with replies array', () => {
    expect(() =>
      rawUpdateRowSchema.parse({
        id: 'upd-1',
        body: 'body',
        text_body: 'text',
        created_at: '2026-05-10T09:00:00Z',
        edited_at: '2026-05-10T09:00:00Z',
        creator_id: '99',
        replies: [
          {
            id: 'rep-1',
            body: 'reply body',
            kind: 'reply',
            text_body: null,
            created_at: null,
            updated_at: null,
            creator_id: null,
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe('rawReplyRowSchema', () => {
  it('parses a Reply with NON_NULL kind + nullable timestamps', () => {
    expect(() =>
      rawReplyRowSchema.parse({
        id: 'rep-1',
        body: 'r',
        kind: 'reply',
        text_body: null,
        created_at: null,
        updated_at: null,
        creator_id: null,
      }),
    ).not.toThrow();
  });

  it('rejects empty kind', () => {
    expect(() =>
      rawReplyRowSchema.parse({
        id: 'rep-1',
        body: 'r',
        kind: '',
        text_body: null,
        created_at: null,
        updated_at: null,
        creator_id: null,
      }),
    ).toThrow();
  });
});

describe('historyEventSchema — 9-variant discriminated union', () => {
  it('parses an update_column_value event', () => {
    expect(() =>
      historyEventSchema.parse({
        id: 'act-1',
        created_at: '2026-05-10T09:00:00Z',
        actor_id: '99',
        kind: 'update_column_value',
        column_id: 'status',
        column_type: 'status',
        before: { id: 0 },
        after: { id: 2 },
        textual_value: 'Working on it',
        pulse_id: '1234',
        pulse_name: 'Refactor login',
      }),
    ).not.toThrow();
  });

  it('parses an update_posted event', () => {
    expect(() =>
      historyEventSchema.parse({
        id: 'upd-1',
        created_at: '2026-05-10T10:00:00Z',
        actor_id: '99',
        kind: 'update_posted',
        before: null,
        after: { body: 'b', text_body: 't', reply_count: 0 },
      }),
    ).not.toThrow();
  });

  it('parses an update_replied event with parent_update_id + reply_kind', () => {
    expect(() =>
      historyEventSchema.parse({
        id: 'rep-1',
        created_at: '2026-05-10T11:00:00Z',
        actor_id: '99',
        kind: 'update_replied',
        parent_update_id: 'upd-1',
        reply_kind: 'reply',
        before: null,
        after: { body: 'r', text_body: 'rt' },
      }),
    ).not.toThrow();
  });

  it('parses an unknown fallback event', () => {
    expect(() =>
      historyEventSchema.parse({
        id: 'act-1',
        created_at: '2026-05-10T09:00:00Z',
        actor_id: '99',
        kind: 'unknown',
        event: 'future_event_kind',
        entity: 'pulse',
        before: null,
        after: { raw: true },
      }),
    ).not.toThrow();
  });

  it('parses every board-scoped variant (defensive parser-roundtrip)', () => {
    const boardScopedKinds = [
      'create_column',
      'create_group',
      'update_board_name',
      'update_board_nickname',
      'board_workspace_id_changed',
    ] as const;
    for (const kind of boardScopedKinds) {
      expect(() =>
        historyEventSchema.parse({
          id: 'act-1',
          created_at: '2026-05-10T09:00:00Z',
          actor_id: '99',
          kind,
          before: null,
          after: { foo: 'bar' },
        }),
      ).not.toThrow();
    }
  });

  it('rejects unknown kind discriminator values', () => {
    expect(() =>
      historyEventSchema.parse({
        id: 'act-1',
        created_at: '2026-05-10T09:00:00Z',
        actor_id: '99',
        kind: 'something_else',
        before: null,
        after: null,
      }),
    ).toThrow();
  });
});

describe('buildUnknownEventKindWarning', () => {
  it('builds the §6.1 warning shape with occurrence_count', () => {
    const w = buildUnknownEventKindWarning('future_kind', 'pulse', 3);
    expect(w.code).toBe('unknown_event_kind');
    expect(w.details.event).toBe('future_kind');
    expect(w.details.entity).toBe('pulse');
    expect(w.details.occurrence_count).toBe(3);
    expect(w.message).toMatch(/3 rows/);
  });

  it('uses singular "row" when occurrence_count is 1', () => {
    const w = buildUnknownEventKindWarning('future_kind', 'pulse', 1);
    expect(w.message).toMatch(/1 row/);
    expect(w.message).not.toMatch(/rows/);
  });

  it('hint forward-references the extension point', () => {
    const w = buildUnknownEventKindWarning('x', 'y', 1);
    expect(w.details.hint).toMatch(/historyEventSchema|unknown/);
  });

  it('parses against the warning schema', () => {
    const w = buildUnknownEventKindWarning('future_kind', 'pulse', 1);
    expect(() => unknownEventKindWarningSchema.parse(w)).not.toThrow();
  });
});

describe('mergeByCreatedAt', () => {
  const ev = (
    id: string,
    createdAt: string,
    kind: HistoryEvent['kind'] = 'update_posted',
  ): HistoryEvent =>
    kind === 'update_posted'
      ? {
          id,
          created_at: createdAt,
          actor_id: null,
          kind: 'update_posted',
          before: null,
          after: { body: '', text_body: null, reply_count: 0 },
        }
      : {
          id,
          created_at: createdAt,
          actor_id: null,
          kind: 'unknown',
          event: 'x',
          entity: 'pulse',
          before: null,
          after: {},
        };

  it('merges + sorts by created_at ascending', () => {
    const a = [ev('a', '2026-05-10T09:00:00Z'), ev('c', '2026-05-10T11:00:00Z')];
    const b = [ev('b', '2026-05-10T10:00:00Z')];
    expect(mergeByCreatedAt(a, b).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks ties lexicographically by id', () => {
    const a = [ev('b', '2026-05-10T09:00:00Z'), ev('a', '2026-05-10T09:00:00Z')];
    expect(mergeByCreatedAt(a, []).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('handles equal id (theoretical edge — same source returns same id)', () => {
    const a = [ev('x', '2026-05-10T09:00:00Z')];
    const b = [ev('x', '2026-05-10T09:00:00Z')];
    // Both entries preserved; merge is stable on equal keys.
    expect(mergeByCreatedAt(a, b)).toHaveLength(2);
  });

  it('returns empty on empty inputs', () => {
    expect(mergeByCreatedAt([], [])).toEqual([]);
  });

  it('does not mutate inputs', () => {
    const a = [ev('a', '2026-05-10T09:00:00Z')];
    const b = [ev('b', '2026-05-10T10:00:00Z')];
    const beforeA = a.map((e) => e.id);
    const beforeB = b.map((e) => e.id);
    mergeByCreatedAt(a, b);
    expect(a.map((e) => e.id)).toEqual(beforeA);
    expect(b.map((e) => e.id)).toEqual(beforeB);
  });
});

describe('projectActivityLogRow — update_column_value variant', () => {
  it('projects a status edit with structured before/after via nested-JSON unwrap', () => {
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        // Monday encodes value / previous_value as JSON strings
        // inside the outer data payload; projector unwraps one level.
        data: JSON.stringify({
          column_id: 'status',
          column_type: 'status',
          value: JSON.stringify({ label: 'Done', index: 1 }),
          previous_value: JSON.stringify({ label: 'Working on it', index: 0 }),
          textual_value: 'Done',
          pulse_id: '1234',
          pulse_name: 'Refactor login',
        }),
      },
    });
    expect(result).toMatchObject({
      id: 'act-1',
      kind: 'update_column_value',
      column_id: 'status',
      column_type: 'status',
      before: { label: 'Working on it', index: 0 },
      after: { label: 'Done', index: 1 },
      textual_value: 'Done',
      pulse_id: '1234',
      pulse_name: 'Refactor login',
      actor_id: '99',
    });
  });

  it('preserves empty-object previous_value as "previously-unset" shape', () => {
    // Decision 2 closure: previous_value === {} on first-set events
    // must be preserved (not collapsed to null) so agents can
    // distinguish "first set" from "no prior value tracked".
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: JSON.stringify({
          column_id: 'status',
          column_type: 'status',
          value: JSON.stringify({ label: 'Done', index: 1 }),
          previous_value: '{}',
          textual_value: 'Done',
          pulse_id: '1234',
          pulse_name: 'Refactor login',
        }),
      },
    });
    expect(result.kind).toBe('update_column_value');
    if (result.kind === 'update_column_value') {
      expect(result.before).toEqual({});
      expect(result.after).toEqual({ label: 'Done', index: 1 });
    }
  });

  it('preserves a date-typed payload as ISO string', () => {
    const result = projectActivityLogRow({
      row: {
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
          pulse_id: '1234',
          pulse_name: 'Refactor login',
        }),
      },
    });
    expect(result.kind).toBe('update_column_value');
    if (result.kind === 'update_column_value') {
      // Raw non-JSON strings pass through unchanged.
      expect(result.before).toBe('2026-05-01');
      expect(result.after).toBe('2026-06-01');
    }
  });

  it('handles nullable pulse_id / pulse_name / textual_value', () => {
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: JSON.stringify({
          column_id: 'numbers4',
          column_type: 'numbers',
          value: '42',
          previous_value: null,
        }),
      },
    });
    expect(result.kind).toBe('update_column_value');
    if (result.kind === 'update_column_value') {
      expect(result.textual_value).toBe(null);
      expect(result.pulse_id).toBe(null);
      expect(result.pulse_name).toBe(null);
    }
  });

  it('falls through to unknown variant when column_id / column_type are missing', () => {
    // Defensive: an `update_column_value` event without the
    // discriminator fields routes through the unknown fallback
    // rather than emitting a malformed typed variant.
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'update_column_value',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: '{}',
      },
    });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.event).toBe('update_column_value');
    }
  });
});

describe('projectActivityLogRow — board-scoped variants', () => {
  it.each([
    'create_column',
    'create_group',
    'update_board_name',
    'update_board_nickname',
    'board_workspace_id_changed',
  ] as const)('projects %s with raw payload under after', (eventKind) => {
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: eventKind,
        entity: 'board',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: JSON.stringify({ foo: 'bar' }),
      },
    });
    expect(result.kind).toBe(eventKind);
    if (
      result.kind === 'create_column' ||
      result.kind === 'create_group' ||
      result.kind === 'update_board_name' ||
      result.kind === 'update_board_nickname' ||
      result.kind === 'board_workspace_id_changed'
    ) {
      expect(result.after).toEqual({ foo: 'bar' });
    }
  });
});

describe('projectActivityLogRow — unknown fallback', () => {
  it('routes unrecognised events to the unknown variant with raw event + entity', () => {
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'future_kind_monday_might_ship',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: JSON.stringify({ raw_payload: true }),
      },
    });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.event).toBe('future_kind_monday_might_ship');
      expect(result.entity).toBe('pulse');
      expect(result.before).toBe(null);
      expect(result.after).toEqual({ raw_payload: true });
    }
  });

  it('handles malformed data JSON gracefully', () => {
    // Defensive: a malformed JSON payload still lands in the
    // unknown variant carrying `{raw_data: <string>}` so the
    // diagnostic content survives.
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'unrecognised',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: 'not-valid-json{',
      },
    });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.after).toEqual({ raw_data: 'not-valid-json{' });
    }
  });

  it('handles a non-object parsed data payload (e.g. JSON array)', () => {
    const result = projectActivityLogRow({
      row: {
        id: 'act-1',
        event: 'unrecognised',
        entity: 'pulse',
        user_id: '99',
        created_at: '2026-05-10T09:00:00Z',
        data: '[1, 2, 3]',
      },
    });
    expect(result.kind).toBe('unknown');
    if (result.kind === 'unknown') {
      expect(result.after).toEqual([1, 2, 3]);
    }
  });
});

describe('projectUpdateRow', () => {
  it('emits update_posted + one update_replied per reply', () => {
    const events = projectUpdateRow({
      row: {
        id: 'upd-1',
        body: '<p>Top-level</p>',
        text_body: 'Top-level',
        created_at: '2026-05-10T09:00:00Z',
        edited_at: '2026-05-10T09:00:00Z',
        creator_id: '99',
        replies: [
          {
            id: 'rep-1',
            body: '<p>Reply</p>',
            kind: 'reply',
            text_body: 'Reply',
            created_at: '2026-05-10T09:30:00Z',
            updated_at: '2026-05-10T09:30:00Z',
            creator_id: '88',
          },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe('update_posted');
    expect(events[1]?.kind).toBe('update_replied');
    if (events[0]?.kind === 'update_posted') {
      expect(events[0].after.reply_count).toBe(1);
      expect(events[0].id).toBe('upd-1');
    }
    if (events[1]?.kind === 'update_replied') {
      expect(events[1].parent_update_id).toBe('upd-1');
      expect(events[1].reply_kind).toBe('reply');
    }
  });

  it('substitutes edited_at for a null created_at (silent projection)', () => {
    const events = projectUpdateRow({
      row: {
        id: 'upd-1',
        body: 'b',
        text_body: null,
        created_at: null,
        edited_at: '2026-05-10T10:00:00Z',
        creator_id: null,
        replies: null,
      },
    });
    expect(events[0]?.created_at).toBe('2026-05-10T10:00:00Z');
    expect(events).toHaveLength(1);
  });

  it('treats null replies as empty (reply_count 0)', () => {
    const events = projectUpdateRow({
      row: {
        id: 'upd-1',
        body: 'b',
        text_body: null,
        created_at: '2026-05-10T09:00:00Z',
        edited_at: '2026-05-10T09:00:00Z',
        creator_id: null,
        replies: null,
      },
    });
    expect(events).toHaveLength(1);
    if (events[0]?.kind === 'update_posted') {
      expect(events[0].after.reply_count).toBe(0);
    }
  });
});

describe('projectReplyRow', () => {
  it('synthesises update_replied with parent_update_id + reply_kind', () => {
    const ev = projectReplyRow({
      row: {
        id: 'rep-1',
        body: 'reply',
        kind: 'reply',
        text_body: 'reply',
        created_at: '2026-05-10T09:30:00Z',
        updated_at: null,
        creator_id: '88',
      },
      parentUpdateId: 'upd-1',
    });
    expect(ev.kind).toBe('update_replied');
    if (ev.kind === 'update_replied') {
      expect(ev.parent_update_id).toBe('upd-1');
      expect(ev.reply_kind).toBe('reply');
      expect(ev.before).toBe(null);
      expect(ev.after.body).toBe('reply');
    }
  });

  it('falls back to updated_at when created_at is null', () => {
    const ev = projectReplyRow({
      row: {
        id: 'rep-1',
        body: 'r',
        kind: 'reply',
        text_body: null,
        created_at: null,
        updated_at: '2026-05-10T11:00:00Z',
        creator_id: null,
      },
      parentUpdateId: 'upd-1',
    });
    expect(ev.created_at).toBe('2026-05-10T11:00:00Z');
  });

  it('substitutes empty string when both timestamps are null (defensive)', () => {
    // Monday's contract pins both Reply.created_at + Reply.updated_at
    // as nullable; both being null on the same Reply isn't observed
    // in production but the projector handles it defensively.
    const ev = projectReplyRow({
      row: {
        id: 'rep-1',
        body: 'r',
        kind: 'reply',
        text_body: null,
        created_at: null,
        updated_at: null,
        creator_id: null,
      },
      parentUpdateId: 'upd-1',
    });
    expect(ev.created_at).toBe('');
  });
});

describe('toEnvelopeWarnings', () => {
  it('returns the input array narrowed to the envelope Warning type', () => {
    const w = buildUnknownEventKindWarning('e', 'pulse', 1);
    const envelopeWarnings = toEnvelopeWarnings([w]);
    expect(envelopeWarnings).toHaveLength(1);
    expect(envelopeWarnings[0]).toBe(w);
  });

  it('preserves empty input', () => {
    expect(toEnvelopeWarnings([])).toEqual([]);
  });
});

/**
 * Builds a seam-injected `MondayClient` stub for walker tests.
 * Routes calls by `operationName` (the typed surface
 * `fetchItemHistory` consumes via `client.raw(query, vars,
 * {operationName})`). R-NEW-20 3rd consumer trigger (after
 * board-favorites + cross-board-search). Decision made: keep
 * stub factory inline this session — same shape as the other
 * two but each carries different variable-routing logic
 * (favorites by op-name, cross-board by boardId variable);
 * lifting now would force a parametrised factory that doesn't
 * meaningfully reduce duplication. Re-evaluate when M27 webhooks
 * brings a 4th consumer.
 */
const buildClientStub = (
  responses: Readonly<Record<string, MondayResponse<unknown>>>,
): {
  client: MondayClient;
  raw: ReturnType<typeof vi.fn>;
} => {
  const raw = vi.fn(
    (
      _query: string,
      _variables: Readonly<Record<string, unknown>> | undefined,
      options: { operationName?: string } = {},
    ): Promise<MondayResponse<unknown>> => {
      const opName = options.operationName ?? '<anon>';
      const response = responses[opName];
      if (response === undefined) {
        return Promise.reject(
          new Error(`buildClientStub: no canned response for ${opName}`),
        );
      }
      return Promise.resolve(response);
    },
  );
  const client = { raw } as unknown as MondayClient;
  return { client, raw };
};

const emptyComplexity = (): Complexity | null => null;
const emptyStats = { attempts: 1, sleeps: [] };

describe('fetchItemHistory — happy path', () => {
  it('runs both stages + merges chronologically + filters board-scoped events walker-side', async () => {
    const { client, raw } = buildClientStub({
      ItemHistoryActivityLogs: {
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
                // Board-scoped — walker filters out via entity check.
                {
                  id: 'act-2',
                  event: 'create_column',
                  entity: 'board',
                  user_id: '99',
                  created_at: '2026-05-10T09:30:00Z',
                  data: '{}',
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: {
          items: [
            {
              id: '12345',
              updates: [
                {
                  id: 'upd-1',
                  body: '<p>Top-level</p>',
                  text_body: 'Top-level',
                  created_at: '2026-05-10T10:00:00Z',
                  edited_at: '2026-05-10T10:00:00Z',
                  creator_id: '99',
                  replies: [],
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(raw).toHaveBeenCalledTimes(2);
    expect(result.events).toHaveLength(2);
    // Chronological order: act-1 (09:00) → upd-1 (10:00). Board-
    // scoped create_column (09:30) was filtered out walker-side.
    expect(result.events.map((e) => e.id)).toEqual(['act-1', 'upd-1']);
    expect(result.warnings).toEqual([]);
    expect(result.source).toBe('live');
  });

  it('threads --since / --until into the activity_logs call', async () => {
    const { client, raw } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-31T23:59:59Z',
    });
    const stage1Vars = raw.mock.calls[0]?.[1] as
      | Readonly<Record<string, unknown>>
      | undefined;
    expect(stage1Vars).toMatchObject({
      bid: ['67890'],
      iid: ['12345'],
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-31T23:59:59Z',
      page: 1,
      limit: DEFAULT_HISTORY_PAGE_SIZE,
    });
  });

  it('omits from / to keys when --since / --until are absent (minimal wire payload)', async () => {
    const { client, raw } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    const stage1Vars = raw.mock.calls[0]?.[1] as Readonly<Record<string, unknown>>;
    expect(stage1Vars).not.toHaveProperty('from');
    expect(stage1Vars).not.toHaveProperty('to');
  });

  it('applies client-side wall-clock filter on Update.created_at', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: {
          items: [
            {
              id: '12345',
              updates: [
                {
                  id: 'upd-too-old',
                  body: 'b',
                  text_body: null,
                  created_at: '2026-04-01T00:00:00Z',
                  edited_at: '2026-04-01T00:00:00Z',
                  creator_id: null,
                  replies: null,
                },
                {
                  id: 'upd-in-range',
                  body: 'b',
                  text_body: null,
                  created_at: '2026-05-15T00:00:00Z',
                  edited_at: '2026-05-15T00:00:00Z',
                  creator_id: null,
                  replies: null,
                },
                {
                  id: 'upd-too-new',
                  body: 'b',
                  text_body: null,
                  created_at: '2026-06-01T00:00:00Z',
                  edited_at: '2026-06-01T00:00:00Z',
                  creator_id: null,
                  replies: null,
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      since: '2026-05-01T00:00:00Z',
      until: '2026-05-31T23:59:59Z',
    });
    expect(result.events.map((e) => e.id)).toEqual(['upd-in-range']);
  });
});

describe('fetchItemHistory — pagination + page-args threading', () => {
  it('threads activityLogsPage + updatesPage independently', async () => {
    const { client, raw } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      activityLogsPage: 3,
      updatesPage: 5,
      limit: 200,
    });
    const stage1Vars = raw.mock.calls[0]?.[1] as Readonly<Record<string, unknown>>;
    const stage2Vars = raw.mock.calls[1]?.[1] as Readonly<Record<string, unknown>>;
    expect(stage1Vars.page).toBe(3);
    expect(stage1Vars.limit).toBe(200);
    expect(stage2Vars.page).toBe(5);
    expect(stage2Vars.limit).toBe(200);
  });

  it('surfaces last_page when stage returned a full slice (more pages likely)', async () => {
    const activityRows = Array.from({ length: 5 }, (_, i) => ({
      id: `act-${String(i)}`,
      event: 'update_column_value',
      entity: 'pulse',
      user_id: '99',
      created_at: `2026-05-10T0${String(i)}:00:00Z`,
      data: JSON.stringify({
        column_id: 'status',
        column_type: 'status',
        value: '{}',
        previous_value: '{}',
      }),
    }));
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [{ id: '67890', activity_logs: activityRows }] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      activityLogsPage: 2,
      limit: 5,
    });
    // A full slice (rows.length === limit) → last_page = current
    // page number ("potentially more pages").
    expect(result.pagination.activity_logs.last_page).toBe(2);
    expect(result.pagination.updates.last_page).toBe(null);
  });

  it('surfaces null last_page when source is exhausted', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
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
                  data: '{}',
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      limit: 100,
    });
    expect(result.pagination.activity_logs.last_page).toBe(null);
    expect(result.pagination.updates.last_page).toBe(null);
  });
});

describe('fetchItemHistory — unknown_event_kind warning aggregation', () => {
  it('aggregates repeated unknown events as one warning with occurrence_count', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
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
                {
                  id: 'act-3',
                  event: 'future_kind',
                  entity: 'pulse',
                  user_id: '99',
                  created_at: '2026-05-10T10:00:00Z',
                  data: '{}',
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.details.event).toBe('future_kind');
    expect(result.warnings[0]?.details.occurrence_count).toBe(3);
  });

  it('emits a separate warning per unique event', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: {
          boards: [
            {
              id: '67890',
              activity_logs: [
                {
                  id: 'act-1',
                  event: 'future_one',
                  entity: 'pulse',
                  user_id: '99',
                  created_at: '2026-05-10T09:00:00Z',
                  data: '{}',
                },
                {
                  id: 'act-2',
                  event: 'future_two',
                  entity: 'pulse',
                  user_id: '99',
                  created_at: '2026-05-10T10:00:00Z',
                  data: '{}',
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.warnings.map((w) => w.details.event)).toEqual([
      'future_one',
      'future_two',
    ]);
  });
});

describe('fetchItemHistory — --kinds filter', () => {
  it('narrows the data array but preserves warnings', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
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
                  created_at: '2026-05-10T09:30:00Z',
                  data: '{}',
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      kinds: ['update_column_value'],
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe('update_column_value');
    // The unknown-event warning still surfaces — filter applies
    // to data, not to warnings.
    expect(result.warnings).toHaveLength(1);
  });
});

describe('fetchItemHistory — streaming hook', () => {
  it('calls onItem per merged event in chronological order', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
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
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: {
          items: [
            {
              id: '12345',
              updates: [
                {
                  id: 'upd-1',
                  body: 'b',
                  text_body: null,
                  created_at: '2026-05-10T10:00:00Z',
                  edited_at: '2026-05-10T10:00:00Z',
                  creator_id: null,
                  replies: null,
                },
              ],
            },
          ],
        },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const seen: string[] = [];
    await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      onItem: (event) => {
        seen.push(event.id);
      },
    });
    expect(seen).toEqual(['act-1', 'upd-1']);
  });

  it('awaits an async onItem hook before emitting the next event', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
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
                  event: 'update_column_value',
                  entity: 'pulse',
                  user_id: '99',
                  created_at: '2026-05-10T09:30:00Z',
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
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const seen: string[] = [];
    await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
      onItem: async (event) => {
        await new Promise<void>((r) => setTimeout(r, 1));
        seen.push(event.id);
      },
    });
    expect(seen).toEqual(['act-1', 'act-2']);
  });
});

describe('fetchItemHistory — complexity propagation', () => {
  it('picks the stage with the lower remaining budget (worst-case snapshot)', async () => {
    const stage1Complexity: Complexity = {
      used: 30,
      remaining: 999_900,
      reset_in_seconds: 60,
    };
    const stage2Complexity: Complexity = {
      used: 80,
      remaining: 999_800, // lower remaining → pick this one
      reset_in_seconds: 60,
    };
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: stage1Complexity,
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: stage2Complexity,
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.complexity).toEqual(stage2Complexity);
  });

  it('falls back to the non-null stage when one is null', async () => {
    const stage2Complexity: Complexity = {
      used: 10,
      remaining: 999_990,
      reset_in_seconds: 60,
    };
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: null,
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: stage2Complexity,
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.complexity).toEqual(stage2Complexity);
  });

  it('returns null when both stages are null', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: null,
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: null,
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.complexity).toBe(null);
  });

  it('picks stage 1 when its remaining is lower than stage 2', async () => {
    const stage1Complexity: Complexity = {
      used: 100,
      remaining: 999_500,
      reset_in_seconds: 60,
    };
    const stage2Complexity: Complexity = {
      used: 10,
      remaining: 999_990,
      reset_in_seconds: 60,
    };
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: stage1Complexity,
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: stage2Complexity,
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.complexity).toEqual(stage1Complexity);
  });

  it('falls back to stage 1 when stage 2 is null', async () => {
    const stage1Complexity: Complexity = {
      used: 30,
      remaining: 999_950,
      reset_in_seconds: 60,
    };
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: stage1Complexity,
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: null,
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.complexity).toEqual(stage1Complexity);
  });
});

describe('fetchItemHistory — defensive nullability', () => {
  it('handles null boards array (defensive forward-compat)', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: null },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });

  it('handles null items array (Stage 2 forward-compat)', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: null },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });

  it('skips null board entries in the boards array (defensive)', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [null] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });

  it('skips null item entries in the items array (defensive)', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [null] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });

  it('treats null activity_logs array as empty', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [{ id: '67890', activity_logs: null }] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });

  it('treats null updates array as empty', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: [{ id: '12345', updates: null }] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    const result = await fetchItemHistory({
      client,
      itemId: iid('12345'),
      boardId: '67890',
    });
    expect(result.events).toEqual([]);
  });
});

describe('fetchItemHistory — parse-failure surface', () => {
  it('surfaces internal_error with details.issues on Stage 1 type mismatch', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: 'not-an-array' },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    await expect(
      fetchItemHistory({
        client,
        itemId: iid('12345'),
        boardId: '67890',
      }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('threads item_id + board_id into the parse-failure details', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: 'not-an-array' },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    try {
      await fetchItemHistory({
        client,
        itemId: iid('12345'),
        boardId: '67890',
      });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('internal_error');
      const details = apiErr.details as {
        item_id: string;
        board_id: string;
        hint: string;
      };
      expect(details.item_id).toBe('12345');
      expect(details.board_id).toBe('67890');
      expect(details.hint).toMatch(/activity_logs|m24-history-kinds/);
    }
  });

  it('surfaces internal_error on Stage 2 type mismatch', async () => {
    const { client } = buildClientStub({
      ItemHistoryActivityLogs: {
        data: { boards: [] },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
      ItemHistoryUpdates: {
        data: { items: 'not-an-array' },
        complexity: emptyComplexity(),
        stats: emptyStats,
      },
    });
    try {
      await fetchItemHistory({
        client,
        itemId: iid('12345'),
        boardId: '67890',
      });
      throw new Error('expected reject');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('internal_error');
      const details = apiErr.details as { hint: string };
      expect(details.hint).toMatch(/updates|m24-history-kinds/);
    }
  });
});
