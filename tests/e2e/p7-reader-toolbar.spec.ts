import { expect, test } from './fixtures';
import {
  dragSelectSpan,
  externalRequests,
  openReader,
  selectionEquals,
  sentMessages,
  waitForPhase,
  waitForRendersToSettle,
  type ReaderSession,
  type SentMessage,
} from './p7-reader-support/helpers';
import { machineHasVoices, promptParts, setUpAi } from './p7-reader-support/ai';
import {
  CONTEXT_MARKERS,
  CONTEXT_SENTENCE,
  CONTEXT_WORD,
  contextPdf,
} from './p7-reader-support/pdfs';
import { gotoPage, selectWordByDoubleClick } from './p7-reader-support/select';
import { CARD, cardOf } from './p5-card-support/harness';
import {
  LISTEN,
  finishAudio,
  installScriptedTts,
  listenOf,
  scriptedCalls,
} from './p6-listen-support/listen';
import { SEL, tb } from './spike-b-support/toolbar';

// Phase 7, FR-053: the PDF reader uses the SAME selection toolbar, Listen and explanation card as a
// web page. Groq is answered by the test (a fake `gsk_TEST...` key); nothing leaves the machine.

test.describe.configure({ timeout: 120_000 });

async function openContextPdf(session: ReaderSession): Promise<void> {
  await session.page.getByTestId('file-input').setInputFiles({
    name: 'context.pdf',
    mimeType: 'application/pdf',
    buffer: await contextPdf(),
  });
  await waitForPhase(session.page, 'ready');
  await gotoPage(session.page, 2);
  await waitForRendersToSettle(session.page, { quietMs: 500 });
}

const aiMessages = (messages: SentMessage[]) => messages.filter((m) => m.type === 'AI_EXPLAIN');

