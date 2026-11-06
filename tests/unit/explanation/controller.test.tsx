// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExplainCard } from '../../../components/explanation/card';
import * as trust from '../../../lib/selection/trust';
import * as contained from '../../../lib/selection/contained-range';
import type { CardSurface, ExplainCardApi, RunContext } from '../../../lib/selection/ui-api';
import { createFakeBackend, flush, installCatalog, makeSnapshot } from './support';

let ids = 0;
let host: HTMLElement;
let shadow: ShadowRoot;

interface Run {
  context: RunContext;
  abort(): void;
  slot: HTMLElement;
  surface: CardSurface & { closed: number; repositioned: number };
}

function run(
  snapshot = makeSnapshot('word'),
  options: { keyboard?: boolean; keepRoot?: boolean } = {},
): Run {
  const controller = new AbortController();
  const slot = document.createElement('section');
  if (options.keepRoot === true) shadow.append(slot);
  else shadow.replaceChildren(slot);
  const surface = {
    keyboard: options.keyboard ?? false,
    closed: 0,
    repositioned: 0,
    open: () => (controller.signal.aborted ? null : slot),
    reposition() {
      surface.repositioned += 1;
    },
    close() {
      surface.closed += 1;
      controller.abort();
    },
  };
  return {
    context: { snapshot, overLimit: false, signal: controller.signal, surface },
    abort: () => controller.abort(),
    slot,
    surface,
  };
}

function setup(overrides: Parameters<typeof createExplainCard>[0] = {}) {
  const fake = createFakeBackend();
  const card = createExplainCard({
    backend: fake.backend,
    newId: () => `id-${(ids += 1)}`,
    now: () => Date.now(),
    copy: () => Promise.resolve(true),
    features: { grammarTab: false, translateTab: false },
    ...overrides,
  });
  return { fake, card };
}

async function present(card: ExplainCardApi, r: Run): Promise<void> {
  await act(async () => {
    await card.present(r.context);
  });
}

async function selectGenerated(slot: HTMLElement, text: string): Promise<void> {
  const leaf = Array.from(
    slot.querySelectorAll<HTMLElement>('[data-clavis="card-result-text"]'),
  ).find((element) => element.textContent?.includes(text));
  if (leaf?.firstChild === null || leaf === undefined)
    throw new Error(`No generated leaf containing ${text}`);
  const offset = leaf.textContent!.indexOf(text);
  const range = document.createRange();
  range.setStart(leaf.firstChild, offset);
  range.setEnd(leaf.firstChild, offset + text.length);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  // jsdom does not expose a selection inside a shadow root; the browser helper has its own tests.
  vi.spyOn(contained, 'selectionWithin').mockReturnValue(range);
  await act(() => {
    leaf.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
}

async function clickLookup(slot: HTMLElement): Promise<void> {
  await act(() => {
    (slot.querySelector('[data-clavis="card-lookup"]') as HTMLElement).click();
  });
}

beforeEach(() => {
  installCatalog();
  ids = 0;
  vi.spyOn(trust, 'isTrustedEvent').mockReturnValue(true);
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.append(host);
  shadow = host.attachShadow({ mode: 'open' });
});

afterEach(() => {
  host.remove();
  vi.useRealTimers();
});

describe('present', () => {
  it('needs a surface to draw on', async () => {
    const { card } = setup();
    const r = run();
    delete r.context.surface;
    await expect(card.present(r.context)).rejects.toThrow('surface');
  });

  it('draws the card in the slot and sends one core request, nothing else', async () => {
    const { card, fake } = setup();
    const r = run(makeSnapshot('word', 'bank'));
    await present(card, r);
    expect(r.slot.querySelector('[data-clavis="card"]')).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.request.mode).toBe('core');
    expect(fake.calls[0]?.request.snapshot.text).toBe('bank');
    expect(fake.settings).toEqual([]);
  });

  it('does nothing for a run that is already aborted', async () => {
    const { card, fake } = setup();
    const r = run();
    r.abort();
    await present(card, r);
    expect(fake.calls).toHaveLength(0);
    expect(r.slot.childElementCount).toBe(0);
  });

  it('adds its own stylesheet to the root the slot lives in, once', async () => {
    const { card } = setup();
    const first = run();
    await present(card, first);
    // jsdom has no constructable stylesheets: the fallback <style> is what is counted here; the
    // real adoptedStyleSheets path runs in the browser E2E.
    const styles = (): number =>
      shadow.querySelectorAll('style').length + (shadow.adoptedStyleSheets?.length ?? 0);
    expect(styles()).toBe(1);
    const second = run(first.context.snapshot, { keepRoot: true });
    await present(card, second);
    expect(styles()).toBe(1);
  });

  it('a card shows its answer, and the toolbar is asked to reposition', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    expect(r.slot.textContent).toContain('bank (noun)');
    expect(r.surface.repositioned).toBeGreaterThan(0);
  });

  it('Close goes through the toolbar surface and ends the run', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await act(async () => {
      (r.slot.querySelector('[data-clavis="card-close"]') as HTMLElement).click();
      await flush();
    });
    expect(r.surface.closed).toBe(1);
    expect(r.slot.childElementCount).toBe(0);
  });
});

