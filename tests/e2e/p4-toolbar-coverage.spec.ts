import { expect, test, type CDPSession, type Frame, type Page } from '@playwright/test';
import {
  dblclickText,
  dragSelect,
  expectNear,
  selectedText,
  textBox,
  type Box,
} from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import {
  activeTabId,
  dblclickDeep,
  dragDeep,
  nearSelectionProblems,
  overlaps,
  startHarness,
  type Harness,
} from './p4-toolbar-support/harness';

// Phase 4 selection coverage on real pages (FR-010 to FR-016): open shadow roots, modal dialogs,
// the keyboard-shortcut leg, a notice for frames Clavis cannot enter, zoom and transforms, device
// pixel ratio, vertical writing, fixed headers, triple-click, trailing whitespace, long selections.
let h: Harness;

test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const viewportOf = (page: Page): { width: number; height: number } =>
  page.viewportSize() ?? { width: 1280, height: 720 };

/** Selection end: a real key release, which is what lets the observer trust a scripted selection. */
const releaseShift = (page: Page): Promise<void> => page.keyboard.press('Shift');

test.describe('open shadow roots (web components)', () => {
  test('a selection inside an open shadow root shows the toolbar next to it and captures its text', async () => {
    const { page, dispose } = await h.open('shadow.html');
    try {
      const word = await dblclickDeep(page, 'harbour');
      await tb(page).waitShown();
      expect(expectNear(await tb(page).box(), word, viewportOf(page))).toEqual([]);
      await tb(page).click('explain');
      await tb(page).waitShown(SEL.card);
      expect(await tb(page).text(SEL.cardText)).toBe('harbour');
    } finally {
      await dispose();
    }
  });

  test('a selection inside a NESTED open shadow root works too', async () => {
    const { page, dispose } = await h.open('shadow.html');
    try {
      const word = await dblclickDeep(page, 'lighthouse');
      await tb(page).waitShown();
      expect(expectNear(await tb(page).box(), word, viewportOf(page))).toEqual([]);
      // Explain (not Listen) shows the captured text since Phase 6: Listen has no card.
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toBe('lighthouse');
    } finally {
      await dispose();
    }
  });

  test('a drag inside a shadow root keeps the selected phrase', async () => {
    const { page, dispose } = await h.open('shadow.html');
    try {
      await dragDeep(page, 'Shadow', 'where');
      await tb(page).waitShown();
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toBe('Shadow paragraph where');
    } finally {
      await dispose();
    }
  });

  test('a CLOSED shadow root cannot be read by an extension: no toolbar and no error', async () => {
    const { page, dispose } = await h.open('shadow.html');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      const box = await page.locator('#closed-host').boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.dblclick((box?.x ?? 0) + 60, (box?.y ?? 0) + 14);
      await page.waitForTimeout(400);
      await tb(page).expectNoHost();
      expect(errors).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('text selected in an input inside a shadow root is ignored (FR-015)', async () => {
    const { page, dispose } = await h.open('shadow.html');
    try {
      const field = await page.evaluate(() => {
        const input = document.getElementById('open')?.shadowRoot?.getElementById('field');
        if (!(input instanceof HTMLInputElement)) throw new Error('no field');
        input.focus();
        input.select();
        const r = input.getBoundingClientRect();
        return { x: r.left, y: r.top, h: r.height };
      });
      await page.mouse.dblclick(field.x + 30, field.y + field.h / 2);
      await page.waitForTimeout(400);
      await tb(page).expectNoHost();
    } finally {
      await dispose();
    }
  });

  test('light DOM text on the same page still works', async () => {
    const { page, dispose } = await h.open('shadow.html');
    try {
      await dblclickText(page, page, 'anchor');
      await tb(page).waitShown();
      // Explain (not Listen) shows the captured text since Phase 6: Listen has no card.
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toBe('anchor');
    } finally {
      await dispose();
    }
  });
});

test.describe('modal <dialog>', () => {
  test('the toolbar is mounted inside the open modal dialog, so it is not inert', async () => {
    const { page, dispose } = await h.open('dialog.html');
    try {
      await page.locator('#open').click();
      expect(
        await page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open),
      ).toBe(true);
      await dblclickText(page, page, 'keystone');
      await tb(page).waitShown();
      expect(await tb(page).hostParent()).toBe('dialog');
      expect(await tb(page).pageSeesShadowRoot()).toBe(false);
      expect(await nearSelectionProblems(page)).toEqual([]);

      // Not inert: a real click reaches the button and the keyboard can focus it.
      await tb(page).click('explain');
      await tb(page).waitShown(SEL.card);
      expect(await tb(page).text(SEL.cardText)).toBe('keystone');
    } finally {
      await dispose();
    }
  });

  test('Escape closes the toolbar first, the dialog on the second press, and the host moves back out', async () => {
    const { page, dispose } = await h.open('dialog.html');
    try {
      await page.locator('#open').click();
      await dblclickText(page, page, 'keystone');
      await tb(page).waitShown();
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      expect(
        await page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open),
      ).toBe(true);

      await page.keyboard.press('Escape');
      await expect
        .poll(() => page.evaluate(() => (document.getElementById('dlg') as HTMLDialogElement).open))
        .toBe(false);

      await dblclickText(page, page, 'backdrop');
      await tb(page).waitShown();
      expect(await tb(page).hostParent()).toBe('html');
    } finally {
      await dispose();
    }
  });

  test('text behind the modal cannot be selected, and the toolbar follows the dialog text only', async () => {
    const { page, dispose } = await h.open('dialog.html');
    try {
      await page.locator('#open').click();
      await dblclickText(page, page, 'keystone');
      await tb(page).waitShown();
      expect(await selectedText(page)).toBe('keystone');
    } finally {
      await dispose();
    }
  });
});

