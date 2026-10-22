import { browser } from 'wxt/browser';
import { injectUiMessage, UI_SCRIPT_PATH, type InjectResult } from '../site-access/messages';
import { getLoadedUi, type ToolbarLoader, type ContentUiModule } from './ui-api';

function requireUi(): ContentUiModule {
  const ui = getLoadedUi();
  if (ui === undefined) throw new Error('UI script did not register');
  return ui;
}

/**
 * Option (a): ask the background to `scripting.executeScript` the UI file into
 * this frame. Exposes no file to web pages; costs a service-worker round trip
 * (and a wake-up if the worker was asleep).
 */
export const backgroundInjectionLoader: ToolbarLoader = async (options) => {
  if (getLoadedUi() === undefined) {
    const reply = (await browser.runtime.sendMessage(injectUiMessage())) as
      InjectResult | undefined;
    if (reply?.ok !== true) throw new Error('UI injection refused');
  }
  return requireUi().createToolbar(options);
};

/**
 * Option (b): `import()` the UI file from a `web_accessible_resources` entry with
 * `use_dynamic_url: true`. Needs a manifest entry that only wxt.config.ts can
 * declare (WXT adds web-accessible resources for content-script CSS only).
 */
export const dynamicImportLoader: ToolbarLoader = async (options) => {
  if (getLoadedUi() === undefined) {
    const url = browser.runtime.getURL(UI_SCRIPT_PATH);
    await import(/* @vite-ignore */ url);
  }
  return requireUi().createToolbar(options);
};
