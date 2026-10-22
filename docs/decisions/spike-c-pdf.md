# Spike C: PDF.js viewer components in the extension reader (D-06)

Status: **works; WebAssembly decision made (D-17)**. Decision date: 2026-10-22; updated after integration. pdfjs-dist **6.4.299**, exact pin. Sections marked *superseded* describe the pre-D-17 state and are kept as the evidence behind the decision.

## Question

Can the extension-owned reader page open a local PDF with the bundled PDF.js viewer components (`PDFViewer`, `EventBus`, `PDFLinkService`, `PDFFindController`), with an aligned selectable text layer, page virtualization, find and honest error states, fully offline under MV3? (docs/execution-phases.md, Phase 2, Spike C.)

## Result in one paragraph

Yes. A local PDF opens from the file picker or by drop, renders canvases and a text layer that agrees with the drawn glyphs within 3 px at 100%, 125%, 175% and fit-width (also on a 90-degree rotated page), a real mouse drag over the text layer yields the exact sentence and page number, a 100-page document never holds more than 10 page canvases, find jumps to a term on page 73, and image-only, corrupt, empty, non-PDF and encrypted files each produce a specific state without a crash. With the browser offline, and with every request logged, only `chrome-extension://` URLs are fetched. Current counts on the integrated build: unit suite `tests/unit/pdf` + i18n 130 tests (9 files); E2E 17 spike-c tests plus the 4 smoke tests pass (21), and the rotated-page test passes 10/10 with `--repeat-each=10`.

## What was built

| Piece | File |
| --- | --- |
| Limits (size, image-only window, link schemes, zoom presets) | `lib/pdf/limits.ts` |
| `ReaderState`, error mapping, file checks | `lib/pdf/state.ts` |
| Image-only detection | `lib/pdf/image-only.ts` |
| Password gate for `onPassword` | `lib/pdf/password.ts` |
| Selection capture and `SelectionSnapshot` (source `pdf`) | `lib/pdf/selection.ts` |
| Lazy PDF.js loader and worker URL | `lib/pdf/pdfjs.ts` |
| Wasm-allowed probe | `lib/pdf/wasm.ts` |
| Controller: open, close, zoom, fit-width, page, find, link confirmation | `lib/pdf/controller.ts` |
| React shell: toolbar, states, password prompt, link confirmation, developer selection panel | `components/reader/*`, `entrypoints/reader/App.tsx` |
| Build hook that copies PDF.js runtime data into `pdfjs/` | `wxt.config.ts` (`hooks['build:publicAssets']`, nothing else changed) |
| Fixture generator and fixtures | `scripts/spikes/make-pdf-fixtures.ts`, `tests/fixtures/pdf/*` |
| Tests | `tests/unit/pdf/*`, `tests/e2e/spike-c-*.spec.ts` |

### Fixtures (deterministic, 126 KB in total, 101 KB of it the 100-page file)

| File | Bytes | Purpose |
| --- | --- | --- |
| `text-1page.pdf` | 1,755 | Four 16 pt sentences, Helvetica (not embedded) |
| `text-100pages.pdf` | 103,755 | Numbered paragraphs; "xylophone" only on page 73 |
| `multi-column.pdf` | 1,906 | Two columns drawn column by column |
| `rotated-page.pdf` | 1,566 | `/Rotate 90` |
| `links.pdf` | 2,235 | External https link and an internal GoTo link |
| `image-only.pdf` | 5,548 | Three pages with one raster image each, no text operators |
| `icc-image.pdf` | 10,766 | CMYK image in an `ICCBased` space (CC0 profile from pdfjs-dist): exercises the wasm colour transform |
| `corrupt.pdf` | 608 | Valid header, truncated body, seeded noise |
| `encrypted.pdf` | 982 | Standard security handler V1/R2 (RC4-40), open password in `manifest.json` |

`manifest.json` records page counts, SHA-256 and, for every text line, its exact text, position and Helvetica advance width. A unit test re-checks every hash and page count and that every recorded sentence is a text item in real PDF.js.

