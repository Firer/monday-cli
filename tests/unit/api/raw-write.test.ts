/**
 * Unit tests for `--set-raw` escape-hatch helpers
 * (`src/api/raw-write.ts`, M8 step 3).
 *
 * Two surfaces, two describe blocks:
 *   - `parseSetRawExpression` — argv-parse-time JSON validation.
 *   - `translateRawColumnValue` — post-resolution type gating.
 *
 * Plus a third describe for the round-trip through `selectMutation`,
 * pinning that `--set-raw` payloads dispatch through the same
 * `change_column_value` / `change_multiple_column_values` paths as
 * the friendly translator.
 */
import { describe, expect, it } from 'vitest';
import {
  parseSetRawExpression,
  translateRawColumnValue,
} from '../../../src/api/raw-write.js';
import {
  selectMutation,
  type SelectedMutation,
  type TranslatedColumnValue,
} from '../../../src/api/column-values.js';
import { ApiError, UsageError } from '../../../src/utils/errors.js';

describe('parseSetRawExpression — happy paths', () => {
  it('splits <col>=<json> on first = and parses JSON object', () => {
    expect(parseSetRawExpression('status={"label":"Done"}')).toEqual({
      token: 'status',
      value: { label: 'Done' },
      rawJson: '{"label":"Done"}',
    });
  });

  it('extra "=" inside JSON values land in the JSON segment', () => {
    expect(
      parseSetRawExpression('text={"text":"a=b=c"}'),
    ).toEqual({
      token: 'text',
      value: { text: 'a=b=c' },
      rawJson: '{"text":"a=b=c"}',
    });
  });

  it('supports id:/title: prefix tokens (resolution is downstream)', () => {
    expect(parseSetRawExpression('id:status_4={"index":1}')).toEqual({
      token: 'id:status_4',
      value: { index: 1 },
      rawJson: '{"index":1}',
    });
    expect(parseSetRawExpression('title:Status={"label":"Done"}')).toEqual({
      token: 'title:Status',
      value: { label: 'Done' },
      rawJson: '{"label":"Done"}',
    });
  });

  it('preserves nested objects + arrays in the parsed value', () => {
    expect(
      parseSetRawExpression(
        'people={"personsAndTeams":[{"id":1,"kind":"person"}]}',
      ),
    ).toEqual({
      token: 'people',
      value: {
        personsAndTeams: [{ id: 1, kind: 'person' }],
      },
      rawJson: '{"personsAndTeams":[{"id":1,"kind":"person"}]}',
    });
  });

  it('preserves Unicode in keys + values verbatim', () => {
    expect(
      parseSetRawExpression('text={"text":"日本語 / café"}'),
    ).toEqual({
      token: 'text',
      value: { text: '日本語 / café' },
      rawJson: '{"text":"日本語 / café"}',
    });
  });
});

describe('parseSetRawExpression — error paths', () => {
  it('missing "=" → usage_error', () => {
    expect(() => parseSetRawExpression('status')).toThrow(UsageError);
    try {
      parseSetRawExpression('status');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/expected <col>=<json>/u);
    }
  });

  it('empty token (leading "=") → usage_error', () => {
    expect(() => parseSetRawExpression('={"label":"Done"}')).toThrow(
      UsageError,
    );
  });

  it('empty <json> after "=" → usage_error', () => {
    expect(() => parseSetRawExpression('status=')).toThrow(
      /empty <json>/u,
    );
  });

  it('malformed JSON → usage_error preserving SyntaxError message', () => {
    expect(() => parseSetRawExpression('status={broken')).toThrow(UsageError);
    try {
      parseSetRawExpression('status={broken');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/JSON parse failed/u);
      expect(err.details).toMatchObject({
        token: 'status',
        raw_json: '{broken',
      });
    }
  });

  it('JSON null at top level → usage_error (must be object)', () => {
    expect(() => parseSetRawExpression('status=null')).toThrow(UsageError);
    try {
      parseSetRawExpression('status=null');
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/expected a JSON object/u);
      expect((err.details as { parsed_shape: string }).parsed_shape).toBe(
        'null',
      );
    }
  });

  it('JSON string at top level → usage_error', () => {
    expect(() => parseSetRawExpression('status="Done"')).toThrow(
      /expected a JSON object/u,
    );
  });

  it('JSON number at top level → usage_error', () => {
    expect(() => parseSetRawExpression('status=42')).toThrow(
      /expected a JSON object/u,
    );
  });

  it('JSON boolean at top level → usage_error', () => {
    expect(() => parseSetRawExpression('status=true')).toThrow(
      /expected a JSON object/u,
    );
  });

  it('JSON array at top level → usage_error (Monday wire shapes are objects)', () => {
    expect(() => parseSetRawExpression('tags=[1,2,3]')).toThrow(UsageError);
    try {
      parseSetRawExpression('tags=[1,2,3]');
    } catch (e) {
      const err = e as UsageError;
      expect((err.details as { parsed_shape: string }).parsed_shape).toBe(
        'array',
      );
    }
  });

  it('parse error preserves cause for downstream debugging', () => {
    try {
      parseSetRawExpression('status={broken');
    } catch (e) {
      const err = e as UsageError;
      expect(err.cause).toBeInstanceOf(SyntaxError);
    }
  });
});

