import { PassThrough } from 'node:stream';
import { CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  buildBaseMeta,
  collectSecrets,
  createMetaBuilder,
  toMondayError,
  writeErrorEnvelope,
} from '../../../src/cli/envelope-out.js';
import {
  ApiError,
  ConfigError,
  InternalError,
  UsageError,
} from '../../../src/utils/errors.js';

describe('createMetaBuilder', () => {
  it('snapshot returns undefined fields before any setter is called', () => {
    const builder = createMetaBuilder();
    expect(builder.snapshot()).toEqual({
      apiVersion: undefined,
      source: undefined,
    });
  });

  it('setApiVersion / setSource land in the snapshot', () => {
    const builder = createMetaBuilder();
    builder.setApiVersion('2026-04');
    builder.setSource('live');
    expect(builder.snapshot()).toEqual({
      apiVersion: '2026-04',
      source: 'live',
    });
  });

  it('repeated setters last-write-wins per field', () => {
    const builder = createMetaBuilder();
    builder.setApiVersion('2026-01');
    builder.setApiVersion('2026-04');
    builder.setSource('cache');
    builder.setSource('live');
    expect(builder.snapshot()).toEqual({
      apiVersion: '2026-04',
      source: 'live',
    });
  });

  it('snapshots are taken at call time, not by reference', () => {
    // Important for the runner's error path: snapshot() captures the
    // builder's state when the runner reads it; later mutations (e.g.
    // a second action firing in a hypothetical batch flow) don't
    // retroactively change a frozen snapshot.
    const builder = createMetaBuilder();
    builder.setApiVersion('2026-01');
    const earlier = builder.snapshot();
    builder.setApiVersion('2026-04');
    const later = builder.snapshot();
    expect(earlier.apiVersion).toBe('2026-01');
    expect(later.apiVersion).toBe('2026-04');
  });
});

describe('collectSecrets', () => {
  it('returns the MONDAY_API_TOKEN value when set', () => {
    expect(collectSecrets({ MONDAY_API_TOKEN: 'tok-xyz' })).toEqual([
      'tok-xyz',
    ]);
  });

  it('returns empty array when MONDAY_API_TOKEN is unset', () => {
    expect(collectSecrets({})).toEqual([]);
  });

  it('returns empty array when MONDAY_API_TOKEN is an empty string', () => {
    // An empty token isn't a secret to scrub; redacting "" would
    // turn every empty string in the envelope into [REDACTED].
    expect(collectSecrets({ MONDAY_API_TOKEN: '' })).toEqual([]);
  });
});

describe('buildBaseMeta', () => {
  const baseInputs = {
    snapshot: { apiVersion: undefined, source: undefined },
    env: {} as NodeJS.ProcessEnv,
    cliVersion: '0.0.0-test',
    requestId: 'req-1',
    retrievedAt: '2026-04-30T00:00:00.000Z',
  };

  it('uses the snapshot.apiVersion when committed', () => {
    const meta = buildBaseMeta({
      ...baseInputs,
      snapshot: { apiVersion: '2026-04', source: 'live' },
    });
    expect(meta.api_version).toBe('2026-04');
    expect(meta.source).toBe('live');
  });

  it('falls back to MONDAY_API_VERSION env when snapshot is empty', () => {
    const meta = buildBaseMeta({
      ...baseInputs,
      env: { MONDAY_API_VERSION: '2026-03' },
    });
    expect(meta.api_version).toBe('2026-03');
  });

  it('falls back to the SDK pin (2026-01) when neither snapshot nor env set it', () => {
    const meta = buildBaseMeta(baseInputs);
    expect(meta.api_version).toBe('2026-01');
  });

  it('snapshot.apiVersion wins over MONDAY_API_VERSION env', () => {
    // Mirrors the resolveClient precedence — flag > env > pin.
    const meta = buildBaseMeta({
      ...baseInputs,
      snapshot: { apiVersion: '2026-05', source: 'live' },
      env: { MONDAY_API_VERSION: '2026-03' },
    });
    expect(meta.api_version).toBe('2026-05');
  });

  it('source falls back to "none" when snapshot is empty', () => {
    const meta = buildBaseMeta(baseInputs);
    expect(meta.source).toBe('none');
  });

  it('always sets cache_age_seconds to null on the error path', () => {
    // The error path doesn't observe cache; M3+ may add cache-source
    // tracking, but the runner-level fallback stays null.
    const meta = buildBaseMeta(baseInputs);
    expect(meta.cache_age_seconds).toBeNull();
  });

  it('always sets complexity to null on the error path', () => {
    // §6.1: meta.complexity is always present, null without --verbose.
    const meta = buildBaseMeta(baseInputs);
    expect(meta.complexity).toBeNull();
  });

  it('threads cli_version, request_id, retrieved_at verbatim', () => {
    const meta = buildBaseMeta({
      ...baseInputs,
      cliVersion: '1.2.3',
      requestId: 'req-abc',
      retrievedAt: '2026-04-30T12:34:56.000Z',
    });
    expect(meta.cli_version).toBe('1.2.3');
    expect(meta.request_id).toBe('req-abc');
    expect(meta.retrieved_at).toBe('2026-04-30T12:34:56.000Z');
  });
});

