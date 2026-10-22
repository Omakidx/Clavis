import { browser } from 'wxt/browser';

type ExtensionPagePath = '/onboarding.html' | '/options.html' | '/practice.html' | '/reader.html';

/** Open the settings page in a tab (it is declared `open_in_tab`). */
export function openSettingsPage(): void {
  void browser.runtime.openOptionsPage();
}

/** Open one of the extension's own pages in a new tab. */
export function openExtensionPage(path: ExtensionPagePath): void {
  void browser.tabs.create({ url: browser.runtime.getURL(path) });
}

/** chrome://extensions details page for Clavis (site access can be switched off there). */
export function openChromeExtensionDetails(): void {
  void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
}
