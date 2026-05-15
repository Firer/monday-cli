/**
 * Integration tests for `monday user team-add-members <tid>
 * --users <id,...> [--dry-run]` (v0.5-M34 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched
 * on `operationName: 'AddUsersToTeam'`. Coverage axes:
 *   - dry-run shape: single planned op with `team_id` + `user_ids`
 *   - happy path (all successful): partial-success envelope with all
 *     `ok: true` records
 *   - partial-success: per-user split with `failed_users[]` →
 *     `{ok: false, error: {code: 'membership_failed'}}` and
 *     `successful_users[]` → `{ok: true, user: {...}}`
 *   - all-failed: every input user lands in failed_users → all
 *     `ok: false` records (envelope still emits `ok: true` per the
 *     universal §6.1 partial-success contract)
 *   - input-order discipline: results mirror `--users <id,...>` order
 *   - null `add_users_to_team` payload → `internal_error`
 *   - missing input user in BOTH buckets → `internal_error`
 *   - parse-boundary usage_error on malformed --users
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

interface MembershipResultEnvelope extends EnvelopeShape {
  readonly data: {
    readonly operation: string;
    readonly team_id: string;
    readonly results: readonly {
      user_id: string;
      ok: boolean;
      user?: { id: string; name: string; email: string };
      error?: { code: string; message: string };
    }[];
  };
}

describe('monday user team-add-members (M34)', () => {
  it('dry-run: emits a single planned op with team_id + user_ids; no wire call', async () => {
    const out = await drive(
      [
        'user',
        'team-add-members',
        '11001',
        '--users',
        '67890,67891',
        '--dry-run',
        '--json',
      ],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes).toEqual([
      {
        operation: 'add_users_to_team',
        team_id: '11001',
        user_ids: ['67890', '67891'],
      },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('happy path (all successful): every input user surfaces as ok: true', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          match_variables: { teamId: '11001', userIds: ['67890', '67891'] },
          response: {
            data: {
              add_users_to_team: {
                failed_users: [],
                successful_users: [wireUser('67890'), wireUser('67891')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890,67891', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('add_users_to_team');
    expect(env.data.team_id).toBe('11001');
    expect(env.data.results).toHaveLength(2);
    expect(env.data.results[0]?.ok).toBe(true);
    expect(env.data.results[0]?.user_id).toBe('67890');
    expect(env.data.results[0]?.user).toEqual(wireUser('67890'));
    expect(env.data.results[1]?.ok).toBe(true);
    expect(env.data.results[1]?.user_id).toBe('67891');
    expect(env.meta.source).toBe('live');
  });

  it('partial success: failed_users surfaces as ok: false with membership_failed code', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          match_variables: { teamId: '11001', userIds: ['67890', '67891', '67892'] },
          response: {
            data: {
              add_users_to_team: {
                failed_users: [wireUser('67891')],
                successful_users: [wireUser('67890'), wireUser('67892')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      [
        'user',
        'team-add-members',
        '11001',
        '--users',
        '67890,67891,67892',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.ok).toBe(true);
    // Input order preserved: results[0] is 67890 (success), [1] is
    // 67891 (failure), [2] is 67892 (success). NOT wire-bucket order.
    expect(env.data.results.map((r) => r.user_id)).toEqual([
      '67890',
      '67891',
      '67892',
    ]);
    expect(env.data.results[0]?.ok).toBe(true);
    expect(env.data.results[1]?.ok).toBe(false);
    expect(env.data.results[1]?.error?.code).toBe('membership_failed');
    expect(env.data.results[1]?.user).toBeUndefined();
    expect(env.data.results[2]?.ok).toBe(true);
  });

  it('all-failed: every input user lands in failed_users; envelope still ok: true', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: {
            data: {
              add_users_to_team: {
                failed_users: [wireUser('67890'), wireUser('67891')],
                successful_users: [],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890,67891', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.results.every((r) => !r.ok)).toBe(true);
    expect(env.data.results.every((r) => r.error?.code === 'membership_failed')).toBe(true);
  });

  it('null bucket: failed_users: null normalised to [] (Codex round-1 P2-1)', async () => {
    // Monday's wire types both buckets as nullable list (`[User!]`,
    // no outer `NON_NULL`), so an all-success response can land
    // with `failed_users: null`. The fetcher normalises to `[]` so
    // the partial-success projection sees a uniform shape.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: {
            data: {
              add_users_to_team: {
                failed_users: null,
                successful_users: [wireUser('67890')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results).toHaveLength(1);
    expect(env.data.results[0]?.ok).toBe(true);
  });

  it('null bucket: successful_users: null normalised to [] (all-failed response)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: {
            data: {
              add_users_to_team: {
                failed_users: [wireUser('67890')],
                successful_users: null,
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results[0]?.ok).toBe(false);
    expect(env.data.results[0]?.error?.code).toBe('membership_failed');
  });

  it('same user in BOTH buckets: failed-bucket priority lands as ok: false (Codex round-1 P3-2)', async () => {
    // W4 sub-axis: a user_id present in BOTH failed + successful
    // (defensive against wire-shape regression) MUST land as
    // `ok: false`. Pins the helper's check order — failed lookup
    // before successful.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: {
            data: {
              add_users_to_team: {
                failed_users: [wireUser('67890')],
                successful_users: [wireUser('67890')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results[0]?.ok).toBe(false);
    expect(env.data.results[0]?.error?.code).toBe('membership_failed');
    expect(env.data.results[0]?.user).toBeUndefined();
  });

  it('internal_error when add_users_to_team payload is null (wire shape regression)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: { data: { add_users_to_team: null } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error when an input user is missing from BOTH buckets (defensive)', async () => {
    // Monday's wire is expected to surface every input user in
    // exactly one bucket; a missing user indicates a wire-shape
    // regression worth surfacing loudly.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'AddUsersToTeam',
          response: {
            data: {
              add_users_to_team: {
                failed_users: [],
                successful_users: [wireUser('67890')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', '67890,67891', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: {
        code: string;
        details?: { team_id?: string; user_id?: string };
      };
    };
    expect(env.error?.code).toBe('internal_error');
    expect(env.error?.details?.user_id).toBe('67891');
  });

  it('usage_error rejects malformed --users token at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['user', 'team-add-members', '11001', '--users', 'foo', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
