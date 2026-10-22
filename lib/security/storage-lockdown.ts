// Secret boundary rule 1 (docs/architecture.md §9): restrict extension storage to
// trusted contexts before anything reads or writes the API key.
//
// The result is fail-closed: `whenStorageLockedDown()` resolves to `false` unless
// every storage area was restricted, and key routes must refuse to run on `false`.

type AccessLevelArea = {
  setAccessLevel(options: { accessLevel: 'TRUSTED_CONTEXTS' }): Promise<void>;
};

let lockdown: Promise<boolean> | undefined;

async function restrict(area: AccessLevelArea): Promise<boolean> {
  try {
    await area.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    return true;
  } catch (error: unknown) {
    // The error carries no user data; log its name only.
    console.error('Clavis: could not restrict storage access', (error as Error)?.name);
    return false;
  }
}

/**
 * Starts the lockdown once. Call it synchronously at the top of the background
 * script, before registering listeners; do not await it there (MV3 drops events
 * whose listeners are registered after an await).
 */
export function lockDownStorage(
  areas: AccessLevelArea[] = [browser.storage.local, browser.storage.session],
): Promise<boolean> {
  lockdown ??= Promise.all(areas.map(restrict)).then((results) => results.every(Boolean));
  return lockdown;
}

/** Resolves to `true` only if every storage area is restricted. Never rejects. */
export function whenStorageLockedDown(): Promise<boolean> {
  return lockdown ?? Promise.resolve(false);
}

/** Test helper: forget the cached result. */
export function resetStorageLockdownForTests(): void {
  lockdown = undefined;
}
