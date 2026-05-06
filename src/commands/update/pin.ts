/**
 * `monday update pin <uid> [--dry-run]` — pin an update to the top of
 * its thread (`cli-design.md` §4.3 line 700, `v0.2-plan.md` §3 M13).
 *
 * Calls Monday's `pin_to_top(id)`. Idempotent — re-pinning is a
 * server-side no-op. Per-mutation SDK divergence: pin / unpin take
 * `id` (vs like / unlike's `update_id`); the toggle helper sends
 * the right variable based on `idVariable: 'id'`.
 */
import { buildUpdateToggleCommand } from './toggle.js';

export const updatePinCommand = buildUpdateToggleCommand({
  name: 'update.pin',
  verb: 'pin',
  summary: 'Pin an update to the top of its thread — idempotent toggle',
  examples: [
    'monday update pin 77',
    'monday update pin 77 --dry-run --json',
  ],
  mutation: 'pin_to_top',
  operationName: 'UpdatePin',
  idVariable: 'id',
});
