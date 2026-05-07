/**
 * Destructive-verb confirmation gate (`v0.2-plan.md` §20 R29).
 *
 * Five sites pre-lift duplicated the same `parseGlobalFlags + if
 * (!dryRun && !yes) throw ConfirmationRequiredError` block:
 *
 *   - `src/commands/item/archive.ts` (M10)
 *   - `src/commands/item/delete.ts` (M10)
 *   - `src/commands/update/delete.ts` (M13)
 *   - `src/commands/update/clear-all.ts` (M13)
 *   - `src/commands/workspace/delete.ts` (M14)
 *
 * Each block was ~17 lines, diverging only in the verb name, the
 * target id (`item_id` / `update_id` / `workspace_id`), the action
 * phrase ("archive the item" / "delete every update on the item"),
 * and the verb-specific hint text. M14's workspace delete arrived
 * as the 5th consumer; the lift fired per the §20 trigger
 * (≥3 sites diverging only in parameters).
 *
 * **Load-bearing invariant** (Codex M10 round-1 P2): the gate must
 * fire BEFORE `resolveClient` so that a missing
 * `MONDAY_API_TOKEN` doesn't mask `confirmation_required` as
 * `config_error`. Agents key off `error.code` and the destructive-
 * gate signal must be unconditional. The helper preserves this
 * by taking `globalFlags` as already-parsed — callers MUST run
 * `parseGlobalFlags(program.opts(), ctx.env)` (a synchronous
 * argv-only operation) before invoking the gate, NOT `resolveClient`
 * (which can throw `config_error` on a missing token). Passing
 * already-parsed flags rather than re-parsing them inside the
 * helper makes the ordering trap visible at the call site.
 *
 * Pure refactor — every existing test passes byte-identical pre-
 * lift vs post-lift. Message templates are reproduced verbatim
 * from the inline blocks. cli-design §6.5 documents the per-code
 * `details` schema; this helper produces the canonical shape:
 * `{<detailKey>: target, hint}`.
 */
import type { GlobalFlags } from '../types/global-flags.js';
import { ConfirmationRequiredError } from '../utils/errors.js';

export interface EnforceDestructiveGateInputs {
  /**
   * Already-parsed global flags. Forces the call site to invoke
   * `parseGlobalFlags` BEFORE `resolveClient` so the gate-before-
   * resolveClient ordering invariant (M10 round-1 P2) is visible
   * in the type signature itself, not buried in helper-internal
   * code.
   */
  readonly globalFlags: GlobalFlags;
  /**
   * CLI verb name as it appears in the user's invocation, e.g.
   * `'item archive'` / `'workspace delete'` / `'update clear-all'`.
   * Used verbatim in the leading `monday <verb> <target>` portion
   * of the error message.
   */
  readonly verb: string;
  /**
   * The target resource id (or other identifier). Appears
   * verbatim in the message after `monday <verb>` AND lands in
   * `details.<detailKey>` so agents can extract it
   * programmatically.
   */
  readonly target: string;
  /**
   * Snake_case detail key matching the resource (`item_id`,
   * `update_id`, `workspace_id`). cli-design §6.5 pins the
   * per-code shape; agents read `error.details.<detailKey>` to
   * extract the target id without re-parsing argv.
   */
  readonly detailKey: string;
  /**
   * Optional extra `details.*` fields merged into the
   * `confirmation_required` envelope alongside `[detailKey]: target`
   * + `hint`. Used by verbs whose wire signature is two-tuple — M16
   * `board column-delete` echoes `{board_id, column_id, hint}` per
   * cli-design §6.5 single-target shape (the wire signature carries
   * both ids); M17 `board group-archive` / `group-delete` will use
   * the same shape. `[detailKey]: target` always wins on key
   * collision (extraDetails is merged FIRST).
   */
  readonly extraDetails?: Readonly<Record<string, unknown>>;
  /**
   * The action phrase that follows `would` in the message body.
   * Verb-specific:
   * - `'archive the item'` (item archive)
   * - `'delete the item'` (item delete)
   * - `'delete the update'` (update delete)
   * - `'delete every update on the item'` (update clear-all)
   * - `'delete the workspace'` (workspace delete)
   */
  readonly action: string;
  /**
   * Verb-specific hint included in `details.hint`. Explains the
   * reversibility window (Monday's 30-day trash for items /
   * updates / workspaces) and any verb-specific recovery story
   * (recreate via `monday workspace create`, etc.).
   */
  readonly hint: string;
  /**
   * Optional override for the "or --dry-run to preview." trailing
   * suffix. Only `update clear-all` uses this — its preview
   * behaviour ("the would-delete IDs") differs enough from the
   * single-target verbs to warrant explicit phrasing. Default:
   * `'or --dry-run to preview.'`.
   */
  readonly previewSuffix?: string;
}

const DEFAULT_PREVIEW_SUFFIX = 'or --dry-run to preview.';

export const enforceDestructiveGate = (
  inputs: EnforceDestructiveGateInputs,
): void => {
  if (inputs.globalFlags.dryRun || inputs.globalFlags.yes) return;
  const previewSuffix = inputs.previewSuffix ?? DEFAULT_PREVIEW_SUFFIX;
  // `extraDetails` lands FIRST so the canonical `[detailKey]: target`
  // + `hint` always win on key collision. Two-tuple verbs (M16
  // column-delete, M17 group-archive / group-delete) populate
  // extraDetails with the secondary id (board_id paired with
  // column_id / group_id) per cli-design §6.5 single-target shape.
  const details = {
    ...(inputs.extraDetails ?? {}),
    [inputs.detailKey]: inputs.target,
    hint: inputs.hint,
  };
  throw new ConfirmationRequiredError(
    `monday ${inputs.verb} ${inputs.target} would ${inputs.action}. Re-run with --yes to confirm, ${previewSuffix}`,
    { details },
  );
};
