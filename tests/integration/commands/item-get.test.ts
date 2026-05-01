/**
 * Integration tests for `monday item get` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - happy path (projected single-resource envelope)
 *   - not_found
 *   - --api-version reaches the error envelope on HTTP 401
 *   - non-numeric ID rejected as usage_error
 *   - --api-version reaches the usage_error envelope on parseArgv
 *     failure (Codex M4 pass-2 §3 regression).
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { sampleItem, useItemTestEnv } from './_item-fixtures.js';

const { drive } = useItemTestEnv();

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

  it('--api-version reaches the usage_error envelope on parseArgv failure (REGRESSION: Codex M4 pass-2 §3)', async () => {
    // Pass-2 §3: pre-`resolveClient` errors (parseArgv throwing on
    // a bad positional) previously fell back to the SDK pin. The
    // preAction hook in program.ts now commits the resolved
    // `--api-version` before any subcommand action runs.
    const out = await drive(
      ['--api-version', '2026-04', 'item', 'get', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.meta.api_version).toBe('2026-04');
  });
});
