/**
 * Unit tests for `src/api/column-mapping.ts` — the `--columns-mapping
 * <json>` parse boundary (M11).
 *
 * Coverage: every branch in `parseColumnMappingJson` plus the typed
 * `usage_error` shape consumers depend on. Exercises the parser with
 * the kinds of inputs commander hands the action layer (string / not
 * a string), and the JSON shapes agents are likely to send (object /
 * array / null / primitives / mixed value types / the deferred rich
 * form).
 */
import { describe, expect, it } from 'vitest';
import { parseColumnMappingJson } from '../../../src/api/column-mapping.js';
import { UsageError } from '../../../src/utils/errors.js';

describe('parseColumnMappingJson', () => {
  it('accepts a simple {<src>: <target>} object', () => {
    const result = parseColumnMappingJson(
      '{"status_4": "status_42", "due": "deadline"}',
    );
    expect(result).toEqual({ status_4: 'status_42', due: 'deadline' });
  });

  it('accepts an empty object as the explicit "drop everything" opt-in', () => {
    // cli-design §8 decision 5 — `{}` is the explicit opt-in to
    // Monday's permissive default. The parser must accept it.
    const result = parseColumnMappingJson('{}');
    expect(result).toEqual({});
  });

  it('rejects undefined / non-string raw input as usage_error', () => {
    // Defensive: commander's option parsing can theoretically hand
    // back a non-string for malformed argv. The parser surfaces this
    // as usage_error rather than letting the caller see a confusing
    // type-error inside the action.
    expect(() => parseColumnMappingJson(undefined)).toThrow(UsageError);
    expect(() => parseColumnMappingJson(42)).toThrow(UsageError);
    expect(() => parseColumnMappingJson(null)).toThrow(UsageError);
  });

  it('rejects empty string as usage_error', () => {
    expect(() => parseColumnMappingJson('')).toThrow(UsageError);
  });

  it('rejects malformed JSON as usage_error with the parser error message', () => {
    try {
      parseColumnMappingJson('not-json');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const usageErr = err as UsageError;
      expect(usageErr.message).toContain("isn't valid JSON");
      // Shell-quoting hint included so agents reading the error know
      // to wrap the JSON in quotes.
      expect((usageErr.details as { hint?: string }).hint).toContain(
        'quote the JSON',
      );
    }
  });

  it('rejects JSON null root as usage_error', () => {
    try {
      parseColumnMappingJson('null');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toContain('JSON object');
      expect(
        (err as UsageError).details as { received_kind?: string },
      ).toMatchObject({ received_kind: 'null' });
    }
  });

  it('rejects JSON array root as usage_error', () => {
    try {
      parseColumnMappingJson('[]');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect(
        (err as UsageError).details as { received_kind?: string },
      ).toMatchObject({ received_kind: 'array' });
    }
  });

  it('rejects JSON primitive root as usage_error', () => {
    expect(() => parseColumnMappingJson('42')).toThrow(UsageError);
    expect(() => parseColumnMappingJson('"a string"')).toThrow(UsageError);
    expect(() => parseColumnMappingJson('true')).toThrow(UsageError);
  });

  it('rejects rich {id, value} form (deferred to v0.3) with deferral hint', () => {
    // The plan's value-override form requires a non-atomic post-move
    // mutation; deferred to v0.3. Agents who hand-craft the rich
    // shape see a typed error pointing at the deferral and the
    // post-move workaround.
    try {
      parseColumnMappingJson(
        '{"status_4": {"id": "status_42", "value": "Done"}}',
      );
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).message).toContain('shape rejected');
      const hint = ((err as UsageError).details as { hint?: string }).hint;
      expect(hint).toContain('deferred to v0.3');
      expect(hint).toContain('monday item set');
    }
  });

  it('rejects non-string values (numbers, booleans, null) as usage_error', () => {
    expect(() => parseColumnMappingJson('{"a": 42}')).toThrow(UsageError);
    expect(() => parseColumnMappingJson('{"a": true}')).toThrow(UsageError);
    expect(() => parseColumnMappingJson('{"a": null}')).toThrow(UsageError);
  });

  it('rejects empty-string values as usage_error', () => {
    // A target column ID can't be empty — the wire shape requires a
    // non-empty string. Reject loud at the parse boundary rather than
    // sending an empty string to Monday and getting a confusing
    // wire-time error.
    expect(() => parseColumnMappingJson('{"a": ""}')).toThrow(UsageError);
  });

  it('rejects empty-string keys as usage_error', () => {
    expect(() => parseColumnMappingJson('{"": "tgt"}')).toThrow(UsageError);
  });

  it('preserves the issues array on invalid shape for agent triage', () => {
    try {
      parseColumnMappingJson('{"a": 42, "b": null}');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      const issues = ((err as UsageError).details as {
        issues?: readonly { path: string; message: string }[];
      }).issues;
      expect(issues?.length).toBeGreaterThanOrEqual(2);
      // At least one issue points at the right key.
      expect(issues?.some((i) => i.path === 'a' || i.path === 'b')).toBe(true);
    }
  });
});
