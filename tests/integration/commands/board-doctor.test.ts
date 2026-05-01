/**
 * Integration tests for `monday board doctor` (M6).
 *
 * Drives the runner against `FixtureTransport` cassettes via the
 * shared `useCachedIntegrationEnv` helper (M5b cleanup R11). Each
 * test exercises one diagnostic kind in isolation, plus the
 * "all healthy" zero-diagnostics path and the multi-diagnostic
 * compose case.
 */
import { describe, expect, it } from 'vitest';
import {
  parseEnvelope,
  useCachedIntegrationEnv,
  type EnvelopeShape,
} from '../helpers.js';
import type { Interaction } from '../../fixtures/load.js';

const { drive } = useCachedIntegrationEnv('monday-cli-doctor-int-');

const baseBoard = {
  id: '111',
  name: 'Sprint',
  description: null,
  state: 'active',
  board_kind: 'public',
  board_folder_id: null,
  workspace_id: null,
  url: null,
  hierarchy_type: null,
  is_leaf: true,
  updated_at: null,
  groups: [],
};

const boardWithColumns = (columns: readonly unknown[]): Interaction => ({
  operation_name: 'BoardMetadata',
  response: {
    data: { boards: [{ ...baseBoard, columns }] },
  },
});

interface DoctorEnvelope {
  data?: {
    board_id?: string;
    board_name?: string;
    total?: number;
    diagnostics?: readonly {
      kind: string;
      severity: string;
      [k: string]: unknown;
    }[];
  };
}

