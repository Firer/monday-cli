import { InternalError } from '../utils/errors.js';

/**
 * Single source of truth for noun-level command descriptions.
 *
 * Every parent noun (`monday <noun>`) and group-tier noun
 * (`monday dev <group>`, `monday item time-track`) the CLI registers
 * has exactly one entry here. `ensureSubcommand(program, name)` looks
 * the description up; passing an explicit `summary` overrides the
 * map (retained for ad-hoc / test injections — the unit suite at
 * `tests/unit/commands/types.test.ts` exercises both arms).
 *
 * Why a map instead of per-file literals: every verb file under
 * `src/commands/<noun>/` used to call
 * `ensureSubcommand(program, '<noun>', '<desc>')` with the
 * description repeated verbatim (~100+ duplicate literals across ~80
 * files). The duplicates are silent — `ensureSubcommand` is
 * find-or-create, so the first attach wins and every later sibling's
 * string is ignored. A drifted sibling whose file happens to attach
 * first then renders its (wrong, often internal-ref-leaking) string;
 * `feedback_public_docs_clean` violations slip in undetected. The
 * map collapses the duplicates and makes divergence structurally
 * impossible.
 *
 * Adding a new noun: add an entry here + the verb's `attach()`
 * calls `ensureSubcommand(program, '<noun>')` with no 3rd arg. No
 * other site needs touching.
 */
export const NOUN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  account: 'Account commands',
  auth: 'Manage stored authentication credentials',
  board: 'Board commands',
  cache: 'Cache management commands',
  config: 'Configuration commands',
  dev: 'Monday Dev workflow shortcuts (sprint, epic, release, task)',
  doc: 'Workdoc commands',
  epic: 'Epic workflow verbs',
  item: 'Item commands',
  notification: 'Send notifications to Monday users',
  release: 'Release workflow verbs',
  sprint: 'Sprint workflow verbs',
  task: 'Task workflow verbs',
  'time-track': 'Time-tracking column verbs',
  update: 'Update (comment) commands',
  user: 'User commands',
  webhook: 'Manage board webhooks (register, list, delete)',
  workspace: 'Workspace commands',
};

/**
 * Look the description for a registered noun up, or throw
 * `internal_error` with `details.reason: 'unknown_noun'` if absent.
 *
 * The throw is a hard contract — a typo or missing-map-entry at a
 * verb's `attach()` would otherwise silently create a noun with the
 * commander-default empty description. By the time it surfaces in
 * `--help` it's already shipped. The strict-mode throw catches it
 * at first invocation (registration walks the registry once at
 * startup, so the throw fires immediately, not lazily).
 */
export const lookupNounDescription = (name: string): string => {
  const description = NOUN_DESCRIPTIONS[name];
  if (description === undefined) {
    throw new InternalError(
      `noun '${name}' has no entry in NOUN_DESCRIPTIONS — add one to src/commands/noun-descriptions.ts`,
      {
        details: {
          reason: 'unknown_noun',
          noun: name,
          known_nouns: Object.keys(NOUN_DESCRIPTIONS).sort(),
        },
      },
    );
  }
  return description;
};
