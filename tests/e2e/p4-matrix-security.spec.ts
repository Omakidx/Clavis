import { expect, test, type Page } from '@playwright/test';
import { expectShown, logWorkerMessages, resetPage, selectText } from './p4-matrix-support/actions';
import { openPath, startHarness, type Harness } from './p4-matrix-support/harness';
import { frameOffset, hostShown } from './p4-matrix-support/page';
import { clickAction, readCardText, SEL, toolbar } from './p4-matrix-support/toolbar';

// Security regressions, black box (docs/decisions/phase-2-security-review.md HIGH-1, requirements
// section 8): a hostile page must not be able to raise the toolbar, press its buttons, find its
// shadow root or read what it shows, and text it selects is only ever rendered as text.
// Real Playwright input is used wherever a real user is meant; synthetic events are the attack.

let harness: Harness;
test.beforeAll(async () => {
  harness = await startHarness();
});
test.afterAll(async () => {
  await harness?.close();
});

interface PageLog {
  attachShadow: number;
  defined: string[];
  upgraded: string[];
  added: string[];
  leaks: string[];
}

const readLog = (page: Page): Promise<PageLog> =>
  page.evaluate(() => (window as unknown as { __log: PageLog }).__log);

async function openHostile(): Promise<{ page: Page; dispose(): Promise<void> }> {
  const opened = await openPath(harness.ext.context, harness.server, 'sec-hostile.html');
  return { page: opened.page, dispose: () => opened.close() };
}

test('a page-made selection plus every synthetic event never raises the toolbar', async () => {
  const { page, dispose } = await openHostile();
  try {
    const log = await logWorkerMessages(harness.ext.serviceWorker);
    await page.evaluate(() =>
      (window as unknown as { attackProgrammatically(): void }).attackProgrammatically(),
    );
    await page.waitForTimeout(1200);
    expect(await page.evaluate(() => getSelection()?.toString())).toContain('SECRET-WORDS');
    expect(await hostShown(page)).toBe(false);
    // The toolbar was never even created: there is nothing for the page to find or click.
    await toolbar(page).expectNoHost();
    expect((await log.read()).filter((m) => m.fromTab)).toEqual([]);
  } finally {
    await dispose();
  }
});

test('with a toolbar showing, the page gets no shadow root, cannot press or dismiss it, and sees no text', async () => {
  const { page, dispose } = await openHostile();
  try {
    const log = await logWorkerMessages(harness.ext.serviceWorker);
    await selectText(
      page,
      page,
      { context: 'selects another word here', text: 'another' },
      'dblclick',
    );
    expect(await expectShown(page)).toBe(true);

    // The page aims synthetic clicks at the middle of the Explain button.
    const [box, offset] = await Promise.all([
      toolbar(page).box(SEL.action('explain')),
      frameOffset(page),
    ]);
    await page.evaluate(
      ([x, y]) => {
        const w = window as unknown as { __probeX: number; __probeY: number };
        w.__probeX = x as number;
        w.__probeY = y as number;
      },
      [offset.x + box.x + box.width / 2, offset.y + box.y + box.height / 2],
    );
    const result = await page.evaluate(() =>
      (window as unknown as { attackToolbar(): Record<string, unknown> }).attackToolbar(),
    );
    await page.waitForTimeout(400);

    expect(result['hostShadowRoot'], 'host.shadowRoot as the page sees it').toBe('null');
    expect(result['shadowRootsFound'], 'any element of the page exposing a shadow root').toBe(0);
    expect(result['hitInner'], 'elementFromPoint over the buttons reveals only the host').toBe(
      false,
    );
    expect(result['hostHtml']).toBe('');
    expect(result['hostText']).toBe('');
    expect(await toolbar(page).pageSeesShadowRoot()).toBe(false);

    // Nothing was pressed (no card) and a synthetic Escape did not dismiss it.
    expect(await toolbar(page).isShown(SEL.card)).toBe(false);
    expect(await toolbar(page).isShown()).toBe(true);
    expect(
      (await log.read()).filter((m) => m.fromTab),
      'no action reached the background',
    ).toEqual([]);

    const pageLog = await readLog(page);
    expect(pageLog.leaks).toEqual([]);
    expect(pageLog.upgraded, 'no pre-defined custom element was upgraded into the host').toEqual(
      [],
    );
    expect(pageLog.attachShadow, 'the page-world attachShadow patch never saw the extension').toBe(
      0,
    );

    // A real click still works, and the card text stays invisible to the page.
    await clickAction(page, 'explain');
    expect(await readCardText(page)).toBe('another');
    const pageView = await page.evaluate(() => {
      const host = document.querySelector(':root > div[popover]') as HTMLElement;
      return {
        html: host.innerHTML,
        text: host.textContent,
        shadow: host.shadowRoot === null,
        attributes: Array.from(host.attributes, (a) => a.name).sort(),
      };
    });
    expect(pageView).toEqual({
      html: '',
      text: '',
      shadow: true,
      attributes: ['popover', 'style'],
    });
    const afterLog = await readLog(page);
    expect(afterLog.leaks).toEqual([]);
    expect(
      afterLog.added.filter((tag) => tag !== 'SCRIPT'),
      'the page only ever saw one added element',
    ).toEqual(['DIV']);
  } finally {
    await dispose();
  }
});