describe('abort, replace, dismiss', () => {
  it('aborting the run removes the card and sends AI_CANCEL for the request in flight', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      r.abort();
      await flush();
    });
    // The card is gone at once; the request is cancelled one tick later (see the next tests).
    expect(r.slot.childElementCount).toBe(0);
    expect(fake.cancelled).toEqual([]);
    await act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(fake.cancelled).toEqual([fake.calls[0]?.request.requestId]);
  });

  it('a late answer after the abort is not shown anywhere', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    r.abort();
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    expect(r.slot.textContent).toBe('');
  });

  it('pressing Explain again on the same selection re-shows the finished card with no new request', async () => {
    const { card, fake } = setup();
    const snapshot = makeSnapshot('word');
    const first = run(snapshot);
    await present(card, first);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    first.abort();
    const second = run(snapshot);
    await present(card, second);
    expect(fake.calls).toHaveLength(1);
    expect(second.slot.textContent).toContain('bank (noun)');
  });

  it('pressing Explain again while the first is still loading keeps that request: no cancel, no second send', async () => {
    const { card, fake } = setup();
    const snapshot = makeSnapshot('word');
    const first = run(snapshot);
    await present(card, first);
    first.abort();
    const second = run(snapshot);
    await present(card, second);
    await act(() => {
      vi.advanceTimersByTime(10);
    });
    expect(fake.cancelled).toEqual([]);
    expect(fake.calls).toHaveLength(1);
    expect(second.slot.querySelector('[data-clavis="card-loading"]')).not.toBeNull();
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    expect(second.slot.textContent).toContain('bank (noun)');
    expect(fake.calls).toHaveLength(1);
  });

  it('closing the card (not replacing it) still cancels the request, one tick later', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    r.abort();
    await act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fake.cancelled).toEqual([fake.calls[0]?.request.requestId]);
    // Opened again later: a fresh request.
    const again = run(r.context.snapshot);
    await present(card, again);
    expect(fake.calls).toHaveLength(2);
  });

  it('a different selection discards the old cache and cancels its pending request', async () => {
    const { card, fake } = setup();
    const a = run(makeSnapshot('word', 'bank'));
    await present(card, a);
    const b = run(makeSnapshot('word', 'river'));
    await present(card, b);
    expect(fake.cancelled).toEqual([fake.calls[0]?.request.requestId]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.request.snapshot.text).toBe('river');
    // Going back to the first selection starts over: the cache is gone.
    const again = run(a.context.snapshot);
    await present(card, again);
    expect(fake.calls).toHaveLength(3);
  });

  it('dismiss(selectionId) drops the card and its cache; another id is ignored', async () => {
    const { card, fake } = setup();
    const snapshot = makeSnapshot('word');
    const r = run(snapshot);
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    card.dismiss('someone-else');
    expect(r.slot.childElementCount).toBeGreaterThan(0);
    await act(async () => {
      card.dismiss(snapshot.selectionId);
      await flush();
    });
    expect(r.slot.childElementCount).toBe(0);
    // Same selection after a dismissal asks again: nothing survives it.
    const next = run(snapshot);
    await present(card, next);
    expect(fake.calls).toHaveLength(2);
  });

  it('dismiss() without an id (after a trim) drops whatever is open', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      card.dismiss();
      await flush();
    });
    expect(r.slot.childElementCount).toBe(0);
    expect(fake.cancelled).toHaveLength(1);
  });

  it('destroy removes everything and cancels', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      card.destroy();
      await flush();
    });
    expect(r.slot.childElementCount).toBe(0);
    expect(fake.cancelled).toHaveLength(1);
  });
});

