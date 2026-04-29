import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { run, type RunOptions } from '../../../src/cli/run.js';
import {
  ApiError,
  ConfigError,
  UsageError,
} from '../../../src/utils/errors.js';
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
  stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
  stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

  const options: RunOptions = {
    argv: ['node', 'monday'],
    env: { MONDAY_API_TOKEN: 'tok' },
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

describe('run — help / version smoke', () => {
  it('--version exits 0 and prints the version on stdout', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--version'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(captured.stdout()).toContain('0.0.0-test');
    expect(captured.stderr()).toBe('');
  });

  it('--help exits 0 and prints help on stdout', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--help'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(captured.stdout()).toContain('Usage: monday');
  });

  it('global flags appear in --help', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--help'],
    });
    await run(options);
    const help = captured.stdout();
    for (const flag of [
      '--json',
      '--table',
      '--full',
      '--minimal',
      '--quiet',
      '--verbose',
      '--no-color',
      '--no-cache',
      '--profile',
      '--api-version',
      '--timeout',
      '--retry',
      '--dry-run',
      '--yes',
    ]) {
      expect(help).toContain(flag);
    }
  });
});

describe('run — usage errors', () => {
  it('unknown flag produces usage_error envelope on stderr and exit 1', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--bogus'],
    });
    const result = await run(options);
    expect(result.exitCode).toBe(1);
    expect(captured.stdout()).toBe('');

    const envelope = JSON.parse(captured.stderr()) as {
      ok: boolean;
      error: { code: string; message: string };
      meta: { schema_version: string; request_id: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('usage_error');
    expect(envelope.meta.schema_version).toBe('1');
    expect(envelope.meta.request_id).toBe('fixed-id');
  });
});

describe('run — error envelope from command actions', () => {
  it('ConfigError → exit 3 with config_error envelope', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: {},
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            throw new ConfigError('MONDAY_API_TOKEN is required');
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(3);

    const envelope = JSON.parse(captured.stderr()) as {
      ok: boolean;
      error: { code: string; message: string };
      meta: object;
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('config_error');
    expect(envelope.error.message).toBe('MONDAY_API_TOKEN is required');
  });

  it('UsageError → exit 1 with usage_error envelope', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            throw new UsageError('expected --board');
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(1);

    const envelope = JSON.parse(captured.stderr()) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('usage_error');
  });

  it('ApiError → exit 2 with the supplied code', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            throw new ApiError('rate_limited', 'slow down', {
              retryAfterSeconds: 30,
            });
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(2);

    const envelope = JSON.parse(captured.stderr()) as {
      error: { code: string; retry_after_seconds: number; retryable: boolean };
    };
    expect(envelope.error.code).toBe('rate_limited');
    expect(envelope.error.retry_after_seconds).toBe(30);
    expect(envelope.error.retryable).toBe(true);
  });

  it('non-CLI Error → exit 2 with internal_error envelope', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            throw new TypeError('something exploded');
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(2);

    const envelope = JSON.parse(captured.stderr()) as {
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe('internal_error');
    expect(envelope.error.message).toBe('something exploded');
  });

  it('non-Error throwable → exit 2 with internal_error envelope', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw 'string-thrown';
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(captured.stderr()) as {
      error: { code: string };
    };
    expect(envelope.error.code).toBe('internal_error');
  });
});

describe('run — token redaction', () => {
  it('does not leak the token through error envelopes', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: { MONDAY_API_TOKEN: literal },
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            // Adversarial shape: literal token nested in `cause`.
            const inner = new Error('boom');
            Object.assign(inner, { apiToken: literal });
            throw new ApiError('forbidden', 'no', { cause: inner });
          });
      },
    });

    await run(options);
    expect(captured.stderr()).not.toContain(literal);
  });
});

describe('run — request_id propagation', () => {
  it('uses the injected request-id generator for envelope.meta', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--bogus'],
      requestIdGenerator: fixedRequestIdGenerator(['my-test-id']),
    });

    await run(options);
    const envelope = JSON.parse(captured.stderr()) as {
      meta: { request_id: string };
    };
    expect(envelope.meta.request_id).toBe('my-test-id');
  });
});

describe('run — meta.api_version', () => {
  it('reads from MONDAY_API_VERSION env when set', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--bogus'],
      env: { MONDAY_API_VERSION: '2026-04' },
    });
    await run(options);
    const envelope = JSON.parse(captured.stderr()) as {
      meta: { api_version: string };
    };
    expect(envelope.meta.api_version).toBe('2026-04');
  });

  it('defaults to the SDK pin (2026-01) when env is unset', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', '--bogus'],
      env: {},
    });
    await run(options);
    const envelope = JSON.parse(captured.stderr()) as {
      meta: { api_version: string };
    };
    expect(envelope.meta.api_version).toBe('2026-01');
  });
});
