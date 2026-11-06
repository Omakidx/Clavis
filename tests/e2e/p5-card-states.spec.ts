import { expect, test, type Page } from '@playwright/test';
import { FAKE_KEY, send } from './p3-support/background';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import {
  CARD,
  chatBody,
  explainWord,
  overrideChat,
  selectWord,
  startCardHarness,
  cardOf,
  type CardHarness,
} from './p5-card-support/harness';

// Phase 5, explanation card: the first-send confirmation, every error state with its action, the
// rate-limit countdown, offline, and cancellation, in the BUILT extension. Groq is answered by
// the test through Playwright routes; no real key exists.

const APPROVED_COPY =
  "Send this to Groq? Clavis will send the selected text and a little of the text around it to Groq to explain it. You'll only be asked once.";

const chatCount = (h: CardHarness): number => h.groq.chats().length;

test.describe('first send (FR-002, D-16)', () => {
  test('key but no acknowledgement: the approved copy shows, nothing is sent; Explain confirms once, never again', async () => {
    const h = await startCardHarness({ acknowledged: false });
    try {
      const { page, dispose } = await h.open();
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.disclosure);
      expect(await card.text(CARD.disclosure)).toContain(APPROVED_COPY);
      expect(await card.text(CARD.confirm)).toBe('Lookup');
      expect(await card.text(CARD.cancel)).toBe('Cancel');
      expect(chatCount(h)).toBe(0);
      await page.waitForTimeout(300);
      expect(chatCount(h)).toBe(0);

      // The ~500 ms arming delay (L3) is covered exactly by unit tests with fake timers
      // (tests/unit/explanation): in a browser under load the reads above can take longer than
      // the window, so an "early" click here would not be early. Wait it out, then confirm.
      await page.waitForTimeout(600);
      await card.click(CARD.confirm);
      await card.waitFor(CARD.ready('core'));
      expect(chatCount(h)).toBe(1);
      expect(await card.exists(CARD.disclosure)).toBe(false);

      // Acknowledged for good: another selection goes straight to the answer.
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      const again = await explainWord(page, 'river');
      await again.waitFor(CARD.ready('core'));
      expect(await again.exists(CARD.disclosure)).toBe(false);
      expect(chatCount(h)).toBe(2);
      await dispose();
    } finally {
      await h.close();
    }
  });

  test('Cancel closes the card and sends nothing; the question comes back next time', async () => {
    const h = await startCardHarness({ acknowledged: false });
    try {
      const { page, dispose } = await h.open();
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.disclosure);
      await card.click(CARD.cancel);
      await card.waitGone(CARD.card);
      expect(chatCount(h)).toBe(0);
      expect(await tb(page).isShown()).toBe(true);
      await tb(page).click('explain');
      await card.waitFor(CARD.disclosure);
      expect(chatCount(h)).toBe(0);
      await dispose();
    } finally {
      await h.close();
    }
  });

  test('the keyboard confirms with Enter on the Explain button the card focused for it', async () => {
    const h = await startCardHarness({ acknowledged: false });
    try {
      const { page, dispose } = await h.open();
      await selectWord(page, 'cartographer');
      await tb(page).focusAction('explain');
      await page.keyboard.press('Enter');
      const card = cardOf(page);
      await card.waitFor(CARD.disclosure);
      await expect.poll(() => card.focused()).toBe('card-confirm:');
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      await card.waitFor(CARD.ready('core'));
      expect(chatCount(h)).toBe(1);
      await dispose();
    } finally {
      await h.close();
    }
  });
});

test.describe('without a key', () => {
  test('Connect Groq opens Settings at the key section', async () => {
    const h = await startCardHarness({ key: false, acknowledged: false });
    try {
      const { page, dispose } = await h.open();
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.error);
      expect(await card.text(CARD.error)).toContain('Connect your Groq key to use Explain.');
      expect(await card.text(CARD.settings)).toBe('Connect Groq');
      expect(h.groqUrls).toEqual([]);
      const opened = h.ext.context.waitForEvent('page');
      await card.click(CARD.settings);
      const settings = await opened;
      await settings.waitForURL(/\/options\.html#section-key$/);
      await dispose();
    } finally {
      await h.close();
    }
  });
});

