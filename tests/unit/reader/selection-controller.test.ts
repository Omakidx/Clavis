// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  isFromBackground,
  mountReaderSelection,
} from '../../../components/reader/selection-toolbar';
import { capturePdfSelection } from '../../../lib/pdf/selection';
import type { CapturedSelection } from '../../../lib/selection/capture';
import {
  createSelectionController,
  type SelectionController,
} from '../../../lib/selection/controller';
import * as trust from '../../../lib/selection/trust';
import type { ToolbarHandle, ToolbarLoader } from '../../../lib/selection/ui-api';
import { buildViewer, layerOf, mockPdfLayout, select, spanTexts } from '../pdf/support';

function fakeToolbar(): ToolbarHandle & { shown: CapturedSelection[] } {
  const state = {
    shown: [] as CapturedSelection[],
    show: vi.fn((selection: CapturedSelection) => void state.shown.push(selection)),
    showNotice: vi.fn(),
    hide: vi.fn(),
    isInteracting: () => false,
    focus: vi.fn(),
    destroy: vi.fn(),
  };
  return state;
}

let controller: SelectionController | undefined;

beforeEach(() => {
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  mockPdfLayout();
});
afterEach(() => {
  controller?.stop();
  controller = undefined;
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const mouseUp = (): void => {
  document.dispatchEvent(new Event('mouseup', { bubbles: true }));
  vi.advanceTimersByTime(5);
};

describe('the shared selection controller on PDF text layers', () => {
  it('shows the shared toolbar for a PDF selection with source pdf, the page and same-page context', async () => {
    const root = buildViewer([
      { number: 1, spans: ['Other page text.'] },
      { number: 2, spans: ['The old bank', 'by the river', 'and the old mill.'] },
    ]);
    root.classList.add('viewer');
    const toolbar = fakeToolbar();
    const loadToolbar = vi.fn<ToolbarLoader>(() => Promise.resolve(toolbar));
    controller = createSelectionController({
      loadToolbar,
      capture: (win) => capturePdfSelection(win, root),
    });
    const [first, second] = spanTexts(layerOf(root, 2));
    select(second!, 7, second!, 12);
    expect(first).toBeDefined();
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(loadToolbar).toHaveBeenCalledTimes(1);
    const shown = toolbar.shown[0]!;
    expect(shown.snapshot).toMatchObject({
      source: 'pdf',
      page: 2,
      kind: 'word',
      text: 'river',
      contextBefore: 'The old bank by the',
      contextAfter: 'and the old mill.',
    });
    expect(JSON.stringify(shown.snapshot)).not.toContain('Other page');
  });

  it('ignores a selection outside the viewer, which the webpage capture would not (it is the same document)', async () => {
    const root = buildViewer([{ number: 1, spans: ['inside'] }]);
    const outside = document.createElement('p');
    outside.textContent = 'outside the pdf';
    document.body.append(outside);
    const toolbar = fakeToolbar();
    controller = createSelectionController({
      loadToolbar: () => Promise.resolve(toolbar),
      capture: (win) => capturePdfSelection(win, root),
    });
    select(outside.firstChild!, 0, outside.firstChild!, 7);
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toEqual([]);
  });

  it('without the override the webpage path would call the selection "webpage" (the override is what makes it pdf)', async () => {
    const root = buildViewer([{ number: 1, spans: ['plain words here'] }]);
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, 5);
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown[0]?.snapshot.source).toBe('webpage');
  });
});

describe('mountReaderSelection', () => {
  it('registers one runtime listener and removes it on stop; unknown senders are ignored', () => {
    const root = buildViewer([{ number: 1, spans: ['x'] }]);
    const handle = mountReaderSelection(root);
    expect(browser.runtime.onMessage.hasListeners()).toBe(true);
    handle.stop();
    expect(browser.runtime.onMessage.hasListeners()).toBe(false);
    // Stopping twice is harmless.
    expect(() => handle.stop()).not.toThrow();
  });

  it('reposition() nudges the toolbar through a window resize event', () => {
    const root = buildViewer([{ number: 1, spans: ['x'] }]);
    const handle = mountReaderSelection(root);
    const resize = vi.fn();
    window.addEventListener('resize', resize);
    handle.reposition();
    expect(resize).toHaveBeenCalledTimes(1);
    window.removeEventListener('resize', resize);
    handle.stop();
  });
});

describe('isFromBackground (LOW-3)', () => {
  const own = browser.runtime.id;
  const worker = browser.runtime.getURL('/background.js');

  it('accepts the service worker: our id, no tab, the worker script URL', () => {
    expect(isFromBackground({ id: own, url: worker })).toBe(true);
  });

  it('ignores a content script of ours (it has a tab and a web page URL)', () => {
    expect(isFromBackground({ id: own, tab: { id: 7 }, url: 'https://evil.example/page' })).toBe(
      false,
    );
    // Even if a content script reported the worker's URL it still has a tab.
    expect(isFromBackground({ id: own, tab: { id: 7 }, url: worker })).toBe(false);
  });

  it('ignores other extension pages, other extensions and missing senders', () => {
    expect(isFromBackground({ id: own, url: browser.runtime.getURL('/options.html') })).toBe(false);
    expect(isFromBackground({ id: 'someone-else', url: worker })).toBe(false);
    expect(isFromBackground({ id: own })).toBe(false);
    expect(isFromBackground(undefined)).toBe(false);
  });
});
