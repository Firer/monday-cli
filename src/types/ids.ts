import { z } from 'zod';

/**
 * Branded zod schemas for the seven ID kinds Monday surfaces. Brands
 * make `BoardId`/`ItemId`/etc. nominally distinct at the type level
 * even though they're all numeric strings on the wire — passing a
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

export const BoardIdSchema = numericIdSchema.brand<'BoardId'>();
export const ItemIdSchema = numericIdSchema.brand<'ItemId'>();
export const UserIdSchema = numericIdSchema.brand<'UserId'>();
export const WorkspaceIdSchema = numericIdSchema.brand<'WorkspaceId'>();
export const UpdateIdSchema = numericIdSchema.brand<'UpdateId'>();

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
