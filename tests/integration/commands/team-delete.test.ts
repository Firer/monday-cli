/**
 * Integration tests for `monday user team-delete <tid> --yes [--dry-run]`
 * (v0.5-M34 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched on
 * `operationName: 'DeleteTeam'`. Coverage axes:
 *   - destructive-gate fire: `--yes` missing → `confirmation_required`
 *     (exit 1) — fires BEFORE `resolveClient` per M10 round-1 P2
 *   - dry-run shape: minimal `{operation, team_id}` with no wire call
 *   - happy path: direct unwrap of `data: <Team>` for the deleted team
 *   - null `delete_team` payload → `not_found` (mirrors workspace-
 *     delete cadence — id bogus / already deleted by concurrent caller)
 *   - missing `delete_team` key → `internal_error` (schema drift)
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
  name: 'Doomed Team',
  picture_url: null,
  is_guest: false,
  users: [wireUser('67890')],
  owners: [wireUser('999')],
  ...overrides,
});

describe('monday user team-delete (M34)', () => {
  it('confirmation_required: --yes missing fires the destructive gate before any wire call', async () => {
    const out = await drive(
      ['user', 'team-delete', '11001', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { team_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.team_id).toBe('11001');
    expect(out.requests).toBe(0);
  });

  it('confirmation_required precedes config_error when no token is set (gate-before-resolveClient invariant)', async () => {
    // M10 round-1 P2 invariant: `confirmation_required` must surface
    // even when the runner can't reach the config layer. The gate
    // ordering prevents `config_error` from masking the agent-
    // observable destructive-gate signal. Codex IMPL round-2 P3-1.
    const out = await drive(
      ['user', 'team-delete', '11001', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(out.requests).toBe(0);
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      ['user', 'team-delete', '11001', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly Record<string, unknown>[];
    };
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.planned_changes).toEqual([
      { operation: 'delete_team', team_id: '11001' },
    ]);
    expect(env.meta.source).toBe('none');
  });

  it('happy path: --yes deletes the team and emits the deleted Team verbatim', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteTeam',
          match_variables: { teamId: '11001' },
          response: { data: { delete_team: wireTeam() } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-delete', '11001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('11001');
    expect(env.data.name).toBe('Doomed Team');
    expect(env.meta.source).toBe('live');
  });

  it('not_found when delete_team payload is null (id bogus / already deleted)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteTeam',
          response: { data: { delete_team: null } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-delete', '11001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { team_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.team_id).toBe('11001');
  });

  it('internal_error when delete_team key is absent (schema drift)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteTeam',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-delete', '11001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error on schema drift in returned Team', async () => {
    const { owners: _owners, ...badTeam } = wireTeam();
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'DeleteTeam',
          response: { data: { delete_team: badTeam } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-delete', '11001', '--yes', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('usage_error rejects non-numeric <teamId> at parse boundary (no gate / wire call)', async () => {
    const out = await drive(
      ['user', 'team-delete', 'not-a-number', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });
});
