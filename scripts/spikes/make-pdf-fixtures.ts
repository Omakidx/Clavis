/**
 * Deterministic PDF fixture generator for Phase 2 Spike C (docs/decisions/spike-c-pdf.md).
 *
 * Usage: npx tsx scripts/spikes/make-pdf-fixtures.ts
 * Output: tests/fixtures/pdf/*.pdf plus tests/fixtures/pdf/manifest.json (page counts, byte
 * sizes, SHA-256 and the exact text/position of the sentences the E2E tests select).
 *
 * Everything is reproducible: fixed dates, no random IDs, a seeded PRNG for the corrupt file.
 * pdf-lib cannot encrypt, so encrypted.pdf is written by hand with the PDF standard security
 * handler (V1/R2, RC4-40). It is only a TEST FIXTURE; RC4-40 is not a safe way to protect data.
 * Its correctness is checked by PDF.js itself (tests/unit/pdf/fixtures.test.ts) and can be
 * cross-checked with Ghostscript:
 *   gs -q -dNOPAUSE -dBATCH -sDEVICE=txtwrite -sPDFPassword=clavis-test -sOutputFile=- encrypted.pdf
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  degrees,
  PDFDocument,
  concatTransformationMatrix,
  drawObject,
  popGraphicsState,
  pushGraphicsState,
  PDFName,
  PDFString,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/fixtures/pdf',
);

const FIXED_DATE = new Date('2026-01-01T00:00:00Z');
const PAGE_W = 612;
const PAGE_H = 792;

export const ENCRYPTED_USER_PASSWORD = 'clavis-test';
const ENCRYPTED_OWNER_PASSWORD = 'clavis-owner';

interface SentenceInfo {
  page: number;
  text: string;
  /** PDF user-space coordinates of the text origin (baseline-left) on the unrotated page. */
  x: number;
  y: number;
  size: number;
  /** Advance width of `text` in PDF points (Helvetica metrics). */
  width: number;
}

interface FixtureInfo {
  file: string;
  description: string;
  pages: number;
  bytes: number;
  sha256: string;
  sentences: SentenceInfo[];
  password?: string;
}

const manifest: FixtureInfo[] = [];

async function newDoc(title: string): Promise<{ doc: PDFDocument; font: PDFFont; bold: PDFFont }> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer('Clavis spike-c fixtures');
  doc.setCreator('Clavis spike-c fixtures');
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, font, bold };
}

function drawLine(
  page: PDFPage,
  font: PDFFont,
  pageNumber: number,
  text: string,
  x: number,
  y: number,
  size: number,
  sink: SentenceInfo[],
): void {
  page.drawText(text, { x, y, size, font });
  sink.push({ page: pageNumber, text, x, y, size, width: font.widthOfTextAtSize(text, size) });
}

async function record(
  file: string,
  description: string,
  bytes: Uint8Array,
  pages: number,
  sentences: SentenceInfo[],
  extra: Partial<FixtureInfo> = {},
): Promise<void> {
  await writeFile(path.join(outDir, file), bytes);
  manifest.push({
    file,
    description,
    pages,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sentences,
    ...extra,
  });
}

const SAVE = { useObjectStreams: false } as const;

async function makeText1Page(): Promise<void> {
  const { doc, font, bold } = await newDoc('Clavis fixture: one page');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const sentences: SentenceInfo[] = [];
  page.drawText('Clavis single page fixture', { x: 72, y: 720, size: 22, font: bold });
  const lines = [
    'The quick brown fox jumps over the lazy dog.',
    'Pack my box with five dozen liquor jugs.',
    'Sphinx of black quartz, judge my vow.',
    'How vexingly quick daft zebras jump.',
  ];
  lines.forEach((line, i) => drawLine(page, font, 1, line, 72, 680 - i * 28, 16, sentences));
  drawLine(page, font, 1, 'Short closing line at the bottom.', 72, 120, 12, sentences);
  await record(
    'text-1page.pdf',
    'One US Letter page, Helvetica (not embedded), four 16pt sentences on separate lines.',
    await doc.save(SAVE),
    1,
    sentences,
  );
}

