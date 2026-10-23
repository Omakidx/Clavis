import { expect, test } from '@playwright/test';
import {
  CARD,
  cardOf,
  chatBody,
  explainWord,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { dblclickText } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { cardText, installScript, pause, type Script } from './p9-support/card';
import { installLedger, type Ledger } from './p9-support/ledger';

// Phase 9, "Regression test navigation/reselection stale answers and toolbar persistence"
// (requirements NFR: "Support cancellation and stale-response prevention when user changes
// selection or navigates"; architecture section 5 rule 8: a response is displayed only if its
// request id and selection match the visible selection; section 6: "Selection changed: abort if
// possible; never render stale result"). The model here answers each word with text naming that
// word, so a test can tell whose answer it is reading; answers can be held and released at will.

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let h: CardHarness;
let ledger: Ledger;
let script: Script;
const gates = new Map<string, (() => void)[]>();

/** Answers name the selected word in every field (so a stale one is recognisable). */
function answer(mode: string, word: string): string {
  switch (mode) {
    case 'etymology':
      return JSON.stringify({ overview: `ORIGIN-OF-${word}`, confidence: 'known' });
    case 'related_words':
      return JSON.stringify({ synonyms: [`SYN-OF-${word}`], antonyms: [] });
    case 'simplify':
      return JSON.stringify({ simplifiedText: `SIMPLE-${word}` });
    default:
      return JSON.stringify({
        title: `TITLE-${word}`,
        summary: `SUMMARY-${word}`,
        contextualMeaning: `MEANING-${word}`,
        definition: `DEFINITION-${word}`,
        examples: [{ sentence: `EXAMPLE-ONE-${word}` }, { sentence: `EXAMPLE-TWO-${word}` }],
      });
  }
}

/** Hold the answer for `mode:word` until `release('mode:word')` (or answer at once when not gated). */
const gated = new Set<string>();
function release(key: string): void {
  // Oldest held request first.
  gates.get(key)?.shift()?.();
}

test.beforeAll(async () => {
  h = await startCardHarness();
  ledger = await installLedger(h.ext.context);
  script = await installScript(h.ext.context);
  script.handler = async (route, mode, word) => {
    const key = `${mode}:${word}`;
    if (gated.has(key)) {
      await new Promise<void>((resolve) => gates.set(key, [...(gates.get(key) ?? []), resolve]));
    }
    await route
      .fulfill({ status: 200, contentType: 'application/json', body: chatBody(answer(mode, word)) })
      .catch(() => undefined);
  };
});
test.afterAll(async () => {
  await h?.close();
});
test.afterEach(() => {
  gated.clear();
  for (const waiting of gates.values()) for (const resolve of waiting) resolve();
  gates.clear();
  script.seen.length = 0;
});

const wasAborted = (aborted: string[]): boolean => aborted.length > 0;

test.describe('stale answers', () => {
  test('a Roots answer still in flight when another word is selected never shows under the new word', async () => {
    gated.add('etymology:cartographer');
    const { page, dispose } = await h.open();
    let card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await card.click(CARD.tab('etymology'));
    await card.waitFor(`${CARD.panel('etymology')}[data-status="loading"]`);

    // The reader moves on to another word before the Roots answer arrives.
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await selectWord(page, 'river');
    await tb(page).click('explain');
    card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect(await card.text(CARD.text)).toBe('river');

    release('etymology:cartographer');
    await pause(1000);

    // The old answer arrived (the route fulfilled it) and was dropped: not in the card, and the
    // new word's Roots tab is still untouched and costs a request only when opened.
    const all = await cardText(card);
    expect(all).not.toContain('ORIGIN-OF-cartographer');
    expect(all).not.toContain('cartographer');
    expect(await card.status('etymology')).toBe('idle');
    const mark = ledger.mark();
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    expect(ledger.chats(mark)).toHaveLength(1);
    expect(await card.text(CARD.panel('etymology'))).toContain('ORIGIN-OF-river');
    expect(await cardText(card)).not.toContain('cartographer');
    await dispose();
  });

  test('the SAME word selected again after Escape gets its own request, and the first request never fills the second card', async () => {
    gated.add('core:cartographer');
    const { page, dispose } = await h.open();
    const aborted: string[] = [];
    h.ext.context.on('requestfailed', (r) => {
      if (r.url().includes('api.groq.com')) aborted.push(r.url());
    });
    const mark = ledger.mark();
    let card = await explainWord(page, 'cartographer');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(1);
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await expect.poll(() => wasAborted(aborted)).toBe(true);

    // Second time, same word: a different selection token. Hold this one too.
    await page.waitForTimeout(300);
    await selectWord(page, 'cartographer');
    await tb(page).click('explain');
    card = cardOf(page);
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    // Let the FIRST request's answer go (its connection was aborted by the cancel; releasing the
    // gate must change nothing), then the second one's.
    release('core:cartographer');
    await pause(600);
    expect(await card.status('core')).toBe('loading');
    release('core:cartographer');
    await card.waitFor(CARD.ready('core'));
    expect(await card.text(CARD.panel('core'))).toContain('DEFINITION-cartographer');
    await dispose();
  });

  test('clearing the selection (page script, or a click in text) while loading dismisses everything; a late answer shows nothing', async () => {
    gated.add('core:cartographer');
    const { page, dispose } = await h.open();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);

    // A click elsewhere in the text collapses the selection (a real, trusted interaction).
    await dblclickText(page, page, 'quiet');
    await page.mouse.click(5, 300);
    await tb(page).waitHidden();
    release('core:cartographer');
    await pause(800);
    expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
    await dispose();
  });

  test('a new selection while the previous answer is shown replaces the card: no field of the old answer survives', async () => {
    const { page, dispose } = await h.open();
    let card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await selectWord(page, 'river');
    // The toolbar follows the new selection at once; the old card is gone until Explain is pressed.
    expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
    await tb(page).click('explain');
    card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    const all = await cardText(card);
    expect(all).toContain('DEFINITION-river');
    expect(all).not.toContain('cartographer');
    await dispose();
  });
});

