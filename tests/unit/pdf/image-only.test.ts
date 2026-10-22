import { describe, expect, it, vi } from 'vitest';
import { isImageOnly, type TextProbeDocument } from '../../../lib/pdf/image-only';
import { IMAGE_ONLY_SCAN_PAGES } from '../../../lib/pdf/limits';

/** Document whose page N has the given text items (strings; marked content has no `str`). */
function fakeDoc(pages: Array<Array<string | { type: string }>>): {
  doc: TextProbeDocument;
  getPage: ReturnType<typeof vi.fn>;
} {
  const getPage = vi.fn(async (n: number) => ({
    getTextContent: async () => ({
      items: (pages[n - 1] ?? []).map((i) => (typeof i === 'string' ? { str: i } : i)),
    }),
    cleanup: vi.fn(),
  }));
  return { doc: { numPages: pages.length, getPage }, getPage };
}

describe('isImageOnly', () => {
  it('is true when no scanned page has any text item', async () => {
    const { doc } = fakeDoc([[], [], []]);
    expect(await isImageOnly(doc)).toBe(true);
  });

  it('treats whitespace-only and marked-content items as no text', async () => {
    const { doc } = fakeDoc([[' ', '\n', { type: 'beginMarkedContent' }]]);
    expect(await isImageOnly(doc)).toBe(true);
  });

  it('is false as soon as a page has visible text, without scanning further', async () => {
    const { doc, getPage } = fakeDoc([[], ['Chapter 1'], [], []]);
    expect(await isImageOnly(doc)).toBe(false);
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('only scans the first N pages, so a long scan is not read in full', async () => {
    const pages = Array.from({ length: 50 }, () => [] as string[]);
    pages[40] = ['text far into the document'];
    const { doc, getPage } = fakeDoc(pages);
    expect(await isImageOnly(doc)).toBe(true); // text on page 41 is outside the window
    expect(getPage).toHaveBeenCalledTimes(IMAGE_ONLY_SCAN_PAGES);
  });

  it('respects a custom scan window and shorter documents', async () => {
    const { doc, getPage } = fakeDoc([[], ['late text']]);
    expect(await isImageOnly(doc, { scanPages: 1 })).toBe(true);
    expect(getPage).toHaveBeenCalledTimes(1);
    expect(await isImageOnly(doc, { scanPages: 99 })).toBe(false);
  });

  it('is false for a document without pages (nothing to claim)', async () => {
    expect(await isImageOnly({ numPages: 0, getPage: vi.fn() })).toBe(false);
  });

  it('stops without a verdict when cancelled', async () => {
    const { doc, getPage } = fakeDoc([[], []]);
    expect(await isImageOnly(doc, { isCancelled: () => true })).toBe(false);
    expect(getPage).not.toHaveBeenCalled();
  });

  it('releases each probed page even when text extraction fails', async () => {
    const cleanup = vi.fn();
    const doc: TextProbeDocument = {
      numPages: 1,
      getPage: async () => ({
        getTextContent: async () => {
          throw new Error('broken page');
        },
        cleanup,
      }),
    };
    await expect(isImageOnly(doc)).rejects.toThrow('broken page');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