test.describe('errors from Groq', () => {
  let h: CardHarness;
  let mode: { current: 'ok' | 'offline' | 'garbage' | 'slow' };
  let release: () => void = () => undefined;

  test.beforeAll(async () => {
    h = await startCardHarness();
    mode = { current: 'ok' };
    await overrideChat(h.ext.context, async (route) => {
      if (mode.current === 'offline') return route.abort('internetdisconnected');
      if (mode.current === 'garbage') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: chatBody('not json'),
        });
      }
      if (mode.current === 'slow') {
        await new Promise<void>((resolve) => (release = resolve));
      }
      return route.fallback();
    });
  });
  test.afterAll(async () => {
    release();
    await h?.close();
  });

  async function failWith(
    status: number | undefined,
    headers: Record<string, string> = {},
  ): Promise<{ page: Page; dispose(): Promise<void>; card: ReturnType<typeof cardOf> }> {
    h.groq.chatStatus.current = status;
    if (headers['retry-after'] !== undefined) h.groq.chatStatus.retryAfter = headers['retry-after'];
    const { page, dispose } = await h.open();
    const card = await explainWord(page, 'cartographer');
    return { page, dispose, card };
  }

  test.afterEach(async () => {
    // A 401 flags the stored key as rejected (FR-072); store it again so every test starts valid.
    h.groq.chatStatus.current = undefined;
    await send(h.options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
    delete h.groq.chatStatus.retryAfter;
    mode.current = 'ok';
  });

  test('401: "Update key" opens Settings at the key', async () => {
    const { card, dispose } = await failWith(401);
    await card.waitFor(CARD.error);
    expect(await card.text(CARD.error)).toContain("Groq didn't accept your key");
    expect(await card.text(CARD.settings)).toBe('Update key');
    const opened = h.ext.context.waitForEvent('page');
    await card.click(CARD.settings);
    await (await opened).waitForURL(/\/options\.html#section-key$/);
    await dispose();
  });

  test('404 model not found: "Choose another model" opens Settings at the model section', async () => {
    const { card, dispose } = await failWith(404);
    await card.waitFor(CARD.error);
    expect(await card.text(CARD.error)).toContain("The chosen model isn't available");
    expect(await card.text(CARD.settings)).toBe('Choose another model');
    const opened = h.ext.context.waitForEvent('page');
    await card.click(CARD.settings);
    await (await opened).waitForURL(/\/options\.html#section-model$/);
    await dispose();
  });

  test('429 with Retry-After: "Rate limit reached", a countdown, Try again stays inactive until it is over', async () => {
    const { card, dispose } = await failWith(429, { 'retry-after': '3' });
    await card.waitFor(CARD.error);
    expect(await card.text(CARD.error)).toContain('HTTP 429');
    const label = (await card.text(CARD.retry)) ?? '';
    expect(label).toMatch(/^Try again in [123] s$/);
    expect(await card.toolbar.attr(CARD.retry, 'aria-disabled')).toBe('true');
    const before = chatCount(h);
    // A click while the countdown runs sends nothing.
    await card.click(CARD.retry);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chatCount(h)).toBe(before);

    await expect.poll(() => card.text(CARD.retry), { timeout: 8000 }).toBe('Try again');
    expect(await card.toolbar.attr(CARD.retry, 'aria-disabled')).toBeNull();
    expect(await card.text(CARD.live)).toBe('You can try again now.');
    // Now it is the user's call: one more request, and it works once Groq recovers.
    h.groq.chatStatus.current = undefined;
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    expect(chatCount(h)).toBe(before + 1);
    await dispose();
  });

  test('500: "Can\'t connect" with Try again, which asks once more only when pressed', async () => {
    const { card, dispose } = await failWith(500);
    await card.waitFor(CARD.error, 20_000);
    expect(await card.text(CARD.error)).toContain('HTTP 500');
    const before = chatCount(h);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(chatCount(h)).toBe(before);
    h.groq.chatStatus.current = undefined;
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    expect(chatCount(h)).toBe(before + 1);
    await dispose();
  });

  test('offline: "Can\'t connect" and Try again recovers when the network is back', async () => {
    mode.current = 'offline';
    const { card, dispose } = await failWith(undefined);
    await card.waitFor(CARD.error, 20_000);
    expect(await card.text(CARD.error)).toContain("Can't connect");
    expect(await card.text(CARD.retry)).toBe('Try again');
    mode.current = 'ok';
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    await dispose();
  });

  test('an answer that is not valid: "Couldn\'t format explanation" with Try again', async () => {
    mode.current = 'garbage';
    const { card, dispose } = await failWith(undefined);
    await card.waitFor(CARD.error, 20_000);
    expect(await card.text(CARD.error)).toContain("Couldn't format explanation");
    expect(await card.text(CARD.retry)).toBe('Try again');
    mode.current = 'ok';
    await card.click(CARD.retry);
    await card.waitFor(CARD.ready('core'));
    await dispose();
  });

  test('a failing tab keeps the core answer and shows its own error', async () => {
    const { page, dispose } = await h.open();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    h.groq.chatStatus.current = 401;
    await card.click(CARD.tab('etymology'));
    await card.waitFor(`${CARD.panel('etymology')} ${CARD.error}`);
    expect(await card.text(CARD.panel('etymology'))).toContain("Groq didn't accept your key");
    expect(await card.text(CARD.panel('core'))).toContain('Definition');
    await dispose();
  });
});

