/**
 * Integration tests for `monday workspace *` (M3 §3).
 *
 * Drives the runner end-to-end via `run(options)` with a
 * `FixtureTransport` injected through `options.transport` — same
 * shape as `account.test.ts`. Covers the success path of each verb
 * plus at least one envelope-meta-on-error assertion per noun.
 */
import { describe, expect, it } from 'vitest';
import type { Interaction } from '../../fixtures/load.js';
import {
  assertEnvelopeContract,
  drive,
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';

const sampleWorkspace = {
  id: '5',
  name: 'Engineering',
  description: 'Platform team',
  kind: 'open',
  state: 'active',
  is_default_workspace: false,
  created_at: '2026-04-01T00:00:00Z',
};

const sampleWorkspaceWithSettings = {
  ...sampleWorkspace,
  settings: { icon: { color: '#0000FF', image: null } },
};

const listInteraction = (
  workspaces: readonly unknown[],
  page = 1,
): Interaction => ({
  operation_name: 'WorkspaceList',
  match_variables: { page },
  response: { data: { workspaces } },
});

describe('monday workspace list (integration)', () => {
  it('handles a missing `workspaces` field gracefully (treats as empty page)', async () => {
    // Defensive ?? [] branch: Monday returning {data: {}} without
    // the workspaces selection — shouldn't crash the walker.
    const out = await drive(
      ['workspace', 'list', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceList',
            response_body: { data: {} },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
    expect(env.meta.total_returned).toBe(0);
  });

  it('returns the projected list with collection-shaped meta', async () => {
    const out = await drive(
      ['workspace', 'list', '--json'],
      { interactions: [listInteraction([sampleWorkspace])] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.meta.total_returned).toBe(1);
    expect(env.meta.has_more).toBe(false);
    expect(env.data).toEqual([sampleWorkspace]);
    expect(out.remaining).toBe(0);
  });

  it('--limit-pages caps the walk and emits a pagination_cap_reached warning', async () => {
    // Codex M3 pass-1 finding 1: prior versions looped indefinitely
    // when every page came back full. The cap stops the walk; the
    // warning tells agents the result is truncated.
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleWorkspace,
      id: String(100 + i),
    }));
    const out = await drive(
      ['workspace', 'list', '--all', '--limit', '25', '--limit-pages', '2', '--json'],
      {
        interactions: [
          { ...listInteraction(fullPage, 1) },
          { ...listInteraction(fullPage, 2) },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly { readonly code: string; readonly details: { readonly pages_walked: number } }[];
    };
    expect(env.meta.has_more).toBe(true);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
    expect(env.warnings[0]?.details.pages_walked).toBe(2);
    expect(out.requests).toBe(2);
  });

  it('--all walks pages until a short page lands', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleWorkspace,
      id: String(100 + i),
    }));
    const shortPage = [{ ...sampleWorkspace, id: '200' }];
    const out = await drive(
      ['workspace', 'list', '--all', '--limit', '25', '--json'],
      {
        interactions: [
          { ...listInteraction(fullPage, 1) },
          { ...listInteraction(shortPage, 2) },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.meta.total_returned).toBe(26);
    expect(out.requests).toBe(2);
  });

  it('--kind and --state are threaded into variables', async () => {
    const out = await drive(
      ['workspace', 'list', '--kind', 'open', '--state', 'archived', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceList',
            match_variables: { kind: 'open', state: 'archived' },
            response: { data: { workspaces: [sampleWorkspace] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects --all and --page together as usage_error', async () => {
    const out = await drive(
      ['workspace', 'list', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--api-version is reflected in the error envelope on HTTP 401', async () => {
    const out = await drive(
      ['--api-version', '2026-04', 'workspace', 'list', '--json'],
      {
        interactions: [
          { operation_name: 'WorkspaceList', http_status: 401, response: {} },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('unauthorized');
    expect(env.meta.api_version).toBe('2026-04');
    expect(env.meta.source).toBe('live');
  });
});

describe('monday workspace get (integration)', () => {
  it('returns the projected workspace including settings.icon', async () => {
    const out = await drive(
      ['workspace', 'get', '5', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceGet',
            match_variables: { ids: ['5'] },
            response: { data: { workspaces: [sampleWorkspaceWithSettings] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toEqual(sampleWorkspaceWithSettings);
  });

  it('surfaces not_found when the workspace does not exist', async () => {
    const out = await drive(
      ['workspace', 'get', '999', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceGet',
            response: { data: { workspaces: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('rejects non-numeric workspace ids at the parse boundary', async () => {
    const out = await drive(
      ['workspace', 'get', 'abc', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });
});

describe('monday workspace folders (integration)', () => {
  const sampleFolder = {
    id: '101',
    name: 'Roadmap',
    color: 'aquamarine',
    created_at: '2026-04-01T00:00:00Z',
    owner_id: '1',
    parent: null,
    children: [{ id: '500', name: 'Q2 plan' }],
  };

  it('handles a missing `folders` field gracefully (treats as empty page)', async () => {
    const out = await drive(
      ['workspace', 'folders', '5', '--json'],
      {
        interactions: [
          { operation_name: 'WorkspaceFolders', response_body: { data: {} } },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    expect(env.data).toEqual([]);
  });

  it('returns the projected folder list', async () => {
    const out = await drive(
      ['workspace', 'folders', '5', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceFolders',
            match_variables: { workspaceIds: ['5'], page: 1 },
            response: { data: { folders: [sampleFolder] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout);
    assertEnvelopeContract(env);
    expect(env.data).toEqual([sampleFolder]);
  });

  it('rejects --all + --page', async () => {
    const out = await drive(
      ['workspace', 'folders', '5', '--all', '--page', '2', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--all walks until a short page', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleFolder,
      id: String(1000 + i),
    }));
    const shortPage = [{ ...sampleFolder, id: '2000' }];
    const out = await drive(
      ['workspace', 'folders', '5', '--all', '--limit', '25', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceFolders',
            match_variables: { page: 1 },
            response: { data: { folders: fullPage } },
          },
          {
            operation_name: 'WorkspaceFolders',
            match_variables: { page: 2 },
            response: { data: { folders: shortPage } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    expect(out.requests).toBe(2);
  });

  it('--all + --limit-pages emits pagination_cap_reached', async () => {
    const fullPage = Array.from({ length: 25 }, (_, i) => ({
      ...sampleFolder,
      id: String(1000 + i),
    }));
    const out = await drive(
      ['workspace', 'folders', '5', '--all', '--limit', '25', '--limit-pages', '2', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceFolders',
            match_variables: { page: 1 },
            response: { data: { folders: fullPage } },
          },
          {
            operation_name: 'WorkspaceFolders',
            match_variables: { page: 2 },
            response: { data: { folders: fullPage } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      warnings: readonly { readonly code: string }[];
    };
    expect(env.meta.has_more).toBe(true);
    expect(env.warnings[0]?.code).toBe('pagination_cap_reached');
  });
});

describe('monday workspace create (integration, M14)', () => {
  const createdWorkspace = {
    id: '12345',
    name: 'Marketing',
    description: 'EU campaigns',
    kind: 'open',
    state: 'active',
    is_default_workspace: false,
    created_at: '2026-05-07T11:00:00Z',
    settings: { icon: { color: '#0000FF', image: null } },
  };

  it('live: --name posts create_workspace with default kind=open and emits the projected workspace', async () => {
    const out = await drive(
      ['workspace', 'create', '--name', 'Marketing', '--description', 'EU campaigns', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            // Wire-shape pin: kind is always sent (Monday's signature
            // pins kind: WorkspaceKind!), defaulting to "open" when
            // the agent omits --kind. Description forwarded verbatim.
            match_variables: { name: 'Marketing', kind: 'open', description: 'EU campaigns' },
            // Pin the GraphQL surface so a future regression that
            // drops `kind` from the mutation declaration would fail.
            match_query: /create_workspace\(name: \$name, kind: \$kind, description: \$description\)/,
            response: { data: { create_workspace: createdWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; kind: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.id).toBe('12345');
    expect(env.data.name).toBe('Marketing');
    expect(env.data.kind).toBe('open');
    assertEnvelopeContract(env);
    expect(env.meta.source).toBe('live');
  });

  it('live: --kind closed forwards kind through to the wire', async () => {
    const closedWorkspace = { ...createdWorkspace, kind: 'closed' };
    const out = await drive(
      ['workspace', 'create', '--name', 'Marketing — EU', '--kind', 'closed', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            match_variables: { name: 'Marketing — EU', kind: 'closed' },
            response: { data: { create_workspace: closedWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { kind: string };
    };
    expect(env.data.kind).toBe('closed');
  });

  it('live: --description omitted does not send a description argument', async () => {
    // Pre-fix, an inadvertent `description: undefined` in the
    // variables map would have been serialised as `null` on the
    // wire and explicitly cleared Monday's server-side default.
    // The action body filters undefined out of the variables map;
    // this fixture asserts the wire-side variables shape.
    const out = await drive(
      ['workspace', 'create', '--name', 'Marketing', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            match_variables: { name: 'Marketing', kind: 'open' },
            response: { data: { create_workspace: createdWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
  });

  it('rejects --kind unknown as usage_error at argv parse', async () => {
    const out = await drive(
      ['workspace', 'create', '--name', 'Marketing', '--kind', 'private', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects empty --name as usage_error (after trim)', async () => {
    // Whitespace-only --name trims to empty; agents that meant to
    // pass a real name would hit Monday's downstream validation
    // anyway. Reject at the boundary so the failure fires before
    // the network round-trip.
    const out = await drive(
      ['workspace', 'create', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects missing --name as usage_error (commander requiredOption)', async () => {
    const out = await drive(
      ['workspace', 'create', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation create_workspace; no mutation fires', async () => {
    const out = await drive(
      ['workspace', 'create', '--name', 'Preview', '--description', 'x', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        name: string;
        kind: string;
        description?: string;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    expect(env.planned_changes.length).toBe(1);
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('create_workspace');
    expect(plan?.name).toBe('Preview');
    expect(plan?.kind).toBe('open');
    expect(plan?.description).toBe('x');
    expect(out.requests).toBe(0);
  });

  it('--dry-run: omits description slot when --description is not set', async () => {
    const out = await drive(
      ['workspace', 'create', '--name', 'Preview', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      planned_changes: readonly Record<string, unknown>[];
    };
    const plan = env.planned_changes[0];
    expect(plan).not.toHaveProperty('description');
  });

  it('surfaces internal_error when Monday returns a null create_workspace payload', async () => {
    // Drives the projectCreatedWorkspace null-guard. Mirrors the
    // null-payload regression test on update create.
    const out = await drive(
      ['workspace', 'create', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            response: { data: { create_workspace: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('internal_error');
  });

  it('surfaces forbidden when Monday rejects with PERMISSION_DENIED (admin-permission-sensitive)', async () => {
    // M14 admin-permission-sensitive contract — non-admin callers
    // surface `forbidden`, not `unauthorized`.
    const out = await drive(
      ['workspace', 'create', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceCreate',
            response: {
              data: { create_workspace: null },
              errors: [
                {
                  message: 'You do not have permission to create workspaces',
                  extensions: { code: 'PERMISSION_DENIED' },
                },
              ],
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('forbidden');
  });
});
