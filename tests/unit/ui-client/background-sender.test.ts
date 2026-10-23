import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { isFromBackground } from '../../../lib/ui-client/background-sender';

// Phase 9 audit I3: the practice page (like the reader and the side panel) accepts background
// events from the service worker only.
describe('isFromBackground', () => {
  const id = fakeBrowser.runtime.id;
  const worker = { id, url: fakeBrowser.runtime.getURL('/background.js') };

  it('accepts only the service worker itself: our id, no tab, its own script url', () => {
    expect(isFromBackground(worker)).toBe(true);
    // A content script of ours in a web page has our id and a tab.
    expect(isFromBackground({ id, url: 'https://example.com/', tab: { id: 1 } })).toBe(false);
    expect(isFromBackground({ ...worker, tab: { id: 1 } })).toBe(false);
    expect(isFromBackground({ ...worker, id: 'someone-else' })).toBe(false);
    // Another of our pages (the options page sending a forged TTS_EVENT).
    expect(isFromBackground({ id, url: fakeBrowser.runtime.getURL('/options.html') })).toBe(false);
    expect(isFromBackground(undefined)).toBe(false);
  });
});