describe('writeErrorEnvelope', () => {
  const buildMetaForTest = (
    overrides: Partial<Parameters<typeof buildBaseMeta>[0]> = {},
  ) =>
    buildBaseMeta({
      snapshot: { apiVersion: undefined, source: undefined },
      env: {},
      cliVersion: '0.0.0-test',
      requestId: 'req-1',
      retrievedAt: '2026-04-30T00:00:00.000Z',
      ...overrides,
    });

  const captureStderr = (): {
    stderr: NodeJS.WritableStream;
    read: () => string;
  } => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    return {
      stderr: stream,
      read: () => Buffer.concat(chunks).toString('utf8'),
    };
  };

  it('writes a §6 error envelope as pretty-printed JSON with trailing newline', () => {
    const { stderr, read } = captureStderr();
    writeErrorEnvelope(new UsageError('expected --board'), {
      stderr,
      env: {},
      meta: buildMetaForTest(),
    });
    const out = read();
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe('usage_error');
    expect(parsed.error.message).toBe('expected --board');
  });

  it('redacts the live token via the value-scan layer', () => {
    const literal = 'tok-leakcheck-zzzz';
    const { stderr, read } = captureStderr();
    writeErrorEnvelope(
      new ApiError('forbidden', `upstream said auth=${literal} expired`),
      {
        stderr,
        env: { MONDAY_API_TOKEN: literal },
        meta: buildMetaForTest(),
      },
    );
    const out = read();
    expect(out).not.toContain(literal);
    expect(out).toContain('[REDACTED]');
  });

  it('threads the supplied meta through to the envelope', () => {
    const { stderr, read } = captureStderr();
    writeErrorEnvelope(new ApiError('rate_limited', 'slow down'), {
      stderr,
      env: {},
      meta: buildMetaForTest({
        snapshot: { apiVersion: '2026-04', source: 'live' },
      }),
    });
    const parsed = JSON.parse(read()) as {
      meta: { api_version: string; source: string };
    };
    expect(parsed.meta.api_version).toBe('2026-04');
    expect(parsed.meta.source).toBe('live');
  });
});

describe('toMondayError', () => {
  it('passes MondayCliError instances through unchanged', () => {
    const err = new ConfigError('missing token');
    expect(toMondayError(err)).toBe(err);
  });

  it('wraps a plain Error in InternalError preserving message + cause', () => {
    const cause = new TypeError('something exploded');
    const mapped = toMondayError(cause);
    expect(mapped).toBeInstanceOf(InternalError);
    expect(mapped.message).toBe('something exploded');
    expect(mapped.cause).toBe(cause);
  });

  it('wraps a non-Error throwable in InternalError with cause', () => {
    const mapped = toMondayError('string-thrown');
    expect(mapped).toBeInstanceOf(InternalError);
    expect(mapped.message).toBe('unknown error');
    expect(mapped.cause).toBe('string-thrown');
  });

  it('maps a CommanderError parsing failure to UsageError', () => {
    const cmdErr = new CommanderError(1, 'commander.unknownOption', 'unknown option');
    const mapped = toMondayError(cmdErr);
    expect(mapped).toBeInstanceOf(UsageError);
    expect(mapped.message).toBe('unknown option');
  });

  it('maps a CommanderError success-style code to InternalError (defensive)', () => {
    // Help-displayed / version are exitCode-0 commander errors. The
    // runner short-circuits them *before* calling toMondayError, so
    // hitting this branch means a flow regression — surfacing as
    // internal_error is the correct loud signal.
    const cmdErr = new CommanderError(0, 'commander.helpDisplayed', 'help');
    const mapped = toMondayError(cmdErr);
    expect(mapped).toBeInstanceOf(InternalError);
    expect(mapped.message).toContain('commander.helpDisplayed');
  });
});
