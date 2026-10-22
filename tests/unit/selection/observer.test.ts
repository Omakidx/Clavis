// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSelectionObserver, type SelectionObserver } from '../../../lib/selection/observer';
import type { CapturedSelection } from '../../../lib/selection/capture';
import { markOwnUi } from '../../../lib/selection/own-ui';
import * as trust from '../../../lib/selection/trust';
import { clearSelection, mockRangeRects, selectText, setBody } from './dom';

let observer: SelectionObserver | undefined;
const seen: CapturedSelection[] = [];
const onClear = vi.fn();

function start(): SelectionObserver {
  observer = startSelectionObserver({
    onSelection: (selection) => seen.push(selection),
    onClear,
  });
  return observer;
}

const fire = (type: string, target: EventTarget = document): void => {
  target.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
};

beforeEach(() => {
  // jsdom never creates trusted events: stand in for the browser.
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  mockRangeRects();
  setBody('<p>The old bank by the river and the old mill.</p><p id="b">Another paragraph.</p>');
});

afterEach(() => {
  observer?.stop();
  observer = undefined;
  seen.length = 0;
  onClear.mockReset();
  clearSelection();
  vi.useRealTimers();
});

describe('selection observer', () => {
  it('does nothing while nothing is selected', () => {
    start();
    fire('keyup');
    fire('mouseup');
    fire('selectionchange');
    vi.runAllTimers();
    expect(seen).toHaveLength(0);
    expect(onClear).not.toHaveBeenCalled();
  });

  it('captures right after mouseup, not on every selectionchange during a drag', () => {
    start();
    fire('mousedown');
    selectText('old bank');
    fire('selectionchange');
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(0);
    fire('mouseup');
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.snapshot.text).toBe('old bank');
  });

  it('captures a keyboard selection after keyup with a small debounce', () => {
    start();
    selectText('river');
    fire('keyup');
    vi.advanceTimersByTime(10);
    expect(seen).toHaveLength(0);
    vi.advanceTimersByTime(60);
    expect(seen).toHaveLength(1);
  });

  it('captures a selectionchange that follows a real gesture (menu or touch selection) within the trust window', () => {
    start();
    fire('mouseup'); // a real click that ended just before the selection changed
    vi.advanceTimersByTime(10);
    selectText('river');
    fire('selectionchange');
    vi.advanceTimersByTime(300);
    expect(seen).toHaveLength(1);
  });

  it('reports one selection for a burst of events on the same range', () => {
    start();
    selectText('river');
    fire('mouseup');
    fire('selectionchange');
    fire('keyup');
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(1);
  });

  it('reports a new selection when the range changes', () => {
    start();
    selectText('river');
    fire('mouseup');
    vi.advanceTimersByTime(1);
    selectText('mill');
    fire('mouseup');
    vi.advanceTimersByTime(1);
    expect(seen.map((s) => s.snapshot.text)).toEqual(['river', 'mill']);
    expect(seen[0]?.snapshot.selectionId).not.toBe(seen[1]?.snapshot.selectionId);
  });

  it('calls onClear once when the selection collapses', () => {
    start();
    selectText('river');
    fire('mouseup');
    vi.advanceTimersByTime(1);
    clearSelection();
    fire('selectionchange');
    vi.advanceTimersByTime(300);
    fire('mouseup');
    vi.advanceTimersByTime(300);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('ignores pointer and key events that originate inside Clavis own UI', () => {
    const own = document.createElement('div');
    markOwnUi(own);
    document.body.append(own);
    selectText('river');
    // Let jsdom deliver its queued `selectionchange` before the observer exists.
    vi.advanceTimersByTime(10);
    start();
    fire('mousedown', own);
    fire('mouseup', own);
    fire('keyup', own);
    vi.advanceTimersByTime(500);
    expect(seen).toHaveLength(0);
    fire('mouseup');
    vi.advanceTimersByTime(1);
    expect(seen).toHaveLength(1);
  });

  it('captureNow returns the current selection without notifying', () => {
    const obs = start();
    selectText('river');
    expect(obs.captureNow()?.snapshot.text).toBe('river');
    expect(seen).toHaveLength(0);
    expect(obs.captureNow()?.snapshot.text).toBe('river');
  });

  it('stop removes all listeners and pending work', () => {
    const obs = start();
    selectText('river');
    fire('mouseup');
    obs.stop();
    vi.advanceTimersByTime(500);
    fire('mouseup');
    expect(seen).toHaveLength(0);
  });

  describe('page-made events and selections cannot raise the toolbar (security review HIGH-1)', () => {
    beforeEach(() => vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(false));

    it('ignores synthetic mouseup and keyup', () => {
      start();
      selectText('river');
      vi.advanceTimersByTime(10);
      fire('mouseup');
      fire('keyup');
      vi.advanceTimersByTime(500);
      expect(seen).toHaveLength(0);
    });

    it('ignores a programmatic selection reported only by selectionchange', () => {
      start();
      selectText('river');
      fire('selectionchange');
      vi.advanceTimersByTime(500);
      expect(seen).toHaveLength(0);
    });

    it('a synthetic mousedown cannot park the observer in "dragging"', () => {
      start();
      vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
      fire('mouseup'); // a real gesture just before: authorizes the selectionchange below
      vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(false);
      fire('mousedown'); // page-made: must not set the "dragging" flag
      selectText('river');
      fire('selectionchange'); // ignored while dragging, so this proves the flag stayed off
      vi.advanceTimersByTime(300);
      expect(seen).toHaveLength(1);
    });

    it('shows nothing for a page selection made long after the last real gesture, even with a real one earlier', () => {
      start();
      vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
      fire('keyup'); // nothing selected yet: records the gesture time only
      vi.advanceTimersByTime(5000);
      vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(false);
      selectText('river');
      fire('selectionchange');
      vi.advanceTimersByTime(500);
      expect(seen).toHaveLength(0);
    });

    it('the extension-initiated capture path (context menu, shortcut) is not affected', () => {
      const obs = start();
      selectText('river');
      expect(obs.captureNow()?.snapshot.text).toBe('river');
    });
  });
});
