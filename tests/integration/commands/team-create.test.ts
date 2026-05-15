/**
 * Integration tests for `monday user team-create --name <n>
 * [--users <id,...>] [--guest-team] [--allow-empty] [--dry-run]`
 * (v0.5-M34 IMPL).
 *
 * Drives the runtime body via `FixtureTransport` cassettes matched
 * on `operationName: 'CreateTeam'`. Coverage axes:
 *   - happy path: direct unwrap of `data: <Team>` with id populated
 *   - dry-run shape: minimal `{operation, name}` + only-supplied
 *     optional fields surface in the planned payload
 *   - `--users` threads as `input.subscriber_ids: [ID!]`
 *   - `--guest-team` + `--allow-empty` threads as input + options
 *   - argv parse: `usage_error` for empty `--name` (no wire call)
 *   - missing `create_team` key → `internal_error` (schema drift)
 *   - null `create_team` payload → `internal_error`
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
  id: '11005',
  name: 'New Team',
  picture_url: null,
  is_guest: false,
  users: [],
  owners: [wireUser('999')],
  ...overrides,
});

describe('monday user team-create (M34)', () => {
  it('happy path: --name only emits the created Team (live source)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateTeam',
          match_variables: { input: { name: 'Backend Eng' } },
          response: {
            data: { create_team: wireTeam({ id: '11005', name: 'Backend Eng' }) },
          },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-create', '--name', 'Backend Eng', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('11005');
    expect(env.data.name).toBe('Backend Eng');
    expect(env.meta.source).toBe('live');
  });

  it('threads --users, --guest-team, --allow-empty to the wire input + options', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateTeam',
          match_variables: {
            input: {
              name: 'Vendors',
              subscriber_ids: ['67890', '67891'],
              is_guest_team: true,
            },
            options: { allow_empty_team: true },
          },
          response: {
            data: { create_team: wireTeam({ id: '11006', name: 'Vendors', is_guest: true }) },
          },
        },
      ],
    };
    const out = await drive(
      [
        'user',
        'team-create',
        '--name',
        'Vendors',
        '--users',
        '67890,67891',
        '--guest-team',
        '--allow-empty',
        '--json',
      ],
      cassette,
    );
    expect(out.exitCode).toBe(0);
  });

  it('dry-run: emits minimal planned changes with no wire call (source: none)', async () => {
    const out = await drive(
      [
        'user',
        'team-create',
        '--name',
        'Empty Bootstrap',
        '--users',
        '67890',
        '--allow-empty',
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
    expect(env.ok).toBe(true);
    expect(env.data).toBeNull();
    expect(env.planned_changes).toHaveLength(1);
    const planned = env.planned_changes[0];
    expect(planned?.operation).toBe('create_team');
    expect(planned?.name).toBe('Empty Bootstrap');
    expect(planned?.subscriber_ids).toEqual(['67890']);
    expect(planned?.allow_empty_team).toBe(true);
    // is_guest_team was NOT passed; should not appear in planned.
    expect(planned).not.toHaveProperty('is_guest_team');
    expect(env.meta.source).toBe('none');
  });

  it('dry-run --name only: planned omits every optional slot', async () => {
    const out = await drive(
      ['user', 'team-create', '--name', 'Simple', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    const planned = env.planned_changes[0];
    expect(planned).toEqual({ operation: 'create_team', name: 'Simple' });
  });

  it('usage_error rejects empty --name at parse boundary (no wire call)', async () => {
    const out = await drive(
      ['user', 'team-create', '--name', '', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('usage_error rejects malformed --users token (non-numeric) at parse boundary', async () => {
    const out = await drive(
      ['user', 'team-create', '--name', 'X', '--users', 'not-a-number', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    expect(parseEnvelope(out.stderr).error?.code).toBe('usage_error');
    expect(out.requests).toBe(0);
  });

  it('internal_error when create_team key is absent (schema drift via R42 helper)', async () => {
    // Codex IMPL round-1 P3-1: pin the missing-root-key branch
    // for `CreateTeam` alongside the null-payload branch.
    // `assertResponseFieldPresent` (R42 helper) surfaces the
    // schema-drift case as `internal_error`.
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateTeam',
          response: { data: { other_root: 'unexpected' } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-create', '--name', 'X', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });

  it('internal_error when create_team payload is null (no team returned post-mutation)', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'CreateTeam',
          response: { data: { create_team: null } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-create', '--name', 'X', '--json'],
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
          operation_name: 'CreateTeam',
          response: { data: { create_team: badTeam } },
        },
      ],
    };
    const out = await drive(
      ['user', 'team-create', '--name', 'X', '--json'],
      cassette,
    );
    expect(out.exitCode).toBe(2);
    expect(parseEnvelope(out.stderr).error?.code).toBe('internal_error');
  });
});
