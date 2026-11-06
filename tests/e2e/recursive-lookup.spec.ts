import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { CARD, cardOf, type CardProbe, chatBody, overrideChat } from './p5-card-support/harness';
import { startCardHarness } from './p5-card-support/harness';
import { dblclickText, frameOffset } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';

const RESULT_TEXT = '[data-clavis="card-result-text"]';
const LOOKUP = '[data-clavis="card-lookup"]';
const BACK = '[data-clavis="card-back"]';
const ARTICLE_CONTEXT = 'A cartographer named Ingrid Halvorsen offered to draw';
const PRACTICE_CONTEXT = 'They sat on the bank of the river';

interface PromptRecord {
  mode: string;
  selected: string;
  messages: { role: string; content: string }[];
}

interface ResultBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Return the visible bounds of an exact word inside the card's closed shadow root. */
async function resultWordBox(card: CardProbe, word: string) {
  const escaped = JSON.stringify(word);
  const box = await card.toolbar.evalIn<ResultBox | null>(
    null,
    `function () {
      const wanted = ${escaped};
      const leaves = Array.from(this.querySelectorAll(${JSON.stringify(RESULT_TEXT)}));
      for (const leaf of leaves) {
        const walker = leaf.ownerDocument.createTreeWalker(leaf, NodeFilter.SHOW_TEXT);
        const nodes = [];
        let full = '';
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          nodes.push(node);
          full += node.data;
        }
        const start = full.indexOf(wanted);
        if (start < 0) continue;
        const end = start + wanted.length;
        let offset = 0;
        let startNode = null;
        let endNode = null;
        let startOffset = 0;
        let endOffset = 0;
        for (const node of nodes) {
          if (startNode === null && start < offset + node.data.length) {
            startNode = node;
            startOffset = start - offset;
          }
          if (end <= offset + node.data.length) {
            endNode = node;
            endOffset = end - offset;
            break;
          }
          offset += node.data.length;
        }
        if (startNode === null || endNode === null) continue;
        const range = leaf.ownerDocument.createRange();
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return null;
    }`,
  );
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`No visible result word: ${word}`);
  return box;
}

/** Use trusted physical mouse input so the card sees the same selection event as a reader. */
async function selectGeneratedWord(
  page: Page,
  target: Page | Frame,
  card: CardProbe,
  word: string,
) {
  const box = await resultWordBox(card, word);
  const offset = await frameOffset(target);
  await page.mouse.dblclick(offset.x + box.x + box.width / 2, offset.y + box.y + box.height / 2);
}

async function programmaticallySelectPageText(page: Page, text: string): Promise<boolean> {
  return page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(needle) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    }
    return false;
  }, text);
}

async function practiceArticleFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((frame) => frame.url() === 'about:srcdoc')).toBe(true);
  const frame = page.frames().find((candidate) => candidate.url() === 'about:srcdoc');
  if (!frame) throw new Error('Practice article frame did not load.');
  await frame.locator('article p').first().waitFor();
  return frame;
}

async function installRecursiveAnswerFixture(context: BrowserContext): Promise<PromptRecord[]> {
  const prompts: PromptRecord[] = [];
  await overrideChat(context, async (route, mode, selected) => {
    const request = route.request().postDataJSON() as {
      messages: { role: string; content: string }[];
    };
    prompts.push({ mode, selected, messages: request.messages });
    const next =
      selected === 'cartographer' || selected === 'bank'
        ? 'branchone'
        : selected === 'branchone'
          ? 'branchtwo'
          : `leaf-${selected}`;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(
        JSON.stringify({
          title: `Meaning of ${selected}`,
          summary: `Follow ${next} for the next lookup.`,
          contextualMeaning: `This result explains ${selected}.`,
          definition: `A definition of ${selected}.`,
          examples: [
            { sentence: `A clear example with ${selected}.`, note: null },
            { sentence: `Another example with ${selected}.`, note: null },
          ],
          caveat: null,
        }),
      ),
    });
  });
  return prompts;
}