**Encrypted fixture.** pdf-lib cannot encrypt and qpdf is absent, so the generator writes the PDF by hand (about 90 lines: MD5 key derivation, RC4, per-object keys). It is trustworthy because two independent readers agree: PDF.js asks for a password, rejects a wrong one and extracts the sentence with the right one, and Ghostscript 10.02 does the same (`gs -sDEVICE=txtwrite -sPDFPassword=...`; wrong password gives "Password did not work"). RC4-40 is a test vehicle only. **Gap:** AES-128/256 documents take the same `onPassword` path in PDF.js but are not covered by a fixture.

## 1. The wiring that works in MV3

```ts
// lib/pdf/pdfjs.ts
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
const lib = await import('pdfjs-dist');                  // sets globalThis.pdfjsLib
const viewer = await import('pdfjs-dist/web/pdf_viewer.mjs'); // reads globalThis.pdfjsLib: must come second
lib.GlobalWorkerOptions.workerSrc = new URL(workerUrl, location.href).href;
```

- **Worker.** The `?url` import makes Vite copy `pdf.worker.min.mjs` verbatim to `assets/pdf.worker.min-<hash>.mjs`; the URL resolves to `chrome-extension://<id>/assets/...` (checked in E2E: the worker URL request is an extension URL and the tracker saw no other origin). Module workers created from an extension page work under the extension CSP. The bundled file has no `sourceMappingURL`, and the ZIP contains no `.map`.
- **CSS.** `import 'pdfjs-dist/web/pdf_viewer.css'` in `components/reader/Reader.tsx`. It is emitted as one 232 KB stylesheet plus a 5 KB cursor SVG; nothing is loaded at runtime from elsewhere.
- **Lazy loading.** Both PDF.js modules are dynamic imports, so `reader.html` itself loads only the 20 KB shell; the PDF.js chunks load on the first file.
- **Data assets.** `cmaps/`, `standard_fonts/`, `iccs/` and `wasm/` are copied into `pdfjs/` by a `build:publicAssets` hook that now copies only `.bcmap`, `.pfb`/`.ttf`, `.icc`, `.wasm` and `LICENSE*` files (no `*_nowasm_fallback.js`, no quickjs). The loader gets `cMapUrl`, `standardFontDataUrl`, `iccUrl` and `wasmUrl` as absolute extension URLs.
- **Viewer container.** Must be `position: absolute; overflow: auto` and always laid out (PDF.js measures it for fit-width). The shell therefore draws messages as overlays and never hides the container.
- **Cleanup.** `viewer.setDocument(null)`, `linkService.setDocument(null)`, `viewer.cleanup()`, then `loadingTask.destroy()` (which also terminates the worker). No object URLs exist: the bytes are an `ArrayBuffer` held only for the life of the document.

### Differences from what the plan assumed (pdfjs-dist 6.4.299)

| Expectation | Reality in 6.4.299 | What the code does |
| --- | --- | --- |
| `getDocument({ isEvalSupported: false })` | The option no longer exists (TypeScript rejects it) and the bundles contain no `eval` / `new Function` | Nothing to set. PDF JavaScript still never runs: no scripting manager, `enableXfa: false` |
| `pdfDocument.destroy()` | `PDFDocumentProxy` has no `destroy()` | `loadingTask.destroy()` |
| Data files are fetched by the worker | `useWorkerFetch` auto-enables only for `http(s)` URLs, so with `chrome-extension://` URLs PDF.js silently disables **all** wasm (qcms, JBIG2, OpenJPEG) | `useWorkerFetch: true` is set explicitly |
| `GenericL10n` may fetch locale files | With no `<link type="application/l10n">` in the page it uses an embedded English bundle: no request | Nothing needed |
| External links | `addLinkAttributes` sets `href` to the target | `PDFLinkService` subclass sets `href="#"`, blocks everything but `http:`, `https:`, `mailto:`, strips credentials, and opens a new tab (`noopener,noreferrer`) only after the shell's confirmation dialog |

## 2. Build size (WXT build; figures measured with the spike build, before D-17 removed the fallbacks)

