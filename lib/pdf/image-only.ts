import { IMAGE_ONLY_SCAN_PAGES } from './limits';

/** The slice of PDFDocumentProxy that image-only detection needs (keeps it testable without PDF.js). */
export interface TextProbeDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getTextContent(): Promise<{ items: ReadonlyArray<unknown> }>;
    cleanup?: () => unknown;
  }>;
}

function hasVisibleText(item: unknown): boolean {
  return (
    typeof item === 'object' &&
    item !== null &&
    'str' in item &&
    typeof item.str === 'string' &&
    item.str.trim() !== ''
  );
}

/**
 * True when none of the first `scanPages` pages has a non-blank text item, i.e. the document is
 * almost certainly a scan without an OCR layer. Stops at the first page that has text.
 * `isCancelled` lets the caller abandon the scan when the document was closed meanwhile.
 */
export async function isImageOnly(
  doc: TextProbeDocument,
  options: { scanPages?: number; isCancelled?: () => boolean } = {},
): Promise<boolean> {
  const scanPages = options.scanPages ?? IMAGE_ONLY_SCAN_PAGES;
  const last = Math.min(doc.numPages, Math.max(scanPages, 1));
  if (last < 1) return false;
  for (let n = 1; n <= last; n++) {
    if (options.isCancelled?.()) return false;
    const page = await doc.getPage(n);
    try {
      const content = await page.getTextContent();
      if (content.items.some(hasVisibleText)) return false;
    } finally {
      page.cleanup?.();
    }
  }
  return true;
}