test.describe('cancellation and stale answers', () => {
  test('Escape while loading cancels the request (AI_CANCEL), and a late answer never shows', async () => {
    const h = await startCardHarness();
    try {
      let release: () => void = () => undefined;
      const aborted: string[] = [];
      h.ext.context.on('requestfailed', (request) => {
        if (request.url().includes('api.groq.com'))
          aborted.push(request.failure()?.errorText ?? '');
      });
      await overrideChat(h.ext.context, async (route) => {
        await new Promise<void>((resolve) => (release = resolve));
        await route.fallback().catch(() => undefined);
      });
      const { page, dispose } = await h.open();
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      await expect.poll(() => aborted.length, { timeout: 8000 }).toBeGreaterThan(0);
      release();
      await page.waitForTimeout(300);
      expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
      await dispose();
    } finally {
      await h.close();
    }
  });

  test('a newer selection wins: the slow answer of the old one is dropped', async () => {
    const h = await startCardHarness();
    try {
      const gates = new Map<string, () => void>();
      await overrideChat(h.ext.context, async (route, _mode, word) => {
        if (word === 'lazy') {
          await new Promise<void>((resolve) => gates.set(word, resolve));
        }
        const title = `answer for ${word}`;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: chatBody(
            JSON.stringify({
              title,
              summary: 'x',
              contextualMeaning: 'y',
              definition: 'z',
              examples: [
                { sentence: 'one', note: null },
                { sentence: 'two', note: null },
              ],
              caveat: null,
            }),
          ),
        });
      });
      const { page, dispose } = await h.open();
      const card = await explainWord(page, 'lazy');
      // Pick another word while the first answer is still pending: the new selection replaces the
      // toolbar content, which takes the old card down.
      await dblclickText(page, page, 'Old');
      await card.waitGone(CARD.card);
      await tb(page).waitShown();
      await tb(page).click('explain');
      await card.waitFor(CARD.card);
      await card.waitFor(CARD.ready('core'));
      expect(await card.text(CARD.panel('core'))).toContain('answer for Old');
      gates.get('lazy')?.();
      await page.waitForTimeout(400);
      expect(await card.text(CARD.panel('core'))).toContain('answer for Old');
      expect(await card.text(CARD.panel('core'))).not.toContain('answer for lazy');
      await dispose();
    } finally {
      await h.close();
    }
  });
});