describe('translateRawColumnValue — happy paths', () => {
  it('writable v0.1 type → rich payload, raw input echoed', () => {
    const out = translateRawColumnValue(
      { id: 'status_4', type: 'status' },
      { label: 'Done' },
      '{"label":"Done"}',
    );
    expect(out).toEqual<TranslatedColumnValue>({
      columnId: 'status_4',
      columnType: 'status',
      rawInput: '{"label":"Done"}',
      payload: { format: 'rich', value: { label: 'Done' } },
      resolvedFrom: null,
      peopleResolution: null,
    });
  });

  it('M8 firm v0.2 type (link) → rich payload accepted', () => {
    // The escape hatch and the friendly translator both produce
    // `change_column_value` payloads for `link`. cli-design §5.3
    // line 940-948: "The user took the escape hatch and owns
    // wire-shape correctness."
    const out = translateRawColumnValue(
      { id: 'site', type: 'link' },
      { url: 'https://example.com', text: '' },
      '{"url":"https://example.com","text":""}',
    );
    expect(out.payload).toEqual({
      format: 'rich',
      value: { url: 'https://example.com', text: '' },
    });
  });

  it('v0.2 tentative type (tags) accepted via --set-raw (escape hatch covers tentatives)', () => {
    // The whole point of --set-raw: tentative-row types whose
    // friendly translator hasn't landed are reachable through the
    // escape hatch. cli-design §5.3 line 946-948.
    const out = translateRawColumnValue(
      { id: 'tags_1', type: 'tags' },
      { tag_ids: [1, 2] },
      '{"tag_ids":[1,2]}',
    );
    expect(out.columnId).toBe('tags_1');
    expect(out.columnType).toBe('tags');
    expect(out.payload).toEqual({
      format: 'rich',
      value: { tag_ids: [1, 2] },
    });
  });

  it('future-roadmap type accepted (escape hatch covers any change_column_value-shaped type)', () => {
    // `battery` is on the future-roadmap row but Monday accepts
    // arbitrary JSON for it (the user owns wire-shape correctness).
    // The CLI has no per-type schema check; Monday rejects bad
    // payloads as `validation_failed`.
    const out = translateRawColumnValue(
      { id: 'battery_1', type: 'battery' },
      { progress: 75 },
      '{"progress":75}',
    );
    expect(out.payload).toEqual({
      format: 'rich',
      value: { progress: 75 },
    });
  });

  it('preserves rawInput for the dry-run diff context', () => {
    const out = translateRawColumnValue(
      { id: 'status_4', type: 'status' },
      { index: 1 },
      '{"index":1}',
    );
    expect(out.rawInput).toBe('{"index":1}');
  });
});

