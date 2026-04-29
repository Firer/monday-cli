import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  type MetaInput,
} from '../../../../src/utils/output/envelope.js';
import { renderNdjson } from '../../../../src/utils/output/ndjson.js';

const baseMetaInput: MetaInput = {
  api_version: '2026-01',
  cli_version: '0.0.0',
  request_id: 'req-1',
  source: 'live',
  retrieved_at: '2026-04-29T10:00:00Z',
  next_cursor: 'abc',
  has_more: false,
  total_returned: 2,
};

const collect = (): {
  stream: PassThrough;
  read: () => string[];
} => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return {
    stream,
    read: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.length > 0),
  };
};

describe('renderNdjson', () => {
  it('emits one JSON resource per line plus a _meta trailer', () => {
    const { stream, read } = collect();
    renderNdjson(
      {
        data: [
          { id: '1', name: 'A' },
          { id: '2', name: 'B' },
        ],
        meta: buildMeta(baseMetaInput),
        warnings: [],
      },
      stream,
    );
    const lines = read();
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!)).toEqual({ id: '1', name: 'A' });
    expect(JSON.parse(lines[1]!)).toEqual({ id: '2', name: 'B' });
    const trailer = JSON.parse(lines[2]!) as { _meta: { has_more: boolean } };
    expect(trailer._meta.has_more).toBe(false);
  });

  it('emits only the trailer for an empty collection', () => {
    const { stream, read } = collect();
    renderNdjson(
      { data: [], meta: buildMeta(baseMetaInput), warnings: [] },
      stream,
    );
    const lines = read();
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0]!) as { _meta: object })._meta).toBeDefined();
  });

  it('attaches warnings as a sibling field of _meta when present', () => {
    const { stream, read } = collect();
    renderNdjson(
      {
        data: [{ id: '1' }],
        meta: buildMeta(baseMetaInput),
        warnings: [{ code: 'stale_cache', message: 'served from cache' }],
      },
      stream,
    );
    const lines = read();
    const trailer = JSON.parse(lines[lines.length - 1]!) as {
      _meta: object;
      warnings: { code: string }[];
    };
    expect(trailer.warnings).toEqual([
      { code: 'stale_cache', message: 'served from cache' },
    ]);
  });

  it('omits the warnings sibling when there are none', () => {
    const { stream, read } = collect();
    renderNdjson(
      { data: [{ id: '1' }], meta: buildMeta(baseMetaInput), warnings: [] },
      stream,
    );
    const lines = read();
    const trailer = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect('warnings' in trailer).toBe(false);
  });

  it('does not pretty-print resource lines (one item = one line)', () => {
    const { stream, read } = collect();
    renderNdjson(
      {
        data: [{ id: '1', nested: { a: 1, b: 2 } }],
        meta: buildMeta(baseMetaInput),
        warnings: [],
      },
      stream,
    );
    const lines = read();
    // Sanity: nested object stays on the resource line.
    expect(lines[0]).toBe('{"id":"1","nested":{"a":1,"b":2}}');
  });
});