async function makeText100Pages(): Promise<void> {
  const { doc, font, bold } = await newDoc('Clavis fixture: 100 pages');
  const sentences: SentenceInfo[] = [];
  for (let n = 1; n <= 100; n++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawText(`Page ${n} of 100`, { x: 72, y: 730, size: 20, font: bold });
    for (let k = 1; k <= 12; k++) {
      const text = `Paragraph ${n}.${k}: numbered fixture sentence ${k} on page ${n}.`;
      page.drawText(text, { x: 72, y: 690 - (k - 1) * 22, size: 12, font });
      if (k === 1) {
        sentences.push({
          page: n,
          text,
          x: 72,
          y: 690,
          size: 12,
          width: font.widthOfTextAtSize(text, 12),
        });
      }
    }
    if (n === 73) {
      drawLine(page, font, n, 'The xylophone melody appears only on this page.', 72, 400, 12, []);
    }
  }
  await record(
    'text-100pages.pdf',
    '100 US Letter pages, numbered paragraphs; the word "xylophone" occurs only on page 73.',
    await doc.save(SAVE),
    100,
    sentences,
  );
}

async function makeMultiColumn(): Promise<void> {
  const { doc, font, bold } = await newDoc('Clavis fixture: two columns');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const sentences: SentenceInfo[] = [];
  page.drawText('Two column fixture', { x: 72, y: 730, size: 20, font: bold });
  for (let k = 1; k <= 6; k++) {
    drawLine(page, font, 1, `Left column line ${k}.`, 72, 690 - (k - 1) * 24, 13, sentences);
    drawLine(page, font, 1, `Right column line ${k}.`, 330, 690 - (k - 1) * 24, 13, sentences);
  }
  await record(
    'multi-column.pdf',
    'Two text columns drawn column by column (left column first, then right).',
    await doc.save(SAVE),
    1,
    sentences,
  );
}

async function makeRotated(): Promise<void> {
  const { doc, font } = await newDoc('Clavis fixture: rotated page');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.setRotation(degrees(90));
  const sentences: SentenceInfo[] = [];
  [
    'This page is rotated by ninety degrees.',
    'Selection must still follow the text layer.',
    'A third line keeps the rotation test honest.',
  ].forEach((line, i) => drawLine(page, font, 1, line, 72, 680 - i * 30, 16, sentences));
  await record(
    'rotated-page.pdf',
    'One page with /Rotate 90; content drawn upright in unrotated user space.',
    await doc.save(SAVE),
    1,
    sentences,
  );
}

async function makeLinks(): Promise<void> {
  const { doc, font } = await newDoc('Clavis fixture: links');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const sentences: SentenceInfo[] = [];
  drawLine(page, font, 1, 'Visit the example website for details.', 72, 700, 16, sentences);
  drawLine(page, font, 1, 'Jump to the second page.', 72, 660, 16, sentences);
  const page2 = doc.addPage([PAGE_W, PAGE_H]);
  drawLine(page2, font, 2, 'You arrived on page two.', 72, 700, 16, sentences);
  type Literal = Parameters<typeof doc.context.obj>[0];
  const link = (y: number, width: number, action: object) =>
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [72, y - 4, 72 + width, y + 16],
        Border: [0, 0, 0],
        A: action,
      } as Literal),
    );
  const external = link(700, sentences[0]!.width, {
    Type: 'Action',
    S: 'URI',
    URI: PDFString.of('https://example.com/clavis-fixture'),
  } as Literal);
  const internal = link(660, sentences[1]!.width, {
    Type: 'Action',
    S: 'GoTo',
    D: [page2.ref, PDFName.of('Fit')],
  });
  page.node.set(PDFName.of('Annots'), doc.context.obj([external, internal]));
  await record(
    'links.pdf',
    'Two pages: an external https link (needs confirmation) and an internal GoTo link to page 2.',
    await doc.save(SAVE),
    2,
    sentences,
  );
}

