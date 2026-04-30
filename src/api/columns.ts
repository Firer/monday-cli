/**
 * Column read-resolver (`cli-design.md` §5.3, `v0.1-plan.md` §3 M3).
 *
 * Token → column ID resolution. The same module is reused by:
 *   - `board describe` (lists columns by ID + title);
 *   - the M4 filter parser (`--where status=Done` resolves "status");
 *   - M5a's value translator (`--set status=Done` resolves "status").
 *
 * Resolution order, from §5.3 step 2:
 *   1. Exact match against column IDs (case-sensitive — Monday IDs are
 *      stable lowercase snake_case).
 *   2. Exact match against column titles after NFC normalisation +
 *      whitespace trim + internal whitespace collapse.
 *   3. Case-folded title match (Unicode-aware, locale-independent).
 *   4. Ambiguous → `ambiguous_column` with `details.candidates`.
 *   5. No match → `column_not_found`. Before surfacing, the caller
 *      can opt into a single auto-refresh of the board metadata via
 *      `resolveColumnWithRefresh` — guards against stale-cache false
 *      negatives after a column was added.
 *
 * **`title:` / `id:` prefix syntax** (§5.3 step 3) — explicit override
 * for the rare ID-vs-title collision case. The CLI returns the
 * matched column with no warning; the caller is asserting which
 * disambiguation they want.
 *
 * **`--include-archived`** (§5.3 step 6) — archived columns are not
 * resolvable by default. The resolver filters them out unless the
 * caller passes `includeArchived: true`. Mutations against archived
 * columns return `column_archived` regardless — that's M5b's
 * concern; this module's job is the lookup.
 */

import { ApiError } from '../utils/errors.js';
import {
  loadBoardMetadata,
  refreshBoardMetadata,
  type BoardColumn,
  type BoardMetadata,
} from './board-metadata.js';
import type { BoardId } from '../types/ids.js';
import type { MondayClient } from './client.js';

export interface ResolveColumnOptions {
  /**
   * Caller-controlled scope. Archived columns are filtered out unless
   * this is true. Mutation paths in M5b set this to false; read paths
   * (`board columns`, `board describe`) honour the flag.
   */
  readonly includeArchived?: boolean;
}

export interface ColumnMatch {
  /** The resolved column. */
  readonly column: BoardColumn;
  /**
   * How the match landed:
   *   - `id`        — exact ID match.
   *   - `title`     — exact title (NFC-normalised) match.
   *   - `case_fold` — case-folded title match.
   *   - `prefix_id` / `prefix_title` — caller used the explicit
   *     `id:`/`title:` prefix; deterministic regardless of collision.
   */
  readonly via: 'id' | 'title' | 'case_fold' | 'prefix_id' | 'prefix_title';
  /**
   * Per `cli-design.md` §5.3 step 3: when a token matches a column's
   * ID *and* another column's title (after normalisation), the ID
   * match wins (deterministic) but a `column_token_collision`
   * warning surfaces so the caller can emit it on the envelope.
   * Empty when no collision exists or `via` isn't `id` /
   * `prefix_id`.
   */
  readonly collisionCandidates: readonly { readonly id: string; readonly title: string; readonly type: string }[];
}

const detectCollision = (
  visible: readonly BoardColumn[],
  match: BoardColumn,
): readonly { readonly id: string; readonly title: string; readonly type: string }[] => {
  const target = caseFold(normaliseTitle(match.id));
  const candidates = visible.filter(
    (c) => c.id !== match.id && caseFold(normaliseTitle(c.title)) === target,
  );
  return candidates.map((c) => ({ id: c.id, title: c.title, type: c.type }));
};

/**
 * NFC-normalises, trims, and collapses internal runs of whitespace
 * to a single space. Per §5.3 step 2.b — all four bullets in one
 * pass so callers don't accidentally apply the steps in a different
 * order.
 */
const normaliseTitle = (s: string): string =>
  s.normalize('NFC').trim().replace(/\s+/gu, ' ');

/**
 * Locale-independent case-fold. Unicode standard-issue: lower-case
 * via the `und` (undefined / language-neutral) locale tag so a
 * Turkish dotless-I doesn't decide it lowercases differently from
 * everywhere else. Same rule the design's "case-folded
 * (Unicode-aware, locale-independent)" line names.
 */
const caseFold = (s: string): string => s.toLocaleLowerCase('und');

/**
 * Splits an explicit-prefix token (`id:status_4` or `title:Status`)
 * into its parts. Returns `undefined` for tokens with no prefix; the
 * caller falls through to the implicit-resolution path. Only the
 * literal prefixes `id:` and `title:` are recognised — anything else
 * (`status:Done` is a filter operator, not a prefix) is left to the
 * caller's parser.
 */
