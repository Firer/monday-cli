/**
 * Monday-supported group colour palette (M17 implementation-owned
 * field set per cli-design §4.3 group-create + group-update).
 *
 * Monday's `create_group(group_color)` and `update_group(group_
 * attribute: color, new_value)` accept plain `String` on the wire
 * (the SDK 14.0.0 `MutationCreate_GroupArgs.group_color: String?`
 * type is unstructured); the accepted-values list lives in Monday's
 * public API help center, not in the SDK's typed surface, and
 * evolves over time.
 *
 * This module owns the v0.2 field set. The cli-design contract
 * pins the SHAPE (argv-parse validation against the M17
 * implementation-owned set); pinning specific values inline in the
 * contract would force docs revisions every time Monday tweaks
 * the palette. Same rationale as M16 column-create's per-type
 * `--settings` field-set ownership in `column-types.ts`.
 *
 * **What's here**: the union of Monday's documented group colours
 * across both the API help center and the working `update_group`
 * payloads observed in the SDK 14.0.0 test fixtures. When Monday
 * adds a colour, agents either patch this list (SemVer-minor) or
 * fall back to `dev mutate` until the next release.
 *
 * **Why two consumers** (group-create + group-update): both verbs
 * share the argv-parse validation layer. Sharing the constant
 * means an agent that successfully sets a colour via group-create
 * can rely on it round-tripping through group-update without
 * surprise rejections, and vice versa.
 */

export const GROUP_COLOR_VALUES = [
  // Reds + warm
  'dark-red',
  'red',
  'stuck-red',
  'sofia-pink',
  'lipstick',
  'berry',
  'dark-orange',
  'orange',
  'working-orange',
  'peachy',
  'sunset',
  'sun-yellow',
  'yellow',
  'dark-yellow',
  'gold',
  // Greens
  'lime-green',
  'grass-green',
  'done-green',
  'dark-green',
  'sea-foam',
  'teal',
  // Blues + indigos
  'turqouise',
  'sky',
  'light-blue',
  'bright-blue',
  'blue',
  'dark-blue',
  'royal',
  'indigo',
  'dark-indigo',
  'navy',
  // Purples + pinks
  'purple',
  'dark-purple',
  'lavender',
  'dark-pink',
  'pink',
  // Earth + neutrals
  'brown',
  'pecan',
  'tan',
  'american-gray',
  'gray-gray',
  'blackish',
] as const;

export type GroupColor = (typeof GROUP_COLOR_VALUES)[number];
