import { readFileSync } from 'node:fs';
import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { accept, acceptPath } from './manifest';

/**
 * Black-box driver for the Phase 7 PDF reader page (`reader.html`). Everything is done the way a
 * user does it (clicks, typing, a file chooser, drag-and-drop, the keyboard); the only "hooks" are
 * the `data-testid`s that the implementer documents at the top of components/reader/Reader.tsx
 * plus accessible names from public/_locales/en/messages.json. If the markup moves, change THIS
 * file only.
 */
export const HOOK = {
  root: '.reader',
  fileInput: 'file-input',
  viewer: 'viewer-container',
  pageInput: 'page-input',
  pageCount: 'page-count',
  zoomSelect: 'zoom-select',
  fitWidth: 'fit-width',
  findToggle: 'find-toggle',
  findBar: 'find-bar',
  findInput: 'find-input',
  findStatus: 'find-status',
  findNext: 'find-next',
  findPrev: 'find-prev',
  findClose: 'find-close',
  stateEmpty: 'state-empty',
  stateLoading: 'state-loading',
  stateError: 'state-error',
  stateImageOnly: 'state-image-only',
  stateRenderIssue: 'state-render-issue',
  passwordPrompt: 'password-prompt',
  passwordError: 'password-error',
  linkConfirm: 'link-confirm',
  liveRegion: 'live-region',
  fileName: 'file-name',
} as const;

export type Phase = 'empty' | 'loading' | 'ready' | 'password-required' | 'image-only' | 'error';

/** English strings of the reader (public/_locales/en/messages.json), as a user reads them. */
export const TEXT = {
  open: 'Open PDF',
  close: 'Close PDF',
  choose: 'Choose a PDF…',
  chooseAnother: 'Choose another PDF',
  prevPage: 'Previous page',
  nextPage: 'Next page',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  passwordLabel: 'PDF password',
  passwordSubmit: 'Open',
  passwordCancel: 'Cancel',
  passwordIncorrect: "That password isn't correct. Try again.",
  linkOpen: 'Open link',
  linkCancel: 'Cancel',
  imageOnly:
    "This PDF appears image-only. Its pages are pictures without text, so text can't be selected. Text recognition (OCR) isn't available in this version.",
  corrupt: "This PDF is damaged and can't be opened. Try another copy of the file.",
  unsupported: "Clavis can't read this file. Choose a different PDF.",
  tooLarge: (mb: number): string =>
    `This PDF is larger than ${mb} MB, which is the most Clavis can open. Try a smaller file.`,
  tooManyPages: (n: number): string =>
    `This PDF has more than ${n} pages, which is the most Clavis can open. Try a shorter file.`,
  notFound: 'No matches',
} as const;

export interface Observed {
  /** `pageerror` events (uncaught exceptions) in the reader page. */
  pageErrors: string[];
  /** `console.error` messages in the reader page. */
  consoleErrors: string[];
  /** alert/confirm/prompt/beforeunload dialogs the page raised (auto-dismissed). */
  dialogs: string[];
  /** URLs of tabs/popups opened while the reader was open. */
  newTabs: string[];
  /** securitypolicyviolation events seen by the page. */
  cspViolations: () => Promise<string[]>;
  /** Every request URL of the browser context since the reader opened (pages, workers, popups). */
  requests: string[];
}

declare global {
  interface Window {
    __csp?: string[];
    __sent?: unknown[];
    __clavisPwned?: unknown;
  }
}

/** A selection snapshot as the reader hands it to the background (lib/contracts/selection.ts). */
export interface SentSnapshot {
  selectionId: string;
  source: string;
  kind: string;
  text: string;
  contextBefore?: string;
  contextAfter?: string;
  languageHint?: string;
  page?: number;
}

export class Reader {
  readonly page: Page;
  readonly observed: Observed;

  constructor(page: Page, observed: Observed) {
    this.page = page;
    this.observed = observed;
  }

  // ---- locators -----------------------------------------------------------------------------
  tid = (id: string): Locator => this.page.getByTestId(id);
  get viewer(): Locator {
    return this.tid(HOOK.viewer);
  }
  get root(): Locator {
    return this.page.locator(HOOK.root);
  }
  pageEl = (n: number): Locator => this.page.locator(`.pdfViewer .page[data-page-number="${n}"]`);
  textLayer = (n: number): Locator => this.pageEl(n).locator('.textLayer');

  // ---- state --------------------------------------------------------------------------------
  async phase(): Promise<string | null> {
    return this.root.getAttribute('data-phase');
  }

