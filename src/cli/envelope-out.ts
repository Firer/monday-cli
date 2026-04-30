/**
 * Envelope emission helpers (M2.5 R2).
 *
 * Pulled out of `cli/run.ts` so the runner stays focused on argv
 * parsing, signal handling, and command registration. Both the error
 * path (`writeErrorEnvelope`, called by the runner's catch-all) and
 * the success path (emit.ts) read action-resolved meta from the same
 * `MetaBuilder` snapshot.
 *
 * **Why a builder, not a setter callback.** The M2-era `setMetaHint`
 * pattern (commit `5e211bc`) worked but coupled the action body to a
 * mutable `MetaHint` record on `ctx`; tracing "what `meta` will the
 * error envelope carry" required grepping every `setMetaHint` call
 * site for shape drift. The builder closes that loop:
 *
 *   - typed setters (`setApiVersion`, `setSource`) enumerate exactly
 *     what the error path can carry — adding a new field means adding
 *     a new typed method + extending `MetaSnapshot`, not stuffing
 *     another optional key into a shared record;
 *   - both paths read from `builder.snapshot()`, so success-vs-error
 *     drift is impossible (M2 Codex review §2 — `--api-version 2026-04
 *     account whoami` claiming `api_version: "2026-01"` on HTTP 401 —
 *     was structurally caused by the two paths reading different
 *     state);
 *   - the public surface is closed (no `set(key, value)` escape
 *     hatch), so the only way to widen what the error envelope can
 *     report is to extend this module deliberately.
 *
 * Action sites stay terse: `ctx.meta.setApiVersion(v)` /
 * `ctx.meta.setSource('live')` is the same shape the M2 callback
 * had, just typed per-field rather than via a record literal.
 */

import { CommanderError } from 'commander';
import {
  buildError,
  buildMeta,
  type DataSource,
  type Meta,
} from '../utils/output/envelope.js';
import { redact } from '../utils/redact.js';
import {
  InternalError,
  MondayCliError,
  UsageError,
} from '../utils/errors.js';

export interface MetaSnapshot {
  readonly apiVersion: string | undefined;
  readonly source: DataSource | undefined;
}

export interface MetaBuilder {
  /**
   * Commit the resolved `API-Version` value the request will carry
   * (or did carry, if the call already went out). The same value
   * lands on `meta.api_version` in both the success envelope (via
   * emit.ts) and the error envelope (via `writeErrorEnvelope`) —
   * an HTTP 401 for `monday --api-version 2026-04 account whoami`
   * reports `meta.api_version: "2026-04"`, not the SDK pin.
   */
  setApiVersion: (version: string) => void;
  /**
   * Commit the data-source the response came from — `live` for a
   * fresh API call, `cache` for a hit, `mixed` for a partially-
   * served response, `none` for local-only commands. Network
   * commands set `live` before the wire goes out so an error
   * envelope on the sad path still reports `source: live`.
   */
  setSource: (source: DataSource) => void;
  /** Frozen view of every value committed so far. */
  snapshot: () => MetaSnapshot;
}

export const createMetaBuilder = (): MetaBuilder => {
  let apiVersion: string | undefined;
  let source: DataSource | undefined;
  return {
    setApiVersion: (v) => {
      apiVersion = v;
    },
    setSource: (s) => {
      source = s;
    },
    snapshot: () => ({ apiVersion, source }),
  };
};

/**
 * Collects literal secret values to scrub from emitted bytes. Read
 * lazily — `loadConfig()` populates `MONDAY_API_TOKEN` from `.env`
 * *after* the runner builds its context, so a snapshot at runner
 * construction time would miss tokens that exist only in the `.env`
 * file (Codex review §1 follow-up). `env` is shared by reference
 * with the runner; re-reading at emit time observes any side-
 * effecting load.
 */
export const collectSecrets = (
  env: NodeJS.ProcessEnv,
): readonly string[] => {
  const out: string[] = [];
  const token = env.MONDAY_API_TOKEN;
  if (token !== undefined && token.length > 0) {
    out.push(token);
  }
  return out;
};

export interface BuildBaseMetaInputs {
  readonly snapshot: MetaSnapshot;
  readonly env: NodeJS.ProcessEnv;
  readonly cliVersion: string;
  readonly requestId: string;
  readonly retrievedAt: string;
}

/**
 * Constructs `meta` for an envelope where no action-resolved
 * complexity / cache-age is in scope (the error path; commands that
 * never reached emit.ts). `api_version` falls back to
 * `MONDAY_API_VERSION` env / SDK pin when the action didn't commit
 * one through the builder.
 */
export const buildBaseMeta = (inputs: BuildBaseMetaInputs): Meta =>
  buildMeta({
    api_version:
      inputs.snapshot.apiVersion ??
      inputs.env.MONDAY_API_VERSION ??
      '2026-01',
    cli_version: inputs.cliVersion,
    request_id: inputs.requestId,
    source: inputs.snapshot.source ?? 'none',
    retrieved_at: inputs.retrievedAt,
    cache_age_seconds: null,
  });

export interface WriteErrorEnvelopeOptions {
  readonly stderr: NodeJS.WritableStream;
  readonly env: NodeJS.ProcessEnv;
  readonly meta: Meta;
}

/**
 * Renders the error envelope to `stderr` with two-layer redaction
 * (key-based + value-scan over the live token). Re-reads `env` for
 * the value-scan layer so a token loaded from `.env` mid-run is
 * still scrubbed (security.md "Redaction in output").
 */
export const writeErrorEnvelope = (
  err: MondayCliError,
  options: WriteErrorEnvelopeOptions,
): void => {
  const envelope = buildError(err, options.meta);
  const redacted = redact(envelope, {
    secrets: collectSecrets(options.env),
  });
  options.stderr.write(`${JSON.stringify(redacted, null, 2)}\n`);
};

const isCommanderError = (err: unknown): err is CommanderError =>
  err instanceof CommanderError;

/**
 * Maps an arbitrary thrown value into the `MondayCliError` family the
 * envelope path expects. `MondayCliError` instances pass through;
 * commander parsing failures become `UsageError`; unknown thrown
 * values become `InternalError` with the original cause attached.
 *
 * Lives here (not in `errors.ts`) because the conversion is part of
 * the runner-→-envelope path: it's the precondition for
 * `writeErrorEnvelope`.
 */
export const toMondayError = (err: unknown): MondayCliError => {
  if (err instanceof MondayCliError) {
    return err;
  }
  if (isCommanderError(err)) {
    // Commander surfaces both --help/--version and parsing failures
    // as CommanderError. The success-style ones carry exitCode 0;
    // those aren't errors and we never reach this function with one.
    if (
      err.code === 'commander.helpDisplayed' ||
      err.code === 'commander.version'
    ) {
      return new InternalError(`unexpected commander success: ${err.code}`);
    }
    return new UsageError(err.message);
  }
  if (err instanceof Error) {
    return new InternalError(err.message, { cause: err });
  }
  return new InternalError('unknown error', { cause: err });
};
