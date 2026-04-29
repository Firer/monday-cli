/**
 * Universal envelope builders (`cli-design.md` §6).
 *
 * Every command's stdout JSON is built through one of four functions
 * here so the shape stays in lockstep with the contract — the M2
 * envelope contract test (`v0.1-plan.md` §5.2) inspects the output
 * of every command and asserts the keys are present in the canonical
 * order. Adding a top-level field is a non-breaking change *only* if
 * it's tacked on the end of the canonical order; renames/reorders
 * are a major-version bump.
 */

import type { ErrorCode, MondayCliError } from '../errors.js';

export type SchemaVersion = '1';
export const CURRENT_SCHEMA_VERSION: SchemaVersion = '1';

export type DataSource = 'live' | 'cache' | 'mixed' | 'none';

export interface Complexity {
  readonly used: number;
  readonly remaining: number;
  readonly reset_in_seconds: number;
}

export interface ColumnHead {
  readonly id: string;
  readonly type: string;
  readonly title: string;
}

/**
 * Inputs to `buildMeta`. Loose ordering — `buildMeta` slots them into
 * the canonical envelope-meta order so per-command call sites don't
 * have to think about it.
 */
export interface MetaInput {
  readonly api_version: string;
  readonly cli_version: string;
  readonly request_id: string;
  readonly source: DataSource;
  readonly retrieved_at: string;
  readonly cache_age_seconds?: number | null;
  readonly complexity?: Complexity | null;
  readonly dry_run?: boolean;
  // Collection extras
  readonly next_cursor?: string | null;
  readonly has_more?: boolean;
  readonly total_returned?: number;
  readonly columns?: Readonly<Record<string, ColumnHead>>;
}

export interface Meta {
  readonly schema_version: SchemaVersion;
  readonly api_version: string;
  readonly cli_version: string;
  readonly request_id: string;
  readonly source: DataSource;
  readonly cache_age_seconds: number | null;
  readonly retrieved_at: string;
  /**
   * `cli-design.md` §6.1: "Always null without `--verbose` to avoid
   * an extra GraphQL field on every query." So this field is always
   * **present**; it's just `null` until `--verbose` makes the
   * GraphQL `complexity` selection.
   */
  readonly complexity: Complexity | null;
  readonly dry_run?: true;
  readonly next_cursor?: string | null;
  readonly has_more?: boolean;
  readonly total_returned?: number;
  readonly columns?: Readonly<Record<string, ColumnHead>>;
}

export interface Warning {
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface ErrorEnvelopeBody {
  readonly code: ErrorCode;
  readonly message: string;
  readonly http_status: number | null;
  readonly monday_code: string | null;
  readonly request_id: string;
  readonly retryable: boolean;
  readonly retry_after_seconds: number | null;
  readonly details: Readonly<Record<string, unknown>> | null;
}

export interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly meta: Meta;
  readonly warnings: readonly Warning[];
}

export interface MutationEnvelope<T> extends SuccessEnvelope<T> {
  readonly side_effects?: readonly Readonly<Record<string, unknown>>[];
}

export interface DryRunEnvelope {
  readonly ok: true;
  readonly data: null;
  readonly meta: Meta;
  readonly planned_changes: readonly Readonly<Record<string, unknown>>[];
  readonly warnings: readonly Warning[];
}

export interface ErrorEnvelope {
  readonly ok: false;
  readonly error: ErrorEnvelopeBody;
  readonly meta: Meta;
}

/**
 * Builds a `meta` object in the canonical key order. Optional fields
 * are only inserted when their input is defined — keeps unrelated
 * commands from carrying empty `next_cursor`/`columns` pairs.
 */
