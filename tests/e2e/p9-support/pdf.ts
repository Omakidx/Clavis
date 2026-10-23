import { manyPages, tempDir, writeTemp } from '../p7-accept-support/synth';

/** A temp directory for PDFs generated at test time (too big to commit); `dispose` removes it. */
export function synthDir(): { pages(count: number): string; dispose(): void } {
  const { dir, dispose } = tempDir('clavis-p9-');
  return {
    /** A valid PDF with `count` tiny pages, written into the directory; returns its path. */
    pages: (count) => writeTemp(dir, `pages-${count}.pdf`, manyPages(count)),
    dispose,
  };
}
