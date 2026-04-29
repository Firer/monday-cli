import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { run, runWithSignals, type RunOptions } from '../../../src/cli/run.js';
import { loadConfig } from '../../../src/config/load.js';
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

  it('a real loadConfig({}) failure surfaces as config_error / exit 3', async () => {
    // The M0 exit criterion: missing-token from loadConfig must produce
    // the §6 envelope on stderr with exit 3 — not internal_error / 2.
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: {},
      registerCommands: (program) => {
        program
          .command('self-test')
          .action((_args: unknown, cmd: { parent: unknown }) => {
            // Commander hands the parent program in as the second arg;
            // we just need any path that calls loadConfig with a stripped env.
            void cmd;
            loadConfig({}, { loadDotenv: false });
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(3);

    const envelope = JSON.parse(captured.stderr()) as {
      ok: boolean;
      error: {
        code: string;
        details: { issues: { path: string }[]; hint: string };
      };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('config_error');
    expect(envelope.error.details.issues.map((i) => i.path)).toContain(
      'MONDAY_API_TOKEN',
    );
    expect(envelope.error.details.hint).toMatch(/MONDAY_API_TOKEN/u);
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
  it('does not leak the token through error envelopes (key path)', async () => {
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

  it('does not leak the token landing in Error.message (value-scan path)', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: { MONDAY_API_TOKEN: literal },
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            // Adversarial: token in a vanilla error message — no
            // sensitively-named key in sight. Without value-scanning
            // the runner would copy it straight into envelope.message.
            throw new Error(`upstream said auth=${literal} expired`);
          });
      },
    });

    await run(options);
    const stderr = captured.stderr();
    expect(stderr).not.toContain(literal);
    expect(stderr).toContain('[REDACTED]');
  });

  it('does not leak a token loaded mid-run from .env (lazy secrets)', async () => {
    // Codex review follow-up: `ctx.secrets` used to snapshot at
    // runner construction. If MONDAY_API_TOKEN lives only in .env,
    // `loadConfig()` populates env *after* the snapshot, so a token
    // landing in Error.message after that point would slip through.
    // The fix re-reads env at emit time. This test fails without it.
    const literal = 'tok-from-dotenv-yyyy';
    const workDir = mkdtempSync(join(tmpdir(), 'monday-cli-runtest-'));
    writeFileSync(join(workDir, '.env'), `MONDAY_API_TOKEN=${literal}\n`);

    try {
      const { options, captured } = baseOptions({
        argv: ['node', 'monday', 'self-test'],
        env: {}, // empty initially; .env populates it during the action
        registerCommands: (program, ctx) => {
          program
            .command('self-test')
            .action(() => {
              loadConfig(ctx.env, { loadDotenv: true, cwd: workDir });
              // After loadConfig, ctx.env.MONDAY_API_TOKEN is set
              // (dotenv mutates by reference). Throw with the literal
              // smuggled into Error.message — the value-scan path
              // must redact it.
              throw new Error(`upstream said auth=${literal}`);
            });
        },
      });

      await run(options);
      expect(captured.stderr()).not.toContain(literal);
      expect(captured.stderr()).toContain('[REDACTED]');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('does not leak the token from Error.stack', async () => {
    const literal = 'tok-leakcheck-xxxx';
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: { MONDAY_API_TOKEN: literal },
      registerCommands: (program) => {
        program
          .command('self-test')
          .action(() => {
            const err = new Error('boom');
            err.stack = `Error: boom (auth=${literal})\n    at frame:1`;
            throw err;
          });
      },
    });

    await run(options);
    expect(captured.stderr()).not.toContain(literal);
  });
});

describe('run — RunContext threading', () => {
  it('passes RunContext into registerCommands so actions see ctx.signal/transport/env', async () => {
    let observed: { hasSignal: boolean; envToken?: string; transport?: unknown } | null = null;

    const { options } = baseOptions({
      argv: ['node', 'monday', 'self-test'],
      env: { MONDAY_API_TOKEN: 'tok' },
      transport: { request: () => Promise.resolve({ status: 200, headers: {}, body: {} }) },
      registerCommands: (program, ctx) => {
        program
          .command('self-test')
          .action(() => {
            observed = {
              hasSignal: ctx.signal instanceof AbortSignal,
              ...(ctx.env.MONDAY_API_TOKEN !== undefined
                ? { envToken: ctx.env.MONDAY_API_TOKEN }
                : {}),
              transport: ctx.transport,
            };
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(0);
    expect(observed).not.toBeNull();
    expect(observed!.hasSignal).toBe(true);
    expect(observed!.envToken).toBe('tok');
    expect(observed!.transport).toBeDefined();
  });
});

describe('run — abort handling (SIGINT path)', () => {
  it('a caller-supplied signal aborted with kind:sigint exits 130 with no envelope', async () => {
    const ctrl = new AbortController();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'hang'],
      signal: ctrl.signal,
      registerCommands: (program, ctx) => {
        program
          .command('hang')
          .action(async () => {
            // Action that respects ctx.signal and bails when aborted.
            await new Promise<void>((resolve, reject) => {
              ctx.signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
              // safety timeout: reject if test forgets to abort
              setTimeout(() => {
                resolve();
              }, 5_000);
            });
          });
      },
    });

    // Fire the abort before parseAsync would otherwise complete.
    setTimeout(() => {
      ctrl.abort({ kind: 'sigint' });
    }, 10);

    const result = await run(options);
    expect(result.exitCode).toBe(130);
    // No envelope on stderr for SIGINT — exit code is the signal.
    expect(captured.stderr()).toBe('');
    expect(captured.stdout()).toBe('');
  });

  it('a caller-supplied signal with a non-sigint reason still surfaces the action error', async () => {
    const ctrl = new AbortController();
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'hang'],
      signal: ctrl.signal,
      registerCommands: (program, ctx) => {
        program
          .command('hang')
          .action(async () => {
            await new Promise<void>((_resolve, reject) => {
              ctx.signal.addEventListener('abort', () => {
                reject(new Error('client cancelled'));
              });
              setTimeout(() => {
                _resolve();
              }, 5_000);
            });
          });
      },
    });

    setTimeout(() => {
      ctrl.abort({ kind: 'cancel', reason: 'client cancelled' });
    }, 10);

    const result = await run(options);
    // Non-sigint abort: action's thrown error becomes internal_error /
    // exit 2, with the §6 envelope on stderr.
    expect(result.exitCode).toBe(2);
    expect(captured.stderr()).toContain('"code": "internal_error"');
  });

  it('without an abort, a normal action returns its own exit code', async () => {
    const { options } = baseOptions({
      argv: ['node', 'monday', 'echo'],
      registerCommands: (program) => {
        program
          .command('echo')
          .action(() => {
            // pass — exit 0
          });
      },
    });

    const result = await run(options);
    expect(result.exitCode).toBe(0);
  });
});

describe('runWithSignals — SIGINT integration', () => {
  it('a real SIGINT during action exits 130 with no envelope', async () => {
    const { options, captured } = baseOptions({
      argv: ['node', 'monday', 'hang'],
      registerCommands: (program, ctx) => {
        program
          .command('hang')
          .action(async () => {
            await new Promise<void>((resolve, reject) => {
              ctx.signal.addEventListener('abort', () => {
                reject(new Error('aborted'));
              });
              setTimeout(() => {
                resolve();
              }, 5_000);
            });
          });
      },
    });

    setTimeout(() => {
      // Simulate a real SIGINT — runWithSignals listens for it and
      // aborts its internal controller with reason {kind:'sigint'}.
      process.emit('SIGINT');
    }, 10);

    const result = await runWithSignals(options);
    expect(result.exitCode).toBe(130);
    expect(captured.stderr()).toBe('');
  });

  it('without SIGINT, runWithSignals delegates to run() exit codes', async () => {
    const { options } = baseOptions({
      argv: ['node', 'monday', '--version'],
    });
    const result = await runWithSignals(options);
    expect(result.exitCode).toBe(0);
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
