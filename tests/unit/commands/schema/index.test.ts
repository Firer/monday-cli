import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  buildSchemaOutput,
  schemaCommand,
  schemaOutputSchema,
  type SchemaOutput,
} from '../../../../src/commands/schema/index.js';
import { getCommandRegistry } from '../../../../src/commands/index.js';
import { ERROR_CODES } from '../../../../src/utils/errors.js';

const buildFull = (): SchemaOutput =>
  buildSchemaOutput({
    modules: getCommandRegistry(),
    apiVersion: '2026-01',
    cliVersion: '0.0.0-test',
  });

describe('buildSchemaOutput — top-level shape', () => {
  it('passes the outputSchema validation', () => {
    expect(() => schemaOutputSchema.parse(buildFull())).not.toThrow();
  });

  it('declares schema_version="1" and the supplied api/cli versions', () => {
    const out = buildFull();
    expect(out.schema_version).toBe('1');
    expect(out.api_version).toBe('2026-01');
    expect(out.cli_version).toBe('0.0.0-test');
  });

  it('lists every registered command keyed by its dotted name', () => {
    const out = buildFull();
    const keys = Object.keys(out.commands).sort();
    const expected = [...getCommandRegistry()].map((m) => m.name).sort();
    expect(keys).toEqual(expected);
  });

  it('includes every error code in error_codes with its mapped exit_code', () => {
    const out = buildFull();
    const codes = out.error_codes.map((e) => e.code).sort();
    expect(codes).toEqual([...ERROR_CODES].sort());
    const usage = out.error_codes.find((e) => e.code === 'usage_error');
    expect(usage?.exit_code).toBe(1);
    const config = out.error_codes.find((e) => e.code === 'config_error');
    expect(config?.exit_code).toBe(3);
  });

  it('includes the documented exit codes', () => {
    const out = buildFull();
    const numbers = out.exit_codes.map((e) => e.code).sort((a, b) => a - b);
    expect(numbers).toEqual([0, 1, 2, 3, 130]);
  });
});

describe('buildSchemaOutput — per-command emission', () => {
  it('emits a JSON Schema with the 2020-12 dialect for each command', () => {
    const out = buildFull();
    for (const [name, entry] of Object.entries(out.commands)) {
      const input = entry.input as { $schema?: string };
      const output = entry.output as { $schema?: string };
      expect(input.$schema, `input dialect for ${name}`).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(output.$schema, `output dialect for ${name}`).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
    }
  });

  it('schema describes itself (round-trip)', () => {
    const out = buildFull();
    expect(out.commands).toHaveProperty('schema');
    expect(out.commands).toHaveProperty('config.show');
  });

  it('emitted output JSON Schemas validate the live emitOutput', () => {
    const ajv = new Ajv2020({ strict: false });
    const out = buildFull();
    const schemaSelfEntry = out.commands.schema;
    expect(schemaSelfEntry).toBeDefined();
    const validate = ajv.compile(schemaSelfEntry?.output ?? {});
    expect(validate(out)).toBe(true);
  });

  it('emitted input JSON Schemas reject malformed input', () => {
    const ajv = new Ajv2020({ strict: false });
    const out = buildFull();
    const cacheClear = out.commands['cache.clear'];
    expect(cacheClear).toBeDefined();
    const validate = ajv.compile(cacheClear?.input ?? {});
    expect(validate({ board: '12345' })).toBe(true);
    // Unknown keys are rejected because the input schema is .strict().
    expect(validate({ bogus: true })).toBe(false);
  });
});

describe('buildSchemaOutput — narrowing via `only`', () => {
  it('emits a single command when `only` is set', () => {
    const out = buildSchemaOutput({
      modules: getCommandRegistry(),
      apiVersion: '2026-01',
      cliVersion: '0.0.0-test',
      only: 'config.show',
    });
    expect(Object.keys(out.commands)).toEqual(['config.show']);
  });

  it('throws UsageError on an unknown command name', () => {
    expect(() =>
      buildSchemaOutput({
        modules: getCommandRegistry(),
        apiVersion: '2026-01',
        cliVersion: '0.0.0-test',
        only: 'nope.does.not.exist',
      }),
    ).toThrow(/unknown command/u);
  });
});

describe('schemaCommand metadata', () => {
  it('declares idempotent=true and ≥1 example', () => {
    expect(schemaCommand.idempotent).toBe(true);
    expect(schemaCommand.examples.length).toBeGreaterThan(0);
  });

  it('uses the literal name "schema" (top-level command)', () => {
    expect(schemaCommand.name).toBe('schema');
  });
});
