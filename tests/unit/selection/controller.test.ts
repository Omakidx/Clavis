// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSelectionController,
  type SelectionController,
} from '../../../lib/selection/controller';
import type { CapturedSelection } from '../../../lib/selection/capture';
import type { ToolbarActions, ToolbarHandle, ToolbarLoader } from '../../../lib/selection/ui-api';
import * as trust from '../../../lib/selection/trust';
import { clearSelection, mockRangeRects, selectText, setBody } from './dom';

function fakeToolbar(): ToolbarHandle & {
  shown: CapturedSelection[];
  interacting: boolean;
} {
  const state = {
    shown: [] as CapturedSelection[],
    interacting: false,
    show: vi.fn((selection: CapturedSelection) => void state.shown.push(selection)),
    showNotice: vi.fn(),
    hide: vi.fn(),
    isInteracting: () => state.interacting,
    focus: vi.fn(),
    explain: vi.fn(),
    destroy: vi.fn(),
  };
  return state;
}

let controller: SelectionController | undefined;
/** The actions the controller handed the loader (its dismiss hook is what the toolbar calls). */
let handed: ToolbarActions | undefined;
const loadedActions = (_toolbar: unknown): ToolbarActions | undefined => handed;

beforeEach(() => {
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  mockRangeRects();
  setBody('<p>The old bank by the river and the old mill.</p>');
});

afterEach(() => {
  controller?.stop();
  controller = undefined;
  clearSelection();
  vi.useRealTimers();
});

const mouseUp = (): void => {
  document.dispatchEvent(new Event('mouseup', { bubbles: true }));
  vi.advanceTimersByTime(5);
};

