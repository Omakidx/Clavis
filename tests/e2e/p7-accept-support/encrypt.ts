import { createCipheriv, createHash } from 'node:crypto';
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFString,
  type PDFObject,
} from 'pdf-lib';

/**
 * Standard security handler writer used only to make ENCRYPTED TEST FIXTURES: Ghostscript 10.02
 * here writes RC4 only (R2/R3), pdf-lib cannot encrypt and qpdf is absent, so AES-128 (V4/R4,
 * /AESV2) and AES-256 (V5/R6, /AESV3) are produced by re-serialising a plain PDF with its streams
 * and strings encrypted. Everything is deterministic (fixed IVs, salts and file key), so the
 * output is reproducible. NOT a safe way to protect data.
 *
 * The result is trustworthy because it is cross-checked by two independent readers: PDF.js (asks
 * for a password, rejects a wrong one, extracts the text with the right one) and Ghostscript
 * (`gs -sDEVICE=txtwrite -sPDFPassword=...`). `scripts/fixtures/make-accept-pdfs.ts --verify`
 * runs both.
 */
export type EncryptionKind = 'aes128' | 'aes256';

export interface EncryptOptions {
  kind: EncryptionKind;
  userPassword: string;
  ownerPassword: string;
  /** Signed 32-bit /P value. Default: everything allowed. */
  permissions?: number;
}

/** /P with print (bit 3) and high-quality print (bit 12) cleared; copy and accessibility allowed. */
export const PERMISSIONS_NO_PRINT = 0xfffff0c0 | 0x10 | 0x200 | 0x20 | 0x100 | 0;
export const PERMISSIONS_ALL = 0xfffff0c0 | 0xf3c | 0;

const PAD = Buffer.from('28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A', 'hex');

const md5 = (...parts: Uint8Array[]): Buffer =>
  createHash('md5').update(Buffer.concat(parts)).digest();

function rc4(key: Uint8Array, data: Uint8Array): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let n = 0; n < data.length; n++) {
    a = (a + 1) & 255;
    b = (b + s[a]!) & 255;
    [s[a], s[b]] = [s[b]!, s[a]!];
    out[n] = data[n]! ^ s[(s[a]! + s[b]!) & 255]!;
  }
  return out;
}

const padPassword = (password: string): Buffer =>
  Buffer.concat([Buffer.from(password, 'latin1'), PAD]).subarray(0, 32);

const le32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeInt32LE(n | 0);
  return b;
};

/** Deterministic pseudo-random bytes (fixture reproducibility, not security). */
function seeded(seed: string, length: number): Buffer {
  let out = Buffer.alloc(0);
  for (let i = 0; out.length < length; i++) {
    out = Buffer.concat([out, createHash('sha256').update(`${seed}:${i}`).digest()]);
  }
  return out.subarray(0, length);
}

interface Handler {
  /** Encrypt the bytes of a stream or string belonging to object `num`. */
  encrypt(num: number, data: Uint8Array): Buffer;
  /** The /Encrypt dictionary text. */
  dictionary: string;
  /** /ID first element. */
  id: Buffer;
}

function aesCbcPad(key: Buffer, iv: Buffer, data: Uint8Array): Buffer {
  const cipher = createCipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

function makeAes128(options: EncryptOptions): Handler {
  const id = seeded('clavis-id', 16);
  const p = options.permissions ?? PERMISSIONS_ALL;
  // Algorithm 3: /O.
  let ownerHash = md5(padPassword(options.ownerPassword || options.userPassword));
  for (let i = 0; i < 50; i++) ownerHash = md5(ownerHash);
  const ownerKey = ownerHash.subarray(0, 16);
  let o = rc4(ownerKey, padPassword(options.userPassword));
  for (let i = 1; i <= 19; i++) o = rc4(Buffer.from(ownerKey.map((b) => b ^ i)), o);
  // Algorithm 2: file key.
  let hash = md5(padPassword(options.userPassword), o, le32(p), id);
  for (let i = 0; i < 50; i++) hash = md5(hash.subarray(0, 16));
  const key = hash.subarray(0, 16);
  // Algorithm 5: /U.
  let u = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) u = rc4(Buffer.from(key.map((b) => b ^ i)), u);
  u = Buffer.concat([u, seeded('clavis-u-tail', 16)]);
  return {
    id,
    encrypt(num, data) {
      const objectKey = md5(
        key,
        Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0]),
        Buffer.from('sAlT', 'latin1'),
      ).subarray(0, 16);
      return aesCbcPad(objectKey, seeded(`iv-${num}`, 16), data);
    },
    dictionary:
      `<</Filter /Standard /V 4 /R 4 /Length 128 /P ${p} /EncryptMetadata true ` +
      `/CF <</StdCF <</AuthEvent /DocOpen /CFM /AESV2 /Length 16>>>> /StmF /StdCF /StrF /StdCF ` +
      `/O <${o.toString('hex')}> /U <${u.toString('hex')}>>>`,
  };
}

