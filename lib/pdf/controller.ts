import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { confirmingLinkService, toSafeExternalUrl } from './links';
import { allowedAnnotationTypes, guardAnnotations } from './annotations';
import { findStateName, IDLE_FIND, type FindStatus } from './find';
import { isImageOnly } from './image-only';
import { FIT_WIDTH, MAX_CANVAS_PIXELS, MAX_IMAGE_PIXELS, MAX_PDF_BYTES } from './limits';
import { PasswordGate } from './password';
import { normalizeKangxiRadicals } from './radicals';
import { loadPdfJs, type PdfJs } from './pdfjs';
import { readFileBytes } from './read';
import { isWasmAllowed } from './wasm';
import { buildReaderPageText, type ReaderPageText } from './reader-text';
import {
  EMPTY_STATE,
  clampPage,
  errorState,
  hasPdfHeader,
  mapLoadError,
  notAPdfState,
  validateFileMeta,
  validatePageCount,
  type ReaderState,
} from './state';

export type { FindStatus };

/** Page/zoom of the document on screen; present whenever a document is displayed. */
export interface ViewStatus {
  pageCount: number;
  page: number;
  zoom: number;
  /** `page-width` or a numeric string such as `1.25`, as reported by PDFViewer. */
  scaleValue: string;
}

/** Immutable snapshot; a new object is created on every change (for useSyncExternalStore). */
export interface ReaderSnapshot {
  state: ReaderState;
  view: ViewStatus | null;
  find: FindStatus;
  /**
   * Number of page/text-layer render completions since the controller was created. It only ever
   * grows; E2E tests use it to know when the viewer is idle after a zoom or scroll.
   */
  renderCount: number;
  /**
   * Pages that failed to draw since the document opened (a cancelled render is not a failure).
   * The shell shows a notice while this is above zero; the other pages stay usable.
   */
  pageErrors: number;
  /**
   * Some page had more annotations than the reader draws (MAX_ANNOTATIONS_PER_PAGE) and the excess
   * was dropped. The shell shows a notice; reset when the document closes.
   */
  annotationsLimited: boolean;
  /**
   * Name of the file being opened or shown, kept for every state of it (also after an error, so
   * the user knows which file failed); empty when no file is open. Shown as text only.
   */
  fileName: string;
}

export interface ViewerElements {
  container: HTMLDivElement;
  viewerElement: HTMLDivElement;
}

export type LinkConfirmer = (url: string) => Promise<boolean>;

export interface ReaderControllerOptions {
  /**
   * DOM nodes for the viewer; may instead be supplied later with `attach()` (React refs only
   * exist after mount). `container` is the scroll container: it must be `position: absolute`
   * (PDF.js requirement), `overflow: auto` and visible (it is measured for fit-width).
   * `viewerElement` is an empty `div.pdfViewer` inside it that receives the pages.
   */
  elements?: ViewerElements;
  /**
   * Called before any external link is opened; resolve true to open it in a new tab. May instead
   * be supplied later with `setLinkConfirmer()`. Without one, external links never open.
   */
  confirmExternalLink?: (url: string) => Promise<boolean>;
  /** Injection point for tests. */
  loadPdfJs?: () => Promise<PdfJs>;
  maxBytes?: number;
  /** Page-count cap override (tests); defaults to MAX_PDF_PAGES. */
  maxPages?: number;
}

export { toSafeExternalUrl };

/**
 * An XFA-only form: the file says it has XFA (`IsXFAPresent`) and has no AcroForm fields. With XFA
 * off (`enableXfa: false`, `isPureXfa` is always false) PDF.js would draw only the "Please wait,
 * your viewer does not support XFA" placeholder page, so say so instead. A hybrid form (XFA plus
 * AcroForm fields) is a normal document whose static fields still show.
 */