describe('selection controller', () => {
  it('loads the UI once, on the first qualifying selection only', async () => {
    const toolbar = fakeToolbar();
    const loadToolbar = vi.fn<ToolbarLoader>(() => Promise.resolve(toolbar));
    controller = createSelectionController({ loadToolbar });
    expect(loadToolbar).not.toHaveBeenCalled();

    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    selectText('mill');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(loadToolbar).toHaveBeenCalledTimes(1);
    expect(toolbar.shown.map((s) => s.snapshot.text)).toEqual(['river', 'mill']);
  });

  it('shows only the latest selection when the UI finishes loading late', async () => {
    const toolbar = fakeToolbar();
    let finish: (handle: ToolbarHandle) => void = () => undefined;
    const loadToolbar: ToolbarLoader = () => new Promise((resolve) => (finish = resolve));
    controller = createSelectionController({ loadToolbar });

    selectText('river');
    mouseUp();
    selectText('mill');
    mouseUp();
    finish(toolbar);
    await vi.advanceTimersByTimeAsync(0);

    expect(toolbar.shown.map((s) => s.snapshot.text)).toEqual(['mill']);
  });

  it('does not show a stale selection that was cleared while the UI loaded', async () => {
    const toolbar = fakeToolbar();
    let finish: (handle: ToolbarHandle) => void = () => undefined;
    controller = createSelectionController({
      loadToolbar: () => new Promise((resolve) => (finish = resolve)),
    });
    selectText('river');
    mouseUp();
    clearSelection();
    mouseUp();
    finish(toolbar);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(0);
  });

  it('retries loading on the next selection after a failed load', async () => {
    const toolbar = fakeToolbar();
    const loadToolbar = vi
      .fn<ToolbarLoader>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(toolbar);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    controller = createSelectionController({ loadToolbar });

    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    selectText('mill');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);

    expect(loadToolbar).toHaveBeenCalledTimes(2);
    expect(toolbar.shown.map((s) => s.snapshot.text)).toEqual(['mill']);
  });

  it('hides the toolbar when the selection goes away', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    clearSelection();
    mouseUp();
    expect(toolbar.hide).toHaveBeenCalledTimes(1);
    expect(toolbar.hide).toHaveBeenCalledWith('cleared');
  });

  it('passes the action interface on to the toolbar, dismissal included', async () => {
    const toolbar = fakeToolbar();
    const loadToolbar = vi.fn<ToolbarLoader>(() => Promise.resolve(toolbar));
    const actions = { explain: vi.fn(), dismiss: vi.fn() };
    controller = createSelectionController({ loadToolbar, actions });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    const given = loadToolbar.mock.calls[0]?.[0].actions;
    expect(given?.explain).toBe(actions.explain);
    const context = {
      snapshot: toolbar.shown[0]!.snapshot,
      overLimit: false,
      reason: 'outside',
    } as const;
    given?.dismiss?.(context);
    expect(actions.dismiss).toHaveBeenCalledWith(context);
  });

  it('after Escape, a real mouseup ON the same unchanged selection shows the toolbar again', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({
      loadToolbar: (options) => {
        handed = options.actions;
        return Promise.resolve(toolbar);
      },
    });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);
    const dismiss = (reason: 'escape' | 'outside' | 'cleared'): void =>
      (handed?.dismiss as (c: unknown) => void)({
        snapshot: toolbar.shown[0]!.snapshot,
        overLimit: false,
        reason,
      });
    const release = (x: number, y: number): void => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x, clientY: y }));
      vi.advanceTimersByTime(5);
    };
    // The mocked selection box is (100,200)-(200,220).

    // A press outside (selection kept by the page) must not bring it back, even on the text.
    dismiss('outside');
    release(150, 210);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);

    // Escape: a release away from the selection does not; one on it does.
    dismiss('escape');
    release(600, 500);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);
    dismiss('escape');
    release(150, 210);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(2);
  });

  it('the reshow press is found by position, so a retargeted event target (shadow root) does not matter', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({
      loadToolbar: (options) => {
        handed = options.actions;
        return Promise.resolve(toolbar);
      },
    });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    (handed?.dismiss as (c: unknown) => void)({
      snapshot: toolbar.shown[0]!.snapshot,
      overLimit: false,
      reason: 'escape',
    });
    // The listener sees the shadow HOST as target; only the coordinates say where the press was.
    const host = document.createElement('div');
    document.body.append(host);
    host.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 205 }));
    vi.advanceTimersByTime(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(2);
  });

  it('the Escape keyup itself does not bring the toolbar back', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({
      loadToolbar: (options) => {
        handed = options.actions;
        return Promise.resolve(toolbar);
      },
    });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    (loadedActions(toolbar)?.dismiss as (c: unknown) => void)({
      snapshot: toolbar.shown[0]!.snapshot,
      overLimit: false,
      reason: 'escape',
    });
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(toolbar.shown).toHaveLength(1);
  });

  it('showNotice loads the toolbar once and shows the message without any selection', async () => {
    const toolbar = fakeToolbar();
    const loadToolbar = vi.fn<ToolbarLoader>(() => Promise.resolve(toolbar));
    controller = createSelectionController({ loadToolbar });
    expect(await controller.showNotice('No access to this frame')).toBe(true);
    expect(await controller.showNotice('Again')).toBe(true);
    expect(loadToolbar).toHaveBeenCalledTimes(1);
    expect(toolbar.showNotice).toHaveBeenLastCalledWith('Again');
    expect(toolbar.shown).toHaveLength(0);
  });

  it('showNotice reports false when the toolbar cannot load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    controller = createSelectionController({ loadToolbar: () => Promise.reject(new Error('x')) });
    expect(await controller.showNotice('x')).toBe(false);
  });

  it('keeps the toolbar when the selection collapses during a toolbar interaction (FR-014)', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    toolbar.interacting = true;
    clearSelection();
    mouseUp();
    expect(toolbar.hide).not.toHaveBeenCalled();
  });

  it('openForCurrentSelection shows the toolbar for the existing selection', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    expect(await controller.openForCurrentSelection()).toBe(false);
    selectText('river');
    expect(await controller.openForCurrentSelection()).toBe(true);
    expect(toolbar.shown).toHaveLength(1);
    expect(toolbar.shown[0]?.snapshot.text).toBe('river');
    expect(toolbar.focus).not.toHaveBeenCalled();
  });

  it('openForCurrentSelection moves focus into the toolbar only when asked (keyboard shortcut)', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    selectText('river');
    expect(await controller.openForCurrentSelection({ focus: true })).toBe(true);
    expect(toolbar.focus).toHaveBeenCalledTimes(1);
  });

  it('openForCurrentSelection starts Explain only when asked (context menu, popup button)', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    selectText('river');
    expect(await controller.openForCurrentSelection()).toBe(true);
    expect(toolbar.explain).not.toHaveBeenCalled();
    expect(await controller.openForCurrentSelection({ explain: true })).toBe(true);
    expect(toolbar.explain).toHaveBeenCalledTimes(1);
    expect(toolbar.focus).not.toHaveBeenCalled();
  });

  it('nothing is explained when there is no selection', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: () => Promise.resolve(toolbar) });
    expect(await controller.openForCurrentSelection({ explain: true })).toBe(false);
    expect(toolbar.explain).not.toHaveBeenCalled();
  });
});