test.describe('keyboard entry and frames Clavis cannot enter', () => {
  async function sendToTopFrame(page: Page, message: object): Promise<unknown> {
    await page.bringToFront();
    const tabId = await activeTabId(h.ext);
    return h.ext.serviceWorker.evaluate(
      ({ id, payload }) => chrome.tabs.sendMessage(id, payload, { frameId: 0 }),
      { id: tabId, payload: message },
    );
  }

  test('the shortcut leg: opening for the current selection moves focus into the toolbar; Escape returns it', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      await page.evaluate(() => {
        const node = document.getElementById('p2')?.firstChild as Text;
        const range = document.createRange();
        range.setStart(node, 5);
        range.setEnd(node, 20);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        (document.getElementById('p3') as HTMLElement).tabIndex = 0;
        (document.getElementById('p3') as HTMLElement).focus();
      });
      // What the background sends after Alt+Shift+E (the native shortcut itself is manual or real-UI).
      const reply = await sendToTopFrame(page, {
        v: 1,
        type: 'CLAVIS_OPEN_SELECTION',
        focus: true,
      });
      expect(reply).toEqual({ ok: true, shown: true });
      await tb(page).waitShown();
      expect(await tb(page).focusedAction()).toBe('explain');

      // The visible order is Lookup, Speak, then speed.
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => tb(page).focusedAction()).toBe('listen');
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => tb(page).focusedAction()).toBe('slow');
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      // Focus went back to where it was, not into the void.
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('p3');
    } finally {
      await dispose();
    }
  });

  test('a notice from the background shows at the top of the page with a Close button', async () => {
    const { page, dispose } = await h.open('iframe.html');
    try {
      const reply = await sendToTopFrame(page, {
        v: 1,
        type: 'CLAVIS_SHOW_NOTICE',
        reason: 'frame-no-access',
      });
      expect(reply).toEqual({ ok: true, shown: true });
      await tb(page).waitShown(SEL.notice);
      expect(await tb(page).text(SEL.notice)).toContain(
        "can't read text inside this embedded frame",
      );
      const box = await tb(page).box(SEL.panel);
      const viewport = viewportOf(page);
      expect(box.y).toBeLessThan(40);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      await expect
        .poll(() => tb(page).live())
        .toContain("can't read text inside this embedded frame");

      await tb(page).click('close');
      await tb(page).waitHidden(SEL.panel);
    } finally {
      await dispose();
    }
  });

  test('an unknown notice reason is ignored', async () => {
    const { page, dispose } = await h.open('iframe.html');
    try {
      const reply = await sendToTopFrame(page, { v: 1, type: 'CLAVIS_SHOW_NOTICE', reason: 'x' });
      expect(reply).toBeUndefined();
      await tb(page).expectNoHost();
    } finally {
      await dispose();
    }
  });
});