describe('translateRawColumnValue — error paths (post-resolution gates)', () => {
  it.each([
    'mirror',
    'formula',
    'auto_number',
    'creation_log',
    'last_updated',
    'item_id',
  ])(
    'read-only-forever type (%s) → unsupported_column_type with read_only: true',
    (type) => {
      expect(() =>
        translateRawColumnValue(
          { id: 'col_x', type },
          { whatever: 1 },
          '{"whatever":1}',
        ),
      ).toThrow(ApiError);
      try {
        translateRawColumnValue(
          { id: 'col_x', type },
          { whatever: 1 },
          '{"whatever":1}',
        );
      } catch (e) {
        const err = e as ApiError;
        expect(err.code).toBe('unsupported_column_type');
        expect(err.details).toMatchObject({
          column_id: 'col_x',
          type,
          read_only: true,
        });
        // Critical: read-only-forever errors must NOT advertise
        // --set-raw as a workaround, because we ARE the --set-raw
        // path. The hint must point at the underlying source column.
        expect(err.details).not.toHaveProperty('deferred_to');
      }
    },
  );

  it('files-shaped type (file) → unsupported_column_type with deferred_to: v0.4', () => {
    expect(() =>
      translateRawColumnValue(
        { id: 'attachments', type: 'file' },
        { something: 1 },
        '{"something":1}',
      ),
    ).toThrow(ApiError);
    try {
      translateRawColumnValue(
        { id: 'attachments', type: 'file' },
        { something: 1 },
        '{"something":1}',
      );
    } catch (e) {
      const err = e as ApiError;
      expect(err.code).toBe('unsupported_column_type');
      expect(err.details).toMatchObject({
        column_id: 'attachments',
        type: 'file',
        deferred_to: 'v0.4',
      });
      expect(err.details).not.toHaveProperty('read_only');
    }
  });

  it('hint on files-shaped error mentions add_file_to_column (the right wire surface)', () => {
    try {
      translateRawColumnValue(
        { id: 'attachments', type: 'file' },
        { url: 'x' },
        '{"url":"x"}',
      );
    } catch (e) {
      const err = e as ApiError;
      expect((err.details as { hint: string }).hint).toMatch(
        /add_file_to_column/u,
      );
    }
  });
});

describe('--set-raw → selectMutation round-trip', () => {
  it('single raw payload → change_column_value (always rich, never simple)', () => {
    // cli-design §5.3 line 898-901: "--set-raw always uses
    // change_column_value for the single-column case... the simple
    // variant is an optimisation that doesn't apply to user-supplied
    // raw payloads." A raw payload for a `text` column still goes
    // through change_column_value, not change_simple_column_value.
    const translated = translateRawColumnValue(
      { id: 'text_1', type: 'text' },
      { text: 'hi' },
      '{"text":"hi"}',
    );
    const out = selectMutation([translated]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_column_value',
      columnId: 'text_1',
      value: { text: 'hi' },
    });
  });

  it('raw payload bundled with friendly translation → change_multiple_column_values', () => {
    // Raw + friendly mix freely — selectMutation doesn't distinguish
    // the source. cli-design §5.3 line 894-897 + line 898-901.
    const friendly: TranslatedColumnValue = {
      columnId: 'status_4',
      columnType: 'status',
      rawInput: 'Done',
      payload: { format: 'rich', value: { label: 'Done' } },
      resolvedFrom: null,
      peopleResolution: null,
    };
    const raw = translateRawColumnValue(
      { id: 'tags_1', type: 'tags' },
      { tag_ids: [1, 2] },
      '{"tag_ids":[1,2]}',
    );
    const out = selectMutation([friendly, raw]);
    expect(out).toEqual<SelectedMutation>({
      kind: 'change_multiple_column_values',
      columnValues: {
        status_4: { label: 'Done' },
        tags_1: { tag_ids: [1, 2] },
      },
    });
  });

  it('two raw payloads against same column → usage_error from selectMutation (mutual-exclusion enforcement)', () => {
    // cli-design §5.3 line 961-972: "--set <col>=<val> and --set-raw
    // <col>=<json> against the same <col> ... are mutually exclusive.
    // Detection is resolution-time, not parse-time." selectMutation
    // owns the duplicate-column-id check; --set-raw + --set against
    // the same resolved column ID surface as usage_error from there.
    const raw1 = translateRawColumnValue(
      { id: 'status_4', type: 'status' },
      { label: 'Done' },
      '{"label":"Done"}',
    );
    const raw2 = translateRawColumnValue(
      { id: 'status_4', type: 'status' },
      { index: 1 },
      '{"index":1}',
    );
    expect(() => selectMutation([raw1, raw2])).toThrow(UsageError);
    try {
      selectMutation([raw1, raw2]);
    } catch (e) {
      const err = e as UsageError;
      expect(err.message).toMatch(/Multiple --set values target column/u);
      expect((err.details as { column_id: string }).column_id).toBe('status_4');
    }
  });
});
