import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

describe('loadConfig', () => {
  it('accepts a minimal env (token only) and applies defaults', () => {
    const config = loadConfig({ MONDAY_API_TOKEN: 'tok' });
    expect(config).toMatchObject({
      apiToken: 'tok',
      apiUrl: 'https://api.monday.com/v2',
      requestTimeoutMs: 30_000,
    });
    expect(config.apiVersion).toBeUndefined();
  });

  it('throws when the API token is missing', () => {
    expect(() => loadConfig({})).toThrow(/MONDAY_API_TOKEN/u);
  });

  it('rejects malformed apiVersion strings', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_API_VERSION: 'spring-2026' }),
    ).toThrow();
  });

  it('rejects non-URL apiUrl', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_API_URL: 'not-a-url' }),
    ).toThrow();
  });

  it('coerces requestTimeoutMs from string', () => {
    const config = loadConfig({
      MONDAY_API_TOKEN: 'tok',
      MONDAY_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('rejects non-positive timeouts', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_REQUEST_TIMEOUT_MS: '0' }),
    ).toThrow();
  });
});

describe('loadConfig — dotenv loading', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'monday-cli-config-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('reads values from a .env file in cwd when loadDotenv is on', () => {
    writeFileSync(
      join(workDir, '.env'),
      'MONDAY_API_TOKEN=from-dotenv\nMONDAY_API_VERSION=2026-01\n',
    );

    const env: NodeJS.ProcessEnv = {};
    const config = loadConfig(env, { loadDotenv: true, cwd: workDir });

    expect(config.apiToken).toBe('from-dotenv');
    expect(config.apiVersion).toBe('2026-01');
  });

  it('lets process-env values override .env defaults (existing-set wins)', () => {
    writeFileSync(
      join(workDir, '.env'),
      'MONDAY_API_TOKEN=from-dotenv\nMONDAY_API_URL=https://example.test/dotenv\n',
    );

    const env: NodeJS.ProcessEnv = {
      MONDAY_API_TOKEN: 'from-shell',
    };
    const config = loadConfig(env, { loadDotenv: true, cwd: workDir });

    // Shell-exported value wins for an already-set key…
    expect(config.apiToken).toBe('from-shell');
    // …but unset keys still pick up the .env default.
    expect(config.apiUrl).toBe('https://example.test/dotenv');
  });

  it('does not read a .env file when loadDotenv is off', () => {
    writeFileSync(join(workDir, '.env'), 'MONDAY_API_TOKEN=from-dotenv\n');

    expect(() =>
      loadConfig({}, { loadDotenv: false, cwd: workDir }),
    ).toThrow(/MONDAY_API_TOKEN/u);
  });

  it('silently no-ops when there is no .env file in cwd', () => {
    const config = loadConfig(
      { MONDAY_API_TOKEN: 'tok' },
      { loadDotenv: true, cwd: workDir },
    );

    expect(config.apiToken).toBe('tok');
  });
});