/** Minimal PNG writer (RGB, 8 bit) so the raster image is deterministic and dependency free. */
function makePng(width: number, height: number): Uint8Array {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * stride + 1 + x * 3;
      // Dark horizontal "text-like" bars on a light gradient: looks like a scan, has no text.
      const bar = y % 14 < 4 && x > 12 && x < width - 12 - ((y * 7) % 60);
      raw[o] = bar ? 30 : 235 - Math.floor((y / height) * 25);
      raw[o + 1] = bar ? 30 : 232;
      raw[o + 2] = bar ? 30 : 225 + Math.floor((x / width) * 20);
    }
  }
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function makeImageOnly(): Promise<void> {
  const { doc } = await newDoc('Clavis fixture: image only');
  const png = await doc.embedPng(makePng(320, 440));
  for (let i = 0; i < 3; i++) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawImage(png, { x: 36, y: 36, width: PAGE_W - 72, height: PAGE_H - 72 });
  }
  await record(
    'image-only.pdf',
    'Three pages that each contain one embedded raster image and no text operators (a "scan").',
    await doc.save(SAVE),
    3,
    [],
  );
}

/**
 * A CMYK image tagged with an ICCBased colour space (the CC0 CGATS001Compat profile that ships
 * with pdfjs-dist). PDF.js converts ICCBased images with its qcms WebAssembly module, so this is
 * the fixture that shows whether WebAssembly is usable under the extension CSP (Spike C, step 4).
 */
async function makeIccImage(): Promise<void> {
  const { doc, font } = await newDoc('Clavis fixture: ICC based image');
  const profile = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../node_modules/pdfjs-dist/iccs/CGATS001Compat-v2-micro.icc',
    ),
  );
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const sentences: SentenceInfo[] = [];
  drawLine(page, font, 1, 'ICC based CMYK image below.', 72, 700, 16, sentences);
  const iccRef = doc.context.register(
    doc.context.flateStream(profile, { N: 4, Alternate: PDFName.of('DeviceCMYK') }),
  );
  const size = 32;
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      pixels[o] = Math.round((x / (size - 1)) * 255); // C ramps left to right
      pixels[o + 1] = Math.round((y / (size - 1)) * 255); // M ramps top to bottom
      pixels[o + 2] = 0;
      pixels[o + 3] = 0;
    }
  }
  const imageRef = doc.context.register(
    doc.context.flateStream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: size,
      Height: size,
      BitsPerComponent: 8,
      ColorSpace: [PDFName.of('ICCBased'), iccRef],
    } as Parameters<typeof doc.context.flateStream>[1]),
  );
  const name = page.node.newXObject('Img1', imageRef);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(300, 0, 0, 300, 72, 340),
    drawObject(name),
    popGraphicsState(),
  );
  await record(
    'icc-image.pdf',
    'One page with a 32x32 CMYK image in an ICCBased colour space (CC0 profile from pdfjs-dist); exercises the qcms wasm path.',
    await doc.save(SAVE),
    1,
    sentences,
  );
}

