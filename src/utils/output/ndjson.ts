import type { Meta, Warning } from './envelope.js';

/**
 * NDJSON renderer for collections (`cli-design.md` §6.3).
 *
 * Streaming-friendly shape: one resource per line, no envelope
 * wrapping. Final line is a `{"_meta": ...}` trailer carrying the
 * pagination state and source so agents can pin behaviour without
 * a second request.
 *
 * §6.3 fixes the trailer shape exactly: `{"_meta":{...}}` — one
 * key, one object, nothing else. NDJSON has no envelope, so it has
 * no `warnings` array; surfacing them out-of-band would mean a
 * consumer keeps reading after the trailer to look for them, which
 * defeats "trailer = stream-end sentinel". If a future milestone
 * needs to deliver warnings in the streaming path, the agreed home
 * is `_meta.warnings` (additive, contract-clean) — extend the
 * `Meta` type, don't add a sibling key here.
 *
 * NDJSON **never truncates**: streaming exists so agents can start
 * processing without waiting for the whole walk, not so the
 * presentation layer can drop bytes.
 */
export interface NdjsonInput {
  readonly data: readonly unknown[];
  readonly meta: Meta;
  /**
   * Warnings are accepted on the input for symmetry with other
   * renderers but are NOT written to the trailer — see the comment
   * above. They're consumed by the table/JSON path on TTY mode and
   * may be surfaced via `meta.warnings` in a later milestone.
   */
  readonly warnings: readonly Warning[];
}

export const renderNdjson = (
  input: NdjsonInput,
  stream: NodeJS.WritableStream,
): void => {
  for (const resource of input.data) {
    stream.write(`${JSON.stringify(resource)}\n`);
  }
  stream.write(`${JSON.stringify({ _meta: input.meta })}\n`);
};
