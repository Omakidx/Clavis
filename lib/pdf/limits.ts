/**
 * PDF reader limits (docs/architecture.md section 8, Spike C).
 */

/**
 * Largest PDF the reader accepts, in bytes (100 MiB).
 *
 * The whole file is read into one ArrayBuffer in the reader tab and handed to the PDF.js worker,
 * so the tab holds roughly the file size once or twice, plus parsed structures and page canvases.
 * 100 MiB covers almost every text-heavy document, including long scanned books, while keeping
 * the peak well inside a typical 4 GB machine. Bigger files get a clear TOO_LARGE message instead
 * of a tab crash.
 */
export const MAX_PDF_BYTES = 100 * 1024 * 1024;

/**
 * Most pages the reader opens. The viewer creates a DOM node and a page view for every page up
 * front (only 10 hold canvases), so memory and open time grow with the page count even when the
 * file is small. 5,000 pages is far beyond books and reports (the 100-page fixture needs 100
 * placeholders) while a crafted file with millions of tiny pages gets a TOO_LARGE message instead
 * of a frozen tab.
 */
export const MAX_PDF_PAGES = 5000;

/**
 * Largest single image PDF.js will decode, in pixels (`getDocument({ maxImageSize })`; larger
 * images are skipped, not rendered). Decoded RGBA costs 4 bytes per pixel, so 50 million pixels is
 * about 200 MB for one image. That still covers an A4 page scanned at 600 dpi (about 35 million
 * pixels) and Legal at 600 dpi (about 50 million is the edge); beyond it the PDF could exhaust the
 * tab with one image.
 */
export const MAX_IMAGE_PIXELS = 50_000_000;

/**
 * Largest page canvas, in pixels (`PDFViewer({ maxCanvasPixels })`; PDF.js default is 33.5
 * million). 16.7 million (4096 x 4096) covers a US Letter or A4 page at 200% zoom on a 2x display
 * (about 14 million) and a 4K monitor at 175% (about 10.5 million). Above it PDF.js renders the
 * visible part in a detail canvas over a CSS-scaled bitmap (`enableDetailCanvas`), so very high
 * zoom stays sharp while the memory per page stays bounded; with 10 buffered pages the canvas
 * ceiling is about 670 MB at this cap.
 */
export const MAX_CANVAS_PIXELS = 4096 * 4096;

/**
 * How many leading pages are scanned for text items before the document is declared image-only.
 * Cover pages, blank pages or a full-page logo often come first, so one page is too few; five
 * keeps the check cheap (five getTextContent calls) without scanning the document (FR-059).
 */
export const IMAGE_ONLY_SCAN_PAGES = 5;

/** Only these URL schemes may be opened from a PDF link, and only after user confirmation. */
export const ALLOWED_LINK_SCHEMES = ['https:', 'http:', 'mailto:'] as const;

/** Zoom presets offered by the shell (fractions of 100%). The viewer clamps to 0.1..10. */
export const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** Values accepted by PDFViewer.currentScaleValue that the shell uses besides numbers. */
export const FIT_WIDTH = 'page-width';
