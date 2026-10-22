import { describe, expect, it, vi } from 'vitest';
import { CONTENT_SCRIPT_ID, OPTIONAL_SITE_ORIGINS } from '../../../lib/config/constants';
import {
  buildRegisteredScript,
  hasSiteAccess,
  reconcileRegistration,
  reconcileSerialized,
  type RegistrationDeps,
} from '../../../lib/site-access/registration';

function deps(options: { granted: boolean; registered: boolean }) {
  let registered = options.registered;
  const scripting = {
    getRegisteredContentScripts: vi.fn(() =>
      Promise.resolve(registered ? [{ id: CONTENT_SCRIPT_ID }] : []),
    ),
    registerContentScripts: vi.fn(() => {
      if (registered)
        return Promise.reject(new Error(`Duplicate script ID '${CONTENT_SCRIPT_ID}'`));
      registered = true;
      return Promise.resolve();
    }),
    updateContentScripts: vi.fn(() => {
      if (!registered)
        return Promise.reject(new Error(`Script with ID '${CONTENT_SCRIPT_ID}' does not exist`));
      return Promise.resolve();
    }),
    unregisterContentScripts: vi.fn(() => {
      registered = false;
      return Promise.resolve();
    }),
  };
  const permissions = { contains: vi.fn(() => Promise.resolve(options.granted)) };
  return {
    scripting,
    permissions,
    value: { scripting, permissions } as unknown as RegistrationDeps,
  };
}

describe('buildRegisteredScript', () => {
  it('registers the observer on every http(s) frame at idle and persists across sessions (D-02)', () => {
    expect(buildRegisteredScript()).toEqual({
      id: CONTENT_SCRIPT_ID,
      js: ['content-scripts/content.js'],
      matches: [...OPTIONAL_SITE_ORIGINS],
      excludeMatches: [
        'https://chromewebstore.google.com/*',
        'https://chrome.google.com/webstore/*',
      ],
      allFrames: true,
      matchOriginAsFallback: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    });
  });
});

describe('registration on older Chrome', () => {
  it('retries without matchOriginAsFallback when Chrome rejects the property (Chrome 116-118)', async () => {
    const { scripting, value } = deps({ granted: true, registered: false });
    scripting.registerContentScripts.mockRejectedValueOnce(
      new Error("Error at parameter 'scripts': Unexpected property: 'matchOriginAsFallback'."),
    );
    expect(await reconcileRegistration(value)).toBe('registered');
    expect(scripting.registerContentScripts).toHaveBeenCalledTimes(2);
    const retried = (scripting.registerContentScripts.mock.calls[1] as unknown as [object[]])[0][0];
    expect(retried).not.toHaveProperty('matchOriginAsFallback');
    expect(retried).toMatchObject({ id: CONTENT_SCRIPT_ID, allFrames: true });
  });

  it('does not swallow other registration errors', async () => {
    const { scripting, value } = deps({ granted: true, registered: false });
    scripting.registerContentScripts.mockRejectedValueOnce(new Error('Duplicate script ID'));
    await expect(reconcileRegistration(value)).rejects.toThrow('Duplicate');
    expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });
});

describe('hasSiteAccess', () => {
  it('asks for exactly the optional origins', async () => {
    const { permissions, value } = deps({ granted: true, registered: false });
    expect(await hasSiteAccess(value.permissions)).toBe(true);
    expect(permissions.contains).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
  });

  it('treats a failing permissions API as "not granted"', async () => {
    const permissions = { contains: vi.fn(() => Promise.reject(new Error('boom'))) };
    expect(await hasSiteAccess(permissions as never)).toBe(false);
  });
});

describe('reconcileRegistration', () => {
  it('registers when access is granted and nothing is registered yet (permissions.onAdded)', async () => {
    const { scripting, value } = deps({ granted: true, registered: false });
    expect(await reconcileRegistration(value)).toBe('registered');
    expect(scripting.registerContentScripts).toHaveBeenCalledWith([buildRegisteredScript()]);
    expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it('unregisters when access was revoked (permissions.onRemoved)', async () => {
    const { scripting, value } = deps({ granted: false, registered: true });
    expect(await reconcileRegistration(value)).toBe('unregistered');
    expect(scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: [CONTENT_SCRIPT_ID] });
    expect(scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('does nothing when already in step', async () => {
    for (const state of [
      { granted: true, registered: true },
      { granted: false, registered: false },
    ]) {
      const { scripting, value } = deps(state);
      expect(await reconcileRegistration(value)).toBe('unchanged');
      expect(scripting.registerContentScripts).not.toHaveBeenCalled();
      expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
    }
  });

  it('rewrites the registration in place on demand (extension update), never leaving a gap', async () => {
    const { scripting, value } = deps({ granted: true, registered: true });
    expect(await reconcileRegistration(value, { force: true })).toBe('registered');
    expect(scripting.updateContentScripts).toHaveBeenCalledWith([buildRegisteredScript()]);
    expect(scripting.unregisterContentScripts).not.toHaveBeenCalled();
    expect(scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('never registers when access is not granted, even when forced', async () => {
    const { scripting, value } = deps({ granted: false, registered: false });
    expect(await reconcileRegistration(value, { force: true })).toBe('unchanged');
    expect(scripting.registerContentScripts).not.toHaveBeenCalled();
  });
});

describe('reconcileSerialized', () => {
  it('runs overlapping reconciliations one at a time so the id is never registered twice', async () => {
    const { scripting, value } = deps({ granted: true, registered: false });
    const outcomes = await Promise.all([
      reconcileSerialized(value),
      reconcileSerialized(value),
      reconcileSerialized(value),
    ]);
    expect(outcomes).toEqual(['registered', 'unchanged', 'unchanged']);
    expect(scripting.registerContentScripts).toHaveBeenCalledTimes(1);
  });

  it('keeps working after a failed reconciliation', async () => {
    const failing = deps({ granted: true, registered: false });
    failing.scripting.registerContentScripts.mockRejectedValueOnce(new Error('boom'));
    await expect(reconcileSerialized(failing.value)).rejects.toThrow('boom');
    expect(await reconcileSerialized(failing.value)).toBe('registered');
  });
});
