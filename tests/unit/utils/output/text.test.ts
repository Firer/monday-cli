import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderText } from '../../../../src/utils/output/text.js';

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

describe('renderText', () => {
  it('emits one key:value line per top-level field', () => {
    const { stream, read } = collect();
    renderText({ data: { id: '1', name: 'Alice', active: true } }, stream);
    expect(read()).toBe('id: 1\nname: Alice\nactive: true\n');
  });

  it('preserves declaration order', () => {
    const { stream, read } = collect();
    renderText({ data: { c: 1, a: 2, b: 3 } }, stream);
    expect(read()).toBe('c: 1\na: 2\nb: 3\n');
  });

  it('renders null explicitly and undefined as empty', () => {
    const { stream, read } = collect();
    renderText({ data: { absent: null, missing: undefined } }, stream);
    expect(read()).toBe('absent: null\nmissing: \n');
  });

  it('JSON-stringifies nested objects/arrays inline', () => {
    const { stream, read } = collect();
    renderText({ data: { tags: ['a', 'b'], owner: { id: '1' } } }, stream);
    expect(read()).toBe('tags: ["a","b"]\nowner: {"id":"1"}\n');
  });

  it('handles an empty record', () => {
    const { stream, read } = collect();
    renderText({ data: {} }, stream);
    expect(read()).toBe('');
  });
});
