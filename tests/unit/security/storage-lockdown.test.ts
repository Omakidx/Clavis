import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  lockDownStorage,
  resetStorageLockdownForTests,
  whenStorageLockedDown,
} from '../../../lib/security/storage-lockdown';

function area(outcome: 'ok' | 'fail') {
  return {
    setAccessLevel: vi.fn(() =>
      outcome === 'ok' ? Promise.resolve() : Promise.reject(new Error('nope')),
    ),
  };
}

describe('storage lockdown', () => {
  afterEach(() => resetStorageLockdownForTests());

  it('resolves true only when every area is restricted to trusted contexts', async () => {
    const local = area('ok');
    const session = area('ok');
    await expect(lockDownStorage([local, session])).resolves.toBe(true);
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    expect(session.setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    await expect(whenStorageLockedDown()).resolves.toBe(true);
  });

  it('fails closed when any area cannot be restricted', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(lockDownStorage([area('ok'), area('fail')])).resolves.toBe(false);
    await expect(whenStorageLockedDown()).resolves.toBe(false);
  });

  it('reports false before the lockdown has started', async () => {
    await expect(whenStorageLockedDown()).resolves.toBe(false);
  });

  it('starts the lockdown only once', async () => {
    const local = area('ok');
    void lockDownStorage([local]);
    void lockDownStorage([local]);
    await whenStorageLockedDown();
    expect(local.setAccessLevel).toHaveBeenCalledTimes(1);
  });
});
