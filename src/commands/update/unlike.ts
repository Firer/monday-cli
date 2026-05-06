/**
 * `monday update unlike <uid> [--dry-run]` — remove a like from an
 * update (`cli-design.md` §4.3 line 699, `v0.2-plan.md` §3 M13).
 *
 * Calls Monday's `unlike_update(update_id)`. Idempotent — un-liking
 * an already-unliked update is a server-side no-op. Thin wrapper
 * around the shared toggle helper (`./toggle.ts`).
 */
import { buildUpdateToggleCommand } from './toggle.js';

export const updateUnlikeCommand = buildUpdateToggleCommand({
  name: 'update.unlike',
  verb: 'unlike',
  summary: 'Remove your like from an update — idempotent toggle',
  examples: [
    'monday update unlike 77',
    'monday update unlike 77 --dry-run --json',
  ],
  mutation: 'unlike_update',
  operationName: 'UpdateUnlike',
  idVariable: 'update_id',
});
