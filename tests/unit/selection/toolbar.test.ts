// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { createPreactRenderer } from '../../../components/tooltip/preact-renderer';
import { createToolbar } from '../../../components/tooltip/toolbar';
import * as trust from '../../../lib/selection/trust';
import { isOwnUiNode } from '../../../lib/selection/own-ui';
import { captureSelection, type CapturedSelection } from '../../../lib/selection/capture';
import type { ToolbarAction, ToolbarHandle } from '../../../lib/selection/ui-api';
import { clearSelection, mockRangeRects, selectText, setBody } from './dom';

let toolbar: ToolbarHandle | undefined;
const actions: ToolbarAction[] = [];

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
function button(action: 'listen' | 'explain'): HTMLButtonElement {
  return shadow().querySelector(`button[data-action="${action}"]`) as HTMLButtonElement;
}
function capture(text: string): CapturedSelection {
  selectText(text);
  return captureSelection() as CapturedSelection;
}
function create(): ToolbarHandle {
  toolbar = createToolbar(createPreactRenderer(), { onAction: (event) => actions.push(event) });
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
  actions.length = 0;
  clearSelection();
  vi.useRealTimers();
});

describe('toolbar shell', () => {
  it('renders Listen and Explain inside a CLOSED shadow root, above the selection', () => {
    create().show(capture('bank'));
    expect(shadowInits).toEqual([{ mode: 'closed' }]);
    expect(host().shadowRoot).toBeNull();
    expect(button('listen').textContent).toBe('toolbarListen');
    expect(button('explain').textContent).toBe('toolbarExplain');
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
      expect(actions).toHaveLength(0);
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
      expect(shadow().activeElement).toBe(button('listen'));
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
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ action: 'explain', overLimit: false });
    expect(actions[0]?.snapshot).toBe(captured.snapshot);
    expect(actions[0]?.snapshot.text).toBe('bank');
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
    expect(shadow().activeElement).toBe(button('listen'));
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
    expect(shadow().activeElement).toBe(button('explain'));
    press('ArrowRight');
    expect(shadow().activeElement).toBe(button('listen'));
    press('End');
    expect(shadow().activeElement).toBe(button('explain'));
    press('Home');
    expect(shadow().activeElement).toBe(button('listen'));
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
    expect(actions.at(-1)?.snapshot.text).toBe('river');
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