export const buildMeta = (input: MetaInput): Meta => {
  // Constructed via property assignment in canonical order; JS object
  // literals preserve insertion order for string keys, which is what
  // the snapshot tests rely on.
  const meta: {
    schema_version: SchemaVersion;
    api_version: string;
    cli_version: string;
    request_id: string;
    source: DataSource;
    cache_age_seconds: number | null;
    retrieved_at: string;
    complexity: Complexity | null;
    dry_run?: true;
    next_cursor?: string | null;
    has_more?: boolean;
    total_returned?: number;
    columns?: Readonly<Record<string, ColumnHead>>;
  } = {
    schema_version: CURRENT_SCHEMA_VERSION,
    api_version: input.api_version,
    cli_version: input.cli_version,
    request_id: input.request_id,
    source: input.source,
    cache_age_seconds: input.cache_age_seconds ?? null,
    retrieved_at: input.retrieved_at,
    // §6.1: complexity is always present; null until --verbose
    // selects the GraphQL field. Insert it at this fixed position
    // so the canonical key order doesn't depend on the input.
    complexity: input.complexity ?? null,
  };

  if (input.dry_run === true) {
    meta.dry_run = true;
  }
  if (input.next_cursor !== undefined) {
    meta.next_cursor = input.next_cursor;
  }
  if (input.has_more !== undefined) {
    meta.has_more = input.has_more;
  }
  if (input.total_returned !== undefined) {
    meta.total_returned = input.total_returned;
  }
  if (input.columns !== undefined) {
    meta.columns = input.columns;
  }

  return meta;
};

export const buildSuccess = <T>(
  data: T,
  meta: Meta,
  warnings: readonly Warning[] = [],
): SuccessEnvelope<T> => ({
  ok: true,
  data,
  meta,
  warnings,
});

export const buildMutation = <T>(
  data: T,
  meta: Meta,
  sideEffects: readonly Readonly<Record<string, unknown>>[] = [],
  warnings: readonly Warning[] = [],
): MutationEnvelope<T> => {
  const env: {
    ok: true;
    data: T;
    meta: Meta;
    warnings: readonly Warning[];
    side_effects?: readonly Readonly<Record<string, unknown>>[];
  } = {
    ok: true,
    data,
    meta,
    warnings,
  };
  if (sideEffects.length > 0) {
    env.side_effects = sideEffects;
  }
  return env;
};

export const buildDryRun = (
  plannedChanges: readonly Readonly<Record<string, unknown>>[],
  meta: Meta,
  warnings: readonly Warning[] = [],
): DryRunEnvelope => ({
  ok: true,
  data: null,
  // `dry_run: true` is part of the contract — slot it in via buildMeta
  // so the field lands in the canonical position.
  meta: meta.dry_run === true ? meta : buildMeta({ ...metaInputFromMeta(meta), dry_run: true }),
  planned_changes: plannedChanges,
  warnings,
});

export const buildError = (
  error: MondayCliError,
  meta: Meta,
): ErrorEnvelope => ({
  ok: false,
  error: {
    code: error.code,
    message: error.message,
    http_status: error.httpStatus ?? null,
    monday_code: error.mondayCode ?? null,
    request_id: error.requestId ?? meta.request_id,
    retryable: error.retryable,
    retry_after_seconds: error.retryAfterSeconds ?? null,
    details: error.details ?? null,
  },
  meta,
});

const metaInputFromMeta = (meta: Meta): MetaInput => {
  const input: {
    -readonly [K in keyof MetaInput]: MetaInput[K];
  } = {
    api_version: meta.api_version,
    cli_version: meta.cli_version,
    request_id: meta.request_id,
    source: meta.source,
    retrieved_at: meta.retrieved_at,
    cache_age_seconds: meta.cache_age_seconds,
    complexity: meta.complexity,
  };
  if (meta.next_cursor !== undefined) {
    input.next_cursor = meta.next_cursor;
  }
  if (meta.has_more !== undefined) {
    input.has_more = meta.has_more;
  }
  if (meta.total_returned !== undefined) {
    input.total_returned = meta.total_returned;
  }
  if (meta.columns !== undefined) {
    input.columns = meta.columns;
  }
  return input;
};