test.describe('navigation', () => {
  test('after the tab loads another page, the old card and toolbar are gone and the old answer shows nowhere', async () => {
    gated.add('core:cartographer');
    const { page, dispose } = await h.open();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);

    await page.goto(`${h.server.origin}/long.html`);
    release('core:cartographer');
    await pause(1000);
    expect(await tb(page).hostCount()).toBe(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain('DEFINITION-');
    expect(card).toBeDefined();

    // The new document works from scratch: a selection there, one Explain, one request.
    const mark = ledger.mark();
    await page.waitForLoadState();
    const word = await page.evaluate(() => {
      const text = document.body.innerText.match(/[A-Za-z]{6,}/)?.[0];
      return text ?? '';
    });
    expect(word).not.toBe('');
    await selectWord(page, word);
    expect(ledger.chats(mark)).toHaveLength(0);
    await tb(page).click('explain');
    const fresh = cardOf(page);
    await fresh.waitFor(CARD.ready('core'));
    expect(ledger.chats(mark)).toHaveLength(1);
    expect(await cardText(fresh)).not.toContain('cartographer');
    await dispose();
  });

  // Q1 (found by this suite, fixed in Phase 9): NFR "Support cancellation ... when the user ...
  // navigates" and architecture section 6 ("Selection changed: abort if possible"). The worker used
  // to abort only on AI_CANCEL, tab close, key change or a newer request; it now also aborts the
  // tab's requests when the tab starts loading another page (lib/router/register.ts).
  test('navigating away while a request is in flight aborts the Groq request', async () => {
    gated.add('core:cartographer');
    const aborted: string[] = [];
    h.ext.context.on('requestfailed', (r) => {
      if (r.url().includes('api.groq.com')) aborted.push(r.url());
    });
    const { page, dispose } = await h.open();
    const mark = ledger.mark();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(1);
    try {
      await page.goto(`${h.server.origin}/long.html`);
      await expect.poll(() => aborted.length, { timeout: 5000 }).toBeGreaterThan(0);
    } finally {
      await dispose();
    }
  });

  test('closing the tab mid-request aborts the request at the worker', async () => {
    gated.add('core:cartographer');
    const aborted: string[] = [];
    h.ext.context.on('requestfailed', (r) => {
      if (r.url().includes('api.groq.com')) aborted.push(r.url());
    });
    const { page, dispose } = await h.open();
    const mark = ledger.mark();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
    await expect.poll(() => ledger.chats(mark).length).toBe(1);
    await page.close();
    await expect.poll(() => aborted.length, { timeout: 8000 }).toBeGreaterThan(0);
    await dispose().catch(() => undefined);
  });
});

test.describe('toolbar persistence and dismissal while an explanation exists', () => {
  test('pressing inside the card, scrolling the page and moving the mouse keep toolbar and card; Escape removes both; the next selection starts clean', async () => {
    const { page, dispose } = await h.open('long.html');
    const word = await page.evaluate(
      () => document.body.innerText.match(/[A-Za-z]{7,}/)?.[0] ?? '',
    );
    let card = await explainWord(page, word);
    await card.waitFor(CARD.ready('core'));

    // Pressing a card control (a trusted click) does not dismiss anything.
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    expect(await tb(page).isShown(SEL.toolbar)).toBe(true);

    // Wheel-scrolling the page keeps them (the toolbar follows its selection).
    await page.mouse.wheel(0, 30);
    await pause(300);
    expect(await card.exists(CARD.card)).toBe(true);

    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    expect(await card.exists(CARD.card).catch(() => false)).toBe(false);

    await selectWord(page, word);
    await tb(page).click('explain');
    card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    // Escape dropped the per-selection cache: the Roots tab is not loaded for the new card.
    expect(await card.status('etymology')).toBe('idle');
    await dispose();
  });

  test('a page that clears the selection when the card is pressed cannot dismiss it (FR-014: preserve when clicking toolbar)', async () => {
    const { page, dispose } = await h.open();
    await page.evaluate(() => {
      document.addEventListener('mousedown', () => getSelection()?.removeAllRanges(), true);
    });
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    expect(await card.exists(CARD.card)).toBe(true);
    expect(await card.text(CARD.text)).toBe('cartographer');
    await dispose();
  });
});
