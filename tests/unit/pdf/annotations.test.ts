// @vitest-environment node
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it, vi } from 'vitest';
import {
  allowedAnnotationTypes,
  filterAnnotations,
  guardAnnotations,
} from '../../../lib/pdf/annotations';
import { ALLOWED_ANNOTATION_TYPES, MAX_ANNOTATIONS_PER_PAGE } from '../../../lib/pdf/limits';
import { floodPdf, hostilePdf, mediaPdf } from '../../e2e/p7-reader-support/pdfs';

const allowed = allowedAnnotationTypes(pdfjs.AnnotationType);
const T = pdfjs.AnnotationType;

async function open(data: Buffer) {
  const task = pdfjs.getDocument({ data: new Uint8Array(data), verbosity: 0, enableXfa: false });
  return { task, doc: await task.promise };
}

describe('allowed annotation types', () => {
  it('are the documented allowlist, as PDF.js numbers', () => {
    expect([...allowed].sort((a, b) => a - b)).toEqual(
      ALLOWED_ANNOTATION_TYPES.map((name) => T[name]).sort((a, b) => a - b),
    );
    for (const dropped of [
      'RICHMEDIA',
      'SCREEN',
      'SOUND',
      'MOVIE',
      'FILEATTACHMENT',
      'THREED',
      'REDACT',
      'WATERMARK',
    ] as const) {
      expect(allowed.has(T[dropped]), dropped).toBe(false);
    }
  });
});

describe('filterAnnotations', () => {
  const a = (annotationType: number | undefined) => ({ annotationType });

  it('drops disallowed and untyped annotations', () => {
    const { kept, truncated } = filterAnnotations(
      [a(T.LINK), a(T.RICHMEDIA), a(undefined), a(T.POPUP), a(T.SOUND)],
      allowed,
    );
    expect(kept.map((k) => k.annotationType)).toEqual([T.LINK, T.POPUP]);
    expect(truncated).toBe(false);
  });

  it('caps the count and says so only when allowed annotations were cut', () => {
    const many = Array.from({ length: 12 }, () => a(T.LINK));
    expect(filterAnnotations(many, allowed, 10)).toMatchObject({ truncated: true });
    expect(filterAnnotations(many, allowed, 10).kept).toHaveLength(10);
    expect(filterAnnotations(many, allowed, 12).truncated).toBe(false);
    // Disallowed ones beyond the cap are not "truncation": they would never have been drawn.
    const mixed = [...many.slice(0, 10), a(T.SOUND), a(T.SOUND)];
    expect(filterAnnotations(mixed, allowed, 10).truncated).toBe(false);
  });

  it('uses 1,000 per page by default', () => {
    expect(MAX_ANNOTATIONS_PER_PAGE).toBe(1000);
    const many = Array.from({ length: 1500 }, () => a(T.LINK));
    expect(filterAnnotations(many, allowed).kept).toHaveLength(1000);
  });
});

describe('guardAnnotations with real PDF.js', () => {
  it('the media fixture really has RichMedia, Screen, Sound and FileAttachment annotations', async () => {
    const { task, doc } = await open(await mediaPdf());
    const raw = (await (await doc.getPage(1)).getAnnotations()).map((x) => x.annotationType);
    expect(raw).toEqual(
      expect.arrayContaining([T.RICHMEDIA, T.SCREEN, T.SOUND, T.FILEATTACHMENT, T.LINK]),
    );
    await task.destroy();
  });

  it('the page the viewer receives answers getAnnotations() with the allowlist only', async () => {
    const { task, doc } = await open(await mediaPdf());
    const guarded = guardAnnotations(doc, { allowed });
    const page = await guarded.getPage(1);
    const types = (await page.getAnnotations({ intent: 'display' })).map((x) => x.annotationType);
    expect(types).toEqual([T.LINK]);
    // The same wrapper, whichever way the viewer asks.
    expect(
      (await (await guarded.getPage(1)).getAnnotations()).map((x) => x.annotationType),
    ).toEqual([T.LINK]);
    await task.destroy();
  });

  it('keeps forms and links of the hostile PDF (widgets are allowed; they are not rendered as inputs)', async () => {
    const { task, doc } = await open(await hostilePdf());
    const page = await guardAnnotations(doc, { allowed }).getPage(1);
    const types = new Set((await page.getAnnotations()).map((x) => x.annotationType));
    expect(types.has(T.WIDGET)).toBe(true);
    expect(types.has(T.LINK)).toBe(true);
    await task.destroy();
  });

  it('forwards everything else with the real object as `this` (private fields keep working)', async () => {
    const { task, doc } = await open(await mediaPdf());
    const guarded = guardAnnotations(doc, { allowed });
    expect(guarded.numPages).toBe(1);
    const page = await guarded.getPage(1);
    expect(page.pageNumber).toBe(1);
    expect(page.getViewport({ scale: 1 }).width).toBe(612);
    expect((await page.getTextContent()).items.length).toBeGreaterThan(0);
    // A stable object per page.
    expect(await guarded.getPage(1)).toBe(page);
    await task.destroy();
  });

  it('caps a flood of annotations, tells the caller once per call, and stays fast', async () => {
    const { task, doc } = await open(await floodPdf(5000));
    const onTruncated = vi.fn();
    const page = await guardAnnotations(doc, { allowed, onTruncated }).getPage(1);
    const started = performance.now();
    const annotations = await page.getAnnotations();
    expect(annotations).toHaveLength(MAX_ANNOTATIONS_PER_PAGE);
    expect(onTruncated).toHaveBeenCalledWith(1);
    // Parsing 5,000 annotations in Node is quick; this guards against a pathological wrapper.
    expect(performance.now() - started).toBeLessThan(5000);
    await task.destroy();
  });
});
