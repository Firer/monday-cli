import type {
  ColumnHead,
  Complexity,
  DataSource,
  Meta,
  Warning,
} from './envelope.js';
import { buildMeta } from './envelope.js';
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
 * Three surfaces:
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
 *
 * - `buildStreamingTrailerMeta` (R53, post-v0.2 cleanup-window lift)
 *   — sibling to `startNdjsonStream`. Builds the canonical
 *   §6.3 trailer Meta from the walker result + the three
 *   source/cache/api inputs. Same three consumers; consolidates
 *   the ~15-line `buildMeta(...)` boilerplate that was repeated
 *   across each call site, with cursor-vs-page + column-bearing-
 *   vs-not divergence handled via optional inputs.
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
 *   Caller passes `collectSecrets(ctx.env, ctx.runtimeSecrets)`
 *   (the v0.3-M21 §7.4.3 redaction-runtime extension folds
 *   credentials-cache `access_token` values in via the second arg).
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

/**
 * Inputs to `buildStreamingTrailerMeta` (R53 lift, v0.2-plan §22).
 * Sibling to `startNdjsonStream` — both implement §6.3.
 *
 * Three NDJSON consumers (item list / item search / update list)
 * end up calling `buildMeta(...)` with structurally near-identical
 * inputs, varying only on whether the noun carries `next_cursor`
 * (cursor-walked vs page-walked) and `meta.columns` (column-bearing
 * or not). The helper takes the walker-shaped `result` block + the
 * three meta source/cache/api inputs + an optional `columns` slot,
 * builds the canonical-key-order Meta via `buildMeta`, and returns
 * it ready for `stream.writeTrailer`.
 *
 * Five fields total — within the >4-parameter heuristic that
 * deferred R44 / R49 / R50, since `ctx` and `result` are
 * structurally complete units (not flat scalars to count).
 *
 * Per-consumer divergence the helper preserves:
 * - cursor-walked consumers (item list / item search) populate
 *   `result.nextCursor`; the trailer carries `next_cursor`.
 * - page-walked consumers (update list) omit `result.nextCursor`;
 *   the trailer drops `next_cursor` entirely (buildMeta convention:
 *   undefined input → key absent from output).
 * - column-bearing consumers (item list / item search) populate
 *   `columns`; non-bearing consumers (update list) omit it; the
 *   trailer mirrors the input shape on a per-consumer basis.
 *
 * The complexity slot is always required: the cursor-walker exposes
 * it directly on `result.complexity`; the page-walker exposes it
 * via `result.lastResponse.complexity`. Each consumer extracts at
 * the call site; the helper takes the post-extraction value.
 */
export interface StreamingTrailerInputs {
  readonly ctx: {
    readonly cliVersion: string;
    readonly requestId: string;
    readonly clock: () => Date;
  };
  readonly apiVersion: string;
  readonly source: DataSource;
  readonly cacheAgeSeconds: number | null;
  readonly result: {
    readonly hasMore: boolean;
    readonly totalReturned: number;
    readonly complexity: Complexity | null;
    /** Omit for page-walked consumers; trailer drops `next_cursor`. */
    readonly nextCursor?: string | null;
  };
  /** Omit for non-column-bearing nouns; trailer drops `columns`. */
  readonly columns?: Readonly<Record<string, ColumnHead>>;
  /**
   * v0.4-M29 `monday item watch` session counters. Optional bundle —
   * absent for every streaming verb except `item watch`. Lands flat
   * under `_meta` (not nested under a sub-object) so agents read
   * each slot directly per cli-design §6.3 + the `item watch` entry
   * in output-shapes.md.
   */
  readonly session?: {
    readonly eventsEmitted: number;
    readonly pollsMade: number;
    readonly failedPolls: number;
    readonly watchDurationSeconds: number;
    readonly lastSeenEventId: string | null;
    readonly circuitBrokenAt: string | null;
    readonly exitReason: string;
  };
  /**
   * §6.3 streaming-trailer warnings channel. Folded into
   * `_meta.warnings[]` per the NDJSON contract (resource lines +
   * final `_meta`; warnings NOT interleaved with event records).
   * Currently set by `item watch`'s `WatchSessionWarning[]`
   * accumulator; previously omitted by every NDJSON consumer
   * (the slot is additive — backwards-compatible).
   */
  readonly warnings?: readonly Warning[];
}

export const buildStreamingTrailerMeta = (
  inputs: StreamingTrailerInputs,
): Meta =>
  buildMeta({
    api_version: inputs.apiVersion,
    cli_version: inputs.ctx.cliVersion,
    request_id: inputs.ctx.requestId,
    source: inputs.source,
    retrieved_at: inputs.ctx.clock().toISOString(),
    cache_age_seconds: inputs.cacheAgeSeconds,
    complexity: inputs.result.complexity,
    has_more: inputs.result.hasMore,
    total_returned: inputs.result.totalReturned,
    // Conditional spreads preserve `exactOptionalPropertyTypes`'s
    // "undefined ≠ absent" rule: passing the keys with explicit
    // `undefined` would not compile against the optional `?:` slots
    // in `MetaInput`, even though `buildMeta` would have stripped
    // them anyway.
    ...(inputs.result.nextCursor === undefined
      ? {}
      : { next_cursor: inputs.result.nextCursor }),
    ...(inputs.session === undefined
      ? {}
      : {
          events_emitted: inputs.session.eventsEmitted,
          polls_made: inputs.session.pollsMade,
          failed_polls: inputs.session.failedPolls,
          watch_duration_seconds: inputs.session.watchDurationSeconds,
          last_seen_event_id: inputs.session.lastSeenEventId,
          circuit_broken_at: inputs.session.circuitBrokenAt,
          exit_reason: inputs.session.exitReason,
        }),
    ...(inputs.warnings === undefined ? {} : { warnings: inputs.warnings }),
    ...(inputs.columns === undefined ? {} : { columns: inputs.columns }),
  });