export const parseColumnTokenPrefix = (
  token: string,
):
  | { readonly kind: 'id' | 'title'; readonly value: string }
  | undefined => {
  if (token.startsWith('id:')) {
    return { kind: 'id', value: token.slice(3) };
  }
  if (token.startsWith('title:')) {
    return { kind: 'title', value: token.slice(6) };
  }
  return undefined;
};

const filterColumns = (
  metadata: BoardMetadata,
  includeArchived: boolean,
): readonly BoardColumn[] =>
  includeArchived
    ? metadata.columns
    : metadata.columns.filter((c) => c.archived !== true);

const candidateDetails = (
  matches: readonly BoardColumn[],
): readonly Readonly<Record<string, string>>[] =>
  matches.map((c) => ({ id: c.id, title: c.title, type: c.type }));

/**
 * Resolves a token against a board's metadata. Pure function — no
 * I/O. The auto-refresh-on-not-found path is in
 * `resolveColumnWithRefresh` because that needs a client.
 *
 * Per §5.3 step 6, archived columns are filtered out of the
 * resolver's view by default — they surface as `column_not_found`,
 * not `column_archived`. The `column_archived` code is reserved for
 * mutations that the M5b writer raises after explicitly resolving
 * with `includeArchived: true` and inspecting the matched column.
 *
 * Throws `ApiError('ambiguous_column' | 'column_not_found')` per
 * §6.5.
 */
export const resolveColumn = (
  metadata: BoardMetadata,
  token: string,
  options: ResolveColumnOptions = {},
): ColumnMatch => {
  const includeArchived = options.includeArchived ?? false;
  const visible = filterColumns(metadata, includeArchived);

  const prefix = parseColumnTokenPrefix(token);
  if (prefix !== undefined) {
    return resolvePrefixed(visible, prefix, token);
  }

  // Step 1: exact ID match (case-sensitive). Restricted to the
  // visible set so an archived column doesn't resolve via its id.
  const idMatch = visible.find((c) => c.id === token);
  if (idMatch !== undefined) {
    return { column: idMatch, via: 'id', collisionCandidates: detectCollision(visible, idMatch) };
  }

  // Step 2: NFC-normalised exact title match.
  const target = normaliseTitle(token);
  const titleMatches = visible.filter(
    (c) => normaliseTitle(c.title) === target,
  );
  if (titleMatches.length > 1) {
    throw ambiguous(token, titleMatches);
  }
  const [titleOnly] = titleMatches;
  if (titleOnly !== undefined) {
    return { column: titleOnly, via: 'title', collisionCandidates: [] };
  }

  // Step 3: case-fold fallback. We only fall here when the
  // NFC-exact pass produced zero matches.
  const folded = caseFold(target);
  const foldedMatches = visible.filter(
    (c) => caseFold(normaliseTitle(c.title)) === folded,
  );
  if (foldedMatches.length > 1) {
    throw ambiguous(token, foldedMatches);
  }
  const [foldedOnly] = foldedMatches;
  if (foldedOnly !== undefined) {
    return { column: foldedOnly, via: 'case_fold', collisionCandidates: [] };
  }

  throw notFound(token, metadata, includeArchived);
};

const resolvePrefixed = (
  visible: readonly BoardColumn[],
  prefix: { readonly kind: 'id' | 'title'; readonly value: string },
  rawToken: string,
): ColumnMatch => {
  if (prefix.kind === 'id') {
    const exact = visible.find((c) => c.id === prefix.value);
    if (exact === undefined) {
      throw notFoundForToken(rawToken, visible);
    }
    return {
      column: exact,
      via: 'prefix_id',
      collisionCandidates: detectCollision(visible, exact),
    };
  }
  const target = normaliseTitle(prefix.value);
  const exactMatches = visible.filter(
    (c) => normaliseTitle(c.title) === target,
  );
  if (exactMatches.length > 1) {
    throw ambiguous(rawToken, exactMatches);
  }
  const [exactOnly] = exactMatches;
  if (exactOnly !== undefined) {
    return { column: exactOnly, via: 'prefix_title', collisionCandidates: [] };
  }
  const folded = caseFold(target);
  const foldedMatches = visible.filter(
    (c) => caseFold(normaliseTitle(c.title)) === folded,
  );
  if (foldedMatches.length > 1) {
    throw ambiguous(rawToken, foldedMatches);
  }
  const [foldedOnly] = foldedMatches;
  if (foldedOnly !== undefined) {
    return { column: foldedOnly, via: 'prefix_title', collisionCandidates: [] };
  }
  throw notFoundForToken(rawToken, visible);
};

const ambiguous = (token: string, matches: readonly BoardColumn[]): ApiError =>
  new ApiError(
    'ambiguous_column',
    `Token ${JSON.stringify(token)} matches ${String(matches.length)} columns; ` +
      'retry with the explicit "id:<column_id>" prefix.',
    {
      details: {
        token,
        candidates: candidateDetails(matches),
      },
    },
  );

