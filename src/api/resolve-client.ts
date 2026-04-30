/**
 * Shared `MondayClient` construction for every network command.
 *
 * Each network command needs the same plumbing — load config (for
 * the API token + URL + version), pick up global flags (`--retry`,
 * `--verbose`, `--api-version`, `--timeout`), and either wrap the
 * injected `Transport` (test path) or build a `FetchTransport` from
 * config (production path). Centralising here:
 *
 *   - keeps the action body in each command focused on the GraphQL
 *     call + envelope mapping;
 *   - means the `--api-version` precedence rule (flag > env > SDK
 *     pin) lives in one place;
 *   - means a future profile switch / OAuth path swaps in here once,
 *     not per-command.
 *
 * Lives next to `Transport` and `MondayClient` (M2.5 R1) — every
 * network noun calls into here, so a cross-noun import from
 * `commands/<x>/` into `commands/<y>/` would be wrong. Putting it
 * under `src/api/` removes that temptation entirely.
 *
 * The injected `ctx.transport` always wins — that's the fixture seam
 * for integration tests. Production callers leave it undefined and
 * a fresh `FetchTransport` is built per command invocation, so each
 * call sees the live config (same as the SDK's per-call client).
 */

import { createFetchTransport } from './transport.js';
import { MondayClient, PINNED_API_VERSION } from './client.js';
import { loadConfig } from '../config/load.js';
import {
  parseGlobalFlags,
  type GlobalFlags,
} from '../types/global-flags.js';
import type { RunContext } from '../cli/run.js';

export interface ResolvedClient {
  readonly client: MondayClient;
  readonly globalFlags: GlobalFlags;
  /**
   * The actual `API-Version` value sent on the wire — `--api-version`
   * flag > `MONDAY_API_VERSION` env > SDK pin. Surfaced so the
   * envelope's `meta.api_version` carries the same value the request
   * carried.
   */
  readonly apiVersion: string;
}

export const resolveClient = (
  ctx: RunContext,
  programOpts: unknown,
): ResolvedClient => {
  const globalFlags = parseGlobalFlags(programOpts, ctx.env);
  const config = loadConfig(ctx.env);

  // Precedence: explicit flag > env-derived config > SDK pin.
  const apiVersion =
    globalFlags.apiVersion ?? config.apiVersion ?? PINNED_API_VERSION;

  // Honour `--timeout` over the env / config default. Same reading
  // as the design intent: the flag is a *per-invocation* override.
  const timeoutMs = globalFlags.timeout ?? config.requestTimeoutMs;

  const transport =
    ctx.transport ??
    createFetchTransport({
      endpoint: config.apiUrl,
      apiToken: config.apiToken,
      apiVersion,
      timeoutMs,
    });

  const client = new MondayClient({
    transport,
    signal: ctx.signal,
    retries: globalFlags.retry,
    verbose: globalFlags.verbose,
  });

  // Stash the resolved meta on the runner so an error envelope
  // emitted by the catch-all carries the same api_version + source
  // a success envelope would. Without this, `--api-version 2026-04
  // account whoami` failing with HTTP 401 produced an error envelope
  // claiming `api_version: "2026-01"` (Codex M2 review §2).
  ctx.setMetaHint({ apiVersion, source: 'live' });

  return { client, globalFlags, apiVersion };
};
