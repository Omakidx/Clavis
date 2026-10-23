import { deflateSync } from 'node:zlib';

/**
 * A tiny hand-rolled PDF writer for fixtures that pdf-lib cannot express (predefined CJK CMaps
 * without embedded fonts, JBIG2/JPX image streams, JavaScript actions, XFA, decompression bombs).
 * Pure Node, no Playwright import: the fixture generator and the test-time synthesizers share it.
 *
 * Objects are numbered from 1 in the order they are added. `build` writes a classic xref table,
 * so the output is byte-for-byte reproducible.
 */
export class RawPdf {
  private readonly bodies: Buffer[] = [];

  /** Reserve an object number so that other objects can refer to it before it is defined. */
  reserve(): number {
    this.bodies.push(Buffer.alloc(0));
    return this.bodies.length;
  }

  /** Define (or redefine) object `num` as a dictionary body, with an optional stream. */
  set(num: number, dict: string, stream?: Uint8Array): number {
    const head = Buffer.from(`${num} 0 obj\n`, 'latin1');
    const tail = Buffer.from('\nendobj\n', 'latin1');
    if (stream === undefined) {
      this.bodies[num - 1] = Buffer.concat([head, Buffer.from(dict, 'latin1'), tail]);
    } else {
      const d = dict.trim().replace(/^<<|>>$/g, '');
      this.bodies[num - 1] = Buffer.concat([
        head,
        Buffer.from(`<<${d} /Length ${stream.length}>>\nstream\n`, 'latin1'),
        stream,
        Buffer.from('\nendstream', 'latin1'),
        tail,
      ]);
    }
    return num;
  }

  add(dict: string, stream?: Uint8Array): number {
    return this.set(this.reserve(), dict, stream);
  }

  get count(): number {
    return this.bodies.length;
  }

  /** `trailer` is the extra dictionary text (for example `/Info 7 0 R`); /Root and /Size are added. */
  build(root: number, trailer = '', header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n'): Buffer {
    const parts: Buffer[] = [Buffer.from(header, 'latin1')];
    const offsets: number[] = [];
    let at = parts[0]!.length;
    for (const body of this.bodies) {
      offsets.push(at);
      parts.push(body);
      at += body.length;
    }
    const xref =
      `xref\n0 ${this.bodies.length + 1}\n0000000000 65535 f \n` +
      offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
    parts.push(
      Buffer.from(
        `${xref}trailer\n<</Size ${this.bodies.length + 1} /Root ${root} 0 R ${trailer}>>\nstartxref\n${at}\n%%EOF\n`,
        'latin1',
      ),
    );
    return Buffer.concat(parts);
  }
}

export const flate = (data: Uint8Array): Buffer => deflateSync(data, { level: 9 });

/** A PDF literal string for ASCII text (parentheses and backslashes escaped). */
export const pdfString = (s: string): string => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

/** UTF-16BE hex string, as the predefined `Uni*-UCS2-H` CMaps expect. */
export const utf16beHex = (s: string): string => {
  let out = '<';
  for (let i = 0; i < s.length; i++) out += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `${out}>`;
};

export interface SimplePage {
  width: number;
  height: number;
  /** Page content stream text. */
  content: string;
  /** Extra page dictionary entries, for example `/Annots [...]` or `/Rotate 90`. */
  extra?: string;
  /** Resources dictionary body, default: Helvetica as /F1. */
  resources?: string;
}

/**
 * One catalogue + page tree with the given pages sharing a Helvetica /F1 (unless resources are
 * given). Returns the catalogue object number. `catalogExtra` carries /OpenAction, /AcroForm,
 * /Names and so on.
 */
export function addSimpleDocument(
  pdf: RawPdf,
  pages: SimplePage[],
  options: { catalogExtra?: string; fontObject?: number; compress?: boolean } = {},
): { root: number; pageObjects: number[] } {
  const font =
    options.fontObject ?? pdf.add('<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>');
  const root = pdf.reserve();
  const tree = pdf.reserve();
  const pageObjects: number[] = [];
  for (const page of pages) {
    const raw = Buffer.from(page.content, 'latin1');
    const content =
      options.compress === true
        ? pdf.add('<</Filter /FlateDecode>>', flate(raw))
        : pdf.add('<<>>', raw);
    pageObjects.push(
      pdf.add(
        `<</Type /Page /Parent ${tree} 0 R /MediaBox [0 0 ${page.width} ${page.height}] ` +
          `/Resources ${page.resources ?? `<</Font <</F1 ${font} 0 R>>>>`} /Contents ${content} 0 R ${page.extra ?? ''}>>`,
      ),
    );
  }
  pdf.set(
    tree,
    `<</Type /Pages /Kids [${pageObjects.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages.length}>>`,
  );
  pdf.set(root, `<</Type /Catalog /Pages ${tree} 0 R ${options.catalogExtra ?? ''}>>`);
  return { root, pageObjects };
}

/** Text drawing operators for one line (Helvetica /F1). */
export const textLine = (text: string, x: number, y: number, size: number): string =>
  `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(text)} Tj ET\n`;