const notFound = (
  token: string,
  metadata: BoardMetadata,
  includeArchived: boolean,
): ApiError =>
  new ApiError(
    'column_not_found',
    `No column on board ${metadata.id} matches token ${JSON.stringify(token)}`,
    {
      details: {
        token,
        board_id: metadata.id,
        include_archived: includeArchived,
      },
    },
  );

const notFoundForToken = (
  token: string,
  visible: readonly BoardColumn[],
): ApiError =>
  new ApiError(
    'column_not_found',
    `No column matches token ${JSON.stringify(token)}`,
    {
      details: {
        token,
        candidate_count: visible.length,
      },
    },
  );

export interface ResolveColumnWithRefreshInputs {
  readonly client: MondayClient;
  readonly boardId: BoardId | string;
  readonly token: string;
  readonly includeArchived?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
}

export interface ResolveColumnWithRefreshResult {
  readonly match: ColumnMatch;
  readonly metadata: BoardMetadata;
  /**
   * `cli-design.md` §6.1 `meta.source` for the resolution payload:
   *   - `live`  — the metadata was fetched live (cache miss / refresh /
   *     `--no-cache`).
   *   - `cache` — the cache served and the resolution succeeded.
   *   - `mixed` — the cache served but missed the column, then a
   *     refresh produced the resolution. Per §8 / Codex M3 pass-1 §4
   *     this is the case that warrants the `stale_cache_refreshed`
   *     warning so the caller knows the cache was wrong.
   */
  readonly source: 'live' | 'cache' | 'mixed';
  readonly cacheAgeSeconds: number | null;
  /**
   * Resolver-emitted warnings the caller should fold into its envelope:
   *   - `column_token_collision` (§5.3 step 3) — the token matched a
   *     column ID *and* another column's title; the ID match won.
   *   - `stale_cache_refreshed` — auto-refresh fired and resolved the
   *     missing column.
   */
  readonly warnings: readonly ResolverWarning[];
}

export interface ResolverWarning {
  readonly code: 'column_token_collision' | 'stale_cache_refreshed';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

const collisionWarning = (
  match: ColumnMatch,
): ResolverWarning | undefined => {
  if (match.collisionCandidates.length === 0) return undefined;
  return {
    code: 'column_token_collision',
    message:
      `Token matched column id "${match.column.id}" and ` +
      `${String(match.collisionCandidates.length)} title(s); the ID match wins.`,
    details: {
      via: match.via,
      resolved_id: match.column.id,
      candidates: match.collisionCandidates,
    },
  };
};

/**
 * Resolves a column token, auto-refreshing the board metadata cache
 * **once** on `column_not_found` per §5.3 step 5. Other resolution
 * errors (`ambiguous_column`, `column_archived`) bubble out
 * immediately — refreshing wouldn't change them.
 *
 * `noCache: true` short-circuits the refresh path because the live
 * data was already used; `column_not_found` is final under that
 * mode.
 */
export const resolveColumnWithRefresh = async (
  inputs: ResolveColumnWithRefreshInputs,
): Promise<ResolveColumnWithRefreshResult> => {
  const env = inputs.env ?? process.env;
  const includeArchived = inputs.includeArchived ?? false;

  const first = await loadBoardMetadata({
    client: inputs.client,
    boardId: inputs.boardId,
    env,
    ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
  });

  try {
    const match = resolveColumn(first.metadata, inputs.token, { includeArchived });
    const warnings: ResolverWarning[] = [];
    const collision = collisionWarning(match);
    if (collision !== undefined) warnings.push(collision);
    return {
      match,
      metadata: first.metadata,
      source: first.source,
      cacheAgeSeconds: first.cacheAgeSeconds,
      warnings,
    };
  } catch (err) {
    const isMissing =
      err instanceof ApiError && err.code === 'column_not_found';
    if (!isMissing || first.source === 'live' || inputs.noCache === true) {
      throw err;
    }
    // Cache hit + missing column → one chance to refresh.
    const refreshed = await refreshBoardMetadata({
      client: inputs.client,
      boardId: inputs.boardId,
      env,
    });
    const match = resolveColumn(refreshed.metadata, inputs.token, {
      includeArchived,
    });
    const warnings: ResolverWarning[] = [
      {
        code: 'stale_cache_refreshed',
        message:
          'Cache miss for token; refreshed board metadata to resolve.',
        details: {
          board_id: refreshed.metadata.id,
          token: inputs.token,
        },
      },
    ];
    const collision = collisionWarning(match);
    if (collision !== undefined) warnings.push(collision);
    return {
      match,
      metadata: refreshed.metadata,
      source: 'mixed',
      cacheAgeSeconds: null,
      warnings,
    };
  }
};
