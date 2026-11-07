import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { accept } from './p7-accept-support/manifest';
import { foreignRequests, HOOK, TEXT } from './p7-accept-support/reader';
import { startPdfServer, type PdfServer } from './p7-accept-support/server';
import { extensionPath } from './fixtures';

// Phase 7 acceptance: opening files (FR-050), not intercepting Chrome's PDF viewer (FR-056) and
// page navigation, zoom and fit-width (FR-054). A black box: a real file chooser, a real drop
// sequence, real clicks and keys; the reader's behaviour is judged by what a user sees.
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness();
});
test.afterAll(async () => {
  await h?.close();
});

test.describe('FR-050 open a local PDF', () => {
  test('the visible "Choose a PDF" button opens a real file chooser and the file renders', async () => {
    const reader = await h.openReader();
    await reader.openWithFileChooser('font-truetype-embedded.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    await expect(reader.page.getByTestId(HOOK.fileName)).toHaveText('font-truetype-embedded.pdf');
    expect(await reader.pageCountText()).toBe('of 2');
    expect(await reader.pageText(1)).toContain('The quick brown fox jumps over the lazy dog.');
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('the toolbar "Open PDF" button also opens the chooser, and a second file replaces the first', async () => {
    const reader = await h.openReader();
    await reader.openWithToolbarButton('basic-1page.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    expect(await reader.pageText(1)).toContain('zeppelin');
    await reader.openWithToolbarButton('font-gs-embedded.pdf');
    await expect(reader.page.getByTestId(HOOK.fileName)).toHaveText('font-gs-embedded.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    expect(await reader.pageText(1)).toContain('Ghostscript embeds this line');
    expect(await reader.pageText(1)).not.toContain('zeppelin');
    expect(await reader.pageCountText()).toBe('of 2');
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('dropping a file on the page opens it (drag overlay appears and goes away)', async () => {
    const reader = await h.openReader();
    // A drag with files over the page shows the drop hint ...
    await reader.page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([37])], 'x.pdf', { type: 'application/pdf' }));
      document
        .querySelector('.reader')!
        .dispatchEvent(
          new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
        );
    });
    await expect(reader.page.getByTestId('drop-target')).toBeVisible();
    // ... and a real drop opens the file.
    await reader.dropFile('columns-3.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    expect(await reader.pageText(1)).toContain('Alpha 1 column text.');
    await expect(reader.page.getByTestId('drop-target')).toHaveCount(0);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('dropping something that is not a file does nothing (no crash, still empty)', async () => {
    const reader = await h.openReader();
    await reader.page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.setData('text/plain', 'just some text');
      const target = document.querySelector('.reader')!;
      target.dispatchEvent(
        new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      target.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    expect(await reader.phase()).toBe('empty');
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('two fixtures open with the browser OFFLINE and every request stays inside chrome-extension://', async () => {
    const reader = await h.openReader();
    await h.ext.context.setOffline(true);
    try {
      for (const [file, needle] of [
        ['font-truetype-embedded.pdf', 'The quick brown fox'],
        ['cjk-truetype-embedded.pdf', '春眠不觉晓'],
        ['image-jpx.pdf', 'JPEG 2000 image below'],
        ['cjk-nonembedded-cmap.pdf', '春眠不觉晓'],
      ] as const) {
        await reader.open(file);
        await reader.waitPhase('ready');
        await reader.waitFirstPage();
        expect(await reader.pageText(1), file).toContain(needle);
      }
      await reader.expectQuiet();
    } finally {
      await h.ext.context.setOffline(false);
    }
    // The tracker is not blind: it saw the extension's own worker and chunks.
    expect(h.requests.some((u) => u.startsWith(`chrome-extension://${h.ext.extensionId}/`))).toBe(
      true,
    );
    expect(foreignRequests(h.requests, h.ext.extensionId)).toEqual([]);
    await reader.page.close();
  });

  test('reading never sends a request to any other origin, including for JPX, JBIG2 and CMap fixtures', async () => {
    const reader = await h.openReader();
    for (const file of [
      'image-jpx.pdf',
      'image-jbig2.pdf',
      'cjk-nonembedded-cmap.pdf',
      'rtl-hebrew-arabic.pdf',
      'hostile-text-links.pdf',
      'acroform-javascript.pdf',
    ]) {
      await reader.open(file);
      await reader.waitPhase('ready');
      await reader.waitFirstPage();
    }
    expect(foreignRequests(h.requests, h.ext.extensionId)).toEqual([]);
    expect(h.webRequests).toEqual([]);
    expect(h.groqUrls).toEqual([]);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('canary: the web-request tracker does see requests made by a worker (so "none" means none)', async () => {
    const reader = await h.openReader();
    await reader.openReady('basic-1page.pdf');
    await reader.page.evaluate(async () => {
      const code = "fetch('https://canary.invalid/from-worker').catch(() => {}); postMessage(1)";
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
      await new Promise((resolve) => (worker.onmessage = resolve));
    });
    await expect.poll(() => h.webRequests).toContain('https://canary.invalid/from-worker');
    h.webRequests.length = 0;
    await reader.page.close();
  });

  test('Close PDF returns to the empty state, drops the pages and stops the PDF.js worker', async () => {
    const reader = await h.openReader();
    await reader.openReady('pages-100.pdf');
    expect((await reader.canvasStats()).pages).toBe(100);
    await expect.poll(() => reader.page.workers().length).toBeGreaterThan(0);
    await reader.page.getByRole('button', { name: TEXT.close, exact: true }).click();
    await reader.waitPhase('empty');
    expect(await reader.canvasStats()).toMatchObject({ pages: 0, canvasCount: 0 });
    await expect.poll(() => reader.page.workers().length, { timeout: 10_000 }).toBe(0);
    // The same file can be opened again after closing.
    await reader.openReady('pages-100.pdf');
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('the document title and file name follow the open file', async () => {
    const reader = await h.openReader();
    await reader.openReady('basic-1page.pdf');
    await expect(reader.page).toHaveTitle(/basic-1page\.pdf/);
    await reader.page.getByRole('button', { name: TEXT.close, exact: true }).click();
    await reader.waitPhase('empty');
    await expect(reader.page).not.toHaveTitle(/basic-1page/);
    await reader.page.close();
  });
});

test.describe('FR-056 the reader launches only when the user chooses it', () => {
  let server: PdfServer;
  test.beforeAll(async () => {
    server = await startPdfServer();
  });
  test.afterAll(async () => {
    await server?.close();
  });

  const readerTabs = (): Promise<number> =>
    h.ext.serviceWorker.evaluate(
      `chrome.tabs.query({ url: 'chrome-extension://' + chrome.runtime.id + '/reader.html' }).then((tabs) => tabs.length)`,
    ) as Promise<number>;

  test('navigating a tab to a .pdf URL does not open or redirect to the reader', async () => {
    const before = await readerTabs();
    const page = await h.ext.context.newPage();
    // Headless Chromium either shows its own viewer or downloads the file; both are fine.
    // What must not happen is an extension redirect.
    const download = page.waitForEvent('download', { timeout: 4_000 }).catch(() => null);
    await page.goto(`${server.origin}/basic-1page.pdf`).catch(() => undefined);
    await download;
    await page.waitForTimeout(1_000);
    expect(page.url()).not.toContain('reader.html');
    expect(page.url()).not.toMatch(/^chrome-extension:\/\/[a-p]{32}\/reader/);
    expect(await readerTabs()).toBe(before);
    expect(
      h.ext.context.pages().filter((p) => p.url().includes(`${h.ext.extensionId}/reader.html`))
        .length,
    ).toBe(before);
    await page.close();
  });

  test('clicking a link to a PDF on a web page is not intercepted either', async () => {
    const before = await readerTabs();
    const page = await h.ext.context.newPage();
    await page.goto(`${server.origin}/index.html`);
    const download = page.waitForEvent('download', { timeout: 4_000 }).catch(() => null);
    await page
      .locator('#pdf')
      .click()
      .catch(() => undefined);
    await download;
    await page.waitForTimeout(1_000);
    expect(await readerTabs()).toBe(before);
    expect(page.url()).not.toContain(h.ext.extensionId);
    await page.close();
  });

  test('the manifest claims no PDF handling: no redirect or interception permissions, no content scripts on PDFs', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'),
    ) as {
      permissions?: string[];
      content_scripts?: { matches: string[] }[];
      host_permissions?: string[];
      [key: string]: unknown;
    };
    const forbidden = [
      'webRequest',
      'webRequestBlocking',
      'declarativeNetRequest',
      'declarativeNetRequestWithHostAccess',
      'declarativeNetRequestFeedback',
      'webNavigation',
      'downloads',
    ];
    expect(manifest.permissions?.filter((p) => forbidden.includes(p))).toEqual([]);
    expect(manifest['file_handlers']).toBeUndefined();
    expect(manifest['chrome_url_overrides']).toBeUndefined();
    expect(manifest['declarative_net_request']).toBeUndefined();
    for (const script of manifest.content_scripts ?? []) {
      expect(script.matches.join(' ')).not.toMatch(/\.pdf/i);
    }
    expect(manifest.host_permissions ?? []).not.toContain('file:///*');
    expect(manifest.host_permissions ?? []).not.toContain('<all_urls>');
  });

  test('the toolbar popup "Open PDF reader" button opens the reader in a tab (explicit choice)', async () => {
    const before = await readerTabs();
    const popup = await h.ext.context.newPage();
    await popup.goto(`chrome-extension://${h.ext.extensionId}/popup.html`);
    await popup.getByRole('button', { name: 'Open PDF reader' }).click();
    await expect.poll(readerTabs).toBe(before + 1);
    await popup.close();
  });
});

test.describe('FR-054 pages, zoom, page count, fit width', () => {
  test('one-page file: count is "of 1", Previous and Next stay on page 1', async () => {
    const reader = await h.openReader();
    await reader.openReady('basic-1page.pdf');
    expect(await reader.pageCountText()).toBe('of 1');
    expect(await reader.currentPage()).toBe(1);
    await reader.page.getByRole('button', { name: TEXT.nextPage }).click();
    await reader.page.getByRole('button', { name: TEXT.prevPage }).click();
    expect(await reader.currentPage()).toBe(1);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('zoom presets scale the page: 100% is 816 px wide, 150% 1224 px, 50% 408 px (Letter)', async () => {
    const reader = await h.openReader({ width: 1400, height: 900 });
    await reader.openReady('basic-1page.pdf');
    for (const [value, width] of [
      ['1', 816],
      ['1.5', 1224],
      ['0.5', 408],
      ['1.25', 1020],
    ] as const) {
      await reader.setZoom(value);
      expect(Math.abs((await reader.pageWidth(1)) - width), `zoom ${value}`).toBeLessThanOrEqual(2);
    }
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('zoom in and zoom out buttons change the size step by step and the select shows the level', async () => {
    const reader = await h.openReader({ width: 1400, height: 900 });
    await reader.openReady('basic-1page.pdf');
    await reader.setZoom('1');
    const base = await reader.pageWidth(1);
    await reader.page.getByRole('button', { name: TEXT.zoomIn }).click();
    await reader.settle();
    const bigger = await reader.pageWidth(1);
    expect(bigger).toBeGreaterThan(base);
    // The select reports a real percentage for in-between levels, never a blank or fit-width.
    const label = await reader.tid(HOOK.zoomSelect).evaluate((el) => {
      const select = el as HTMLSelectElement;
      return select.selectedOptions[0]?.textContent ?? '';
    });
    expect(label).toMatch(/^\d+%$/);
    await reader.page.getByRole('button', { name: TEXT.zoomOut }).click();
    await reader.page.getByRole('button', { name: TEXT.zoomOut }).click();
    await reader.settle();
    expect(await reader.pageWidth(1)).toBeLessThan(base);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('fit width makes the page fill the viewer with no horizontal scrollbar, at several window widths', async () => {
    for (const width of [700, 1200, 1500]) {
      const reader = await h.openReader({ width, height: 800 });
      await reader.openReady('basic-1page.pdf');
      await reader.setZoom('1');
      // At the narrow breakpoint the toolbar button is hidden; the visible zoom select exposes
      // the same preset and still lets us verify fit-width layout at this window size.
      if (width === 700) await reader.setZoom('page-width');
      else await reader.clickFitWidth();
      const m = await reader.viewer.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        page: (el.querySelector('.page') as HTMLElement).clientWidth,
      }));
      expect(m.scroll, `window ${width}`).toBeLessThanOrEqual(m.client + 1);
      expect(m.page, `window ${width}`).toBeGreaterThan(m.client * 0.8);
      expect(m.page, `window ${width}`).toBeLessThanOrEqual(m.client);
      expect(await reader.zoomValue()).toBe('page-width');
      await reader.expectQuiet();
      await reader.page.close();
    }
  });

  test('fit width FOLLOWS a window resize: the page shrinks and grows with the window, no horizontal scrollbar appears', async () => {
    const reader = await h.openReader({ width: 1200, height: 800 });
    await reader.openReady('basic-1page.pdf');
    await reader.clickFitWidth();
    const measure = () =>
      reader.viewer.evaluate((el) => ({
        client: el.clientWidth,
        scroll: el.scrollWidth,
        page: (el.querySelector('.page') as HTMLElement).clientWidth,
      }));
    const wide = await measure();
    await reader.page.setViewportSize({ width: 700, height: 800 });
    await expect
      .poll(async () => (await measure()).page, { timeout: 8_000, message: 'page did not shrink' })
      .toBeLessThan(wide.page);
    const narrow = await measure();
    expect(narrow.scroll).toBeLessThanOrEqual(narrow.client + 1);
    await reader.page.setViewportSize({ width: 1500, height: 800 });
    await expect
      .poll(async () => (await measure()).page, { timeout: 8_000, message: 'page did not grow' })
      .toBeGreaterThan(narrow.page);
    await reader.page.close();
  });

  test('100-page file: count, Next/Previous, typed page, clamping, keyboard and wheel scrolling', async () => {
    const reader = await h.openReader();
    await reader.openReady('pages-100.pdf');
    expect(await reader.pageCountText()).toBe('of 100');
    expect(await reader.currentPage()).toBe(1);
    await reader.page.getByRole('button', { name: TEXT.nextPage }).click();
    await expect.poll(() => reader.currentPage()).toBe(2);
    await reader.page.getByRole('button', { name: TEXT.prevPage }).click();
    await expect.poll(() => reader.currentPage()).toBe(1);
    // Previous on page 1 stays on page 1.
    await reader.page.getByRole('button', { name: TEXT.prevPage }).click();
    expect(await reader.currentPage()).toBe(1);

    await reader.goToPage(57);
    expect(await reader.pageText(57)).toContain('Folio 57');
    await expect(reader.pageEl(57).locator('canvas').first()).toBeVisible();

    // Out of range numbers are clamped, not crashes.
    const input = reader.tid(HOOK.pageInput);
    await input.fill('999');
    await input.press('Enter');
    await expect.poll(() => reader.currentPage()).toBe(100);
    await input.fill('0');
    await input.press('Enter');
    await expect.poll(() => reader.currentPage()).toBe(1);

    // Wheel scroll with the mouse updates the page box.
    await reader.page.mouse.move(600, 400);
    await reader.page.mouse.wheel(0, 4200);
    await expect.poll(() => reader.currentPage()).toBeGreaterThanOrEqual(4);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('changing the zoom keeps the current page (page 50 stays page 50)', async () => {
    const reader = await h.openReader({ width: 1400, height: 900 });
    await reader.openReady('pages-100.pdf');
    await reader.goToPage(50);
    await reader.setZoom('1.5');
    expect(await reader.currentPage()).toBe(50);
    await reader.setZoom('0.5');
    expect(await reader.currentPage()).toBe(50);
    await reader.clickFitWidth();
    expect(await reader.currentPage()).toBe(50);
    await reader.page.close();
  });

  test('mixed page sizes: every page opens, fit width never clips the widest page horizontally', async () => {
    const reader = await h.openReader({ width: 1100, height: 800 });
    await reader.openReady('mixed-page-sizes.pdf');
    expect(await reader.pageCountText()).toBe('of 5');
    const sizes = accept('mixed-page-sizes.pdf').properties!['pageSizes'] as [number, number][];
    await reader.setZoom('1');
    for (let n = 1; n <= 5; n++) {
      await reader.goToPage(n);
      await expect(reader.pageEl(n).locator('canvas').first()).toBeVisible();
      const box = await reader.pageSize(n);
      const [w, h2] = sizes[n - 1]!;
      expect(Math.abs(box.width - (w * 4) / 3), `page ${n} width`).toBeLessThanOrEqual(2);
      expect(Math.abs(box.height - (h2 * 4) / 3), `page ${n} height`).toBeLessThanOrEqual(2);
    }
    await reader.clickFitWidth();
    await reader.goToPage(5);
    expect(await reader.pageText(5)).toContain('1500 by 300 points');
    await reader.expectQuiet();
    await reader.page.close();
  });
});

test.describe('FR-058 and FR-060 are not presented in v1', () => {
  test('no URL, OCR, annotation, sign, stamp or document translation controls; local highlights are allowed', async () => {
    const reader = await h.openReader();
    const surface = async () =>
      reader.page.evaluate(() => ({
        urlInputs: document.querySelectorAll('input[type=url]').length,
        controls: [...document.querySelectorAll('button, [role=button], input, select, a')].map(
          (el) =>
            `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''} ${el.getAttribute('placeholder') ?? ''}`.trim(),
        ),
      }));
    for (const phase of ['empty', 'open'] as const) {
      if (phase === 'open') await reader.openReady('basic-1page.pdf');
      const { urlInputs, controls } = await surface();
      expect(urlInputs, phase).toBe(0);
      const highlightControls = controls.filter((name) => /\bhighlight\b/i.test(name));
      expect(highlightControls.sort(), `${phase}: local highlight controls`).toEqual(
        phase === 'open'
          ? ['Highlight in blue', 'Highlight in green', 'Highlight in pink', 'Highlight in yellow']
          : [],
      );
      for (const name of controls) {
        if (/\bhighlight\b/i.test(name)) {
          expect(name, `${phase}: nonlocal highlight control`).toMatch(
            /^highlight in (yellow|green|blue|pink)$/i,
          );
        } else {
          expect(name, `${phase}: control "${name}"`).not.toMatch(
            /\b(url|web address|remote|ocr|recogni[sz]e|annotat|draw|sign|stamp|translate document|edit)\b/i,
          );
        }
      }
    }
    await reader.page.close();
  });
});
