// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSelectionController,
  type SelectionController,
} from '../../../lib/selection/controller';
import type { CapturedSelection } from '../../../lib/selection/capture';
import type { ToolbarHandle, ToolbarLoader } from '../../../lib/selection/ui-api';
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
    hide: vi.fn(),
    isInteracting: () => state.interacting,
    focus: vi.fn(),
    destroy: vi.fn(),
  };
  return state;
}

let controller: SelectionController | undefined;

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
});