| Item | Raw | gzip -9 | When loaded |
| --- | --- | --- | --- |
| `chunks/reader-*.js` (shell + controller) | 20.4 KB | 7.3 KB | page load |
| `chunks/pdf-*.js` (PDF.js core) | 430 KB | 127 KB | first file |
| `chunks/pdf_viewer-*.js` (viewer components) | 169 KB | 51 KB | first file |
| `assets/pdf.worker.min-*.mjs` | 1.26 MB | 375 KB | first file (worker) |
| `assets/reader-*.css` | 232 KB | 42 KB | page load |
| `pdfjs/cmaps/` (169 files) | 1.17 MB | | on demand (CJK and other CID fonts) |
| `pdfjs/standard_fonts/` | 0.80 MB | | on demand (fallback when no system font) |
| `pdfjs/wasm/` | 1.07 MB measured with the 2 JS fallbacks; about 0.45 MB now (3 `.wasm` + licences) | | on demand |
| `pdfjs/iccs/` | 15 KB | | on demand |

JavaScript the reader needs for a first PDF: about 1.9 MB raw, roughly 560 KB gzip, plus 3.05 MB of data files measured (about 2.45 MB after D-17 dropped the JS fallbacks). The extension ZIP measured 2.72 MB in the spike (up from 85 KB of placeholders; recheck on the integrated build), of which the other agents' content UI is about 230 KB raw. The existing `size-budgets.json` only budgets content scripts, so no budget fails, but the manager should add one for the reader (proposal: reader JS chunks 700 KB gzip, `pdfjs/` data 3.5 MB raw, ZIP 4 MB).

Possible savings if needed: drop `cmaps` (1.17 MB) if CJK PDFs with non-embedded CID fonts are out of scope for v1 (most such PDFs embed fonts); keep only `LiberationSans-*` and the Foxit fonts you need from `standard_fonts`. The 0.6 MB of JS fallbacks are already gone (D-17); with the fallbacks removed the integrated build is 5.07 MB in total.

## 3. Text-layer alignment

Method (E2E, `measureAlignment`): for the target span, compare its client rectangle with the bounding box of the **dark pixels the canvas actually drew** in the same area (search area padded 24 px along the line and 60% of the line thickness across it). Values are CSS pixels; line height is the span height.

| Zoom | Scale | left edge Δ | right edge Δ | vertical centre Δ | line height |
| --- | --- | --- | --- | --- | --- |
| 100% | 1.000 | 0.0 | 1.9 | 0.9 | 21.3 |
| 125% | 1.249 | 1.2 | 1.7 | 1.9 | 26.7 |
| 175% | 1.748 | 1.0 | 3.0 | 1.8 | 37.3 |
| Fit width | 1.299 | 0.4 | 2.5 | 1.9 | 27.7 |
| Rotated 90°, 100% | | start 1.0 | end 1.5 | across 0.9 | 21.3 |
| Rotated 90°, 125% | | start 0.2 | end 2.1 | across 0.9 | 26.7 |

Asserted limits: left 4 px, right 6 px, vertical centre 30% of the line height (rotated: 6 px along, 30% across). The right-edge value is mostly the glyph side bearing, not drift.

At each zoom a **real mouse drag** (Playwright `page.mouse`, from inside the first character to inside the last) selected exactly `The quick brown fox jumps over the lazy dog.` The developer panel then showed the same text, `data-page="1"`, source `pdf`, kind `sentence`, all produced by `selectionSnapshotSchema.safeParse` with `source: 'pdf'`. The multi-column fixture selects each column line exactly; the rotated page selects its full sentence by a vertical drag.

### Findings worth knowing before Phase 7

