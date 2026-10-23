import { expect, test, type Frame, type Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import {
  dblclickText,
  dragSelect,
  expectNear,
  frameOffset,
  keyboardExtend,
  selectedText,
  selectionBox,
  trackGroqRequests,
  trackWorlds,
  type Box,
} from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { SEL, tb } from './spike-b-support/toolbar';

// Spike B, site access GRANTED path: observer registered at runtime (D-02), selection by
// mouse and keyboard, toolbar placement and dismissal on several layouts (FR-010..FR-014),
// and no Groq traffic on selection alone (FR-017).

let server: FixtureServer;
let ext: LaunchedExtension;
let groqRequests: string[];

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  groqRequests = trackGroqRequests(ext.context);
  await waitForRegistration(ext.serviceWorker);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

async function open(path: string): Promise<{ page: Page; dispose(): Promise<void> }> {
  const page = await ext.context.newPage();
  const worlds = await trackWorlds(page);
  await page.goto(`${server.origin}/${path}`);
  await worlds.waitForObserver();
  return {
    page,
    async dispose() {
      await worlds.dispose();
      await page.close();
    },
  };
}

function viewportOf(page: Page): { width: number; height: number } {
  return page.viewportSize() ?? { width: 1280, height: 720 };
}

const toolbarBox = (target: Page | Frame): Promise<Box> => tb(target).box();

/** Toolbar and selection are compared in the same (top-page) coordinate space. */
async function expectToolbarNearSelection(page: Page, target: Page | Frame = page): Promise<void> {
  const [toolbar, selection, offset] = await Promise.all([
    toolbarBox(target),
    selectionBox(target),
    frameOffset(target),
  ]);
  expect(selection, 'there is a selection').not.toBeNull();
  const sel = selection as Box;
  // The probe reports the toolbar in its own frame's viewport (Playwright used to give page
  // coordinates); move both into the top page's space.
  const problems = expectNear(
    { ...toolbar, x: toolbar.x + offset.x, y: toolbar.y + offset.y },
    { ...sel, x: sel.x + offset.x, y: sel.y + offset.y },
    viewportOf(page),
  );
  expect(problems, `toolbar placement: ${problems.join(', ')}`).toEqual([]);
}

test.describe('registration (D-02)', () => {
  test('the manifest has no static content scripts and the observer is registered at runtime', async () => {
    const manifest = (await ext.serviceWorker.evaluate('chrome.runtime.getManifest()')) as Record<
      string,
      unknown
    >;
    expect(manifest).not.toHaveProperty('content_scripts');
    const scripts = (await ext.serviceWorker.evaluate(
      'chrome.scripting.getRegisteredContentScripts()',
    )) as Array<Record<string, unknown>>;
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatchObject({
      id: 'clavis-observer',
      js: ['content-scripts/content.js'],
      matches: ['http://*/*', 'https://*/*'],
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    });
  });
});

type Layout = {
  name: string;
  path: string;
  word: string;
  phrase: readonly [string, string];
  keyboard: readonly [string, number];
  forward?: 'ArrowLeft';
};

const LAYOUTS: Layout[] = [
  {
    name: 'plain article',
    path: 'article.html',
    word: 'cartographer',
    phrase: ['detailed', 'building'] as const,
    keyboard: ['neighbours', 10] as const,
  },
  {
    name: 'nested inline markup',
    path: 'nested.html',
    word: 'unbreakable',
    phrase: ['carefully', 'inside'] as const,
    keyboard: ['Second list', 8] as const,
  },
  {
    name: 'scroll container',
    path: 'scroll-container.html',
    word: 'lighthouse',
    phrase: ['harbour', 'islands'] as const,
    keyboard: ['Item 4', 6] as const,
  },
  {
    name: 'fixed header and long page',
    path: 'fixed-header.html',
    word: 'lantern',
    phrase: ['harvest', 'square'] as const,
    keyboard: ['Paragraph 2', 11] as const,
  },
  {
    name: 'right-to-left text',
    path: 'rtl.html',
    word: 'المكتبة',
    phrase: ['الكتب', 'القصص'] as const,
    keyboard: ['הספרייה', 5] as const,
    forward: 'ArrowLeft' as const,
  },
];

for (const layout of LAYOUTS) {
  test(`${layout.name}: toolbar follows double-click, drag and keyboard selection, and Escape dismisses it`, async () => {
    const { page, dispose } = await open(layout.path);
    try {
      await test.step('double-click a word', async () => {
        await dblclickText(page, page, layout.word);
        await tb(page).waitShown();
        await expect.poll(() => selectedText(page)).toContain(layout.word);
        await expectToolbarNearSelection(page);
      });

      await test.step('Escape dismisses and the same selection does not bring it back', async () => {
        await page.keyboard.press('Escape');
        await tb(page).waitHidden();
        await page.waitForTimeout(250);
        await tb(page).waitHidden();
      });

      await test.step('drag-select a phrase', async () => {
        await dragSelect(page, page, layout.phrase[0], layout.phrase[1]);
        await tb(page).waitShown();
        await expectToolbarNearSelection(page);
      });

      await test.step('a click elsewhere dismisses it', async () => {
        await page.mouse.click(5, 5);
        await tb(page).waitHidden();
      });

      await test.step('keyboard: Shift+Arrow grows a selection and the toolbar follows', async () => {
        await keyboardExtend(page, page, layout.keyboard[0], layout.keyboard[1], layout.forward);
        const grown = (await selectedText(page)).length;
        expect(grown).toBeGreaterThan(layout.keyboard[0].length);
        await tb(page).waitShown();
        await expectToolbarNearSelection(page);
      });

      await test.step('clicking a toolbar button keeps the captured snapshot', async () => {
        const text = (await selectedText(page)).replace(/\s+/g, ' ').trim();
        await tb(page).click('explain');
        await tb(page).waitShown(SEL.card);
        expect(await tb(page).attr(SEL.card, 'data-action')).toBe('explain');
        expect(await tb(page).text(SEL.cardText)).toBe(text);
        await tb(page).waitShown();
      });
    } finally {
      await dispose();
    }
  });
}

test.describe('toolbar behaviour', () => {
  test('keeps the snapshot even when the click collapses the selection before the toolbar sees it (FR-014)', async () => {
    const { page, dispose } = await open('article.html');
    try {
      // The page clears the selection on the very first mousedown, like sites that reset it on click.
      await page.evaluate(() => {
        document.addEventListener('mousedown', () => getSelection()?.removeAllRanges(), true);
      });
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toBe('cartographer');
      expect(await selectedText(page)).toBe('');
      // The collapse did not dismiss the toolbar while the pointer was on it.
      await page.waitForTimeout(150);
      await tb(page).waitShown();
      // Once the interaction is over, clicking the page dismisses it as usual.
      await page.mouse.click(5, 5);
      await tb(page).waitHidden();
    } finally {
      await dispose();
    }
  });

  test('a keyboard-only selection (Ctrl+A) shows the toolbar and captures a passage', async () => {
    const { page, dispose } = await open('article.html');
    try {
      await page.keyboard.press('Control+a');
      await tb(page).waitShown();
      expect(await tb(page).attr(SEL.panel, 'data-kind')).toBe('passage');
      await expectToolbarNearSelection(page);
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toContain('The Old Bank on the River');
    } finally {
      await dispose();
    }
  });

  test('the toolbar is keyboard operable: focus, arrows, Enter, Escape', async () => {
    const { page, dispose } = await open('article.html');
    try {
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).focusAction('listen');
      // Since Phase 6 the order is Listen, Slow, Explain.
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => tb(page).focusedAction()).toBe('slow');
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => tb(page).focusedAction()).toBe('explain');
      await page.keyboard.press('Enter');
      await expect.poll(() => tb(page).attr(SEL.card, 'data-action')).toBe('explain');
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
    } finally {
      await dispose();
    }
  });

  test('exposes accessible names and roles', async () => {
    const { page, dispose } = await open('article.html');
    try {
      await dblclickText(page, page, 'cartographer');
      // The root is closed, so Playwright's role queries cannot see in: read the same
      // semantics straight from the nodes.
      await tb(page).waitShown();
      expect(await tb(page).attr(SEL.toolbar, 'role')).toBe('toolbar');
      expect(await tb(page).attr(SEL.toolbar, 'aria-label')).toBe(
        'Clavis actions for the selected text',
      );
      expect(await tb(page).text(SEL.action('listen'))).toBe('Listen');
      expect(await tb(page).text(SEL.action('explain'))).toBe('Explain');
      const tags = await tb(page).evalIn<string[]>(
        SEL.toolbar,
        `function () { return Array.from(this.children, (c) => c.tagName + ':' + c.getAttribute('type')); }`,
      );
      expect(tags).toEqual(['BUTTON:button', 'BUTTON:button', 'BUTTON:button']);
    } finally {
      await dispose();
    }
  });

  test('follows the selection when the page scrolls, and hides when it scrolls away', async () => {
    const { page, dispose } = await open('article.html');
    try {
      await page.setViewportSize({ width: 900, height: 300 });
      await dblclickText(page, page, 'stood');
      await tb(page).waitShown();
      const before = await toolbarBox(page);
      await page.evaluate(() => scrollBy(0, 40));
      await expect.poll(async () => (await toolbarBox(page)).y).toBeCloseTo(before.y - 40, 0);
      await expectToolbarNearSelection(page);
      await page.evaluate(() => scrollBy(0, 4000));
      await tb(page).waitHidden();
      await page.evaluate(() => scrollTo(0, 0));
      await tb(page).waitShown();
    } finally {
      await dispose();
    }
  });

  test('follows the selection when a scroll container scrolls', async () => {
    const { page, dispose } = await open('scroll-container.html');
    try {
      await dblclickText(page, page, 'lighthouse');
      await tb(page).waitShown();
      const before = await toolbarBox(page);
      await page.evaluate(() => document.getElementById('scroller')?.scrollBy(0, 30));
      await expect.poll(async () => (await toolbarBox(page)).y).toBeCloseTo(before.y - 30, 0);
      await expectToolbarNearSelection(page);
    } finally {
      await dispose();
    }
  });

  test('stays on top of page elements with an extreme z-index (top layer) and keeps clear of a fixed header', async () => {
    const { page, dispose } = await open('fixed-header.html');
    try {
      // The first paragraph sits just under the 64px header: there is room above the text only
      // on top of the header, so the toolbar goes below the line instead of onto the header.
      await page.evaluate(() => scrollTo(0, 30));
      await dblclickText(page, page, 'harvest');
      await tb(page).waitShown();
      const box = await toolbarBox(page);
      expect(box.y).toBeGreaterThanOrEqual(64);
      await expectToolbarNearSelection(page);

      // Top layer: a page element with the maximum z-index laid over the whole viewport still
      // sits BELOW the toolbar.
      await page.evaluate(() => {
        const overlay = document.createElement('div');
        overlay.style.cssText =
          'position:fixed;inset:0;z-index:2147483647;background:rgb(255 0 0 / 10%)';
        document.body.append(overlay);
      });
      const topIsToolbarHost = await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.matches(':root > div[popover]') === true,
        { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      );
      expect(topIsToolbarHost).toBe(true);
    } finally {
      await dispose();
    }
  });

  test('stays inside the viewport at every corner', async () => {
    const { page, dispose } = await open('placement.html');
    try {
      for (const word of ['topleft', 'topright', 'bottomleft', 'bottomright']) {
        await dblclickText(page, page, word);
        await tb(page).waitShown();
        await expectToolbarNearSelection(page);
        await page.keyboard.press('Escape');
        await tb(page).waitHidden();
      }
      // Rotated text: placement uses the rotated line box.
      await dblclickText(page, page, 'rotated');
      await tb(page).waitShown();
      await expectToolbarNearSelection(page);
    } finally {
      await dispose();
    }
  });

  test('fits a narrow viewport (the equivalent of 300% browser zoom on a laptop)', async () => {
    const { page, dispose } = await open('article.html');
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.reload();
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await expectToolbarNearSelection(page);
    } finally {
      await dispose();
    }
  });

  test('RTL: the toolbar takes the selection direction', async () => {
    const { page, dispose } = await open('rtl.html');
    try {
      await dblclickText(page, page, 'المكتبة');
      await tb(page).waitShown();
      const dir = await tb(page).evalIn<string>(
        null,
        `function () { return this.firstElementChild.getAttribute('dir'); }`,
      );
      expect(dir).toBe('rtl');
    } finally {
      await dispose();
    }
  });

  test('ignores inputs, password fields, textareas, contenteditable and hidden text', async () => {
    const { page, dispose } = await open('fields.html');
    try {
      for (const id of ['text', 'password', 'area']) {
        await page.locator(`#${id}`).focus();
        await page.keyboard.press('Control+a');
      }
      await page.locator('#editable').focus();
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Shift+End');
      await page.waitForTimeout(400);
      await tb(page).expectNoHost();

      await page.locator('#editable').dblclick();
      await page.waitForTimeout(400);
      await tb(page).expectNoHost();

      // Hidden text can only be selected programmatically.
      await page.evaluate(() => {
        for (const id of ['hidden', 'invisible']) {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById(id) as Element);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        }
      });
      await page.waitForTimeout(400);
      await tb(page).expectNoHost();

      // Control: ordinary text on the same page works.
      await dblclickText(page, page, 'Normal');
      await tb(page).waitShown();
    } finally {
      await dispose();
    }
  });
});

