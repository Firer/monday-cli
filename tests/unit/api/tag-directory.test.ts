/**
 * Surface-level tests for the v0.3-M19 pre-flight `tag-directory.ts`
 * stub. The full runtime + cache-then-live + miss-collection tests
 * land at M19 implementation alongside the `tags` friendly
 * translator; this suite pins the type-level surface (so the
 * exports compile + are reachable) and confirms the stub bodies
 * throw the documented pre-flight error shape.
 *
 * Mirrors the v0.2-plan precedent set by stub-pre-flight modules
 * landing in M-prefix contract diffs: type-imports + stub-throw
 * assertions that cover the public surface without re-implementing
 * what the M19 implementation will own.
 */

import { describe, expect, it } from 'vitest';
import {
  loadAccountTags,
  resolveTags,
  type AccountTag,
  type LoadAccountTagsResult,
  type ResolveTagsInputs,
  type ResolveTagsResult,
} from '../../../src/api/tag-directory.js';
import type { MondayClient } from '../../../src/api/client.js';
import { ApiError } from '../../../src/utils/errors.js';

const stubClient = {} as unknown as MondayClient;

describe('tag-directory pre-flight surface', () => {
  it('exports the AccountTag interface with id + name (numeric-string id)', () => {
    const sample: AccountTag = { id: '123', name: 'launch' };
    expect(sample.id).toBe('123');
    expect(sample.name).toBe('launch');
  });

  it('exports ResolveTagsInputs / ResolveTagsResult / LoadAccountTagsResult shapes', () => {
    const inputs: ResolveTagsInputs = {
      client: stubClient,
      input: 'launch,priority',
    };
    expect(inputs.input).toBe('launch,priority');

    const result: ResolveTagsResult = {
      ids: [1, 2],
      misses: [],
      source: 'cache',
    };
    expect(result.ids).toEqual([1, 2]);

    const dirResult: LoadAccountTagsResult = {
      tags: [],
      source: 'live',
      cacheAgeSeconds: null,
    };
    expect(dirResult.cacheAgeSeconds).toBeNull();
  });
});

describe('resolveTags (stub)', () => {
  it('throws an internal_error ApiError until M19 implementation lands', async () => {
    await expect(resolveTags({ client: stubClient, input: 'launch' })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(resolveTags({ client: stubClient, input: 'launch' })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('carries a hint pointing at the M19 implementation session', async () => {
    await expect(
      resolveTags({ client: stubClient, input: 'foo' }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        hint: expect.stringContaining('M19') as string,
      }) as Record<string, unknown>,
    });
  });
});

describe('loadAccountTags (stub)', () => {
  it('throws an internal_error ApiError until M19 implementation lands', async () => {
    await expect(loadAccountTags({ client: stubClient })).rejects.toBeInstanceOf(
      ApiError,
    );
    await expect(loadAccountTags({ client: stubClient })).rejects.toMatchObject({
      code: 'internal_error',
    });
  });

  it('carries a hint pointing at the M19 implementation session', async () => {
    await expect(
      loadAccountTags({ client: stubClient }),
    ).rejects.toMatchObject({
      details: expect.objectContaining({
        hint: expect.stringContaining('M19') as string,
      }) as Record<string, unknown>,
    });
  });
});
