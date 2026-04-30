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
