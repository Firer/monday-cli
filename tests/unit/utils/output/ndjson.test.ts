import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildMeta,
  type MetaInput,
} from '../../../../src/utils/output/envelope.js';
import {
  renderNdjson,
  startNdjsonStream,
} from '../../../../src/utils/output/ndjson.js';

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

  it('does not add a warnings sibling to the trailer (§6.3 literal)', () => {
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
    const trailer = JSON.parse(lines[lines.length - 1]!) as Record<
      string,
      unknown
    >;
    expect(Object.keys(trailer)).toEqual(['_meta']);
  });

  it('produces only `_meta` keys regardless of warnings', () => {
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
    expect(Object.keys(trailer)).toEqual(['_meta']);
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

describe('startNdjsonStream (R52, M18 lift)', () => {
  // Direct unit coverage for the lifted stream helper. Item list +
  // item search + update list integration tests exercise it end-to-
  // end; these unit tests pin the per-input contract (project
  // callback, redaction passthrough, trailer shape, one-line-per-
  // resource) so a future regression to the helper itself fails
  // here loudly without depending on any consumer's full path.

  interface RawItem {
    readonly id: string;
    readonly note?: string;
  }

  it('emits one projected line per item via onItem', async () => {
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: [],
      project: (item) => ({ id: item.id, projected: true }),
    });
    await handle.onItem({ id: '1' });
    await handle.onItem({ id: '2' });
    const lines = read();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ id: '1', projected: true });
    expect(JSON.parse(lines[1]!)).toEqual({ id: '2', projected: true });
  });

  it('runs the project callback before serialising', async () => {
    // The point of `project` is that consumers can transform raw
    // Monday rows into the projected output shape *before* JSON
    // serialisation. A consumer that hands raw rows in (no
    // project) should see them serialised raw. Field name `note`
    // intentionally chosen — `raw_token` would trigger the key-
    // based filter (per .claude/rules/security.md) and the
    // serialised output would surprise the test reader.
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: [],
      project: (item) => item, // identity
    });
    await handle.onItem({ id: '1', note: 'preserved' });
    const lines = read();
    expect(JSON.parse(lines[0]!)).toEqual({ id: '1', note: 'preserved' });
  });

  it('redacts the literal secret from each emitted line', async () => {
    // Per .claude/rules/security.md: every emitted byte goes
    // through the value-scanning redactor with the runtime token
    // value as a secret. The lifted helper must thread `secrets`
    // through to `redact()` for each item AND the trailer.
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: ['leak-token'],
      project: (item) => ({
        id: item.id,
        ...(item.note === undefined ? {} : { note: item.note }),
      }),
    });
    await handle.onItem({ id: '1', note: 'value contains leak-token in body' });
    handle.writeTrailer(
      buildMeta({
        ...baseMetaInput,
        request_id: 'leak-token-in-meta',
      }),
    );
    const lines = read();
    expect(lines.join('\n')).not.toContain('leak-token');
    // Sanity: the redaction substituted the canonical [REDACTED]
    // marker (per src/utils/redact.ts).
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[1]).toContain('[REDACTED]');
  });

  it('writeTrailer emits exactly `{"_meta":{...}}`, no sibling keys', () => {
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: [],
      project: (item) => item,
    });
    handle.writeTrailer(buildMeta(baseMetaInput));
    const lines = read();
    expect(lines).toHaveLength(1);
    const trailer = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(trailer)).toEqual(['_meta']);
    // Trailer's `_meta` carries the full Meta shape (schema_version,
    // api_version, etc.) — same shape the JSON envelope's `meta`
    // would have.
    expect((trailer._meta as { schema_version: string }).schema_version).toBe(
      '1',
    );
  });

  it('emits items one-per-line followed by the trailer (full streaming flow)', async () => {
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: [],
      project: (item) => ({ id: item.id }),
    });
    await handle.onItem({ id: 'a' });
    await handle.onItem({ id: 'b' });
    handle.writeTrailer(buildMeta(baseMetaInput));
    const lines = read();
    expect(lines).toHaveLength(3);
    // Sanity on full ordering: items, then trailer.
    expect(JSON.parse(lines[0]!)).toEqual({ id: 'a' });
    expect(JSON.parse(lines[1]!)).toEqual({ id: 'b' });
    const trailer = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(Object.keys(trailer)).toEqual(['_meta']);
  });

  it('does not include `warnings` in the trailer (§6.3 contract pin)', () => {
    // §6.3 fixes the trailer shape: `{"_meta":{...}}` exactly. No
    // warnings sibling. The lifted helper takes a `Meta` directly,
    // so even if the caller built one with no warning surface, the
    // trailer line stays single-key. Future warning-in-trailer
    // contract path is `_meta.warnings` (extend the Meta type),
    // not a sibling.
    const { stream, read } = collect();
    const handle = startNdjsonStream<RawItem>({
      stream,
      secrets: [],
      project: (item) => item,
    });
    handle.writeTrailer(buildMeta(baseMetaInput));
    const lines = read();
    const trailer = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(Object.keys(trailer)).toEqual(['_meta']);
    expect('warnings' in trailer).toBe(false);
  });

  it('awaits stream `drain` when stream.write returns false (real backpressure)', async () => {
    // Codex M18 implementation review P3-3: walkPages.onItem +
    // paginate.onItem document backpressure semantics ("a slow
    // downstream consumer ... backpressures the walker"). Pre-fix,
    // the lifted helper's onItem ignored stream.write's false
    // return — items would buffer in Node's internal write queue
    // and the docstring was aspirational. This test pins the real
    // backpressure: a stream with a tiny high-water mark + a
    // delayed drain should make onItem's promise pending until
    // the drain fires.
    const tinyStream = new PassThrough({ highWaterMark: 1 });
    // Don't read — let writes fill the buffer until 'drain' is
    // needed for further writes.
    const handle = startNdjsonStream<RawItem>({
      stream: tinyStream,
      secrets: [],
      project: (item) => ({ id: item.id }),
    });

    // Track resolution via Promise.race against an already-settled
    // sentinel. Using `let` bools tripped the lint's narrowing
    // analysis (it doesn't see assignments inside .then callbacks).
    const sentinel = Symbol('not-yet');
    const raceFor = <T>(p: Promise<T>): Promise<T | typeof sentinel> =>
      Promise.race([p, Promise.resolve(sentinel)]);

    const writeP = handle.onItem({ id: 'x'.repeat(64) });
    // Second write to guarantee the queue tips over the
    // highWaterMark of 1 even if the first write was below.
    const writeP2 = handle.onItem({ id: 'y'.repeat(64) });

    // Yield once to give the writes a chance to flush their
    // first-pass `stream.write` call.
    await new Promise<void>((r) => setImmediate(r));

    // At this point at least one of the writes should be pending
    // on a 'drain' (highWaterMark = 1, payload >> 1). If both
    // resolved, the helper isn't actually awaiting drain.
    const firstSettled = await raceFor(writeP);
    const secondSettled = await raceFor(writeP2);
    if (firstSettled !== sentinel && secondSettled !== sentinel) {
      throw new Error(
        'expected at least one onItem to be pending on drain; both resolved synchronously',
      );
    }

    // Drain the buffer by reading every queued chunk; the resume
    // triggers the 'drain' event the helper is awaiting.
    tinyStream.resume();

    // Both should resolve once 'drain' fires.
    await expect(writeP).resolves.toBeUndefined();
    await expect(writeP2).resolves.toBeUndefined();
  });
});
