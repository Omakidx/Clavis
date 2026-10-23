import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RawPdf, textLine } from './rawpdf';

/**
 * Files that are generated at TEST time into a temp directory because they are too big to commit:
 * a document with N pages (a few hundred bytes per page, all sharing one content stream) and a
 * sparse file of a given size.
 */
export function tempDir(prefix = 'clavis-accept-'): { dir: string; dispose(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A valid PDF with `count` pages; page n is a 200x200 pt page that shows "Synthetic page N". */
export function manyPages(count: number): Buffer {
  const pdf = new RawPdf();
  const font = pdf.add('<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>');
  const root = pdf.reserve();
  const tree = pdf.reserve();
  // One content stream shared by every page (legal; keeps the file small).
  const content = pdf.add('<<>>', Buffer.from(textLine('Synthetic page', 20, 100, 14), 'latin1'));
  const kids: number[] = [];
  for (let i = 0; i < count; i++) {
    kids.push(
      pdf.add(
        `<</Type /Page /Parent ${tree} 0 R /MediaBox [0 0 200 200] /Resources <</Font <</F1 ${font} 0 R>>>> /Contents ${content} 0 R>>`,
      ),
    );
  }
  pdf.set(
    tree,
    `<</Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${count}>>`,
  );
  pdf.set(root, `<</Type /Catalog /Pages ${tree} 0 R>>`);
  return pdf.build(root);
}

/**
 * A SPARSE file of exactly `size` bytes that starts with a PDF header (so a header check cannot be
 * what rejects it). Disk usage is a few KiB; the reader must reject it from `file.size` alone
 * (over the limit) or fail on its content (at the limit) without us writing 100 MiB.
 */
export function sparsePdf(file: string, size: number): void {
  const fd = openSync(file, 'w');
  try {
    writeSync(fd, Buffer.from('%PDF-1.7\n', 'latin1'));
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }
}

export function writeTemp(dir: string, name: string, bytes: Uint8Array): string {
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}
