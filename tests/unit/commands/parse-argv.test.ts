import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseArgv } from '../../../src/commands/parse-argv.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('parseArgv', () => {
  const schema = z
    .object({
      id: z.string().regex(/^\d+$/u),
      limit: z.coerce.number().int().positive().optional(),
    })
    .strict();

  it('returns parsed input on success', () => {
    expect(parseArgv(schema, { id: '5', limit: '10' })).toEqual({
      id: '5',
      limit: 10,
    });
  });

  it('throws UsageError with structured details on failure', () => {
    let caught: unknown = undefined;
    try {
      parseArgv(schema, { id: 'abc' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as UsageError).code).toBe('usage_error');
    expect((caught as UsageError).details).toMatchObject({
      issues: [{ path: 'id' }],
    });
    expect((caught as UsageError).message).toContain('id:');
  });

  it('summarises multiple issues into the message', () => {
    let caught: UsageError | undefined;
    try {
      parseArgv(schema, { id: 'x', extra: 'no' });
    } catch (e) {
      caught = e as UsageError;
    }
    expect(caught).toBeInstanceOf(UsageError);
    const issues = (caught?.details?.issues ?? []) as readonly { path: string }[];
    expect(issues.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves the ZodError as cause for downstream debug', () => {
    let caught: UsageError | undefined;
    try {
      parseArgv(schema, { id: 'abc' });
    } catch (e) {
      caught = e as UsageError;
    }
    expect(caught?.cause).toBeInstanceOf(z.ZodError);
  });
});
