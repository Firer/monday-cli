/**
 * Pure people-resolution helpers for the `people` column-value
 * translator (`cli-design.md` §5.3 step 3, the people grammar
 * line 728-734 + the `me` token rule line 704-707).
 *
 * Surface:
 *
 *   - `parsePeopleInput` — accepts the comma-split email list +
 *     `me` token sugar `cli-design.md` §5.3 step 3 enumerates and
 *     returns the Monday wire payload (`{personsAndTeams: [...]}`).
 *     Async because email→ID resolution can hit the network; the
 *     caller injects a `PeopleResolutionContext` carrying
 *     `resolveMe` + `resolveEmail` callbacks so this module stays
 *     pure (no `client` imports — same inversion `filters.ts` uses
 *     for its `me` plumbing).
 *
 * **Why a separate module.** column-values.ts owns translator
 * *dispatch* — the switch over WritableColumnType, the
 * mutation-selection helper, and the ApiError builder. The people
 * translator's machinery is a small async function with regex
 * shape-checks + token classification + safe-integer conversion;
 * splitting keeps column-values.ts at one screen of dispatch logic
 * and the people-specific concerns isolated for unit testing —
 * same template `dates.ts` followed in the previous M5a session.
 *
 * **Why the `me` callback shape mirrors filters.ts.** `filters.ts`
 * already takes `resolveMe: () => Promise<string>` for its `me`
 * sugar on people-style columns. M5b's command layer plumbs the
 * same callback through both surfaces — agents learning one `me`
 * rule for read filters don't need to learn a different one for
 * `--set`. A second callback (`resolveEmail`) handles the email
 * branch; M5b will wire it to `resolvers.userByEmail` (which owns
 * the directory cache + `users(emails:)` fallback).
 *
 * **No `kind: 'team'` support in v0.1.** cli-design.md §5.3 step 3
 * line 730 prescribes `{id, kind: 'person'}` only. Monday's API
 * accepts `kind: 'team'` for team assignments but the design
 * defers teams to a v0.2 candidate. Logged as a spec gap in
 * v0.1-plan.md §3 M5a.
 *
 * **Numeric tokens rejected.** cli-design.md §5.3 step 3 only
 * lists emails + `me`. Numeric tokens (`--set Owner=12345`) are
 * rejected with a `usage_error` pointing at `--set-raw '{
 * "personsAndTeams": [{"id": 12345, "kind": "person"}]}'` so
 * agents that already have a user ID can paste-and-edit. cli-
 * design doesn't say either way; logged as a spec gap.
 */

import { ApiError, UsageError } from '../utils/errors.js';

/**
 * Wire payload shape for a `people` column. Matches Monday's
 * `change_column_value(value: JSON!)` JSON scalar:
 *   `{personsAndTeams: [{id: <number>, kind: 'person'}, ...]}`
 *
 * cli-design.md §5.3 step 3 line 730 pins the shape exactly:
 *   - `id` is an integer (number, not string — Monday's user IDs
 *     are auto-incremented integers and the JSON scalar serialises
 *     a number as a number).
 *   - `kind` is the literal string `'person'` (singular `person`
 *     is deprecated; `personsAndTeams` is the plural canonical
 *     wire-shape key — Monday's per-column blob spelling).
 *
 * Frozen to one-of-two shapes by the literal type on `kind` so
 * any future "send `team`" branch fails type-checking until the
 * union is widened intentionally.
 */
export interface PeoplePayload {
  readonly personsAndTeams: readonly PeoplePayloadEntry[];
}

export interface PeoplePayloadEntry {
  readonly id: number;
  readonly kind: 'person';
}

export interface PeopleResolutionContext {
  /**
   * Resolves the `me` token to the current user's ID. Async because
   * the production path issues a `me { id }` query; tests stub it
   * synchronously. Mirrors `filters.ts`'s `resolveMe` slot one-to-one
   * so the same M5b wiring resolves `me` for both `--where owner=me`
   * (filter) and `--set Owner=me` (write).
   *
   * Called at most once per `parsePeopleInput` call regardless of
   * how many `me` tokens appear in the input — same caching shape
   * `filters.ts` uses.
   */
  readonly resolveMe: () => Promise<string>;
  /**
   * Resolves an email to a Monday user ID. Throws
   * `ApiError(user_not_found)` for unknown emails — the translator
   * surfaces this verbatim per cli-design.md §5.3 step 3 line 733.
   * M5b wires this to `resolvers.userByEmail` (which owns the
   * directory cache + `users(emails:)` fallback).
   *
   * Email matching is the callback's responsibility — `userByEmail`
   * already does NFC + case-fold per its own contract. The
   * translator forwards the verbatim email so the unmatched-email
   * detail in any thrown `user_not_found` echoes what the agent
   * typed.
   */
  readonly resolveEmail: (email: string) => Promise<string>;
}

export interface ParsedPeopleInput {
  readonly payload: PeoplePayload;
}

