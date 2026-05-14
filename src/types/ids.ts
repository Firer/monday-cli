import { z } from 'zod';

/**
 * Branded zod schemas for the nine ID kinds Monday surfaces (M32
 * adds `DocId` alongside the eight v0.1+M27 brands). Brands make
 * `BoardId`/`ItemId`/etc. nominally distinct at the type level even
 * though they're all numeric strings on the wire — passing a
 * `BoardId` where an `ItemId` is wanted becomes a compile error,
 * which is the whole point.
 *
 * Monday's numeric IDs exceed `Number.MAX_SAFE_INTEGER` for older
 * accounts, so we keep them as decimal strings everywhere — argv
 * already arrives as strings, GraphQL responses already arrive as
 * strings, and the wire format stays stable through the CLI.
 */
const numericIdSchema = z
  .string()
  .regex(/^\d+$/u, { message: 'expected a numeric ID' });

const slugIdSchema = z.string().min(1, {
  message: 'expected a non-empty ID',
});

/**
 * Decimal non-negative integer string: matches `0`, `42`,
 * `1234567`. Rejects `"-1"` (signed), `"0x2a"` (hex), `"1e3"`
 * (scientific), `""` (empty), `"01"` (leading zeros), `"42 "`
 * (trailing whitespace).
 *
 * Stricter than the numeric-ID brand regex (`/^\d+$/u`, which
 * accepts `"00042"`) because this regex is the **resolver-output
 * validator** for user IDs that get converted to JS numbers for
 * Monday wire payloads. The directory should never produce
 * leading-zero IDs for a real user — if it does, the resolver is
 * misbehaving and we want to surface it as `internal_error`
 * rather than silently letting `Number()` corrupt the payload.
 *
 * Two consumers: `src/api/people.ts`'s `idStringToNumber`
 * defence-in-depth check + `src/api/resolvers.ts`'s
 * `userDirectoryEntrySchema` shape (the source-of-truth pin on
 * what the directory cache stores). Pre-consolidation, both
 * carried a copy of this regex — same rule, two copies. R16
 * landed both onto this single export.
 */
export const DECIMAL_USER_ID_PATTERN = /^(0|[1-9]\d*)$/u;

export const BoardIdSchema = numericIdSchema.brand<'BoardId'>();
export const ItemIdSchema = numericIdSchema.brand<'ItemId'>();
export const UserIdSchema = numericIdSchema.brand<'UserId'>();
export const WorkspaceIdSchema = numericIdSchema.brand<'WorkspaceId'>();
export const UpdateIdSchema = numericIdSchema.brand<'UpdateId'>();
export const WebhookIdSchema = numericIdSchema.brand<'WebhookId'>();
// M32 (v0.4) — workdocs read surface (`monday doc list/get`). Monday's
// `Document.id` is `ID!` on the wire (numeric on every observed
// account at API `2026-01`; empirical probe at `scripts/probe/m32-
// docs.ts` 2026-05-14). Brand keeps `DocId` distinct from
// `BoardId`/`ItemId`/etc. so the type system catches an `--workspace
// <did>` slip at compile time.
export const DocIdSchema = numericIdSchema.brand<'DocId'>();

// Column and group IDs are stable lower-snake-case slugs ("status_4",
// "topics") — not numeric. Validate as non-empty strings only.
export const ColumnIdSchema = slugIdSchema.brand<'ColumnId'>();
export const GroupIdSchema = slugIdSchema.brand<'GroupId'>();

export type BoardId = z.infer<typeof BoardIdSchema>;
export type ItemId = z.infer<typeof ItemIdSchema>;
export type ColumnId = z.infer<typeof ColumnIdSchema>;
export type GroupId = z.infer<typeof GroupIdSchema>;
export type UserId = z.infer<typeof UserIdSchema>;
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;
export type UpdateId = z.infer<typeof UpdateIdSchema>;
export type WebhookId = z.infer<typeof WebhookIdSchema>;
export type DocId = z.infer<typeof DocIdSchema>;