1. **Shared CSS collides with PDF.js.** `components/common/page.css` defines `* { box-sizing: border-box }` and `.page { padding: 24px 16px }`. PDF.js names every page div `.page` and sizes it as `content-box` with no padding. Imported as is, the canvas was 2.2% narrower than its backing store and the text layer was visibly shifted. `components/reader/reader.css` carries a scoped reset (`.reader .pdfViewer .page { box-sizing: content-box; padding: 0 }`). Phase 7 should namespace the shared classes (or stop importing `page.css` into the reader).
2. **Large zoom uses a detail canvas.** At 175% the page needs more pixels than the viewport-capped canvas (`capCanvasAreaFactor`), so PDF.js draws a second, partial canvas on top. Anything that counts canvases per page, or reads pixels, must tolerate more than one.
3. **Drags that end on blank space fall short.** PDF.js keeps an `endOfContent` element next to the selection focus. With two synthetic moves a pointer that ends on blank text-layer space resolved next to the previous focus (selection stopped mid-line). With 25 moves ending 30 px past the line, the selection reached the line but **dropped the final `.`** (43 of 44 characters). Starting on blank space collapses the selection to an arbitrary caret. The tests start and end on glyphs and say so in `dragSelectSpan`. This has not been checked with a physical mouse. Consequence for the product: the reader already plans to show the exact string before a large send; also expand the snapshot to word boundaries (or at least offer it) so a one-character shortfall does not change the meaning.
4. **Rotated-page test flakiness (fixed; root cause was the test, not the product).** On a loaded machine the rotated test failed intermittently with a short selection ("This page is rotated"). Two causes: (a) geometry: at 125% the rotated page is wider than the window and, once the developer panel filled, the stage shrank, so the last glyph sat under the scrollbar or the panel and the pointer left the viewer; (b) timing: Chromium applies a mouse drag lazily (about one update per rendered frame) and a "selection unchanged for 300 ms" rule accepted a half-grown selection. Fixes in `spike-c-helpers.ts`: `dragSelectSpan` waits for renders to be idle, scrolls the span to the centre both ways, throws a clear error if the first or last glyph is outside the viewer rectangle, and moves in 8 small steps over glyphs; `selectionEquals(page, expected)` polls until the selection equals the expected text (a real truncation then fails with the last value). The rotated test uses a 1100x1300 window. Result: 10/10 with `--repeat-each=10` at 8 workers and load average 18 to 31. Real mouse drags remain in the reader, multi-column, rotated and offline tests.
5. **Selection reading order across columns** is whatever the PDF's drawing order gives (left column then right here). The snapshot is plain `getSelection()` text, as the architecture says; nothing is reconstructed.

## 4. Virtualization (100-page fixture at 100% zoom: 816 x 1056 px pages)

The viewer creates 100 page placeholders but renders few. The test jumps through the whole document (pages 8, 15, ... 99, then 100, 51, 1) and records which pages hold a `<canvas>`:

```
jump->p8   canvases=1,2,8
jump->p36  canvases=8,9,15,16,22,23,29,30,36
jump->p100 canvases=71,72,78,79,85,86,92,93,99,100
jump->p51  canvases=51,78,79,85,86,92,93,99,100
jump->p1   canvases=1,50,51,85,86,92,93,99,100
```

- Maximum pages with a canvas over the whole walk: **10** (of 100). Maximum canvas backing store: **32.9 MB** (a fully rendered 100 pages would be about 340 MB). JS heap at the start 8.0 MB, at the end 7.2 MB.
- The page in view always had a canvas; page 1 was released once the walk passed page 30.
- **Nuance:** the viewer keeps a least-recently-used buffer of 10 rendered pages, not strictly the pages nearest the viewport. Pages far from the current one (85 to 100 in the last line) stay until later pages push them out. The count is bounded; it is not "only nearby pages". The test asserts the bound (14) and the release of page 1, not distance.
- Find on the 100-page file: "xylophone" gives "1 of 1" and scrolls to page 73 with a `.highlight.selected` span; "fixture sentence 12 on" gives 100 matches, starting at the match nearest the page in view ("73 of 100"), Enter and Shift+Enter step to "74 of 100" and back; a missing term shows "No matches". Page box and previous/next navigate (page 50, 51, 49).

## 5. CSP and WebAssembly (D-17 adopted)

**Adopted policy** (manifest `content_security_policy.extension_pages`, required exactly by `scripts/expected-permissions.json`):

```
script-src 'self' 'wasm-unsafe-eval'; object-src 'self'
```

The E2E test `spike-c-wasm.spec.ts` now asserts: the manifest carries exactly this string; `WebAssembly.instantiate` succeeds on the reader page **and inside the PDF.js worker**; `isWasmAllowed()` is true so the controller passes `useWasm: true` (with `useWorkerFetch: true`); and `icc-image.pdf` renders through the qcms colour path. The colour evidence compares the shipped build with a runtime copy whose CSP is removed: mean RGB **182,189,222** (wasm) against **179,190,224** (no wasm, non-ICC path); they must differ. A second test asserts no `nowasm_fallback` file is requested or served.

