/**
 * Integration tests for `monday item watch <iid>` — drives the
 * runtime polling loop + circuit breaker + per-event NDJSON emit
 * via `FixtureTransport` cassettes (cli-design §14.4 closure;
 * v0.4-plan §3 M29).
 *
 * Tests confirm:
 *   - ItemBoardLookup → repeated ItemWatchPoll wire-call shape.
 *   - Happy single-event / multi-event paths emit one NDJSON record
 *     per emitted event + a final trailer-meta carrying the seven
 *     M29-specific slots flat under `_meta`.
 *   - `--once` drains backlog and exits without polling further.
 *   - `--since <event-id>` looks up the event's `created_at` once,
 *     dedupes the watermark event, and starts the loop from there;
 *     an unknown id surfaces `usage_error`.
 *   - `--max-events` / `--max-duration` ceilings exit cleanly with
 *     the matching `exit_reason`.
 *   - SIGINT (via `ctx.signal.abort`) triggers a graceful drain +
 *     trailer emit + exit 130 + valid NDJSON (no partial JSON line).
 *   - Circuit-breaker trip on 5 consecutive `complexity_exceeded`
 *     wire errors → trailer carries `exit_reason: circuit_broken` +
 *     `circuit_broken_at` + `poll_failed` warnings; stderr emits a
 *     §6.5 failure envelope; exit code 2.
 *   - Circuit-breaker recovery on partial failure → consecutive
 *     counter resets; session continues to its ceiling.
 *   - `--include <kind>` filter narrows emitted events; forward-
 *     compat for v0.5+ comment polling (passing `update_posted`
 *     returns no events at v0.4 since `activity_logs` doesn't
 *     surface comment events).
 *   - Walker-side `entity === 'pulse'` filter drops board-scoped
 *     rows (Decision 2 closure invariant).
 *
 * `--retry 0` is set on every test so the runner's `withRetry`
 * surfaces wire errors directly to the polling loop without its
 * own retry layer interfering with the circuit-breaker progression.
 *
 * Polling cadence is set to the `MIN_WATCH_INTERVAL_MS` floor
 * (1000ms) on multi-poll tests so the cadence-wait completes
 * reasonably fast under real timers; per-test runtime stays under
 * the vitest default test timeout.
 */
import { describe, expect, it } from 'vitest';
import { drive, parseNdjsonStream } from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

type Interaction = Cassette['interactions'][number];

const ITEM_ID = '12345';
const BOARD_ID = '67890';

const validItemBoardLookup: Interaction = {
  operation_name: 'ItemBoardLookup',
  response: {
    data: { items: [{ id: ITEM_ID, board: { id: BOARD_ID } }] },
  },
};

const itemNotFoundLookup: Interaction = {
  operation_name: 'ItemBoardLookup',
  response: {
    data: { items: [] },
  },
};

/**
 * Builds a `boards.activity_logs` watch-poll response carrying the
 * given rows. Each row is shaped per the M24 wire schema (event +
 * entity + user_id + created_at + JSON-encoded `data` payload).
 */
const pollResponse = (
  rows: readonly {
    readonly id: string;
    readonly event?: string;
    readonly entity?: string;
    readonly user_id?: string;
    readonly created_at: string;
    readonly data?: Readonly<Record<string, unknown>>;
  }[],
): Interaction => ({
  operation_name: 'ItemWatchPoll',
  response: {
    data: {
      boards: [
        {
          id: BOARD_ID,
          activity_logs: rows.map((r) => ({
            id: r.id,
            event: r.event ?? 'update_column_value',
            entity: r.entity ?? 'pulse',
            user_id: r.user_id ?? '99',
            created_at: r.created_at,
            data: JSON.stringify(
              r.data ?? {
                column_id: 'status',
                column_type: 'status',
                value: JSON.stringify({ label: 'Done', index: 1 }),
                previous_value: JSON.stringify({
                  label: 'In progress',
                  index: 0,
                }),
                textual_value: 'Done',
                pulse_id: ITEM_ID,
                pulse_name: 'Refactor login',
              },
            ),
          })),
        },
      ],
    },
  },
});

