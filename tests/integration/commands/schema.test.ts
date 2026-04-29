import { PassThrough } from 'node:stream';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import { fixedRequestIdGenerator } from '../../../src/utils/request-id.js';

interface Captured {
  readonly stdout: () => string;
  readonly stderr: () => string;
}

const baseOptions = (
  overrides: Partial<RunOptions> = {},
): { options: RunOptions; captured: Captured } => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => stdoutChunks.push(c));
  stderr.on('data', (c: Buffer) => stderrChunks.push(c));
  const options: RunOptions = {
    argv: ['node', 'monday'],
    env: {},
    stdout,
    stderr,
    isTTY: false,
    cliVersion: '0.0.0-test',
    cliDescription: 'CLI under test',
    requestIdGenerator: fixedRequestIdGenerator(['fixed-id']),
    clock: () => new Date('2026-04-29T10:00:00Z'),
    ...overrides,
  };
  return {
    options,
    captured: {
      stdout: () => Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: () => Buffer.concat(stderrChunks).toString('utf8'),
    },
  };
};

describe('monday schema (integration)', () => {
  it('emits a §6 envelope with the full registry', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'schema', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as {
      ok: boolean;
      data: {
        schema_version: string;
        commands: Record<string, { input: unknown; output: unknown }>;
        error_codes: { code: string }[];
      };
      meta: { schema_version: string; source: string };
    };
    expect(env.ok).toBe(true);
    expect(env.meta.schema_version).toBe('1');
    expect(env.meta.source).toBe('none');
    // The shipped M1 surface — every entry is required.
    for (const expected of [
      'config.show',
      'config.path',
      'cache.list',
      'cache.clear',
      'cache.stats',
      'schema',
    ]) {
      expect(env.data.commands).toHaveProperty(expected);
    }
    // Round-trip: schema describes its own registration.
    expect(env.data.commands.schema?.output).toBeDefined();
    expect(env.data.commands.schema?.input).toBeDefined();
  });

  it('narrows to a single command via positional', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'schema', 'cache.list', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    const env = JSON.parse(captured.stdout()) as {
      data: { commands: Record<string, unknown> };
    };
    expect(Object.keys(env.data.commands)).toEqual(['cache.list']);
  });

  it('surfaces an unknown command as usage_error / exit 1', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'schema', 'nope.fake', '--json'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    const env = JSON.parse(captured.stderr()) as {
      error: { code: string; message: string };
    };
    expect(env.error.code).toBe('usage_error');
    expect(env.error.message).toMatch(/unknown command/u);
  });

  it('emitted JSON Schemas validate against ajv 2020-12', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'schema', '--json'],
    });
    await run(options);
    const env = JSON.parse(captured.stdout()) as {
      data: {
        commands: Record<string, { input: object; output: object }>;
      };
    };
    const ajv = new Ajv2020({ strict: false });
    for (const [name, entry] of Object.entries(env.data.commands)) {
      // ajv compiles each schema; failure throws and the test fails
      // with the offending command name in the message.
      try {
        ajv.compile(entry.input);
        ajv.compile(entry.output);
      } catch (err) {
        throw new Error(
          `schema for ${name} failed ajv compilation: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }
  });
});
