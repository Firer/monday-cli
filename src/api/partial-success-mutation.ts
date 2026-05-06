/**
 * Partial-success mutation envelope builder (`cli-design.md` §6.4 +
 * `v0.2-plan.md` §1 universal partial-success rule).
 *
 * Multi-target mutations (M13 `update clear-all`; M14 `workspace
 * add-users` / `remove-users`; M15 `board add-users`) dispatch one
 * wire call per target inside a sequential loop. The CLI emits **one
 * success envelope** (`ok: true`) with per-target outcomes in
 * `data.results: [...]`; each per-target record carries
 * `{<target_id_field>: string, ok: true | false, error?: { code,
 * message }}`. The id-field name is verb-specific (parameterised here
 * via `idField`) so the JSON is self-documenting — `update_id` for
 * `update clear-all`, `user_id` for the add/remove-users family.
 *
 * **Universal rule**: the envelope is always `ok: true` when dispatch
 * ran. Top-level `ok: false` is reserved for whole-call failure
 * (couldn't reach API, couldn't resolve any target before the loop
 * began, an unrecoverable validation error before dispatch). All-
 * failed-but-each-call-attempted is still `ok: true` — the agent
 * reads `data.results` to determine outcomes.
 */
import { MondayCliError } from '../utils/errors.js';

/** A per-target result inside `data.results: [...]`. */
export interface PartialSuccessResult {
  readonly ok: boolean;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
  // The id-field key is dynamic (`update_id` / `user_id` / etc).
  // Index signature lets the dispatch helper assign the field at
  // construction time without losing the rest of the contract.
  readonly [key: string]: unknown;
}

export interface PartialSuccessEnvelopeData {
  readonly results: readonly PartialSuccessResult[];
}

/**
 * Sequential per-target dispatch with shared error decoration. Each
 * dispatch failure is captured into the result record's `error: {code,
 * message}` slot rather than thrown — a per-target failure doesn't
 * abort the loop. The whole-call contract: if dispatch ran, the
 * envelope is `ok: true` regardless of per-target outcomes.
 *
 * Errors thrown that aren't `MondayCliError` propagate up — those are
 * programmer bugs, not Monday-side failures, and the runner's catch-
 * all maps them to `internal_error`.
 */
export interface DispatchOneTargetInputs<TargetId extends string> {
  readonly targetId: TargetId;
}

export const dispatchSequential = async <TargetId extends string>(
  targets: readonly TargetId[],
  idField: string,
  dispatch: (inputs: DispatchOneTargetInputs<TargetId>) => Promise<void>,
): Promise<readonly PartialSuccessResult[]> => {
  const results: PartialSuccessResult[] = [];
  for (const targetId of targets) {
    try {
      await dispatch({ targetId });
      // Build the result with the dynamic id-field name. Property
      // assignment preserves insertion order (`<idField>` first, then
      // `ok`) so the JSON shape stays stable across runs.
      const ok: PartialSuccessResult = {
        [idField]: targetId,
        ok: true,
      };
      results.push(ok);
    } catch (err: unknown) {
      if (err instanceof MondayCliError) {
        const failed: PartialSuccessResult = {
          [idField]: targetId,
          ok: false,
          error: { code: err.code, message: err.message },
        };
        results.push(failed);
        continue;
      }
      // Non-CLI errors are programmer bugs — let the runner catch-all
      // surface as `internal_error`.
      throw err;
    }
  }
  return results;
};

// The output schema lives per-verb because the id-field key (`update_
// id` / `user_id` / etc.) is dynamic and zod doesn't synthesise
// per-call object keys cleanly. M14 will re-evaluate whether a schema
// factory pulls weight; today each consumer writes a 6-line zod
// schema and pays nothing for the duplication.
