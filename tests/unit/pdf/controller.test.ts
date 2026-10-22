// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { PdfReaderController, toSafeExternalUrl } from '../../../lib/pdf/controller';
import { MAX_CANVAS_PIXELS, MAX_IMAGE_PIXELS } from '../../../lib/pdf/limits';
import type { PdfJs } from '../../../lib/pdf/pdfjs';
import type { ReaderState } from '../../../lib/pdf/state';

type Handler = (...args: never[]) => void;

/** Just enough of PDF.js to drive the controller: bus, viewer, link service and getDocument. */
function fakePdfJs(options: {
  numPages?: number;
  text?: boolean;
  password?: string;
  failWith?: string;
  holdLoad?: boolean;
}) {
  const calls = {
    taskDestroyed: 0,
    viewerDocs: [] as unknown[],
    linkDocs: [] as unknown[],
    getDocumentParams: [] as Record<string, unknown>[],
    passwordsSeen: [] as number[],
    viewerOptions: [] as Record<string, unknown>[],
  };
  const releaseLoad: Array<() => void> = [];

  class EventBus {
    #handlers = new Map<string, Array<{ fn: Handler; once: boolean }>>();
    on(name: string, fn: Handler, opts?: { once?: boolean }) {
      const list = this.#handlers.get(name) ?? [];
      list.push({ fn, once: opts?.once === true });
      this.#handlers.set(name, list);
    }
    dispatch(name: string, data: object) {
      const list = this.#handlers.get(name) ?? [];
      this.#handlers.set(
        name,
        list.filter((h) => !h.once),
      );
      for (const h of list) (h.fn as (d: object) => void)(data);
    }
  }
  class PDFLinkService {
    setViewer() {}
    setDocument(doc: unknown) {
      calls.linkDocs.push(doc);
    }
    addLinkAttributes() {}
  }
  class PDFFindController {}
  class PDFViewer {
    currentScale = 1.3;
    currentScaleValue = 'page-width';
    currentPageNumber = 1;
    pagesCount = 0;
    #bus: EventBus;
    constructor(o: { eventBus: EventBus }) {
      calls.viewerOptions.push(o as unknown as Record<string, unknown>);
      this.#bus = o.eventBus;
    }
    setDocument(doc: { numPages: number } | null) {
      calls.viewerDocs.push(doc);
      this.pagesCount = doc?.numPages ?? 0;
      if (doc) queueMicrotask(() => this.#bus.dispatch('pagesinit', {}));
    }
    cleanup() {}
    nextPage() {
      return true;
    }
    previousPage() {
      return true;
    }
    increaseScale() {}
    decreaseScale() {}
  }

  const makeDoc = () => ({
    numPages: options.numPages ?? 2,
    isPureXfa: false,
    getPage: async () => ({
      getTextContent: async () => ({ items: options.text === false ? [] : [{ str: 'text' }] }),
      cleanup: () => undefined,
    }),
  });

  const getDocument = (params: Record<string, unknown>) => {
    calls.getDocumentParams.push(params);
    const task: {
      onPassword: ((update: (pw: string) => void, reason: number) => void) | null;
      promise: Promise<ReturnType<typeof makeDoc>>;
      destroy: () => Promise<void>;
    } = {
      onPassword: null,
      promise: undefined as never,
      destroy: async () => {
        calls.taskDestroyed += 1;
      },
    };
    task.promise = new Promise((resolve, reject) => {
      const finish = () => {
        if (options.failWith) reject(Object.assign(new Error('raw'), { name: options.failWith }));
        else resolve(makeDoc());
      };
      const ask = (reason: number) => {
        calls.passwordsSeen.push(reason);
        task.onPassword?.((pw) => (pw === options.password ? finish() : ask(2)), reason);
      };
      queueMicrotask(() => {
        if (options.password !== undefined) ask(1);
        else if (options.holdLoad) releaseLoad.push(finish);
        else finish();
      });
    });
    return task;
  };

  const pdf = {
    lib: {
      getDocument,
      VerbosityLevel: { ERRORS: 0 },
      AnnotationMode: { ENABLE: 1 },
    },
    viewer: { EventBus, PDFLinkService, PDFFindController, PDFViewer },
    assetBase: 'chrome-extension://abc/pdfjs/',
  } as unknown as PdfJs;
  return { pdf, calls, releaseLoad };
}

