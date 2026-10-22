import { describe, expect, it } from 'vitest';
import {
  MAX_CANVAS_PIXELS,
  MAX_IMAGE_PIXELS,
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
} from '../../../lib/pdf/limits';
import {
  clampPage,
  errorState,
  hasPdfHeader,
  mapLoadError,
  notAPdfState,
  validateFileMeta,
  validatePageCount,
} from '../../../lib/pdf/state';

const named = (name: string) =>
  Object.assign(new Error('raw PDF.js text that must not leak'), { name });

describe('mapLoadError', () => {
  it.each([
    ['InvalidPDFException', 'CORRUPT'],
    ['MissingPDFException', 'CORRUPT'],
    ['FormatError', 'CORRUPT'],
    ['XRefParseException', 'CORRUPT'],
    ['NotReadableError', 'PERMISSION'],
    ['NotAllowedError', 'PERMISSION'],
    ['SecurityError', 'PERMISSION'],
    ['RangeError', 'TOO_LARGE'],
    ['UnexpectedResponseException', 'UNSUPPORTED'],
    ['SomethingNew', 'UNSUPPORTED'],
  ] as const)('maps %s to %s', (name, code) => {
    const state = mapLoadError(named(name), 'a.pdf');
    expect(state).toMatchObject({ phase: 'error', code });
  });

  it('ignores cancellations so a superseded load shows nothing', () => {
    expect(mapLoadError(named('AbortException'))).toBeNull();
  });

  it('maps a surfaced PasswordException to password-required for that file', () => {
    expect(mapLoadError(named('PasswordException'), 'secret.pdf')).toEqual({
      phase: 'password-required',
      name: 'secret.pdf',
    });
  });

  it('never copies the raw error text, file name or bytes into the message', () => {
    const state = mapLoadError(named('InvalidPDFException'), 'my-private-file.pdf');
    expect(state?.phase).toBe('error');
    const message = state?.phase === 'error' ? state.message : '';
    expect(message).not.toContain('raw PDF.js text');
    expect(message).not.toContain('my-private-file');
  });

  it('handles non-Error throwables', () => {
    expect(mapLoadError('boom')).toMatchObject({ phase: 'error', code: 'UNSUPPORTED' });
    expect(mapLoadError(null)).toMatchObject({ phase: 'error', code: 'UNSUPPORTED' });
  });
});

describe('file size limit', () => {
  const file = (size: number) => ({ name: 'x.pdf', size, type: 'application/pdf' });

  it('uses 100 MiB as the default limit', () => {
    expect(MAX_PDF_BYTES).toBe(100 * 1024 * 1024);
  });

  it('accepts a file exactly at the limit and rejects one byte over', () => {
    expect(validateFileMeta(file(MAX_PDF_BYTES))).toBeNull();
    expect(validateFileMeta(file(MAX_PDF_BYTES + 1))).toMatchObject({
      phase: 'error',
      code: 'TOO_LARGE',
    });
  });

  it('honours a custom limit', () => {
    expect(validateFileMeta(file(11), 10)).toMatchObject({ code: 'TOO_LARGE' });
    expect(validateFileMeta(file(10), 10)).toBeNull();
  });

  it('rejects an empty file as corrupt', () => {
    expect(validateFileMeta(file(0))).toMatchObject({ phase: 'error', code: 'CORRUPT' });
  });
});

describe('page-count and memory limits', () => {
  it('caps documents at 5,000 pages, with the boundary inclusive', () => {
    expect(MAX_PDF_PAGES).toBe(5000);
    expect(validatePageCount(MAX_PDF_PAGES)).toBeNull();
    expect(validatePageCount(MAX_PDF_PAGES + 1)).toMatchObject({
      phase: 'error',
      code: 'TOO_LARGE',
      limit: 'pages',
    });
    expect(validatePageCount(1)).toBeNull();
    expect(validatePageCount(11, 10)).toMatchObject({ code: 'TOO_LARGE' });
    expect(validatePageCount(10, 10)).toBeNull();
  });

  it('marks the byte limit so the UI can name it', () => {
    expect(validateFileMeta({ name: 'x', size: MAX_PDF_BYTES + 1, type: '' })).toMatchObject({
      limit: 'bytes',
    });
  });

  it('keeps image and canvas ceilings inside sane memory bounds', () => {
    // RGBA bytes for one decoded image / one page canvas.
    expect(MAX_IMAGE_PIXELS * 4).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(MAX_CANVAS_PIXELS * 4).toBeLessThanOrEqual(80 * 1024 * 1024);
    // A4 at 600 dpi (4961 x 7016) still decodes; a 4K-display Letter page at 175% fits the canvas.
    expect(4961 * 7016).toBeLessThanOrEqual(MAX_IMAGE_PIXELS);
    expect(
      Math.ceil(612 * (96 / 72) * 1.75 * 2) * Math.ceil(792 * (96 / 72) * 1.75 * 2),
    ).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
  });
});

describe('hasPdfHeader', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('finds %PDF- at the start', () => {
    expect(hasPdfHeader(bytes('%PDF-1.7\n...'))).toBe(true);
  });

  it('finds %PDF- after leading junk inside the first 1024 bytes', () => {
    expect(hasPdfHeader(bytes(`${' '.repeat(500)}%PDF-1.4`))).toBe(true);
  });

  it('does not look past the first 1024 bytes', () => {
    expect(hasPdfHeader(bytes(`${' '.repeat(1100)}%PDF-1.4`))).toBe(false);
  });

  it('rejects text, empty and tiny inputs', () => {
    expect(hasPdfHeader(bytes('hello world'))).toBe(false);
    expect(hasPdfHeader(new Uint8Array())).toBe(false);
    expect(hasPdfHeader(bytes('%PD'))).toBe(false);
  });
});

describe('state helpers', () => {
  it('builds an UNSUPPORTED state for non-PDF content', () => {
    expect(notAPdfState()).toMatchObject({ phase: 'error', code: 'UNSUPPORTED' });
  });

  it('errorState appends only the supplied diagnostic detail', () => {
    const state = errorState('CORRUPT', 'empty file');
    expect(state).toMatchObject({ phase: 'error', code: 'CORRUPT' });
    expect(state.phase === 'error' && state.message).toContain('(empty file)');
  });

  it('clampPage keeps the page inside 1..pageCount', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(11, 10)).toBe(10);
    expect(clampPage(4.9, 10)).toBe(4);
    expect(clampPage(Number.NaN, 10)).toBe(1);
    expect(clampPage(3, 0)).toBe(1);
  });
});
