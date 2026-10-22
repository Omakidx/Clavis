import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import { isImageOnly } from '../../../lib/pdf/image-only';
import { PasswordGate } from '../../../lib/pdf/password';
import { hasPdfHeader, mapLoadError } from '../../../lib/pdf/state';

/**
 * Real PDF.js (the Node-compatible legacy build of the same pinned version) against the generated
 * fixtures: checks that the fixtures are what the E2E tests assume, and that the reader's own
 * pure modules agree with what PDF.js actually reports.
 */
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures/pdf');
const bytesOf = (file: string) => new Uint8Array(readFileSync(path.join(dir, file)));

interface ManifestEntry {
  file: string;
  pages: number;
  bytes: number;
  sha256: string;
  password?: string;
  sentences: Array<{ page: number; text: string }>;
}
const manifest = JSON.parse(
  readFileSync(path.join(dir, 'manifest.json'), 'utf8'),
) as ManifestEntry[];
const entry = (file: string) => manifest.find((m) => m.file === file)!;

async function open(file: string, extra: Partial<Parameters<typeof pdfjs.getDocument>[0]> = {}) {
  const task = pdfjs.getDocument({ data: bytesOf(file), verbosity: 0, ...extra });
  return { task, doc: await task.promise };
}

async function pageText(doc: Awaited<ReturnType<typeof open>>['doc'], n: number): Promise<string> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  return content.items.map((i) => ('str' in i ? i.str : '')).join('\n');
}

describe('fixture manifest', () => {
  it.each(manifest.map((m) => [m.file, m] as const))(
    '%s matches its recorded size and hash',
    (file, m) => {
      const data = bytesOf(file);
      expect(data.length).toBe(m.bytes);
      expect(createHash('sha256').update(data).digest('hex')).toBe(m.sha256);
    },
  );
});

describe('text fixtures', () => {
  it.each(['text-1page.pdf', 'multi-column.pdf', 'rotated-page.pdf', 'links.pdf', 'icc-image.pdf'])(
    '%s has the recorded page count and every recorded sentence as a text item',
    async (file) => {
      const { task, doc } = await open(file);
      expect(doc.numPages).toBe(entry(file).pages);
      for (const s of entry(file).sentences) {
        expect(await pageText(doc, s.page)).toContain(s.text);
      }
      await task.destroy();
    },
  );

  it('text-100pages.pdf has 100 pages and "xylophone" only on page 73', async () => {
    const { task, doc } = await open('text-100pages.pdf');
    expect(doc.numPages).toBe(100);
    const hits: number[] = [];
    for (let n = 1; n <= 100; n++) {
      if ((await pageText(doc, n)).includes('xylophone')) hits.push(n);
    }
    expect(hits).toEqual([73]);
    await task.destroy();
  });

  it('rotated-page.pdf is rotated by 90 degrees', async () => {
    const { task, doc } = await open('rotated-page.pdf');
    expect((await doc.getPage(1)).rotate).toBe(90);
    await task.destroy();
  });

  it('is not detected as image-only', async () => {
    const { task, doc } = await open('text-1page.pdf');
    expect(await isImageOnly(doc)).toBe(false);
    await task.destroy();
  });
});

describe('image-only.pdf', () => {
  it('has three pages and no text items, so the detector says image-only', async () => {
    const { task, doc } = await open('image-only.pdf');
    expect(doc.numPages).toBe(3);
    expect(await isImageOnly(doc)).toBe(true);
    await task.destroy();
  });
});

describe('corrupt.pdf', () => {
  it('has a PDF header but PDF.js rejects it, and the reader maps that to CORRUPT', async () => {
    expect(hasPdfHeader(bytesOf('corrupt.pdf'))).toBe(true);
    const task = pdfjs.getDocument({ data: bytesOf('corrupt.pdf'), verbosity: 0 });
    const error = await task.promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    expect(mapLoadError(error, 'corrupt.pdf')).toMatchObject({ phase: 'error', code: 'CORRUPT' });
    await task.destroy();
  });
});

describe('encrypted.pdf (hand-built RC4-40 fixture)', () => {
  it('asks for a password, flags a wrong one, and opens with the right one via PasswordGate', async () => {
    const password = entry('encrypted.pdf').password!;
    const prompts: boolean[] = [];
    let attempts = 0;
    const gate: PasswordGate = new PasswordGate(
      ({ incorrect }) => {
        prompts.push(incorrect);
        // Simulate the user: first a wrong password, then the right one.
        queueMicrotask(() => gate.submit(attempts++ === 0 ? 'not-the-password' : password));
      },
      () => {
        throw new Error('prompt must not be cancelled');
      },
    );
    const task = pdfjs.getDocument({ data: bytesOf('encrypted.pdf'), verbosity: 0 });
    task.onPassword = gate.request;
    const doc = await task.promise;
    expect(prompts).toEqual([false, true]);
    expect(await pageText(doc, 1)).toContain(entry('encrypted.pdf').sentences[0]!.text);
    await task.destroy();
  });

  it('is rejected with a PasswordException when the prompt is cancelled (no password given)', async () => {
    const task = pdfjs.getDocument({ data: bytesOf('encrypted.pdf'), verbosity: 0 });
    const error = await task.promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(mapLoadError(error, 'encrypted.pdf')).toEqual({
      phase: 'password-required',
      name: 'encrypted.pdf',
    });
    await task.destroy();
  });
});