/** Builds a `complexity_exceeded` poll response for circuit-breaker tests. */
const complexityExceededResponse = (): Interaction => ({
  operation_name: 'ItemWatchPoll',
  response: {
    errors: [
      {
        message: 'Complexity budget exhausted',
        extensions: { code: 'ComplexityException', retry_in_seconds: 0 },
      },
    ],
  },
});

/**
 * Verb-specific wrapper around `parseNdjsonStream` that renames
 * `records` → `events` for the item-watch lexicon (every callsite
 * here reads "events") and pins the trailer as non-null since every
 * `item watch` run emits the §6.3 trailer.
 */
const parseStream = (
  stdout: string,
): {
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly trailer: Readonly<Record<string, unknown>>;
} => {
  const { records, trailer } = parseNdjsonStream(stdout);
  expect(trailer).not.toBeNull();
  return { events: records, trailer: trailer! };
};

describe('monday item watch — happy paths', () => {
  it('emits one event + trailer for --once with single-event backlog', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          { id: '1001', created_at: '2026-05-13T10:00:00Z' },
        ]),
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: '1001',
      kind: 'update_column_value',
      column_id: 'status',
    });
    expect(trailer).toMatchObject({
      events_emitted: 1,
      polls_made: 1,
      failed_polls: 0,
      last_seen_event_id: '1001',
      circuit_broken_at: null,
      exit_reason: 'once_complete',
      warnings: [],
      source: 'live',
    });
    expect(trailer.watch_duration_seconds).toEqual(expect.any(Number));
  });

  it('drains multi-event backlog under --once in chronological order', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          // Out-of-order rows; the loop sorts before emit.
          { id: '1003', created_at: '2026-05-13T10:02:00Z' },
          { id: '1001', created_at: '2026-05-13T10:00:00Z' },
          { id: '1002', created_at: '2026-05-13T10:01:00Z' },
        ]),
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['1001', '1002', '1003']);
    expect(trailer).toMatchObject({
      events_emitted: 3,
      polls_made: 1,
      last_seen_event_id: '1003',
      exit_reason: 'once_complete',
    });
  });

  it('exits with --once even on empty backlog', async () => {
    const cassette: Cassette = {
      interactions: [validItemBoardLookup, pollResponse([])],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      polls_made: 1,
      last_seen_event_id: null,
      exit_reason: 'once_complete',
    });
  });

  it('drops board-scoped events at the walker-side entity filter', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          // Item-scoped: kept.
          {
            id: '1001',
            entity: 'pulse',
            created_at: '2026-05-13T10:00:00Z',
          },
          // Board-scoped: dropped at the walker (entity !== 'pulse').
          {
            id: '1002',
            entity: 'board',
            event: 'create_column',
            created_at: '2026-05-13T10:01:00Z',
            data: {},
          },
        ]),
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['1001']);
    expect(trailer).toMatchObject({ events_emitted: 1 });
  });
});

describe('monday item watch — multi-poll with --max-events ceiling', () => {
  it('exits with max_events after the ceiling fires mid-poll', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // First poll returns 2 events.
        pollResponse([
          { id: '2001', created_at: '2026-05-13T10:00:00Z' },
          { id: '2002', created_at: '2026-05-13T10:00:30Z' },
        ]),
        // Second poll would return 5 more, but ceiling fires after 3.
        pollResponse([
          { id: '2003', created_at: '2026-05-13T10:01:00Z' },
          { id: '2004', created_at: '2026-05-13T10:01:30Z' },
          { id: '2005', created_at: '2026-05-13T10:02:00Z' },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
        '--max-events',
        '3',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['2001', '2002', '2003']);
    expect(trailer).toMatchObject({
      events_emitted: 3,
      polls_made: 2,
      last_seen_event_id: '2003',
      exit_reason: 'max_events',
    });
  });
});

