import { browser } from 'wxt/browser';
import { createApiClient } from '../account/api';
import { buildAccountConfig } from '../account/config';
import { createAccountService } from '../account/service';
import { createTokenClient, createTokenStore } from '../account/tokens';
import { FEATURES } from '../config/constants';
import { createSyncEngine } from '../sync/engine';
import { createSyncStateStore } from '../sync/state';
import { createCapabilityCache } from '../ai/capability-cache';
import { GroqProvider } from '../ai/groq';
import { notifyAccountStatusChanged } from '../data/channel';
import { sweepStaleHandoffs } from '../data/handoff';
import { migrateLegacyHighlights } from '../data/migrate';
import { logger } from '../security/logger';
import { whenStorageLockedDown } from '../security/storage-lockdown';
import { registerSiteAccess } from '../site-access/background';
import { createSpeech } from '../speech/background';
import { createApiKeyStore, createSettingsStore } from '../storage';
import { createAccountHandlers } from './handlers/account';
import { createAiHandlers } from './handlers/ai';
import { createCardHandlers } from './handlers/card';
import { createChatHandlers } from './handlers/chat';
import { createDocumentHandlers } from './handlers/documents';
import { createKeyService } from './handlers/key';
import { createNavigationHandlers } from './handlers/navigation';
import { createSidePanelHandlers } from './handlers/sidepanel';
import { createSettingsHandlers } from './handlers/settings';
import { createSyncHandlers } from './handlers/sync';
import { createWordHandlers } from './handlers/words';
import { abortTabRequests, createAiGuard, panelKey, senderKey } from './limiter';
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

  // The side panel hand-off (FR-042): held in this worker's memory by tab, never persisted.
  const sidePanel = createSidePanelHandlers({
    sidePanel: browser.sidePanel,
    notify: (message) => browser.runtime.sendMessage(message) as Promise<unknown>,
  });

  // Accounts and sync (docs/clavis-sync-design.md). Built always, but inert unless
  // FEATURES.accountSync: no listener below is registered, no request is ever made.
  const accountEnabled = FEATURES.accountSync;
  const syncState = createSyncStateStore(browser.storage.local);
  const accountApi = createApiClient({ origin: buildAccountConfig().apiOrigin });
  const tokenStore = createTokenStore({
    local: browser.storage.local,
    session: browser.storage.session,
    lockedDown: whenStorageLockedDown,
  });
  // eslint-disable-next-line prefer-const -- the token client needs the service, the service the client
  let account: ReturnType<typeof createAccountService>;
  const tokenClient = createTokenClient({
    store: tokenStore,
    api: accountApi,
    onSessionLost: () => account.sessionLost(),
    generation: () => account.generation(),
  });
  const engine = createSyncEngine({
    tokens: tokenClient,
    state: syncState,
    alarms: browser.alarms,
    enabled: accountEnabled,
    onSessionLost: () => account.sessionLost(),
  });
  account = createAccountService({
    config: buildAccountConfig(),
    api: accountApi,
    tokens: tokenClient,
    store: tokenStore,
    state: syncState,
    engine,
    local: browser.storage.local,
    identity: browser.identity,
    enabled: accountEnabled,
  });
  const kickEngine = (pull = false): void => void engine.kick(pull);

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
    sidePanel,
    keys: keyService,
    settings: createSettingsHandlers({
      settings: settingsStore,
      keys: keyStore,
      siteAccess: controller,
      guard,
      areas: [browser.storage.local, browser.storage.session],
      onModelContextChanged: () => void capabilityCache.invalidate(),
      onDataCleared: () => sidePanel.clear(),
      invalidateAccount: () => account.invalidate(),
      signOutFirst: async () => {
        if (accountEnabled) await account.signOut(false);
      },
    }),
    speech: createSpeech({ preferences: () => settingsStore.getPreferences() }),
    injection,
    words: createWordHandlers({ tabs: browser.tabs, onLocalChange: kickEngine }),
    chat: createChatHandlers({
      settings: settingsStore,
      keys: keyStore,
      keyService,
      provider,
      guard,
      lockedDown: whenStorageLockedDown,
      onLocalChange: kickEngine,
    }),
    sync: createSyncHandlers({ onKick: kickEngine }),
    account: createAccountHandlers({ account, engine, enabled: accountEnabled }),
    documents: createDocumentHandlers({
      tokens: tokenClient,
      enabled: accountEnabled,
      onLocalChange: () => kickEngine(true),
      onStorageChanged: () => {
        account.invalidateUsage();
        notifyAccountStatusChanged();
      },
    }),
  });

  const listener = createMessageListener({
    identity: {
      runtimeId: browser.runtime.id,
      extensionOrigin: browser.runtime.getURL('/'),
    },
    routes,
  });
  browser.runtime.onMessage.addListener(listener);

  // Highlights used to live in chrome.storage.local; move them into IndexedDB once (design 7.3).
  // Idempotent and cheap when there is nothing to move, so it simply runs at every worker start.
  void migrateLegacyHighlights().then(
    (written) => {
      if (written > 0) kickEngine();
    },
    () => logger.warn('highlight_migration_failed'),
  );

  // A PDF left in the handoff store by a page that died mid-transfer must not stay (design 6.6).
  void sweepStaleHandoffs().catch(() => logger.warn('handoff_sweep_failed'));

  if (accountEnabled) {
    // Listeners are registered synchronously (MV3). The engine only acts while signed in.
    browser.runtime.onStartup.addListener(() => void engine.onStartup());
    browser.alarms.onAlarm.addListener((alarm) => void engine.onAlarm(alarm.name));
    void engine.ensureAlarm();
  }

  // A closed tab can no longer receive a result: stop paying for its request.
  browser.tabs.onRemoved.addListener((tabId) => {
    const key = senderKey({ tabId });
    guard.inFlight.forget(key);
    guard.buckets.forget(key);
    // Its side panel (if any) goes with it: the hand-off, and the panel's own request state.
    sidePanel.forget(tabId);
    guard.inFlight.forget(panelKey(tabId));
    guard.buckets.forget(panelKey(tabId));
  });

  // A tab that starts loading another page, or changes its url without loading (a single-page
  // app's navigation), no longer shows what the panel explains. `status` is reported without any
  // host permission; `url` only where the extension may read the tab, which covers the sites Clavis
  // runs on.
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || changeInfo.url !== undefined) sidePanel.reset(tabId);
    // The page the request was for is going away: stop paying for an answer nobody will read (the
    // tab's own request, and its side panel's, which belongs to the same page). A single-page
    // app's route change also reports `status: 'loading'` (verified in Chrome), so it counts too.
    if (changeInfo.status === 'loading') abortTabRequests(guard, tabId);
  });
}
