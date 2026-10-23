import { browser } from 'wxt/browser';
import { SETTINGS_SECTION_ANCHORS } from '../config/constants';

type ExtensionPagePath = '/onboarding.html' | '/options.html' | '/practice.html' | '/reader.html';

/** Open the settings page in a tab (it is declared `open_in_tab`). */
export function openSettingsPage(): void {
  void browser.runtime.openOptionsPage();
}

/**
 * Open Settings scrolled to one section. Extension pages can open their own page with an anchor
 * directly; web pages and the card go through the background's OPEN_SETTINGS route instead.
 */
export function openSettingsAt(section: keyof typeof SETTINGS_SECTION_ANCHORS): void {
  void browser.tabs.create({
    url: `${browser.runtime.getURL('/options.html')}#${SETTINGS_SECTION_ANCHORS[section]}`,
  });
}

/** Open one of the extension's own pages in a new tab. */
export function openExtensionPage(path: ExtensionPagePath): void {
  void browser.tabs.create({ url: browser.runtime.getURL(path) });
}

/** chrome://extensions details page for Clavis (site access can be switched off there). */
export function openChromeExtensionDetails(): void {
  void browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
}
