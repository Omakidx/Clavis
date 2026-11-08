// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  /** The file declares XFA (`IsXFAPresent`). */
  xfa?: boolean;
  /** The file has AcroForm fields. */
  fields?: boolean;
}) {
  const calls = {
    taskDestroyed: 0,
    viewerDocs: [] as unknown[],
    linkDocs: [] as unknown[],
    getDocumentParams: [] as Record<string, unknown>[],
    passwordsSeen: [] as number[],
    viewerOptions: [] as Record<string, unknown>[],
    buses: [] as EventBus[],
    scaleWrites: [] as string[],
    viewers: [] as Array<{
      currentScale: number;
      currentScaleValue: string;
      currentPageNumber: number;
      update: () => void;
    }>,
    findDispatches: [] as Record<string, unknown>[],
  };
  const releaseLoad: Array<() => void> = [];

  class EventBus {
    constructor() {
      calls.buses.push(this);
    }
    #handlers = new Map<string, Array<{ fn: Handler; once: boolean }>>();
    on(name: string, fn: Handler, opts?: { once?: boolean }) {
      const list = this.#handlers.get(name) ?? [];
      list.push({ fn, once: opts?.once === true });
      this.#handlers.set(name, list);
    }
    dispatch(name: string, data: object) {
      if (name === 'find') calls.findDispatches.push(data as Record<string, unknown>);
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
    #currentScale = 1.3;
    get currentScale(): number {
      return this.#currentScale;
    }
    set currentScale(value: number) {
      this.#currentScale = value;
      this.currentScaleValue = String(value);
    }
    #scaleValue = 'page-width';
    get currentScaleValue(): string {
      return this.#scaleValue;
    }
    set currentScaleValue(value: string) {
      this.#scaleValue = value;
      calls.scaleWrites.push(value);
    }
    currentPageNumber = 1;
    pagesCount = 0;
    #bus: EventBus;
    constructor(o: { eventBus: EventBus }) {
      calls.viewers.push(this);
      calls.viewerOptions.push(o as unknown as Record<string, unknown>);
      this.#bus = o.eventBus;
    }
    setDocument(doc: { numPages: number } | null) {
      calls.viewerDocs.push(doc);
      this.pagesCount = doc?.numPages ?? 0;
      if (doc) queueMicrotask(() => this.#bus.dispatch('pagesinit', {}));
    }
    cleanup() {}
    update() {}
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
    getMetadata: async () => ({ info: options.xfa === true ? { IsXFAPresent: true } : {} }),
    getFieldObjects: async () => (options.fields === true ? new Map([['f', [{}]]]) : null),
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
      AnnotationEditorType: { DISABLE: -1 },
      AnnotationType: { LINK: 2, TEXT: 1, POPUP: 16, WIDGET: 20, RICHMEDIA: 27 },
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

describe('PdfReaderController hardening (PDF is untrusted, the reader page is trusted)', () => {
  it('renders links only: no form widgets, no editors, no auto-links, no scripting manager', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    const options = calls.viewerOptions[0]!;
    expect(options['annotationMode']).toBe(1); // AnnotationMode.ENABLE, not ENABLE_FORMS
    expect(options['annotationEditorMode']).toBe(-1); // AnnotationEditorType.DISABLE
    expect(options['enableAutoLinking']).toBe(false);
    expect(options).not.toHaveProperty('scriptingManager');
    expect(calls.getDocumentParams[0]!['enableXfa']).toBe(false);
  });

  it('never passes a URL or a remote origin to PDF.js, only extension-local asset paths', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    const strings = Object.values(calls.getDocumentParams[0]!).filter((v) => typeof v === 'string');
    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) expect(value).toMatch(/^chrome-extension:\/\/abc\/pdfjs\//);
    expect(calls.getDocumentParams[0]).not.toHaveProperty('url');
  });
});

describe('PdfReaderController loading and viewer events', () => {
  it('reports read progress in whole percents while the file is read', async () => {
    const { controller, states } = setup();
    const body = `%PDF-1.7\n${'x'.repeat(5000)}`;
    // A Blob that streams in 1,000-byte chunks; jsdom's File has no stream().
    const file = Object.assign(new File([body], 'p.pdf', { type: 'application/pdf' }), {
      stream: () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            const bytes = new TextEncoder().encode(body);
            for (let i = 0; i < bytes.length; i += 1000) c.enqueue(bytes.slice(i, i + 1000));
            c.close();
          },
        }),
    });
    await controller.openFile(file);
    const progress = states.flatMap((s) =>
      s.phase === 'loading' && s.progress !== undefined ? [s.progress] : [],
    );
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
  });

  it('maps an unknown load failure (worker or chunk) to a RENDER error', async () => {
    const { controller } = setup({ failWith: 'TypeError' });
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'RENDER' }),
    );
  });

  it('counts pages that failed to draw, ignores clean renders, and resets on close', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    const bus = calls.buses[0]!;
    bus.dispatch('pagerendered', { pageNumber: 1 });
    expect(controller.getSnapshot().pageErrors).toBe(0);
    bus.dispatch('pagerendered', { pageNumber: 2, error: new Error('draw failed') });
    expect(controller.getSnapshot().pageErrors).toBe(1);
    await controller.close();
    expect(controller.getSnapshot().pageErrors).toBe(0);
  });

  it('starts a case-sensitive search and steps with `again`', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    controller.find('Bank', { caseSensitive: true });
    controller.find('Bank', { again: true, previous: true, caseSensitive: true });
    controller.find('bank');
    expect(calls.findDispatches).toMatchObject([
      { query: 'Bank', type: '', caseSensitive: true, findPrevious: false, highlightAll: true },
      { query: 'Bank', type: 'again', caseSensitive: true, findPrevious: true },
      { query: 'bank', type: '', caseSensitive: false },
    ]);
  });

  it('maps PDF.js find states and counts into the snapshot', async () => {
    const { controller, calls } = setup();
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    const bus = calls.buses[0]!;
    bus.dispatch('updatefindcontrolstate', { state: 3, matchesCount: { current: 0, total: 0 } });
    expect(controller.getSnapshot().find.state).toBe('pending');
    bus.dispatch('updatefindmatchescount', { matchesCount: { current: 2, total: 5 } });
    expect(controller.getSnapshot().find).toMatchObject({ current: 2, total: 5 });
    bus.dispatch('updatefindcontrolstate', { state: 1, matchesCount: { current: 0, total: 0 } });
    expect(controller.getSnapshot().find.state).toBe('not-found');
    controller.clearFind();
    expect(controller.getSnapshot().find).toEqual({ state: 'idle', current: 0, total: 0 });
  });
});