  async waitPhase(expected: Phase | Phase[], timeout = 20_000): Promise<Phase> {
    const wanted = Array.isArray(expected) ? expected : [expected];
    await expect
      .poll(async () => wanted.includes((await this.phase()) as Phase), {
        timeout,
        intervals: [100],
        message: `reader phase never became ${wanted.join(' or ')} (is ${await this.phase()})`,
      })
      .toBe(true);
    return (await this.phase()) as Phase;
  }

  /** The visible error text and its `data-code`. */
  async error(): Promise<{ code: string | null; text: string }> {
    const el = this.tid(HOOK.stateError);
    await expect(el).toBeVisible();
    // The first paragraph is the message; the block also holds the "Choose another PDF" action.
    return {
      code: await el.getAttribute('data-code'),
      text: (await el.locator('p').first().innerText()).trim(),
    };
  }

  // ---- opening files ------------------------------------------------------------------------
  /** Set the hidden file input directly (fast path used by most tests). */
  async openPath(file: string): Promise<void> {
    await this.tid(HOOK.fileInput).setInputFiles(file);
  }

  /** Open a manifest fixture through the input. */
  async open(name: string): Promise<void> {
    await this.openPath(acceptPath(name));
  }

  /** Open `name` and wait until the first page has a canvas and (optionally) text. */
  async openReady(
    name: string,
    options: { text?: boolean; password?: string } = {},
  ): Promise<void> {
    await this.open(name);
    if (options.password !== undefined) {
      await this.submitPassword(options.password);
    }
    await this.waitPhase('ready');
    await this.waitFirstPage(options.text ?? true);
  }

  async waitFirstPage(text = true): Promise<void> {
    await expect(this.pageEl(1).locator('canvas').first()).toBeVisible({ timeout: 20_000 });
    if (text) {
      await expect(this.textLayer(1).locator('span').first()).toBeAttached({ timeout: 20_000 });
    }
    await this.settle();
  }

