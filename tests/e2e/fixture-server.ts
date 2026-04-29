/**
 * In-process HTTP fixture server (`v0.1-plan.md` §5.3).
 *
 * Backs the E2E suite. Listens on a random port, accepts GraphQL
 * POSTs, and replays cassette interactions in order — same format
 * the integration suite consumes (`tests/fixtures/load.ts`). The
 * E2E test then spawns the compiled binary with
 * `MONDAY_API_URL=http://127.0.0.1:<port>` so the production
 * `FetchTransport` path runs end-to-end against canned bytes.
 *
 * The cassette match logic mirrors `FixtureTransport`'s — same
 * `operation_name` / `match_query` / `match_variables` /
 * `expect_headers` semantics — so a fixture written for the
 * integration suite can be replayed by the server without
 * adjustments. The implementation is duplicated rather than imported
 * because the in-process Transport version reads from arbitrary
 * `Transport.request()` shapes; the HTTP version reads from `req.body`
 * after JSON-parsing.
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import type {
  Cassette,
  GraphQlErrorShape,
  Interaction,
} from '../fixtures/load.js';

export interface FixtureServer {
  readonly url: string;
  readonly port: number;
  /** All requests received by the server, in arrival order. */
  readonly requests: readonly RecordedRequest[];
  readonly remaining: () => number;
  readonly close: () => Promise<void>;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

interface RuntimeInteraction {
  readonly spec: Interaction;
  remaining: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

const queryMatches = (
  haystack: string,
  matcher: string | RegExp | undefined,
): boolean => {
  if (matcher === undefined) return true;
  if (typeof matcher === 'string') return haystack.includes(matcher);
  return matcher.test(haystack);
};

const variablesMatch = (
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: Readonly<Record<string, unknown>> | undefined,
): boolean => {
  if (expected === undefined) return true;
  for (const [key, value] of Object.entries(expected)) {
    if (actual === undefined) return false;
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) {
      return false;
    }
  }
  return true;
};

const headersMatch = (
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string | RegExp>> | undefined,
): boolean => {
  if (expected === undefined) return true;
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(actual)) {
    lower[k.toLowerCase()] = v;
  }
  for (const [k, v] of Object.entries(expected)) {
    const got = lower[k.toLowerCase()];
    if (got === undefined) return false;
    if (typeof v === 'string' && got !== v) return false;
    if (v instanceof RegExp && !v.test(got)) return false;
  }
  return true;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface StartFixtureServerOptions {
  readonly cassette: Cassette;
}

export const startFixtureServer = async (
  options: StartFixtureServerOptions,
): Promise<FixtureServer> => {
  const queue: RuntimeInteraction[] = options.cassette.interactions.map(
    (spec) => ({ spec, remaining: spec.repeat ?? 1 }),
  );
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        // Iterating a Node IncomingMessage yields Buffers in normal
        // flowing-mode usage. Tests don't send strings, but defend.
        if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk));
        } else if (chunk instanceof Uint8Array) {
          chunks.push(chunk);
        }
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: unknown;
      try {
        parsed = raw.length === 0 ? null : JSON.parse(raw);
      } catch {
        parsed = raw;
      }
      const recordedHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') {
          recordedHeaders[k] = v;
        } else if (Array.isArray(v) && typeof v[0] === 'string') {
          recordedHeaders[k] = v[0];
        }
      }
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: recordedHeaders,
        body: parsed,
      });

      // Operation name + query + variables come out of a normal
      // GraphQL POST body shape: `{ query, variables, operationName }`.
      const opName = isObject(parsed) ? typeof parsed.operationName === 'string' ? parsed.operationName : undefined : undefined;
      const query = isObject(parsed) && typeof parsed.query === 'string' ? parsed.query : '';
      const variables =
        isObject(parsed) && isObject(parsed.variables) ? parsed.variables : undefined;

      while (queue.length > 0 && (queue[0]?.remaining ?? 0) <= 0) {
        queue.shift();
      }
      const next = queue[0];
      if (next === undefined) {
        respondJson(res, 500, {
          errors: [
            {
              message: `cassette exhausted: no interaction matches operation=${
                opName ?? '<anon>'
              }`,
            },
          ],
        });
        return;
      }
      const spec = next.spec;
      const mismatch = checkMatch(spec, opName, query, variables, recordedHeaders);
      if (mismatch !== undefined) {
        respondJson(res, 500, { errors: [{ message: mismatch }] });
        return;
      }

      next.remaining--;
      if (spec.delay_ms !== undefined && spec.delay_ms > 0) {
        await sleep(spec.delay_ms);
      }

      const status = spec.http_status ?? 200;
      const body =
        spec.response_body !== undefined ? spec.response_body : spec.response;
      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json',
        ...(spec.response_headers ?? {}),
      };
      respondJson(res, status, body, responseHeaders);
    })().catch((err: unknown) => {
      respondJson(res, 500, {
        errors: [
          {
            message:
              err instanceof Error ? err.message : 'fixture server crashed',
          },
        ] as readonly GraphQlErrorShape[],
      });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fixture server failed to bind a TCP address');
  }
  const port = address.port;
  const url = `http://127.0.0.1:${String(port)}`;

  return {
    url,
    port,
    requests,
    remaining: (): number =>
      queue.reduce((sum, i) => sum + Math.max(0, i.remaining), 0),
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err === undefined) resolve();
          else reject(err);
        });
      });
    },
  };
};

const checkMatch = (
  spec: Interaction,
  opName: string | undefined,
  query: string,
  variables: Readonly<Record<string, unknown>> | undefined,
  headers: Readonly<Record<string, string>>,
): string | undefined => {
  if (
    spec.operation_name !== undefined &&
    spec.operation_name !== opName
  ) {
    return `cassette mismatch: expected operation_name=${spec.operation_name}, got ${opName ?? '<anon>'}`;
  }
  if (!queryMatches(query, spec.match_query)) {
    return 'cassette mismatch: match_query did not match the request query';
  }
  if (!variablesMatch(variables, spec.match_variables)) {
    return `cassette mismatch: variables did not match expected ${JSON.stringify(spec.match_variables)}`;
  }
  if (!headersMatch(headers, spec.expect_headers)) {
    return `cassette mismatch: headers did not match expected ${JSON.stringify(spec.expect_headers)}`;
  }
  return undefined;
};

const respondJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = { 'content-type': 'application/json' },
): void => {
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  res.statusCode = status;
  res.end(body === undefined ? '' : JSON.stringify(body));
};
