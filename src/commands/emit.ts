import type { z } from 'zod';
import type { RunContext } from '../cli/run.js';
import {
  buildMeta,
  buildSuccess,
  type ColumnHead,
  type Complexity,
  type DataSource,
  type Meta,
  type Warning,
} from '../utils/output/envelope.js';
import { renderJson } from '../utils/output/json.js';
import { renderNdjson } from '../utils/output/ndjson.js';
import { renderTable } from '../utils/output/table.js';
import { renderText } from '../utils/output/text.js';
import { selectOutput, type OutputFormat } from '../utils/output/select.js';
import { redact } from '../utils/redact.js';
import {
  parseGlobalFlags,
  type GlobalFlags,
} from '../types/global-flags.js';
import { collectSecrets } from '../cli/envelope-out.js';
import { UsageError } from '../utils/errors.js';

/**
 * Emit helper for command actions (`v0.1-plan.md` §4 DoD #7–#8).
 *
 * Centralises the four steps every successful command shares:
 *
 *  1. Validate the `data` payload against the command's
 *     `outputSchema`. Catches drift between the implementation and
 *     the published schema (the same check `monday schema` reads).
 *     A failure is an internal bug, so it surfaces as `internal_error`
 *     via the runner's catch-all (kept simple; no special-case here).
 *  2. Resolve the active output format from the global flags +
 *     `MONDAY_OUTPUT` env + TTY.
 *  3. Build the §6 envelope (success path; errors flow through the
 *     runner's catch-all).
 *  4. Render to stdout via the format-specific renderer, with token
 *     redaction across the entire payload before the bytes hit the
 *     stream.
 *
 * The shape is deliberately not exposed as a class — every command's
 * action is a thin call to this function, so passing options as an
 * object keeps the surface obvious at the call site.
 */

export interface EmitSuccessOptions<T> {
  readonly ctx: RunContext;
  readonly data: T;
  readonly schema: z.ZodType<T>;
  /**
   * The raw, post-parse global options object commander hands back
   * via `program.opts()`. Re-parsed inside `emitSuccess` so the
   * normaliser (`parseGlobalFlags`) is the single source of truth
   * for `--json`/`--table`/`--full`/etc. — no command needs to
   * handle the raw shape.
   */
  readonly programOpts: unknown;
  /** `cli-design.md` §6.1 `meta.source`. M1 is local-only → `none`. */
  readonly source?: DataSource;
  /**
   * Cache age for the served data; only meaningful when `source` is
   * `'cache'` or `'mixed'`. M3+ wires this from the cache primitives;
   * M1 leaves it null.
   */
  readonly cacheAgeSeconds?: number | null;
  /** Optional non-fatal warnings (`cli-design.md` §6.1). */
  readonly warnings?: readonly Warning[];
  /**
   * Hint to the renderer for collection-shaped commands. Defaults to
   * `'single'`. NDJSON and table-collection layout are reserved for
   * collection commands; M1 only emits collections from `cache list`.
   */
  readonly kind?: 'single' | 'collection';
  /**
   * `meta.complexity` payload for `--verbose` runs. `null` (or
   * omitted) collapses to `cli-design.md` §6.1's default — the
   * field is always present, the value is `null` until --verbose
   * makes the GraphQL `complexity` selection.
   */
  readonly complexity?: Complexity | null;
  /**
   * Override `meta.api_version`. Network commands resolve this
   * post-flag (`--api-version` > env > SDK pin) and pass the result
   * through so the envelope reflects the actual `API-Version` header
   * sent on the wire. Local-only commands leave it unset and inherit
   * the env-or-SDK-pin default the runner already uses.
   */
  readonly apiVersion?: string;
  /**
   * Collection-only meta fields (`cli-design.md` §6.3). All optional
   * — list commands fill what they know.
   *
   * `nextCursor` is for `items_page` style pagination (M4); page-
   * based collections (workspace list, board list) leave it
   * undefined. `hasMore` is set whenever the command can tell.
   * `totalReturned` defaults to `data.length` when omitted but is
   * accepted explicitly so a future paginator that filters
   * client-side can report a smaller surface.
   *
   * `columns` is the per-board column de-duplication slot §6.3
   * documents — `item list` against a single board fills this so
   * the per-row `columns` payload doesn't repeat titles. Unused
   * by M3 commands.
   */
  readonly nextCursor?: string | null;
  readonly hasMore?: boolean;
  readonly totalReturned?: number;
  readonly columns?: Readonly<Record<string, ColumnHead>>;
}

/**
 * Returns true when the resolved output format is one this command
 * shape supports. Single-resource commands reject `--ndjson` per
 * `v0.1-plan.md` §4 DoD #8 ("Non-applicable formats fail with
 * usage_error").
 */
const ensureFormatApplies = (
  format: OutputFormat,
  kind: 'single' | 'collection',
): void => {
  if (format === 'ndjson' && kind === 'single') {
    throw new UsageError(
      '--ndjson / --output ndjson is only supported for collection commands',
    );
  }
};

