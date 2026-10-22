/**
 * Whether the current page's Content Security Policy lets WebAssembly compile.
 *
 * MV3's default `extension_pages` CSP is `script-src 'self'`, which blocks WebAssembly (Spike C
 * measured this on the reader page and inside the PDF.js worker). PDF.js 6 uses wasm for ICC colour
 * conversion (qcms), JPEG 2000 (OpenJPEG) and JBIG2. It also has a JavaScript fallback for the two
 * image decoders, so the reader asks PDF.js for wasm only when the CSP allows it; adding
 * `'wasm-unsafe-eval'` to the manifest later switches it on without a code change.
 *
 * An 8-byte module (magic + version) is the smallest valid module; compiling it exercises the CSP
 * check without any real work.
 */
export function isWasmAllowed(): boolean {
  try {
    new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00));
    return true;
  } catch {
    return false;
  }
}