describe('monday item watch — --since <event-id>', () => {
  it('resolves the watermark + dedupes the bootstrap event', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // First poll = the bootstrap lookup (limit:500 from epoch);
        // returns the --since event so the watermark resolves.
        {
          ...pollResponse([
            { id: '500', created_at: '2026-05-13T09:00:00Z' },
            { id: '501', created_at: '2026-05-13T09:30:00Z' },
          ]),
          match_variables: {
            from: '1970-01-01T00:00:00Z',
            limit: 500,
          },
        },
        // Second poll fires from the watermark; --once with --since
        // uses the resolved bootstrap created_at + limit:500.
        {
          ...pollResponse([
            { id: '501', created_at: '2026-05-13T09:30:00Z' }, // dup — drops
            { id: '502', created_at: '2026-05-13T10:00:00Z' }, // new
          ]),
          match_variables: {
            from: '2026-05-13T09:30:00Z',
            limit: 500,
          },
        },
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--since',
        '501',
        '--once',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['502']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      last_seen_event_id: '502',
      exit_reason: 'once_complete',
    });
  });

  it('surfaces usage_error when --since id is not in the recent window', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          { id: '500', created_at: '2026-05-13T09:00:00Z' },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--since',
        '99999',
        '--once',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(1);
    const errorEnvelope = JSON.parse(result.stderr) as {
      readonly ok: boolean;
      readonly error: { readonly code: string; readonly details: unknown };
    };
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe('usage_error');
    expect(errorEnvelope.error.details).toMatchObject({
      since_event_id: '99999',
    });
  });
});

describe('monday item watch — --include filter', () => {
  it('narrows emitted events to listed kinds', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          // update_column_value (item-scoped, retained)
          {
            id: '3001',
            entity: 'pulse',
            event: 'update_column_value',
            created_at: '2026-05-13T10:00:00Z',
          },
          // Unknown event (entity=pulse, event=foo) — projects to
          // `kind: 'unknown'`; filter drops because not in --include.
          {
            id: '3002',
            entity: 'pulse',
            event: 'something_unknown',
            created_at: '2026-05-13T10:01:00Z',
            data: {},
          },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--once',
        '--include',
        'update_column_value',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['3001']);
    expect(trailer).toMatchObject({ events_emitted: 1 });
    // unknown_event_kind warning still accumulates even when the
    // filter drops the unknown event — agents see the projector
    // coverage gap regardless of their --include selection.
    const warnings = trailer.warnings as readonly { code: string }[];
    expect(warnings.some((w) => w.code === 'unknown_event_kind')).toBe(true);
  });

  it('returns no events when --include is forward-compat update_posted (no comment polling at v0.4)', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          {
            id: '3001',
            event: 'update_column_value',
            created_at: '2026-05-13T10:00:00Z',
          },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--once',
        '--include',
        'update_posted',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      polls_made: 1,
      exit_reason: 'once_complete',
    });
  });
});

describe('monday item watch — circuit breaker', () => {
  it('trips after 5 consecutive complexity_exceeded polls', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // 5 consecutive complexity_exceeded; the 5th trips.
        { ...complexityExceededResponse(), repeat: 5 },
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
      ],
      cassette,
    );
    // Failure envelope on stderr; exit code 2 per
    // exitCodeForError(complexity_exceeded).
    expect(result.exitCode).toBe(2);
    const errorEnvelope = JSON.parse(result.stderr) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(errorEnvelope.ok).toBe(false);
    expect(errorEnvelope.error.code).toBe('complexity_exceeded');
    // Trailer still emits on stdout BEFORE the failure envelope —
    // agents see the seven M29 slots + accumulated poll_failed
    // warnings.
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      polls_made: 0,
      failed_polls: 5,
      exit_reason: 'circuit_broken',
    });
    expect(trailer.circuit_broken_at).toEqual(expect.any(String));
    const warnings = trailer.warnings as readonly {
      readonly code: string;
      readonly details: Readonly<Record<string, unknown>>;
    }[];
    // 5 poll_failed + 1 circuit_breaker_armed (fired at 4th
    // consecutive failure).
    const pollFailed = warnings.filter((w) => w.code === 'poll_failed');
    const armed = warnings.filter((w) => w.code === 'circuit_breaker_armed');
    expect(pollFailed).toHaveLength(5);
    expect(armed).toHaveLength(1);
    expect(pollFailed[0]?.details).toMatchObject({
      monday_code: 'complexity_exceeded',
      consecutive_failures: 1,
    });
  });

  it('resets consecutive counter on a successful poll between failures', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // 3 fails → success → ceiling fires.
        { ...complexityExceededResponse(), repeat: 3 },
        pollResponse([
          { id: '4001', created_at: '2026-05-13T10:00:00Z' },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
        '--max-events',
        '1',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['4001']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      polls_made: 1,
      failed_polls: 3,
      exit_reason: 'max_events',
    });
    const warnings = trailer.warnings as readonly { code: string }[];
    // 3 poll_failed warnings stick on the trailer (circuit recovery
    // doesn't drop them — agents see the session health history).
    expect(warnings.filter((w) => w.code === 'poll_failed')).toHaveLength(3);
    // No circuit_breaker_armed since we never reached 4 consecutive.
    expect(warnings.filter((w) => w.code === 'circuit_breaker_armed')).toHaveLength(0);
  });
});

