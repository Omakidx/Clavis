import { browser } from 'wxt/browser';
import { t } from '../i18n';
import { toolbarVariant } from '../selection/variant';
import {
  CONTEXT_MENU_ID,
  filesForVariant,
  handleCommand,
  handleContextMenuClick,
  routeInjectionMessage,
  type InjectionDeps,
} from './injection';
import { reconcileSerialized, type RegistrationDeps } from './registration';

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

/**
 * Spike B (D-02): runtime content-script registration, the `activeTab` fallback
 * (context menu and popup button) and the option (a) UI injection route.
 * Called once, synchronously, from the background service worker at startup:
 * every listener must be registered before the first await (MV3).
 */
export function registerSiteAccess(): void {
  const registration: RegistrationDeps = {
    permissions: browser.permissions,
    scripting: browser.scripting,
  };
  const injection: InjectionDeps = {
    scripting: browser.scripting,
    tabs: browser.tabs,
    runtimeId: browser.runtime.id,
    extensionUrlPrefix: browser.runtime.getURL('/'),
    files: filesForVariant(toolbarVariant()),
  };

  const reconcile = (force = false): void => {
    reconcileSerialized(registration, { force }).catch((error: unknown) =>
      warn('site access reconcile', error),
    );
  };

  browser.permissions.onAdded.addListener(() => reconcile());
  browser.permissions.onRemoved.addListener(() => reconcile());
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
  // `browser.commands` only exists once the manifest declares `commands` (a Spike B proposal
  // for wxt.config.ts); without it the API is undefined and touching it would crash the worker.
  const commands = (browser as { commands?: typeof browser.commands }).commands;
  commands?.onCommand.addListener((command, tab) => {
    handleCommand(injection, command, tab)?.catch((error: unknown) => warn('command', error));
  });
  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const pending = routeInjectionMessage(injection, raw, sender);
    if (pending === undefined) return undefined;
    void pending.then(sendResponse);
    return true;
  });

  // The worker also starts for unrelated events; keep the registration in step with the grant.
  reconcile();
}