function setup(
  options: Parameters<typeof fakePdfJs>[0] = {},
  maxBytes?: number,
  maxPages?: number,
) {
  const fake = fakePdfJs(options);
  const loadPdfJs = vi.fn(async () => fake.pdf);
  const controller = new PdfReaderController({
    elements: {
      container: document.createElement('div'),
      viewerElement: document.createElement('div'),
    },
    confirmExternalLink: async () => false,
    loadPdfJs,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxPages === undefined ? {} : { maxPages }),
  });
  const states: ReaderState[] = [];
  controller.subscribe(() => states.push(controller.getSnapshot().state));
  return { controller, loadPdfJs, states, ...fake };
}

const pdfFile = (name = 'doc.pdf', body = '%PDF-1.7\n%%EOF') =>
  new File([body], name, { type: 'application/pdf' });

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PdfReaderController.openFile', () => {
  it('rejects an oversize file as TOO_LARGE without loading PDF.js', async () => {
    const { controller, loadPdfJs } = setup({}, 10);
    await controller.openFile(pdfFile('big.pdf', '%PDF-1.7 0123456789'));
    expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'TOO_LARGE' });
    expect(loadPdfJs).not.toHaveBeenCalled();
  });

  it('rejects bytes that are not a PDF as UNSUPPORTED without loading PDF.js', async () => {
    const { controller, loadPdfJs } = setup();
    await controller.openFile(pdfFile('notes.pdf', 'just some text'));
    expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'UNSUPPORTED' });
    expect(loadPdfJs).not.toHaveBeenCalled();
  });

  it('goes loading -> ready with page count, page and zoom, and sets safe loader options', async () => {
    const { controller, states, calls } = setup({ numPages: 5 });
    await controller.openFile(pdfFile('book.pdf'));
    expect(states).toContainEqual({ phase: 'loading', name: 'book.pdf' });
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({
        phase: 'ready',
        name: 'book.pdf',
        pageCount: 5,
        page: 1,
        zoom: 1.3,
      }),
    );
    const params = calls.getDocumentParams[0]!;
    expect(params['enableXfa']).toBe(false);
    expect(params['useWorkerFetch']).toBe(true);
    expect(typeof params['useWasm']).toBe('boolean');
    expect(params['cMapUrl']).toBe('chrome-extension://abc/pdfjs/cmaps/');
    expect(params['standardFontDataUrl']).toBe('chrome-extension://abc/pdfjs/standard_fonts/');
    expect(params['data']).toBeInstanceOf(Uint8Array);
    // No remote URL is ever handed to PDF.js (D-03).
    expect(JSON.stringify(Object.values(params).filter((v) => typeof v === 'string'))).not.toMatch(
      /https?:/,
    );
  });

  it('sets explicit memory limits for images and page canvases', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    expect(calls.getDocumentParams[0]!['maxImageSize']).toBe(MAX_IMAGE_PIXELS);
    expect(calls.viewerOptions[0]!['maxCanvasPixels']).toBe(MAX_CANVAS_PIXELS);
  });

  it('opens a document exactly at the page cap', async () => {
    const { controller } = setup({ numPages: 3 }, undefined, 3);
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'ready', pageCount: 3 }),
    );
  });

  it('rejects a document one page over the cap as TOO_LARGE (pages) before the viewer sees it', async () => {
    const { controller, calls } = setup({ numPages: 4 }, undefined, 3);
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({
        phase: 'error',
        code: 'TOO_LARGE',
        limit: 'pages',
      }),
    );
    expect(calls.viewerDocs.filter((d) => d !== null)).toHaveLength(0);
    expect(calls.taskDestroyed).toBe(1);
  });

  it('reports image-only for a document without text, but keeps the page view', async () => {
    const { controller } = setup({ numPages: 3, text: false });
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toEqual({
        phase: 'image-only',
        name: 'doc.pdf',
        pageCount: 3,
      }),
    );
    expect(controller.getSnapshot().view).toMatchObject({ pageCount: 3 });
  });

  it('maps a PDF.js InvalidPDFException to CORRUPT and releases the task', async () => {
    const { controller, calls } = setup({ failWith: 'InvalidPDFException' });
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'CORRUPT' }),
    );
    expect(calls.taskDestroyed).toBe(1);
    expect(controller.getSnapshot().view).toBeNull();
  });

  it('password flow: prompt, wrong password flagged, right password opens, secret never in state', async () => {
    const { controller, calls } = setup({ password: 'open-sesame' });
    const seen: string[] = [];
    controller.subscribe(() => seen.push(JSON.stringify(controller.getSnapshot())));
    // openFile settles only once the document is loaded, failed or cancelled, so it is not awaited
    // while the password prompt is pending (the shell calls it with `void`).
    void controller.openFile(pdfFile('locked.pdf'));
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toEqual({
        phase: 'password-required',
        name: 'locked.pdf',
        incorrect: false,
      }),
    );

    expect(controller.submitPassword('wrong-guess')).toBe(true);
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toEqual({
        phase: 'password-required',
        name: 'locked.pdf',
        incorrect: true,
      }),
    );

    expect(controller.submitPassword('open-sesame')).toBe(true);
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    expect(calls.passwordsSeen).toEqual([1, 2]);
    expect(controller.submitPassword('again')).toBe(false); // nothing pending any more
    for (const snapshot of seen) {
      expect(snapshot).not.toContain('open-sesame');
      expect(snapshot).not.toContain('wrong-guess');
    }
  });

  it('cancelling the password prompt destroys the task and returns to empty', async () => {
    const { controller, calls } = setup({ password: 'pw' });
    void controller.openFile(pdfFile('locked.pdf'));
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('password-required'));
    controller.cancelPassword();
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('empty'));
    expect(calls.taskDestroyed).toBe(1);
  });

  it('a newer open supersedes a slow earlier load and destroys the stale document', async () => {
    const slow = setup({ holdLoad: true });
    const first = slow.controller.openFile(pdfFile('first.pdf'));
    await settle();
    await settle();
    expect(slow.releaseLoad).toHaveLength(1);
    // Second open (new file) while the first load is still pending.
    const second = slow.controller.openFile(pdfFile('second.pdf'));
    await settle();
    await settle();
    expect(slow.releaseLoad).toHaveLength(2);
    slow.releaseLoad[0]!(); // the stale load finishes late
    slow.releaseLoad[1]!();
    await Promise.all([first, second]);
    await vi.waitFor(() =>
      expect(slow.controller.getSnapshot().state).toMatchObject({
        phase: 'ready',
        name: 'second.pdf',
      }),
    );
    expect(slow.calls.taskDestroyed).toBeGreaterThanOrEqual(1);
  });
});