describe('monday item watch — SIGINT graceful drain', () => {
  it('emits trailer + exits 130 when the signal aborts mid-cadence', async () => {
    const ctrl = new AbortController();
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // One successful poll; then the signal fires during the
        // cadence wait so no second poll consumed.
        pollResponse([
          { id: '5001', created_at: '2026-05-13T10:00:00Z' },
        ]),
      ],
    };
    // Schedule an abort shortly after the first poll completes so
    // the loop hits the cadence wait and exits via the signal-race.
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 50);
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
      ],
      cassette,
      { signal: ctrl.signal },
    );
    // SIGINT exit per cli-design §7 — no envelope on stderr; the
    // exit code IS the signal. Trailer still emitted on stdout
    // before the abort surfaced.
    expect(result.exitCode).toBe(130);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['5001']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      polls_made: 1,
      failed_polls: 0,
      last_seen_event_id: '5001',
      exit_reason: 'signal',
    });
  });
});

describe('monday item watch — item-board lookup', () => {
  it('surfaces not_found when the item-board lookup misses', async () => {
    const cassette: Cassette = {
      interactions: [itemNotFoundLookup],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    // Item-board lookup short-circuits before any poll fires.
    expect(result.exitCode).toBe(2);
    const errorEnvelope = JSON.parse(result.stderr) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(errorEnvelope.error.code).toBe('not_found');
  });
});

describe('monday item watch — --max-duration ceiling', () => {
  it('exits with max_duration after the wall-clock ceiling fires at loop-top', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // First poll completes — empty rows, no ceiling fires yet.
        pollResponse([]),
        // Second poll never fires; the loop-top max-duration check
        // catches the elapsed >= 1s after the cadence wait.
        pollResponse([
          { id: '8001', created_at: '2026-05-13T10:00:00Z' },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
        '--max-duration',
        '1',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      polls_made: 1,
      exit_reason: 'max_duration',
    });
  }, 10000);
});

describe('monday item watch — non-circuit-breaker errors propagate', () => {
  it('propagates a non-rate-limit ApiError mid-poll (validation_failed → failure envelope)', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          operation_name: 'ItemWatchPoll',
          response: {
            errors: [
              {
                message: 'Argument missing',
                extensions: { code: 'INVALID_ARGUMENT' },
              },
            ],
          },
        },
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    // Non-rate-limit errors bypass the circuit breaker — propagate
    // straight to the runner, which emits a §6.5 failure envelope.
    // No trailer on stdout (the session never reached the trailer-
    // emit site).
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    const errorEnvelope = JSON.parse(result.stderr) as {
      readonly ok: boolean;
      readonly error: { readonly code: string };
    };
    expect(errorEnvelope.ok).toBe(false);
    // Monday's INVALID_ARGUMENT maps to validation_failed via the
    // error mapper.
    expect(errorEnvelope.error.code).toBe('validation_failed');
  });
});