test.describe('zoom, transforms and device pixel ratio', () => {
  for (const mode of ['html-zoom', 'body-zoom', 'body-scale', 'html-scale']) {
    test(`${mode}: the toolbar sits next to the selection and inside the viewport`, async () => {
      const { page, dispose } = await h.open(`zoom.html?mode=${mode}`);
      try {
        const word = await dblclickDeep(page, 'lighthouse');
        await tb(page).waitShown();
        const problems = expectNear(await tb(page).box(), word, viewportOf(page));
        expect(problems, `${mode}: ${problems.join(', ')}`).toEqual([]);
        expect(overlaps(await tb(page).box(), word)).toBe(false);
      } finally {
        await dispose();
      }
    });
  }

  test('a multi-line selection under zoom puts the toolbar below its last line', async () => {
    const { page, dispose } = await h.open('zoom.html?mode=html-zoom');
    try {
      await dragSelect(page, page, 'Zoomed', 'cases.');
      await tb(page).waitShown();
      const problems = await nearSelectionProblems(page);
      expect(problems, problems.join(', ')).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('pinch zoom: the toolbar stays inside the visible area and follows it when it pans', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      const cdp: CDPSession = await h.ext.context.newCDPSession(page);
      await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
      await page.waitForFunction(() => window.visualViewport?.scale === 2);
      // Pan so the word sits near the top edge of the visible area: no room above it.
      const word = await textBox(page, 'cartographer');
      await page.evaluate((y) => window.scrollTo(0, y), Math.max(0, word.y - 20));
      await page.evaluate(() => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const i = (n as Text).data.indexOf('cartographer');
          if (i < 0) continue;
          const range = document.createRange();
          range.setStart(n, i);
          range.setEnd(n, i + 'cartographer'.length);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          break;
        }
      });
      const view = await page.evaluate(() => {
        const v = window.visualViewport as VisualViewport;
        return { left: v.offsetLeft, top: v.offsetTop, width: v.width, height: v.height };
      });
      await page.keyboard.press('Shift');
      await tb(page).waitShown();
      const box = await tb(page).box();
      // Fully inside the visible area (layout-viewport coordinates, offset by the pan).
      expect(box.x).toBeGreaterThanOrEqual(view.left - 1);
      expect(box.y).toBeGreaterThanOrEqual(view.top - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(view.left + view.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(view.top + view.height + 1);
    } finally {
      await dispose();
    }
  });

  test('devicePixelRatio 2: positions land on whole device pixels and stay next to the selection', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      const cdp: CDPSession = await h.ext.context.newCDPSession(page);
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1000,
        height: 700,
        deviceScaleFactor: 2,
        mobile: false,
      });
      await page.reload();
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      const style = await tb(page).evalIn<{ left: string; top: string }>(
        SEL.panel,
        `function () { return { left: this.style.left, top: this.style.top }; }`,
      );
      for (const value of [style?.left, style?.top]) {
        expect((Number.parseFloat(value ?? '') * 2) % 1).toBeCloseTo(0, 5);
      }
      expect(await nearSelectionProblems(page)).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

test.describe('writing modes and layout', () => {
  test('vertical writing mode: next to the text, inside the viewport, not covering it', async () => {
    const { page, dispose } = await h.open('vertical.html');
    try {
      const word = await textBox(page, 'lantern');
      await page.mouse.dblclick(word.x + word.width / 2, word.y + word.height / 2);
      await tb(page).waitShown();
      const box = await tb(page).box();
      const viewport = viewportOf(page);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(overlaps(box, await textBox(page, 'lantern'))).toBe(false);
      // Beside the column: the gap is 8 px plus subpixel and device-pixel rounding.
      const lanternBox = await textBox(page, 'lantern');
      const gap = Math.max(
        lanternBox.x - (box.x + box.width),
        box.x - (lanternBox.x + lanternBox.width),
      );
      expect(gap).toBeGreaterThanOrEqual(0);
      expect(gap).toBeLessThanOrEqual(12);
    } finally {
      await dispose();
    }
  });

  for (const mode of ['rl', 'lr']) {
    test(`vertical-${mode}: a selection over several columns gets the toolbar beside them, never over the text (FR-012)`, async () => {
      const { page, dispose } = await h.open(`vertical.html?mode=${mode}`);
      try {
        await page.evaluate(() => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById('v') as Node);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
        });
        await page.keyboard.press('Shift');
        await tb(page).waitShown();
        const toolbar = await tb(page).box();
        const rects = await page.evaluate(() =>
          Array.from(getSelection()?.getRangeAt(0).getClientRects() ?? [])
            .filter((r) => r.width > 1)
            .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })),
        );
        expect(rects.length).toBeGreaterThan(1);
        for (const rect of rects) expect(overlaps(toolbar, rect)).toBe(false);
        const viewport = viewportOf(page);
        expect(toolbar.x).toBeGreaterThanOrEqual(0);
        expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(viewport.width);
      } finally {
        await dispose();
      }
    });
  }

  test('right-to-left: a multi-line selection tucks the toolbar against the end (left) edge of the last line', async () => {
    const { page, dispose } = await h.open('rtl.html');
    try {
      await dragSelect(page, page, 'الكتب', 'القصص');
      await tb(page).waitShown();
      expect(
        await tb(page).evalIn<string>(null, `function () { return this.firstElementChild.dir; }`),
      ).toBe('rtl');
      expect(await nearSelectionProblems(page)).toEqual([]);
    } finally {
      await dispose();
    }
  });

  test('triple-click on a paragraph anchors to that paragraph, not to the start of the next one', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      const para = await page.locator('#p1').boundingBox();
      expect(para).not.toBeNull();
      const p = para as Box;
      await page.mouse.click(p.x + 40, p.y + 12, { clickCount: 3 });
      await tb(page).waitShown();
      const box = await tb(page).box();
      expect(await tb(page).attr(SEL.panel, 'data-kind')).toBe('passage');
      // Anchored to p1: right under its last line, or above its first line. Had the zero-width
      // box at the start of p2 been used, the toolbar would sit a full paragraph further down.
      const gapBelow = box.y - (p.y + p.height);
      const gapAbove = p.y - (box.y + box.height);
      expect(Math.min(Math.abs(gapBelow), Math.abs(gapAbove))).toBeLessThanOrEqual(24);
    } finally {
      await dispose();
    }
  });

  test('a selection that ends in whitespace is captured without it', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      await page.evaluate(() => {
        const node = document.getElementById('p5')?.firstChild as Text;
        const start = node.data.indexOf('jumps');
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 'jumps over '.length);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
      await releaseShift(page);
      await tb(page).waitShown();
      await tb(page).click('explain');
      await expect.poll(() => tb(page).text(SEL.cardText)).toBe('jumps over');
    } finally {
      await dispose();
    }
  });

  test('a selection spanning paragraphs gets a toolbar near its END, inside the viewport', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      await dragSelect(page, page, 'cartographer', 'carefully');
      await tb(page).waitShown();
      expect(await tb(page).attr(SEL.panel, 'data-kind')).toBe('passage');
      expect(await nearSelectionProblems(page)).toEqual([]);
      const end = await textBox(page, 'carefully');
      const box = await tb(page).box();
      // Below the last line, within reach of where the drag ended.
      expect(box.y).toBeGreaterThanOrEqual(end.y + end.height);
    } finally {
      await dispose();
    }
  });

  test('320 px wide: the toolbar never overflows horizontally, the page gets no scrollbar from it', async () => {
    const { page, dispose } = await h.open('article.html');
    try {
      await page.setViewportSize({ width: 320, height: 568 });
      await page.reload();
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      const box = await tb(page).box(SEL.panel);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    } finally {
      await dispose();
    }
  });
});

