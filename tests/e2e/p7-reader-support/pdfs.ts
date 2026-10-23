import { PDFDocument, PDFName, PDFString, StandardFonts, type PDFPage } from 'pdf-lib';

/**
 * PDFs generated inside the tests (pdf-lib, deterministic), for cases the shared fixtures do not
 * cover: bounded context across pages, hostile content, and a page-count over the cap.
 */

const W = 612;
const H = 792;
type Literal = Parameters<PDFDocument['context']['obj']>[0];
type StreamDict = Parameters<PDFDocument['context']['stream']>[1];

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-01-01T00:00:00Z'));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

const bytesOf = async (doc: PDFDocument): Promise<Buffer> =>
  Buffer.from(await doc.save({ useObjectStreams: false }));

/** The word on the middle page of `contextPdf` that tests select. */
export const CONTEXT_WORD = 'cartographer';
/** The sentence selected on its middle page. */
export const CONTEXT_SENTENCE = 'The cartographer drew every river and every bank by hand.';
export const CONTEXT_MARKERS = { before: 'SECRET-PAGE-ONE', after: 'SECRET-PAGE-THREE' } as const;

/**
 * Three pages. Page 2 holds 40 lines of ordinary prose (about 3,000 characters) with the target
 * sentence in the middle; pages 1 and 3 carry the SECRET markers, which must never reach a
 * request made for a selection on page 2.
 */
export async function contextPdf(): Promise<Buffer> {
  const { doc, font } = await newDoc('Clavis context fixture');
  const line = (page: PDFPage, text: string, y: number) =>
    page.drawText(text, { x: 54, y, size: 11, font });
  const p1 = doc.addPage([W, H]);
  for (let i = 0; i < 20; i++) {
    line(
      p1,
      `${CONTEXT_MARKERS.before} line ${i + 1} of the opening page, written to fill it up.`,
      740 - i * 20,
    );
  }
  const p2 = doc.addPage([W, H]);
  for (let i = 0; i < 40; i++) {
    const text =
      i === 20
        ? CONTEXT_SENTENCE
        : `Row ${String(i + 1).padStart(2, '0')}: the middle page keeps ordinary words about rivers, mills and old banks.`;
    line(p2, text, 760 - i * 18);
  }
  const p3 = doc.addPage([W, H]);
  for (let i = 0; i < 20; i++) {
    line(
      p3,
      `${CONTEXT_MARKERS.after} line ${i + 1} of the closing page, written to fill it up.`,
      740 - i * 20,
    );
  }
  return bytesOf(doc);
}

/** Text lines that look like markup, and the globals a successful injection would set. */
export const HOSTILE_LINES = [
  '<img src=x onerror="window.__pwned=1">',
  '<script>window.__pwned=2</script>',
  '"><svg onload=window.__pwned=3>',
  '&lt;b&gt;entity&lt;/b&gt; {{7*7}} ${7*7} <iframe src="javascript:window.__pwned=4">',
] as const;

export interface HostileLinks {
  javascript: string;
  file: string;
  chrome: string;
  data: string;
  https: string;
}
export const HOSTILE_URLS: HostileLinks = {
  javascript: 'javascript:window.__pwned=5',
  file: 'file:///etc/passwd',
  chrome: 'chrome://settings',
  data: 'data:text/html,<script>window.__pwned=6</script>',
  https: 'https://example.com/clavis-hostile-ok',
};

/**
 * One page of hostile content (PDF is untrusted):
 * - four text lines that look like HTML/script,
 * - link annotations with javascript:, file:, chrome:, data: and https: targets,
 * - a JavaScript action link and a document OpenAction that runs script (never run: no scripting),
 * - a text form field whose value is markup,
 * - markup in the document title.
 */
export async function hostilePdf(): Promise<Buffer> {
  const { doc, font } = await newDoc('<img src=x onerror="window.__pwned=7">');
  const page = doc.addPage([W, H]);
  HOSTILE_LINES.forEach((text, i) =>
    page.drawText(text, { x: 54, y: 740 - i * 30, size: 12, font }),
  );
  const targets: Array<[string, string]> = [
    ['javascript', HOSTILE_URLS.javascript],
    ['file', HOSTILE_URLS.file],
    ['chrome', HOSTILE_URLS.chrome],
    ['data', HOSTILE_URLS.data],
    ['https', HOSTILE_URLS.https],
  ];
  const refs = targets.map(([label, uri], i) => {
    const y = 560 - i * 40;
    page.drawText(`LINK-${label}`, { x: 54, y, size: 14, font });
    return doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [54, y - 4, 54 + 150, y + 16],
        Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
      } as Literal),
    );
  });
  // A link whose action is document JavaScript.
  page.drawText('LINK-js-action', { x: 54, y: 340, size: 14, font });
  refs.push(
    doc.context.register(
      doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: [54, 336, 204, 356],
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'JavaScript',
          JS: PDFString.of('window.__pwned=8; app.alert("pwned")'),
        },
      } as Literal),
    ),
  );
  page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  // OpenAction JavaScript at document level.
  doc.catalog.set(
    PDFName.of('OpenAction'),
    doc.context.obj({
      Type: 'Action',
      S: 'JavaScript',
      JS: PDFString.of('window.__pwned=9; app.alert("open action")'),
    } as Literal),
  );
  // An AcroForm text field whose value is markup.
  const form = doc.getForm();
  const field = form.createTextField('markup');
  field.setText('<img src=x onerror="window.__pwned=10">');
  field.addToPage(page, { x: 54, y: 260, width: 300, height: 24 });
  return bytesOf(doc);
}