describe('PdfReaderController file name', () => {
  it('keeps the file name through every state of that file, including an error, and clears it on close', async () => {
    const { controller } = setup();
    expect(controller.getSnapshot().fileName).toBe('');
    await controller.openFile(pdfFile('notes.pdf', 'just some text'));
    expect(controller.getSnapshot()).toMatchObject({
      fileName: 'notes.pdf',
      state: { phase: 'error', code: 'UNSUPPORTED' },
    });
    await controller.openFile(pdfFile('book.pdf'));
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    expect(controller.getSnapshot().fileName).toBe('book.pdf');
    await controller.close();
    expect(controller.getSnapshot().fileName).toBe('');
  });
});

describe('PdfReaderController load failures and unusual documents', () => {
  it('a valid PDF with zero pages is a CORRUPT error, not an endless "loading"', async () => {
    const { controller, calls } = setup({ numPages: 0 });
    await controller.openFile(pdfFile());
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'CORRUPT' }),
    );
    expect(calls.viewerDocs.filter((d) => d !== null)).toHaveLength(0);
    expect(calls.taskDestroyed).toBe(1);
  });

  it.each([
    ['NotReadableError'],
    ['TypeError'], // Chromium's Blob#stream() on an unreadable file: "network error"
  ])(
    'a file that cannot be read (%s) is a PERMISSION error, before PDF.js is loaded',
    async (name) => {
      const { controller, loadPdfJs } = setup();
      const file = Object.assign(pdfFile(), {
        stream: () =>
          new ReadableStream({
            pull() {
              throw Object.assign(new Error('network error'), { name });
            },
          }),
      });
      await controller.openFile(file);
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'PERMISSION' });
      expect(controller.getSnapshot().fileName).toBe('doc.pdf');
      expect(loadPdfJs).not.toHaveBeenCalled();
    },
  );

  it('an XFA-only form (XFA declared, no AcroForm fields) is UNSUPPORTED and never reaches the viewer', async () => {
    const { controller, calls } = setup({ xfa: true });
    await controller.openFile(pdfFile('form.pdf'));
    await vi.waitFor(() =>
      expect(controller.getSnapshot().state).toMatchObject({ phase: 'error', code: 'UNSUPPORTED' }),
    );
    expect(calls.viewerDocs.filter((d) => d !== null)).toHaveLength(0);
    expect(calls.taskDestroyed).toBe(1);
  });

  it('a hybrid form (XFA plus AcroForm fields) and a plain AcroForm open normally', async () => {
    for (const options of [{ xfa: true, fields: true }, { fields: true }, {}]) {
      const { controller } = setup(options);
      await controller.openFile(pdfFile());
      await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    }
  });
});