test.describe('Explain from the PDF reader', () => {
  test('a word: the toolbar appears, Explain sends source pdf, the page and bounded same-page context', async ({
    context,
    extensionId,
  }) => {
    const { groq } = await setUpAi(context, extensionId);
    const session = await openReader(context, extensionId);
    const { page, requests, problems } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();

    // Nothing is sent by selecting (FR-017): no Groq traffic, no AI message.
    expect(groq.calls).toEqual([]);
    expect(aiMessages(await sentMessages(page))).toEqual([]);

    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect(await card.text(CARD.text)).toBe(CONTEXT_WORD);

    // The message the reader sent: a pdf snapshot, with the page and nothing else around it.
    const [message] = aiMessages(await sentMessages(page));
    const snapshot = message!.payload!.snapshot;
    expect(snapshot).toMatchObject({ source: 'pdf', page: 2, kind: 'word', text: CONTEXT_WORD });
    expect(Object.keys(snapshot).sort()).toEqual(
      ['contextAfter', 'contextBefore', 'kind', 'page', 'selectionId', 'source', 'text'].sort(),
    );

    // The request Groq received: one core request; context from page 2 only, at most 1,000 chars.
    expect(groq.chats()).toHaveLength(1);
    const parts = promptParts(groq.chats()[0]!.body!.messages[1]!.content);
    expect(parts.mode).toBe('core');
    expect(parts.selected).toBe(CONTEXT_WORD);
    expect(parts.contextBefore.length + parts.contextAfter.length).toBeLessThanOrEqual(1000);
    expect(parts.contextBefore.length).toBeGreaterThan(100);
    expect(parts.contextAfter.length).toBeGreaterThan(100);
    expect(parts.contextBefore).toContain('Row 20');
    expect(parts.contextAfter).toContain('Row 22');
    // Same-page rule: nothing from the other pages, and not the whole page either.
    const everything = JSON.stringify(groq.chats()[0]!.body);
    expect(everything).not.toContain(CONTEXT_MARKERS.before);
    expect(everything).not.toContain(CONTEXT_MARKERS.after);
    expect(everything).not.toContain('Row 01');
    expect(everything).not.toContain('Row 40');

    // No PDF bytes: the whole request is the prompt (a few KB), with no trace of the file.
    expect(everything.length).toBeLessThan(10_000);
    expect(everything).not.toContain('%PDF');
    expect(JSON.stringify(message).length).toBeLessThan(8_000);

    // Zero network except the extension itself and the one explicit Groq call.
    const external = externalRequests(requests, extensionId);
    expect(external).toEqual(['https://api.groq.com/openai/v1/chat/completions']);
    expect(problems).toEqual([]);
  });

  test('a sentence: Core and Simplify tabs, the request carries the whole sentence', async ({
    context,
    extensionId,
  }) => {
    const { groq } = await setUpAi(context, extensionId);
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await dragSelectSpan(page, CONTEXT_SENTENCE);
    await selectionEquals(page, CONTEXT_SENTENCE);
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect((await card.tabs())?.map((tab) => tab.label)).toEqual(['Core', 'Simplify', 'Translate']);

    const [message] = aiMessages(await sentMessages(page));
    expect(message!.payload!.snapshot).toMatchObject({
      source: 'pdf',
      page: 2,
      kind: 'sentence',
      text: CONTEXT_SENTENCE,
    });
    const parts = promptParts(groq.chats()[0]!.body!.messages[1]!.content);
    expect(parts.selected).toBe(CONTEXT_SENTENCE);
    expect(parts.contextBefore.length + parts.contextAfter.length).toBeLessThanOrEqual(1000);
  });

  test('the first send asks for confirmation inside the reader, then sends once', async ({
    context,
    extensionId,
  }) => {
    const { groq } = await setUpAi(context, extensionId, { acknowledged: false });
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.disclosure);
    // Asking is not sending.
    expect(groq.calls).toEqual([]);
    // The confirm button ignores presses for a moment after it appears; a user needs that long to read.
    await page.waitForTimeout(1200);
    await card.click(CARD.confirm);
    await card.waitFor(CARD.ready('core'));
    expect(groq.chats()).toHaveLength(1);
    const sent = aiMessages(await sentMessages(page));
    expect(sent.some((m) => m.acknowledgeDisclosure === true)).toBe(true);
  });

  test('without a key, Explain says how to connect Groq and sends nothing', async ({
    context,
    extensionId,
  }) => {
    const groqCalls: string[] = [];
    context.on('request', (r) => {
      if (r.url().startsWith('https://api.groq.com')) groqCalls.push(r.url());
    });
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.error);
    expect(await card.text(CARD.error)).toContain('Connect your Groq key to use Explain.');
    expect(groqCalls).toEqual([]);
  });

  test('a selection over the limit offers "use the first 2,000 characters"; nothing is sent until then', async ({
    context,
    extensionId,
  }) => {
    const { groq } = await setUpAi(context, extensionId);
    const session = await openReader(context, extensionId, { width: 1100, height: 1000 });
    const { page } = session;
    await openContextPdf(session);
    // A real click at the start of the page, then Shift+click at the end: the browser selects
    // everything between (about 3,000 characters on page 2).
    const ends = await page.evaluate(() => {
      const spans = [
        ...document.querySelectorAll<HTMLElement>('.page[data-page-number="2"] .textLayer span'),
      ];
      spans[0]!.scrollIntoView({ block: 'start' });
      const first = spans[0]!.getBoundingClientRect();
      const last = spans[spans.length - 1]!.getBoundingClientRect();
      return {
        from: { x: first.left + 3, y: first.top + first.height / 2 },
        to: { x: last.left + last.width - 3, y: last.top + last.height / 2 },
      };
    });
    await waitForRendersToSettle(page, { quietMs: 500 });
    await page.mouse.move(ends.from.x, ends.from.y);
    await page.mouse.down();
    await page.mouse.move(ends.to.x, ends.to.y, { steps: 12 });
    await page.mouse.up();
    await tb(page).waitShown(SEL.limit);
    expect(await tb(page).text(SEL.limit)).toContain('Selection too long');
    expect(groq.calls).toEqual([]);
    expect(aiMessages(await sentMessages(page))).toEqual([]);

    await tb(page).click('trim');
    await tb(page).waitShown(SEL.trimmed);
    const trimmed = (await tb(page).text(SEL.trimmedText)) ?? '';
    expect(trimmed.length).toBeLessThanOrEqual(2000);
    expect(trimmed.length).toBeGreaterThan(1500);
    // Still nothing sent; Explain now sends the trimmed text only.
    expect(groq.calls).toEqual([]);
    await tb(page).click('explain');
    await cardOf(page).waitFor(CARD.ready('core'));
    const [message] = aiMessages(await sentMessages(page));
    expect(message!.payload!.snapshot.page).toBe(2);
    expect(message!.payload!.snapshot.source).toBe('pdf');
    expect(message!.payload!.snapshot.text.length).toBeLessThanOrEqual(2000);
  });
});