describe('monday board doctor (integration)', () => {
  it('healthy board: emits zero diagnostics', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'status_4',
              title: 'Status',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    expect(env.data?.total).toBe(0);
    expect(env.data?.diagnostics).toEqual([]);
    expect(env.data?.board_id).toBe('111');
    expect(env.data?.board_name).toBe('Sprint');
    expect(env.meta.source).toBe('live');
  });

  it('duplicate_column_title: groups columns sharing a normalised title', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'status_a',
              title: 'Status',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
            {
              id: 'status_b',
              title: 'STATUS',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    expect(env.data?.total).toBe(1);
    const dx = env.data?.diagnostics?.[0] as
      | {
          kind: string;
          severity: string;
          normalised_title: string;
          columns: { id: string; title: string }[];
        }
      | undefined;
    expect(dx?.kind).toBe('duplicate_column_title');
    expect(dx?.severity).toBe('warning');
    expect(dx?.normalised_title).toBe('status');
    expect(dx?.columns.map((c) => c.id).sort()).toEqual(['status_a', 'status_b']);
  });

  it('duplicate_column_title: skips archived columns from grouping', async () => {
    // The diagnostic only fires for active columns — archived columns
    // are filtered out of the resolver too, so they can't cause
    // ambiguous_column at runtime.
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'status_active',
              title: 'Status',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
            {
              id: 'status_archived',
              title: 'Status',
              type: 'status',
              description: null,
              archived: true,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    expect(env.data?.total).toBe(0);
  });

  it('unsupported_column_type: read-only-forever surfaces with category', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'mirror_1',
              title: 'Mirrored',
              type: 'mirror',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    expect(env.data?.total).toBe(1);
    const dx = env.data?.diagnostics?.[0] as
      | {
          kind: string;
          severity: string;
          column_id: string;
          category: string;
        }
      | undefined;
    expect(dx?.kind).toBe('unsupported_column_type');
    expect(dx?.severity).toBe('info');
    expect(dx?.column_id).toBe('mirror_1');
    expect(dx?.category).toBe('read_only_forever');
  });

  it('unsupported_column_type: v0.2-roadmap (link) surfaces with v0.2_writer_expansion category', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'link_1',
              title: 'External',
              type: 'link',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const dx = env.data?.diagnostics?.[0] as
      | { severity: string; category: string }
      | undefined;
    expect(dx?.severity).toBe('warning');
    expect(dx?.category).toBe('v0.2_writer_expansion');
  });

  it('unsupported_column_type: future type (battery) surfaces with future category', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'battery_1',
              title: 'Progress',
              type: 'battery',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const dx = env.data?.diagnostics?.[0] as
      | { severity: string; category: string }
      | undefined;
    expect(dx?.severity).toBe('warning');
    expect(dx?.category).toBe('future');
  });

  it('broken_board_relation: archived linked board surfaces with reason archived', async () => {
    // `board_relation` is on the v0.2 writer-expansion roadmap, so
    // doctor ALSO emits an unsupported_column_type diagnostic for
    // every board_relation column. Filter to the broken_board_
    // relation diagnostic in the assertion.
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'rel_1',
              title: 'Linked epics',
              type: 'board_relation',
              description: null,
              archived: null,
              settings_str: JSON.stringify({ boardIds: ['222'] }),
              width: null,
            },
          ]),
          {
            operation_name: 'BoardDoctorRelationLookup',
            response: {
              data: {
                boards: [{ id: '222', name: 'Epics', state: 'archived' }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const dx = env.data?.diagnostics?.find(
      (d) => d.kind === 'broken_board_relation',
    ) as
      | {
          kind: string;
          column_id: string;
          missing_board_ids: string[];
          reason: string;
        }
      | undefined;
    expect(dx?.kind).toBe('broken_board_relation');
    expect(dx?.column_id).toBe('rel_1');
    expect(dx?.missing_board_ids).toEqual(['222']);
    expect(dx?.reason).toBe('archived');
  });

  it('broken_board_relation: unreachable linked board (missing from response) surfaces with reason unreachable', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'rel_1',
              title: 'Linked epics',
              type: 'board_relation',
              description: null,
              archived: null,
              settings_str: JSON.stringify({ boardIds: ['222'] }),
              width: null,
            },
          ]),
          {
            operation_name: 'BoardDoctorRelationLookup',
            // Monday returns an empty list — the board ID isn't visible
            // to this token (no read permission, or the board was hard-
            // deleted).
            response: { data: { boards: [] } },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const dx = env.data?.diagnostics?.find(
      (d) => d.kind === 'broken_board_relation',
    ) as { reason: string; missing_board_ids: string[] } | undefined;
    expect(dx?.reason).toBe('unreachable');
    expect(dx?.missing_board_ids).toEqual(['222']);
  });

  it('broken_board_relation: mixed (one archived + one unreachable) surfaces with reason mixed', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'rel_1',
              title: 'Linked',
              type: 'board_relation',
              description: null,
              archived: null,
              settings_str: JSON.stringify({ boardIds: ['222', '333'] }),
              width: null,
            },
          ]),
          {
            operation_name: 'BoardDoctorRelationLookup',
            response: {
              data: {
                // 222 archived; 333 omitted (unreachable).
                boards: [{ id: '222', name: 'X', state: 'archived' }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const dx = env.data?.diagnostics?.find(
      (d) => d.kind === 'broken_board_relation',
    ) as { reason: string; missing_board_ids: string[] } | undefined;
    expect(dx?.reason).toBe('mixed');
    expect(dx?.missing_board_ids.sort()).toEqual(['222', '333']);
  });

  it('broken_board_relation: all linked boards healthy → no broken-relation diagnostic', async () => {
    // Note: an unsupported_column_type diagnostic still fires for the
    // board_relation column itself (v0.2 writer-expansion). Filter to
    // confirm the broken-relation kind specifically did NOT fire.
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'rel_1',
              title: 'Linked',
              type: 'board_relation',
              description: null,
              archived: null,
              settings_str: JSON.stringify({ boardIds: ['222'] }),
              width: null,
            },
          ]),
          {
            operation_name: 'BoardDoctorRelationLookup',
            response: {
              data: {
                boards: [{ id: '222', name: 'Active', state: 'active' }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    const broken = env.data?.diagnostics?.filter(
      (d) => d.kind === 'broken_board_relation',
    );
    expect(broken).toEqual([]);
  });

  it('multi-diagnostic compose: duplicate titles + unsupported types fire together', async () => {
    const out = await drive(
      ['board', 'doctor', '111', '--json'],
      {
        interactions: [
          boardWithColumns([
            {
              id: 'status_a',
              title: 'Status',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
            {
              id: 'status_b',
              title: 'status',
              type: 'status',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
            {
              id: 'mirror_1',
              title: 'Mirrored',
              type: 'mirror',
              description: null,
              archived: null,
              settings_str: '{}',
              width: null,
            },
          ]),
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & DoctorEnvelope;
    expect(env.data?.total).toBe(2);
    const kinds = env.data?.diagnostics?.map((d) => d.kind).sort();
    expect(kinds).toEqual(['duplicate_column_title', 'unsupported_column_type']);
  });
});
