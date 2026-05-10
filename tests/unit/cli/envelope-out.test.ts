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

  it('appends extraSecrets after the env token (cli-design §7.4.3)', () => {
    // The runtime-extension contract: credentials-cache access_token
    // values are added to the secret-bag alongside the env token.
    expect(
      collectSecrets(
        { MONDAY_API_TOKEN: 'env-tok' },
        ['cred-tok-a', 'cred-tok-b'],
      ),
    ).toEqual(['env-tok', 'cred-tok-a', 'cred-tok-b']);
  });

  it('returns only extraSecrets when env token is unset', () => {
    // Credentials-cache-only flow (`monday auth login --profile work`
    // is the user's only token source) — the runtime extension still
    // populates the bag for the value-scan layer to consume.
    expect(collectSecrets({}, ['cred-tok-a'])).toEqual(['cred-tok-a']);
  });

  it('skips empty entries in extraSecrets', () => {
    // Same reasoning as the empty-env-token case — scrubbing "" would
    // turn every empty string in the envelope into [REDACTED].
    expect(
      collectSecrets(
        { MONDAY_API_TOKEN: 'env-tok' },
        ['', 'cred-tok-a', ''],
      ),
    ).toEqual(['env-tok', 'cred-tok-a']);
  });

  it('defaults extraSecrets to an empty list when omitted', () => {
    // Backward-compatible signature: pre-§7.4.3 callers passing only
    // env keep working.
    expect(collectSecrets({ MONDAY_API_TOKEN: 'env-tok' })).toEqual([
      'env-tok',
    ]);
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

  it('redacts runtimeSecrets via the value-scan layer (cli-design §7.4.3)', () => {
    // Credentials-cache-only flow: no env token, but a cached
    // access_token leaked into the error chain through, e.g., a
    // post-login `account { id }` probe whose error.message echoed
    // back the auth header value.
    const cached = 'tok-cred-leak-deadbeef-canary';
    const { stderr, read } = captureStderr();
    writeErrorEnvelope(
      new ApiError(
        'unauthorized',
        `request failed with cached creds ${cached}`,
      ),
      {
        stderr,
        env: {},
        runtimeSecrets: [cached],
        meta: buildMetaForTest(),
      },
    );
    const out = read();
    expect(out).not.toContain(cached);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts both env token and runtimeSecrets simultaneously', () => {
    // Mixed flow: env token set AND a credentials-cache profile
    // present. Both must scrub.
    const envTok = 'tok-env-aaaabbbbcccc';
    const credTok = 'tok-cred-ddddeeeeffff';
    const { stderr, read } = captureStderr();
    writeErrorEnvelope(
      new ApiError(
        'forbidden',
        `presented env=${envTok} cached=${credTok}`,
      ),
      {
        stderr,
        env: { MONDAY_API_TOKEN: envTok },
        runtimeSecrets: [credTok],
        meta: buildMetaForTest(),
      },
    );
    const out = read();
    expect(out).not.toContain(envTok);
    expect(out).not.toContain(credTok);
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
