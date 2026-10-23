/**
 * A minimal JBIG2 embedded stream (ISO 14492, PDF `/JBIG2Decode` without globals): one page
 * information segment and one immediate lossless generic region coded with MMR (ITU-T T.6, the
 * same coding as CCITT Group 4). The MMR bits come from ImageMagick (`GROUP4:` raw output), so no
 * JBIG2 encoder is needed. It exercises PDF.js's JBIG2 decoder (WebAssembly under the extension
 * CSP, decision D-17).
 */
function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function segment(number: number, type: number, data: Buffer): Buffer {
  return Buffer.concat([
    u32(number),
    Buffer.from([type]), // flags: segment type, 1-byte page association
    Buffer.from([0x00]), // no referred-to segments
    Buffer.from([0x01]), // page association: page 1
    u32(data.length),
    data,
  ]);
}

export function jbig2GenericMmr(width: number, height: number, mmr: Uint8Array): Buffer {
  const pageInfo = Buffer.concat([
    u32(width),
    u32(height),
    u32(0), // x resolution (unknown)
    u32(0), // y resolution (unknown)
    Buffer.from([0x00, 0x00, 0x00]), // flags (default pixel 0), striping off
  ]);
  const region = Buffer.concat([
    u32(width),
    u32(height),
    u32(0), // x
    u32(0), // y
    Buffer.from([0x00]), // external combination operator: OR
    Buffer.from([0x01]), // generic region flags: MMR = 1
    Buffer.from(mmr),
  ]);
  return Buffer.concat([segment(0, 48, pageInfo), segment(1, 38, region)]);
}
