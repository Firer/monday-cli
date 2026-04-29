import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, type LoggerOptions } from '../../../src/utils/logger.js';

const collect = (
  partial: Partial<LoggerOptions> = {},
): { lines: string[]; logger: ReturnType<typeof createLogger> } => {
  const stderr = new PassThrough();
  const lines: string[] = [];
  stderr.on('data', (chunk: Buffer) => {
    lines.push(chunk.toString('utf8'));
  });
  const logger = createLogger({
    stderr,
    isTTY: false,
    verbose: false,
    quiet: false,
    ...partial,
  });
  return { lines, logger };
};

describe('createLogger — level routing', () => {
  it('always emits error', () => {
    const { lines, logger } = collect({ quiet: true, isTTY: false, verbose: false });
    logger.error('boom');
    expect(lines.join('')).toContain('[error] boom');
  });

  it('emits warn unless quiet', () => {
    const a = collect();
    a.logger.warn('hint');
    expect(a.lines.join('')).toContain('[warn] hint');

    const b = collect({ quiet: true });
    b.logger.warn('hint');
    expect(b.lines).toEqual([]);
  });

  it('emits info only on TTY and only when not quiet', () => {
    const tty = collect({ isTTY: true });
    tty.logger.info('progress');
    expect(tty.lines.join('')).toContain('[info] progress');

    const piped = collect({ isTTY: false });
    piped.logger.info('progress');
    expect(piped.lines).toEqual([]);

    const ttyQuiet = collect({ isTTY: true, quiet: true });
    ttyQuiet.logger.info('progress');
    expect(ttyQuiet.lines).toEqual([]);
  });

  it('emits debug only when verbose', () => {
    const off = collect();
    off.logger.debug('details');
    expect(off.lines).toEqual([]);

    const on = collect({ verbose: true });
    on.logger.debug('details');
    expect(on.lines.join('')).toContain('[debug] details');
  });
});

describe('createLogger — formatting', () => {
  it('emits string payloads verbatim', () => {
    const { lines, logger } = collect();
    logger.error('hello world');
    expect(lines.join('')).toMatch(/^monday: \[error\] hello world\n$/u);
  });

  it('JSON-stringifies object payloads', () => {
    const { lines, logger } = collect();
    logger.error({ kind: 'http', status: 500 });
    expect(lines.join('')).toContain('{"kind":"http","status":500}');
  });

  it('formats undefined explicitly', () => {
    const { lines, logger } = collect();
    logger.error(undefined);
    expect(lines.join('')).toContain('[error] undefined');
  });
});

describe('createLogger — redaction', () => {
  it('redacts the token before writing', () => {
    const { lines, logger } = collect({ verbose: true });
    logger.debug({ apiToken: 'tok-leakcheck-xxxx' });
    const out = lines.join('');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('tok-leakcheck-xxxx');
  });

  it('honours extra redaction keys', () => {
    const { lines, logger } = collect({
      verbose: true,
      redactOptions: { extraKeys: ['workspaceId'] },
    });
    logger.debug({ workspaceId: '99' });
    expect(lines.join('')).toContain('[REDACTED]');
  });

  // Codex M2 review §5: when `env` is supplied, the logger must
  // auto-collect MONDAY_API_TOKEN as a literal-secret so the
  // value-scan layer scrubs it from arbitrary string payloads
  // even when the caller forgets to thread `redactOptions.secrets`.
  it('auto-scrubs MONDAY_API_TOKEN from arbitrary string payloads when env is provided', () => {
    const { lines, logger } = collect({
      verbose: true,
      env: { MONDAY_API_TOKEN: 'tok-leakcheck-deadbeef-canary' },
    });
    logger.debug('auth=tok-leakcheck-deadbeef-canary expired');
    const out = lines.join('');
    expect(out).not.toContain('tok-leakcheck-deadbeef-canary');
    expect(out).toContain('[REDACTED]');
  });

  it('merges env-derived secrets with explicit redactOptions.secrets', () => {
    const { lines, logger } = collect({
      verbose: true,
      env: { MONDAY_API_TOKEN: 'env-token-deadbeef' },
      redactOptions: { secrets: ['explicit-secret-feedface'] },
    });
    logger.debug({ msg: 'env-token-deadbeef and explicit-secret-feedface' });
    const out = lines.join('');
    expect(out).not.toContain('env-token-deadbeef');
    expect(out).not.toContain('explicit-secret-feedface');
  });

  it('re-reads env at write-time so a token loaded mid-run is still scrubbed', () => {
    const env: NodeJS.ProcessEnv = {};
    const { lines, logger } = collect({ verbose: true, env });
    logger.debug('auth=lazy-token-deadbeef'); // before env populated
    env.MONDAY_API_TOKEN = 'lazy-token-deadbeef';
    logger.debug('auth=lazy-token-deadbeef'); // after env populated
    const all = lines.join('\n');
    // Second emission must be scrubbed; the first slipped through
    // because the token wasn't loaded yet — an artefact of the
    // env-mutation pattern, not a bug. The point of this test is
    // to prove the second write picks up the *current* env.
    const second = lines[lines.length - 1];
    expect(second).not.toContain('lazy-token-deadbeef');
    expect(all).toContain('[REDACTED]');
  });
});
