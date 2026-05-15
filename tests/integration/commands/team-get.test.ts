/**
 * Integration tests for `monday user team-get <tid>` (v0.5-M34 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'GetTeam'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <Team>`
 *   - empty `teams: []` → `not_found` with `details.team_id`
 *   - null `teams` root → `internal_error` (distinct from empty-
 *     array not_found case)
 *   - multi-element response → defensive `internal_error`
 *   - schema drift → `internal_error`
 *   - W4: live source + cache_age_seconds null
 *   - parse-boundary rejection on non-numeric `<teamId>`
 */
import { describe, expect, it } from 'vitest';
import {
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import type { Cassette } from '../../fixtures/load.js';

const wireUser = (id: string) => ({
  id,
  name: `User ${id}`,
  email: `user${id}@example.test`,
});

const wireTeam = (
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> => ({
  id: '11001',
  name: 'Backend Engineering',
  picture_url: null,
  is_guest: false,
  users: [wireUser('67890')],
  owners: [wireUser('67890')],
  ...overrides,
});

describe('monday user team-get (M34)', () => {
  it('happy path: emits the Team directly under data (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetTeam',
          match_variables: { ids: ['11001'] },
          response: { data: { teams: [wireTeam()] } },
        },
      ],
    };
    const out = await drive(['user', 'team-get', '11001', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        id: string;
        name: string;
        users: readonly { id: string }[] | null;
        owners: readonly { id: string }[];
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('11001');
    expect(env.data.name).toBe('Backend Engineering');
    expect(env.data.owners).toHaveLength(1);
    expect(env.meta.source).toBe('live');
    expect(env.meta.cache_age_seconds).toBeNull();
  });

  it('not_found when GetTeam returns teams: [] (D8 — doesn\'t exist OR inaccessible)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetTeam',
          response: { data: { teams: [] } },
        },
      ],
    };
    const out = await drive(['user', 'team-get', '99999', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { team_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.team_id).toBe('99999');
  });

  it('internal_error when GetTeam returns teams: null (wire-shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetTeam',
          response: { data: { teams: null } },
        },
      ],
    };
    const out = await drive(['user', 'team-get', '99999', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { team_id?: string } };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.team_id).toBe('99999');
  });

  it('internal_error on multi-element response (defensive: wire shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetTeam',
          response: { data: { teams: [wireTeam(), wireTeam({ id: '11002' })] } },
        },
      ],
    };
    const out = await drive(['user', 'team-get', '11001', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in the Team row', async () => {
    const { owners: _owners, ...badTeam } = wireTeam();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'GetTeam',
          response: { data: { teams: [badTeam] } },
        },
      ],
    };
    const out = await drive(['user', 'team-get', '11001', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('usage_error rejects non-numeric <teamId> at parse boundary (no wire call fires)', async () => {
    const cassette: Cassette = { interactions: [] };
    const out = await drive(['user', 'team-get', 'not-a-number', '--json'], cassette);
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    // No wire call fired — cassette stays empty.
    expect(out.requests).toBe(0);
  });
});
