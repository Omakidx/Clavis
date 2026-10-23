import { browser } from 'wxt/browser';
import { EXTENSION_PAGES } from '../config/constants';
import { t } from '../i18n';
import { createSiteAccessController, type SiteAccessController } from './controller';
import {
  CONTEXT_MENU_ID,
  handleCommand,
  handleContextMenuClick,
  type InjectionDeps,
} from './injection';
import type { RegistrationDeps, SitePolicy } from './registration';
import type { SiteAccessControllerDeps } from './controller';

/** (Re)create the single "Explain with Clavis" entry. Menu items persist, so rebuild on install/update. */
export async function setupContextMenu(
  contextMenus: Pick<typeof browser.contextMenus, 'create' | 'removeAll'>,
): Promise<void> {
  await contextMenus.removeAll();
  contextMenus.create(
    { id: CONTEXT_MENU_ID, title: t('toolbarContextMenuTitle'), contexts: ['selection'] },
    () => {
      // Read lastError so a duplicate id cannot surface as an unchecked error.
      void browser.runtime.lastError;
    },
  );
}

function warn(what: string, error: unknown): void {
  // Metadata only: never page text or URLs (FR-073).
  console.warn(`Clavis: ${what} failed`, error instanceof Error ? error.name : '');
}

export interface SiteAccessOptions {
  /** The user's preferences as a registration policy (see SitePolicy). */
  readPolicy: SiteAccessControllerDeps['readPolicy'];
  /** Persist the user's grant/decline so onboarding never re-prompts. */
  recordChoice: SiteAccessControllerDeps['recordChoice'];
}

export interface SiteAccess {
  controller: SiteAccessController;
  /** Dependencies of the on-demand injection routes served by the message router. */
  injection: InjectionDeps;
}

/**
 * Spike B (D-02) + Phase 3: runtime content-script registration, per-site exclusions,
 * on-demand mode, the `activeTab` fallback (context menu, popup button, shortcut) and
 * injection into already-open tabs after a grant.
 *
 * Registers every NON-message listener, once, synchronously from the background service
 * worker at startup (MV3 requirement). Its messages (CLAVIS_INJECT_TAB) are routes
 * in the single router (lib/router); this module no longer listens for runtime messages.
 */
export function registerSiteAccess(options: SiteAccessOptions): SiteAccess {
  const registration: RegistrationDeps = {
    permissions: browser.permissions,
    scripting: browser.scripting,
  };
  const injection: InjectionDeps = {
    scripting: browser.scripting,
    tabs: browser.tabs,
    readerUrl: browser.runtime.getURL(EXTENSION_PAGES.reader),
  };
  const controller = createSiteAccessController({
    registration,
    openTabs: { tabs: browser.tabs, scripting: browser.scripting },
    readPolicy: options.readPolicy,
    recordChoice: options.recordChoice,
  });

  const reconcile = (force = false): void => {
    controller
      .reconcile(force ? { force: true } : {})
      .catch((error: unknown) => warn('site access reconcile', error));
  };

  browser.permissions.onAdded.addListener((permissions) => {
    controller
      .handlePermissionsAdded(permissions)
      .catch((error: unknown) => warn('site access grant', error));
  });
  browser.permissions.onRemoved.addListener((permissions) => {
    controller
      .handlePermissionsRemoved(permissions)
      .catch((error: unknown) => warn('site access revoke', error));
  });
  browser.runtime.onStartup.addListener(() => reconcile());
  browser.runtime.onInstalled.addListener(() => {
    setupContextMenu(browser.contextMenus).catch((error: unknown) => warn('context menu', error));
    reconcile(true);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    handleContextMenuClick(injection, info, tab)?.catch((error: unknown) =>
      warn('context menu injection', error),
    );
  });
  // `browser.commands` only exists once the manifest declares `commands`; without it the API is
  // undefined and touching it would crash the worker.
  const commands = (browser as { commands?: typeof browser.commands }).commands;
  commands?.onCommand.addListener((command, tab) => {
    handleCommand(injection, command, tab)?.catch((error: unknown) => warn('command', error));
  });

  // The worker also starts for unrelated events; keep the registration in step with the grant.
  reconcile();
  return { controller, injection };
}

export type { SitePolicy };
