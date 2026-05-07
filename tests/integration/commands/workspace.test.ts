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

describe('monday workspace update (integration, M14)', () => {
  const currentWorkspace = {
    id: '12345',
    name: 'Marketing',
    description: 'EU campaigns',
    kind: 'open',
    state: 'active',
    is_default_workspace: false,
    created_at: '2026-05-07T11:00:00Z',
    settings: { icon: { color: '#0000FF', image: null } },
  };
  const renamedWorkspace = { ...currentWorkspace, name: 'Marketing — EU' };

  it('live: --name fires update_workspace with attributes={name} and returns the projected workspace', async () => {
    const out = await drive(
      ['workspace', 'update', '12345', '--name', 'Marketing — EU', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdate',
            // Wire-shape pin: only the agent-provided field appears
            // in `attributes`; omitted fields are absent (not null).
            match_variables: {
              id: '12345',
              attributes: { name: 'Marketing — EU' },
            },
            match_query: /update_workspace\(id: \$id, attributes: \$attributes\)/,
            response: { data: { update_workspace: renamedWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string; kind: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.name).toBe('Marketing — EU');
    expect(env.meta.source).toBe('live');
    assertEnvelopeContract(env);
  });

  it('live: multi-flag bundles into one update_workspace call', async () => {
    const updated = {
      ...currentWorkspace,
      name: 'Renamed',
      description: 'Updated',
    };
    const out = await drive(
      ['workspace', 'update', '12345', '--name', 'Renamed', '--description', 'Updated', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdate',
            match_variables: {
              id: '12345',
              attributes: { name: 'Renamed', description: 'Updated' },
            },
            response: { data: { update_workspace: updated } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { name: string; description: string };
    };
    expect(env.data.name).toBe('Renamed');
    expect(env.data.description).toBe('Updated');
    expect(out.requests).toBe(1);
  });

  it('rejects zero-flag invocation as usage_error at argv parse', async () => {
    // Schema-level `.refine()`: at least one of --name / --kind /
    // --description required. No network leg fires.
    const out = await drive(
      ['workspace', 'update', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
    expect(env.error).toBeDefined();
  });

  it('rejects --kind unknown as usage_error', async () => {
    const out = await drive(
      ['workspace', 'update', '12345', '--kind', 'private', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects whitespace-only --name as usage_error (after trim)', async () => {
    const out = await drive(
      ['workspace', 'update', '12345', '--name', '   ', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('rejects non-numeric workspace id as usage_error', async () => {
    const out = await drive(
      ['workspace', 'update', 'abc', '--name', 'X', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: preflight reads then emits diff with from→to per provided field', async () => {
    const out = await drive(
      [
        'workspace', 'update', '12345',
        '--name', 'Marketing — EU',
        '--kind', 'closed',
        '--dry-run', '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdatePreflight',
            match_variables: { ids: ['12345'] },
            response: { data: { workspaces: [currentWorkspace] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly {
        operation: string;
        workspace_id: string;
        diff: Record<string, { from: unknown; to: unknown }>;
      }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('live');
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('update_workspace');
    expect(plan?.workspace_id).toBe('12345');
    expect(plan?.diff).toEqual({
      name: { from: 'Marketing', to: 'Marketing — EU' },
      kind: { from: 'open', to: 'closed' },
    });
    // Only fields the agent provided appear in the diff.
    expect(plan?.diff).not.toHaveProperty('description');
  });

  it('--dry-run: surfaces not_found when the preflight read returns []', async () => {
    // Per cli-design §6.4 workspace-update variant: "When the
    // preflight read returns not_found, the dry-run surfaces
    // not_found (exit 2)" — not a would-fail dry-run shape.
    const out = await drive(
      ['workspace', 'update', '999', '--name', 'Renamed', '--dry-run', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdatePreflight',
            response: { data: { workspaces: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { workspace_id?: string } };
    };
    expect(env.error?.code).toBe('not_found');
    expect(env.error?.details?.workspace_id).toBe('999');
  });

  it('live: surfaces not_found when update_workspace returns null payload', async () => {
    // Mirrors the M13 update edit / delete null-payload mapping —
    // Monday returning `update_workspace: null` after a bogus id is
    // the standard not_found path.
    const out = await drive(
      ['workspace', 'update', '999', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdate',
            response: { data: { update_workspace: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: surfaces forbidden when Monday rejects with PERMISSION_DENIED', async () => {
    const out = await drive(
      ['workspace', 'update', '12345', '--name', 'X', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceUpdate',
            response: {
              data: { update_workspace: null },
              errors: [
                {
                  message: 'You do not have permission to update this workspace',
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

describe('monday workspace delete (integration, M14)', () => {
  const deletedWorkspace = {
    id: '12345',
    name: 'Marketing',
    description: 'EU campaigns',
    kind: 'open',
    state: 'deleted',
    is_default_workspace: false,
    created_at: '2026-05-07T11:00:00Z',
    settings: { icon: { color: '#0000FF', image: null } },
  };

  it('live: --yes round-trips delete_workspace and returns the projected workspace with state=deleted', async () => {
    const out = await drive(
      ['workspace', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceDelete',
            // Wire-shape pin: variable name `workspaceId` → `workspace_id`
            // on the wire (Monday's `delete_workspace(workspace_id: ID!)`).
            match_variables: { workspaceId: '12345' },
            match_query: /delete_workspace\(workspace_id: \$workspaceId\)/,
            response: { data: { delete_workspace: deletedWorkspace } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; state: string };
    };
    expect(env.data.id).toBe('12345');
    expect(env.data.state).toBe('deleted');
    assertEnvelopeContract(env);
  });

  it('rejects missing --yes as confirmation_required (exit 1)', async () => {
    // Gate fires BEFORE resolveClient — Codex M10 round-1 P2.
    // No mutation interaction needed; the failure surfaces purely
    // from argv state.
    const out = await drive(
      ['workspace', 'delete', '12345', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr) as EnvelopeShape & {
      error?: { code: string; details?: { workspace_id?: string } };
    };
    expect(env.error?.code).toBe('confirmation_required');
    expect(env.error?.details?.workspace_id).toBe('12345');
  });

  it('confirmation_required precedes config_error when no token is set (gate-before-resolveClient invariant)', async () => {
    // M10 round-1 P2 invariant: `confirmation_required` must surface
    // even when the runner can't reach the config layer. The gate
    // ordering prevents `config_error` from masking the agent-
    // observable destructive-gate signal.
    const out = await drive(
      ['workspace', 'delete', '12345', '--json'],
      { interactions: [] },
      { env: { MONDAY_API_URL: 'https://api.monday.com/v2' } },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('confirmation_required');
  });

  it('rejects non-numeric workspace id as usage_error', async () => {
    const out = await drive(
      ['workspace', 'delete', 'abc', '--yes', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(1);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('usage_error');
  });

  it('--dry-run: emits planned_changes with operation delete_workspace; no mutation fires', async () => {
    const out = await drive(
      ['workspace', 'delete', '12345', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: null;
      planned_changes: readonly { operation: string; workspace_id: string }[];
    };
    expect(env.data).toBeNull();
    expect(env.meta.source).toBe('none');
    const plan = env.planned_changes[0];
    expect(plan?.operation).toBe('delete_workspace');
    expect(plan?.workspace_id).toBe('12345');
    expect(out.requests).toBe(0);
  });

  it('--dry-run takes precedence over missing --yes (no confirmation gate fires)', async () => {
    // Mirrors the M10 archive/delete + M13 update delete contract:
    // --dry-run alone is a valid invocation and the gate doesn't
    // fire. The combination `--dry-run` without `--yes` must NOT
    // surface as `confirmation_required`.
    const out = await drive(
      ['workspace', 'delete', '12345', '--dry-run', '--json'],
      { interactions: [] },
    );
    expect(out.exitCode).toBe(0);
  });

  it('live: surfaces not_found when delete_workspace returns null payload', async () => {
    // Re-deleting an already-deleted workspace surfaces null on
    // the wire; the projection's null-guard maps it to not_found.
    const out = await drive(
      ['workspace', 'delete', '999', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceDelete',
            response: { data: { delete_workspace: null } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('live: surfaces forbidden when Monday rejects with PERMISSION_DENIED', async () => {
    const out = await drive(
      ['workspace', 'delete', '12345', '--yes', '--json'],
      {
        interactions: [
          {
            operation_name: 'WorkspaceDelete',
            response: {
              data: { delete_workspace: null },
              errors: [
                {
                  message: 'You do not have permission to delete this workspace',
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
