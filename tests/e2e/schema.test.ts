import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { spawnCli } from './spawn.js';

describe('e2e: monday schema', () => {
  it('--json produces a valid JSON Schema 2020-12 envelope', async () => {
    const result = await spawnCli({
      args: ['schema', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout) as {
      ok: boolean;
      data: {
        schema_version: string;
        commands: Record<string, { input: object; output: object }>;
      };
    };
    expect(env.ok).toBe(true);
    expect(env.data.schema_version).toBe('1');
    // Every emitted command schema compiles under ajv 2020.
    const ajv = new Ajv2020({ strict: false });
    for (const [name, entry] of Object.entries(env.data.commands)) {
      try {
        ajv.compile(entry.input);
        ajv.compile(entry.output);
      } catch (err) {
        throw new Error(`schema for ${name} failed: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  });

  it('narrows to a single command when given a positional argument', async () => {
    const result = await spawnCli({
      args: ['schema', 'config.show', '--json'],
      env: { PATH: process.env.PATH ?? '' },
    });
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(result.stdout) as {
      data: { commands: Record<string, unknown> };
    };
    expect(Object.keys(env.data.commands)).toEqual(['config.show']);
  });
});
