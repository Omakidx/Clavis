// @vitest-environment jsdom
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCard, type CardHost } from '../../../components/explanation/ExplanationCard';
import { ExplainSession } from '../../../components/explanation/session';
import { sidePanelHandoffSchema } from '../../../lib/contracts/sidepanel';
import * as trust from '../../../lib/selection/trust';
import { createFakeBackend, installCatalog, makeSnapshot } from './support';

let root: HTMLElement;
let unmount: (() => void) | undefined;
let trusted = true;
let browserOnline = true;

interface Setup {
  fake: ReturnType<typeof createFakeBackend>;
  session: ExplainSession;
  host: CardHost & {
    reposition: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    copy: ReturnType<typeof vi.fn>;
    openSidePanel: ReturnType<typeof vi.fn>;
  };
}

async function setup(
  kind: Parameters<typeof makeSnapshot>[0] = 'word',
  text = 'bank',
  hostOverrides: Partial<CardHost> = {},
): Promise<Setup> {
  const fake = createFakeBackend();
  let ids = 0;
  const session = new ExplainSession({
    snapshot: makeSnapshot(kind, text),
    backend: fake.backend,
    newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
    now: () => Date.now(),
    features: { grammarTab: false, translateTab: false },
  });
  const host = {
    keyboard: false,
    reposition: vi.fn(),
    close: vi.fn(),
    openSettings: (section?: Parameters<CardHost['openSettings']>[0]) =>
      fake.backend.openSettings(section),
    openSidePanel: vi.fn((handoff: Parameters<CardHost['openSidePanel']>[0]) =>
      fake.backend.openSidePanel(handoff),
    ),
    online: () => browserOnline,
    copy: vi.fn().mockResolvedValue(true),
    now: () => Date.now(),
    ...hostOverrides,
  } as Setup['host'];
  await act(() => {
    unmount = mountCard(root, { session, host });
    session.attach();
  });
  return { fake, session, host };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string): T =>
  root.querySelector(selector) as T;
const $$ = (selector: string): HTMLElement[] => Array.from(root.querySelectorAll(selector));
const tab = (mode: string): HTMLButtonElement => $(`[data-clavis="card-tab"][data-tab="${mode}"]`);
const panel = (mode: string): HTMLElement => $(`[data-clavis="card-panel"][data-tab="${mode}"]`);
const byText = (selector: string, text: string): HTMLButtonElement =>
  $$(selector).find((el) => el.textContent === text) as HTMLButtonElement;

async function click(el: Element): Promise<void> {
  await act(() => {
    (el as HTMLElement).click();
  });
}

async function press(el: Element, key: string): Promise<void> {
  await act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  installCatalog();
  trusted = true;
  browserOnline = true;
  vi.spyOn(trust, 'isTrustedEvent').mockImplementation(() => trusted);
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.append(root);
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  root.remove();
  vi.useRealTimers();
});