/** Small deterministic PRNG (mulberry32) for the corrupt fixture. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function makeCorrupt(): Promise<void> {
  const { doc, font } = await newDoc('Clavis fixture: corrupt');
  const page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawText('This document will be damaged.', { x: 72, y: 700, size: 16, font });
  const valid = await doc.save(SAVE);
  // Keep a plausible header, drop everything from the middle of the body (no xref, no trailer)
  // and fill the rest with seeded noise so the cross-reference recovery has nothing to find.
  const rand = prng(20260101);
  const head = Buffer.from(valid.subarray(0, 96));
  const noise = Buffer.alloc(512);
  for (let i = 0; i < noise.length; i++) noise[i] = Math.floor(rand() * 256);
  await record(
    'corrupt.pdf',
    'Valid PDF header followed by truncated body and seeded random bytes (no xref/trailer).',
    Buffer.concat([head, noise]),
    0,
    [],
  );
}

// ---- Hand-built encrypted PDF (standard security handler V1/R2, RC4-40) ----

const PASSWORD_PAD = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);
const md5 = (...parts: Uint8Array[]): Buffer =>
  createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + (s[i] as number) + (key[i % key.length] as number)) & 255;
    [s[i], s[j]] = [s[j] as number, s[i] as number];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + (s[a] as number)) & 255;
    [s[a], s[b]] = [s[b] as number, s[a] as number];
    out[n] = (data[n] as number) ^ (s[((s[a] as number) + (s[b] as number)) & 255] as number);
  }
  return out;
}

const padPassword = (pw: string): Buffer =>
  Buffer.concat([Buffer.from(pw, 'latin1'), PASSWORD_PAD]).subarray(0, 32);

async function makeEncrypted(): Promise<void> {
  const fileId = md5(Buffer.from('clavis-spike-c-encrypted-fixture'));
  const P = -44; // print + copy + accessibility bits, R2 reserved bits set
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(P);

  // Algorithm 3: owner entry. Algorithm 2: file key. Algorithm 4: user entry (R2).
  const ownerKey = md5(padPassword(ENCRYPTED_OWNER_PASSWORD)).subarray(0, 5);
  const O = rc4(ownerKey, padPassword(ENCRYPTED_USER_PASSWORD));
  const fileKey = md5(padPassword(ENCRYPTED_USER_PASSWORD), O, pBytes, fileId).subarray(0, 5);
  const U = rc4(fileKey, PASSWORD_PAD);

  const objectKey = (num: number): Buffer =>
    md5(fileKey, Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(
      0,
      Math.min(fileKey.length + 5, 16),
    );

  const sentence = 'This secret sentence needs the correct password to read.';
  const content = Buffer.from(`BT /F1 16 Tf 72 700 Td (${sentence}) Tj ET`, 'latin1');
  const encContent = rc4(objectKey(4), content);

  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b;
    parts.push(buf);
    length += buf.length;
  };
  const obj = (num: number, body: Buffer | string): void => {
    offsets[num] = length;
    push(`${num} 0 obj\n`);
    push(body);
    push('\nendobj\n');
  };
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  );
  obj(
    4,
    Buffer.concat([
      Buffer.from(`<< /Length ${encContent.length} >>\nstream\n`, 'latin1'),
      encContent,
      Buffer.from('\nendstream', 'latin1'),
    ]),
  );
  obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(
    6,
    `<< /Filter /Standard /V 1 /R 2 /Length 40 /P ${P} /O <${O.toString('hex')}> /U <${U.toString('hex')}> >>`,
  );
  const xrefAt = length;
  push('xref\n0 7\n0000000000 65535 f \n');
  for (let n = 1; n <= 6; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(
    `trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${fileId.toString('hex')}> <${fileId.toString('hex')}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`,
  );
  await record(
    'encrypted.pdf',
    'One page, standard security handler V1/R2 (RC4-40). Open password is in manifest "password".',
    Buffer.concat(parts),
    1,
    [{ page: 1, text: sentence, x: 72, y: 700, size: 16, width: 0 }],
    { password: ENCRYPTED_USER_PASSWORD },
  );
}

await mkdir(outDir, { recursive: true });
await makeText1Page();
await makeText100Pages();
await makeMultiColumn();
await makeLinks();
await makeRotated();
await makeImageOnly();
await makeIccImage();
await makeCorrupt();
await makeEncrypted();
await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const f of manifest) {
  console.log(
    `${f.file.padEnd(18)} ${String(f.bytes).padStart(8)} bytes  pages=${String(f.pages).padStart(3)}  sha256=${f.sha256.slice(0, 12)}`,
  );
}
