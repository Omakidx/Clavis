// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createPreactRenderer } from '../../../components/tooltip/preact-renderer';
import { createToolbar } from '../../../components/tooltip/toolbar';
import * as trust from '../../../lib/selection/trust';
import { isOwnUiNode } from '../../../lib/selection/own-ui';
import { captureSelection, type CapturedSelection } from '../../../lib/selection/capture';
import { actionError } from '../../../lib/selection/ui-api';
import { LIMITS } from '../../../lib/config/constants';
import type {
  ActionContext,
  RunContext,
  DismissContext,
  ToolbarActionResult,
  ToolbarActions,
  ToolbarHandle,
} from '../../../lib/selection/ui-api';
import { clearSelection, mockRangeRects, selectText, setBody } from '../selection/dom';

let toolbar: ToolbarHandle | undefined;
/** Every call the toolbar made on the action interface, in order. */
const calls: Array<{ action: string; context: ActionContext | DismissContext }> = [];
/** The abort signal of each listen/explain run, in order. */
const signals: AbortSignal[] = [];
/** What `listen` and `explain` return; tests replace it to simulate a slow or failing action. */
let outcome: () => ToolbarActionResult = () => undefined;
const implementation: ToolbarActions = {
  listen: (context: RunContext) => {
    calls.push({ action: 'listen', context });
    signals.push(context.signal);
    return outcome();
  },
  explain: (context: RunContext) => {
    calls.push({ action: 'explain', context });
    signals.push(context.signal);
    return outcome();
  },
  trim: (context) => void calls.push({ action: 'trim', context }),
  dismiss: (context) => void calls.push({ action: 'dismiss', context }),
};

// The root is CLOSED (pages get `host.shadowRoot === null`); tests see it through the
// value `attachShadow` returns, exactly what the extension itself holds.
let roots: ShadowRoot[] = [];
let shadowInits: ShadowRootInit[] = [];

function host(): HTMLElement {
  return document.querySelector('div[popover]') as HTMLElement;
}
function shadow(): ShadowRoot {
  return roots[0] as ShadowRoot;
}
function panel(): HTMLElement {
  return shadow().querySelector('[data-clavis="panel"]') as HTMLElement;
}
function button(
  action: 'listen' | 'explain' | 'trim' | 'close' | 'slow' | 'voice-settings',
): HTMLButtonElement {
  return shadow().querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;
}
function capture(text: string): CapturedSelection {
  selectText(text);
  return captureSelection() as CapturedSelection;
}
function create(): ToolbarHandle {
  toolbar = createToolbar(createPreactRenderer(), { actions: implementation });
  return toolbar;
}

beforeEach(() => {
  roots = [];
  shadowInits = [];
  const attachShadow = Element.prototype.attachShadow;
  vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (
    this: Element,
    init: ShadowRootInit,
  ) {
    shadowInits.push(init);
    const root = attachShadow.call(this, init);
    roots.push(root);
    return root;
  });
  // jsdom never creates trusted events; the untrusted-event tests below flip this off.
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  // jsdom has no hit testing: nothing covers the selection unless a test says so.
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation((key: string) => key);
  mockRangeRects([{ left: 300, top: 300, right: 360, bottom: 320, width: 60, height: 20 }]);
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    value: 800,
  });
  Object.defineProperty(document.documentElement, 'clientHeight', {
    configurable: true,
    value: 600,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, value: 100 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: 40 });
  setBody('<p>The old bank by the river and the old mill.</p><p id="outside">Elsewhere.</p>');
});

afterEach(() => {
  toolbar?.destroy();
  toolbar = undefined;
  calls.length = 0;
  signals.length = 0;
  outcome = () => undefined;
  clearSelection();
  vi.useRealTimers();
});

