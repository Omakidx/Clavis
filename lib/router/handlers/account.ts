import type { AccountStatus } from '../../contracts/account';
import type { MessageReply } from '../../contracts';
import type { AccountService, ServiceResult } from '../../account/service';
import type { SyncEngine } from '../../sync/engine';
import { failure, success } from '../replies';

/** ACCOUNT_* and SYNC_NOW (docs/clavis-sync-design.md 7.4). Replies never contain a token. */
export interface AccountHandlerDeps {
  account: Pick<AccountService, 'signIn' | 'signOut' | 'signOutEverywhere' | 'getStatus'>;
  engine: Pick<SyncEngine, 'syncNow'>;
  enabled: boolean;
}

const fromService = <T>(
  result: ServiceResult<T>,
): MessageReply<Omit<typeof result & { ok: true }, 'ok'>> =>
  result.ok ? success((({ ok: _ok, ...rest }) => rest)(result) as never) : failure(result.code);

export function createAccountHandlers(deps: AccountHandlerDeps) {
  return {
    async getStatus(): Promise<MessageReply<AccountStatus>> {
      return success(await deps.account.getStatus());
    },
    async signIn(): Promise<MessageReply<Record<string, never>>> {
      return fromService(await deps.account.signIn()) as MessageReply<Record<string, never>>;
    },
    async signOut(keepLocalCopy: boolean): Promise<MessageReply<{ unsyncedDropped: number }>> {
      if (!deps.enabled) return failure('NOT_SIGNED_IN');
      return fromService(await deps.account.signOut(keepLocalCopy)) as MessageReply<{
        unsyncedDropped: number;
      }>;
    },
    async signOutEverywhere(): Promise<MessageReply<Record<string, never>>> {
      if (!deps.enabled) return failure('NOT_SIGNED_IN');
      return fromService(await deps.account.signOutEverywhere()) as MessageReply<
        Record<string, never>
      >;
    },
    async syncNow(): Promise<MessageReply<Record<string, never>>> {
      if (!deps.enabled) return failure('NOT_SIGNED_IN');
      const result = await deps.engine.syncNow();
      if (result.status === 'ok') return success({});
      if (result.status === 'error') {
        return failure(result.code === 'NETWORK' ? 'NETWORK_ERROR' : 'INTERNAL_ERROR');
      }
      return failure('NOT_SIGNED_IN');
    },
  };
}

export type AccountHandlers = ReturnType<typeof createAccountHandlers>;