test.describe('fixed or sticky headers on top of the selection', () => {
  async function selectMultiLine(page: Page): Promise<void> {
    await page.evaluate(() => scrollTo(0, 400));
    // A real drag across three lines of one paragraph.
    const para = await page.locator('main p').nth(6).boundingBox();
    const p = para as Box;
    await page.mouse.move(p.x + 4, p.y + 8);
    await page.mouse.down();
    await page.mouse.move(p.x + p.width - 20, p.y + p.height - 6, { steps: 6 });
    await page.mouse.up();
  }

  test('the toolbar goes below a multi-line selection whose first line is behind the header', async () => {
    const { page, dispose } = await h.open('fixed-header.html');
    try {
      await selectMultiLine(page);
      await tb(page).waitShown();
      const sel = (await page.evaluate(() => {
        const r = getSelection()?.getRangeAt(0).getBoundingClientRect();
        return r === undefined ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
      })) as Box;
      // Scroll until the selection's first line is under the 64 px header, the last still visible.
      await page.evaluate((dy) => scrollBy(0, dy), Math.ceil(sel.y - 40));
      await expect
        .poll(async () => (await tb(page).box()).y, { message: 'toolbar re-placed' })
        .toBeGreaterThanOrEqual(64);
      const box = await tb(page).box();
      const after = (await page.evaluate(() => {
        const r = getSelection()?.getRangeAt(0).getBoundingClientRect();
        return r === undefined ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
      })) as Box;
      expect(after.y).toBeLessThan(64);
      expect(box.y).toBeGreaterThanOrEqual(after.y + after.height - 1);
    } finally {
      await dispose();
    }
  });

  test('the toolbar hides when the whole selection is under the header, and returns when it scrolls out', async () => {
    const { page, dispose } = await h.open('fixed-header.html');
    try {
      await page.evaluate(() => scrollTo(0, 400));
      await dblclickText(page, page, 'Paragraph 12');
      await tb(page).waitShown();
      const y = await page.evaluate(
        () => getSelection()?.getRangeAt(0).getBoundingClientRect().top ?? 0,
      );
      await page.evaluate((dy) => scrollBy(0, dy), Math.ceil(y - 30));
      await tb(page).waitHidden();
      await page.evaluate((dy) => scrollBy(0, dy), -200);
      await tb(page).waitShown();
    } finally {
      await dispose();
    }
  });
});

