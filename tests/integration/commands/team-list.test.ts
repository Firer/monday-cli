/**
 * Integration tests for `monday user team-list` (v0.5-M34 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched
 * on `operationName: 'ListTeams'` (R-NEW-37 W2 audit-point — the
 * operationName is pinned literally at the fetcher boundary, NOT
 * caller-overridable). Coverage axes:
 *   - empty-account / populated-account happy paths
 *   - wrapped-record envelope: `data: { teams, returned_count }`
 *   - W4: live source + cache_age_seconds null
 *   - null `teams` root → `internal_error` with drift hint
 *   - schema drift in a per-team field → `internal_error`
 *   - wire-vs-output projection: sparse `users` (null entries) get
 *     filtered before the output schema sees them
 *   - LEAK_CANARY redaction sanity
 */
import { describe, expect, it } from 'vitest';
import {
  assertEnvelopeContract,
  drive,
  LEAK_CANARY,
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
  picture_url: 'https://example.monday.com/teams/11001/pic.png',
  is_guest: false,
  users: [wireUser('67890'), wireUser('67891')],
  owners: [wireUser('67890')],
  ...overrides,
});

describe('monday user team-list (M34)', () => {
  it('empty account: emits the wrapped record envelope with teams: []', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: { data: { teams: [] } },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { teams: readonly unknown[]; returned_count: number };
    };
    expect(env.ok).toBe(true);
    expect(env.data.teams).toEqual([]);
    expect(env.data.returned_count).toBe(0);
    expect(env.meta.source).toBe('live');
    expect(env.meta.cache_age_seconds).toBeNull();
    assertEnvelopeContract(env);
  });

  it('populated account: emits the projected teams + returned_count', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: {
            data: {
              teams: [
                wireTeam(),
                wireTeam({ id: '11002', name: 'Sales', is_guest: true }),
              ],
            },
          },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        teams: readonly {
          id: string;
          name: string;
          is_guest: boolean | null;
          users: readonly { id: string }[] | null;
        }[];
        returned_count: number;
      };
    };
    expect(env.data.teams).toHaveLength(2);
    expect(env.data.teams[0]?.id).toBe('11001');
    expect(env.data.teams[1]?.is_guest).toBe(true);
    expect(env.data.returned_count).toBe(2);
  });

  it('filters null entries out of Team.users at the wire-vs-output projection', async () => {
    // Wire's `users: [User]` can contain sparse entries when a
    // member's User record was tombstoned post-team-creation. The
    // wire-vs-output split filters those nulls before agents see
    // them (R-v0.5-NEW-4 discipline).
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: {
            data: {
              teams: [wireTeam({ users: [wireUser('67890'), null, wireUser('67892')] })],
            },
          },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: {
        teams: readonly { users: readonly { id: string }[] | null }[];
      };
    };
    expect(env.data.teams[0]?.users).toHaveLength(2);
    expect(env.data.teams[0]?.users).toEqual([
      { id: '67890', name: 'User 67890', email: 'user67890@example.test' },
      { id: '67892', name: 'User 67892', email: 'user67892@example.test' },
    ]);
  });

  it('null users container passes through as null (team has no member list)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: { data: { teams: [wireTeam({ users: null })] } },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { teams: readonly { users: unknown }[] };
    };
    expect(env.data.teams[0]?.users).toBeNull();
  });

  it('internal_error when ListTeams returns teams: null (wire shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: { data: { teams: null } },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in a Team row (missing required `owners` key)', async () => {
    const { owners: _owners, ...teamWithoutOwners } = wireTeam();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: { data: { teams: [teamWithoutOwners] } },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('redaction: LEAK_CANARY never appears in stdout even on the happy path', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ListTeams',
          response: { data: { teams: [wireTeam()] } },
        },
      ],
    };
    const out = await drive(['user', 'team-list', '--json'], cassette);
    expect(out.stdout).not.toContain(LEAK_CANARY);
  });
});
