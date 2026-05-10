/**
 * Integration tests for `monday item time-track start / stop` (v0.3
 * M20). Documentation-only verbs at v0.3 — empirical probe (2026-05-10,
 * API version 2026-01) confirmed Monday's public API does not
 * currently support time_tracking column writes; the verbs ship
 * with `usage_error` rejections so the CLI surface is stable when
 * Monday eventually ships API support.
 *
 * Coverage:
 *
 *   - `--board` supplied → no `ItemBoardLookup` fires; verb rejects
 *     with `usage_error` and the documented hint.
 *   - `--board` omitted → `ItemBoardLookup` fires for `not_found`
 *     surface preservation; verb rejects with `usage_error` after
 *     the resolution succeeds.
 *   - invalid item ID with no `--board` → `ItemBoardLookup` returns
 *     empty; envelope surfaces `not_found` (not `usage_error` —
 *     resolution preceded the rejection).
 *   - non-numeric item ID → `usage_error` at the parse boundary.
 *   - both verbs (start + stop) emit envelopes with the same
 *     hint string.
 *   - token redaction across all error envelopes.
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  LEAK_CANARY,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { useItemTestEnv } from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item time-track start (integration, M20)', () => {
  it('--board supplied — rejects with usage_error citing the API limitation, no wire call fires', async () => {
    const out = await drive(
      [
        'item',
        'time-track',
        'start',
        '12345',
        '--column',
        'duration',
        '--board',
        '111',
        '--json',
      ],
      // No `ItemBoardLookup` cassette: the explicit --board skips it
      // (cli-design §5.3 step 1). The api primitive throws before
      // any wire call would fire.
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        message: string;
        details?: {
          board_id?: string;
          item_id?: string;
          column_id?: string;
          hint?: string;
        };
      };
    };
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/monday item time-track start/u);
    expect(env.error?.message).toMatch(/forward-compatibility/u);
    expect(env.error?.details?.board_id).toBe('111');
    expect(env.error?.details?.item_id).toBe('12345');
    expect(env.error?.details?.column_id).toBe('duration');
    expect(env.error?.details?.hint).toMatch(/2026-05-10/u);
    expect(env.error?.details?.hint).toMatch(/CorrectedValueException/u);
    expect(env.error?.details?.hint).toMatch(/InvalidColumnTypeException/u);
    // No wire call fired — meta.source should reflect that.
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('--board omitted — ItemBoardLookup fires for not_found surface preservation, then verb rejects with usage_error', async () => {
    const out = await drive(
      [
        'item',
        'time-track',
        'start',
        '12345',
        '--column',
        'duration',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            match_variables: { ids: ['12345'] },
            response: {
              data: { items: [{ id: '12345', board: { id: '111' } }] },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    // Lookup resolved the board → it surfaces in details.
    const details = env.error?.details as { board_id?: string };
    expect(details.board_id).toBe('111');
  });

  it('invalid item ID with no --board — ItemBoardLookup returns empty, envelope surfaces not_found (not usage_error)', async () => {
    const out = await drive(
      ['item', 'time-track', 'start', '99999', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemBoardLookup',
            match_variables: { ids: ['99999'] },
            response: { data: { items: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    expect(out.requests).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
    // The verb's usage_error never fires — the resolution failure
    // takes precedence and the agent sees the standard not_found
    // surface (mirrors item set / item clear / item archive).
    const details = env.error?.details as { item_id?: string };
    expect(details.item_id).toBe('99999');
  });

  it('non-numeric item ID — parse-boundary usage_error', async () => {
    const out = await drive(
      ['item', 'time-track', 'start', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--column omitted — empty columnId echoes verbatim into details (forward-compat: future implementation will resolve from board metadata)', async () => {
    const out = await drive(
      ['item', 'time-track', 'start', '12345', '--board', '111', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    const details = env.error?.details as { column_id?: string };
    expect(details.column_id).toBe('');
  });

  it('token redaction — canary absent across the usage_error envelope', async () => {
    const out = await drive(
      [
        'item',
        'time-track',
        'start',
        '12345',
        '--column',
        'duration',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.stdout).not.toContain(LEAK_CANARY);
    expect(out.stderr).not.toContain(LEAK_CANARY);
  });
});

describe('monday item time-track stop (integration, M20)', () => {
  it('--board supplied — rejects with usage_error citing the stop verb (not start)', async () => {
    const out = await drive(
      [
        'item',
        'time-track',
        'stop',
        '12345',
        '--column',
        'duration',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error?.message).toMatch(/monday item time-track stop/u);
    // Reciprocal: stop's message does NOT mention start.
    expect(env.error?.message).not.toMatch(/time-track start/u);
  });

  it('shares the same API_UNSUPPORTED_HINT as start', async () => {
    const startOut = await drive(
      [
        'item',
        'time-track',
        'start',
        '12345',
        '--column',
        'duration',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    const stopOut = await drive(
      [
        'item',
        'time-track',
        'stop',
        '12345',
        '--column',
        'duration',
        '--board',
        '111',
        '--json',
      ],
      { interactions: [] },
    );
    const startEnv = parseEnvelope(startOut.stderr);
    const stopEnv = parseEnvelope(stopOut.stderr);
    const startHint = (startEnv.error?.details as { hint?: string }).hint;
    const stopHint = (stopEnv.error?.details as { hint?: string }).hint;
    expect(startHint).toBeDefined();
    expect(stopHint).toBe(startHint);
  });
});