test.describe('Listen from the PDF reader', () => {
  test('on a machine without voices: the same no-voice message and Linux hint as a web page, nothing plays', async ({
    context,
    extensionId,
  }) => {
    test.skip(await machineHasVoices(context, extensionId), 'This machine has voices.');
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitMessage();
    expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
    expect(await listen.toolbar.text(LISTEN.hint)).toContain('speech-dispatcher');
    expect(await listen.listenButton()).toMatchObject({ label: 'Speak', spinner: false });
    // Listen is local: it sends the word and nothing else, and makes no AI request.
    const speak = (await sentMessages(page)).filter((m) => m.type === 'TTS_SPEAK');
    expect(speak).toHaveLength(1);
    expect(speak[0]).toMatchObject({ text: CONTEXT_WORD });
    expect(Object.keys(speak[0]!)).not.toContain('contextBefore');
    expect(aiMessages(await sentMessages(page))).toEqual([]);
  });

  test('with a voice: Stop while it plays, Replay after it ends; only the selected text is spoken', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await installScriptedTts(serviceWorker);
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await dragSelectSpan(page, CONTEXT_SENTENCE);
    await selectionEquals(page, CONTEXT_SENTENCE);
    await tb(page).waitShown();
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitLabel('Stop');
    const calls = await scriptedCalls(serviceWorker);
    expect(calls).toHaveLength(1);
    // The context (hundreds of characters) is never spoken, nor sent for Listen.
    expect(calls[0]!.chars).toBe(CONTEXT_SENTENCE.length);

    await finishAudio(serviceWorker);
    await listen.waitLabel('Replay');
    const speak = (await sentMessages(page)).filter((m) => m.type === 'TTS_SPEAK');
    expect(speak[0]).toMatchObject({ text: CONTEXT_SENTENCE });
    expect(JSON.stringify(speak[0])).not.toContain('Row 1');
  });

  test('Listen leaves an open explanation alone', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await installScriptedTts(serviceWorker);
    await setUpAi(context, extensionId);
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitLabel('Stop');
    expect(await card.exists(CARD.ready('core'))).toBe(true);
  });
});