const renderForFormat = <T>(
  format: OutputFormat,
  envelope: ReturnType<typeof buildSuccess<T>>,
  data: T,
  ctx: RunContext,
  globalFlags: GlobalFlags,
  kind: 'single' | 'collection',
  warnings: readonly Warning[],
): void => {
  // The redactor strips both keyed sensitive values (Authorization,
  // apiToken, ...) and any literal occurrence of the runtime token —
  // so a secret loaded from `.env` mid-action is still scrubbed,
  // matching the runner's error-path behaviour.
  const secrets = collectSecrets(ctx.env);
  const redacted = redact(envelope, { secrets });
  const redactedData = redact(data, { secrets });

  switch (format) {
    case 'json':
      renderJson(redacted, ctx.stdout);
      return;
    case 'table':
      if (kind === 'collection') {
        renderTable(
          {
            kind: 'collection',
            data: redactedData as readonly Readonly<Record<string, unknown>>[],
            options: {
              full: globalFlags.full,
              ...(globalFlags.width === undefined ? {} : { width: globalFlags.width }),
              ...(globalFlags.columns === undefined
                ? {}
                : { columns: globalFlags.columns }),
            },
          },
          ctx.stdout,
        );
      } else {
        renderTable(
          {
            kind: 'single',
            data: redactedData as Readonly<Record<string, unknown>>,
            options: {
              full: globalFlags.full,
              ...(globalFlags.width === undefined ? {} : { width: globalFlags.width }),
              ...(globalFlags.columns === undefined
                ? {}
                : { columns: globalFlags.columns }),
            },
          },
          ctx.stdout,
        );
      }
      return;
    case 'text':
      if (kind === 'collection') {
        // Text renderer is single-resource only per v0.1; collections
        // would need an ad-hoc shape. Reject loudly rather than emit
        // something half-shaped.
        throw new UsageError(
          '--output text is only supported for single-resource commands',
        );
      }
      renderText(
        { data: redactedData as Readonly<Record<string, unknown>> },
        ctx.stdout,
      );
      return;
    case 'ndjson':
      // Only reachable for collections (single-resource case rejected
      // by `ensureFormatApplies` upstream). The trailer is built from
      // the redacted envelope, not the raw one — Codex review §4
      // caught a path where literal secrets in `meta` (e.g., a
      // future `meta.next_cursor` carrying user-supplied state)
      // would slip through unscrubbed because the original code
      // passed `envelope.meta` instead of `(redacted as ...).meta`.
      renderNdjson(
        {
          data: redactedData as readonly unknown[],
          meta: (redacted as { meta: Meta }).meta,
          warnings,
        },
        ctx.stdout,
      );
      return;
  }
};

export const emitSuccess = <T>(options: EmitSuccessOptions<T>): void => {
  const { ctx, schema, programOpts, source = 'none' } = options;
  const warnings = options.warnings ?? [];
  const kind = options.kind ?? 'single';

  // Drift catch (`v0.1-plan.md` §4 DoD #2). A failure means the
  // command's runtime output diverged from its declared schema —
  // the runner maps the thrown ZodError into `internal_error` /
  // exit 2, which is what we want for an internal contract break.
  const validated = schema.parse(options.data);

  const globalFlags = parseGlobalFlags(programOpts, ctx.env);
  const format = selectOutput({
    json: globalFlags.json,
    table: globalFlags.table,
    ...(globalFlags.output === undefined ? {} : { output: globalFlags.output }),
    env: ctx.env,
    isTTY: ctx.isTTY,
  });
  ensureFormatApplies(format, kind);

  // Default `total_returned` to `data.length` for collections so
  // commands don't have to repeat the count. Single-resource commands
  // skip this because §6.3 ties `total_returned` to the collection
  // shape.
  const inferredTotal =
    kind === 'collection' && Array.isArray(validated)
      ? (validated as readonly unknown[]).length
      : undefined;

  const envelope = buildSuccess(
    validated,
    buildMeta({
      api_version:
        options.apiVersion ?? ctx.env.MONDAY_API_VERSION ?? '2026-01',
      cli_version: ctx.cliVersion,
      request_id: ctx.requestId,
      source,
      retrieved_at: ctx.clock().toISOString(),
      cache_age_seconds: options.cacheAgeSeconds ?? null,
      // §6.1: meta.complexity is always present; null until --verbose
      // selects the GraphQL field. Carry the resolved value when the
      // action provides one.
      complexity: options.complexity ?? null,
      ...(options.nextCursor === undefined ? {} : { next_cursor: options.nextCursor }),
      ...(options.hasMore === undefined ? {} : { has_more: options.hasMore }),
      ...(options.totalReturned !== undefined
        ? { total_returned: options.totalReturned }
        : inferredTotal !== undefined
          ? { total_returned: inferredTotal }
          : {}),
      ...(options.columns === undefined ? {} : { columns: options.columns }),
    }),
    warnings,
  );

  renderForFormat(format, envelope, validated, ctx, globalFlags, kind, warnings);
};
