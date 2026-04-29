import { describe, expect, it } from 'vitest';
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