describe('PdfReaderController follows the container size (fit width)', () => {
  type Callback = () => void;
  let observed: Callback[] = [];
  const frames: Array<() => void> = [];

  function install() {
    observed = [];
    frames.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: Callback) {
          observed.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
  }
  afterEach(() => vi.unstubAllGlobals());
  const flushFrames = () => frames.splice(0).forEach((cb) => cb());

  async function open(widthRef: { width: number }) {
    install();
    const fake = fakePdfJs({});
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { get: () => widthRef.width });
    Object.defineProperty(container, 'clientHeight', { value: 600 });
    const controller = new PdfReaderController({
      elements: { container, viewerElement: document.createElement('div') },
      loadPdfJs: async () => fake.pdf,
    });
    await controller.openFile(pdfFile());
    await vi.waitFor(() => expect(controller.getSnapshot().state.phase).toBe('ready'));
    fake.calls.scaleWrites.length = 0;
    return { controller, fake };
  }

  it('re-applies page-width once per frame when the container changes size', async () => {
    const size = { width: 1200 };
    const { fake } = await open(size);
    const notify = observed[0]!;
    notify(); // first callback: the initial size
    size.width = 700;
    notify();
    notify();
    notify(); // a burst of resize callbacks within one frame
    expect(fake.calls.scaleWrites).toEqual([]);
    flushFrames();
    expect(fake.calls.scaleWrites).toEqual(['page-width']);
    // Same size again: nothing to do.
    notify();
    flushFrames();
    expect(fake.calls.scaleWrites).toEqual(['page-width']);
    size.width = 1500;
    notify();
    flushFrames();
    expect(fake.calls.scaleWrites).toEqual(['page-width', 'page-width']);
  });

  it('leaves a numeric zoom alone', async () => {
    const size = { width: 1200 };
    const { fake } = await open(size);
    const notify = observed[0]!;
    notify(); // initial size
    // The user zoomed to 150%: PDF.js now reports a numeric scale value.
    fake.calls.viewers[0]!.currentScaleValue = '1.5';
    fake.calls.scaleWrites.length = 0;
    size.width = 600;
    notify();
    flushFrames();
    expect(fake.calls.scaleWrites).toEqual([]);
  });

  it('keeps a newly selected page when a refit races the PDF.js scroll-location update', async () => {
    const size = { width: 1200 };
    const { controller, fake } = await open(size);
    const viewer = fake.calls.viewers[0]!;
    const notify = observed[0]!;
    notify();
    // PDF.js caches its last visible location asynchronously after a scroll. A scale change
    // restores that cached page, which can still be page 1 immediately after navigation to 2.
    let cachedPage = 1;
    vi.spyOn(viewer, 'currentScaleValue', 'set').mockImplementation(() => {
      viewer.currentPageNumber = cachedPage;
    });
    vi.spyOn(viewer, 'update').mockImplementation(() => {
      cachedPage = viewer.currentPageNumber;
    });
    controller.goToPage(2);
    size.width = 800;
    notify();
    flushFrames();
    expect(viewer.currentPageNumber).toBe(2);
  });

  it('records an explicit numeric zoom when it matches the current fit-width scale', async () => {
    const size = { width: 1200 };
    const { controller, fake } = await open(size);
    const viewer = fake.calls.viewers[0]!;
    expect(viewer.currentScaleValue).toBe('page-width');

    controller.setZoom(viewer.currentScale);

    expect(controller.getSnapshot().view).toMatchObject({
      zoom: viewer.currentScale,
      scaleValue: String(viewer.currentScale),
    });
    expect(fake.calls.scaleWrites).toContain(String(viewer.currentScale));
  });
});

describe('PdfReaderController ignores stale find events (O5)', () => {
  async function ready() {
    const s = setup();
    await s.controller.openFile(pdfFile());
    await vi.waitFor(() => expect(s.controller.getSnapshot().state.phase).toBe('ready'));
    return { ...s, bus: s.calls.buses[0] as unknown as { dispatch(n: string, d: object): void } };
  }

  it('drops counts and states from the previous query until PDF.js reports the new one', async () => {
    const { controller, bus } = await ready();
    controller.find('first');
    bus.dispatch('updatefindcontrolstate', {
      state: 0,
      rawQuery: 'first',
      matchesCount: { current: 1, total: 100 },
    });
    expect(controller.getSnapshot().find).toMatchObject({ current: 1, total: 100 });

    controller.find('second');
    // Still in flight from the first search: "47 of 100".
    bus.dispatch('updatefindmatchescount', { matchesCount: { current: 47, total: 100 } });
    bus.dispatch('updatefindcontrolstate', {
      state: 0,
      rawQuery: 'first',
      matchesCount: { current: 47, total: 100 },
    });
    expect(controller.getSnapshot().find).toMatchObject({ current: 1, total: 100 });

    bus.dispatch('updatefindcontrolstate', {
      state: 3,
      rawQuery: 'second',
      matchesCount: { current: 0, total: 0 },
    });
    expect(controller.getSnapshot().find.state).toBe('pending');
    bus.dispatch('updatefindmatchescount', { matchesCount: { current: 1, total: 12 } });
    expect(controller.getSnapshot().find).toMatchObject({ current: 1, total: 12 });
  });

  it('stepping with the same query does not reset the confirmation', async () => {
    const { controller, bus } = await ready();
    controller.find('word');
    bus.dispatch('updatefindcontrolstate', {
      state: 0,
      rawQuery: 'word',
      matchesCount: { current: 1, total: 3 },
    });
    controller.find('word', { again: true });
    bus.dispatch('updatefindmatchescount', { matchesCount: { current: 2, total: 3 } });
    expect(controller.getSnapshot().find).toMatchObject({ current: 2, total: 3 });
  });

  it('types Kangxi radicals as the ideographs PDF.js indexes', async () => {
    const { controller, calls } = await ready();
    controller.find('\u2F47');
    expect(calls.findDispatches.at(-1)).toMatchObject({ query: '\u65E5' });
  });
});
