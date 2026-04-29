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
});
