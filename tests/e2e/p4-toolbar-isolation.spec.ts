import { expect, test } from '@playwright/test';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { startHarness, type Harness } from './p4-toolbar-support/harness';

// The toolbar must not change how the page looks outside its own box (FR-012), whatever global
// CSS the page ships. Also: lifecycle (an extension update or a second injection must leave
// exactly one live toolbar).
let h: Harness;

test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

test('a page-wide ::backdrop rule does not dim the page when the toolbar shows', async () => {
  const { page, dispose } = await h.open('backdrop.html');
  try {
    // Control: the page rule really is in force for a popover of the page's own.
    const control = await page.evaluate(() => {
      const own = document.createElement('div');
      own.setAttribute('popover', 'manual');
      document.body.append(own);
      own.showPopover();
      const style = getComputedStyle(own, '::backdrop');
      const result = { background: style.backgroundColor, filter: style.backdropFilter };
      own.hidePopover();
      own.remove();
      return result;
    });
    expect(control.background).toBe('rgba(0, 0, 0, 0.6)');
    expect(control.filter).toContain('blur');

    const swatch = (await page.locator('#swatch').boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    // The bottom-left corner of the swatch: well away from where the toolbar will be.
    const region = { x: swatch.x, y: swatch.y + swatch.height - 40, width: 80, height: 40 };
    const before = await page.screenshot({ clip: region });

    await dblclickText(page, page, 'anchor');
    await tb(page).waitShown();
    const backdrop = await page.evaluate(() => {
      const host = document.querySelector(':root > div[popover]') as Element;
      const style = getComputedStyle(host, '::backdrop');
      return {
        background: style.backgroundColor,
        filter: style.backdropFilter,
        display: style.display,
      };
    });
    expect(backdrop.background).toBe('rgba(0, 0, 0, 0)');
    expect(backdrop.filter).toBe('none');
    expect(backdrop.display).toBe('none');

    // A region away from the toolbar looks exactly as before.
    const toolbarBox = await tb(page).box();
    expect(
      toolbarBox.x < region.x + region.width &&
        toolbarBox.x + toolbarBox.width > region.x &&
        toolbarBox.y < region.y + region.height &&
        toolbarBox.y + toolbarBox.height > region.y,
    ).toBe(false);
    const after = await page.screenshot({ clip: region });
    expect(after.equals(before)).toBe(true);
  } finally {
    await dispose();
  }
});

test.describe('lifecycle', () => {
  async function reinject(pagePath: string, times: number): Promise<number> {
    const { page, dispose } = await h.open(pagePath);
    try {
      await page.bringToFront();
      const tabId = (await h.ext.serviceWorker.evaluate(
        `chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0].id)`,
      )) as number;
      for (let i = 0; i < times; i++) {
        await h.ext.serviceWorker.evaluate(
          (id) =>
            chrome.scripting.executeScript({
              target: { tabId: id },
              files: ['/observer.js'],
            }),
          tabId,
        );
      }
      await page.waitForTimeout(300);
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await page.waitForTimeout(300);
      const hosts = await tb(page).hostCount();
      // The toolbar that is there works, and Escape dismisses it (no orphan listener left over).
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      return hosts;
    } finally {
      await dispose();
    }
  }

  test('a second injection (an update re-injecting open tabs) replaces the old instance: one toolbar per selection', async () => {
    expect(await reinject('article.html', 2)).toBe(1);
  });

  test('without re-injection there is one toolbar too (control)', async () => {
    expect(await reinject('article.html', 0)).toBe(1);
  });
});
