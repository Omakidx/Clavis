// @vitest-environment node
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { hostilePdf, HOSTILE_LINES } from '../../e2e/p7-reader-support/pdfs';

/**
 * Real PDF.js (the Node build of the pinned version) against the hostile test PDF: confirms the
 * fixture really contains what the E2E hardening tests rely on, so a green E2E means something.
 */
async function load() {
  const task = pdfjs.getDocument({
    data: new Uint8Array(await hostilePdf()),
    verbosity: 0,
    enableXfa: false,
  });
  const doc = await task.promise;
  const page = await doc.getPage(1);
  return { task, doc, page };
}

describe('hostile PDF fixture', () => {
  it('has markup-like text lines as ordinary text items', async () => {
    const { task, page } = await load();
    const content = await page.getTextContent();
    const items = content.items.map((i) => ('str' in i ? i.str : ''));
    for (const line of HOSTILE_LINES) expect(items).toContain(line);
    await task.destroy();
  });

  it('has an AcroForm text widget and link annotations, and the unsafe URLs are not in the parsed links', async () => {
    const { task, page } = await load();
    const annotations = await page.getAnnotations();
    const subtypes = annotations.map((a) => a.subtype);
    expect(subtypes).toContain('Widget');
    expect(subtypes.filter((s) => s === 'Link').length).toBeGreaterThanOrEqual(5);
    const urls = annotations.flatMap((a) => (typeof a.url === 'string' ? [a.url] : []));
    // PDF.js itself drops targets it does not consider safe; the reader refuses them again.
    expect(urls).toEqual(['https://example.com/clavis-hostile-ok']);
    await task.destroy();
  });

  it('has JavaScript actions that PDF.js can see and this reader never runs', async () => {
    const { task, doc, page } = await load();
    // The document is hostile: PDF.js reports the script. The reader creates no scripting manager,
    // so it is never executed (E2E: no dialog, no global).
    expect(await doc.hasJSActions()).toBe(true);
    const link = (await page.getAnnotations()).find(
      (a) => a.subtype === 'Link' && a.action === 'JavaScript',
    );
    expect(link === undefined || link.url === undefined).toBe(true);
    await task.destroy();
  });
});
