import { accountStatusSchema, signOutResultSchema } from '../contracts/account';
import { z } from 'zod';
import { request } from './request';

const emptySchema = z.strictObject({});

/** Typed wrappers for the account routes (lib/contracts/account.ts). The background owns every token. */
export const accountApi = {
  getStatus: () => request({ type: 'ACCOUNT_GET_STATUS' }, accountStatusSchema),
  /** Opens Google's window and can take a minute: never retried automatically. */
  signIn: () => request({ type: 'ACCOUNT_SIGN_IN' }, emptySchema, {}, { retry: false }),
  signOut: (keepLocalCopy: boolean) =>
    request({ type: 'ACCOUNT_SIGN_OUT', keepLocalCopy }, signOutResultSchema, {}, { retry: false }),
  signOutEverywhere: () =>
    request({ type: 'ACCOUNT_SIGN_OUT_EVERYWHERE' }, emptySchema, {}, { retry: false }),
  syncNow: () => request({ type: 'SYNC_NOW' }, emptySchema, {}, { retry: false }),
} as const;