  /** Click the visible "Choose a PDF…" button and answer the browser's real file chooser. */
  async openWithFileChooser(file: string): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser');
    await this.page.getByRole('button', { name: TEXT.choose }).click();
    await (await chooser).setFiles(acceptPath(file));
  }

  /** Same through the toolbar's "Open PDF" button (keyboard-friendly path). */
  async openWithToolbarButton(file: string): Promise<void> {
    const chooser = this.page.waitForEvent('filechooser');
    await this.page.getByRole('button', { name: TEXT.open, exact: true }).click();
    await (await chooser).setFiles(acceptPath(file));
  }

  /**
   * Drag-and-drop: a real `DataTransfer` carrying a real `File` is dropped on the page through
   * the dragenter/dragover/drop sequence the browser would fire (Playwright cannot start an
   * OS-level file drag). The reader's own handlers do the rest.
   */
  async dropFile(file: string, target = '.reader'): Promise<void> {
    const bytes = readFileSync(acceptPath(file)).toString('base64');
    const name = file;
    await this.page.evaluate(
      async ({ b64, fileName, selector }) => {
        const binary = atob(b64);
        const data = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
        const transfer = new DataTransfer();
        transfer.items.add(new File([data], fileName, { type: 'application/pdf' }));
        // Like a real drop: at a point of the screen, the event goes to whatever is under it.
        const at = document.querySelector(selector)?.getBoundingClientRect();
        const x = (at?.left ?? 0) + (at?.width ?? innerWidth) / 2;
        const y = (at?.top ?? 0) + (at?.height ?? innerHeight) / 2;
        const el = document.elementFromPoint(x, y) ?? document.body;
        const init = {
          bubbles: true,
          cancelable: true,
          composed: true,
          dataTransfer: transfer,
          clientX: x,
          clientY: y,
        };
        el.dispatchEvent(new DragEvent('dragenter', init));
        el.dispatchEvent(new DragEvent('dragover', init));
        el.dispatchEvent(new DragEvent('drop', init));
      },
      { b64: bytes, fileName: name, selector: target },
    );
  }

  // ---- password -----------------------------------------------------------------------------
  get passwordInput(): Locator {
    return this.tid(HOOK.passwordPrompt).locator('input[type="password"]');
  }

  async submitPassword(password: string): Promise<void> {
    await this.waitPhase('password-required');
    await this.passwordInput.fill(password);
    await this.tid(HOOK.passwordPrompt).getByRole('button', { name: TEXT.passwordSubmit }).click();
  }

  async cancelPassword(): Promise<void> {
    await this.tid(HOOK.passwordPrompt).getByRole('button', { name: TEXT.passwordCancel }).click();
  }

  // ---- rendering ----------------------------------------------------------------------------
  async renderCount(): Promise<number> {
    return Number(await this.root.getAttribute('data-render-count'));
  }

  /** Wait until the render counter has not moved for `quietMs` (and moved past `since`). */
  async settle(options: { since?: number; quietMs?: number } = {}): Promise<void> {
    const quietMs = options.quietMs ?? 600;
    let last = -1;
    let lastChange = Date.now();
    await expect
      .poll(
        async () => {
          const count = await this.renderCount();
          if (count !== last) {
            last = count;
            lastChange = Date.now();
          }
          const advanced = options.since === undefined || count > options.since;
          return advanced && Date.now() - lastChange >= quietMs;
        },
        { timeout: 40_000, intervals: [150] },
      )
      .toBe(true);
  }

  // ---- zoom, pages --------------------------------------------------------------------------
  async setZoom(value: string): Promise<void> {
    const select = this.tid(HOOK.zoomSelect);
    if ((await select.inputValue()) === value) return;
    const since = await this.renderCount();
    await select.selectOption(value);
    await this.settle({ since });
  }

  async zoomValue(): Promise<string> {
    return this.tid(HOOK.zoomSelect).inputValue();
  }

  /** CSS size of page `n` without PDF.js's 9px page border (what the user sees as the sheet). */
  async pageSize(n = 1): Promise<{ width: number; height: number }> {
    return this.pageEl(n).evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight }));
  }

  async pageWidth(n = 1): Promise<number> {
    return (await this.pageSize(n)).width;
  }

  async currentPage(): Promise<number> {
    return Number(await this.tid(HOOK.pageInput).inputValue());
  }

  async pageCountText(): Promise<string> {
    return (await this.tid(HOOK.pageCount).innerText()).trim();
  }

  async goToPage(n: number): Promise<void> {
    const input = this.tid(HOOK.pageInput);
    await input.fill(String(n));
    await input.press('Enter');
    await expect.poll(() => this.currentPage(), { timeout: 15_000 }).toBe(n);
    await this.settle();
  }

  async goToPageIfNeeded(n: number): Promise<void> {
    if ((await this.currentPage()) !== n) await this.goToPage(n);
  }

  /** Pages (numbers) that currently hold a canvas, and the canvas totals. */
  async canvasStats(): Promise<{
    pages: number;
    withCanvas: number[];
    canvasCount: number;
    canvasPixels: number;
    maxCanvasPixels: number;
  }> {
    return this.page.evaluate(() => {
      const pages = [...document.querySelectorAll<HTMLElement>('.pdfViewer .page')];
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdfViewer .page canvas')];
      const pixels = canvases.map((c) => c.width * c.height);
      return {
        pages: pages.length,
        withCanvas: pages
          .filter((p) => p.querySelector('canvas'))
          .map((p) => Number(p.dataset['pageNumber'])),
        canvasCount: canvases.length,
        canvasPixels: pixels.reduce((a, b) => a + b, 0),
        maxCanvasPixels: Math.max(0, ...pixels),
      };
    });
  }

  /** Scroll the viewer so page `n` is at the top, as a user wheel-scrolling would end up. */
  async scrollToPage(n: number): Promise<void> {
    await this.page.evaluate((target) => {
      const el = document.querySelector<HTMLElement>(
        `.pdfViewer .page[data-page-number="${target}"]`,
      );
      el?.scrollIntoView({ block: 'start' });
    }, n);
    await this.settle();
  }

  // ---- text ---------------------------------------------------------------------------------
  /** Concatenated text of a page's text layer (spans in DOM order). */
  async pageText(n: number): Promise<string> {
    return this.page.evaluate((target) => {
      const layer = document.querySelector(
        `.pdfViewer .page[data-page-number="${target}"] .textLayer`,
      );
      return layer ? ((layer as HTMLElement).textContent ?? '') : '';
    }, n);
  }

  async selectionText(): Promise<string> {
    return this.page.evaluate(() => document.getSelection()?.toString() ?? '');
  }

  /** Poll until the selection equals `expected` (compared with `norm`). */
  async expectSelection(expected: string, norm: (s: string) => string = squash): Promise<void> {
    await expect
      .poll(async () => norm(await this.selectionText()), { timeout: 20_000, intervals: [200] })
      .toBe(norm(expected));
  }

  /** Click on blank page area far from text, to clear a selection like a user would. */
  async clearSelection(): Promise<void> {
    await this.page.evaluate(() => document.getSelection()?.removeAllRanges());
  }

  // ---- find ---------------------------------------------------------------------------------
  async findStatus(): Promise<string> {
    return (await this.tid(HOOK.findStatus).innerText()).trim();
  }

  async openFind(): Promise<void> {
    if (await this.tid(HOOK.findBar).isVisible()) return;
    await this.page.keyboard.press('Control+f');
    await expect(this.tid(HOOK.findInput)).toBeFocused();
  }

  async find(term: string): Promise<void> {
    await this.openFind();
    const input = this.tid(HOOK.findInput);
    await input.fill(term);
  }

  // ---- messages to the background -------------------------------------------------------------
  /** Every `runtime.sendMessage` payload the page sent (recorded by an init script). */
  async sentMessages(): Promise<{ type?: string; payload?: { snapshot?: SentSnapshot } }[]> {
    return this.page.evaluate(() => (window.__sent ?? []) as never);
  }

  /** Snapshots of every AI_EXPLAIN the reader sent, oldest first. */
  async explainSnapshots(): Promise<SentSnapshot[]> {
    return (await this.sentMessages())
      .filter((m) => m.type === 'AI_EXPLAIN')
      .map((m) => m.payload!.snapshot!);
  }

  // ---- misc ---------------------------------------------------------------------------------
  async cspViolations(): Promise<string[]> {
    return this.observed.cspViolations();
  }

  /** Assert that nothing went wrong behind the scenes (used at the end of most tests). */
  async expectQuiet(options: { allowConsoleErrors?: RegExp } = {}): Promise<void> {
    expect(this.observed.pageErrors, 'uncaught page errors').toEqual([]);
    const consoleErrors = options.allowConsoleErrors
      ? this.observed.consoleErrors.filter((m) => !options.allowConsoleErrors!.test(m))
      : this.observed.consoleErrors;
    expect(consoleErrors, 'console.error output').toEqual([]);
    expect(this.observed.dialogs, 'JavaScript dialogs').toEqual([]);
    expect(await this.cspViolations(), 'CSP violations').toEqual([]);
  }
}

