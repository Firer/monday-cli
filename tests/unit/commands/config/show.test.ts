import { describe, expect, it } from 'vitest';
import {
  buildConfigShowOutput,
  configShowCommand,
  configShowOutputSchema,
} from '../../../../src/commands/config/show.js';

describe('buildConfigShowOutput', () => {
  it('reports api_token as <unset> when env is empty', () => {
    const out = buildConfigShowOutput({});
    expect(out.auth).toBe('unset');
  });

  it('reports api_token as <set> without leaking the value', () => {
    const literal = 'tok-leakcheck-xxxx';
    const out = buildConfigShowOutput({ MONDAY_API_TOKEN: literal });
    expect(out.auth).toBe('set');
    // The shape itself never carries the literal anywhere.
    expect(JSON.stringify(out)).not.toContain(literal);
  });

  it('treats an empty-string MONDAY_API_TOKEN as <unset>', () => {
    const out = buildConfigShowOutput({ MONDAY_API_TOKEN: '' });
    expect(out.auth).toBe('unset');
  });

  it('reports defaults when the optional vars are missing', () => {
    const out = buildConfigShowOutput({});
    expect(out.api_version).toEqual({ state: 'default', value: '2026-01' });
    expect(out.api_url).toEqual({
      state: 'default',
      value: 'https://api.monday.com/v2',
    });
    expect(out.request_timeout_ms).toEqual({ state: 'default', value: 30_000 });
    expect(out.profile).toEqual({ state: 'default' });
  });

  it('reports explicit values when set', () => {
    const out = buildConfigShowOutput({
      MONDAY_API_TOKEN: 'tok-leakcheck-xxxx',
      MONDAY_API_VERSION: '2026-04',
      MONDAY_API_URL: 'https://example.test/graphql',
      MONDAY_REQUEST_TIMEOUT_MS: '5000',
      MONDAY_PROFILE: 'work',
    });
    expect(out.api_version).toEqual({ state: 'explicit', value: '2026-04' });
    expect(out.api_url).toEqual({
      state: 'explicit',
      value: 'https://example.test/graphql',
    });
    expect(out.request_timeout_ms).toEqual({ state: 'explicit', value: 5000 });
    expect(out.profile).toEqual({ state: 'explicit', value: 'work' });
  });

  it('falls back to default when timeout is non-numeric or non-positive', () => {
    expect(
      buildConfigShowOutput({ MONDAY_REQUEST_TIMEOUT_MS: 'oops' }).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
    expect(
      buildConfigShowOutput({ MONDAY_REQUEST_TIMEOUT_MS: '0' }).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
    expect(
      buildConfigShowOutput({ MONDAY_REQUEST_TIMEOUT_MS: '' }).request_timeout_ms,
    ).toEqual({ state: 'default', value: 30_000 });
  });

  it('passes the outputSchema validation', () => {
    const out = buildConfigShowOutput({
      MONDAY_API_TOKEN: 'tok-leakcheck-xxxx',
      MONDAY_PROFILE: 'work',
    });
    expect(() => configShowOutputSchema.parse(out)).not.toThrow();
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
