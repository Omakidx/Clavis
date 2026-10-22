import { browser } from 'wxt/browser';
import { GroqProvider } from '../ai/groq';
import { whenStorageLockedDown } from '../security/storage-lockdown';
import { registerSiteAccess } from '../site-access/background';
import { createSpeech } from '../speech/background';
import { createApiKeyStore, createSettingsStore } from '../storage';
import { createAiHandlers } from './handlers/ai';
import { createKeyService } from './handlers/key';
import { createSettingsHandlers } from './handlers/settings';
import { createAiGuard, senderKey } from './limiter';
import { createMessageListener } from './router';
import { buildRoutes } from './routes';

/**
 * Compose the background and register its listeners. Called ONCE, synchronously, from
 * entrypoints/background.ts (MV3 drops events whose listeners are registered after an
 * await). The caller starts the storage lockdown first; every key route awaits it.
 *
 * Exactly one `runtime.onMessage` listener exists in the background: the router's.
 */
export function registerBackground(): void {
  const provider = new GroqProvider();
  const settingsStore = createSettingsStore({ area: browser.storage.local });
  const keyStore = createApiKeyStore({
    local: browser.storage.local,
    session: browser.storage.session,
    lockedDown: whenStorageLockedDown,
  });
  const guard = createAiGuard();

  const keyService = createKeyService({
    store: keyStore,
    provider,
    now: Date.now,
    // A replaced or removed key must not keep serving a request that started with it.
    onKeyChanged: () => guard.inFlight.abortAll(),
  });

  const { controller, injection } = registerSiteAccess({
    readPolicy: async () => {
      const preferences = await settingsStore.getPreferences();
      return {
        automatic: preferences.tooltipBehavior === 'automatic',
        disabledSites: preferences.disabledSites,
      };
    },
    recordChoice: async (choice) => {
      await settingsStore.updateOnboarding({ siteAccessChoice: choice });
    },
  });

  const routes = buildRoutes({
    ai: createAiHandlers({
      settings: settingsStore,
      keys: keyStore,
      keyService,
      provider,
      guard,
      lockedDown: whenStorageLockedDown,
    }),
    keys: keyService,
    settings: createSettingsHandlers({
      settings: settingsStore,
      keys: keyStore,
      siteAccess: controller,
      guard,
      areas: [browser.storage.local, browser.storage.session],
    }),
    speech: createSpeech(),
    injection,
  });

  const listener = createMessageListener({
    identity: {
      runtimeId: browser.runtime.id,
      extensionOrigin: browser.runtime.getURL('/'),
    },
    routes,
  });
  browser.runtime.onMessage.addListener(listener);

  // A closed tab can no longer receive a result: stop paying for its request.
  browser.tabs.onRemoved.addListener((tabId) => {
    const key = senderKey({ tabId });
    guard.inFlight.forget(key);
    guard.buckets.forget(key);
  });
}