What PDF.js needs wasm for in 6.4.299: ICC colour conversion including **DeviceCMYK** (qcms), JPEG 2000 (OpenJPEG) and JBIG2. Eval is not needed at all; `'wasm-unsafe-eval'` does not allow JavaScript eval. Chrome Web Store review of the directive was not checked. **Still untested:** JPEG 2000 and JBIG2 documents (no generator offline: Ghostscript here cannot emit JPX, no JBIG2 encoder installed).

**Superseded (pre-D-17 evidence, kept for the record).** With the default MV3 policy (`script-src 'self'`) WebAssembly failed on both the page and the worker with *"neither 'wasm-eval' nor 'unsafe-eval' is an allowed source"*, and PDF.js fell back to JavaScript decoders for JPEG 2000/JBIG2 and skipped ICC transforms, which is why `*_nowasm_fallback.js` had been copied. Those copies and the "decision pending" text no longer apply. `lib/pdf/wasm.ts` still probes at runtime, so the reader degrades safely if a future manifest drops the directive, but without the fallback files JPEG 2000 and JBIG2 images would then fail to decode.

**Chrome minimum raised to 147.** pdfjs-dist 6.4.299 uses newer platform APIs unguarded: `Math.sumPrecise` (Chrome 147), `Uint8Array.fromBase64` (140), `Promise.try` (128) and `URL.parse` (126; the controller also uses it). `minimum_chrome_version` is now 147 (the earlier 116 and 119 in this spike's text are superseded).

## 6. Network, offline and remote code

- `context.setOffline(true)`, then four fixtures opened in a row (text, columns, image-only, encrypted with password) plus a real text selection: all rendered, no console or page errors.
- Every request seen by the browser context (including the worker script and the lazily loaded chunks; the tracker is not blind: the test fails unless it saw the worker file and `chunks/pdf*`) was `chrome-extension://<id>/...`. The list: `reader.html`, `chunks/reader|browser|i18n|constants|contracts|pdf|pdf_viewer-*.js`, two CSS files and `assets/pdf.worker.min-*.mjs`. Zero other origins.
- Every `<script>` on the page is an extension URL, none inline. No `eval`/`Function` in PDF.js 6.4.299; the ZIP audit's remote-script and `.map` checks pass.
- `pdfjs/*` data files were **not requested** by any fixture: Helvetica (not embedded) is drawn with the system font (`useSystemFonts` defaults to true on the web), and no fixture has a non-embedded CID font. So `standard_fonts/` and `cmaps/` are shipped but unexercised.

## 7. States (FR-055, requirements section 7)

| Input | State | Evidence |
| --- | --- | --- |
| Valid text PDF | `ready` | page count, canvas, text layer |
| `image-only.pdf` | `image-only`: pages stay visible, banner says image-only and that OCR is not available | no text in any text layer; first 5 pages scanned |
| `corrupt.pdf` | `error` / `CORRUPT` (PDF.js `InvalidPDFException`) | alert text; the next valid file opens normally |
| 0-byte file | `error` / `CORRUPT` | without loading PDF.js |
| Text file named `.pdf` | `error` / `UNSUPPORTED` (no `%PDF-` in the first 1024 bytes) | without loading PDF.js |
| Over 100 MiB | `error` / `TOO_LARGE` (`limit: 'bytes'`) | unit-tested at the boundary (limit and limit + 1); not exercised end to end (a 100 MB upload is too heavy for CI) |
| Unreadable file (`NotReadableError`, `NotAllowedError`, `SecurityError`) | `error` / `PERMISSION` | unit-tested mapping only |
| `encrypted.pdf` | `password-required`, wrong password flagged (`incorrect: true`), right password opens, cancel returns to `empty` | E2E; the typed password never appears in the DOM, the snapshot or console |
| More than 5,000 pages | `error` / `TOO_LARGE` (`limit: 'pages'`) | controller test: exactly at the cap opens, one over is rejected before the viewer receives the document |
| XFA-only form | `error` / `UNSUPPORTED` | by code path; no fixture |

**Size limit: 100 MiB.** The whole file lives in one `ArrayBuffer` in the tab and is handed to the worker, so the tab holds about one to two times the file plus parsed structures and at most 10 page canvases (33 MB here). 100 MiB covers almost every text document and long scanned books and stays well inside a 4 GB machine. Pick a different number from real memory measurements in Phase 7 if needed (`MAX_PDF_BYTES`).

**Image-only detection:** none of the first 5 pages has a non-blank text item. Five, not one, because covers, blank pages and full-page logos often come first; it is five `getTextContent` calls, not a document scan (FR-059). A text PDF whose first five pages are pictures would be labelled image-only; the pages still render, only the message is wrong.

### Resource limits (security review LOW-8)

| Constant (`lib/pdf/limits.ts`) | Value | Applied as | Why |
| --- | --- | --- | --- |
| `MAX_PDF_BYTES` | 100 MiB | file size check before reading | one `ArrayBuffer` in the tab, plus the worker copy |
| `MAX_PDF_PAGES` | 5,000 | checked right after load, before `viewer.setDocument` | the viewer builds a placeholder per page, so cost grows with page count even for small files |
| `MAX_IMAGE_PIXELS` | 50,000,000 | `getDocument({ maxImageSize })` | about 200 MB RGBA for one image; A4 at 600 dpi (about 35 M pixels) still decodes |
| `MAX_CANVAS_PIXELS` | 4096 x 4096 (16.7 M) | `PDFViewer({ maxCanvasPixels })` | covers 200% on a 2x display (about 14 M) and a 4K display at 175% (about 10.5 M); above it PDF.js uses its detail canvas |
| `RAW_SELECTION_CAP` (`selection.ts`) | `maxSelectionChars` x 4 | raw `selection.toString()` is sliced before whitespace normalisation | bounds the regex on whole-document selections; a cut surrogate pair is dropped; `truncated` is set |

All are unit-tested at their boundaries (`tests/unit/pdf/state.test.ts`, `controller.test.ts`, `selection.test.ts`).

### ReaderState additions (proposed for architecture section 8)

- `password-required.incorrect?: boolean`, true after a wrong password.
- `error.limit?: 'bytes' | 'pages'`, which limit a `TOO_LARGE` error refers to (the UI names it).
- `error.message` is a short fixed English diagnostic for logs and tests; it never contains file names, bytes or raw PDF.js text, and the UI renders text by `code`.

## Gaps and untested

- AES-encrypted PDFs; JPEG 2000 and JBIG2 images (section 5); CJK documents with non-embedded fonts (cmaps unexercised); embedded-font text layers (pdf-lib cannot embed fonts without fontkit, so alignment was measured on non-embedded Helvetica drawn with the system font; embedded subset fonts are the usual case and are the first thing to check manually).
- A physical mouse, touch input, and screen readers. Text-layer scaling was checked only through headless Chromium on Linux, under heavy machine load (every synthetic mouse event took 0.5 to 1 s), so no performance numbers are claimed.
- Annotation forms are off (`AnnotationMode.ENABLE`, links only) by design; no editing, thumbnails, outline, print or download.
- Context around the selection (`contextBefore/After`) is not built; the snapshot carries text, kind, page only.
- The `reader` shell has no styling polish and a developer-only selection panel.

## Recommendation for Phase 7

1. Keep the controller and state modules as they are (`lib/pdf/*` is framework-free and unit-tested against fake PDF.js and real PDF.js in Node); build the final UI on `useReaderController`.
2. The CSP question is settled (D-17); add a reader budget to `scripts/size-budgets.json` and decide whether to keep `cmaps/` (section 2).
3. Namespace the shared CSS classes before the reader grows (finding 1).
4. Add the shared toolbar on top of `selectionchange` inside `.textLayer` (already scoped by `readPdfSelection`); show the exact string before a large send, and offer expansion to word/sentence boundaries (finding 3).
5. Manually verify on branded Chrome with a physical mouse, an embedded-font PDF, a CJK PDF and an AES-encrypted PDF before declaring FR-051/052 done.
6. Update the architecture text: `isEvalSupported` and `PDFDocumentProxy.destroy` no longer exist in 6.x; add the `ReaderState` additions above; mention `useWorkerFetch: true`, the CSP string and the Chrome 147 minimum.

## Reproduce

```
npx tsx scripts/spikes/make-pdf-fixtures.ts
npm run build
npx vitest run tests/unit/pdf
npx playwright test tests/e2e/spike-c-*.spec.ts --output=test-results/spike-c --trace=off
```

Use a separate `--output` directory when other Playwright runs share the checkout (they clear `test-results/`). `--repeat-each=10 -g rotated` re-checks the rotated test.