describe('structure and accessibility', () => {
  it('is a labelled region with the kind and the (truncated) selected text', async () => {
    await setup('word', 'bank');
    const region = $('[data-clavis="card"]');
    expect(region.getAttribute('aria-label')).toBe('Explanation of bank');
    expect(region.getAttribute('tabindex')).toBe('-1');
    expect(root.textContent).toContain('Word');
    expect($('[data-clavis="card-text"]').textContent).toBe('bank');

    unmount?.();
    root.replaceChildren();
    const long = `${'long '.repeat(80)}end`;
    await setup('passage', long);
    // The DOM keeps the same 200 characters as the toolbar's own state line; CSS clamps it to two
    // lines. The accessible name is shorter still.
    expect($('[data-clavis="card-text"]').textContent).toBe(long.slice(0, 200));
    expect($('[data-clavis="card"]').getAttribute('aria-label')?.endsWith('…')).toBe(true);
    expect($('[data-clavis="card"]').getAttribute('data-action')).toBe('explain');
  });

  it.each([
    ['word', ['Core', 'Roots', 'Related words']],
    ['phrase', ['Core', 'Roots', 'Related words', 'Simplify']],
    ['sentence', ['Core', 'Simplify']],
    ['passage', ['Core', 'Simplify']],
  ] as const)('shows the right tabs for a %s', async (kind, labels) => {
    await setup(kind, 'text');
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual(labels);
  });

  it('follows the WAI-ARIA tabs pattern: roles, selection, roving tabindex, labelled panels', async () => {
    await setup('word');
    const list = $('[role="tablist"]');
    expect(list.getAttribute('aria-label')).toBe('Explanation sections');
    const tabs = $$('[role="tab"]');
    expect(tabs.map((el) => el.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    const panels = $$('[role="tabpanel"]');
    expect(panels).toHaveLength(tabs.length);
    tabs.forEach((el, index) => {
      const controlled = panels[index] as HTMLElement;
      expect(el.getAttribute('aria-controls')).toBe(controlled.id);
      expect(controlled.getAttribute('aria-labelledby')).toBe(el.id);
      expect(controlled.hidden).toBe(index !== 0);
      // Every tab panel can be scrolled with the keyboard.
      expect(controlled.getAttribute('tabindex')).toBe('0');
    });
  });

  it('arrow keys, Home and End move focus only; Enter opens (manual activation, no request by arrowing)', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    tab('core').focus();
    await press(tab('core'), 'ArrowRight');
    expect(document.activeElement ?? null).not.toBeNull();
    expect(root.querySelector('[role="tab"]:focus')).toBe(tab('etymology'));
    expect(tab('etymology').getAttribute('tabindex')).toBe('0');
    expect(tab('core').getAttribute('tabindex')).toBe('-1');
    expect(tab('core').getAttribute('aria-selected')).toBe('true');
    await press(tab('etymology'), 'ArrowRight');
    await press(tab('related_words'), 'ArrowRight');
    expect(root.querySelector('[role="tab"]:focus')).toBe(tab('core'));
    await press(tab('core'), 'End');
    expect(root.querySelector('[role="tab"]:focus')).toBe(tab('related_words'));
    await press(tab('related_words'), 'Home');
    expect(root.querySelector('[role="tab"]:focus')).toBe(tab('core'));
    await press(tab('core'), 'ArrowLeft');
    expect(root.querySelector('[role="tab"]:focus')).toBe(tab('related_words'));
    // Nothing was requested by moving focus around.
    expect(fake.calls).toHaveLength(1);
    await click(tab('related_words'));
    expect(fake.calls).toHaveLength(2);
  });

  it('keeps arrow keys away from the toolbar around it (stopPropagation)', async () => {
    await setup('word');
    const outer = vi.fn();
    root.addEventListener('keydown', outer);
    tab('core').focus();
    await press(tab('core'), 'ArrowRight');
    expect(outer).not.toHaveBeenCalled();
  });

  it('has a polite live region that announces loading, then the result', async () => {
    const { fake } = await setup('word');
    const live = $('[data-clavis="card-live"]');
    expect(live.getAttribute('role')).toBe('status');
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(live.textContent).toBe('Explaining…');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    expect(live.textContent).toBe('Explanation ready.');
  });

  it('moves focus into the card only for keyboard-started runs', async () => {
    await setup('word', 'bank', { keyboard: false });
    expect(document.activeElement).toBe(document.body);
    unmount?.();
    root.replaceChildren();
    await setup('word', 'bank', { keyboard: true });
    expect(document.activeElement).toBe($('[data-clavis="card"]'));
  });

  it('asks the toolbar to reposition when the content changes size', async () => {
    const { fake, host } = await setup('word');
    const before = host.reposition.mock.calls.length;
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    expect(host.reposition.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('core answer', () => {
  it('shows loading, then meaning, definition and two examples marked as written by AI, plus the model', async () => {
    const { fake } = await setup('word');
    expect(panel('core').querySelector('[data-clavis="card-loading"]')?.textContent).toBe(
      'Explaining…',
    );
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    const text = panel('core').textContent ?? '';
    expect(text).toContain('bank (noun)');
    expect(text).toContain('Meaning here');
    expect(text).toContain('Definition');
    expect(text).toContain('Examples written by AI');
    expect(panel('core').querySelectorAll('ol li')).toHaveLength(2);
    expect(text).toContain('Other senses exist.');
    expect($('[data-clavis="card-model"]').textContent).toBe('Model: openai/gpt-oss-20b');
  });

  it('renders model text as plain text: HTML, Markdown and links stay literal', async () => {
    const { fake } = await setup('word');
    const hostile =
      '<img src=x onerror="alert(1)"><script>alert(2)</script> **bold** [a](https://evil.test)';
    fake.calls[0]?.succeed({
      title: hostile,
      summary: hostile,
      definition: hostile,
      caveat: hostile,
      examples: [{ sentence: hostile }, { sentence: '<b>two</b>' }],
    });
    await act(() => Promise.resolve());
    expect(root.querySelector('img, script, b, a, iframe, svg, style')).toBeNull();
    expect(panel('core').textContent).toContain(hostile);
    expect(panel('core').textContent).toContain('<b>two</b>');
    expect(root.innerHTML).not.toContain('<script>');
  });
});

describe('lazy tabs', () => {
  it('requests Roots once on first open, shows its own loading state, and never again', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click(tab('etymology'));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.request.mode).toBe('etymology');
    expect(panel('etymology').hidden).toBe(false);
    expect(panel('core').hidden).toBe(true);
    expect(panel('etymology').querySelector('[data-clavis="card-loading"]')?.textContent).toBe(
      'Loading Roots…',
    );
    fake.calls[1]?.succeed();
    await act(() => Promise.resolve());
    expect(panel('etymology').textContent).toContain('From Old Norse');
    expect(panel('etymology').textContent).not.toContain('uncertain');
    await click(tab('core'));
    await click(tab('etymology'));
    await click(tab('related_words'));
    expect(fake.calls).toHaveLength(3);
    fake.calls[2]?.succeed();
    await act(() => Promise.resolve());
    expect(panel('related_words').textContent).toContain('Not applicable');
    await click(tab('related_words'));
    await click(tab('etymology'));
    expect(fake.calls).toHaveLength(3);
  });

  it('a tab error does not touch the core answer and has its own Retry', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click(tab('etymology'));
    fake.calls[1]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await act(() => Promise.resolve());
    expect(panel('etymology').querySelector('[data-clavis="card-error"]')).not.toBeNull();
    expect(panel('core').textContent).toContain('bank (noun)');
    await click(byText('[data-clavis="card-retry"]', 'Try again'));
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.request.mode).toBe('etymology');
  });
});

describe('error states and their actions (requirements section 7)', () => {
  async function fail(
    reply: Parameters<ReturnType<typeof createFakeBackend>['calls'][0]['reply']>[0],
  ) {
    const made = await setup('word');
    made.fake.calls[0]?.reply(reply);
    await act(() => Promise.resolve());
    return made;
  }

  it('SETUP_REQUIRED: "Connect Groq" opens Settings at the key', async () => {
    const { fake } = await fail({ kind: 'error', code: 'SETUP_REQUIRED' });
    expect($('[data-clavis="card-error"]').textContent).toContain(
      'Connect your Groq key to use Explain.',
    );
    await click(byText('[data-clavis="card-settings"]', 'Connect Groq'));
    expect(fake.settings).toEqual(['key']);
  });

  it('INVALID_API_KEY: "Update key" opens Settings at the key', async () => {
    const { fake } = await fail({ kind: 'error', code: 'INVALID_API_KEY' });
    await click(byText('[data-clavis="card-settings"]', 'Update key'));
    expect(fake.settings).toEqual(['key']);
  });

  it('MODEL_UNAVAILABLE: "Choose another model" opens Settings at the model', async () => {
    const { fake } = await fail({ kind: 'error', code: 'MODEL_UNAVAILABLE' });
    await click(byText('[data-clavis="card-settings"]', 'Choose another model'));
    expect(fake.settings).toEqual(['model']);
  });

  it('a failed settings open is announced, not swallowed', async () => {
    const { fake } = await fail({ kind: 'error', code: 'SETUP_REQUIRED' });
    fake.state.settingsOpens = false;
    await click(byText('[data-clavis="card-settings"]', 'Connect Groq'));
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect($('[data-clavis="card-live"]').textContent).toContain("couldn't open Settings");
  });

  it('NETWORK_ERROR and TIMEOUT: "Can\'t connect" and Try again (a new request, only when pressed)', async () => {
    const { fake } = await fail({ kind: 'error', code: 'NETWORK_ERROR' });
    expect($('[data-clavis="card-error"]').textContent).toContain("Can't connect");
    expect(fake.calls).toHaveLength(1);
    await click($('[data-clavis="card-retry"]'));
    expect(fake.calls).toHaveLength(2);
  });

  it('INVALID_RESPONSE: "Couldn\'t format explanation" and Try again', async () => {
    await fail({ kind: 'error', code: 'INVALID_RESPONSE' });
    expect($('[data-clavis="card-error"]').textContent).toContain("Couldn't format explanation");
    expect($('[data-clavis="card-retry"]').textContent).toBe('Try again');
  });

  it.each(['STORAGE_UNAVAILABLE', 'INTERNAL_ERROR'] as const)(
    '%s: a message and Try again',
    async (code) => {
      await fail({ kind: 'error', code });
      expect($('[data-clavis="card-error"]').textContent?.length).toBeGreaterThan(10);
      expect($('[data-clavis="card-retry"]')).not.toBeNull();
    },
  );

  it('RATE_LIMITED: counts down, Try again stays inactive until the delay is over', async () => {
    const { fake } = await fail({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 3000 });
    const retry = (): HTMLElement => $('[data-clavis="card-retry"]');
    expect($('[data-clavis="card-error"]').textContent).toContain('Rate limit reached');
    expect(retry().textContent).toBe('Try again in 3 s');
    expect(retry().getAttribute('aria-disabled')).toBe('true');
    await click(retry());
    expect(fake.calls).toHaveLength(1);
    await act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(retry().textContent).toBe('Try again in 2 s');
    await act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(retry().textContent).toBe('Try again');
    expect(retry().getAttribute('aria-disabled')).toBeNull();
    expect($('[data-clavis="card-live"]').textContent).toBe('You can try again now.');
    await click(retry());
    expect(fake.calls).toHaveLength(2);
  });

  it('a request cancelled for us is a quiet note with a Load button, not an error', async () => {
    const { fake } = await fail({ kind: 'error', code: 'REQUEST_CANCELLED' });
    expect($('[data-clavis="card-error"]').textContent).toContain("wasn't loaded");
    expect($('.ec__error-title')).toBeNull();
    expect($('[data-clavis="card-retry"]').textContent).toBe('Load');
    await click($('[data-clavis="card-retry"]'));
    expect(fake.calls).toHaveLength(2);
  });

  it('offers no button for an error nobody can act on', async () => {
    await fail({ kind: 'error', code: 'INVALID_REQUEST' });
    expect($('[data-clavis="card-error"] button')).toBeNull();
  });

  it('is never an infinite spinner', async () => {
    await setup('word');
    await act(() => {
      vi.advanceTimersByTime(46_000);
    });
    expect($('[data-clavis="card-error"]').textContent).toContain("Can't connect");
    expect($('[data-clavis="card-loading"]')).toBeNull();
  });
});

describe('first-send confirmation', () => {
  async function prompt() {
    const made = await setup('word', 'bank', { keyboard: true });
    made.fake.calls[0]?.reply({ kind: 'disclosure' });
    await act(() => Promise.resolve());
    return made;
  }
  /** Past the short delay in which an activation of Explain is ignored. */
  const wait = (ms = 500) =>
    act(() => {
      vi.advanceTimersByTime(ms);
    });

  it('shows the approved copy with Explain and Cancel, and puts keyboard focus on Explain', async () => {
    await prompt();
    const box = $('[data-clavis="card-disclosure"]');
    expect(box.textContent).toContain(
      "Send this to Groq? Clavis will send the selected text and a little of the text around it to Groq to explain it. You'll only be asked once.",
    );
    expect($('[data-clavis="card-confirm"]').textContent).toBe('Explain');
    expect($('[data-clavis="card-cancel"]').textContent).toBe('Cancel');
    expect(document.activeElement).toBe($('[data-clavis="card-confirm"]'));
  });

  it('Explain re-sends the same request with the acknowledgement and shows the answer', async () => {
    const { fake } = await prompt();
    await wait();
    await click($('[data-clavis="card-confirm"]'));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.acknowledge).toBe(true);
    expect(fake.calls[1]?.request).toEqual(fake.calls[0]?.request);
    fake.calls[1]?.succeed();
    await act(() => Promise.resolve());
    expect(panel('core').textContent).toContain('bank (noun)');
    expect($('[data-clavis="card-disclosure"]')).toBeNull();
  });

  it('ignores Explain for the first half second (a held Enter, a click timed under the pointer), then works', async () => {
    const { fake } = await prompt();
    await click($('[data-clavis="card-confirm"]'));
    await wait(499);
    await click($('[data-clavis="card-confirm"]'));
    expect(fake.calls).toHaveLength(1);
    expect($('[data-clavis="card-disclosure"]')).not.toBeNull();
    await wait(1);
    await click($('[data-clavis="card-confirm"]'));
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.acknowledge).toBe(true);
  });

  it('Cancel is not delayed', async () => {
    const { host } = await prompt();
    await click($('[data-clavis="card-cancel"]'));
    expect(host.close).toHaveBeenCalledTimes(1);
  });

  it('Cancel closes the card and sends nothing', async () => {
    const { fake, host } = await prompt();
    await click($('[data-clavis="card-cancel"]'));
    expect(host.close).toHaveBeenCalledTimes(1);
    expect(fake.calls).toHaveLength(1);
  });

  it('ignores a click that is not a real user event (page scripts cannot confirm)', async () => {
    const { fake } = await prompt();
    await wait();
    trusted = false;
    await click($('[data-clavis="card-confirm"]'));
    expect(fake.calls).toHaveLength(1);
    expect($('[data-clavis="card-disclosure"]')).not.toBeNull();
  });
});

