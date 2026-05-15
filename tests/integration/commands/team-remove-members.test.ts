/**
 * Integration tests for `monday user team-remove-members <tid>
 * --users <id,...> [--dry-run]` (v0.5-M34 IMPL).
 *
 * Mirrors `team-add-members.test.ts` modulo the `operation` literal
 * and the wire root key. Coverage axes (lighter than add-members
 * since the projection logic lives in the shared
 * `_team-membership.ts` helper exercised in full by add-members):
 *   - dry-run shape: planned op with `remove_users_from_team`
 *   - happy path (all successful)
 *   - partial-success: per-user split with input-order preservation
 *   - null payload → `internal_error`
 *   - parse-boundary usage_error
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

describe('monday user team-remove-members (M34)', () => {
  it('dry-run: emits planned op with remove_users_from_team operation literal', async () => {
    const out = await drive(
      [
        'user',
        'team-remove-members',
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
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.planned_changes).toEqual([
      {
        operation: 'remove_users_from_team',
        team_id: '11001',
        user_ids: ['67890', '67891'],
      },
    ]);
  });

  it('happy path: all-successful emits ok: true records', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'RemoveUsersFromTeam',
          match_variables: { teamId: '11001', userIds: ['67890'] },
          response: {
            data: {
              remove_users_from_team: {
                failed_users: [],
                successful_users: [wireUser('67890')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.ok).toBe(true);
    expect(env.data.operation).toBe('remove_users_from_team');
    expect(env.data.results[0]?.ok).toBe(true);
  });

  it('partial success: failed_users surfaces as ok: false with input-order preserved', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'RemoveUsersFromTeam',
          response: {
            data: {
              remove_users_from_team: {
                failed_users: [wireUser('67890')],
                successful_users: [wireUser('67891')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890,67891', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results.map((r) => r.user_id)).toEqual(['67890', '67891']);
    expect(env.data.results[0]?.ok).toBe(false);
    expect(env.data.results[0]?.error?.code).toBe('membership_failed');
    expect(env.data.results[1]?.ok).toBe(true);
  });

  it('null bucket: failed_users: null normalised to [] (Codex round-2 P3-2 — parity with add-members)', async () => {
    // The `?? []` normalisation lives independently in
    // `removeUsersFromTeam` so pin it explicitly — a future refactor
    // could regress one fetcher without the other.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'RemoveUsersFromTeam',
          response: {
            data: {
              remove_users_from_team: {
                failed_users: null,
                successful_users: [wireUser('67890')],
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results[0]?.ok).toBe(true);
  });

  it('null bucket: successful_users: null normalised to [] (all-failed response)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'RemoveUsersFromTeam',
          response: {
            data: {
              remove_users_from_team: {
                failed_users: [wireUser('67890')],
                successful_users: null,
              },
            },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as MembershipResultEnvelope;
    expect(env.data.results[0]?.ok).toBe(false);
    expect(env.data.results[0]?.error?.code).toBe('membership_failed');
  });

  it('internal_error when remove_users_from_team payload is null', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'RemoveUsersFromTeam',
          response: { data: { remove_users_from_team: null } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', '67890', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('usage_error rejects malformed --users token at parse boundary', async () => {
    const out = await drive(
      ['user', 'team-remove-members', '11001', '--users', 'foo', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
