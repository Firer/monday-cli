import type { Meta, Warning } from './envelope.js';

/**
 * NDJSON renderer for collections (`cli-design.md` §6.3).
 *
 * Streaming-friendly shape: one resource per line, no envelope
 * wrapping. Final line is a `{"_meta": ...}` trailer carrying the
 * pagination state and source so agents can pin behaviour without
 * a second request. Warnings ride alongside `_meta` when present —
 * the trailer remains the only line a consumer can't classify by
 * "is this a regular item or a sentinel?".
 *
 * NDJSON **never truncates**: streaming exists so agents can start
 * processing without waiting for the whole walk, not so the
 * presentation layer can drop bytes.
 */
export interface NdjsonInput {
  readonly data: readonly unknown[];
  readonly meta: Meta;
  readonly warnings: readonly Warning[];
}

export const renderNdjson = (
  input: NdjsonInput,
  stream: NodeJS.WritableStream,
): void => {
  for (const resource of input.data) {
    stream.write(`${JSON.stringify(resource)}\n`);
  }

  const trailer: { _meta: Meta; warnings?: readonly Warning[] } = {
    _meta: input.meta,
  };
  if (input.warnings.length > 0) {
    trailer.warnings = input.warnings;
  }
  stream.write(`${JSON.stringify(trailer)}\n`);
};