describe('untrusted events', () => {
  it('tabs, Retry, settings, Copy and Close all ignore synthetic events', async () => {
    const { fake, host } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    trusted = false;
    await click(tab('etymology'));
    expect(fake.calls).toHaveLength(1);
    await click($('[data-clavis="card-copy"]'));
    await click($('[data-clavis="card-close"]'));
    expect(host.copy).not.toHaveBeenCalled();
    expect(host.close).not.toHaveBeenCalled();
    await press(tab('core'), 'ArrowRight');
    expect(root.querySelector('[role="tab"]:focus')).toBeNull();
  });
});

describe('copy and close', () => {
  it('Copy is inactive until there is a result, then copies the visible result as plain text', async () => {
    const { fake, host, session } = await setup('word');
    expect($('[data-clavis="card-copy"]').getAttribute('aria-disabled')).toBe('true');
    await click($('[data-clavis="card-copy"]'));
    expect(host.copy).not.toHaveBeenCalled();
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-copy"]').getAttribute('aria-disabled')).toBeNull();
    await click($('[data-clavis="card-copy"]'));
    expect(host.copy).toHaveBeenCalledTimes(1);
    const [text] = host.copy.mock.calls[0] as [string];
    expect(text).toBe(session.activeText());
    expect(text).toContain('Definition: Sloping ground along the side of a river.');
    expect(text).not.toMatch(/<|>/);
    expect($('[data-clavis="card-copy"]').textContent).toBe('Copied');
    await act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect($('[data-clavis="card-copy"]').textContent).toBe('Copy');
  });

  it('copies the ACTIVE tab, not the core answer', async () => {
    const { fake, host } = await setup('sentence', 'She broke the ice.');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click(tab('simplify'));
    fake.calls[1]?.succeed();
    await act(() => Promise.resolve());
    await click($('[data-clavis="card-copy"]'));
    expect(host.copy.mock.calls[0]?.[0]).toContain('She finally got people talking.');
    expect(host.copy.mock.calls[0]?.[0]).not.toContain('bank (noun)');
  });

  it('announces a failed copy', async () => {
    const { fake, host } = await setup('word');
    host.copy.mockResolvedValue(false);
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click($('[data-clavis="card-copy"]'));
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect($('[data-clavis="card-live"]').textContent).toBe("Copy isn't available on this page.");
  });

  it('Close asks the toolbar to close the card', async () => {
    const { host } = await setup('word');
    await click($('[data-clavis="card-close"]'));
    expect(host.close).toHaveBeenCalledTimes(1);
  });
});