test('Lookup opens recursive results in one card and Back restores cached parents', async () => {
  const harness = await startCardHarness();
  const prompts = await installRecursiveAnswerFixture(harness.ext.context);

  try {
    const { page, dispose } = await harness.open('article.html?recursive-lookup=1');
    try {
      const toolbar = tb(page);
      let card = await (async () => {
        await dblclickText(page, page, 'cartographer');
        await toolbar.waitShown();
        await toolbar.click('explain');
        const result = cardOf(page);
        await result.waitFor(CARD.ready('core'));
        return result;
      })();
      const initialTabs = await card.tabs();
      expect(await card.toolbar.hostCount()).toBe(1);
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer']);

      // An untrusted event cannot arm Lookup, and selecting a result word alone never sends it.
      await card.toolbar.evalIn(
        RESULT_TEXT,
        `function () {
        this.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
      }`,
      );
      expect(await card.exists(LOOKUP)).toBe(false);
      await selectGeneratedWord(page, page, card, 'branchone');
      await card.waitFor(LOOKUP);
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer']);

      // Replacing the selected range from page script cannot turn a stale candidate into Lookup.
      expect(await programmaticallySelectPageText(page, ARTICLE_CONTEXT)).toBe(true);
      if (await card.exists(LOOKUP)) await card.click(LOOKUP);
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer']);

      // Restore the original card after the outside selection; reopening the cached parent is free.
      await dblclickText(page, page, 'cartographer');
      await toolbar.waitShown();
      await toolbar.click('explain');
      card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer']);

      // A fresh trusted selection in the result leaf is still accepted.
      await selectGeneratedWord(page, page, card, 'branchone');
      await card.waitFor(LOOKUP);
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer']);
      await card.click(LOOKUP);
      await expect.poll(() => prompts.length).toBe(2);
      await card.waitFor(CARD.ready('core'));
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer', 'branchone']);
      expect(await card.toolbar.hostCount()).toBe(1);

      // A second generated answer can itself be selected for another child lookup.
      await selectGeneratedWord(page, page, card, 'branchtwo');
      await card.waitFor(LOOKUP);
      expect(prompts.map((prompt) => prompt.selected)).toEqual(['cartographer', 'branchone']);
      if (process.env['CLAVIS_CAPTURE_LOOKUP'] === '1') {
        await page.screenshot({ path: '/tmp/clavis-recursive-lookup.png' });
      }
      await card.click(LOOKUP);
      await expect.poll(() => prompts.length).toBe(3);
      await card.waitFor(CARD.ready('core'));
      expect(prompts.map((prompt) => prompt.selected)).toEqual([
        'cartographer',
        'branchone',
        'branchtwo',
      ]);
      expect(await card.toolbar.hostCount()).toBe(1);

      // Recursive child prompts use the chosen leaf, with no original page context or language hint.
      for (const prompt of prompts.slice(1)) {
        const user = prompt.messages.find((message) => message.role === 'user')?.content ?? '';
        expect(user).toContain(prompt.selected);
        expect(user).not.toContain(ARTICLE_CONTEXT);
        expect(user).not.toContain('Language hint:');
      }

      // Back walks one cached parent at a time; it does not ask Groq again or remove the card.
      await card.click(BACK);
      await card.waitFor(CARD.ready('core'));
      expect(await card.text(CARD.panel('core'))).toContain('Meaning of branchone');
      expect(await card.tabs()).toEqual(initialTabs);
      expect(await card.toolbar.hostCount()).toBe(1);
      expect(prompts.map((prompt) => prompt.selected)).toHaveLength(3);

      await card.click(BACK);
      await card.waitFor(CARD.ready('core'));
      expect(await card.text(CARD.panel('core'))).toContain('Meaning of cartographer');
      expect(await card.tabs()).toEqual(initialTabs);
      expect(await card.toolbar.hostCount()).toBe(1);
      expect(prompts.map((prompt) => prompt.selected)).toHaveLength(3);
    } finally {
      await dispose();
    }
  } finally {
    await harness.close();
  }
});

test('Lookup works inside the practice iframe and keeps the child request isolated to the result', async () => {
  const harness = await startCardHarness();
  const prompts = await installRecursiveAnswerFixture(harness.ext.context);
  const practice = await harness.ext.context.newPage();
  try {
    await practice.goto(`chrome-extension://${harness.ext.extensionId}/practice.html`);
    const frame = await practiceArticleFrame(practice);
    await dblclickText(practice, frame, 'bank');
    const toolbar = tb(frame);
    await toolbar.waitShown();
    await toolbar.click('explain');

    const card = cardOf(practice, frame);
    await card.waitFor(CARD.ready('core'));
    expect(await card.toolbar.hostCount()).toBe(1);
    expect(prompts.map((prompt) => prompt.selected)).toEqual(['bank']);

    await selectGeneratedWord(practice, frame, card, 'branchone');
    await card.waitFor(LOOKUP);
    expect(prompts.map((prompt) => prompt.selected)).toEqual(['bank']);
    await card.click(LOOKUP);
    await card.waitFor(CARD.ready('core'));
    expect(prompts.map((prompt) => prompt.selected)).toEqual(['bank', 'branchone']);
    expect(await card.text(CARD.panel('core'))).toContain('Meaning of branchone');
    expect(await card.toolbar.hostCount()).toBe(1);

    const childUser =
      prompts[1]?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(childUser).toContain('branchone');
    expect(childUser).not.toContain(PRACTICE_CONTEXT);
    expect(childUser).not.toContain('Language hint:');
  } finally {
    await practice.close();
    await harness.close();
  }
});
