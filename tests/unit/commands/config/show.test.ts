import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConfigShowOutput,
  configShowCommand,
  configShowOutputSchema,
} from '../../../../src/commands/config/show.js';

describe('buildConfigShowOutput', () => {
  it('reports api_token as <unset> when env is empty', () => {
    const out = buildConfigShowOutput({}, { loadDotenv: false });
    expect(out.auth).toBe('unset');
  });

  it('reports api_token as <set> without leaking the value', () => {
    const literal = 'tok-leakcheck-xxxx';
    const out = buildConfigShowOutput(
      { MONDAY_API_TOKEN: literal },
      { loadDotenv: false },
    );
    expect(out.auth).toBe('set');
    // The shape itself never carries the literal anywhere.
    expect(JSON.stringify(out)).not.toContain(literal);
  });

  it('treats an empty-string MONDAY_API_TOKEN as <unset>', () => {
    const out = buildConfigShowOutput(
      { MONDAY_API_TOKEN: '' },
      { loadDotenv: false },
    );
    expect(out.auth).toBe('unset');
  });

  it('reports defaults when the optional vars are missing', () => {
    const out = buildConfigShowOutput({}, { loadDotenv: false });
    expect(out.api_version).toEqual({ state: 'default', value: '2026-01' });
    expect(out.api_url).toEqual({
      state: 'default',
      value: 'https://api.monday.com/v2',
    });
    expect(out.request_timeout_ms).toEqual({ state: 'default', value: 30_000 });
    expect(out.profile).toEqual({ state: 'default' });
  });

  it('reports explicit values when set', () => {
    const out = buildConfigShowOutput(
      {
        MONDAY_API_TOKEN: 'tok-leakcheck-xxxx',
        MONDAY_API_VERSION: '2026-04',
        MONDAY_API_URL: 'https://example.test/graphql',
        MONDAY_REQUEST_TIMEOUT_MS: '5000',
        MONDAY_PROFILE: 'work',
      },
      { loadDotenv: false },
    );
    expect(out.api_version).toEqual({ state: 'explicit', value: '2026-04' });
    expect(out.api_url).toEqual({
      state: 'explicit',
      value: 'https://example.test/graphql',
    });
    expect(out.request_timeout_ms).toEqual({ state: 'explicit', value: 5000 });
    expect(out.profile).toEqual({ state: 'explicit', value: 'work' });
  });

  it('falls back to default when timeout is non-numeric or non-positive', () => {
    // Codex review §2: `parseInt('5000abc', 10)` returns `5000`, which
    // is a lying-diagnostic — `loadConfig`'s zod coercion rejects it.
    // The command now uses the same `z.coerce.number().int().positive()`
    // so the diagnostic matches the strict path.
    expect(
      buildConfigShowOutput(
        { MONDAY_REQUEST_TIMEOUT_MS: 'oops' },
        { loadDotenv: false },
      ).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
    expect(
      buildConfigShowOutput(
        { MONDAY_REQUEST_TIMEOUT_MS: '5000abc' },
        { loadDotenv: false },
      ).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
    expect(
      buildConfigShowOutput(
        { MONDAY_REQUEST_TIMEOUT_MS: '0' },
        { loadDotenv: false },
      ).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
    expect(
      buildConfigShowOutput(
        { MONDAY_REQUEST_TIMEOUT_MS: '' },
        { loadDotenv: false },
      ).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
  });

  it('passes the outputSchema validation', () => {
    const out = buildConfigShowOutput(
      {
        MONDAY_API_TOKEN: 'tok-leakcheck-xxxx',
        MONDAY_PROFILE: 'work',
      },
      { loadDotenv: false },
    );
    expect(() => configShowOutputSchema.parse(out)).not.toThrow();
  });
});

describe('buildConfigShowOutput — .env loading (Codex review §2)', () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'monday-cli-cfgshow-'));
  });
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('reports auth=set when MONDAY_API_TOKEN is only in .env', async () => {
    await writeFile(join(cwd, '.env'), 'MONDAY_API_TOKEN=tok-from-dotenv\n');
    const env: NodeJS.ProcessEnv = {};
    const out = buildConfigShowOutput(env, { cwd, loadDotenv: true });
    expect(out.auth).toBe('set');
    // The env was mutated by dotenv (override:false, but the entry
    // wasn't there before) — the diagnostic and the runtime path
    // observe the same world from this point forward.
    expect(env.MONDAY_API_TOKEN).toBe('tok-from-dotenv');
  });

  it('keeps shell-exported values when both shell and .env set the var', async () => {
    await writeFile(join(cwd, '.env'), 'MONDAY_API_VERSION=2026-99\n');
    const env: NodeJS.ProcessEnv = { MONDAY_API_VERSION: '2026-04' };
    const out = buildConfigShowOutput(env, { cwd, loadDotenv: true });
    // override:false → shell wins.
    expect(out.api_version).toEqual({ state: 'explicit', value: '2026-04' });
  });

  it('does not load .env when loadDotenv:false', async () => {
    await writeFile(join(cwd, '.env'), 'MONDAY_API_TOKEN=tok-from-dotenv\n');
    const out = buildConfigShowOutput({}, { cwd, loadDotenv: false });
    expect(out.auth).toBe('unset');
  });
});

describe('configShowCommand metadata', () => {
  it('declares idempotent=true and at least one usage example', () => {
    expect(configShowCommand.idempotent).toBe(true);
    expect(configShowCommand.examples.length).toBeGreaterThan(0);
    expect(configShowCommand.examples[0]).toMatch(/^monday config show/u);
  });

  it('uses a dotted command name for the registry/schema lookup', () => {
    expect(configShowCommand.name).toBe('config.show');
  });
});
