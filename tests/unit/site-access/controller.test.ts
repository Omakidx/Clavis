import { describe, expect, it, vi } from 'vitest';
import { CONTENT_SCRIPT_ID } from '../../../lib/config/constants';
import { createSiteAccessController } from '../../../lib/site-access/controller';
import type { SitePolicy } from '../../../lib/site-access/registration';

function setup(initial: { granted: boolean; registered: boolean; policy?: SitePolicy }) {
  const state = {
    granted: initial.granted,
    registered: initial.registered,
    excludeMatches: ['https://chromewebstore.google.com/*', 'https://chrome.google.com/webstore/*'],
    policy: initial.policy ?? { automatic: true, disabledSites: [] },
  };
  const scripting = {
    getRegisteredContentScripts: vi.fn(() =>
      Promise.resolve(
        state.registered ? [{ id: CONTENT_SCRIPT_ID, excludeMatches: state.excludeMatches }] : [],
      ),
    ),
    registerContentScripts: vi.fn((scripts: { excludeMatches: string[] }[]) => {
      state.registered = true;
      state.excludeMatches = scripts[0]?.excludeMatches ?? [];
      return Promise.resolve();
    }),
    updateContentScripts: vi.fn((scripts: { excludeMatches: string[] }[]) => {
      state.excludeMatches = scripts[0]?.excludeMatches ?? [];
      return Promise.resolve();
    }),
    unregisterContentScripts: vi.fn(() => {
      state.registered = false;
      return Promise.resolve();
    }),
    executeScript: vi.fn(() => Promise.resolve([])),
  };
  const permissions = { contains: vi.fn(() => Promise.resolve(state.granted)) };
  const query = vi.fn((_q: unknown) => Promise.resolve([{ id: 7, url: 'https://a.test/' }]));
  const choices: string[] = [];
  const controller = createSiteAccessController({
    registration: { permissions, scripting } as never,
    openTabs: { tabs: { query } as never, scripting: scripting as never },
    readPolicy: () => Promise.resolve(state.policy),
    recordChoice: (choice) => {
      choices.push(choice);
      return Promise.resolve();
    },
  });
  return { state, scripting, query, choices, controller };
}

describe('site access controller', () => {
  it('injects into open tabs when the observer is newly registered, not on a plain refresh', async () => {
    const { controller, scripting, state } = setup({ granted: true, registered: false });
    expect(await controller.reconcile()).toBe('registered');
    expect(scripting.executeScript).toHaveBeenCalledTimes(1);

    state.policy = { automatic: true, disabledSites: ['x.test'] };
    expect(await controller.reconcile()).toBe('refreshed');
    expect(scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('injects into open tabs when the user switches back from on-demand to automatic', async () => {
    const { controller, scripting, state } = setup({
      granted: true,
      registered: false,
      policy: { automatic: false, disabledSites: [] },
    });
    expect(await controller.reconcile()).toBe('unchanged');
    expect(scripting.executeScript).not.toHaveBeenCalled();
    state.policy = { automatic: true, disabledSites: [] };
    expect(await controller.reconcile()).toBe('registered');
    expect(scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default policy if preferences cannot be read', async () => {
    const { scripting, state } = setup({ granted: true, registered: false });
    const controller = createSiteAccessController({
      registration: { permissions: { contains: () => Promise.resolve(true) }, scripting } as never,
      openTabs: {
        tabs: { query: () => Promise.resolve([]) } as never,
        scripting: scripting as never,
      },
      readPolicy: () => Promise.reject(new Error('storage')),
      recordChoice: () => Promise.resolve(),
    });
    expect(await controller.reconcile()).toBe('registered');
    expect(state.registered).toBe(true);
  });

  it('reports the live grant and registration', async () => {
    const { controller, state } = setup({ granted: true, registered: false });
    expect(await controller.getStatus()).toEqual({ granted: true, registered: false });
    state.registered = true;
    state.granted = false;
    expect(await controller.getStatus()).toEqual({ granted: false, registered: true });
  });

  it('does not persist a choice if the choice store fails, and still reconciles', async () => {
    const { scripting, state } = setup({ granted: true, registered: false });
    const controller = createSiteAccessController({
      registration: { permissions: { contains: () => Promise.resolve(true) }, scripting } as never,
      openTabs: {
        tabs: { query: () => Promise.resolve([]) } as never,
        scripting: scripting as never,
      },
      readPolicy: () => Promise.resolve(state.policy),
      recordChoice: () => Promise.reject(new Error('storage')),
    });
    await expect(
      controller.handlePermissionsAdded({ origins: ['http://*/*', 'https://*/*'] }),
    ).resolves.toBeUndefined();
    expect(state.registered).toBe(true);
  });
});
