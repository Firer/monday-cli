import type { Meta, Warning } from './envelope.js';
import { redact } from '../redact.js';

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
 *
 * Two surfaces:
 *
 * - `renderNdjson` (collect-then-emit) — used when the caller
 *   already has the full data array. Single function, no streaming
 *   semantics.
 *
 * - `startNdjsonStream` (R52, M18 lift) — used when the caller is
 *   walking a paginated source (`paginate.onItem` /
 *   `walkPages.onItem`). Returns a `{ onItem, writeTrailer }`
 *   handle so the caller can emit per-item-arrival and write the
 *   trailer after the walk completes. Three consumers: `item list`
 *   (M7), `item search` (M18), `update list` (M18). Was previously
 *   a private helper in `src/commands/item/list.ts`; lifted at the
 *   3-consumer trigger.
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

/**
 * Inputs to `startNdjsonStream`. Three fields — well below the
 * >4-parameter heuristic that deferred R44 / R49 / R50:
 *
 * - `stream` — the writable stream items + trailer write to
 *   (typically `ctx.stdout`).
 * - `secrets` — token bytes the redactor scrubs from every emitted
 *   line (per `.claude/rules/security.md` "value-scanning filter").
 *   Caller passes `collectSecrets(ctx.env)`.
 * - `project` — per-item projection callback. Decouples the helper
 *   from per-noun output shape: item list/search projects raw
 *   Monday rows through `projectFromRaw`; update list runs items
 *   through `normaliseReplies` + the per-update zod parse.
 *
 * The trailer-side `Meta` is built by the caller (`buildMeta(...)`)
 * and passed into `writeTrailer`. This keeps the per-noun trailer-
 * shape variance at the call site — item list/search carries
 * `meta.columns`, `update list` does not — without parameterising
 * a `meta` builder inside the helper.
 */
export interface NdjsonStreamInputs<T> {
  readonly stream: NodeJS.WritableStream;
  readonly secrets: readonly string[];
  readonly project: (item: T) => unknown;
}

export interface NdjsonStreamHandle<T> {
  /**
   * Per-item callback for the stream. Returns a `Promise<void>`
   * that resolves once the bytes are flushed (or, when
   * `stream.write` returns `false`, once the stream's `'drain'`
   * event fires). Threaded through `paginate.onItem` /
   * `walkPages.onItem` so a slow downstream consumer (a piped
   * `jq`, an open-ended `tee`) backpressures the cursor walk
   * for real — not just in spirit. Without the await on `'drain'`,
   * a fast walker against a slow stdout would buffer items in
   * Node's internal write queue and the "backpressure" comment in
   * `walk-pages.ts` / `pagination.ts` would be aspirational.
   */
  readonly onItem: (item: T) => Promise<void>;
  readonly writeTrailer: (meta: Meta) => void;
}

const writeAndDrain = async (
  stream: NodeJS.WritableStream,
  bytes: string,
): Promise<void> => {
  if (stream.write(bytes)) return;
  // High-water mark hit; wait for the next 'drain' before resolving.
  // The walker awaits this, so the next item waits with us.
  await new Promise<void>((resolve) => {
    stream.once('drain', () => {
      resolve();
    });
  });
};

export const startNdjsonStream = <T>(
  inputs: NdjsonStreamInputs<T>,
): NdjsonStreamHandle<T> => {
  const { stream, secrets, project } = inputs;
  return {
    onItem: async (item) => {
      const projected = project(item);
      const redacted = redact(projected, { secrets });
      await writeAndDrain(stream, `${JSON.stringify(redacted)}\n`);
    },
    writeTrailer: (meta) => {
      const trailer = redact({ _meta: meta }, { secrets });
      stream.write(`${JSON.stringify(trailer)}\n`);
    },
  };
};
