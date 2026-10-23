import { browser } from 'wxt/browser';
import { BACKGROUND_SCRIPT_PATH } from '../../lib/speech/constants';
import { registerOffscreenSpeech } from '../../lib/speech/offscreen-page';

// Offscreen document (D-07): hosts `speechSynthesis`, which the service worker lacks.
// Created and closed by lib/speech; it has no UI.
/**
 * The worker script's own url: the only sender whose commands this page obeys. `getManifest` is
 * not guaranteed inside an offscreen document (only part of chrome.runtime is), so the build's
 * fixed worker path is the fallback.
 */
function workerScriptUrl(): string {
  let path: string = BACKGROUND_SCRIPT_PATH;
  try {
    const background = browser.runtime.getManifest().background;
    if (typeof background === 'object' && background !== null && 'service_worker' in background) {
      const declared = background.service_worker;
      if (typeof declared === 'string' && declared !== '') path = `/${declared.replace(/^\//, '')}`;
    }
  } catch {
    // Keep the fixed path.
  }
  return browser.runtime.getURL(path as never);
}

registerOffscreenSpeech({
  runtime: browser.runtime as never,
  workerUrl: workerScriptUrl(),
  synth: typeof speechSynthesis === 'undefined' ? undefined : (speechSynthesis as never),
  createUtterance: (text) => new SpeechSynthesisUtterance(text) as never,
});
