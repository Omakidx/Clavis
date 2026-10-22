// Minimal, dependency-free ZIP reader (central directory + stored/deflate entries).
// Purpose: audit our own release ZIP without trusting a third-party parser. It fails closed:
// ZIP64, encryption, multi-disk archives, unknown compression methods, CRC mismatches and
// oversized entries all throw instead of being skipped silently.
import { inflateRawSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * @param {Buffer} buffer whole ZIP file
 * @returns {{ name: string, isDirectory: boolean, size: number, read: () => Buffer }[]}
 */
export function readZip(buffer) {
  // The EOCD record is at the end, followed by at most a 64 KiB comment.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a ZIP file: end-of-central-directory record not found');

  const diskNumber = buffer.readUInt16LE(eocd + 4);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (diskNumber !== 0) throw new Error('Multi-disk ZIP archives are not supported');
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries = [];
  let pos = directoryOffset;
  for (let index = 0; index < entryCount; index++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== CENTRAL_SIGNATURE) {
      throw new Error(`Corrupt central directory at entry ${index}`);
    }
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const expectedCrc = buffer.readUInt32LE(pos + 16);
    const compressedSize = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLength);
    pos += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    if (size === 0xffffffff || compressedSize === 0xffffffff) {
      throw new Error(`ZIP64 entry is not supported: ${name}`);
    }
    const isDirectory = name.endsWith('/');

    entries.push({
      name,
      isDirectory,
      size,
      read() {
        if (isDirectory) return Buffer.alloc(0);
        if (size > MAX_ENTRY_BYTES) throw new Error(`Entry too large to audit: ${name}`);
        if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
          throw new Error(`Corrupt local header for ${name}`);
        }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const raw = buffer.subarray(start, start + compressedSize);
        let data;
        if (method === 0) data = Buffer.from(raw);
        else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
        else throw new Error(`Unsupported compression method ${method} for ${name}`);
        if (data.length !== size) throw new Error(`Size mismatch for ${name}`);
        if (crc32(data) !== expectedCrc) throw new Error(`CRC mismatch for ${name}`);
        return data;
      },
    });
  }
  return entries;
}
