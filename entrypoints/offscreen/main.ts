import { browser } from 'wxt/browser';
import { registerOffscreenSpeech } from '../../lib/speech/offscreen-page';

// Offscreen document (D-07): hosts `speechSynthesis`, which the service worker lacks.
// Created and closed by lib/speech; it has no UI.
registerOffscreenSpeech({
  runtime: browser.runtime as never,
  synth: typeof speechSynthesis === 'undefined' ? undefined : (speechSynthesis as never),
  createUtterance: (text) => new SpeechSynthesisUtterance(text) as never,
});
