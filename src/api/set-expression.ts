/**
 * `--set <col>=<val>` argv splitter, shared by `item set` / `item update`
 * (single + bulk) / `item create`.
 *
 * Per cli-design §5.3 lines 712-715: split on the FIRST `=`. Tokens with
 * `=` in the title need shell quoting plus the explicit `id:` / `title:`
 * prefix or `--filter-json`-style escape. An empty token raises
 * `usage_error`; an empty value (`status=`) is accepted at this layer
 * and propagated to the per-type translator which decides whether to
 * accept (e.g. `status= ` becomes `{label: ""}`) or reject (dropdown
 * empty-input rejects per `column-values.ts`).
 *
 * Lifted from three identical 12-line copies (`set.ts`, `update.ts`,
 * `create.ts`) — see v0.2-plan §12 R22. The sibling `parseSetRawExpression`
 * in `raw-write.ts` shares the same first-`=` rule but layers JSON-object
 * parsing on top, so it stays where it is.
 */

import { UsageError } from '../utils/errors.js';

export interface SetExpression {
  readonly token: string;
  readonly value: string;
}

export const splitSetExpression = (raw: string): SetExpression => {
  const idx = raw.indexOf('=');
  if (idx <= 0) {
    throw new UsageError(
      `--set: expected <col>=<val> (got ${JSON.stringify(raw)}); ` +
        `use shell quoting and the id:/title: prefix when the column ` +
        `token contains "="`,
      { details: { input: raw } },
    );
  }
  return {
    token: raw.slice(0, idx),
    value: raw.slice(idx + 1),
  };
};