describe('toolbar shell', () => {
  it('renders Lookup, Speak and speed in order inside a CLOSED shadow root', () => {
    create().show(capture('bank'));
    expect(shadowInits).toEqual([{ mode: 'closed' }]);
    expect(host().shadowRoot).toBeNull();
    expect(button('listen').textContent).toBe('toolbarListen');
    expect(button('explain').textContent).toBe('toolbarExplain');
    expect(
      Array.from(shadow().querySelectorAll('[role="toolbar"] button'), (item) =>
        item.getAttribute('data-action'),
      ),
    ).toEqual(['explain', 'listen', 'slow']);
    expect(button('explain').querySelector('[data-icon="lookup"] path')).not.toBeNull();
    expect(button('listen').querySelector('[data-icon="speak"] path')).not.toBeNull();
    expect(button('slow').getAttribute('aria-label')).toBe('speechSpeedToggle');
    expect(button('slow').getAttribute('aria-pressed')).toBe('false');
    expect(panel().hidden).toBe(false);
    expect(panel().style.top).toBe('252px');
    expect(panel().style.left).toBe('280px');
    expect(shadow().querySelector('[role="toolbar"]')?.getAttribute('aria-label')).toBe(
      'toolbarGroupLabel',
    );
  });

  it('adds one plain host element with no custom tag name, and nothing readable to the page', () => {
    create().show(capture('bank'));
    const hosts = document.querySelectorAll('div[popover]');
    expect(hosts).toHaveLength(1);
    expect(hosts[0]?.tagName).toBe('DIV');
    expect(hosts[0]?.localName.includes('-')).toBe(false);
    expect(hosts[0]?.attributes).toHaveLength(2); // popover + style, no id/class/data-* to target
    expect(hosts[0]?.textContent).toBe('');
    expect(document.documentElement.textContent).not.toContain('toolbarListen');
    expect(isOwnUiNode(hosts[0] as Element)).toBe(true);
  });

  it('is hidden (display:none) while idle and shown while visible', () => {
    const handle = create();
    handle.show(capture('bank'));
    expect(host().getAttribute('style')).toContain('display:block');
    handle.hide();
    expect(host().getAttribute('style')).toContain('display:none');
  });

  describe('synthetic events from the page are ignored (security review HIGH-1)', () => {
    beforeEach(() => vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(false));

    it('a synthetic click on a button records no action and shows no card', () => {
      create().show(capture('bank'));
      button('explain').click();
      button('listen').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(calls).toHaveLength(0);
      expect(shadow().querySelector('[data-clavis="card"]')).toBeNull();
    });

    it('a synthetic Escape or outside pointerdown does not dismiss the toolbar', () => {
      create().show(capture('bank'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      document
        .getElementById('outside')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
      expect(panel().hidden).toBe(false);
    });

    it('a synthetic pointerdown cannot mark the toolbar as being interacted with', () => {
      const handle = create();
      handle.show(capture('bank'));
      button('listen').dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
      expect(handle.isInteracting()).toBe(false);
    });

    it('synthetic arrow keys do not move focus', () => {
      const handle = create();
      handle.show(capture('bank'));
      handle.focus();
      shadow().activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      expect(shadow().activeElement).toBe(button('explain'));
    });
  });

  it('dismisses on Escape', () => {
    create().show(capture('bank'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().hidden).toBe(true);
  });

  it('dismisses on a pointer press outside, but not inside', () => {
    create().show(capture('bank'));
    button('listen').dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(panel().hidden).toBe(false);
    document.getElementById('outside')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(panel().hidden).toBe(true);
  });

  it('records the CAPTURED snapshot when a button is clicked after the selection collapsed', () => {
    const captured = capture('bank');
    create().show(captured);
    clearSelection();
    button('explain').click();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ action: 'explain', context: { overLimit: false } });
    expect(calls[0]?.context.snapshot).toBe(captured.snapshot);
    expect(calls[0]?.context.snapshot.text).toBe('bank');
    const card = shadow().querySelector('[data-clavis="card"]');
    expect(card?.getAttribute('data-action')).toBe('explain');
    expect(card?.textContent).toContain('bank');
    expect(panel().hidden).toBe(false);
  });

  it('prevents default on button mousedown so the page selection and focus stay put', () => {
    create().show(capture('bank'));
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true });
    button('listen').dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('reports interaction while a pointer is pressed inside and shortly after', () => {
    const handle = create();
    handle.show(capture('bank'));
    expect(handle.isInteracting()).toBe(false);
    button('listen').dispatchEvent(new Event('pointerdown', { bubbles: true, composed: true }));
    expect(handle.isInteracting()).toBe(true);
    button('listen').dispatchEvent(new Event('pointerup', { bubbles: true, composed: true }));
    expect(handle.isInteracting()).toBe(true);
    vi.advanceTimersByTime(400);
    expect(handle.isInteracting()).toBe(false);
  });

  it('reports interaction while a toolbar button has keyboard focus', () => {
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    expect(shadow().activeElement).toBe(button('explain'));
    expect(handle.isInteracting()).toBe(true);
  });

  it('moves focus between buttons with the arrow keys, wrapping around', () => {
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    const press = (key: string): void => {
      shadow().activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };
    press('ArrowRight');
    expect(shadow().activeElement).toBe(button('listen'));
    press('ArrowRight');
    expect(shadow().activeElement).toBe(button('slow'));
    press('ArrowRight');
    expect(shadow().activeElement).toBe(button('explain'));
    press('End');
    expect(shadow().activeElement).toBe(button('slow'));
    press('Home');
    expect(shadow().activeElement).toBe(button('explain'));
  });

  it('shows the next selection with a clean card and a fresh snapshot', () => {
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    handle.hide();
    expect(panel().hidden).toBe(true);
    handle.show(capture('river'));
    expect(panel().hidden).toBe(false);
    expect(shadow().querySelector('[data-clavis="card"]')).toBeNull();
    button('listen').click();
    expect(calls.at(-1)?.context.snapshot.text).toBe('river');
  });

  it('hides itself when the selection scrolls out of the viewport', () => {
    const handle = create();
    handle.show(capture('bank'));
    mockRangeRects([{ left: 300, top: -300, right: 360, bottom: -280, width: 60, height: 20 }]);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    window.dispatchEvent(new Event('scroll'));
    expect(panel().style.visibility).toBe('hidden');
  });

  it('removes its listeners and host on destroy', () => {
    const handle = create();
    handle.show(capture('bank'));
    handle.destroy();
    expect(document.querySelector('div[popover]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
});

const LONG = Array.from({ length: 700 }, (_, i) => `word${i}`).join(' ');

function captureLong(): CapturedSelection {
  setBody(`<p>Before the long part. <span id="long">${LONG}</span> After it.</p>`);
  selectText(LONG);
  return captureSelection() as CapturedSelection;
}

const press = (key: string, init: KeyboardEventInit = {}): void => {
  const target = shadow().activeElement ?? document.body;
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, composed: true, ...init }),
  );
};

describe('over-limit selection (FR-016, requirements 4.2)', () => {
  it('shows "Selection too long" with ONE action and no Listen or Explain', () => {
    const captured = captureLong();
    expect(captured.overLimit).toBe(true);
    create().show(captured);
    expect(panel().getAttribute('data-mode')).toBe('too-long');
    expect(shadow().querySelector('[data-clavis="limit"]')?.textContent).toContain(
      'toolbarTooLong',
    );
    expect(button('trim').textContent).toBe('toolbarUseFirst');
    expect(shadow().querySelectorAll('button')).toHaveLength(1);
    expect(shadow().querySelector('[data-action="listen"]')).toBeNull();
  });

  it('announces the state in the polite live region after a beat', () => {
    create().show(captureLong());
    const live = (): string => shadow().querySelector('[data-clavis="live"]')?.textContent ?? '';
    expect(live()).toBe('');
    vi.advanceTimersByTime(100);
    expect(live()).toBe('toolbarTooLongLive');
  });

  it('trims on a word boundary, shows the text that will be used and the toolbar becomes Listen/Explain', () => {
    const captured = captureLong();
    create().show(captured);
    button('trim').click();

    expect(panel().getAttribute('data-mode')).toBe('actions');
    const shownText = shadow().querySelector('[data-clavis="trimmed-text"]')?.textContent ?? '';
    expect(shownText.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(shownText.length).toBeGreaterThan(LIMITS.maxSelectionChars * 0.8);
    expect(LONG.startsWith(shownText)).toBe(true);
    expect(LONG.charAt(shownText.length)).toBe(' ');
    expect(button('listen')).not.toBeNull();
    expect(button('explain')).not.toBeNull();

    expect(calls).toHaveLength(1);
    const { action, context } = calls[0] as (typeof calls)[number];
    expect(action).toBe('trim');
    expect(context.overLimit).toBe(false);
    expect(context.snapshot.text).toBe(shownText);
    // A new snapshot: a response to the long one can never be shown for it.
    expect(context.snapshot.selectionId).not.toBe(captured.snapshot.selectionId);
    expect(context.snapshot.contextBefore).toBe(captured.snapshot.contextBefore);
    expect(context.snapshot).not.toHaveProperty('contextAfter');
  });

  it('sends nothing by trimming: only the trim call reaches the action interface', () => {
    create().show(captureLong());
    button('trim').click();
    expect(calls.map((call) => call.action)).toEqual(['trim']);
  });

  it('Listen after trimming carries the trimmed snapshot, not the long one', () => {
    create().show(captureLong());
    button('trim').click();
    button('listen').click();
    const last = calls.at(-1);
    expect(last?.action).toBe('listen');
    expect(last?.context.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(last?.context.overLimit).toBe(false);
  });

  it('keeps keyboard focus on the toolbar when the trim button the user pressed disappears', () => {
    const handle = create();
    handle.show(captureLong());
    handle.focus();
    expect(shadow().activeElement).toBe(button('trim'));
    press('Enter');
    button('trim').click();
    expect(shadow().activeElement).toBe(button('explain'));
  });

  it('a new selection starts over: no trimmed preview from the previous one', () => {
    const handle = create();
    handle.show(captureLong());
    button('trim').click();
    handle.show(capture('Before'));
    expect(shadow().querySelector('[data-clavis="trimmed"]')).toBeNull();
    expect(panel().getAttribute('data-mode')).toBe('actions');
  });
});

describe('action interface', () => {
  it('shows a working state until a returned promise settles, then resets', async () => {
    let settle: () => void = () => undefined;
    outcome = () => new Promise<void>((resolve) => (settle = resolve));
    create().show(capture('bank'));
    button('explain').click();
    expect(button('explain').getAttribute('aria-disabled')).toBe('true');
    expect(button('explain').getAttribute('data-state')).toBe('working');
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe('toolbarWorking');

    // A second press on the working button does nothing.
    button('explain').click();
    expect(calls).toHaveLength(1);

    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(button('explain').getAttribute('aria-disabled')).toBeNull();
    expect(button('explain').getAttribute('data-state')).toBeNull();
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe(
      'toolbarCardPlaceholder',
    );
  });

  it('shows and announces an error when the action rejects, and the button works again', async () => {
    outcome = () => Promise.reject(new Error('nope'));
    create().show(capture('bank'));
    button('explain').click();
    await vi.advanceTimersByTimeAsync(200);
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe(
      'toolbarActionFailed',
    );
    expect(shadow().querySelector('[data-clavis="live"]')?.textContent).toBe('toolbarActionFailed');
    outcome = () => undefined;
    button('explain').click();
    expect(calls).toHaveLength(2);
  });

  it('treats a throwing action like a rejected one', async () => {
    outcome = () => {
      throw new Error('sync failure');
    };
    create().show(capture('bank'));
    button('explain').click();
    await vi.advanceTimersByTimeAsync(200);
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe(
      'toolbarActionFailed',
    );
  });

  it('ignores a late result after the toolbar moved on to another selection', async () => {
    let settle: () => void = () => undefined;
    outcome = () => new Promise<void>((resolve) => (settle = resolve));
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    handle.show(capture('river'));
    settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(shadow().querySelector('[data-clavis="card"]')).toBeNull();
    expect(button('explain').getAttribute('data-state')).toBeNull();
  });

  it('works with an interface that implements nothing', () => {
    toolbar = createToolbar(createPreactRenderer(), {});
    toolbar.show(capture('bank'));
    button('listen').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().hidden).toBe(true);
  });

  it.each([
    [
      'Escape',
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      'escape',
    ],
    [
      'a press outside',
      () =>
        document
          .getElementById('outside')!
          .dispatchEvent(new Event('pointerdown', { bubbles: true })),
      'outside',
    ],
  ] as const)(
    'reports dismissal with the snapshot and the reason: %s',
    (_name, trigger, reason) => {
      const captured = capture('bank');
      create().show(captured);
      trigger();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ action: 'dismiss', context: { reason } });
      expect(calls[0]?.context.snapshot).toBe(captured.snapshot);
    },
  );

  it('reports "cleared" when the controller hides it and "replaced" when a new selection takes over', () => {
    const handle = create();
    handle.show(capture('bank'));
    handle.show(capture('river'));
    handle.hide('cleared');
    handle.hide('cleared');
    expect(calls.map((call) => [call.action, (call.context as DismissContext).reason])).toEqual([
      ['dismiss', 'replaced'],
      ['dismiss', 'cleared'],
    ]);
  });

  it('does not report dismissal for re-showing the same selection', () => {
    const handle = create();
    const captured = capture('bank');
    handle.show(captured);
    handle.show(captured);
    expect(calls).toHaveLength(0);
  });
});

describe('cancellation and specific errors (ToolbarActions contract)', () => {
  const pending = (): ToolbarActionResult => new Promise<void>(() => undefined);

  it('aborts the signal when the same button supersedes its own run', () => {
    outcome = pending;
    create().show(capture('bank'));
    button('explain').click();
    expect(signals[0]?.aborted).toBe(false);
    // Explain pressed while its card works: the first request is superseded.
    outcome = pending;
    (calls.at(-1)?.context as RunContext).surface?.close();
    expect(signals[0]?.aborted).toBe(true);
  });

  it('Listen and Explain are independent: neither aborts the other (Phase 5 follow-up)', () => {
    outcome = pending;
    create().show(capture('bank'));
    button('explain').click();
    button('listen').click();
    expect(calls.map((call) => call.action)).toEqual(['explain', 'listen']);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('aborts the signal when the same button is pressed again after it settled with an error', async () => {
    outcome = () => Promise.reject(new Error('x'));
    create().show(capture('bank'));
    button('listen').click();
    await vi.advanceTimersByTimeAsync(0);
    button('listen').click();
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('aborts the signal when a different selection replaces the toolbar content', () => {
    outcome = pending;
    const handle = create();
    handle.show(capture('bank'));
    button('listen').click();
    handle.show(capture('river'));
    expect(signals[0]?.aborted).toBe(true);
  });

  it('aborts the signal on every kind of dismissal', () => {
    outcome = pending;
    const handle = create();
    const dismissals: Array<() => void> = [
      () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      () =>
        document
          .getElementById('outside')!
          .dispatchEvent(new Event('pointerdown', { bubbles: true })),
      () => handle.hide('cleared'),
      () => handle.destroy(),
    ];
    for (const dismiss of dismissals) {
      handle.show(capture('bank'));
      button('explain').click();
      const signal = signals.at(-1) as AbortSignal;
      expect(signal.aborted).toBe(false);
      dismiss();
      expect(signal.aborted).toBe(true);
    }
  });

  it('aborts the signal when the user trims instead', () => {
    outcome = pending;
    const handle = create();
    handle.show(captureLong());
    button('trim').click();
    button('listen').click();
    handle.show(captureLong());
    expect(signals[0]?.aborted).toBe(true);
  });

  it('ignores the outcome of an aborted run (no state change after it)', async () => {
    let settle: () => void = () => undefined;
    outcome = () => new Promise<void>((resolve) => (settle = resolve));
    create().show(capture('bank'));
    button('listen').click();
    const first = settle;
    outcome = pending;
    button('explain').click();
    first();
    await vi.advanceTimersByTimeAsync(0);
    expect(shadow().querySelector('[data-clavis="card"]')?.getAttribute('data-action')).toBe(
      'explain',
    );
    expect(button('explain').getAttribute('data-state')).toBe('working');
  });

  it('shows the specific message of an actionError, announced, instead of the generic line', async () => {
    outcome = () => Promise.reject(actionError('toolbarClose'));
    create().show(capture('bank'));
    button('explain').click();
    await vi.advanceTimersByTimeAsync(200);
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe('toolbarClose');
    expect(shadow().querySelector('[data-clavis="live"]')?.textContent).toBe('toolbarClose');
  });

  it('falls back to the generic line for an unknown or unusable message key', async () => {
    outcome = () => Promise.reject(Object.assign(new Error('x'), { messageKey: 42 }));
    create().show(capture('bank'));
    button('explain').click();
    await vi.advanceTimersByTimeAsync(200);
    expect(shadow().querySelector('[data-clavis="card-note"]')?.textContent).toBe(
      'toolbarActionFailed',
    );
  });
});

describe('destroy leaves nothing behind (content script cleanup)', () => {
  it('removes the host and every document/window listener it added, and cancels timers', () => {
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
    outcome = () => new Promise<void>(() => undefined);
    const long = captureLong();
    const baseline = vi.getTimerCount();
    const handle = create();
    handle.show(long);
    button('trim').click();
    button('explain').click();
    handle.destroy();
    toolbar = undefined;

    expect(document.querySelector('div[popover]')).toBeNull();
    expect(added.length).toBeGreaterThan(0);
    for (const entry of added) expect(removed, String(entry[0])).toContainEqual(entry);
    expect(vi.getTimerCount()).toBe(baseline);
  });
});

describe('notice', () => {
  it('shows a message with a Close button at the top of the viewport, and announces it', () => {
    const handle = create();
    handle.showNotice('No access to this frame');
    expect(panel().getAttribute('data-mode')).toBe('notice');
    expect(shadow().querySelector('[data-clavis="notice"]')?.textContent).toContain(
      'No access to this frame',
    );
    expect(panel().style.top).toBe('12px');
    expect(panel().style.left).toBe('350px');
    vi.advanceTimersByTime(100);
    expect(shadow().querySelector('[data-clavis="live"]')?.textContent).toBe(
      'No access to this frame',
    );
    button('close').click();
    expect(panel().hidden).toBe(true);
  });

  it('closes with Escape and reports nothing (it was not about a selection)', () => {
    create().showNotice('Hello');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel().hidden).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('explain() (context menu and popup button, FR-018)', () => {
  it('runs the Explain action for the shown selection without any click, and keeps focus where it was', () => {
    calls.length = 0;
    const handle = create();
    handle.show(capture('bank'));
    handle.explain?.();
    expect(calls.map((c) => c.action)).toEqual(['explain']);
    expect((calls[0]?.context as ActionContext).snapshot.text).toBe('bank');
    expect(shadow().activeElement).toBeNull();
  });

  it('does nothing without a selection or for a selection over the limit', () => {
    calls.length = 0;
    const handle = create();
    handle.explain?.();
    handle.show({ ...capture('bank'), overLimit: true });
    handle.explain?.();
    expect(calls).toHaveLength(0);
  });
});

describe('keyboard and focus (FR-016)', () => {
  it('focus() moves into the toolbar and Escape gives focus back to the element that had it', () => {
    setBody('<p>The old bank by the river.</p><a id="link" href="#x">link</a>');
    const link = document.getElementById('link') as HTMLElement;
    link.focus();
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    expect(shadow().activeElement).toBe(button('explain'));
    press('Escape');
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(link);
  });

  it('Escape with nothing focused before drops the focus instead of leaving it on a hidden button', () => {
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    press('Escape');
    expect(shadow().activeElement).toBeNull();
    expect(handle.isInteracting()).toBe(false);
  });

  it('Tab gives focus back so the browser continues from where the user was', () => {
    setBody('<p>The old bank by the river.</p><a id="link" href="#x">link</a>');
    const link = document.getElementById('link') as HTMLElement;
    link.focus();
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    press('Tab');
    expect(document.activeElement).toBe(link);
    expect(panel().hidden).toBe(false);
  });

  it('focus() lands on the first action in every mode (Lookup, or the one trim action)', () => {
    const handle = create();
    handle.show(captureLong());
    handle.focus();
    expect(shadow().activeElement).toBe(button('trim'));
  });

  it('reverses the arrow keys for right-to-left selections', () => {
    setBody('<p dir="rtl">The old bank by the river.</p>');
    const handle = create();
    handle.show(capture('bank'));
    handle.focus();
    press('ArrowLeft');
    expect(shadow().activeElement).toBe(button('listen'));
    press('ArrowRight');
    expect(shadow().activeElement).toBe(button('explain'));
  });

  it('every button is a native button with a visible name', () => {
    create().show(capture('bank'));
    for (const node of Array.from(shadow().querySelectorAll('button'))) {
      expect(node.type).toBe('button');
      expect((node.textContent ?? '').trim()).not.toBe('');
    }
  });
});

describe('modal dialogs', () => {
  it('mounts the host inside the open modal dialog that contains the selection, and moves it back out', () => {
    setBody(
      '<p id="page">The old bank.</p><dialog open><p id="inside">Dialog river text.</p></dialog>',
    );
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ':modal' ? this.localName === 'dialog' : matches.call(this, selector);
    });
    const dialog = document.querySelector('dialog') as HTMLElement;
    const handle = create();

    handle.show(capture('river'));
    expect(host().parentElement).toBe(dialog);
    expect(host().getAttribute('style')).toContain('display:block');

    handle.show(capture('bank'));
    expect(host().parentElement).toBe(document.documentElement);
  });

  it('Escape closes only the toolbar first when it sits inside a modal dialog', () => {
    setBody('<dialog open><p id="inside">Dialog river text.</p></dialog>');
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
      this: Element,
      selector: string,
    ) {
      return selector === ':modal' ? this.localName === 'dialog' : matches.call(this, selector);
    });
    create().show(capture('river'));
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(panel().hidden).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves Escape alone outside a dialog', () => {
    create().show(capture('bank'));
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('page elements on top of the selection', () => {
  it('hides the toolbar when a fixed header covers the whole selection', () => {
    const header = document.createElement('header');
    header.style.position = 'fixed';
    document.body.append(header);
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => header,
    });
    create().show(capture('bank'));
    expect(panel().style.visibility).toBe('hidden');
  });

  it('is not fooled by a fixed element that CONTAINS the selection (a selection inside a fixed sidebar)', () => {
    setBody('<aside style="position:fixed"><p>The old bank by the river.</p></aside>');
    const aside = document.querySelector('aside') as HTMLElement;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => aside });
    create().show(capture('bank'));
    expect(panel().style.visibility).toBe('');
  });
});

describe('pinch zoom (visual viewport)', () => {
  function stubVisualViewport(box: {
    offsetLeft: number;
    offsetTop: number;
    width: number;
    height: number;
    scale: number;
  }): EventTarget {
    const target = Object.assign(new EventTarget(), box);
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: target });
    return target;
  }
  afterEach(() => {
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: undefined });
  });

  it('places the toolbar inside the visible area, not the layout viewport', () => {
    // Selection at (300, 300); the visible area starts at (250, 280): above would be 252, off-screen.
    stubVisualViewport({ offsetLeft: 250, offsetTop: 280, width: 400, height: 300, scale: 2 });
    create().show(capture('bank'));
    expect(panel().style.top).toBe('328px'); // below the line (320 + 8)
    expect(Number.parseFloat(panel().style.left)).toBeGreaterThanOrEqual(258);
  });

  it('ignores the visual viewport while the page is not zoomed', () => {
    stubVisualViewport({ offsetLeft: 0, offsetTop: 0, width: 790, height: 590, scale: 1 });
    create().show(capture('bank'));
    expect(panel().style.top).toBe('252px');
  });

  it('repositions when the visual viewport scrolls or resizes, and stops listening when hidden', () => {
    const visual = stubVisualViewport({
      offsetLeft: 0,
      offsetTop: 0,
      width: 800,
      height: 600,
      scale: 2,
    });
    const handle = create();
    handle.show(capture('bank'));
    const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    visual.dispatchEvent(new Event('scroll'));
    visual.dispatchEvent(new Event('resize'));
    expect(frames).toHaveBeenCalled();
    handle.hide();
    frames.mockClear();
    visual.dispatchEvent(new Event('scroll'));
    expect(frames).not.toHaveBeenCalled();
  });
});

