// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExplainCard } from '../../../components/explanation/card';
import * as trust from '../../../lib/selection/trust';
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
    const spyOff = vi.spyOn(off.fake.backend, 'explanationLanguage');
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
    const spy = vi.spyOn(fake.backend, 'explanationLanguage');
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
