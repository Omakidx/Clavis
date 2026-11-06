import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { acceptDir, acceptManifest, acceptPath } from './p7-accept-support/manifest';

// The acceptance fixtures themselves (no browser, no extension): the manifest matches the bytes,
// the files are small, every line the E2E specs expect is really in the PDF according to real
// PDF.js, passwords behave. Regenerate with `npx tsx scripts/fixtures/make-accept-pdfs.ts`
// (byte-identical on this machine); `... --verify` adds a Ghostscript cross-check.
const entries = acceptManifest();
const squash = (s: string): string => s.replace(/\s+/g, '');

test('every file in the fixture directory is listed in the manifest, and vice versa', () => {
  const onDisk = readdirSync(acceptDir)
    .filter((f) => f !== 'manifest.json')
    .sort();
  expect(entries.map((e) => e.file).sort()).toEqual(onDisk);
});

test('the fixtures are small enough to commit (each under 100 KB, 450 KB in total)', () => {
  let total = 0;
  for (const entry of entries) {
    const size = statSync(acceptPath(entry.file)).size;
    total += size;
    expect(size, entry.file).toBeLessThan(100 * 1024);
  }
  expect(total).toBeLessThan(450 * 1024);
});

for (const entry of entries) {
  test(`${entry.file}: size and SHA-256 match the manifest`, () => {
    const bytes = readFileSync(acceptPath(entry.file));
    expect(bytes.length).toBe(entry.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  });
}

test('fixtures with embedded third-party fonts record their licences', () => {
  for (const entry of entries.filter(
    (e) => (e.fonts ?? []).length > 0 && /^(skia|gs|enc)/.test(e.producer),
  )) {
    expect(entry.licenses?.length, entry.file).toBeGreaterThan(0);
    for (const licence of entry.licenses ?? []) {
      expect(licence, entry.file).toMatch(/OFL|Apache|Bitstream Vera/);
    }
  }
});

test('encrypted fixtures record passwords; PDF.js needs them and rejects wrong ones', async () => {
  for (const entry of entries.filter((e) => e.password !== undefined)) {
    const data = new Uint8Array(readFileSync(acceptPath(entry.file)));
    const open = async (password?: string) => {
      const task = pdfjs.getDocument({
        data: data.slice(),
        verbosity: 0,
        ...(password === undefined ? {} : { password }),
      });
      try {
        return (await task.promise).numPages;
      } finally {
        await task.destroy();
      }
    };
    await expect(open(), entry.file).rejects.toMatchObject({ name: 'PasswordException' });
    await expect(open('definitely-wrong'), entry.file).rejects.toMatchObject({
      name: 'PasswordException',
    });
    expect(await open(entry.password), entry.file).toBe(entry.pages);
    expect(await open(entry.ownerPassword), entry.file).toBe(entry.pages);
  }
});

test('the owner-only fixture opens without any password', async () => {
  const entry = entries.find((e) => e.file === 'owner-only-no-print.pdf')!;
  const task = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(acceptPath(entry.file))),
    verbosity: 0,
  });
  const doc = await task.promise;
  expect(doc.numPages).toBe(entry.pages);
  const permissions = (await doc.getPermissions()) ?? [];
  // Print is forbidden (PDF.js PermissionFlag.PRINT = 4), copying is allowed (COPY = 16).
  expect(permissions).not.toContain(4);
  expect(permissions).toContain(16);
  await task.destroy();
});

test('every authored line is present in the real PDF.js text of its page', async () => {
  for (const entry of entries) {
    if (entry.pages === null || entry.pages === 0 || entry.lines.length === 0) continue;
    const task = pdfjs.getDocument({
      data: new Uint8Array(readFileSync(acceptPath(entry.file))),
      verbosity: 0,
      cMapUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/cmaps/', import.meta.url))
        .split(path.sep)
        .join('/'),
      cMapPacked: true,
      ...(entry.password === undefined ? {} : { password: entry.password }),
    });
    const doc = await task.promise;
    expect(doc.numPages, entry.file).toBe(entry.pages);
    const text = new Map<number, string>();
    for (const line of entry.lines) {
      if (!text.has(line.page)) {
        const content = await (await doc.getPage(line.page)).getTextContent();
        text.set(line.page, squash(content.items.map((i) => ('str' in i ? i.str : '')).join('')));
      }
      const have = text.get(line.page)!;
      const want = squash(line.text);
      expect(
        line.nfkc === true ? have.normalize('NFKC') : have,
        `${entry.file} page ${line.page}`,
      ).toContain(line.nfkc === true ? want.normalize('NFKC') : want);
    }
    await task.destroy();
  }
});

test('the manifest expectation for each broken file holds in PDF.js', async () => {
  for (const entry of entries.filter((e) => e.state.startsWith('error'))) {
    const task = pdfjs.getDocument({
      data: new Uint8Array(readFileSync(acceptPath(entry.file))),
      verbosity: 0,
    });
    await expect(task.promise, entry.file).rejects.toBeDefined();
    await task.destroy().catch(() => undefined);
  }
});
