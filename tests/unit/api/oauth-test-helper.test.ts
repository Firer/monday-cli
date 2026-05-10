/**
 * Unit tests for the `__test_oauth_helper` test seam
 * (cli-design §7.3.4) at `src/api/oauth-test-helper.ts`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TEST_OAUTH_HELPER_ENV_VAR,
  buildTestOAuthListener,
  readTestOAuthFixture,
} from '../../../src/api/oauth-test-helper.js';
import { ApiError, ConfigError } from '../../../src/utils/errors.js';

describe('TEST_OAUTH_HELPER_ENV_VAR', () => {
  it('is `__test_oauth_helper` (cli-design §7.3.4)', () => {
    expect(TEST_OAUTH_HELPER_ENV_VAR).toBe('__test_oauth_helper');
  });
});

describe('readTestOAuthFixture', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'monday-cli-oauth-fixture-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('parses a minimal fixture', async () => {
    const path = join(dir, 'f.json');
    await writeFile(path, JSON.stringify({ code: 'fixture-code' }));
    const fixture = await readTestOAuthFixture(path);
    expect(fixture.code).toBe('fixture-code');
  });

  it('parses a fixture with all four force_* flags (one at a time)', async () => {
    const path = join(dir, 'f.json');
    await writeFile(
      path,
      JSON.stringify({
        code: 'unused',
        force_authorization_failed: {
          error: 'invalid_scope',
          error_description: 'requested scope not granted',
        },
      }),
    );
    const fixture = await readTestOAuthFixture(path);
    expect(fixture.force_authorization_failed?.error).toBe('invalid_scope');
  });

  it('throws config_error on ENOENT', async () => {
    const path = join(dir, 'missing.json');
    await expect(readTestOAuthFixture(path)).rejects.toBeInstanceOf(
      ConfigError,
    );
    try {
      await readTestOAuthFixture(path);
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).code).toBe('config_error');
      expect((err as ConfigError).message).toMatch(/cannot read/u);
    }
  });

  it('throws config_error on malformed JSON', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{not json');
    await expect(readTestOAuthFixture(path)).rejects.toBeInstanceOf(
      ConfigError,
    );
    try {
      await readTestOAuthFixture(path);
      expect.fail('should have rejected');
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/not valid JSON/u);
    }
  });

  it('throws config_error on schema mismatch (unknown key)', async () => {
    const path = join(dir, 'mismatch.json');
    await writeFile(
      path,
      JSON.stringify({ code: 'x', unknown_key: true }),
    );
    await expect(readTestOAuthFixture(path)).rejects.toBeInstanceOf(
      ConfigError,
    );
    try {
      await readTestOAuthFixture(path);
      expect.fail('should have rejected');
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/documented shape/u);
    }
  });

  it('throws config_error when code is missing', async () => {
    const path = join(dir, 'no-code.json');
    await writeFile(path, JSON.stringify({ force_user_denied: true }));
    await expect(readTestOAuthFixture(path)).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('buildTestOAuthListener', () => {
  it('default fixture path: resolves with the CLI state echoed back', async () => {
    const handle = buildTestOAuthListener(
      { code: 'fixture-code' },
      'cli-generated-state',
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('code');
    if (payload.kind === 'code') {
      expect(payload.code).toBe('fixture-code');
      expect(payload.state).toBe('cli-generated-state');
    }
  });

  it('exposes port: 0 (no real socket)', () => {
    const handle = buildTestOAuthListener(
      { code: 'fixture-code' },
      'state',
    );
    expect(handle.port).toBe(0);
    handle.close(); // no-op
  });

  it('force_csrf_mismatch: returns a different state', async () => {
    const handle = buildTestOAuthListener(
      { code: 'fixture-code', force_csrf_mismatch: true },
      'palindromic-state', // not a palindrome — fine
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('code');
    if (payload.kind === 'code') {
      expect(payload.state).not.toBe('palindromic-state');
      expect(payload.state.length).toBe('palindromic-state'.length);
    }
  });

  it('force_csrf_mismatch with a palindromic state still returns a different state', async () => {
    const handle = buildTestOAuthListener(
      { code: 'fixture-code', force_csrf_mismatch: true },
      'aba',
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('code');
    if (payload.kind === 'code') {
      expect(payload.state).not.toBe('aba');
      expect(payload.state.length).toBe(3);
    }
  });

  it('force_user_denied: resolves with kind:error error:access_denied', async () => {
    const handle = buildTestOAuthListener(
      { code: 'unused', force_user_denied: true },
      'cli-state',
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('error');
    if (payload.kind === 'error') {
      expect(payload.error).toBe('access_denied');
      expect(payload.state).toBe('cli-state');
    }
  });

  it('force_authorization_failed: resolves with kind:error and the fixture error+description', async () => {
    const handle = buildTestOAuthListener(
      {
        code: 'unused',
        force_authorization_failed: {
          error: 'invalid_scope',
          error_description: 'requested scope `boards:write` not granted',
        },
      },
      'cli-state',
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('error');
    if (payload.kind === 'error') {
      expect(payload.error).toBe('invalid_scope');
      expect(payload.errorDescription).toMatch(/boards:write/u);
      expect(payload.state).toBe('cli-state');
    }
  });

  it('force_authorization_failed without error_description: resolves with undefined description', async () => {
    const handle = buildTestOAuthListener(
      {
        code: 'unused',
        force_authorization_failed: { error: 'temporary_unavailable' },
      },
      'cli-state',
    );
    const payload = await handle.awaitRedirect();
    expect(payload.kind).toBe('error');
    if (payload.kind === 'error') {
      expect(payload.error).toBe('temporary_unavailable');
      expect(payload.errorDescription).toBeUndefined();
    }
  });

  it('force_listener_timeout: rejects with oauth_failed.timeout (retryable: true)', async () => {
    const handle = buildTestOAuthListener(
      { code: 'unused', force_listener_timeout: true },
      'cli-state',
    );
    // Only one awaitRedirect call — the helper guards against
    // double-awaits with `internal_error` (next test).
    try {
      await handle.awaitRedirect();
      expect.fail('should have rejected');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      const ae = err as ApiError;
      expect(ae.code).toBe('oauth_failed');
      expect(ae.details?.reason).toBe('timeout');
      expect(ae.retryable).toBe(true);
    }
  });

  it('double-await: second await rejects with internal_error (programmer error)', async () => {
    const handle = buildTestOAuthListener(
      { code: 'fixture-code' },
      'cli-state',
    );
    await handle.awaitRedirect();
    await expect(handle.awaitRedirect()).rejects.toBeInstanceOf(ApiError);
    try {
      await handle.awaitRedirect();
      expect.fail('should have rejected');
    } catch (err) {
      const ae = err as ApiError;
      expect(ae.code).toBe('internal_error');
    }
  });
});