describe('open in side panel (FR-042)', () => {
  const button = () => $('[data-clavis="card-side-panel"]');

  it('is inactive until the core answer is ready', async () => {
    const { fake, host } = await setup('word');
    expect(button().getAttribute('aria-disabled')).toBe('true');
    await click(button());
    expect(host.openSidePanel).not.toHaveBeenCalled();
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    expect(button().getAttribute('aria-disabled')).toBeNull();
    expect(button().textContent).toBe('Open in side panel');
  });

  it('hands over the selection and every loaded tab, without selectedText, and announces it', async () => {
    const { fake, host, session } = await setup('word', 'bank');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click(tab('etymology'));
    fake.calls[1]?.succeed();
    await act(() => Promise.resolve());
    await click(button());
    expect(host.openSidePanel).toHaveBeenCalledTimes(1);
    const handoff = fake.handoffs[0]!;
    expect(sidePanelHandoffSchema.safeParse(handoff).success).toBe(true);
    expect(handoff.snapshot.text).toBe('bank');
    expect(handoff.snapshot.contextBefore).toBe('They sat on the ');
    expect(handoff.results.map((r) => r.mode)).toEqual(['core', 'etymology']);
    expect(handoff.active).toBe('etymology');
    for (const result of handoff.results) expect(result).not.toHaveProperty('selectedText');
    expect(JSON.stringify(handoff)).not.toMatch(/gsk_|apiKey/);
    // Nothing was requested for it, and the card kept its own state.
    expect(fake.calls).toHaveLength(2);
    expect(session.state.entries.core?.status).toBe('ready');
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect($('[data-clavis="card-live"]').textContent).toBe('Opened in the side panel.');
  });

  it('asks the host in the SAME task as the click (the user gesture does not survive an await)', async () => {
    const { fake, host } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    let calledDuringClick = false;
    host.openSidePanel.mockImplementation(() => {
      calledDuringClick = true;
      return Promise.resolve(true);
    });
    (button() as HTMLElement).click();
    expect(calledDuringClick).toBe(true);
  });

  it('says so when the panel could not be opened', async () => {
    const { fake, host } = await setup('word');
    host.openSidePanel.mockResolvedValue(false);
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    await click(button());
    await act(() => {
      vi.advanceTimersByTime(100);
    });
    expect($('[data-clavis="card-live"]').textContent).toBe(
      "Clavis couldn't open the side panel. Try again.",
    );
  });

  it('ignores a synthetic click (a page cannot open the panel through the card)', async () => {
    const { fake, host } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    trusted = false;
    await click(button());
    expect(host.openSidePanel).not.toHaveBeenCalled();
  });

  it('points to the side panel only when the answer is long', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-long-hint"]')).toBeNull();
    expect(button().className).not.toContain('suggest');
    unmount?.();
    root.replaceChildren();
    const second = await setup('sentence', 'A long sentence.');
    second.fake.calls[0]?.succeed({ summary: 'x'.repeat(600), definition: 'y'.repeat(500) });
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-long-hint"]')?.textContent).toContain('side panel');
    expect(button().className).toContain('suggest');
  });
});

