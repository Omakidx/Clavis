export default defineBackground(() => {
  // Secret boundary rule 1 (docs/architecture.md section 9): this must be the very
  // first action, before any listener is registered. It is issued synchronously
  // (not awaited) because MV3 drops events whose listeners are registered after
  // an await; later message routes that touch storage must await this promise.
  const storageLockedDown = browser.storage.local
    .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch((error: unknown) => {
      console.error('Clavis: could not restrict storage access', error);
    });
  void storageLockedDown;

  // FR-001: open the welcome page once, on fresh install only (not update/reload).
  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') {
      void browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    }
  });
});