/**
 * Parses a `people` column input per cli-design.md §5.3 step 3.
 *
 * Accepted inputs:
 *   - **Single email** `alice@example.com` → one-element
 *     `personsAndTeams` payload.
 *   - **Multiple emails** `alice@example.com,bob@example.com` →
 *     comma-split, per-segment trimmed, empty segments dropped;
 *     each email resolved through `ctx.resolveEmail`.
 *   - **`me` token** (case-insensitive) `me` / `ME` / `Me` →
 *     resolved through `ctx.resolveMe` to the connected user's ID.
 *   - **Mixed** `me,alice@example.com` → both resolve, ordered.
 *
 * Throws `usage_error` (UsageError):
 *   - empty input after trim+filter (no labels, no IDs);
 *   - numeric token (`--set Owner=12345`) — agents with a raw
 *     user ID use `--set-raw '{"personsAndTeams":[{"id":N,
 *     "kind":"person"}]}'` to bypass the friendly translator.
 *   - resolved user ID exceeds `Number.MAX_SAFE_INTEGER` (2^53 - 1)
 *     — defensive guard against a future Monday user-ID range
 *     expansion. Same shape as the status / dropdown safe-integer
 *     guards.
 *
 * Throws `ApiError(user_not_found)` (bubbled from
 * `ctx.resolveEmail`) for unknown emails per cli-design.md §5.3
 * step 3 line 733.
 *
 * @param raw - The raw user-supplied value (post-`--set` parsing).
 * @param columnId - Column ID for error messages.
 * @param ctx - Resolution context; the caller wires `resolveMe`
 *   to a whoami query and `resolveEmail` to `userByEmail`.
 */
export const parsePeopleInput = async (
  raw: string,
  columnId: string,
  ctx: PeopleResolutionContext,
): Promise<ParsedPeopleInput> => {
  const tokens = raw
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (tokens.length === 0) {
    throw emptyPeopleInputError(columnId, raw);
  }

  // Cache `me` resolution within the call — same shape filters.ts
  // uses. An input like `me,me,me` resolves once.
  let cachedMe: string | undefined;
  const resolveMeOnce = async (): Promise<string> => {
    cachedMe ??= await ctx.resolveMe();
    return cachedMe;
  };

  const entries: PeoplePayloadEntry[] = [];
  for (const token of tokens) {
    if (NON_NEGATIVE_INTEGER.test(token)) {
      // Numeric tokens aren't in cli-design's people grammar. Reject
      // with a hint pointing at --set-raw so an agent who already has
      // a user ID can paste-and-edit. Logged as a spec gap in
      // v0.1-plan.md §3 M5a.
      throw numericPeopleTokenError(columnId, token, raw);
    }
    const id =
      isMeToken(token)
        ? await resolveMeOnce()
        : await ctx.resolveEmail(token);
    entries.push({ id: idStringToNumber(id, columnId, token), kind: 'person' });
  }

  return { payload: { personsAndTeams: entries } };
};

/**
 * Case-insensitive `me` recognition. cli-design.md §5.3 step 3
 * line 704-707 says `--set Owner=me` resolves to the connected
 * user — the translator is generous with case (`ME` / `Me` /
 * `mE` all match) so an agent's all-caps shouting style works
 * the same as a filter's `--where owner=me`. Pinned via test.
 */
const isMeToken = (token: string): boolean => token.toLowerCase() === 'me';

/**
 * Non-negative integer: matches `0`, `42`, `1234567` but not `-1`,
 * `0.5`, `1e3`. Used to gate numeric-token rejection on people
 * input. Same regex `column-values.ts` uses for status indexes /
 * dropdown IDs — pin via local copy because importing from
 * `column-values.ts` would create a circular import (column-values
 * imports parsePeopleInput).
 */
const NON_NEGATIVE_INTEGER = /^\d+$/u;

/**
 * Converts a string user ID (Monday's directory shape) to a
 * number for the `personsAndTeams[].id` wire field. Two layers
 * of validation, both required:
 *
 *   1. **Decimal-shape regex** (`DECIMAL_NON_NEGATIVE`). `Number()`
 *      alone accepts hex (`"0x2a"` → 42), scientific notation
 *      (`"1e3"` → 1000), empty strings (`""` → 0), and signed
 *      forms (`"-1"` → -1) — none of which are valid Monday user
 *      IDs but all of which would silently land at Monday as the
 *      wrong number. Codex review pass-1 finding: caller's
 *      `userByEmail` validates only `z.string().min(1)`, so the
 *      translator must defend its own boundary. Throws
 *      `internal_error` (data corruption from the resolver, not
 *      user-input fault).
 *   2. **Safe-integer guard.** Defensive against a future Monday
 *      user-ID range expansion that would silently round through
 *      `Number()` and corrupt the wire payload. Throws
 *      `usage_error` (consistent with the status / dropdown
 *      safe-integer guards — agent-actionable).
 *
 * `token` is included in error details so the agent's debug log
 * shows which email/me-token resolved to the unsafe ID.
 */
