import type { TextContent } from 'pdfjs-dist/types/src/display/api';

export interface ReaderTextRun {
  /** Index among the nonempty PDF.js text spans, including whitespace spans. */
  index: number;
  start: number;
  end: number;
}

export interface ReaderTextSection {
  start: number;
  end: number;
}

export interface ReaderPageText {
  page: number;
  text: string;
  runs: ReaderTextRun[];
  paragraphs: ReaderTextSection[];
  lang?: string;
}

export interface ReaderTextSelection {
  page: number;
  start: number;
  end: number;
}

/** Keep source offsets: only synthetic line breaks sit outside the text runs. */
export function buildReaderPageText(page: number, content: TextContent): ReaderPageText {
  let text = '';
  let paragraphStart = 0;
  let lastY: number | undefined;
  let lastHeight = 0;
  const runs: ReaderTextRun[] = [];
  const paragraphs: ReaderTextSection[] = [];
  for (const item of content.items) {
    if (!('str' in item)) continue;
    const y = item.transform[5] as number;
    // A larger vertical gap starts a new paragraph; ordinary wrapped lines stay together.
    if (lastY !== undefined && Math.abs(y - lastY) > Math.max(lastHeight, item.height) * 1.7) {
      if (text.slice(paragraphStart).trim())
        paragraphs.push({ start: paragraphStart, end: text.length });
      paragraphStart = text.length;
    }
    if (item.str !== '') {
      runs.push({ index: runs.length, start: text.length, end: text.length + item.str.length });
      text += item.str;
    }
    if (item.hasEOL) text += '\n';
    lastY = y;
    lastHeight = item.height;
  }
  if (text.slice(paragraphStart).trim())
    paragraphs.push({ start: paragraphStart, end: text.length });
  return { page, text, runs, paragraphs, ...(content.lang ? { lang: content.lang } : {}) };
}

function spansOf(container: HTMLElement, page: number): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      // PDF.js removes role=presentation from link-associated source spans for accessibility.
      // Every source text span has dir; marked-content and Find wrappers do not.
      `.page[data-page-number="${page}"] .textLayer span[dir]`,
    ),
  );
}

/** Resolve an offset even when Find has split a PDF.js span into several text nodes. */
function pointAt(span: HTMLElement, offset: number): { node: Node; offset: number } | null {
  const walker = span.ownerDocument.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
}

export function readerTextRange(
  container: HTMLElement,
  model: ReaderPageText,
  start: number,
  end: number,
): Range | null {
  if (end <= start) return null;
  const spans = spansOf(container, model.page);
  const first = model.runs.find((run) => run.end > start && run.start < end);
  const last = model.runs.findLast((run) => run.start < end && run.end > start);
  if (!first || !last) return null;
  const firstSpan = spans[first.index];
  const lastSpan = spans[last.index];
  if (!firstSpan || !lastSpan) return null;
  const a = pointAt(firstSpan, Math.max(0, start - first.start));
  const b = pointAt(lastSpan, Math.min(last.end - last.start, end - last.start));
  if (!a || !b) return null;
  const range = container.ownerDocument.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  return range;
}

/** Capture page-local source offsets; a cross-page selection yields one range per page. */
export async function captureReaderTextSelection(
  container: HTMLElement,
  readPage: (page: number) => Promise<ReaderPageText | null>,
): Promise<ReaderTextSelection[]> {
  const selection = container.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return [];
  const range = selection.getRangeAt(0).cloneRange();
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer))
    return [];
  const inTextLayer = (node: Node) =>
    (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest(
      '.textLayer',
    );
  if (!inTextLayer(range.startContainer) || !inTextLayer(range.endContainer)) return [];
  const pages = Array.from(container.querySelectorAll<HTMLElement>('.page[data-page-number]'));
  const result: ReaderTextSelection[] = [];
  for (const page of pages) {
    if (!page.querySelector('.textLayer') || !range.intersectsNode(page)) continue;
    const pageNumber = Number(page.dataset['pageNumber']);
    const model = await readPage(pageNumber);
    if (!model || !range.startContainer.isConnected || !range.endContainer.isConnected) return [];
    const spans = spansOf(container, pageNumber);
    let start = Infinity;
    let end = -1;
    for (const run of model.runs) {
      const span = spans[run.index];
      if (!span || !range.intersectsNode(span)) continue;
      const slice = span.ownerDocument.createRange();
      slice.selectNodeContents(span);
      if (span.contains(range.startContainer))
        slice.setStart(range.startContainer, range.startOffset);
      if (span.contains(range.endContainer)) slice.setEnd(range.endContainer, range.endOffset);
      const prefix = span.ownerDocument.createRange();
      prefix.selectNodeContents(span);
      prefix.setEnd(slice.startContainer, slice.startOffset);
      const localStart = run.start + prefix.toString().length;
      start = Math.min(start, localStart);
      end = Math.max(end, localStart + slice.toString().length);
    }
    if (end > start) result.push({ page: pageNumber, start, end });
  }
  return result;
}
