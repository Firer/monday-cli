/**
 * Three-pass column resolution + value translation for `--set` and
 * `--set-raw` entries.
 *
 * Lifted from five sites — see v0.2-plan §12 R20:
 *   - `api/dry-run.ts planChanges` (single-item dry-run)
 *   - `api/dry-run.ts planCreate` (create dry-run)
 *   - `commands/item/update.ts` action (single-item live)
 *   - `commands/item/update.ts runBulk` (bulk live)
 *   - `commands/item/create.ts` action (create live)
 *
 * Each implemented the same ~80-90 LOC three-pass discipline:
 *
 *   - **Pass (a)** — resolve every `--set` token, then every
 *     `--set-raw` token, against the supplied board. Same-token
 *     duplicates surface as `usage_error` (cli-design §5.3 line
 *     961-972). Archived columns surface as `column_archived` (per
 *     §5.3 step 6 — "Mutations against archived columns return
 *     `column_archived` regardless"). Each leg's `source` /
 *     `cacheAgeSeconds` / `warnings` aggregates into the running
 *     totals.
 *
 *   - **Pass (b)** — cross-token duplicate-resolved-ID check. Two
 *     distinct tokens (e.g. `status` and `id:status_4`, or `--set
 *     status=Done` and `--set-raw id:status_4='{...}'`) resolving to
 *     the same column ID surface as `usage_error`. The check fires
 *     pre-translation to keep the engine from producing a half-built
 *     diff and to avoid translator errors pre-empting the mutual-
 *     exclusion error (Codex M8 finding #2).
 *
 *   - **Pass (c)** — translate. Friendly entries through
 *     `translateColumnValueAsync`; raw entries through
 *     `translateRawColumnValue`. Each catch folds the cumulative
 *     `warnings` array (every leg's warnings) so prior tokens'
 *     collision / `stale_cache_refreshed` signals survive into
 *     the failure envelope's `details.resolver_warnings` (Codex M8
 *     finding #1, M5b R19 contract).
 *
 * **Why this lift earns its place pre-M10.** M10 archive / delete /
 * duplicate don't take `--set` so they're not consumers — but R20's
 * payoff is in the M5b/M9 sites that already exist: a fix to the
 * three-pass shape (bug, perf, contract change) lands in one place
 * rather than five. Also a consistency win — pre-lift the message
 * wording diverged across sites ("Monday rejects mutations against
 * archived columns" vs "Monday rejects writes against archived
 * columns") and the ApiError-vs-MondayCliError catch in pass (c)
 * was inconsistent (planChanges/planCreate caught only `ApiError`,
 * missing translator UsageErrors; update.ts/create.ts caught
 * `MondayCliError`). The lift normalises both.
 *
 * **Behaviour-preservation contract.** Every existing test passes
 * byte-for-byte. The two consistency normalisations above
 * (archived-message wording + UsageError catch in dry-run paths)
 * are observable but no test exercises them, and the unified
 * behaviour is the M5b R19 contract's intent.
 */

import { ApiError, MondayCliError } from '../utils/errors.js';
import type { MondayClient } from './client.js';
import {
  resolveColumnWithRefresh,
  type ResolverWarning,
} from './columns.js';
import {
  translateColumnValueAsync,
  type DateResolutionContext,
  type PeopleResolutionContext,
  type TranslatedColumnValue,
} from './column-values.js';
import { translateRawColumnValue, type ParsedSetRawExpression } from './raw-write.js';
import { foldResolverWarningsIntoError } from './resolver-error-fold.js';
import { mergeSource, mergeCacheAge } from './source-aggregator.js';

export interface SetEntry {
  readonly token: string;
  readonly value: string;
}

export interface ResolvedSet {
  readonly kind: 'set';
  readonly token: string;
  readonly value: string;
  readonly columnId: string;
  readonly columnType: string;
}

export interface ResolvedRaw {
  readonly kind: 'raw';
  readonly token: string;
  readonly entry: ParsedSetRawExpression;
  readonly columnId: string;
  readonly columnType: string;
}

export type ResolvedEntry = ResolvedSet | ResolvedRaw;

export interface ResolveAndTranslateInputs {
  readonly client: MondayClient;
  /**
   * The board column tokens resolve against. For `item set` /
   * `item update` (single + bulk), this is the item's home board.
   * For `item create` top-level, the explicit `--board <bid>`. For
   * `item create --parent`, the auto-derived subitems board.
   */
  readonly boardId: string;
  readonly setEntries: readonly SetEntry[];
  readonly rawEntries: readonly ParsedSetRawExpression[];
  readonly dateResolution?: DateResolutionContext;
  readonly peopleResolution?: PeopleResolutionContext;
  readonly env?: NodeJS.ProcessEnv;
  readonly noCache?: boolean;
  /**
   * Initial `source` seed. Defaults to `undefined` so the first leg
   * of resolution becomes the seed value. Bulk callers pass the
   * board-metadata leg's source (`'cache'` or `'live'`) so the
   * downstream aggregator reflects every leg that fired (Codex M8
   * finding #3 in update.ts bulk).
   */
  readonly initialSource?: 'live' | 'cache' | 'mixed';
  /**
   * Initial `cacheAgeSeconds` seed. Defaults to `null`. Bulk callers
   * pass the board-metadata cacheAge so a cache-served metadata leg
   * shows up in the worst-case staleness aggregate.
   */
  readonly initialCacheAgeSeconds?: number | null;
}

