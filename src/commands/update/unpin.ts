/**
 * `monday update unpin <uid> [--dry-run]` — unpin an update
 * (`cli-design.md` §4.3 line 701, `v0.2-plan.md` §3 M13).
 *
 * Calls Monday's `unpin_from_top(id)`. Idempotent — un-pinning an
 * already-unpinned update is a server-side no-op.
 */
import { buildUpdateToggleCommand } from './toggle.js';

export const updateUnpinCommand = buildUpdateToggleCommand({
  name: 'update.unpin',
  verb: 'unpin',
  summary: 'Unpin an update from the top of its thread — idempotent toggle',
  examples: [
    'monday update unpin 77',
    'monday update unpin 77 --dry-run --json',
  ],
  mutation: 'unpin_from_top',
  operationName: 'UpdateUnpin',
  idVariable: 'id',
});