test.describe('iframes', () => {
  async function openFrames() {
    const { page, dispose } = await open('iframe.html');
    await page.waitForLoadState('load');
    return { page, dispose };
  }

  /**
   * Cross-origin frames are out-of-process, so readiness cannot be read over CDP:
   * keep selecting until the frame's observer answers.
   */
  async function selectUntilToolbar(page: Page, frame: Frame, word: string): Promise<void> {
    await expect(async () => {
      await dblclickText(page, frame, word);
      await tb(frame).waitShown(SEL.toolbar, 700);
    }).toPass({ timeout: 10_000 });
  }

  for (const [label, selector, word] of [
    ['same-origin', '#same', 'lighthouse'],
    ['cross-origin', '#cross', 'harbour'],
    ['srcdoc', '#srcdoc', 'lantern'],
  ] as const) {
    test(`${label} iframe: the frame's own observer shows the toolbar next to the selection`, async () => {
      const { page, dispose } = await openFrames();
      try {
        const frame = await (await page.locator(selector).elementHandle())!.contentFrame();
        expect(frame).not.toBeNull();
        await selectUntilToolbar(page, frame as Frame, word);
        await expectToolbarNearSelection(page, frame as Frame);
        // The toolbar belongs to the frame, not the top page.
        await tb(page).expectNoHost();
        await page.keyboard.press('Escape');
        await tb(page).waitHidden();
      } finally {
        await dispose();
      }
    });
  }

  test('the top document of an iframe page still works', async () => {
    const { page, dispose } = await openFrames();
    try {
      await dblclickText(page, page, 'anchor');
      await tb(page).waitShown();
      await expectToolbarNearSelection(page);
    } finally {
      await dispose();
    }
  });
});