test.describe('Toolbar placement in the scrolling viewer', () => {
  test('follows the text while scrolling, hides when the selection leaves the viewer, returns when it is back', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();

    const viewer = (await page.getByTestId('viewer-container').boundingBox())!;
    const selectionBox = () =>
      page.evaluate(() => {
        const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      });

    const before = await selectionBox();
    const boxBefore = await tb(page).box();
    // Next to the word, not on top of it, and inside the window.
    expect(
      Math.abs(boxBefore.x + boxBefore.width / 2 - (before.x + before.width / 2)),
    ).toBeLessThan(boxBefore.width);
    const gapBefore = Math.min(
      Math.abs(boxBefore.y + boxBefore.height - before.y),
      Math.abs(before.y + before.height - boxBefore.y),
    );
    expect(gapBefore).toBeLessThan(40);

    // Scroll 120 px: the toolbar moves with the word.
    await page.getByTestId('viewer-container').evaluate((el) => el.scrollBy(0, 120));
    await expect.poll(async () => Math.round((await selectionBox()).y - before.y)).toBe(-120);
    await expect
      .poll(async () => {
        const box = await tb(page).box();
        return Math.round(box.y - boxBefore.y);
      })
      .toBeLessThanOrEqual(-100);

    // Scroll far enough that the word is above the viewer: the toolbar is not shown over the header.
    const top = await page.getByTestId('viewer-container').evaluate((el) => el.scrollTop);
    await page.getByTestId('viewer-container').evaluate((el) => el.scrollBy(0, 5000));
    await tb(page).waitHidden();
    // And it must not be sitting over the header or outside the viewer when it is shown again.
    await page.getByTestId('viewer-container').evaluate((el, y) => (el.scrollTop = y), top);
    await tb(page).waitShown();
    const again = await tb(page).box();
    const word = await selectionBox();
    expect(again.y).toBeGreaterThanOrEqual(viewer.y - 1);
    expect(again.y + again.height).toBeLessThanOrEqual(viewer.y + viewer.height + 1);
    expect(Math.abs(again.x + again.width / 2 - (word.x + word.width / 2))).toBeLessThan(
      again.width,
    );
  });

  test('a zoom change clears the selection (PDF.js rebuilds the text) and the toolbar goes with it', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    const since = await page.locator('.reader').getAttribute('data-render-count');
    await page.getByTestId('zoom-select').selectOption('1.5');
    await waitForRendersToSettle(page, { since: Number(since) });
    expect(await page.evaluate(() => document.getSelection()?.toString().trim())).toBe('');
    // No orphaned toolbar floating over the re-rendered page.
    await tb(page).waitHidden();
    // Selecting again at the new zoom works and the toolbar sits next to the word.
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    const word = await page.evaluate(() => {
      const r = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const box = await tb(page).box();
    expect(Math.abs(box.x + box.width / 2 - (word.x + word.width / 2))).toBeLessThan(box.width);
    expect(Math.abs(box.y - word.y)).toBeLessThan(80);
  });
});

test.describe('What does not show the toolbar', () => {
  test('Escape dismisses it; text outside the pages and the find box never show it', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();

    // The reader's own heading is not PDF text.
    await page.getByRole('heading', { level: 1 }).dblclick();
    await page.waitForTimeout(400);
    expect(await tb(page).isShown()).toBe(false);

    // Typing in the find box and selecting its text is not a PDF selection either.
    await page.keyboard.press('Control+f');
    const find = page.getByTestId('find-input');
    await find.fill('cartographer');
    await find.selectText();
    await page.waitForTimeout(400);
    expect(await tb(page).isShown()).toBe(false);
  });

  test('image-only pages offer nothing to select, so no toolbar', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await page.getByTestId('file-input').setInputFiles('tests/fixtures/pdf/image-only.pdf');
    await waitForPhase(page, 'image-only');
    await page.mouse.dblclick(500, 400);
    await page.waitForTimeout(400);
    expect(await tb(page).isShown()).toBe(false);
  });
});

test.describe('Keyboard path', () => {
  test('the background keyboard command (Alt+Shift+E) shows the toolbar for the selection and moves focus into it', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openContextPdf(session);
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    // The Alt+Shift+E path (CLAVIS_OPEN_SELECTION from the background) moves focus into the toolbar.
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await selectWordByDoubleClick(page, CONTEXT_WORD, 2);
    await tb(page).waitShown();
    // The service worker knows no tab URLs without the `tabs` permission: try every tab; only the
    // reader answers (the others have no listener).
    const reply = await serviceWorker.evaluate(
      async (message) => {
        const api = globalThis as unknown as {
          chrome: {
            tabs: {
              query(q: object): Promise<Array<{ id?: number }>>;
              sendMessage(id: number, m: unknown): Promise<unknown>;
            };
          };
        };
        for (const tab of await api.chrome.tabs.query({})) {
          try {
            const answer = await api.chrome.tabs.sendMessage(tab.id!, message);
            if (answer) return answer;
          } catch {
            // no listener in this tab
          }
        }
        return null;
      },
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
    );
    expect(reply).toMatchObject({ ok: true, shown: true });
    await expect.poll(() => tb(page).focusedAction()).toBe('explain');
  });
});