test('the host is a plain div: no custom tag name, id, class or data attributes for page code to single out', async () => {
  const { page, dispose } = await openHostile();
  try {
    await selectText(
      page,
      page,
      { context: 'selects another word here', text: 'another' },
      'dblclick',
    );
    expect(await expectShown(page)).toBe(true);
    const host = await page.evaluate(() => {
      const el = document.querySelector(':root > div[popover]') as HTMLElement;
      return {
        tag: el.localName,
        isCustom: el.localName.includes('-'),
        id: el.id,
        className: el.className,
        dataset: Object.keys(el.dataset),
        childCount: el.childElementCount,
      };
    });
    expect(host).toEqual({
      tag: 'div',
      isCustom: false,
      id: '',
      className: '',
      dataset: [],
      childCount: 0,
    });
  } finally {
    await dispose();
  }
});

test('text with HTML in it is shown as text: no element is created and no handler runs', async () => {
  const { page, dispose } = await openHostile();
  try {
    await selectText(
      page,
      page,
      {
        context: 'Beware of <img src=x onerror="window.__xss=1"> and <b>bold</b> text',
        text: '<img src=x onerror="window.__xss=1"> and <b>bold</b>',
      },
      'drag',
    );
    expect(await expectShown(page)).toBe(true);
    await clickAction(page, 'explain');
    expect(await readCardText(page)).toBe('<img src=x onerror="window.__xss=1"> and <b>bold</b>');
    const elementsInCard = await toolbar(page).evalIn<number>(
      SEL.card,
      `function () { return this.querySelectorAll('img, b, script, iframe, [onerror]').length; }`,
    );
    expect(elementsInCard, 'card renders the selection as text only').toBe(0);
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
  } finally {
    await dispose();
  }
});

test('a hostile page cannot start AI or speech traffic: no message from the page reaches the background and nothing goes to Groq', async () => {
  const { page, dispose } = await openHostile();
  try {
    const log = await logWorkerMessages(harness.ext.serviceWorker);
    const before = harness.groqRequests.length;
    await page.evaluate(() =>
      (window as unknown as { attackProgrammatically(): void }).attackProgrammatically(),
    );
    await page.waitForTimeout(500);
    // A real user clicks away from whatever the page selected before selecting a word; start from
    // a clean state so a slow machine cannot turn this into a timing race.
    await resetPage(page);
    await selectText(
      page,
      page,
      { context: 'selects another word here', text: 'another' },
      'dblclick',
    );
    expect(await expectShown(page, 8000)).toBe(true);
    await page.evaluate(() => (window as unknown as { attackToolbar(): unknown }).attackToolbar());
    await page.waitForTimeout(500);
    expect(harness.groqRequests.slice(before)).toEqual([]);
    expect((await log.read()).filter((m) => /^(AI|TTS)/.test(m.type ?? ''))).toEqual([]);
  } finally {
    await dispose();
  }
});