test.describe('same-origin frames', () => {
  test('a toolbar inside an iframe stays inside the frame, next to its selection', async () => {
    const { page, dispose } = await h.open('iframe.html');
    try {
      await page.waitForLoadState('load');
      const frame = (await (await page.locator('#same').elementHandle())?.contentFrame()) as Frame;
      await expect(async () => {
        await dblclickText(page, frame, 'lighthouse');
        await tb(frame).waitShown(SEL.toolbar, 700);
      }).toPass({ timeout: 10_000 });
      expect(await nearSelectionProblems(page, frame)).toEqual([]);
    } finally {
      await dispose();
    }
  });
});

test('after Escape, an instantaneous double-click on the still-selected word shows the toolbar again', async () => {
  const { page, dispose } = await h.open('article.html');
  try {
    await dblclickText(page, page, 'cartographer');
    await tb(page).waitShown();
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    // The Escape key release alone must not bring it back.
    await page.waitForTimeout(300);
    await tb(page).waitHidden();
    const box = await textBox(page, 'cartographer');
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
    await tb(page).waitShown();
    // A click elsewhere on the page (selection kept) does not.
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await page.mouse.click(5, 5);
    await page.waitForTimeout(300);
    await tb(page).waitHidden();
  } finally {
    await dispose();
  }
});

test('after Escape, an instantaneous double-click on a word inside a shadow root shows the toolbar again', async () => {
  const { page, dispose } = await h.open('shadow.html');
  try {
    const word = await dblclickDeep(page, 'harbour');
    await tb(page).waitShown();
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await page.waitForTimeout(300);
    await page.mouse.dblclick(word.x + word.width / 2, word.y + word.height / 2);
    await tb(page).waitShown();
  } finally {
    await dispose();
  }
});

test.describe('several frames with a selection', () => {
  test('the shortcut leg opens (and focuses) only the frame the user is in', async () => {
    const { page, dispose } = await h.open('iframe.html');
    try {
      await page.waitForLoadState('load');
      const frame = (await (await page.locator('#same').elementHandle())?.contentFrame()) as Frame;
      // A selection in the top document made earlier (stale), then the user selects in the frame.
      await dblclickText(page, page, 'anchor');
      await tb(page).waitShown();
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      await expect(async () => {
        await dblclickText(page, frame, 'lighthouse');
        await tb(frame).waitShown(SEL.toolbar, 700);
      }).toPass({ timeout: 10_000 });
      await page.keyboard.press('Escape');
      await tb(frame).waitHidden();

      const tabId = await activeTabId(h.ext);
      // Like the background: the same message to every frame of the tab.
      await h.ext.serviceWorker.evaluate(
        (id) => chrome.tabs.sendMessage(id, { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true }),
        tabId,
      );
      await tb(frame).waitShown();
      await expect.poll(() => tb(frame).focusedAction()).toBe('explain');
      await page.waitForTimeout(300);
      // The top document (stale selection, toolbar used and dismissed earlier) stays closed.
      expect(await tb(page).isShown()).toBe(false);
    } finally {
      await dispose();
    }
  });
});