/** ISO 32000-2 algorithm 2.B (hash for revision 6). */
function hash2B(password: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let k = createHash('sha256')
    .update(Buffer.concat([password, salt, udata]))
    .digest();
  let lastByte = 0;
  for (let i = 0; i < 64 || lastByte > i - 32; i++) {
    const k1 = Buffer.concat([password, k, udata]);
    const repeated = Buffer.concat(Array.from({ length: 64 }, () => k1));
    const cipher = createCipheriv('aes-128-cbc', k.subarray(0, 16), k.subarray(16, 32));
    cipher.setAutoPadding(false);
    const e = Buffer.concat([cipher.update(repeated), cipher.final()]);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += e[j]!;
    k = createHash((['sha256', 'sha384', 'sha512'] as const)[sum % 3]!)
      .update(e)
      .digest();
    lastByte = e[e.length - 1]!;
  }
  return k.subarray(0, 32);
}

function aes256NoPad(key: Buffer, iv: Buffer, data: Buffer, mode: 'cbc' | 'ecb'): Buffer {
  const cipher =
    mode === 'cbc'
      ? createCipheriv('aes-256-cbc', key, iv)
      : createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function makeAes256(options: EncryptOptions): Handler {
  const id = seeded('clavis-id-256', 16);
  const p = options.permissions ?? PERMISSIONS_ALL;
  const fileKey = seeded('clavis-file-key', 32);
  const user = Buffer.from(options.userPassword, 'utf8').subarray(0, 127);
  const owner = Buffer.from(options.ownerPassword || options.userPassword, 'utf8').subarray(0, 127);
  const empty = Buffer.alloc(0);
  const zeroIv = Buffer.alloc(16);

  const uValidation = seeded('u-val', 8);
  const uKeySalt = seeded('u-key', 8);
  const u = Buffer.concat([hash2B(user, uValidation, empty), uValidation, uKeySalt]);
  const ue = aes256NoPad(hash2B(user, uKeySalt, empty), zeroIv, fileKey, 'cbc');

  const oValidation = seeded('o-val', 8);
  const oKeySalt = seeded('o-key', 8);
  const o = Buffer.concat([hash2B(owner, oValidation, u), oValidation, oKeySalt]);
  const oe = aes256NoPad(hash2B(owner, oKeySalt, u), zeroIv, fileKey, 'cbc');

  const perms = Buffer.concat([
    le32(p),
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from('Tadb', 'latin1'),
    seeded('perms', 4),
  ]);
  const permsEncrypted = aes256NoPad(fileKey, zeroIv, perms, 'ecb');
  return {
    id,
    encrypt(num, data) {
      return aesCbcPad(fileKey, seeded(`iv-${num}`, 16), data);
    },
    dictionary:
      `<</Filter /Standard /V 5 /R 6 /Length 256 /P ${p} /EncryptMetadata true ` +
      `/CF <</StdCF <</AuthEvent /DocOpen /CFM /AESV3 /Length 32>>>> /StmF /StdCF /StrF /StdCF ` +
      `/O <${o.toString('hex')}> /U <${u.toString('hex')}> /OE <${oe.toString('hex')}> ` +
      `/UE <${ue.toString('hex')}> /Perms <${permsEncrypted.toString('hex')}>>>`,
  };
}

/** Serialise a pdf-lib object, encrypting strings for object `num`. */
function serialise(object: PDFObject, handler: Handler, num: number): string {
  if (object instanceof PDFDict) {
    let out = '<<';
    for (const [key, value] of object.entries()) {
      out += `${key.toString()} ${serialise(value, handler, num)} `;
    }
    return `${out}>>`;
  }
  if (object instanceof PDFArray) {
    return `[${object
      .asArray()
      .map((v) => serialise(v, handler, num))
      .join(' ')}]`;
  }
  if (object instanceof PDFString || object instanceof PDFHexString) {
    return `<${handler.encrypt(num, object.asBytes()).toString('hex')}>`;
  }
  if (
    object instanceof PDFName ||
    object instanceof PDFNumber ||
    object instanceof PDFRef ||
    object instanceof PDFBool ||
    object === PDFNull
  ) {
    return object.toString();
  }
  throw new Error(`cannot serialise ${object.constructor.name}`);
}

/**
 * Re-write `plain` (an unencrypted PDF) with the standard security handler. Cross-reference and
 * object streams of the source are dropped (pdf-lib has already expanded them), so the output has
 * a classic xref table.
 */
export async function encryptPdf(plain: Uint8Array, options: EncryptOptions): Promise<Buffer> {
  const handler = options.kind === 'aes128' ? makeAes128(options) : makeAes256(options);
  const source = await PDFDocument.load(plain, { updateMetadata: false });
  const context = source.context;
  const entries = context.enumerateIndirectObjects().filter(([, object]) => {
    const dict = object instanceof PDFRawStream ? object.dict : object;
    if (!(dict instanceof PDFDict)) return true;
    const type = dict.get(PDFName.of('Type'));
    return !(type instanceof PDFName && ['XRef', 'ObjStm'].includes(type.asString().slice(1)));
  });
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let at = parts[0]!.length;
  const offsets = new Map<number, number>();
  let maxNumber = 0;
  const write = (buffer: Buffer): void => {
    parts.push(buffer);
    at += buffer.length;
  };
  for (const [ref, object] of entries) {
    const num = ref.objectNumber;
    maxNumber = Math.max(maxNumber, num);
    offsets.set(num, at);
    if (object instanceof PDFRawStream) {
      const encrypted = handler.encrypt(num, object.contents);
      const dict = object.dict.clone();
      dict.set(PDFName.of('Length'), PDFNumber.of(encrypted.length));
      write(Buffer.from(`${num} 0 obj\n${serialise(dict, handler, num)}\nstream\n`, 'latin1'));
      write(encrypted);
      write(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      write(Buffer.from(`${num} 0 obj\n${serialise(object, handler, num)}\nendobj\n`, 'latin1'));
    }
  }
  const encryptNumber = maxNumber + 1;
  offsets.set(encryptNumber, at);
  write(Buffer.from(`${encryptNumber} 0 obj\n${handler.dictionary}\nendobj\n`, 'latin1'));
  const size = encryptNumber + 1;
  let xref = `xref\n0 ${size}\n`;
  for (let n = 0; n < size; n++) {
    const offset = offsets.get(n);
    xref +=
      offset === undefined
        ? '0000000000 65535 f \n'
        : `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  const root = context.trailerInfo.Root;
  if (!(root instanceof PDFRef)) throw new Error('source PDF has no catalogue reference');
  const info = context.trailerInfo.Info;
  const idHex = handler.id.toString('hex');
  const trailer =
    `trailer\n<</Size ${size} /Root ${root.toString()} ` +
    (info instanceof PDFRef ? `/Info ${info.toString()} ` : '') +
    `/Encrypt ${encryptNumber} 0 R /ID [<${idHex}> <${idHex}>]>>\nstartxref\n${at}\n%%EOF\n`;
  write(Buffer.from(xref + trailer, 'latin1'));
  return Buffer.concat(parts);
}
