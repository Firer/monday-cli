/**
 * Integration tests for the v0.12-M55-E Commander application-layer
 * injection: when a profile carries a `[profiles.<active>.defaults]`
 * `board` value AND the invocation omits `--board <bid>`, the
 * Commander preAction hook should inject the profile default into
 * `actionCommand.opts()` BEFORE the action body runs.
 *
 * **Load-bearing proof.** This is the end-to-end test that the (c′)
 * shape from the Codex consultation actually works at runtime:
 *
 *   1. Profile config TOML carries `board = "111"`.
 *   2. User runs `monday item list --profile work` (NO --board).
 *   3. The CLI dispatches `ItemsPage` against `board_id: "111"`.
 *
 * Also pins the contract that NON-applicable commands (like
 * `item create --parent`) do NOT receive injection — blind
 * injection would break shipped behavior per Codex's review.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseEnvelope, type EnvelopeShape } from '../helpers.js';
import {
  boardMetadataInteraction,
  item,
  useItemTestEnv,
} from './_item-fixtures.js';

const { drive, xdgRoot } = useItemTestEnv();

const seedProfileConfig = async (
  home: string,
  body: string,
): Promise<void> => {
  const dir = join(home, '.monday-cli');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'config.toml'), body, { mode: 0o600 });
};

describe('v0.12-M55-E profile-defaults injection (integration)', () => {
  it('item list resolves --board from [profiles.<active>.defaults] when flag is absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'profile-defaults-inj-'));
    try {
      await seedProfileConfig(
        home,
        [
          '[profiles.work]',
          'api_token_env = "MONDAY_API_TOKEN_WORK"',
          '[profiles.work.defaults]',
          'board = "111"',
        ].join('\n'),
      );
      // NO --board flag — profile default for `board` should fill in.
      const out = await drive(
        ['item', 'list', '--profile', 'work', '--json'],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsPage',
              // Pin the wire-shape — Monday must see board_id `"111"`
              // dispatched from the profile default.
              match_variables: { boardId: '111' },
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [item('A'), item('B')],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          env: {
            HOME: home,
            XDG_CACHE_HOME: xdgRoot(),
            // Profile resolution sets ctx.env.MONDAY_API_TOKEN from
            // MONDAY_API_TOKEN_WORK; the LEAK_CANARY pre-seed here
            // satisfies loadConfig's required-MONDAY_API_TOKEN check
            // if the preAction hook bails for any reason.
            MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_TOKEN_WORK: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_URL: 'https://api.monday.com/v2',
          },
        },
      );
      expect(out.exitCode).toBe(0);
      const env = parseEnvelope(out.stdout) as EnvelopeShape & {
        data: { id: string }[];
      };
      expect(env.ok).toBe(true);
      expect(env.data.map((i) => i.id)).toEqual(['A', 'B']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('explicit --board on item list wins over profile default (cli precedence (1))', async () => {
    const home = mkdtempSync(join(tmpdir(), 'profile-defaults-inj-'));
    try {
      await seedProfileConfig(
        home,
        [
          '[profiles.work]',
          'api_token_env = "MONDAY_API_TOKEN_WORK"',
          '[profiles.work.defaults]',
          'board = "111"',
        ].join('\n'),
      );
      // --board 222 explicitly given; profile default 111 must lose.
      // BoardMetadata fixture is the canonical one (board id 111 in
      // the body) — only the ItemsPage dispatch carries the
      // load-bearing wire shape: `boardId: "222"`.
      const out = await drive(
        ['item', 'list', '--profile', 'work', '--board', '222', '--json'],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsPage',
              match_variables: { boardId: '222' },
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [item('Z')],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          env: {
            HOME: home,
            XDG_CACHE_HOME: xdgRoot(),
            // Profile resolution sets ctx.env.MONDAY_API_TOKEN from
            // MONDAY_API_TOKEN_WORK; the LEAK_CANARY pre-seed here
            // satisfies loadConfig's required-MONDAY_API_TOKEN check
            // if the preAction hook bails for any reason.
            MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_TOKEN_WORK: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_URL: 'https://api.monday.com/v2',
          },
        },
      );
      expect(out.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('MONDAY_BOARD env wins over profile default (env precedence (2))', async () => {
    const home = mkdtempSync(join(tmpdir(), 'profile-defaults-inj-'));
    try {
      await seedProfileConfig(
        home,
        [
          '[profiles.work]',
          'api_token_env = "MONDAY_API_TOKEN_WORK"',
          '[profiles.work.defaults]',
          'board = "111"',
        ].join('\n'),
      );
      const out = await drive(
        ['item', 'list', '--profile', 'work', '--json'],
        {
          interactions: [
            boardMetadataInteraction,
            {
              operation_name: 'ItemsPage',
              // MONDAY_BOARD env=333 must win over profile board=111.
              match_variables: { boardId: '333' },
              response: {
                data: {
                  boards: [
                    {
                      items_page: {
                        cursor: null,
                        items: [item('E')],
                      },
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          env: {
            HOME: home,
            XDG_CACHE_HOME: xdgRoot(),
            MONDAY_BOARD: '333',
            MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_TOKEN_WORK: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_URL: 'https://api.monday.com/v2',
          },
        },
      );
      expect(out.exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('item list with NO profile default and NO --board → usage_error (applicability registry left the flag undefined; Zod rejects)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'profile-defaults-inj-'));
    try {
      await seedProfileConfig(
        home,
        ['[profiles.work]', 'api_token_env = "MONDAY_API_TOKEN_WORK"'].join('\n'),
      );
      const out = await drive(
        ['item', 'list', '--profile', 'work', '--json'],
        { interactions: [] },
        {
          env: {
            HOME: home,
            XDG_CACHE_HOME: xdgRoot(),
            // Profile resolution sets ctx.env.MONDAY_API_TOKEN from
            // MONDAY_API_TOKEN_WORK; the LEAK_CANARY pre-seed here
            // satisfies loadConfig's required-MONDAY_API_TOKEN check
            // if the preAction hook bails for any reason.
            MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_TOKEN_WORK: 'tok-leakcheck-deadbeef-canary',
            MONDAY_API_URL: 'https://api.monday.com/v2',
          },
        },
      );
      // No board anywhere; Zod parse-boundary rejects with usage_error.
      expect(out.exitCode).toBe(1);
      const env = parseEnvelope(out.stderr);
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('usage_error');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
