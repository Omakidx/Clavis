import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const WORDS = (
  'reader memory canvas page render viewport buffer release document scroll jump zoom text layer ' +
  'selection toolbar explain listen pronounce phrase sentence margin column figure table caption'
).split(' ');

/**
 * A text PDF with `pages` US-Letter pages and about 38 lines of text per page (a dense book page:
 * the text layer is the part that costs DOM nodes). Generated, never committed: a 1,000-page
 * fixture would bloat the repository, and the generator is deterministic (no clock, no random).
 * Returns the file path and a dispose function.
 */
export async function makeLongPdf(
  pages: number,
): Promise<{ file: string; bytes: number; dispose(): Promise<void> }> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Chapter page ${p} of ${pages}`, { x: 54, y: 740, size: 16, font });
    for (let line = 0; line < 38; line++) {
      const words: string[] = [];
      for (let w = 0; w < 11; w++) words.push(WORDS[(p * 7 + line * 3 + w * 5) % WORDS.length]!);
      page.drawText(`${line + 1}. ${words.join(' ')}.`, {
        x: 54,
        y: 710 - line * 17,
        size: 10.5,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
  }
  const bytes = await doc.save({ useObjectStreams: true });
  const dir = await mkdtemp(path.join(tmpdir(), 'clavis-p9-pdf-'));
  const file = path.join(dir, `long-${pages}.pdf`);
  await writeFile(file, bytes);
  return {
    file,
    bytes: bytes.length,
    dispose: () => rm(dir, { recursive: true, force: true }).catch(() => undefined),
  };
}