describe('placement coordinates', () => {
  it('converts viewport pixels back to the host pixels when <html> is zoomed or scaled', () => {
    // Layout size 100x40 (mocked offsetWidth/Height), but the box measures 200x80: a 2x zoom.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 80,
    } as DOMRect);
    create().show(capture('bank'));
    // Above the selection (top 300, centre x 330) for a 200x80 box: left 230, top 212 viewport px.
    expect(panel().style.top).toBe('106px');
    expect(panel().style.left).toBe('115px');
  });

  it('snaps to device pixels of the zoomed host: ratio times scale', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 150,
      height: 60,
    } as DOMRect); // layout 100x40: scale 1.5
    try {
      mockRangeRects([{ left: 300, top: 300, right: 360, bottom: 320, width: 60, height: 20 }]);
      create().show(capture('bank'));
      // Viewport top 300 - 60 - 8 = 232, host px 154.666..., snapped to 1/(2*1.5) = 1/3 px.
      const top = Number.parseFloat(panel().style.top);
      expect((top * 3) % 1).toBeCloseTo(0, 5);
      expect(top).toBeCloseTo(232 / 1.5, 0);
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    }
  });

  it('rounds to whole device pixels', () => {
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
    try {
      mockRangeRects([
        { left: 300.3, top: 300.3, right: 360.3, bottom: 320.3, width: 60, height: 20 },
      ]);
      create().show(capture('bank'));
      expect(panel().style.top).toBe('252.5px');
    } finally {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
    }
  });
});