export interface ResolveAndTranslateResult {
  readonly resolved: readonly ResolvedEntry[];
  /**
   * Translated values in argv order — `setEntries` first (in their
   * argv order), then `rawEntries` (in their argv order). Callers
   * downstream of the helper iterate this for their wire payload
   * builders (`selectMutation` / `bundleColumnValues`).
   */
  readonly translated: readonly TranslatedColumnValue[];
  /**
   * Token → resolved column ID echo per cli-design §5.3 step 2 and
   * §6.4 mutation-envelope shape.
   */
  readonly resolvedIds: Readonly<Record<string, string>>;
  /**
   * Cumulative resolver warnings across every resolution leg.
   * Callers fold these into the success envelope's `warnings` slot
   * and into the failure envelope's `details.resolver_warnings` via
   * `foldResolverWarningsIntoError` (already done internally by the
   * helper for every typed throw it raises — callers re-fold only
   * for downstream throws their own catch arms produce).
   */
  readonly warnings: readonly ResolverWarning[];
  /**
   * Aggregate envelope source. `undefined` only when the helper was
   * called with zero entries AND no `initialSource`; in practice
   * callers gate the empty case before calling the helper.
   */
  readonly source: 'live' | 'cache' | 'mixed' | undefined;
  readonly cacheAgeSeconds: number | null;
}

const SAME_SET_TOKEN_MESSAGE = (token: string): string =>
  `Multiple --set entries target column token ${JSON.stringify(token)}. ` +
  `Pass at most one --set per column; if two tokens resolve to the ` +
  `same column ID after NFC + case-fold normalisation, use the ` +
  `\`id:<column_id>\` prefix to disambiguate.`;

const SAME_RAW_OR_SHARED_TOKEN_MESSAGE = (token: string): string =>
  `Multiple --set / --set-raw entries target column token ` +
  `${JSON.stringify(token)}. Pass at most one per column; ` +
  `if two tokens resolve to the same column ID after NFC + ` +
  `case-fold normalisation, use the \`id:<column_id>\` prefix to ` +
  `disambiguate.`;

const ARCHIVED_MESSAGE = (columnId: string, boardId: string): string =>
  `Column ${JSON.stringify(columnId)} on board ` +
  `${boardId} is archived. Monday rejects writes against ` +
  `archived columns; un-archive the column or pick a different target.`;

/**
 * Builds a `column_archived` ApiError with the unified §6.5 wording
 * + the canonical `details` slot (column_id / column_title /
 * column_type / board_id). Single source of truth for the
 * pre-mutation archived-column check; the three single-token
 * surfaces (`item set`, `item clear`, `planClear`) call this so the
 * message matches the helper-backed multi-token surfaces (`item
 * update` single + bulk, `item create`, `planChanges`,
 * `planCreate`). Mirrors the M5b R19 message convention; the
 * `column_archived` error from the post-mutation F4 remap in
 * `resolver-error-fold.ts` keeps its remap-specific message because
 * the remap context is observably distinct (forced refresh +
 * `details.remapped_from`).
 */
export const buildColumnArchivedError = (inputs: {
  readonly columnId: string;
  readonly columnTitle: string;
  readonly columnType: string;
  readonly boardId: string;
}): ApiError =>
  new ApiError('column_archived', ARCHIVED_MESSAGE(inputs.columnId, inputs.boardId), {
    details: {
      column_id: inputs.columnId,
      column_title: inputs.columnTitle,
      column_type: inputs.columnType,
      board_id: inputs.boardId,
    },
  });