describe('controller lifecycle and edge cases', () => {
  const load =
    (toolbar: ToolbarHandle): ToolbarLoader =>
    () =>
      Promise.resolve(toolbar);

  it('re-opening the SAME showing selection keeps its snapshot and only moves focus (context menu, shortcut)', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: load(toolbar) });
    selectText('river');
    expect(await controller.openForCurrentSelection()).toBe(true);
    expect(await controller.openForCurrentSelection({ focus: true })).toBe(true);
    expect(toolbar.show).toHaveBeenCalledTimes(1);
    expect(toolbar.focus).toHaveBeenCalledTimes(1);
  });

  it('a different selection, or the same one after it was dismissed, is shown (new snapshot)', async () => {
    const toolbar = fakeToolbar();
    let actions: ToolbarActions | undefined;
    controller = createSelectionController({
      loadToolbar: (options) => {
        actions = options.actions;
        return Promise.resolve(toolbar);
      },
    });
    selectText('river');
    await controller.openForCurrentSelection();
    selectText('mill');
    await controller.openForCurrentSelection();
    expect(toolbar.show).toHaveBeenCalledTimes(2);
    (actions?.dismiss as (c: unknown) => void)({
      snapshot: toolbar.shown[1]!.snapshot,
      overLimit: false,
      reason: 'outside',
    });
    await controller.openForCurrentSelection();
    expect(toolbar.show).toHaveBeenCalledTimes(3);
    expect(toolbar.shown[2]?.snapshot.selectionId).not.toBe(toolbar.shown[1]?.snapshot.selectionId);
  });

  it('a page script that changes the selection (no real input) clears the toolbar from the old text', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: load(toolbar) });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);

    // Long after the last real gesture (trust window is 1.5 s), the page selects something else.
    vi.advanceTimersByTime(5000);
    selectText('mill');
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
    expect(toolbar.hide).toHaveBeenCalledWith('cleared');
    expect(toolbar.shown).toHaveLength(1); // and nothing new was shown
  });

  it('a page-made change back to the SAME selection leaves the toolbar alone', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: load(toolbar) });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(5000);
    selectText('river');
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
    expect(toolbar.hide).not.toHaveBeenCalled();
  });

  it('injected fresh and opened by the extension (context menu, popup, shortcut): a follow-up selectionchange with the same range keeps the toolbar', async () => {
    const toolbar = fakeToolbar();
    controller = createSelectionController({ loadToolbar: load(toolbar) });
    // The observer never saw the user's gesture: no mouseup or keyup has happened at all.
    selectText('river');
    expect(await controller.openForCurrentSelection()).toBe(true);
    expect(toolbar.show).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.hide).not.toHaveBeenCalled();
    expect(toolbar.show).toHaveBeenCalledTimes(1);

    // A genuinely different selection afterwards, still without real input, does clear it.
    selectText('mill');
    document.dispatchEvent(new Event('selectionchange'));
    vi.advanceTimersByTime(200);
    expect(toolbar.hide).toHaveBeenCalledWith('cleared');
  });

  it('stop() destroys the toolbar, removes the observer listeners and shows nothing afterwards', async () => {
    const toolbar = fakeToolbar();
    const added: Array<[string, unknown]> = [];
    const removed: Array<[string, unknown]> = [];
    for (const target of [document, window] as const) {
      const add = target.addEventListener.bind(target);
      const remove = target.removeEventListener.bind(target);
      vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        added.push([type, listener]);
        add(type, listener, options as AddEventListenerOptions);
      });
      vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
        removed.push([type, listener]);
        remove(type, listener, options as EventListenerOptions);
      });
    }
    controller = createSelectionController({ loadToolbar: load(toolbar) });
    selectText('river');
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    controller.stop();
    expect(toolbar.destroy).toHaveBeenCalledTimes(1);
    for (const entry of added) expect(removed).toContainEqual(entry);

    selectText('mill');
    mouseUp();
    vi.advanceTimersByTime(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);
    expect(await controller.showNotice('x')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a toolbar that finishes loading after stop() is destroyed, not shown', async () => {
    const toolbar = fakeToolbar();
    let finish: (handle: ToolbarHandle) => void = () => undefined;
    controller = createSelectionController({
      loadToolbar: () => new Promise((resolve) => (finish = resolve)),
    });
    selectText('river');
    mouseUp();
    controller.stop();
    finish(toolbar);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.destroy).toHaveBeenCalledTimes(1);
    expect(toolbar.shown).toHaveLength(0);
  });
});

describe('selection removed by the page itself (Phase 9 Q4)', () => {
  async function showFor(word: string, options: object = {}) {
    const toolbar = fakeToolbar();
    controller = createSelectionController({
      loadToolbar: () => Promise.resolve(toolbar),
      ...options,
    });
    selectText(word);
    mouseUp();
    await vi.advanceTimersByTimeAsync(0);
    expect(toolbar.shown).toHaveLength(1);
    return toolbar;
  }

  it('hides the toolbar when the selected text is deleted from the DOM (no selectionchange)', async () => {
    const toolbar = await showFor('river');
    await vi.advanceTimersByTimeAsync(2000);
    expect(toolbar.hide).not.toHaveBeenCalled();
    document.body.replaceChildren();
    await vi.advanceTimersByTimeAsync(600);
    expect(toolbar.hide).toHaveBeenCalledWith('cleared');
    expect(toolbar.hide).toHaveBeenCalledTimes(1);
    // Nothing keeps checking afterwards.
    await vi.advanceTimersByTimeAsync(5000);
    expect(toolbar.hide).toHaveBeenCalledTimes(1);
  });

  it('hides it when only the text node is removed and the range collapses', async () => {
    const toolbar = await showFor('river');
    document.querySelector('p')!.replaceChildren();
    await vi.advanceTimersByTimeAsync(600);
    expect(toolbar.hide).toHaveBeenCalledWith('cleared');
  });

  it('keeps it while the text is still in the document, also after other DOM changes', async () => {
    const toolbar = await showFor('river');
    document.body.append(document.createElement('div'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(toolbar.hide).not.toHaveBeenCalled();
  });
});
