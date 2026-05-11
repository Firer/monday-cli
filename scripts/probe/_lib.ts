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
 * GraphQL type reference, three `ofType` levels deep — covers the
 * standard `NON_NULL<LIST<NON_NULL<NamedType>>>` chain Monday's schema
 * uses for collection wrappers. The M23 favorites-deep probe needed
 * the third level; shallower consumers ignore the inner `ofType`s.
 */
export interface IntrospectedTypeRef {
  readonly name: string | null;
  readonly kind: string;
  readonly ofType: {
    readonly name: string | null;
    readonly kind: string;
    readonly ofType: {
      readonly name: string | null;
      readonly kind: string;
      readonly ofType: { readonly name: string | null; readonly kind: string } | null;
    } | null;
  } | null;
}

export interface IntrospectedField {
  readonly name: string;
  readonly description: string | null;
  readonly args: ReadonlyArray<{
    readonly name: string;
    readonly description: string | null;
    readonly type: IntrospectedTypeRef;
  }>;
  readonly type: IntrospectedTypeRef;
}

export interface IntrospectedType {
  readonly name: string;
  readonly kind: string;
  readonly description: string | null;
  readonly fields: ReadonlyArray<IntrospectedField> | null;
  readonly enumValues: ReadonlyArray<{
    readonly name: string;
    readonly description: string | null;
  }> | null;
  readonly possibleTypes: ReadonlyArray<{ readonly name: string }> | null;
}

/**
 * Introspects a Monday GraphQL type by name. Returns `null` when the
 * type doesn't exist on the schema (Monday's `__type` returns null,
 * not an error — every existing probe-script consumer distinguishes
 * "type missing" from "GraphQL error" inline, so this preserves that
 * contract).
 *
 * Lift surfaced by v0.3-plan §22 R-NEW-5: the M22 probe matrix had
 * four consumers (`m22-usage-{extended,daily,platform-api,analytics,
 * by-day}.ts`) and the M23 pre-flight added five more (`m23-favorites
 * .ts`, `m23-favorites-deep.ts`, `m23-hierarchy-item.ts`,
 * `m23-hierarchy-object.ts`, `m23-monday-object-enum.ts`) — 9+ total,
 * well above the R-class 3-consumer trigger. Each spelled the same
 * `__type(name:) { name kind description fields { ... } enumValues
 * { ... } possibleTypes { ... } }` selection in ~30 LOC blocks. The
 * lift collapses those blocks into a single helper call while
 * preserving the richest-superset shape so future pre-flights
 * (M24+M25+M26+M27+M28) can introspect any type kind (OBJECT, ENUM,
 * UNION, INTERFACE, SCALAR) from one entry point.
 *
 * Variables-based rather than string-interpolated — defensive against
 * future type names containing characters that would break the inline
 * GraphQL string.
 */
export const introspectType = async (
  typeName: string,
): Promise<IntrospectedType | null> => {
  const result = await gql<{ __type: IntrospectedType | null }>(
    `query Introspect($name: String!) {
       __type(name: $name) {
         name kind description
         fields {
           name description
           args { name description type { name kind ofType { name kind ofType { name kind ofType { name kind } } } } }
           type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }
         }
         enumValues(includeDeprecated: true) { name description }
         possibleTypes { name }
       }
     }`,
    { name: typeName },
    'Introspect',
  );
  return expect(`introspectType("${typeName}")`, result).__type;
};

/**
 * Pretty-prints an introspected type. Mirrors the inline `probeType`
 * / `printFields` shape the M22+M23 probes converged on:
 * `- fieldName (kind/name[ofType-kind/ofType-name])` per field, plus
 * per-kind sections for enumValues + possibleTypes. Prints "(missing)"
 * when the helper returned `null`.
 */
export const printIntrospected = (
  label: string,
  introspected: IntrospectedType | null,
): void => {
  console.log(`\n[INTROSPECT] ${label}`);
  if (introspected === null) {
    console.log('  (type not found on schema)');
    return;
  }
  console.log(`  name: ${introspected.name}`);
  console.log(`  kind: ${introspected.kind}`);
  if (introspected.description !== null) {
    console.log(`  description: ${introspected.description}`);
  }
  if (introspected.fields !== null) {
    console.log(`  fields: ${introspected.fields.length.toString()}`);
    for (const f of introspected.fields) {
      const oft = f.type.ofType === null
        ? ''
        : `[${f.type.ofType.kind}/${f.type.ofType.name ?? '<wrapped>'}]`;
      console.log(
        `    - ${f.name} -> ${f.type.kind}/${f.type.name ?? '<wrapped>'}${oft}`,
      );
    }
  }
  if (introspected.enumValues !== null) {
    console.log(`  enumValues: ${introspected.enumValues.length.toString()}`);
    for (const v of introspected.enumValues) {
      console.log(`    - ${v.name}${v.description === null ? '' : ` — ${v.description}`}`);
    }
  }
  if (introspected.possibleTypes !== null) {
    console.log(`  possibleTypes: ${introspected.possibleTypes.length.toString()}`);
    for (const p of introspected.possibleTypes) {
      console.log(`    - ${p.name}`);
    }
  }
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