describe('the host handed to the card', () => {
  it('passes the keyboard flag so focus moves in only for keyboard runs', async () => {
    const { card } = setup();
    const r = run(makeSnapshot('word'), { keyboard: true });
    await present(card, r);
    await act(async () => {
      vi.advanceTimersByTime(50);
      await flush();
    });
    expect(shadow.activeElement).toBe(r.slot.querySelector('[data-clavis="card"]'));
  });

  it('Connect Groq goes through OPEN_SETTINGS with the key section', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.reply({ kind: 'error', code: 'SETUP_REQUIRED' });
      await flush();
    });
    await act(async () => {
      (r.slot.querySelector('[data-clavis="card-settings"]') as HTMLElement).click();
      await flush();
    });
    expect(fake.settings).toEqual(['key']);
  });

  it('Copy uses the copy dependency with the document of the slot', async () => {
    const copy = vi.fn().mockResolvedValue(true);
    const { card, fake } = setup({ copy });
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await act(async () => {
      (r.slot.querySelector('[data-clavis="card-copy"]') as HTMLElement).click();
      await flush();
    });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy.mock.calls[0]?.[0]).toBe(document);
    expect(copy.mock.calls[0]?.[1]).toContain('bank (noun)');
    expect(copy.mock.calls[0]).toHaveLength(2);
  });
});

describe('Translate language (feature flag)', () => {
  it('looks the language up only when the Translate tab is enabled', async () => {
    const off = setup();
    const spyOff = vi.spyOn(off.fake.backend, 'translationLanguage');
    await present(off.card, run());
    expect(spyOff).not.toHaveBeenCalled();

    const on = setup({ features: { grammarTab: false, translateTab: true } });
    on.fake.state.language = 'fr';
    await present(on.card, run(makeSnapshot('sentence', 'Hello there.')));
    await act(async () => {
      on.fake.calls[0]?.succeed();
      await flush();
    });
    await act(async () => {
      (
        shadow.querySelector('[data-clavis="card-tab"][data-tab="translate"]') as HTMLElement
      ).click();
      await flush();
    });
    expect(on.fake.calls[1]?.request).toMatchObject({ mode: 'translate', targetLanguage: 'fr' });
  });
});

describe('production flags (Translate on, Grammar off)', () => {
  it('draws the Translate tab, never Grammar, with the language looked up once and one request per open', async () => {
    const fake = createFakeBackend();
    fake.state.language = 'de';
    const spy = vi.spyOn(fake.backend, 'translationLanguage');
    // No `features` override: the card uses FEATURES from lib/config/constants.
    const card = createExplainCard({
      backend: fake.backend,
      newId: () => `id-${(ids += 1)}`,
      now: () => Date.now(),
      copy: () => Promise.resolve(true),
    });
    const r = run(makeSnapshot('sentence', 'Hello there.'));
    await present(card, r);
    expect(spy).toHaveBeenCalledTimes(1);
    const tabs = Array.from(r.slot.querySelectorAll('[data-clavis="card-tab"]')).map(
      (el) => (el as HTMLElement).dataset['tab'],
    );
    expect(tabs).toEqual(['core', 'simplify', 'translate']);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    const click = async (mode: string): Promise<void> => {
      await act(async () => {
        (
          r.slot.querySelector(`[data-clavis="card-tab"][data-tab="${mode}"]`) as HTMLElement
        ).click();
        await flush();
      });
    };
    await click('translate');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.request).toMatchObject({ mode: 'translate', targetLanguage: 'de' });
    await act(async () => {
      fake.calls[1]?.succeed({ translation: { language: 'German', text: 'Hallo.' } });
      await flush();
    });
    await click('core');
    await click('translate');
    expect(fake.calls).toHaveLength(2);
  });
});

