import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { ConfigError } from '../../src/utils/errors.js';

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

  it('throws ConfigError when the API token is missing', () => {
    try {
      loadConfig({});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const cfgErr = err as ConfigError;
      expect(cfgErr.code).toBe('config_error');
      expect(cfgErr.message).toMatch(/MONDAY_API_TOKEN/u);
      expect(cfgErr.details?.hint).toMatch(/MONDAY_API_TOKEN/u);
    }
  });

  it('throws ConfigError on malformed apiVersion', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_API_VERSION: 'spring-2026' }),
    ).toThrow(ConfigError);
  });

  it('throws ConfigError on non-URL apiUrl', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_API_URL: 'not-a-url' }),
    ).toThrow(ConfigError);
  });

  it('attaches structured issues to ConfigError.details', () => {
    try {
      loadConfig({ MONDAY_API_TOKEN: '', MONDAY_API_VERSION: 'bad' });
      expect.fail('should have thrown');
    } catch (err) {
      const details = (err as ConfigError).details as
        | { issues: { path: string }[] }
        | undefined;
      expect(details?.issues).toBeDefined();
      const paths = details!.issues.map((i) => i.path);
      expect(paths).toContain('MONDAY_API_TOKEN');
      expect(paths).toContain('MONDAY_API_VERSION');
    }
  });

  it('coerces requestTimeoutMs from string', () => {
    const config = loadConfig({
      MONDAY_API_TOKEN: 'tok',
      MONDAY_REQUEST_TIMEOUT_MS: '5000',
    });
    expect(config.requestTimeoutMs).toBe(5000);
  });

  it('throws ConfigError on non-positive timeouts', () => {
    expect(() =>
      loadConfig({ MONDAY_API_TOKEN: 'tok', MONDAY_REQUEST_TIMEOUT_MS: '0' }),
    ).toThrow(ConfigError);
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
    ).toThrow(ConfigError);
  });

  it('silently no-ops when there is no .env file in cwd', () => {
    const config = loadConfig(
      { MONDAY_API_TOKEN: 'tok' },
      { loadDotenv: true, cwd: workDir },
    );

    expect(config.apiToken).toBe('tok');
  });
});