/** `count` blank pages: over the reader's page cap when `count` > 5,000. */
export async function blankPagesPdf(count: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage([200, 200]);
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}

/** A real-size file to exercise the progress and over-size paths without 100 MiB on disk. */
export function paddedPdf(bytes: number): Buffer {
  const head = Buffer.from('%PDF-1.4\n');
  return Buffer.concat([head, Buffer.alloc(Math.max(bytes - head.length, 0), 0x20)]);
}

/** Where `fullPageLinkPdf` links to. */
export const FULL_PAGE_LINK_URL = 'https://example.com/clavis-full-page-link';

/** One page covered edge to edge by a single link annotation (a "clickjacking" PDF). */
export async function fullPageLinkPdf(): Promise<Buffer> {
  const { doc, font } = await newDoc('Clavis full-page link');
  const page = doc.addPage([W, H]);
  page.drawText('Everything on this page is a link.', { x: 54, y: 700, size: 18, font });
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [0, 0, W, H],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(FULL_PAGE_LINK_URL) },
    } as Literal),
  );
  page.node.set(PDFName.of('Annots'), doc.context.obj([link]));
  return bytesOf(doc);
}

/**
 * One page with a RichMedia, a Screen (rendition), a Sound and a FileAttachment annotation, each
 * carrying a tiny embedded "media" file, plus one ordinary link. PDF.js draws the first three as a
 * play button that decodes the embedded file in the page on click, which the reader must never do.
 */
export async function mediaPdf(): Promise<Buffer> {
  const { doc, font } = await newDoc('Clavis media annotations');
  const page = doc.addPage([W, H]);
  page.drawText('MEDIA-PAGE', { x: 54, y: 740, size: 18, font });
  const embedded = (name: string) => {
    const stream = doc.context.register(
      doc.context.stream(new Uint8Array(64).fill(1), { Type: 'EmbeddedFile' } as StreamDict),
    );
    return doc.context.register(
      doc.context.obj({
        Type: 'Filespec',
        F: PDFString.of(name),
        UF: PDFString.of(name),
        EF: { F: stream },
      } as Literal),
    );
  };
  const rect = (y: number) => [54, y, 204, y + 40];

  const richMedia = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'RichMedia',
      Rect: rect(600),
      RichMediaContent: {
        Configurations: [
          doc.context.register(
            doc.context.obj({
              Type: 'RichMediaConfiguration',
              Subtype: 'Video',
              Instances: [
                doc.context.register(
                  doc.context.obj({
                    Type: 'RichMediaInstance',
                    Subtype: 'Video',
                    Asset: embedded('rich.mp4'),
                  } as Literal),
                ),
              ],
            } as Literal),
          ),
        ],
      },
    } as Literal),
  );
  const screen = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Screen',
      Rect: rect(540),
      A: {
        Type: 'Action',
        S: 'Rendition',
        R: {
          Type: 'Rendition',
          S: 'MR',
          C: {
            Type: 'MediaClip',
            S: 'MCD',
            N: PDFString.of('clip'),
            D: embedded('screen.mp3'),
            CT: PDFString.of('audio/mpeg'),
          },
        },
      },
    } as Literal),
  );
  const soundStream = doc.context.register(
    doc.context.stream(new Uint8Array(800).fill(128), {
      Type: 'Sound',
      R: 8000,
      C: 1,
      B: 8,
      E: 'Unsigned',
    } as StreamDict),
  );
  const sound = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Sound',
      Rect: rect(480),
      Name: 'Speaker',
      Sound: soundStream,
    } as Literal),
  );
  const attachment = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: rect(420),
      Name: 'PushPin',
      Contents: PDFString.of('attached'),
      FS: embedded('notes.txt'),
    } as Literal),
  );
  const link = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: rect(360),
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.com/media-ok') },
    } as Literal),
  );
  page.node.set(
    PDFName.of('Annots'),
    doc.context.obj([richMedia, screen, sound, attachment, link]),
  );
  return bytesOf(doc);
}

/** One page with `count` small link annotations (a flood). Built on demand, never committed. */
export async function floodPdf(count: number): Promise<Buffer> {
  const { doc, font } = await newDoc('Clavis annotation flood');
  const page = doc.addPage([W, H]);
  page.drawText('FLOOD-PAGE selectable text stays usable.', { x: 54, y: 740, size: 14, font });
  const refs = [];
  for (let i = 0; i < count; i++) {
    const x = 20 + (i % 100) * 5;
    const y = 20 + Math.floor((i / 100) % 60) * 10;
    refs.push(
      doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [x, y, x + 4, y + 8],
          Border: [0, 0, 0],
          A: { Type: 'Action', S: 'URI', URI: PDFString.of(`https://example.com/flood/${i}`) },
        } as Literal),
      ),
    );
  }
  page.node.set(PDFName.of('Annots'), doc.context.obj(refs));
  return Buffer.from(await doc.save({ useObjectStreams: true }));
}
