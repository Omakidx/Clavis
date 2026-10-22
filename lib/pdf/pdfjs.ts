import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type PdfJsLib = typeof import('pdfjs-dist');
export type PdfJsViewer = typeof import('pdfjs-dist/web/pdf_viewer.mjs');

/** Everything the reader needs from PDF.js, loaded lazily and wired to extension-local assets. */
export interface PdfJs {
  lib: PdfJsLib;
  viewer: PdfJsViewer;
  /** Absolute URL prefix (with trailing slash) of the bundled cmaps/, standard_fonts/, wasm/, iccs/. */
  assetBase: string;
}

/** Where wxt.config.ts copies PDF.js runtime data (see the `build:publicAssets` hook). */
export const PDFJS_ASSET_DIR = 'pdfjs/';

let pending: Promise<PdfJs> | undefined;

/**
 * Load PDF.js core and the viewer components once.
 *
 * Order matters: web/pdf_viewer.mjs reads `globalThis.pdfjsLib`, which the core build sets when
 * it is evaluated, so the core is awaited first. The worker is the locally bundled
 * `pdf.worker.min.mjs` (Vite `?url` asset, emitted under assets/ with a hash). Both URLs resolve
 * against the extension origin (`chrome-extension://<id>/`); nothing is fetched from a CDN.
 */
export function loadPdfJs(): Promise<PdfJs> {
  pending ??= (async () => {
    const lib = await import('pdfjs-dist');
    const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs');
    lib.GlobalWorkerOptions.workerSrc = new URL(workerUrl, location.href).href;
    return { lib, viewer, assetBase: new URL(`/${PDFJS_ASSET_DIR}`, location.href).href };
  })().catch((error: unknown) => {
    pending = undefined; // allow a retry after a transient failure
    throw error;
  });
  return pending;
}