describe('recursive generated-text lookup', () => {
  it('opens repeated layers in one card and Back restores each cached answer without a request', async () => {
    const { card, fake } = setup();
    const snapshot = makeSnapshot('word', 'bank', { source: 'pdf', page: 4, languageHint: 'en' });
    const r = run(snapshot);
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await selectGenerated(r.slot, 'ground');
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')?.textContent).toContain('ground');
    await clickLookup(r.slot);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.request.snapshot).toMatchObject({
      source: 'pdf',
      text: 'ground',
      kind: 'word',
    });
    expect(fake.calls[1]?.request.snapshot).not.toHaveProperty('page');
    expect(fake.calls[1]?.request.snapshot).not.toHaveProperty('languageHint');
    expect(fake.calls[1]?.request.snapshot.contextBefore).toContain('Sloping');
    await act(async () => {
      fake.calls[1]?.succeed();
      await flush();
    });
    await selectGenerated(r.slot, 'riverside');
    await clickLookup(r.slot);
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.request.snapshot.text).toBe('riverside');
    await act(async () => {
      fake.calls[2]?.succeed();
      await flush();
    });
    expect(r.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('riverside');
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-back"]') as HTMLElement).click();
    });
    expect(r.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('ground');
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-back"]') as HTMLElement).click();
    });
    expect(r.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('bank');
    expect(r.slot.querySelector('[data-clavis="card-back"]')).toBeNull();
    expect(fake.calls).toHaveLength(3);
  });

  it('cancels only the active child on Back; a late child reply cannot replace the parent', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await selectGenerated(r.slot, 'ground');
    await clickLookup(r.slot);
    expect(fake.calls).toHaveLength(2);
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-back"]') as HTMLElement).click();
    });
    expect(fake.cancelled).toContain(fake.calls[1]?.request.requestId);
    expect(fake.cancelled).not.toContain(fake.calls[0]?.request.requestId);
    await act(async () => {
      fake.calls[1]?.succeed({ title: 'Late child' });
      await flush();
    });
    expect(r.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('bank');
    expect(r.slot.textContent).not.toContain('Late child');
  });

  it('ignores a late reply from a detached ancestor tab while a child is active', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await act(() => {
      (
        r.slot.querySelector('[data-clavis="card-tab"][data-tab="etymology"]') as HTMLElement
      ).click();
    });
    expect(fake.calls).toHaveLength(2);
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-tab"][data-tab="core"]') as HTMLElement).click();
    });
    await selectGenerated(r.slot, 'ground');
    await clickLookup(r.slot);
    expect(fake.cancelled).toContain(fake.calls[1]?.request.requestId);
    await act(async () => {
      fake.calls[1]?.succeed({ title: 'Stale roots' });
      await flush();
    });
    await act(async () => {
      fake.calls[2]?.succeed();
      await flush();
    });
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-back"]') as HTMLElement).click();
    });
    expect(r.slot.textContent).not.toContain('Stale roots');
    await act(() => {
      (
        r.slot.querySelector('[data-clavis="card-tab"][data-tab="etymology"]') as HTMLElement
      ).click();
    });
    expect(fake.calls).toHaveLength(4);
  });

  it('requires trusted selection and click, and excludes labels and other card UI', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    vi.mocked(trust.isTrustedEvent).mockReturnValue(false);
    await selectGenerated(r.slot, 'ground');
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
    vi.mocked(trust.isTrustedEvent).mockReturnValue(true);
    await selectGenerated(r.slot, 'ground');
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).not.toBeNull();
    vi.mocked(trust.isTrustedEvent).mockReturnValue(false);
    await clickLookup(r.slot);
    expect(fake.calls).toHaveLength(1);
    vi.mocked(trust.isTrustedEvent).mockReturnValue(true);
    const label = r.slot.querySelector<HTMLElement>('.ec__label')!;
    const range = document.createRange();
    range.selectNodeContents(label);
    vi.spyOn(contained, 'selectionWithin').mockReturnValue(range);
    await act(() => {
      label.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
    await selectGenerated(r.slot, 'ground');
    await act(() => {
      (r.slot.querySelector('[data-clavis="card-close"]') as HTMLElement).dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true }),
      );
    });
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
  });

  it.each(['outside', 'header', 'mixed'] as const)(
    'refuses a stale candidate when the range changes to %s before click',
    async (where) => {
      const { card, fake } = setup();
      const r = run();
      await present(card, r);
      await act(async () => {
        fake.calls[0]?.succeed();
        await flush();
      });
      await selectGenerated(r.slot, 'ground');
      const leaves = r.slot.querySelectorAll<HTMLElement>('[data-clavis="card-result-text"]');
      const range = document.createRange();
      if (where === 'outside') {
        vi.spyOn(contained, 'selectionWithin').mockReturnValue(null);
      } else if (where === 'header') {
        range.selectNodeContents(r.slot.querySelector('[data-clavis="card-text"]')!);
        vi.spyOn(contained, 'selectionWithin').mockReturnValue(range);
      } else {
        range.setStart(leaves[0]!.firstChild!, 0);
        range.setEnd(leaves[1]!.firstChild!, 2);
        vi.spyOn(contained, 'selectionWithin').mockReturnValue(range);
      }
      await clickLookup(r.slot);
      expect(fake.calls).toHaveLength(1);
      expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
    },
  );

  it('clears the candidate on tab switch and refuses over-limit selections without a request', async () => {
    const { card, fake } = setup();
    const r = run();
    await present(card, r);
    const longText = 'x'.repeat(2001);
    await act(async () => {
      fake.calls[0]?.succeed({ definition: longText });
      await flush();
    });
    await selectGenerated(r.slot, longText);
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
    expect(r.slot.textContent).toContain('That selection is too long');
    expect(fake.calls).toHaveLength(1);
    await selectGenerated(r.slot, 'bank');
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).not.toBeNull();
    await act(() => {
      (
        r.slot.querySelector('[data-clavis="card-tab"][data-tab="etymology"]') as HTMLElement
      ).click();
    });
    expect(r.slot.querySelector('[data-clavis="card-lookup"]')).toBeNull();
  });

  it('keeps nested history across immediate same-root re-presentation and Close', async () => {
    const { card, fake } = setup();
    const snapshot = makeSnapshot('word', 'bank');
    const first = run(snapshot);
    await present(card, first);
    await act(async () => {
      fake.calls[0]?.succeed();
      await flush();
    });
    await selectGenerated(first.slot, 'ground');
    await clickLookup(first.slot);
    await act(async () => {
      fake.calls[1]?.succeed();
      await flush();
    });
    first.abort();
    const second = run(snapshot);
    await present(card, second);
    expect(second.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('ground');
    expect(second.slot.querySelector('[data-clavis="card-back"]')).not.toBeNull();
    expect(fake.calls).toHaveLength(2);
    await act(() => {
      (second.slot.querySelector('[data-clavis="card-close"]') as HTMLElement).click();
    });
    const third = run(snapshot);
    await present(card, third);
    expect(third.slot.querySelector('[data-clavis="card-text"]')?.textContent).toBe('ground');
    expect(fake.calls).toHaveLength(2);
  });

  it('removes its resize listener when destroyed without an abort', async () => {
    const { card } = setup();
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    await present(card, run());
    const resize = add.mock.calls.find(([name]) => name === 'resize')?.[1];
    expect(resize).toBeDefined();
    card.destroy();
    expect(remove.mock.calls).toContainEqual(['resize', resize]);
    add.mockRestore();
    remove.mockRestore();
  });

  it.each(['destroy', 'dismiss'] as const)(
    'ignores a deferred language lookup after %s',
    async (action) => {
      const fake = createFakeBackend();
      let resolveLanguage: ((value: string) => void) | undefined;
      fake.backend.translationLanguage = () =>
        new Promise<string>((resolve) => {
          resolveLanguage = resolve;
        });
      const card = createExplainCard({
        backend: fake.backend,
        newId: () => `id-${(ids += 1)}`,
        now: Date.now,
        copy: () => Promise.resolve(true),
        features: { grammarTab: false, translateTab: true },
      });
      const snapshot = makeSnapshot();
      const r = run(snapshot);
      const pending = card.present(r.context);
      if (action === 'destroy') card.destroy();
      else card.dismiss(snapshot.selectionId);
      resolveLanguage?.('fr');
      await act(async () => {
        await pending;
        await flush();
      });
      expect(r.slot.childElementCount).toBe(0);
      expect(fake.calls).toHaveLength(0);
    },
  );
});
