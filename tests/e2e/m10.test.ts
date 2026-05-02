/**
 * M10 E2E suite — spawns the compiled binary against a fixture server
 * for `monday item delete` (`v0.2-plan.md` §3 M10).
 *
 * One scenario: `delete --yes` happy path. cli-design §3.1 #7 +
 * §5.4 + §9.1 anchor delete as the highest-blast-radius destructive
 * verb in v0.2 — Monday retains deleted items in the trash for 30
 * days but exposes no restore mutation, so an end-to-end spawn
 * against a fixture server proves the binary really gates / really
 * round-trips before agents trust it on live workspaces. Archive's
 * coverage stays at the integration layer (one fewer spawn keeps
 * the e2e budget under control); the gate condition + projection
 * logic is shared by both verbs so a regression that breaks one
 * surfaces in the integration suite of both.
 *
 * Build dependency: `dist/cli/index.js` must be current (CI runs
 * `npm run build` before `test:e2e`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnCli } from './spawn.js';
import { startFixtureServer, type FixtureServer } from './fixture-server.js';
import type { Cassette } from '../fixtures/load.js';

const LEAK_CANARY = 'tok-leakcheck-deadbeef-canary';

const fixtureEnv = (
  server: FixtureServer,
  extras: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  MONDAY_API_TOKEN: LEAK_CANARY,
  MONDAY_API_URL: server.url,
  ...extras,
});

const deletedItem = {
  id: '12345',
  name: 'Refactor login',
  state: 'deleted',
  url: null,
  created_at: '2026-04-29T10:00:00Z',
  updated_at: '2026-04-29T11:00:00Z',
  board: { id: '111' },
  group: { id: 'topics', title: 'Topics' },
  parent_item: null,
  column_values: [],
};

interface EnvelopeShape {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly error?: { readonly code: string };
  readonly meta: Readonly<Record<string, unknown>>;
}

const parseEnvelope = (s: string): EnvelopeShape =>
  JSON.parse(s) as EnvelopeShape;

describe('M10 e2e — item delete --yes (live)', () => {
  let server: FixtureServer | undefined;
  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it('round-trips delete_item; envelope carries the projected deleted item + state: "deleted"', async () => {
    const cassette: Cassette = {
      interactions: [
        {
          operation_name: 'ItemDelete',
          response: { data: { delete_item: deletedItem } },
        },
      ],
    };
    server = await startFixtureServer({ cassette });
    const result = await spawnCli({
      args: ['item', 'delete', '12345', '--yes', '--json'],
      env: fixtureEnv(server),
    });
    expect(result.exitCode).toBe(0);
    const env = parseEnvelope(result.stdout) as EnvelopeShape & {
      data: { id: string; name: string; state: string | null };
    };
    expect(env.ok).toBe(true);
    expect(env.data).toMatchObject({
      id: '12345',
      name: 'Refactor login',
      state: 'deleted',
    });
    // Token never leaks into stdout / stderr (M10 regression).
    expect(result.stdout).not.toContain(LEAK_CANARY);
    expect(result.stderr).not.toContain(LEAK_CANARY);
  });
});
