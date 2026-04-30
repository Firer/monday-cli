/**
 * Integration tests for `monday user *` (M3 §3).
 */
import { describe, expect, it } from 'vitest';
import { drive, parseEnvelope, type EnvelopeShape } from '../helpers.js';

const sampleUser = {
  id: '1',
  name: 'Alice',
  email: 'alice@example.test',
  enabled: true,
  is_guest: false,
  is_admin: false,
  is_view_only: false,
  is_pending: false,
  is_verified: true,
  title: null,
  time_zone_identifier: 'Europe/London',
  join_date: '2026-01-01',
  last_activity: '2026-04-30T09:00:00Z',
};

describe('monday user list — null-data resilience', () => {
  it('handles a missing `users` field gracefully', async () => {
    const out = await drive(
      ['user', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'UserList', response_body: { data: {} } },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
  });
});

describe('monday user list', () => {
  it('returns the projected list with collection meta', async () => {
    const out = await drive(
      ['user', 'list', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserList',
            response: { data: { users: [sampleUser] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.total_returned).toBe(1);
    expect(env.data).toEqual([sampleUser]);
  });

  it('--name / --email / --kind are threaded into variables', async () => {
    const out = await drive(
      ['user', 'list', '--name', 'Alice', '--email', 'alice@example.test', '--kind', 'guests', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserList',
            match_variables: {
              name: 'Alice',
              emails: ['alice@example.test'],
              kind: 'guests',
            },
            response: { data: { users: [sampleUser] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('--all walks until short page', async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({
      ...sampleUser,
      id: String(100 + i),
      email: `u${String(i)}@x.test`,
    }));
    const short = [{ ...sampleUser, id: '200', email: 'last@x.test' }];
    const out = await drive(
      ['user', 'list', '--all', '--limit', '25', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserList',
            match_variables: { page: 1 },
            response: { data: { users: full } },
          },
          {
            operation_name: 'UserList',
            match_variables: { page: 2 },
            response: { data: { users: short } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.total_returned).toBe(26);
  });

  it('--all + --limit-pages emits pagination_cap_reached', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleUser,
      id: String(100 + i),
      email: `u${String(i)}@x.test`,
    }));
    const out = await drive(
      ['user', 'list', '--all', '--limit', '25', '--limit-pages', '2', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserList',
            match_variables: { page: 1 },
            response: { data: { users: fullPage } },
          },
          {
            operation_name: 'UserList',
            match_variables: { page: 2 },
            response: { data: { users: fullPage } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      meta: { has_more?: boolean };
      warnings: readonly { readonly code: string }[];
    };
    expect(env.meta.has_more).toBe(true);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
  });

  it('rejects --all + --page', async () => {
    const out = await drive(
      ['user', 'list', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--api-version reaches error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'user', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'UserList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
  });
});

describe('monday user get', () => {
  it('returns the projected user', async () => {
    const out = await drive(
      ['user', 'get', '1', '--json'],
      {
        interactions: [
          {
            operation_name: 'UserGet',
            match_variables: { ids: ['1'] },
            response: {
              data: {
                users: [
                  { ...sampleUser, url: 'https://x.monday.com/u/1', country_code: 'GB' },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({
      id: '1',
      url: 'https://x.monday.com/u/1',
      country_code: 'GB',
    });
  });

  it('not_found when no user matches', async () => {
    const out = await drive(
      ['user', 'get', '9999', '--json'],
      {
        interactions: [
          { operation_name: 'UserGet', response: { data: { users: [] } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric user id at the parse boundary', async () => {
    const out = await drive(['user', 'get', 'xyz', '--json'], { interactions: [] });
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday user me', () => {
  it('mirrors account whoami output', async () => {
    const out = await drive(
      ['user', 'me', '--json'],
      {
        interactions: [
          {
            operation_name: 'Whoami',
            response: {
              data: {
                me: {
                  id: '1',
                  name: 'Alice',
                  email: 'alice@example.test',
                  account: { id: '99', name: 'Org', slug: 'org' },
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toMatchObject({
      me: { id: '1', email: 'alice@example.test' },
    });
  });

  it('surfaces unauthorized when me is null', async () => {
    const out = await drive(
      ['user', 'me', '--json'],
      {
        interactions: [
          { operation_name: 'Whoami', response: { data: { me: null } } },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
  });
});
