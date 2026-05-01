/**
 * Integration tests for `monday item find` (M4 §3 reads).
 *
 * Drives the full runner against `FixtureTransport` cassettes via the
 * shared helpers (R6) + per-verb fixture module (R14). Coverage:
 *   - exact match, ambiguous_name, --first warning, find-cap
 *     truncated scan warning.
 */
import { describe, expect, it } from 'vitest';
import {
  parseEnvelope,
  type EnvelopeShape,
} from '../helpers.js';
import { item, useItemTestEnv } from './_item-fixtures.js';

const { drive } = useItemTestEnv();

describe('monday item find (integration)', () => {
  it('returns the unique match', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor login', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('1', 'Refactor login'), item('2', 'Other')],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.data.id).toBe('1');
    expect(env.data.name).toBe('Refactor login');
  });

  it('raises ambiguous_name on multi-match without --first', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('1', 'Refactor'), item('2', 'Refactor')],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('ambiguous_name');
  });

  it('surfaces first_of_many warning under --first', async () => {
    const out = await drive(
      ['item', 'find', 'Refactor', '--board', '111', '--first', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: null,
                      items: [item('5', 'Refactor'), item('1', 'Refactor')],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
    };
    expect(env.data.id).toBe('1'); // lowest ID wins
    expect(env.warnings?.[0]?.code).toBe('first_of_many');
  });

  it('not_found when the board has no matching item', async () => {
    const out = await drive(
      ['item', 'find', 'No such', '--board', '111', '--json'],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [{ items_page: { cursor: null, items: [item('1', 'Other')] } }],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(2);
    const env = parseEnvelope(out.stderr);
    expect(env.error?.code).toBe('not_found');
  });

  it('emits pagination_cap_reached warning when find scan was capped before resolving uniqueness (REGRESSION: Codex M4 §6)', async () => {
    // Resolved match exists on page 1 but the cap is small enough
    // that there are still more pages — uniqueness can't be
    // verified.
    const out = await drive(
      [
        'item',
        'find',
        'Refactor',
        '--board',
        '111',
        '--limit-pages',
        '1',
        '--page-size',
        '2',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemFind',
            response: {
              data: {
                boards: [
                  {
                    items_page: {
                      cursor: 'C2',
                      items: [
                        item('1', 'Refactor'),
                        item('2', 'Other'),
                      ],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string };
      warnings: { code: string }[];
    };
    expect(env.data.id).toBe('1');
    expect(env.warnings.some((w) => w.code === 'pagination_cap_reached')).toBe(true);
  });

  it('walks multiple pages until the match is found, with --group narrowing', async () => {
    const out = await drive(
      [
        'item',
        'find',
        'Refactor login',
        '--board',
        '111',
        '--group',
        'topics',
        '--json',
      ],
      {
        interactions: [
          {
            operation_name: 'ItemFindByGroup',
            match_variables: { groupId: 'topics' },
            response: {
              data: {
                boards: [
                  {
                    groups: [
                      {
                        items_page: {
                          cursor: 'C2',
                          items: [item('1', 'Other')],
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
          {
            operation_name: 'ItemFindNext',
            response: {
              data: {
                next_items_page: {
                  cursor: null,
                  items: [item('2', 'Refactor login')],
                },
              },
            },
          },
        ],
      },
    );
    expect(out.exitCode).toBe(0);
    const env = parseEnvelope(out.stdout) as EnvelopeShape & {
      data: { id: string; name: string };
    };
    expect(env.data.id).toBe('2');
  });
});