export const resolveAndTranslate = async (
  inputs: ResolveAndTranslateInputs,
): Promise<ResolveAndTranslateResult> => {
  const warnings: ResolverWarning[] = [];
  const resolvedIds: Record<string, string> = {};
  let aggregateSource: 'live' | 'cache' | 'mixed' | undefined =
    inputs.initialSource;
  let aggregateCacheAge: number | null = inputs.initialCacheAgeSeconds ?? null;
  const resolved: ResolvedEntry[] = [];

  // Pass (a-set) — resolve every --set token. `includeArchived: true`
  // so archived columns surface as `column_archived` rather than
  // `column_not_found` (cli-design §5.3 step 6).
  for (const entry of inputs.setEntries) {
    if (resolvedIds[entry.token] !== undefined) {
      throw foldResolverWarningsIntoError(
        new ApiError('usage_error', SAME_SET_TOKEN_MESSAGE(entry.token), {
          details: {
            token: entry.token,
            resolved_id: resolvedIds[entry.token],
          },
        }),
        warnings,
      );
    }
    const resolution = await resolveColumnWithRefresh({
      client: inputs.client,
      boardId: inputs.boardId,
      token: entry.token,
      includeArchived: true,
      ...(inputs.env === undefined ? {} : { env: inputs.env }),
      ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
    });
    warnings.push(...resolution.warnings);
    aggregateSource = mergeSource(aggregateSource, resolution.source);
    aggregateCacheAge = mergeCacheAge(aggregateCacheAge, resolution.cacheAgeSeconds);

    if (resolution.match.column.archived === true) {
      throw foldResolverWarningsIntoError(
        buildColumnArchivedError({
          columnId: resolution.match.column.id,
          columnTitle: resolution.match.column.title,
          columnType: resolution.match.column.type,
          boardId: inputs.boardId,
        }),
        warnings,
      );
    }

    resolved.push({
      kind: 'set',
      token: entry.token,
      value: entry.value,
      columnId: resolution.match.column.id,
      columnType: resolution.match.column.type,
    });
    resolvedIds[entry.token] = resolution.match.column.id;
  }

  // Pass (a-raw) — resolve every --set-raw token. Same-token
  // duplicates within raw OR shared with a friendly --set entry
  // surface as usage_error per cli-design §5.3 line 961-972.
  for (const entry of inputs.rawEntries) {
    if (resolvedIds[entry.token] !== undefined) {
      throw foldResolverWarningsIntoError(
        new ApiError('usage_error', SAME_RAW_OR_SHARED_TOKEN_MESSAGE(entry.token), {
          details: {
            token: entry.token,
            resolved_id: resolvedIds[entry.token],
          },
        }),
        warnings,
      );
    }
    const resolution = await resolveColumnWithRefresh({
      client: inputs.client,
      boardId: inputs.boardId,
      token: entry.token,
      includeArchived: true,
      ...(inputs.env === undefined ? {} : { env: inputs.env }),
      ...(inputs.noCache === undefined ? {} : { noCache: inputs.noCache }),
    });
    warnings.push(...resolution.warnings);
    aggregateSource = mergeSource(aggregateSource, resolution.source);
    aggregateCacheAge = mergeCacheAge(aggregateCacheAge, resolution.cacheAgeSeconds);

    if (resolution.match.column.archived === true) {
      throw foldResolverWarningsIntoError(
        buildColumnArchivedError({
          columnId: resolution.match.column.id,
          columnTitle: resolution.match.column.title,
          columnType: resolution.match.column.type,
          boardId: inputs.boardId,
        }),
        warnings,
      );
    }

    resolved.push({
      kind: 'raw',
      token: entry.token,
      entry,
      columnId: resolution.match.column.id,
      columnType: resolution.match.column.type,
    });
    resolvedIds[entry.token] = resolution.match.column.id;
  }

  // Pass (b) — cross-token duplicate-resolved-ID check.
  const seenColumnIds = new Set<string>();
  for (const r of resolved) {
    if (seenColumnIds.has(r.columnId)) {
      throw foldResolverWarningsIntoError(
        new ApiError(
          'usage_error',
          `Multiple --set / --set-raw entries resolve to the same column ID ` +
            `${JSON.stringify(r.columnId)} (last token: ` +
            `${JSON.stringify(r.token)}). Pass at most one per column.`,
          {
            details: {
              column_id: r.columnId,
              tokens: resolved
                .filter((x) => x.columnId === r.columnId)
                .map((x) => x.token),
            },
          },
        ),
        warnings,
      );
    }
    seenColumnIds.add(r.columnId);
  }

  // Pass (c) — translate. Order preserved: friendly --set entries
  // first (argv order), then raw entries (argv order). Each catch
  // folds the cumulative `warnings` so prior tokens' collision /
  // stale_cache_refreshed signals survive (Codex M8 finding #1,
  // M5b R19 contract). MondayCliError catches both translator
  // UsageErrors (date / dropdown / people invalid input) and
  // ApiErrors (`unsupported_column_type`, `user_not_found`); pre-
  // lift the dry-run paths only caught ApiError, missing translator
  // UsageErrors that the M5b contract says should fold.
  const translated: TranslatedColumnValue[] = [];
  for (const r of resolved) {
    if (r.kind === 'set') {
      try {
        const t = await translateColumnValueAsync({
          column: { id: r.columnId, type: r.columnType },
          value: r.value,
          ...(inputs.dateResolution === undefined
            ? {}
            : { dateResolution: inputs.dateResolution }),
          ...(inputs.peopleResolution === undefined
            ? {}
            : { peopleResolution: inputs.peopleResolution }),
        });
        translated.push(t);
      } catch (err) {
        if (err instanceof MondayCliError) {
          throw foldResolverWarningsIntoError(err, warnings);
        }
        throw err;
      }
    } else {
      try {
        const t = translateRawColumnValue(
          { id: r.columnId, type: r.columnType },
          r.entry.value,
          r.entry.rawJson,
        );
        translated.push(t);
      } catch (err) {
        if (err instanceof MondayCliError) {
          throw foldResolverWarningsIntoError(err, warnings);
        }
        throw err;
      }
    }
  }

  return {
    resolved,
    translated,
    resolvedIds,
    warnings,
    source: aggregateSource,
    cacheAgeSeconds: aggregateCacheAge,
  };
};