describe('PdfReaderController cleanup', () => {
  it('close() clears the viewer and link service, destroys the task and returns to empty', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    await controller.close();
    expect(calls.viewerDocs.at(-1)).toBeNull();
    expect(calls.linkDocs.at(-1)).toBeNull();
    expect(calls.taskDestroyed).toBe(1);
    expect(controller.getSnapshot()).toMatchObject({
      state: { phase: 'empty' },
      view: null,
      find: { state: 'idle' },
    });
  });

  it('opening another file tears down the previous document first', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile('a.pdf'));
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    await controller.openFile(pdfFile('b.pdf'));
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'ready', name: 'b.pdf' }),
    );
    expect(calls.taskDestroyed).toBe(1); // a.pdf's task
    expect(calls.viewerDocs.filter((d) => d === null).length).toBeGreaterThanOrEqual(1);
  });

  it('destroy() is repeatable and leaves the controller usable (React StrictMode)', async () => {
    const { controller } = setup();
    await controller.destroy();
    await controller.destroy();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
  });
});

describe('toSafeExternalUrl', () => {
  it.each([
    ['https://example.com/a?b=1', 'https://example.com/a?b=1'],
    ['http://example.com/', 'http://example.com/'],
    ['mailto:someone@example.com', 'mailto:someone@example.com'],
  ])('allows %s', (raw, expected) => {
    expect(toSafeExternalUrl(raw)?.href).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'chrome://settings',
    'data:text/html,hi',
    'not a url',
    '',
  ])('blocks %j', (raw) => {
    expect(toSafeExternalUrl(raw)).toBeNull();
  });

  it('strips credentials from the displayed/opened URL', () => {
    expect(toSafeExternalUrl('https://user:pass@example.com/x')?.href).toBe(
      'https://example.com/x',
    );
  });
});
