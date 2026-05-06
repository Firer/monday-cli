/**
 * `monday update like <uid> [--dry-run]` — like an update
 * (`cli-design.md` §4.3 line 698, `v0.2-plan.md` §3 M13).
 *
 * Calls Monday's `like_update(update_id)`. Idempotent — re-liking an
 * already-liked update is a server-side no-op (the like is keyed
 * off the caller). Thin wrapper around the shared toggle helper
 * (`./toggle.ts`); see that module for the shape rationale.
 */
import { buildUpdateToggleCommand } from './toggle.js';

export const updateLikeCommand = buildUpdateToggleCommand({
  name: 'update.like',
  verb: 'like',
  summary: 'Like an update (comment) — idempotent toggle',
  examples: [
    'monday update like 77',
    'monday update like 77 --dry-run --json',
  ],
  mutation: 'like_update',
  operationName: 'UpdateLike',
  idVariable: 'update_id',
});
