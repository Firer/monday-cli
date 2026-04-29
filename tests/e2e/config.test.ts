import { describe, expect, it } from 'vitest';
import { spawnCli } from './spawn.js';

describe('e2e: monday config show', () => {
  it('--json emits a §6 envelope and never leaks the literal token', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const result = await spawnCli({
      args: ['config', 'show', '--json'],
      env: {
        PATH: process.env.PATH ?? '',
        MONDAY_API_TOKEN: literal,
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(literal);
    const env = JSON.parse(result.stdout) as {
      ok: boolean;
      data: { auth: string };
      meta: { schema_version: string };
    };
    expect(env.ok).toBe(true);
    expect(env.data.auth).toBe('set');
    expect(env.meta.schema_version).toBe('1');
  });

  it('reports api_token=unset when the env is empty', async () => {
    const result = await spawnCli({
      args: ['config', 'show', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout) as {
      data: { auth: string };
    };
    expect(env.data.auth).toBe('unset');
  });
});

describe('e2e: monday config path', () => {
  it('--json reports the .env file path candidate', async () => {
    const result = await spawnCli({
      args: ['config', 'path', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout) as {
      data: { searched: { kind: string; path: string }[] };
    };
    expect(env.data.searched.length).toBe(1);
    expect(env.data.searched[0]?.kind).toBe('dotenv');
    expect(env.data.searched[0]?.path.endsWith('/.env')).toBe(true);
  });
});