test.describe('FR-017: no network call on selection alone', () => {
  test('selecting, dismissing, clicking Listen and clicking Explain produce no Groq request', async () => {
    // Positive control first: prove the tracker would see a Groq request, from a page and from the worker.
    await ext.context.route('https://api.groq.com/**', (route) => route.abort());
    const control = await ext.context.newPage();
    await control.goto(`${server.origin}/article.html`);
    await control.evaluate(() => fetch('https://api.groq.com/openai/v1/models').catch(() => null));
    await ext.serviceWorker.evaluate(() =>
      fetch('https://api.groq.com/openai/v1/models').catch(() => null),
    );
    await control.close();
    expect(groqRequests.length, 'tracker sees page and worker requests').toBeGreaterThanOrEqual(2);
    groqRequests.length = 0;

    const { page, dispose } = await open('article.html');
    try {
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await dragSelect(page, page, 'detailed', 'building');
      await tb(page).waitShown();
      await tb(page).click('listen');
      await tb(page).click('explain');
      await tb(page).waitShown(SEL.card);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } finally {
      await dispose();
    }
    expect(groqRequests).toEqual([]);
    // The page loaded nothing but its own fixture (the browser may ask for a favicon).
    expect(server.requests.every((path) => path.endsWith('.html') || path === '/favicon.ico')).toBe(
      true,
    );
  });
});