describe('provider status', () => {
  it('words a connection failure as offline when the browser says it is offline', async () => {
    browserOnline = false;
    const { fake } = await setup('word');
    fake.calls[0]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await act(() => Promise.resolve());
    const error = $('[data-clavis="card-error"]');
    expect(error.getAttribute('data-offline')).toBe('true');
    expect(error.textContent).toContain("You're offline");
    expect(error.textContent).toContain('offline');
    expect($('[data-clavis="card-retry"]')).not.toBeNull();
  });

  it('keeps the normal connection wording when the browser is online', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.reply({ kind: 'error', code: 'NETWORK_ERROR' });
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-error"]').getAttribute('data-offline')).toBeNull();
    expect($('[data-clavis="card-error"]').textContent).toContain("Can't connect");
  });

  it('follows the window going offline while an error is showing', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.reply({ kind: 'error', code: 'TIMEOUT' });
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-error"]').getAttribute('data-offline')).toBeNull();
    browserOnline = false;
    await act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect($('[data-clavis="card-error"]').getAttribute('data-offline')).toBe('true');
  });

  it('a rate limit counts down on Retry, which stays reachable but inactive', async () => {
    const { fake } = await setup('word');
    fake.calls[0]?.reply({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 3000 });
    await act(() => Promise.resolve());
    const retry = $('[data-clavis="card-retry"]');
    expect($('[data-clavis="card-error"]').textContent).toContain('Rate limit reached');
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    expect(retry.textContent).toBe('Try again in 3 s');
    await act(() => {
      vi.advanceTimersByTime(3100);
    });
    expect(retry.getAttribute('aria-disabled')).toBeNull();
    expect(retry.textContent).toBe('Try again');
  });

  it.each([
    ['SETUP_REQUIRED', 'Connect Groq', 'key'],
    ['INVALID_API_KEY', 'Update key', 'key'],
    ['MODEL_UNAVAILABLE', 'Choose another model', 'model'],
  ] as const)(
    '%s offers one button that opens Settings at the right section',
    async (code, label, section) => {
      const { fake } = await setup('word');
      fake.calls[0]?.reply({ kind: 'error', code });
      await act(() => Promise.resolve());
      const action = $('[data-clavis="card-settings"]');
      expect(action.textContent).toBe(label);
      await click(action);
      expect(fake.settings).toEqual([section]);
    },
  );
});