const idStringToNumber = (id: string, columnId: string, token: string): number => {
  if (!DECIMAL_NON_NEGATIVE.test(id)) {
    // Resolver returned something that isn't a decimal non-negative
    // integer string. This is a data-integrity problem with the
    // directory, not a user-input fault — surface as internal_error
    // with enough context for an agent to file a bug, but don't
    // pretend the user can fix it by editing their --set value.
    throw new ApiError(
      'internal_error',
      `People column "${columnId}" resolved token "${token}" to a ` +
        `non-decimal user ID ${JSON.stringify(id)}. Monday's user IDs ` +
        `are decimal non-negative integers; the resolver returned an ` +
        `unexpected shape.`,
      {
        details: {
          column_id: columnId,
          column_type: 'people',
          token,
          resolved_id: id,
          hint:
            'this is a data-integrity error in the user directory or ' +
            'the resolver wiring; verify the directory cache and the ' +
            'shape of the response from `users(emails:)`.',
        },
      },
    );
  }
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed)) {
    throw new UsageError(
      `People column "${columnId}" got a resolved user ID "${id}" ` +
        `(from token "${token}") that exceeds JavaScript's safe-integer ` +
        `range (2^53 - 1, i.e. 9007199254740991). Number(id) would lose ` +
        `precision, corrupting the personsAndTeams wire payload. Pass ` +
        `--set-raw to bypass the friendly translator.`,
      {
        details: {
          column_id: columnId,
          column_type: 'people',
          token,
          resolved_id: id,
          hint: `--set-raw ${columnId}='{"personsAndTeams":[{"id":${id},"kind":"person"}]}'`,
        },
      },
    );
  }
  return parsed;
};

/**
 * Decimal non-negative integer string: matches `0`, `42`,
 * `1234567`. Rejects `"-1"` (signed), `"0x2a"` (hex), `"1e3"`
 * (scientific), `""` (empty), `"01"` (leading zeros — defensible
 * to allow but Monday's IDs don't have them, so the strict shape
 * catches data corruption sooner). Used by `idStringToNumber` as
 * the resolver-output validator.
 *
 * Note this is intentionally stricter than `NON_NEGATIVE_INTEGER`
 * (which accepts `"00042"`) — the input-side regex is forgiving
 * because users type sloppy numbers; the resolver-side regex is
 * strict because the directory should never return `"00042"` for
 * a real user.
 */
const DECIMAL_NON_NEGATIVE = /^(0|[1-9]\d*)$/u;

/**
 * Builds the `usage_error` for empty input — no emails, no `me`,
 * nothing left after trim+filter (`--set Owner=""` or
 * `--set Owner=" , "` etc.). Mirrors the dropdown empty-input
 * branch's shape so an agent that handles one details payload
 * handles them all. Pointing at `monday item clear` keeps `--set`
 * and the dedicated clear verb non-overlapping per cli-design.md
 * §5.3 (clear is the verb that empties a column; `--set` is the
 * verb that writes a new value).
 */
const emptyPeopleInputError = (columnId: string, raw: string): UsageError =>
  new UsageError(
    `People column "${columnId}" needs at least one email or the \`me\` ` +
      `token. Got "${raw}". To clear a people column, use ` +
      `\`monday item clear <iid> ${columnId} [--board <bid>]\` instead.`,
    {
      details: {
        column_id: columnId,
        column_type: 'people',
        raw_input: raw,
        hint:
          'pass a comma-separated list of emails (e.g. --set ' +
          `${columnId}=alice@example.com,bob@example.com), or ` +
          `--set ${columnId}=me, or --set-raw to bypass the friendly translator.`,
      },
    },
  );

/**
 * Builds the `usage_error` for a numeric token that the translator
 * doesn't accept. cli-design.md §5.3 step 3 only lists emails and
 * `me` for the people grammar — numeric tokens are an explicit
 * v0.1 spec gap. The hint interpolates the literal token so the
 * `--set-raw` example is paste-ready.
 *
 * `raw` is included alongside `token` because the failing token
 * may be one of many in a comma list (`alice@example.com,12345`)
 * and the agent's debug log benefits from seeing both.
 */
const numericPeopleTokenError = (
  columnId: string,
  token: string,
  raw: string,
): UsageError =>
  new UsageError(
    `People column "${columnId}" got numeric token "${token}", which ` +
      `is not in the v0.1 people grammar (cli-design.md §5.3 step 3 ` +
      `only lists emails and \`me\`). Agents with a raw user ID can ` +
      `bypass the friendly translator with --set-raw.`,
    {
      details: {
        column_id: columnId,
        column_type: 'people',
        token,
        raw_input: raw,
        hint: `--set-raw ${columnId}='{"personsAndTeams":[{"id":${token},"kind":"person"}]}'`,
      },
    },
  );

