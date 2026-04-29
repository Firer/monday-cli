import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderJson } from '../../../../src/utils/output/json.js';

const collect = (): {
  stream: PassThrough;
  read: () => string;
} => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () => Buffer.concat(chunks).toString('utf8'),
  };
};

describe('renderJson', () => {
  it('emits indented JSON with a trailing newline', () => {
    const { stream, read } = collect();
    renderJson({ ok: true, data: { id: '1' } }, stream);
    const out = read();
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('  "ok": true');
    expect(out).toContain('  "data": {');
    expect(JSON.parse(out)).toEqual({ ok: true, data: { id: '1' } });
  });

  it('preserves insertion order in the rendered output', () => {
    const { stream, read } = collect();
    renderJson(
      { ok: true, data: null, meta: { schema_version: '1' }, warnings: [] },
      stream,
    );
    const out = read();
    const okPos = out.indexOf('"ok"');
    const dataPos = out.indexOf('"data"');
    const metaPos = out.indexOf('"meta"');
    const warningsPos = out.indexOf('"warnings"');
    expect(okPos).toBeLessThan(dataPos);
    expect(dataPos).toBeLessThan(metaPos);
    expect(metaPos).toBeLessThan(warningsPos);
  });
});
