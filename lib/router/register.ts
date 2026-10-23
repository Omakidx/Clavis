import { browser } from 'wxt/browser';
import { createCapabilityCache } from '../ai/capability-cache';
import { GroqProvider } from '../ai/groq';
import { whenStorageLockedDown } from '../security/storage-lockdown';
import { registerSiteAccess } from '../site-access/background';
import { createSpeech } from '../speech/background';
import { createApiKeyStore, createSettingsStore } from '../storage';
import { createAiHandlers } from './handlers/ai';
import { createCardHandlers } from './handlers/card';
import { createKeyService } from './handlers/key';
import { createNavigationHandlers } from './handlers/navigation';
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
  // What the account's models accept (json_schema, reasoning_effort), kept in storage.session so a
  // worker restart does not re-learn it with a rejected request. Non-secret; swept by CLEAR_ALL_DATA.
  const capabilityCache = createCapabilityCache({ store: browser.storage.session });
  const provider = new GroqProvider({ capabilityCache });
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
    onKeyChanged: () => {
      guard.inFlight.abortAll();
      // Another key can belong to an account with other models.
      void capabilityCache.invalidate();
    },
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
    card: createCardHandlers({ scripting: browser.scripting }),
    navigation: createNavigationHandlers({
      runtime: browser.runtime,
      tabs: browser.tabs,
      optionsUrl: browser.runtime.getURL('/options.html'),
    }),
    keys: keyService,
    settings: createSettingsHandlers({
      settings: settingsStore,
      keys: keyStore,
      siteAccess: controller,
      guard,
      areas: [browser.storage.local, browser.storage.session],
      onModelContextChanged: () => void capabilityCache.invalidate(),
    }),
    speech: createSpeech({ preferences: () => settingsStore.getPreferences() }),
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
