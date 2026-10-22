import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { isImageOnly } from './image-only';
import {
  ALLOWED_LINK_SCHEMES,
  FIT_WIDTH,
  MAX_CANVAS_PIXELS,
  MAX_IMAGE_PIXELS,
  MAX_PDF_BYTES,
} from './limits';
import { PasswordGate } from './password';
import { loadPdfJs, type PdfJs } from './pdfjs';
import { isWasmAllowed } from './wasm';
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

export interface FindStatus {
  state: 'idle' | 'pending' | 'found' | 'not-found' | 'wrapped';
  current: number;
  total: number;
}

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

const IDLE_FIND: FindStatus = { state: 'idle', current: 0, total: 0 };

/** Return a displayable, credential-free http(s)/mailto URL, or null for anything else. */
export function toSafeExternalUrl(raw: string): URL | null {
  const url = URL.parse(raw);
  if (!url) return null;
  if (!(ALLOWED_LINK_SCHEMES as readonly string[]).includes(url.protocol)) return null;
  url.username = '';
  url.password = '';
  return url;
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
  #snapshot: ReaderSnapshot = { state: EMPTY_STATE, view: null, find: IDLE_FIND, renderCount: 0 };
  #viewer: PDFViewer | null = null;
  #linkService: PDFLinkService | null = null;
  #eventBus: InstanceType<PdfJs['viewer']['EventBus']> | null = null;
  #task: PDFDocumentLoadingTask | null = null;
  #doc: PDFDocumentProxy | null = null;
  #fileName = '';
  /** Incremented by every open/close so stale async continuations can bail out. */
  #token = 0;

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
      this.#setSnapshot({ state: meta });
      return;
    }
    this.#setSnapshot({ state: { phase: 'loading', name: file.name } });

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (token === this.#token) this.#fail(error);
      return;
    }
    if (token !== this.#token) return;
    if (!hasPdfHeader(bytes)) {
      this.#setSnapshot({ state: notAPdfState() });
      return;
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
    this.#setSnapshot({ state: EMPTY_STATE, view: null, find: IDLE_FIND });
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
    this.#setSnapshot({ view: null, find: IDLE_FIND });
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
    const eventBus = new v.EventBus();
    const confirm: LinkConfirmer = (url) => this.#confirm(url);
    if (!this.#elements) throw new Error('PdfReaderController: attach() the viewer elements first');
    const { container, viewerElement } = this.#elements;

    // PDFLinkService variant that never navigates by itself: external links are shown with a
    // neutral href and open in a new tab only after the user confirms (architecture section 8).
    class ConfirmingLinkService extends v.PDFLinkService {
      override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
        const safe = toSafeExternalUrl(url);
        link.removeAttribute('target');
        link.rel = 'noopener noreferrer nofollow';
        link.href = '#';
        if (!safe) {
          link.title = '';
          link.onclick = () => false;
          return;
        }
        link.title = safe.href;
        link.onclick = (event: MouseEvent) => {
          event.preventDefault();
          void confirm(safe.href).then((ok) => {
            if (ok) window.open(safe.href, '_blank', 'noopener,noreferrer');
          });
          return false;
        };
      }
    }

    const linkService = new ConfirmingLinkService({ eventBus });
    const findController = new v.PDFFindController({ linkService, eventBus });
    const viewer = new v.PDFViewer({
      container,
      viewer: viewerElement,
      eventBus,
      linkService,
      findController,
      // Links only: no form widgets and no scripting manager, so PDF JavaScript never runs.
      annotationMode: lib.AnnotationMode.ENABLE,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
    });
    linkService.setViewer(viewer);

    const countRender = () => this.#setSnapshot({ renderCount: this.#snapshot.renderCount + 1 });
    eventBus.on('pagerendered', countRender);
    eventBus.on('textlayerrendered', countRender);
    eventBus.on('pagechanging', (evt: { pageNumber: number }) => {
      this.#setView({ page: evt.pageNumber });
    });
    eventBus.on('scalechanging', (evt: { scale: number; presetValue?: string }) => {
      this.#setView({ zoom: evt.scale, scaleValue: evt.presetValue ?? String(evt.scale) });
    });
    eventBus.on(
      'updatefindmatchescount',
      (evt: { matchesCount: { current: number; total: number } }) => {
        this.#setFind({ ...evt.matchesCount });
      },
    );
    eventBus.on(
      'updatefindcontrolstate',
      (evt: { state: number; matchesCount: { current: number; total: number } }) => {
        const names = ['found', 'not-found', 'wrapped', 'pending'] as const;
        const state = names[evt.state] ?? 'found';
        this.#setFind({ state, ...evt.matchesCount });
      },
    );

    this.#eventBus = eventBus;
    this.#linkService = linkService;
    this.#viewer = viewer;
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
    if (doc.isPureXfa) {
      this.#setSnapshot({ state: errorState('UNSUPPORTED', 'XFA-only form') });
      void this.#task?.destroy();
      this.#task = null;
      return;
    }
    this.#doc = doc;
    const ready = new Promise<void>((resolve) => {
      eventBus.on('pagesinit', () => resolve(), { once: true });
    });
    viewer.setDocument(doc);
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

  nextPage(): void {
    this.#ready?.nextPage();
  }

  previousPage(): void {
    this.#ready?.previousPage();
  }

  /** Set an exact zoom factor (1 = 100%). */
  setZoom(scale: number): void {
    const viewer = this.#ready;
    if (viewer && Number.isFinite(scale) && scale > 0) viewer.currentScale = scale;
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

  find(query: string, options: { previous?: boolean; again?: boolean } = {}): void {
    const eventBus = this.#eventBus;
    if (!eventBus || !this.#doc) return;
    if (query.trim() === '') {
      this.clearFind();
      return;
    }
    eventBus.dispatch('find', {
      source: this,
      type: options.again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: options.previous ?? false,
      matchDiacritics: false,
    });
  }

  clearFind(): void {
    this.#eventBus?.dispatch('findbarclose', { source: this });
    this.#setSnapshot({ find: IDLE_FIND });
  }
}
