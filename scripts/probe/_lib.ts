/**
 * Shared scaffold for ad-hoc empirical probes against a real Monday
 * workspace. Per-probe scripts (`scripts/probe/<milestone>-<surface>.ts`)
 * stay local + gitignored; this `_lib.ts` ships under a one-off
 * `.gitignore` exclusion so the helpers themselves are versioned and
 * reused.
 *
 * Surfaced by v0.3-plan §22 R-candidate "scripts/probe/ reusable probe
 * infrastructure" — the M20 implementation pivot needed four ad-hoc
 * scripts that all shared the same scaffold (typed gql wrapper +
 * `expect` helper + bootstrap/cleanup mutations). M21's OAuth probe is
 * the second consumer; this lift fires the candidate so the probe
 * matrix can stay terse (~30–80 LOC per probe).
 *
 * Usage from a sibling probe script (these scripts are intentionally
 * gitignored — only `_lib.ts` is tracked):
 *
 * ```ts
 * import 'dotenv/config';
 * import { gql, expect, oauthGet, oauthPost } from './_lib.js';
 *
 * const me = await gql<{ me: { id: string } }>(`query { me { id } }`);
 * expect('me { id }', me);
 * ```
 *
 * Environment loading:
 *   - `.env.probe.local` (gitignored) supplies `MONDAY_API_TOKEN`. The
 *     token is loaded via `dotenv/config` in the per-probe script,
 *     never echoed.
 */

import { request } from 'node:https';
import { URL } from 'node:url';

const MONDAY_GRAPHQL_URL = 'https://api.monday.com/v2';
const MONDAY_API_VERSION = '2026-01';

export interface GraphQLResponse<T> {
  readonly data?: T;
  readonly errors?: ReadonlyArray<{
    readonly message: string;
    readonly extensions?: Record<string, unknown>;
  }>;
}

export interface RawHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * Typed wrapper around `fetch` against Monday's GraphQL endpoint.
 * Requires `MONDAY_API_TOKEN` in `process.env` (loaded via
 * `dotenv/config` in the calling script).
 */
export const gql = async <T>(
  query: string,
  variables?: Record<string, unknown>,
  operationName?: string,
): Promise<GraphQLResponse<T>> => {
  const token = process.env.MONDAY_API_TOKEN;
  if (token === undefined || token.length === 0) {
    throw new Error(
      'MONDAY_API_TOKEN missing — load via dotenv from .env.probe.local',
    );
  }
  const body = JSON.stringify({
    query,
    ...(variables === undefined ? {} : { variables }),
    ...(operationName === undefined ? {} : { operationName }),
  });
  const res = await fetch(MONDAY_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: token,
      'API-Version': MONDAY_API_VERSION,
      'Content-Type': 'application/json',
    },
    body,
  });
  const text = await res.text();
  let parsed: GraphQLResponse<T>;
  try {
    parsed = JSON.parse(text) as GraphQLResponse<T>;
  } catch {
    throw new Error(
      `non-JSON response from Monday (status ${res.status.toString()}): ${text.slice(0, 200)}`,
    );
  }
  return parsed;
};

/**
 * Surfaces a probe step's outcome. On a `data`-bearing response, prints
 * the result; on `errors`, prints them and exits non-zero so a probe
 * script's first failure halts the rest of the matrix.
 */
export const expect = <T>(
  label: string,
  result: GraphQLResponse<T>,
): T => {
  if (result.errors !== undefined && result.errors.length > 0) {
    console.error(`[FAIL] ${label}`);
    for (const e of result.errors) {
      console.error(`  - ${e.message}`);
      if (e.extensions !== undefined) {
        console.error(`    extensions: ${JSON.stringify(e.extensions)}`);
      }
    }
    process.exit(1);
  }
  if (result.data === undefined) {
    console.error(`[FAIL] ${label}: empty data`);
    process.exit(1);
  }
  console.log(`[OK]   ${label}`);
  return result.data;
};

/**
 * Low-level HTTPS GET that captures status + headers + raw body —
 * suitable for OAuth-endpoint probing where the response may be HTML,
 * a redirect, or a non-standard error JSON shape that we don't want
 * `fetch` to silently massage.
 */
export const rawGet = (url: string): Promise<RawHttpResponse> => {
  const u = new URL(url);
  return new Promise((resolveP, rejectP) => {
    const req = request(
      {
        hostname: u.hostname,
        port: u.port === '' ? 443 : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        // Don't auto-follow redirects — the redirect target is the
        // load-bearing finding for OAuth probes.
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    req.end();
  });
};

/**
 * Low-level HTTPS POST with `application/x-www-form-urlencoded` body.
 * Used to probe `/oauth2/token` rejections without the standard
 * GraphQL-shaped error envelope.
 */
export const rawPostForm = (
  url: string,
  formBody: Record<string, string>,
): Promise<RawHttpResponse> => {
  const u = new URL(url);
  const payload = new URLSearchParams(formBody).toString();
  return new Promise((resolveP, rejectP) => {
    const req = request(
      {
        hostname: u.hostname,
        port: u.port === '' ? 443 : Number(u.port),
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolveP({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', rejectP);
      },
    );
    req.on('error', rejectP);
    req.write(payload);
    req.end();
  });
};

/**
 * Pretty-prints a captured raw HTTP response with the body truncated
 * to the first ~600 chars (the probe matrix calls this many times;
 * truncation keeps the terminal output readable).
 */
export const printRaw = (label: string, res: RawHttpResponse): void => {
  console.log(`\n[RAW] ${label}`);
  console.log(`  status: ${res.status.toString()}`);
  const ct = res.headers['content-type'];
  console.log(`  content-type: ${typeof ct === 'string' ? ct : '(multi)'}`);
  const loc = res.headers['location'];
  if (typeof loc === 'string') {
    console.log(`  location: ${loc}`);
  }
  const trimmed = res.body.length > 600
    ? `${res.body.slice(0, 600)}…(truncated, total ${res.body.length.toString()} bytes)`
    : res.body;
  console.log(`  body: ${trimmed}`);
};
