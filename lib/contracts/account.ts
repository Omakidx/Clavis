import { z } from 'zod';
import { MESSAGE_VERSION } from '../config/constants';
import { parseMessage, type MessageParseResult } from './messages';

/**
 * Account and sync routes (docs/clavis-sync-design.md 7.4). Extension pages only; never accepted by
 * a public parser. Strict, versioned. No reply here ever carries a token (rule R1): the status has
 * who is signed in and how sync is doing, nothing else.
 */

const v = z.literal(MESSAGE_VERSION);

export const accountGetStatusMessageSchema = z.strictObject({
  v,
  type: z.literal('ACCOUNT_GET_STATUS'),
});
export const accountSignInMessageSchema = z.strictObject({ v, type: z.literal('ACCOUNT_SIGN_IN') });
export const accountSignOutMessageSchema = z.strictObject({
  v,
  type: z.literal('ACCOUNT_SIGN_OUT'),
  keepLocalCopy: z.boolean(),
});
export const accountSignOutEverywhereMessageSchema = z.strictObject({
  v,
  type: z.literal('ACCOUNT_SIGN_OUT_EVERYWHERE'),
});
export const syncNowMessageSchema = z.strictObject({ v, type: z.literal('SYNC_NOW') });

export const accountMessageSchema = z.discriminatedUnion('type', [
  accountGetStatusMessageSchema,
  accountSignInMessageSchema,
  accountSignOutMessageSchema,
  accountSignOutEverywhereMessageSchema,
  syncNowMessageSchema,
]);
export type AccountMessage = z.infer<typeof accountMessageSchema>;

export function parseAccountMessage(input: unknown): MessageParseResult<AccountMessage> {
  return parseMessage(accountMessageSchema, input);
}

export const syncStatusSchema = z.strictObject({
  state: z.enum(['idle', 'syncing', 'error', 'offline']),
  /** Local changes not pushed yet. */
  pending: z.number().int().nonnegative(),
  /** Changes the server refused for good (kept on this device). */
  rejected: z.number().int().nonnegative(),
  lastSyncAt: z.number().optional(),
  error: z.string().max(64).optional(),
});
export type SyncStatusView = z.infer<typeof syncStatusSchema>;

export const accountStatusSchema = z.strictObject({
  /** False in a build where accounts are switched off. */
  enabled: z.boolean(),
  signedIn: z.boolean(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  /** The device was signed out by the server (session ended); shown until the next sign-in. */
  notice: z.literal('session-ended').optional(),
  sync: syncStatusSchema,
});
export type AccountStatus = z.infer<typeof accountStatusSchema>;

export const signOutResultSchema = z.strictObject({
  unsyncedDropped: z.number().int().nonnegative(),
});