describe('card surface (the separately loaded explanation card, Phase 5)', () => {
  const slot = (): HTMLElement | null => shadow().querySelector('[data-clavis="card-slot"]');
  const surfaceOf = (index = 0) => (calls[index]?.context as RunContext).surface;

  it('lends every run a surface; keyboard is false for a mouse press and true from a focused button', () => {
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    expect(surfaceOf(0)?.keyboard).toBe(false);
    button('explain').focus();
    button('explain').click();
    expect(surfaceOf(1)?.keyboard).toBe(true);
  });

  it('open() swaps the state line for an empty slot and returns the same element every time', () => {
    outcome = () => new Promise<void>(() => undefined);
    create().show(capture('bank'));
    button('explain').click();
    expect(shadow().querySelector('[data-clavis="card"]')).not.toBeNull();
    expect(slot()).toBeNull();
    const first = surfaceOf()?.open() as HTMLElement;
    expect(first.getAttribute('data-clavis')).toBe('card-slot');
    expect(first.childElementCount).toBe(0);
    expect(shadow().querySelector('[data-clavis="card"]')).toBeNull();
    expect(panel().getAttribute('data-card')).toBe('explain');
    expect(surfaceOf()?.open()).toBe(first);
  });

  it('keeps the card (and whatever was drawn in the slot) through toolbar re-renders and after the action settles', async () => {
    let settle: () => void = () => undefined;
    outcome = () => new Promise<void>((resolve) => (settle = resolve));
    create().show(capture('bank'));
    button('explain').click();
    const element = surfaceOf()?.open() as HTMLElement;
    const drawn = document.createElement('p');
    drawn.textContent = 'drawn by the card';
    element.append(drawn);
    // The toolbar's own announcement re-renders its tree.
    await vi.advanceTimersByTimeAsync(200);
    expect(slot()).toBe(element);
    expect(slot()?.contains(drawn)).toBe(true);
    settle();
    await vi.advanceTimersByTimeAsync(200);
    expect(slot()).toBe(element);
    expect(slot()?.contains(drawn)).toBe(true);
    expect(shadow().querySelector('[data-clavis="card"]')).toBeNull();
    // The button is usable again.
    expect(button('explain').getAttribute('aria-disabled')).toBeNull();
  });

  it('a rejected action does not wipe a card it already opened', async () => {
    let fail: (error: unknown) => void = () => undefined;
    outcome = () => new Promise<void>((_resolve, reject) => (fail = reject));
    create().show(capture('bank'));
    button('explain').click();
    const element = surfaceOf()?.open() as HTMLElement;
    fail(new Error('late'));
    await vi.advanceTimersByTimeAsync(200);
    expect(slot()).toBe(element);
  });

  it('pressing Explain again aborts the old run, which can no longer open the surface', async () => {
    outcome = () => Promise.resolve();
    create().show(capture('bank'));
    button('explain').click();
    const old = surfaceOf(0);
    old?.open();
    await vi.advanceTimersByTimeAsync(0);
    button('explain').click();
    expect(signals[0]?.aborted).toBe(true);
    expect(old?.open()).toBeNull();
    // The new run starts from the state line again until it opens its own slot.
    expect(slot()).toBeNull();
    expect(surfaceOf(1)?.open()).not.toBeNull();
  });

  it('close() removes the card, aborts the run, keeps the toolbar and returns keyboard focus to Explain', () => {
    outcome = () => new Promise<void>(() => undefined);
    const handle = create();
    handle.show(capture('bank'));
    button('explain').focus();
    button('explain').click();
    const element = surfaceOf()?.open() as HTMLElement;
    const inside = document.createElement('button');
    element.append(inside);
    inside.focus();
    expect(shadow().activeElement).toBe(inside);
    surfaceOf()?.close();
    expect(slot()).toBeNull();
    expect(signals[0]?.aborted).toBe(true);
    expect(panel().hidden).toBe(false);
    expect(button('explain').getAttribute('aria-disabled')).toBeNull();
    expect(shadow().activeElement).toBe(button('explain'));
  });

  it('close() with the mouse does not move focus', () => {
    outcome = () => new Promise<void>(() => undefined);
    create().show(capture('bank'));
    button('explain').click();
    surfaceOf()?.open();
    surfaceOf()?.close();
    expect(shadow().activeElement).toBeNull();
  });

  it('Escape closes the toolbar with the card in it and reports the dismissal of the selection', () => {
    outcome = () => new Promise<void>(() => undefined);
    create().show(capture('bank'));
    button('explain').click();
    surfaceOf()?.open();
    press('Escape');
    expect(panel().hidden).toBe(true);
    expect(signals[0]?.aborted).toBe(true);
    expect(calls.at(-1)).toMatchObject({ action: 'dismiss', context: { reason: 'escape' } });
  });

  it('retains interaction for selected card output after pointer grace expires', () => {
    outcome = () => new Promise<void>(() => undefined);
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    const element = surfaceOf()?.open() as HTMLElement;
    const leaf = document.createElement('p');
    leaf.textContent = 'riverbank';
    element.append(leaf);
    const selected = document.createRange();
    selected.selectNodeContents(leaf);
    vi.spyOn(document, 'getSelection').mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => selected,
      getComposedRanges: () => [selected],
    } as unknown as Selection);
    vi.advanceTimersByTime(1_000);
    expect(handle.isInteracting()).toBe(true);
    selected.collapse(true);
    expect(handle.isInteracting()).toBe(false);
    handle.hide();
    expect(handle.isInteracting()).toBe(false);
  });

  it('speaks translated output through Listen with target language and without page context', () => {
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    const surface = surfaceOf()!;
    surface.open();
    const reports: unknown[] = [];
    const stop = surface.speak!('banque', 'fr', (report) => reports.push(report));
    const spoken = calls.at(-1)!.context as RunContext;
    expect(calls.at(-1)!.action).toBe('listen');
    expect(spoken.snapshot.text).toBe('banque');
    expect(spoken.snapshot).not.toHaveProperty('contextBefore');
    expect(spoken.listen).toMatchObject({ lang: 'fr', slow: undefined });
    spoken.listen!.report({ status: 'playing', slow: false, remote: false });
    expect(reports).toContainEqual({ status: 'playing', slow: false, remote: false });
    expect(surface.speakerIcon!()?.getAttribute('data-icon')).toBe('speak');
    stop();
    expect(spoken.signal.aborted).toBe(true);
    expect(reports.at(-1)).toEqual({ status: 'idle' });
  });

  it('a new selection discards the card', () => {
    outcome = () => new Promise<void>(() => undefined);
    const handle = create();
    handle.show(capture('bank'));
    button('explain').click();
    surfaceOf()?.open();
    handle.show(capture('river'));
    expect(slot()).toBeNull();
    expect(surfaceOf()?.open()).toBeNull();
  });

  it('reposition() schedules a placement; it does nothing once the run is over', () => {
    outcome = () => new Promise<void>(() => undefined);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    create().show(capture('bank'));
    button('explain').click();
    const surface = surfaceOf();
    raf.mockClear();
    surface?.reposition();
    expect(raf).toHaveBeenCalledTimes(1);
    surface?.close();
    raf.mockClear();
    surface?.reposition();
    expect(raf).not.toHaveBeenCalled();
  });

  describe('keyboard handling is left to the card', () => {
    function openWithControls(): { first: HTMLButtonElement; second: HTMLButtonElement } {
      outcome = () => new Promise<void>(() => undefined);
      setBody('<p>The old bank by the river.</p><a id="link" href="#x">link</a>');
      const link = document.getElementById('link') as HTMLElement;
      link.focus();
      const handle = create();
      handle.show(capture('bank'));
      handle.focus();
      button('explain').click();
      const element = surfaceOf()?.open() as HTMLElement;
      const first = document.createElement('button');
      const second = document.createElement('button');
      element.append(first, second);
      first.focus();
      return { first, second };
    }

    it('Tab inside the card is not turned into "leave the toolbar"', () => {
      const { first } = openWithControls();
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        composed: true,
        cancelable: true,
      });
      first.dispatchEvent(event);
      expect(shadow().activeElement).toBe(first);
    });

    it('arrow keys inside the card do not move focus along the toolbar buttons', () => {
      const { first } = openWithControls();
      first.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, composed: true }),
      );
      expect(shadow().activeElement).toBe(first);
    });

    it('the toolbar arrow group excludes card controls', () => {
      openWithControls();
      button('explain').focus();
      press('ArrowRight');
      expect(shadow().activeElement).toBe(button('listen'));
      press('End');
      expect(shadow().activeElement).toBe(button('slow'));
    });
  });
});