/** Remove all whitespace: CJK and RTL lines have no meaningful spaces between text-layer spans. */
export const squash = (s: string): string => s.replace(/\s+/g, '');
/** Collapse whitespace runs: for Latin lines, spaces matter. */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Open the reader page in `context`: console/pageerror/dialog/popup tracking attached BEFORE the
 * first navigation, plus a `securitypolicyviolation` listener (a CSP violation is how hidden
 * eval or inline script would show up).
 */
export async function openReaderPage(
  context: BrowserContext,
  extensionId: string,
  requests: string[],
  viewport = { width: 1200, height: 800 },
): Promise<Reader> {
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  const observed: Observed = {
    pageErrors: [],
    consoleErrors: [],
    dialogs: [],
    newTabs: [],
    requests,
    cspViolations: async () => {
      try {
        return await page.evaluate(() => window.__csp ?? []);
      } catch {
        return [];
      }
    },
  };
  page.on('pageerror', (error) => observed.pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') observed.consoleErrors.push(message.text());
  });
  page.on('dialog', (dialog) => {
    observed.dialogs.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('popup', (popup) => observed.newTabs.push(popup.url()));
  await page.addInitScript(() => {
    window.__sent = [];
    const runtime = (globalThis as unknown as { chrome?: { runtime?: Record<string, unknown> } })
      .chrome?.runtime;
    const original = runtime?.['sendMessage'] as ((...args: unknown[]) => unknown) | undefined;
    if (runtime && original) {
      runtime['sendMessage'] = (...args: unknown[]) => {
        try {
          window.__sent?.push(JSON.parse(JSON.stringify(args[0])));
        } catch {
          // not serialisable: not one of ours
        }
        return original.apply(runtime, args);
      };
    }
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__csp?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  requests.length = 0;
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(page.getByTestId(HOOK.stateEmpty)).toBeVisible();
  return new Reader(page, observed);
}

/** Request URLs that are neither extension resources nor inline (data:/blob:) content. */
export function foreignRequests(requests: string[], extensionId: string): string[] {
  const own = `chrome-extension://${extensionId}/`;
  return requests.filter(
    (url) => !url.startsWith(own) && !url.startsWith('data:') && !url.startsWith('blob:'),
  );
}

export const fixtureLines = (file: string, page?: number) =>
  accept(file).lines.filter((l) => page === undefined || l.page === page);