async function isXfaOnly(doc: PDFDocumentProxy): Promise<boolean> {
  try {
    const { info } = await doc.getMetadata();
    if ((info as { IsXFAPresent?: unknown } | undefined)?.IsXFAPresent !== true) return false;
    const fields = await doc.getFieldObjects();
    return fields === null || fields.size === 0;
  } catch {
    return false;
  }
}

/**
 * Thin adapter between PDF.js viewer components and the React shell (D-06).
 *
 * Lifecycle: `openFile` -> loading -> (password-required)* -> ready | image-only | error.
 * `close()` and every new `openFile` run the same cleanup: viewer.setDocument(null),
 * linkService.setDocument(null) and loadingTask.destroy() (which also terminates the worker;
 * PDF.js 6 has no PDFDocumentProxy.destroy). No object URLs are created: bytes are an
 * ArrayBuffer owned by this tab only for the lifetime of the document.
 */
export class PdfReaderController {
  readonly #opts: ReaderControllerOptions;
  readonly #listeners = new Set<() => void>();
  readonly #gate: PasswordGate;
  #snapshot: ReaderSnapshot = {
    state: EMPTY_STATE,
    view: null,
    find: IDLE_FIND,
    renderCount: 0,
    pageErrors: 0,
    annotationsLimited: false,
    fileName: '',
  };
  #viewer: PDFViewer | null = null;
  #linkService: PDFLinkService | null = null;
  #eventBus: InstanceType<PdfJs['viewer']['EventBus']> | null = null;
  #task: PDFDocumentLoadingTask | null = null;
  #doc: PDFDocumentProxy | null = null;
  /** The query of the search in progress, and whether PDF.js has reported on it yet. */
  #findQuery: string | null = null;
  #findConfirmed = false;
  #annotationTypes: ReadonlySet<number> = new Set();
  #fileName = '';
  /** Incremented by every open/close so stale async continuations can bail out. */
  #token = 0;
  #documentId: string | null = null;
  readonly #textPages = new Map<number, Promise<ReaderPageText | null>>();

  #elements: ViewerElements | null;
  #confirm: LinkConfirmer;

  constructor(options: ReaderControllerOptions = {}) {
    this.#opts = options;
    this.#elements = options.elements ?? null;
    this.#confirm = options.confirmExternalLink ?? (async () => false);
    this.#gate = new PasswordGate(
      ({ incorrect }) => {
        this.#setSnapshot({
          state: { phase: 'password-required', name: this.#fileName, incorrect },
        });
      },
      () => {
        void this.close();
      },
    );
  }

  /** Provide (or replace) the viewer DOM nodes. Call before the first `openFile`. */
  attach(elements: ViewerElements): void {
    this.#elements = elements;
  }

  /** Provide the function that asks the user before an external link opens. */
  setLinkConfirmer(confirm: LinkConfirmer): void {
    this.#confirm = confirm;
  }

  // ---- external store API ----

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  readonly getSnapshot = (): ReaderSnapshot => this.#snapshot;

  /** Stable content identity for local reading marks; never derived from the filename. */
  get documentId(): string | null {
    return this.#documentId;
  }

  /** Text is loaded on demand, independently of rendered canvases. Keep at most three pages. */
  readPageText(page: number): Promise<ReaderPageText | null> {
    const doc = this.#doc;
    if (!doc || !Number.isInteger(page) || page < 1 || page > doc.numPages)
      return Promise.resolve(null);
    const cached = this.#textPages.get(page);
    if (cached) return cached;
    const token = this.#token;
    const pending = (async () => {
      const pdfPage = await doc.getPage(page);
      if (token !== this.#token) return null;
      // Match TextLayerBuilder's normalization setting exactly so offsets map to visible spans.
      const content = await pdfPage.getTextContent({ disableNormalization: true });
      return token === this.#token ? buildReaderPageText(page, content) : null;
    })();
    this.#textPages.set(page, pending);
    while (this.#textPages.size > 3) this.#textPages.delete(this.#textPages.keys().next().value!);
    return pending;
  }

  #setSnapshot(patch: Partial<ReaderSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener();
  }

  #setView(patch: Partial<ViewStatus>): void {
    const view = this.#snapshot.view;
    if (!view) return;
    const next = { ...view, ...patch };
    const state = this.#snapshot.state;
    this.#setSnapshot({
      view: next,
      state: state.phase === 'ready' ? { ...state, page: next.page, zoom: next.zoom } : state,
    });
  }

  // ---- open / close ----

  async openFile(file: File): Promise<void> {
    const token = await this.#reset();
    this.#fileName = file.name;
    const meta = validateFileMeta(file, this.#opts.maxBytes ?? MAX_PDF_BYTES);
    if (meta) {
      this.#setSnapshot({ state: meta, fileName: file.name });
      return;
    }
    this.#setSnapshot({ state: { phase: 'loading', name: file.name }, fileName: file.name });

    let bytes: Uint8Array | null;
    try {
      let shown = 0;
      bytes = await readFileBytes(file, {
        isCancelled: () => token !== this.#token,
        onProgress: ({ loaded, total }) => {
          // Whole percents only: a 100 MiB file arrives in thousands of chunks.
          const progress = total > 0 ? Math.floor((loaded / total) * 100) / 100 : 0;
          if (token !== this.#token || progress === shown) return;
          shown = progress;
          this.#setSnapshot({ state: { phase: 'loading', name: file.name, progress } });
        },
      });
    } catch (error) {
      // Failing to read the file at all (permissions removed, file gone, disk error) is the
      // user's file system, not PDF.js: Chromium reports it as NotReadableError, or as a bare
      // `TypeError: network error` from Blob#stream(). Both get the "couldn't read this file" copy.
      if (token === this.#token) {
        this.#setSnapshot({
          state: errorState('PERMISSION', error instanceof Error ? error.name : 'Error'),
          view: null,
        });
      }
      return;
    }
    if (bytes === null || token !== this.#token) return;
    if (!hasPdfHeader(bytes)) {
      this.#setSnapshot({ state: notAPdfState() });
      return;
    }

    // Hash before PDF.js transfers the buffer to its worker. No document bytes are persisted.
    if (globalThis.crypto?.subtle) {
      let digest: ArrayBuffer | null = null;
      try {
        digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
      } catch {
        // Reading still works if storage identity cannot be computed; annotations stay disabled.
      }
      if (token !== this.#token) return;
      this.#documentId = digest
        ? Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
        : null;
    }

    try {
      const pdf = await (this.#opts.loadPdfJs ?? loadPdfJs)();
      if (token !== this.#token) return;
      this.#ensureViewer(pdf);
      const task = pdf.lib.getDocument({
        data: bytes,
        // pdfjs-dist 6.x removed the `isEvalSupported` option: the bundles contain no eval() or
        // new Function() at all (PostScript functions are interpreted). PDF JavaScript never runs
        // because no scripting manager is created and XFA is off.
        enableXfa: false,
        // Images above this many pixels are skipped rather than decoded (memory bound).
        maxImageSize: MAX_IMAGE_PIXELS,
        // Runtime data is bundled in the extension (wxt.config.ts hook); never fetched remotely.
        //
        // `useWorkerFetch` must be explicit: PDF.js only auto-enables it for http(s) URLs, so with
        // chrome-extension:// URLs it silently switches wasm off altogether. Wasm itself is
        // requested only when the extension CSP allows it (lib/pdf/wasm.ts); otherwise PDF.js uses
        // its bundled JavaScript fallbacks for JPEG 2000 / JBIG2 and no ICC transform.
        useWorkerFetch: true,
        useWasm: isWasmAllowed(),
        cMapUrl: `${pdf.assetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${pdf.assetBase}standard_fonts/`,
        wasmUrl: `${pdf.assetBase}wasm/`,
        iccUrl: `${pdf.assetBase}iccs/`,
        verbosity: pdf.lib.VerbosityLevel.ERRORS,
      });
      this.#task = task;
      task.onPassword = this.#gate.request;
      const doc = await task.promise;
      if (token !== this.#token) {
        void task.destroy();
        return;
      }
      await this.#attach(doc, token);
    } catch (error) {
      if (token === this.#token) this.#fail(error);
    }
  }

  /** Submit the password the user typed. Returns false if no password is being requested. */
  submitPassword(password: string): boolean {
    if (!this.#gate.isPending) return false;
    // Show "loading" first: PDF.js may ask again (wrong password) before this call returns.
    this.#setSnapshot({ state: { phase: 'loading', name: this.#fileName } });
    return this.#gate.submit(password);
  }

  /** The user dismissed the password prompt: abort the load and return to the empty state. */
  cancelPassword(): void {
    this.#gate.cancel();
  }

  async close(): Promise<void> {
    await this.#reset();
    this.#fileName = '';
    this.#setSnapshot({ state: EMPTY_STATE, view: null, find: IDLE_FIND, fileName: '' });
  }

  /**
   * Release the document and worker (call on unmount). Safe to call repeatedly; React StrictMode
   * runs unmount cleanups once during development and the controller must stay usable after that.
   */
  async destroy(): Promise<void> {
    await this.#reset();
  }

  /** Tear down the current document and return a fresh token for the next load. */
  async #reset(): Promise<number> {
    const token = ++this.#token;
    this.#documentId = null;
    this.#textPages.clear();
    this.#gate.reset();
    const task = this.#task;
    this.#task = null;
    this.#doc = null;
    try {
      this.#viewer?.setDocument(null);
      this.#linkService?.setDocument(null);
    } catch (error) {
      console.warn('PDF viewer cleanup failed', error instanceof Error ? error.name : 'error');
    }
    this.#viewer?.cleanup();
    this.#setSnapshot({ view: null, find: IDLE_FIND, pageErrors: 0, annotationsLimited: false });
    if (task) {
      try {
        await task.destroy();
      } catch {
        // The worker may already be gone; nothing else to release.
      }
    }
    return token;
  }

  #fail(error: unknown): void {
    const state = mapLoadError(error, this.#fileName);
    if (state === null) return;
    // Release the half-open loading task (and its worker) without touching the visible state.
    const task = this.#task;
    this.#task = null;
    void task?.destroy();
    this.#setSnapshot({ state, view: null });
  }

  // ---- viewer wiring ----

  #ensureViewer(pdf: PdfJs): void {
    if (this.#viewer) return;
    const { viewer: v, lib } = pdf;
    this.#annotationTypes = allowedAnnotationTypes(lib.AnnotationType);
    const eventBus = new v.EventBus();
    const confirm: LinkConfirmer = (url) => this.#confirm(url);
    if (!this.#elements) throw new Error('PdfReaderController: attach() the viewer elements first');
    const { container, viewerElement } = this.#elements;

    const ConfirmingLinkService = confirmingLinkService(v.PDFLinkService, confirm);
    const linkService = new ConfirmingLinkService({ eventBus });
    const findController = new v.PDFFindController({ linkService, eventBus });
    const viewer = new v.PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      // Links only: ENABLE draws link/popup annotations but no AcroForm widgets as editable
      // inputs (ENABLE_FORMS would), and no scripting manager exists, so PDF JavaScript never runs.
      annotationMode: lib.AnnotationMode.ENABLE,
      // Reading only: no annotation editors, no highlight/stamp/ink tools, no paste or
      // drag-and-drop of images into the document.
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      // Do not turn plain-text URLs into clickable links; real link annotations still work.
      enableAutoLinking: false,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
    });
    linkService.setViewer(viewer);

    const countRender = () => this.#setSnapshot({ renderCount: this.#snapshot.renderCount + 1 });
    eventBus.on('pagerendered', (evt: { error?: unknown }) => {
      countRender();
      if (evt.error) this.#setSnapshot({ pageErrors: this.#snapshot.pageErrors + 1 });
    });
    eventBus.on('textlayerrendered', countRender);
    eventBus.on('pagechanging', (evt: { pageNumber: number }) => {
      this.#setView({ page: evt.pageNumber });
    });
    eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) => {
      this.#setView({ zoom: evt.scale, scaleValue: evt.presetValue ?? String(evt.scale) });
    });
    // A new query starts a new search; events still in flight from the previous one (they carry
    // its match index, "47 of 100") are ignored until PDF.js reports a state for THIS query.
    eventBus.on(
      'updatefindmatchescount',
      (evt: { matchesCount: { current: number; total: number } }) => {
        if (this.#findQuery !== null && !this.#findConfirmed) return;
        this.#setFind({ ...evt.matchesCount });
      },
    );
    eventBus.on(
      'updatefindcontrolstate',
      (evt: {
        state: number;
        matchesCount: { current: number; total: number };
        rawQuery?: string | null;
      }) => {
        if (this.#findQuery !== null) {
          if (evt.rawQuery !== undefined && evt.rawQuery !== this.#findQuery) return;
          this.#findConfirmed = true;
        }
        this.#setFind({ state: findStateName(evt.state), ...evt.matchesCount });
      },
    );

    this.#eventBus = eventBus;
    this.#linkService = linkService;
    this.#viewer = viewer;
    this.#followContainerSize(viewer, container);
  }

  /**
   * PDF.js viewer components compute `page-width` (and `page-fit`, `auto`) once, when the scale is
   * set; only the PDF.js app listens to window resizes. Without this the page keeps its width when
   * the window shrinks (a horizontal scrollbar) or grows (a gap) while the select still says "Fit
   * width". Re-apply the NAMED scale when the container's size changes, at most once per frame; a
   * numeric zoom is left alone.
   */
  #followContainerSize(viewer: PDFViewer, container: HTMLElement): void {
    if (typeof ResizeObserver !== 'function') return;
    let size = '';
    let frame = 0;
    const refit = (): void => {
      frame = 0;
      const value = viewer.currentScaleValue;
      if (!this.#doc || !value || !Number.isNaN(Number(value))) return;
      viewer.currentScaleValue = value;
    };
    new ResizeObserver(() => {
      const next = `${container.clientWidth}x${container.clientHeight}`;
      if (next === size) return;
      const first = size === '';
      size = next;
      // The first callback only reports the initial size.
      if (first || frame !== 0) return;
      frame = requestAnimationFrame(refit);
    }).observe(container);
  }

  #setFind(patch: Partial<FindStatus>): void {
    this.#setSnapshot({ find: { ...this.#snapshot.find, ...patch } });
  }

  async #attach(doc: PDFDocumentProxy, token: number): Promise<void> {
    const viewer = this.#viewer;
    const linkService = this.#linkService;
    const eventBus = this.#eventBus;
    if (!viewer || !linkService || !eventBus) return;
    const tooMany = validatePageCount(doc.numPages, this.#opts.maxPages);
    if (tooMany) {
      this.#setSnapshot({ state: tooMany });
      void this.#task?.destroy();
      this.#task = null;
      return;
    }
    // A valid file with an empty page tree never fires `pagesinit`: the reader would say
    // "Opening..." for ever. Nothing to show means nothing usable.
    if (doc.numPages < 1) {
      this.#setSnapshot({ state: errorState('CORRUPT', 'no pages') });
      void this.#task?.destroy();
      this.#task = null;
      return;
    }
    if (await isXfaOnly(doc)) {
      if (token !== this.#token) return;
      this.#setSnapshot({ state: errorState('UNSUPPORTED', 'XFA-only form') });
      void this.#task?.destroy();
      this.#task = null;
      return;
    }
    if (token !== this.#token) return;
    this.#doc = doc;
    const ready = new Promise<void>((resolve) => {
      eventBus.on('pagesinit', () => resolve(), { once: true });
    });
    // The viewer only ever sees pages whose annotations are allowlisted and capped (annotations.ts).
    viewer.setDocument(
      guardAnnotations(doc, {
        allowed: this.#annotationTypes,
        onTruncated: () => {
          if (token === this.#token) this.#setSnapshot({ annotationsLimited: true });
        },
      }),
    );
    linkService.setDocument(doc, null);
    await ready;
    if (token !== this.#token) return;
    viewer.currentScaleValue = FIT_WIDTH;
    const view: ViewStatus = {
      pageCount: doc.numPages,
      page: viewer.currentPageNumber,
      zoom: viewer.currentScale,
      scaleValue: viewer.currentScaleValue,
    };
    this.#setSnapshot({
      view,
      state: {
        phase: 'ready',
        name: this.#fileName,
        pageCount: doc.numPages,
        page: view.page,
        zoom: view.zoom,
      },
    });

    // Pages stay on screen either way; only the message changes (no OCR in v1, FR-055).
    const imageOnly = await isImageOnly(doc, { isCancelled: () => token !== this.#token }).catch(
      () => false,
    );
    if (imageOnly && token === this.#token) {
      this.#setSnapshot({
        state: { phase: 'image-only', name: this.#fileName, pageCount: doc.numPages },
      });
    }
  }

  // ---- viewer commands ----

  get #ready(): PDFViewer | null {
    return this.#doc ? this.#viewer : null;
  }

  goToPage(page: number): void {
    const viewer = this.#ready;
    if (viewer) viewer.currentPageNumber = clampPage(page, viewer.pagesCount);
  }

  firstPage(): void {
    this.goToPage(1);
  }

  lastPage(): void {
    this.goToPage(this.#ready?.pagesCount ?? 1);
  }

  nextPage(): void {
    this.#ready?.nextPage();
  }

  previousPage(): void {
    this.#ready?.previousPage();
  }

  /** Set an exact zoom factor (1 = 100%). */
  setZoom(scale: number): void {
    const viewer = this.#ready;
    if (viewer && Number.isFinite(scale) && scale > 0) {
      viewer.currentScale = scale;
      // PDF.js does not emit scalechanging when a numeric scale equals the current fit preset.
      // Still reflect the explicit choice so resize no longer treats it as Fit width.
      this.#setView({ zoom: viewer.currentScale, scaleValue: viewer.currentScaleValue });
    }
  }

  zoomIn(): void {
    this.#ready?.increaseScale();
  }

  zoomOut(): void {
    this.#ready?.decreaseScale();
  }

  fitWidth(): void {
    const viewer = this.#ready;
    if (viewer) viewer.currentScaleValue = FIT_WIDTH;
  }

  find(
    query: string,
    options: { previous?: boolean; again?: boolean; caseSensitive?: boolean } = {},
  ): void {
    const eventBus = this.#eventBus;
    if (!eventBus || !this.#doc) return;
    if (query.trim() === '') {
      this.clearFind();
      return;
    }
    // Kangxi radicals the user typed or pasted would never match the ideographs PDF.js indexes.
    const text = normalizeKangxiRadicals(query);
    if (!options.again || this.#findQuery !== text) {
      this.#findQuery = text;
      this.#findConfirmed = false;
    }
    eventBus.dispatch('find', {
      source: this,
      type: options.again ? 'again' : '',
      query: text,
      caseSensitive: options.caseSensitive ?? false,
      entireWord: false,
      highlightAll: true,
      findPrevious: options.previous ?? false,
      matchDiacritics: false,
    });
  }

  clearFind(): void {
    this.#findQuery = null;
    this.#findConfirmed = false;
    this.#eventBus?.dispatch('findbarclose', { source: this });
    this.#setSnapshot({ find: IDLE_FIND });
  }
}