test.describe('restricted pages', () => {
  test('chrome://extensions is not injected and the fallback route answers "restricted" without throwing', async () => {
    const restricted = await ext.context.newPage();
    const errors: string[] = [];
    restricted.on('pageerror', (error) => errors.push(error.message));
    await restricted.goto('chrome://extensions');
    await restricted.waitForTimeout(500);
    await restricted.bringToFront();

    const helper = await ext.context.newPage();
    await helper.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await restricted.bringToFront();
    const tabId = (await ext.serviceWorker.evaluate(
      `chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0].id)`,
    )) as number;

    // With the URL (what the popup passes) and without it (the real attempt decides).
    for (const url of ['chrome://extensions/', undefined]) {
      const reply = await helper.evaluate(
        ({ id, pageUrl }) =>
          chrome.runtime.sendMessage({
            v: 1,
            type: 'CLAVIS_INJECT_TAB',
            tabId: id,
            ...(pageUrl === undefined ? {} : { url: pageUrl }),
          }),
        { id: tabId, pageUrl: url },
      );
      expect(reply).toEqual({ ok: false, reason: 'restricted' });
    }
    expect(errors).toEqual([]);
    await helper.close();
    await restricted.close();
  });

  test('the Chrome Web Store is treated as restricted without an injection attempt', async () => {
    const helper = await ext.context.newPage();
    await helper.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    const reply = await helper.evaluate(() =>
      chrome.runtime.sendMessage({
        v: 1,
        type: 'CLAVIS_INJECT_TAB',
        tabId: 1,
        url: 'https://chromewebstore.google.com/detail/x',
      }),
    );
    expect(reply).toEqual({ ok: false, reason: 'restricted' });
    await helper.close();
  });
});

test.describe('on-demand injection into the current tab (the activeTab path, same code)', () => {
  test('injecting where the observer already runs does not duplicate the toolbar and opens the existing selection', async () => {
    const { page, dispose } = await open('article.html');
    try {
      // A selection made without any pointer or keyboard event the observer listens to.
      await page.evaluate(() => {
        const node = document.getElementById('p2')?.firstChild as Text;
        const range = document.createRange();
        range.setStart(node, 5);
        range.setEnd(node, 20);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
      const helper = await ext.context.newPage();
      await helper.goto(`chrome-extension://${ext.extensionId}/popup.html`);
      await page.bringToFront();
      const tabId = (await ext.serviceWorker.evaluate(
        `chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0].id)`,
      )) as number;
      const reply = await helper.evaluate(
        (id) => chrome.runtime.sendMessage({ v: 1, type: 'CLAVIS_INJECT_TAB', tabId: id }),
        tabId,
      );
      expect(reply).toEqual({ ok: true, shown: true });
      expect(await tb(page).hostCount()).toBe(1);
      await tb(page).waitShown();
      await helper.close();
    } finally {
      await dispose();
    }
  });
});