describe('monday item watch — unknown event aggregation', () => {
  it('sorts unknown-event-kind warnings deterministically by event name', async () => {
    // Two distinct unknown kinds in one poll. The accumulator sorts
    // ascending by event so re-walks against the same stream produce
    // identical trailers.
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          {
            id: '7001',
            entity: 'pulse',
            event: 'zebra_event',
            created_at: '2026-05-13T10:00:00Z',
            data: {},
          },
          {
            id: '7002',
            entity: 'pulse',
            event: 'alpha_event',
            created_at: '2026-05-13T10:01:00Z',
            data: {},
          },
        ]),
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { trailer } = parseStream(result.stdout);
    const warnings = trailer.warnings as readonly {
      readonly code: string;
      readonly details: { readonly event: string };
    }[];
    const unknownWarnings = warnings.filter(
      (w) => w.code === 'unknown_event_kind',
    );
    expect(unknownWarnings).toHaveLength(2);
    expect(unknownWarnings.map((w) => w.details.event)).toEqual([
      'alpha_event',
      'zebra_event',
    ]);
  });

  it('aggregates repeated unknown event kinds into one warning with occurrence_count', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        pollResponse([
          // Two rows with the same unknown event name; both have
          // entity=pulse so the walker keeps them. They share a
          // `created_at` so the BigInt-id tie-break fires.
          {
            id: '6001',
            entity: 'pulse',
            event: 'mystery_event',
            created_at: '2026-05-13T10:00:00Z',
            data: {},
          },
          {
            id: '6002',
            entity: 'pulse',
            event: 'mystery_event',
            created_at: '2026-05-13T10:00:00Z',
            data: {},
          },
        ]),
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    // Both rows emit (no --include filter); both project to
    // kind=unknown carrying the raw event name.
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.kind === 'unknown')).toBe(true);
    // Tie-broken by BigInt id — 6001 sorts before 6002.
    expect(events.map((e) => e.id)).toEqual(['6001', '6002']);
    const warnings = trailer.warnings as readonly {
      readonly code: string;
      readonly details: { readonly occurrence_count: number; readonly event: string };
    }[];
    const unknownWarnings = warnings.filter((w) => w.code === 'unknown_event_kind');
    expect(unknownWarnings).toHaveLength(1);
    expect(unknownWarnings[0]?.details).toMatchObject({
      event: 'mystery_event',
      occurrence_count: 2,
    });
  });
});