describe('text direction', () => {
  it('lets every piece of model text and the selected text choose its own direction', async () => {
    const { fake } = await setup('sentence', 'مرحبا بالعالم');
    fake.calls[0]?.succeed({
      title: 'مرحبا',
      summary: 'تحية عربية',
      contextualMeaning: 'Hello (مرحبا) to the world',
      examples: [{ sentence: 'مرحبا يا صديقي' }, { sentence: 'Say مرحبا to her' }],
    });
    await act(() => Promise.resolve());
    expect($('[data-clavis="card-text"]').getAttribute('dir')).toBe('auto');
    const result = $('[data-clavis="card-result"]');
    const texts = Array.from(result.querySelectorAll('p:not(.ec__label), li'));
    expect(texts.length).toBeGreaterThan(4);
    for (const element of texts)
      expect(element.getAttribute('dir'), element.textContent ?? '').toBe('auto');
    // Our own labels are not model text: they keep the interface's direction.
    for (const label of Array.from(result.querySelectorAll('.ec__label'))) {
      expect(label.getAttribute('dir')).toBeNull();
    }
    expect(result.querySelector('ol')?.getAttribute('dir')).toBe('auto');
  });
});

describe('Grammar and Translate tabs with their flags forced on (FR-036, FR-037)', () => {
  const ON = { grammarTab: true, translateTab: true };

  async function flagged(kind: Parameters<typeof makeSnapshot>[0], text: string, language = 'fr') {
    const fake = createFakeBackend();
    let ids = 0;
    const session = new ExplainSession({
      snapshot: makeSnapshot(kind, text),
      backend: fake.backend,
      newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
      now: () => Date.now(),
      features: ON,
      targetLanguage: language,
    });
    const host = {
      keyboard: false,
      reposition: vi.fn(),
      close: vi.fn(),
      openSettings: () => Promise.resolve(true),
      openSidePanel: () => Promise.resolve(true),
      online: () => true,
      copy: vi.fn().mockResolvedValue(true),
      now: () => Date.now(),
    } as unknown as CardHost;
    await act(() => {
      unmount = mountCard(root, { session, host });
      session.attach();
    });
    fake.calls[0]?.succeed();
    await act(() => Promise.resolve());
    return { fake, session };
  }

  it('offers Grammar for a sentence and Translate for every kind', async () => {
    await flagged('sentence', 'She broke the ice.');
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual([
      'Core',
      'Simplify',
      'Grammar',
      'Translate',
    ]);
    unmount?.();
    root.replaceChildren();
    await flagged('word', 'bank');
    expect($$('[role="tab"]').map((el) => el.textContent)).toEqual([
      'Core',
      'Roots',
      'Related words',
      'Translate',
    ]);
  });

  it('requests Grammar and Translate lazily, Translate with the target language', async () => {
    const { fake } = await flagged('sentence', 'She broke the ice.', 'fr');
    expect(fake.calls).toHaveLength(1);
    await click(tab('grammar'));
    expect(fake.calls[1]?.request.mode).toBe('grammar');
    fake.calls[1]?.succeed({ grammar: 'Subject: she\nVerb: broke\nObject: the ice' });
    await act(() => Promise.resolve());
    expect(panel('grammar').querySelector('.ec__field p:not(.ec__label)')?.textContent).toContain(
      'Verb: broke',
    );
    await click(tab('translate'));
    expect(fake.calls[2]?.request).toMatchObject({ mode: 'translate', targetLanguage: 'fr' });
  });

  it('labels the translation with its language and separates the literal rendering', async () => {
    const { fake, session } = await flagged('sentence', 'She broke the ice.');
    await click(tab('translate'));
    fake.calls[1]?.succeed({
      translation: {
        language: 'French',
        text: 'Elle a brisé la glace.',
        literal: 'Elle a cassé la glace.',
      },
    });
    await act(() => Promise.resolve());
    const text = panel('translate').textContent ?? '';
    expect(text).toContain('Translation into French');
    expect(text).toContain('Elle a brisé la glace.');
    expect(text).toContain('Word for word');
    expect(session.activeText()).toContain('Translation into French: Elle a brisé la glace.');
  });

  it('shows a right-to-left translation in its own direction and a plain failure with Retry', async () => {
    const { fake } = await flagged('phrase', 'break the ice', 'ar');
    await click(tab('translate'));
    fake.calls[1]?.succeed({ translation: { language: 'Arabic', text: 'كسر الجليد' } });
    await act(() => Promise.resolve());
    const field = panel('translate').querySelector('.ec__field p:not(.ec__label)');
    expect(field?.getAttribute('dir')).toBe('auto');
    expect(field?.textContent).toBe('كسر الجليد');
    await click(tab('grammar'));
    fake.calls[2]?.reply({ kind: 'error', code: 'INVALID_RESPONSE' });
    await act(() => Promise.resolve());
    expect(panel('grammar').textContent).toContain("Couldn't format explanation");
    expect($('[data-clavis="card-retry"]')).not.toBeNull();
  });
});
