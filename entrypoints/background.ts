import { registerBackground } from '../lib/router/register';
import { lockDownStorage } from '../lib/security/storage-lockdown';

export default defineBackground(() => {
  // Secret boundary rule 1 (docs/architecture.md §9): restrict storage to trusted
  // contexts before any listener is registered. Not awaited here, because MV3 drops
  // events whose listeners are registered after an await. Routes that read or write
  // the key `await whenStorageLockedDown()` and refuse to run if it is false.
  void lockDownStorage();

  // FR-001: open the welcome page once, on fresh install only (not update/reload).
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    }
  });

  // One message router (lib/router) plus the site-access listeners, registered
  // synchronously (MV3 requirement).
  registerBackground();
});