describe('monday item watch — codex impl review round-1 regression coverage', () => {
  it('P1-1 (polling loop): SIGINT mid in-flight poll emits signal trailer', async () => {
    const ctrl = new AbortController();
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // First poll completes immediately so we enter the polling
        // loop's cadence wait, then the second poll delays long
        // enough for the abort to fire mid-fetch.
        pollResponse([
          { id: '10001', created_at: '2026-05-13T10:00:00Z' },
        ]),
        { ...pollResponse([]), delay_ms: 500 },
      ],
    };
    // Fire the abort during the SECOND poll's delay window (after
    // 1s cadence + ~50ms into the 500ms delay).
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 1100);
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
      ],
      cassette,
      { signal: ctrl.signal },
    );
    expect(result.exitCode).toBe(130);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['10001']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      exit_reason: 'signal',
    });
  }, 5000);

  it('P1-1 (--since lookup): SIGINT mid-bootstrap emits signal trailer', async () => {
    const ctrl = new AbortController();
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // `--since` bootstrap poll delays long enough for the abort
        // to fire mid-fetch; the catch in the `resolveSinceWatermark`
        // wrapper recognizes the abort and exits signal cleanly
        // rather than rethrowing past the trailer-emit site.
        { ...pollResponse([]), delay_ms: 200 },
      ],
    };
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 50);
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--since',
        '999',
        '--once',
      ],
      cassette,
      { signal: ctrl.signal },
    );
    expect(result.exitCode).toBe(130);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      exit_reason: 'signal',
    });
  });

  it('P1-1: SIGINT mid-once-poll emits a signal trailer (not a rethrow)', async () => {
    const ctrl = new AbortController();
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // Poll delays long enough for the test's abort to fire
        // mid-flight; the transport's abort wrap surfaces as a
        // non-circuit-breaker error which the catch handler must
        // recognize via `isAborted()` and exit signal.
        { ...pollResponse([]), delay_ms: 200 },
      ],
    };
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 50);
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
      { signal: ctrl.signal },
    );
    expect(result.exitCode).toBe(130);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      exit_reason: 'signal',
    });
  });

  it('P1-2: `--once` without `--since` drains the most-recent backlog (from epoch, not session start)', async () => {
    // Pins the wire variables via `match_variables`: the cassette
    // refuses to consume an `ItemWatchPoll` request whose `from`
    // isn't the epoch floor (catching the regression where it was
    // session-start and the recent backlog would be hidden).
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        {
          ...pollResponse([
            // Event predates session-start — would be excluded if
            // `--once` used `from: sessionStartIso` (the bug).
            { id: '9001', created_at: '2020-01-01T00:00:00Z' },
          ]),
          match_variables: {
            from: '1970-01-01T00:00:00Z',
            limit: 100,
          },
        },
      ],
    };
    const result = await drive(
      ['--retry', '0', 'item', 'watch', ITEM_ID, '--once'],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['9001']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      exit_reason: 'once_complete',
    });
  });

  it('P2-1: `--since` with a same-timestamp tuple skips events with id <= the boundary', async () => {
    const cassette: Cassette = {
      interactions: [
        validItemBoardLookup,
        // Bootstrap window: contains the --since event id=500 with
        // a tied timestamp neighbour (id=499) and a later neighbour
        // (id=501).
        pollResponse([
          { id: '499', created_at: '2026-05-13T09:00:00Z' },
          { id: '500', created_at: '2026-05-13T09:00:00Z' },
          { id: '501', created_at: '2026-05-13T09:00:00Z' },
        ]),
        // `--once` follow-up poll returns the same tuple; the
        // since-boundary skip drops 499 (id < 500) and 500 (id ==
        // bound, in seenEventIds) but admits 501 (id > 500).
        pollResponse([
          { id: '499', created_at: '2026-05-13T09:00:00Z' },
          { id: '500', created_at: '2026-05-13T09:00:00Z' },
          { id: '501', created_at: '2026-05-13T09:00:00Z' },
        ]),
      ],
    };
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--since',
        '500',
        '--once',
      ],
      cassette,
    );
    expect(result.exitCode).toBe(0);
    const { events, trailer } = parseStream(result.stdout);
    expect(events.map((e) => e.id)).toEqual(['501']);
    expect(trailer).toMatchObject({
      events_emitted: 1,
      last_seen_event_id: '501',
    });
  });
});

describe('monday item watch — abort during backoff', () => {
  it('exits with signal when the abort fires during a circuit-breaker backoff sleep', async () => {
    const ctrl = new AbortController();
    // Use a non-zero retry_in_seconds so the backoff is long enough
    // for the test's abort to fire mid-sleep.
    const slowBackoffPoll: Interaction = {
      operation_name: 'ItemWatchPoll',
      response: {
        errors: [
          {
            message: 'Complexity budget exhausted',
            extensions: {
              code: 'ComplexityException',
              retry_in_seconds: 10,
            },
          },
        ],
      },
    };
    const cassette: Cassette = {
      interactions: [validItemBoardLookup, slowBackoffPoll],
    };
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 50);
    const result = await drive(
      [
        '--retry',
        '0',
        'item',
        'watch',
        ITEM_ID,
        '--interval',
        '1000',
      ],
      cassette,
      { signal: ctrl.signal },
    );
    // SIGINT exit; trailer still emits before the abort surfaces.
    expect(result.exitCode).toBe(130);
    const { events, trailer } = parseStream(result.stdout);
    expect(events).toEqual([]);
    expect(trailer).toMatchObject({
      events_emitted: 0,
      polls_made: 0,
      failed_polls: 1,
      exit_reason: 'signal',
    });
    const warnings = trailer.warnings as readonly { code: string }[];
    expect(warnings.filter((w) => w.code === 'poll_failed')).toHaveLength(1);
  });
});
