# Phase 7 acceptance: local PDF reader

Independent, black-box verification of the Phase 7 reader (FR-050 to FR-059, UJ-04, the PDF rows of the
[error catalog](../requirements.md#7-error-catalog) and of the [verification matrix](../requirements.md#9-verification-test-matrix))
and of the gaps Spike C left open ([spike-c-pdf.md](spike-c-pdf.md), "Gaps and untested"): AES encryption, embedded
fonts, non-Latin text, JPEG 2000 and JBIG2. Written by the verification specialist, not by the implementer.

**Status: the reader meets FR-050 to FR-059 on this build, with four open defects (D1, D3, D4, D5 below; D2, the
page-number clamp, was fixed while the build was moving) and the known image-only limitation (O1).** Run date 2026-10-23, Playwright 1.64.1 bundled Chromium (Chrome for
Testing, new headless), Linux, branch `phase-7-reader` built with `WXT_OUT_DIR=.output-p7-accept npx wxt build` while the
implementer was still editing. **209 tests in 8 files, 209 pass**; four of them (`test.fail`) pass because they fail as
documented: D1, D3, D4, D5. An earlier 204-test version of the suite also passed twice in a row (`--repeat-each=2`, 408 of 408) at load
average 12 to 25; the fixtures spec alone (Node only, no browser) takes 4 seconds. One intermittent behaviour under heavy load is
recorded as observation O5.

## Method

- **Black box.** The reader is driven the way a user drives it: a real file chooser (`filechooser` event on the visible
  buttons), a real drop sequence (a `DataTransfer` carrying a real `File`, dispatched through dragenter, dragover and drop
  at the point under the cursor; Playwright cannot start an OS-level file drag), real `page.mouse` drags and
  double-clicks on the text layer, real keyboard input. The Clavis toolbar and explanation card live in a closed shadow
  root and are read only through the DevTools-protocol helpers that earlier phases already use
  (`tests/e2e/spike-b-support/toolbar.ts`, `p5-card-support/harness.ts`, `p6-listen-support/listen.ts`).
- **One adapter.** All reader selectors and strings are in `tests/e2e/p7-accept-support/reader.ts` (`HOOK`, `TEXT`). The
  hooks used are the ones the implementer documents at the top of `components/reader/Reader.tsx` (`data-testid`:
  `file-input`, `viewer-container`, `page-input`, `page-count`, `zoom-select`, `fit-width`, `find-toggle`, `find-bar`,
  `find-input`, `find-status`, `find-next`, `find-prev`, `find-case`, `find-close`, `state-empty|loading|error|image-only`,
  `password-prompt`, `password-error`, `link-confirm`, `live-region`, `file-name`, `drop-target`; `.reader[data-phase]` and
  `[data-render-count]`), plus accessible names from `public/_locales/en/messages.json`. Nothing else is read from
  production code. If the markup moves, edit that one file.
- **One recorded message channel.** An init script wraps `chrome.runtime.sendMessage` in the reader tab and records each
  payload, so the snapshot the reader hands to the background (`source: 'pdf'`, `page`, `kind`, `contextBefore/After`) can
  be asserted. Everything after that (router, prompt builder, Groq adapter) is the real code; Groq itself is answered by
  `tests/e2e/p5-support/groq.ts` (`fakeGroq`), the key is a fake `gsk_TEST...` stored through the real Settings route.
- **Network.** Playwright's context `request` event does not report requests made by dedicated workers, which is where
  PDF.js fetches its CMaps and wasm. So "no request leaves the browser" is judged by a **route** on every
  `http(s)/ws(s)` URL (recorded and aborted, Groq falls through to the fake, the local fixture server is exempt and is
  judged by the `request` list instead). A canary test proves the route sees a request made by a worker, so "none" means
  none.
- **Alignment.** For a located line, the text layer's character rectangles are compared with the bounding box of the dark
  pixels the page canvas actually drew there (same idea as Spike C `measureAlignment`, made orientation-agnostic). The
  start edge must agree within 20% of the line height + 2 px, the end edge within 35% + 2 px (75% + 2 px when the line
  ends in a full-width stop, whose dot sits in the corner of its em box), the centre across the line within 35%.
- **Selection.** `dragSelectText` finds the needle by walking the text layer's text nodes while ignoring whitespace
  (span boundaries differ between producers), then drags from inside the first glyph to inside the last along the
  direction between them, so it works on 90/180/270 degree pages and right-to-left lines. Drags start and end on glyphs
  (Spike C finding 3).
- **Fixtures** are generated, not downloaded: `scripts/fixtures/make-accept-pdfs.ts` (see below). Large inputs
  (5,000 and 5,001 pages, files of exactly and one byte over 100 MiB) are generated at test time into a temp directory
  (`p7-accept-support/synth.ts`); the oversize files are sparse (a `%PDF-` header and `ftruncate`), so no 100 MiB is ever
  written.

## Commands

```
# fixtures (byte-identical on this machine; --verify re-checks hashes, page counts, text, passwords with PDF.js
# and Ghostscript)
npx tsx scripts/fixtures/make-accept-pdfs.ts
npx tsx scripts/fixtures/make-accept-pdfs.ts --verify

# suite (build into a separate directory so other work is not disturbed)
WXT_OUT_DIR=.output-p7-accept npx wxt build
CLAVIS_EXTENSION_DIR=.output-p7-accept/chrome-mv3 npx playwright test tests/e2e/p7-accept-*.spec.ts --output=test-results/p7-accept

# checks
npx tsc --noEmit -p tsconfig.node.json
npx eslint tests/e2e/p7-accept-* tests/e2e/p7-accept-support scripts/fixtures
npx prettier --check tests/e2e/p7-accept-* scripts/fixtures tests/fixtures/pdf/accept/manifest.json
```

`scripts/` is outside `tsconfig.node.json`; the generator was type-checked with a throw-away tsconfig that extends it
(`include: scripts/fixtures/*.ts`, clean).

## Fixtures

All under `tests/fixtures/pdf/accept/`, 32 files, 416 KiB in total (plus `manifest.json`), the largest 91 KB. `manifest.json` lists for every
file: producer and command, bytes, SHA-256, page count, the state the reader is expected to end in, the authored text
per page (`lines`), passwords, fonts and their licences, and file-specific properties (page sizes, link positions, image
boxes). The generator re-runs byte-identical on this machine (checked: second run `diff -r` clean). Skia output depends
on the installed font files and Chromium version, so the committed bytes and their hashes are the source of truth for the
tests; the generator exists to regenerate them. Every file is verified by real PDF.js (Node, legacy build) for page
count and every authored line, and the encrypted files additionally by Ghostscript 10.02.

| File | Bytes | Pages | What it is | Expected end state |
| --- | ---: | ---: | --- | --- |
| `acroform-javascript.pdf` | 1,843 | 1 | AcroForm text field + JS push button + /OpenAction, field and document JavaScript | ready |
| `basic-1page.pdf` | 1,657 | 1 | 1 page, 3 Helvetica sentences (word "zeppelin") | ready |
| `cjk-cff-type3.pdf` | 60,343 | 1 | zh/ja/ko, Noto Sans CJK, Type3 glyphs + ToUnicode | ready |
| `cjk-kangxi-radicals.pdf` | 40,348 | 1 | zh, ToUnicode maps ideographs to Kangxi radicals (NFKC restores) | ready |
| `cjk-nonembedded-cmap.pdf` | 1,749 | 1 | zh/ja/ko through predefined UniGB/UniJIS/UniKS-UCS2-H CMaps, no embedded font | ready |
| `cjk-truetype-embedded.pdf` | 13,185 | 1 | zh/ja, Droid Sans Fallback embedded TrueType (CIDFontType2) | ready |
| `columns-3.pdf` | 2,386 | 1 | 3 columns drawn row by row (interleaved stream order) | ready |
| `context-pages.pdf` | 3,845 | 3 | 3 pages with page tokens; page 2 has ~2,300 characters (context and 2,000-char tests) | ready |
| `corrupt-noise.pdf` | 3,009 | - | valid header + 3,000 bytes of seeded noise | error-corrupt |
| `corrupt-truncated.pdf` | 2,114 | - | context-pages.pdf cut at 55% | ready-or-corrupt |
| `cover-then-text.pdf` | 2,178 | 3 | picture cover page, then 2 text pages | ready |
| `encrypted-aes128.pdf` | 22,793 | 2 | AES-128 (V4/R4 AESV2), embedded TrueType, user + owner password | password-required |
| `encrypted-aes256.pdf` | 14,558 | 1 | AES-256 (V5/R6 AESV3), embedded CJK TrueType, user + owner password | password-required |
| `font-gs-embedded.pdf` | 33,364 | 2 | Ghostscript: embedded Type1C (no ToUnicode) + embedded TrueType subset | ready |
| `font-truetype-embedded.pdf` | 21,625 | 2 | Skia: Liberation Serif + DejaVu Sans embedded TrueType, accents, ligatures | ready |
| `hostile-text-links.pdf` | 2,738 | 1 | HTML/script/template/prompt-injection text; javascript:, file:, data:, https:, mailto:, Launch, JavaScript, GoToR links | ready |
| `image-bomb.pdf` | 49,564 | 1 | 20000x20000 1-bit image (400 MP) in 49 KB | ready |
| `image-jbig2.pdf` | 1,020 | 1 | JBIG2Decode image (hand-built MMR generic region) | ready |
| `image-jpx.pdf` | 1,808 | 1 | JPXDecode image (JP2, 4 colour quadrants) | ready |
| `leading-junk.pdf` | 1,858 | 1 | 201 bytes of junk before %PDF- | ready |
| `mixed-page-sizes.pdf` | 3,173 | 5 | Letter, A4, Legal landscape, 3x2 in card, 1500x300 banner | ready |
| `not-a-pdf.pdf` | 99 | - | HTML with a script, named .pdf | error-unsupported |
| `owner-only-no-print.pdf` | 22,796 | 2 | AES-128, empty user password, owner password, print forbidden | ready |
| `page-huge.pdf` | 637 | 1 | one 14400 x 14400 pt page | ready |
| `pages-100.pdf` | 90,718 | 100 | 100 pages; "marmot" on every page, "quokka" only on p. 88, unique token per line | ready |
| `rotated-0-90-180-270.pdf` | 3,115 | 4 | 4 pages, /Rotate 0/90/180/270 | ready |
| `rtl-hebrew-arabic.pdf` | 15,431 | 2 | Hebrew (clean) + Arabic (Skia glyph-level visual order) | ready |
| `scan-image-only.pdf` | 3,820 | 2 | 2 pages of 1-bit rasters of text, no text operators | image-only |
| `scan-then-text.pdf` | 2,978 | 6 | 5 picture pages, then 1 text page | image-only-or-ready |
| `xfa-only.pdf` | 1,012 | 1 | XFA form with a "Please wait" fallback page | ready-or-unsupported |
| `zero-byte.pdf` | 0 | - | empty file | error-corrupt |
| `zero-pages.pdf` | 323 | - | valid structure, empty page tree | ready-or-corrupt |

### Producers and how the hard ones were made

- **Embedded TrueType and CJK/RTL (`skia`).** Chromium `page.pdf()` on a generated HTML page, fonts pinned by `@font-face`
  with `file://` URLs (Chromium needs `--allow-file-access-from-files` for that) so the font choice never depends on
  fontconfig. TrueType faces become `Type0/CIDFontType2` with an embedded `FontFile2` subset; CFF/OpenType faces (Noto Sans
  CJK) cannot be embedded by Skia and become `Type3` glyph procedures with a ToUnicode map (this is what Chrome produces for
  such fonts in practice). `TZ=UTC`, and the two date strings are rewritten to a fixed value of the same length, make the
  output byte-stable.
- **Embedded Type1C and TrueType (`gs`).** Ghostscript 10.02 `pdfwrite` from a PostScript file using Liberation Sans and
  DejaVu Serif. Exact options: `-dNOPAUSE -dBATCH -sDEVICE=pdfwrite -dCompatibilityLevel=1.7 -dOmitInfoDate -dOmitID
  -dOmitXMP -dSubsetFonts=true -dEmbedAllFonts=true -dCompressFonts=true -dCompressStreams=true
  -sFONTPATH=/usr/share/fonts/truetype/liberation:/usr/share/fonts/truetype/dejavu` (the three `-dOmit*` flags make it
  deterministic). Result: Liberation Sans as an embedded `Type1C` subset **without** ToUnicode (simple font, WinAnsi),
  DejaVu Serif as an embedded `TrueType` subset.
- **AES-128 and AES-256 (`enc`).** Ghostscript 10.02 `pdfwrite` only writes RC4 (`-dEncryptionR=4/5/6` is rejected:
  "Encryption revisions 2 and 3 are only supported"), pdf-lib cannot encrypt, qpdf is absent. So
  `tests/e2e/p7-accept-support/encrypt.ts` re-serialises a plain PDF (parsed with pdf-lib, expanded object streams) with
  the standard security handler: V4/R4 `/AESV2` (MD5 key derivation, per-object key + `sAlT`, AES-128-CBC) and V5/R6
  `/AESV3` (ISO 32000-2 algorithm 2.B hash, `/UE`, `/OE`, `/Perms`, AES-256-CBC). IVs, salts and the file key are
  derived deterministically, so the output is reproducible. Trust comes from two independent readers agreeing on every
  file (this is the same evidence Spike C used for its RC4 file): PDF.js asks for a password, rejects a wrong one and
  extracts the exact text with the user and with the owner password; Ghostscript (`gs -sDEVICE=txtwrite
  -sPDFPassword=...`) does the same. `encrypted-aes128.pdf` carries embedded TrueType fonts, `encrypted-aes256.pdf`
  carries embedded CJK TrueType, so "encrypted + embedded fonts + non-Latin" is one path. `owner-only-no-print.pdf` is
  AES-128 with an empty user password and `/P` without the print bits; PDF.js reports print off and copy on.
- **CJK without embedded fonts (`raw`).** Type0 fonts with the predefined `UniGB-UCS2-H`, `UniJIS-UCS2-H`,
  `UniKS-UCS2-H` CMaps and no `FontFile`: extraction only works if the extension's bundled `pdfjs/cmaps/` are reachable.
  (This is the first fixture that actually exercises `cmaps/` and `standard_fonts/` fallbacks; Spike C noted both as
  unexercised.)
- **JPEG 2000.** ImageMagick 6.9.12 (`convert ... -depth 8 -quality 100 jp2:-`, lossless) writes a 64x64 JP2 with four
  coloured quadrants; it is embedded with `/JPXDecode`. Ghostscript renders the same file with the same colours.
- **JBIG2.** No encoder exists offline, so `p7-accept-support/jbig2.ts` writes an embedded JBIG2 stream by hand: a page
  information segment (type 48) and an immediate lossless generic region (type 38) with MMR=1, whose bits are CCITT
  Group 4 data from ImageMagick (`convert ... -negate -compress Group4 GROUP4:-`; JBIG2 treats 1 as black and the PDF
  filter inverts it). Ghostscript (jbig2dec) renders the intended picture, which is how polarity was verified. The region
  is MMR, not arithmetic coded: a symbol-dictionary / text-region / arithmetic-coded stream (what real scanners and
  `jbig2enc` write) is **not** covered, see Gaps.
- **Decompression bomb.** `image-bomb.pdf`: a 20000x20000 pixel 1-bit image of zeros deflates to 49 KB (about 400
  megapixels, eight times the 50-megapixel cap).

### Licences of the fonts embedded in committed files

Only subsets of these fonts are embedded (a few dozen glyphs each); all are installed system packages on this machine.

| Font | Package | Licence |
| --- | --- | --- |
| Liberation Serif and Sans 2.1.5 | `fonts-liberation 1:2.1.5-3` | SIL OFL 1.1 |
| DejaVu Sans and Serif 2.37 | `fonts-dejavu-core 2.37-8` | Bitstream Vera licence (free to embed and redistribute) |
| Droid Sans Fallback Full 6.0.1 | `fonts-droid-fallback 1:6.0.1r16-1.1build1` | Apache 2.0 |
| Noto Sans CJK Regular (2023-08) | `fonts-noto-cjk 1:20230817+repack1-3` | SIL OFL 1.1 |
| Noto Naskh Arabic, Noto Sans Hebrew | `fonts-noto-core 20201225-2` | SIL OFL 1.1 |

The licence string of every font fixture is in `manifest.json` (`licenses`), and `p7-accept-fixtures.spec.ts` fails if a
fixture that embeds a font lacks one.

## Results by requirement

Test names are `file › describe › title` (title shortened). "Spec" is `tests/e2e/p7-accept-<name>.spec.ts`.

| ID | Requirement and the evidence | Result |
| --- | --- | --- |
| FR-050 | **open** (FR-050 describe): the visible "Choose a PDF" button opens a real file chooser; the toolbar "Open PDF" button too and a second file replaces the first; a drop sequence opens a file (drag overlay `drop-target` appears and goes); dropping text does nothing; four fixtures (embedded TrueType, CJK, JPX, CMap CJK) open with the context **offline** and only `chrome-extension://` requests exist; six more incl. JPX, JBIG2, CMap and hostile fixtures cause no web request (route-based tracker, proven by the worker canary) and no Groq call; Close PDF empties the viewer, drops all pages and stops the PDF.js worker; the same file reopens; title and file name follow the file. **states**: password text never reaches any request, storage or message. | pass |
| FR-051 | **render**: for `font-truetype-embedded`, `font-gs-embedded` (Type1C and TrueType subsets), `cjk-truetype-embedded`, `cjk-cff-type3`, `rtl-hebrew-arabic`, `columns-3` at 100%, 150%, 175% and fit width the canvas draws ink under every authored line; JPEG 2000 (4 quadrant colours at 100% and 150%) and JBIG2 (both rectangles and the white background at 100% and 175%) decode through the wasm modules under the D-17 CSP; every authored line of six fixtures is in the text layer. | pass |
| FR-052 | **render**: text layer vs canvas ink for the same 6 fixtures plus `rotated-0-90-180-270` (all four rotations, three zooms) within the tolerances in Method; a **real mouse drag** from the first to the last glyph selects exactly the authored line at every zoom (Latin compared with spaces, CJK/Hebrew without); Arabic: ink aligned, drag selects a contiguous run covering more than 85% (O6); rotated sheets swap their size (1056 x 816). | pass |
| FR-053 | **actions**: a double-clicked word and a dragged sentence show the same toolbar (Listen, Explain) and send nothing; Listen without voices says "Voice isn't available on this device." with the Linux hint and no spinner, never calls Groq; with scripted voices Listen plays, Stop, Slow (rate 0.75), Replay, the sentence is one `speak` call of the right length; Explain opens the card and sends exactly one request with the selection, key only in the header, no file name, under 12 KB; the recorded snapshot is `source: 'pdf'`, right `kind`, right `page`; CJK and an AES-256 document work end to end; **context**: first/last words of a page never pull text from the neighbouring pages (`ALPHAONE`, `OMEGATHREE` never appear), mid-page words get both sides, combined at most 1,000 characters, equal to the prompt's blocks; a selection over 2,000 characters shows "Selection too long", trim and Explain send at most 2,000; rotated 90 page at 175%; Escape and click-away dismiss; closing or replacing the document dismisses toolbar and card; reader chrome selections never open the toolbar; scans offer no toolbar; without a key the card says "Connect your Groq key". | pass; D5 (low) |
| FR-054 | **open** (FR-054 describe): 1-page file ("of 1", Previous/Next stay); presets give 408/816/1020/1224 px sheets; zoom buttons change the size and the select shows a percentage; fit width fills the viewer with no horizontal scrollbar at 700, 1200 and 1500 px windows; 100-page file: "of 100", Next/Previous, typed page, clamping to 1..100, wheel scrolling updates the page box; zoom keeps page 50; mixed page sizes show their exact sizes and fit width works on the banner. **a11y**: keyboard n/j/p/k, Ctrl+Home/End, PageUp/Down, Home/End, 0 + - . | pass; **D1** (medium) fit width does not follow a window resize |
| FR-055 | **states**: AES-128 and AES-256: prompt (file name shown, nothing rendered behind it, focus in the field), empty submit ignored, three wrong passwords (including 300 characters) give "That password isn't correct" and an emptied field, right password with Enter opens with correct text, owner password also opens, Cancel leaves a usable reader, a new file replaces the prompt, keyboard-only, owner-only (print forbidden) opens without a prompt; zero-byte, noise, HTML-as-PDF give the `CORRUPT`/`UNSUPPORTED` message with a "Choose another PDF" button and the next file opens; junk before `%PDF-` opens; truncated file ends in `CORRUPT`; XFA opens as a document (O2); scans show the exact image-only banner with pages and ink visible and nothing selectable; picture cover then text is not image-only; limits: **5,001 pages** gives the "more than 5000 pages" message in 1.6 s with no viewer built, **exactly 5,000** opens (3.6 s) with at most 14 canvases and page 5000 reachable, **100 MiB + 1** is refused from its size in 1.5 s without reading, **exactly 100 MiB** is not refused for size (fails on content), the 400-megapixel image is skipped and the page opens, a 14400 x 14400 pt page keeps each canvas within 4096 x 4096 at 100%, 175% and fit width. | pass; **D3** zero-page PDF stuck in "loading"; **D4** unreadable file shows the RENDER message |
| FR-056 | **open** (FR-056 describe): a tab navigated to a `.pdf` URL and a click on a link to one are not redirected (no reader tab appears); the manifest has no `webRequest`, `declarativeNetRequest`, `webNavigation`, `downloads`, no `file_handlers`, no content script matching PDFs, no `file:///*` or `<all_urls>`; the popup's "Open PDF reader" button opens one tab. | pass |
| FR-057 | **find**: Ctrl+F and the Find button open the bar with the box focused, Escape closes and clears highlights; a once-only term on page 88 gives "1 of 1", jumps there with canvas and highlight in view; "marmot" gives "1 of 100", Enter/Shift+Enter/buttons step and wrap (100 of 100 and back); unique per-page token; "No matches"; case-insensitive by default and "Match case"; clearing; typed letters (njkp+-0) never trigger page shortcuts; CJK, Hebrew, ligature word ("office"), accented "Café", Kangxi-radical text, AES-256 document; scans say "No matches"; a new file resets the bar. | pass |
| FR-058 / FR-060 | **open**: no URL input and no OCR, annotation, translation or editing control in the empty or open reader; the image-only banner says OCR is not available. | pass |
| FR-059 | **find** (FR-059 describe): jumping through 17 pages of the 100-page file never holds more than 10 canvases (bound asserted: 14), the page in view always has one, total canvas pixels at most 14 x 816 x 1056; 40 wheel steps with a frame probe: worst `requestAnimationFrame` gap 63 ms (bound 3,000 ms); 25 keyboard page steps bounded; at 175% and 200% each canvas stays within 4096 x 4096 and at most 18 exist; JS heap 21.9 MB after visiting the whole file (bound 150 MB); only about a dozen text layers exist for 100 page boxes. | pass (O4) |
| Security | **security**: HTML, script, template and prompt-injection lines are text (no `script`, `img`, `iframe`, handler attribute; no request for `/x`; `__clavisPwned` never set; all scripts are extension files); Explain on those lines sends angle brackets as entities, the card shows plain text; the injection sentence occurs once, inside the nonce-tagged block; clicking `javascript:`, `file:`, `data:`, Launch, JavaScript-action and GoToR links does nothing (no tab, dialog, navigation, confirmation or request) and no `href` of those schemes exists; mailto and https ask first, Cancel opens nothing, the dialog names the target; confirming https opens one tab with that URL and `window.opener === null`; Tab+Enter on every link is as harmless; the AcroForm and its JavaScript (open action, field and button actions, document scripts, `app.launchURL`) never become editable or run: no control in the pages, typing and clicking on the field/button do nothing, Tab never enters a control in the pages, no dialog, no tab, no request to the script's URLs; HTML file names are text in title, label and password prompt; **no CSP violation, uncaught error or console error for any of the 21 opening fixtures** (and the two encrypted ones); the page loads only extension scripts and styles. | pass |
| A11y | **a11y**: axe WCAG 2.1 A/AA clean on empty, open with find, CJK, password (with and without the error), three error states, image-only, link dialog; axe best-practice (landmarks, ARIA roles) clean on empty, open, password, image-only; the whole reader (open, pages, zoom, find, close) operable with the keyboard; first Tab reaches an open control; focus moves to the pages after opening; every toolbar control has a name and a visible focus ring; the link dialog is an `alertdialog`, takes focus, keeps Tab inside, Escape cancels, focus returns; the password prompt is labelled and keyboard completable; the live region announces open, page, zoom and close; errors are `role=alert`; no horizontal scroll at 400 px; every control at least 24 x 24 px. | pass |
| Fixtures | **fixtures** (Node only): manifest = bytes and SHA-256, no unlisted files, each file under 100 KB and 450 KB in total, font licences recorded, every authored line present in real PDF.js, encrypted files need the password and reject a wrong one (user and owner), owner-only opens and reports print off and copy on, broken files are rejected by PDF.js. | pass |

## Defects

All four are encoded as `test.fail` with a comment naming the defect; each test fails for the stated reason (verified
by running a copy without the `test.fail` line against the final build) and will turn red as soon as the defect is fixed,
which is the signal to delete that one line.

**D1 (medium, FR-054): fit width does not follow a window resize.** Repro: open any PDF, choose Fit width, shrink the window
from 1200 to 700 px. The page stays 1160 px wide, the viewer gets a horizontal scrollbar (`scrollWidth` 1178 for a client
width of 700) and the zoom select still says "Fit width"; growing the window leaves a gap. Test:
`p7-accept-open.spec.ts › FR-054 … › fit width FOLLOWS a window resize` (fails with "page did not shrink: expected < 1160,
received 1160"). Probable cause: the PDF.js viewer components do not observe their container (the PDF.js demo app does);
`components/reader` and `lib/pdf/controller.ts` have no `ResizeObserver` or `resize` handler. A `ResizeObserver` on the
viewer container that re-applies `currentScaleValue = 'page-width'` while the scale value is `page-width` would do.

**D3 (low, FR-055): a PDF with an empty page tree leaves the reader on "Opening ..." for ever.** Repro: choose
`tests/fixtures/pdf/accept/zero-pages.pdf` (323 bytes, `/Pages << /Kids [] /Count 0 >>`). `data-phase` stays `loading` (30 s
observed), no message, no way out except choosing another file. Test:
`p7-accept-states.spec.ts › … › a structurally valid PDF with ZERO pages …`. Probable cause: the viewer fires `pagesinit`
only when it has pages. Show an error (`CORRUPT`) when `numPages === 0`.

**D4 (low, FR-055): an unreadable file gets the wrong message.** Repro: `chmod 000` a PDF and choose it. The user sees the
`RENDER` text ("Clavis couldn't start its PDF viewer ... Reload this page") instead of the `PERMISSION` text ("Chrome
couldn't read this file ..."). Cause (reproduced in the page): `Blob.arrayBuffer()` rejects with `NotReadableError`, but the
new `Blob.stream().getReader().read()` in `lib/pdf/read.ts` rejects with `TypeError: network error`, which `mapLoadError`
sends to `RENDER`. Map a read failure in the file-reading step to `PERMISSION` regardless of the error name. Test:
`p7-accept-states.spec.ts › … › a file the browser cannot read (permissions removed) gives the PERMISSION message`.

**D5 (low, FR-052/FR-053): Chrome-printed CJK PDFs hand Kangxi radicals to Groq and to the voice.** Skia writes
ToUnicode entries for many common ideographs as Kangxi radicals (for example U+2F47 for 日, U+2F49 for 月, U+2F8A for 色),
so selecting `白日依山尽，大河入海流。` in `cjk-kangxi-radicals.pdf` produces `⽩⽇依⼭尽，⼤河⼊海流。`, which is exactly what
Groq receives (verified in the intercepted request). They look identical, but a TTS voice reads them as "Kangxi radical
moon". PDF.js find already NFKC-normalises (find passes for the plain ideographs), selection does not. NFKC maps U+2F00 to
U+2FD5 back to the ideograph (checked in Node: 日, 月, 色, 白, 山, 入, 大 ...); the CJK Radicals Supplement block
(U+2E80 to U+2EF3, for example U+2EE6 and U+2EE9) does not normalise and needs a small table. Proposal: normalise the
Kangxi block with NFKC in `capturePdfSelection`, without touching other characters (NFKC would also turn full-width
punctuation into ASCII). Test: `p7-accept-actions.spec.ts › Chrome-printed CJK whose text layer uses Kangxi radicals`.
The generator writes the file with real Skia output; `manifest.json` marks its lines `nfkc: true`.

**D2 (fixed)** and a11y landmarks (fixed), found while the build was moving and kept as regression tests: typing a page number outside
1..N (999 or 0) left the page box showing 999 with no movement (now clamps); the reader had no `<main>` landmark, its empty and
dialog overlays sat outside any landmark and the password `<form>` carried `role="group"` (axe `landmark-one-main`,
`region`, `aria-allowed-role`; now clean).

## Observations (no failing test; for the manager's judgement)

- **O1.** `scan-then-text.pdf` (five picture pages, then a text page) shows the image-only banner (Spike C limitation: only
  the first five pages are scanned). The text on page 6 stays selectable (toolbar and selection work), searchable and
  findable, so the wrong part is the message. Accepted in Spike C; asserted so it cannot get worse.
- **O2.** XFA-only forms open as ordinary documents showing their fallback page ("Please wait ..."): `enableXfa: false` makes
  `doc.isPureXfa` false (confirmed in Node and in the browser, `xfa-only.pdf -> ready`), so the `UNSUPPORTED` branch at
  `lib/pdf/controller.ts` (`if (doc.isPureXfa)`) cannot be reached. The user sees a "please wait" page with no explanation.
  If that matters, detect `doc.allXfaHtml`/the `/XFA` entry another way; otherwise delete the dead branch and the
  architecture text.
- **O3.** The prompt builder escapes `<` and `>` but not `&`, so a literal `&lt;b&gt;` in a PDF reaches the model exactly
  like an escaped `<b>` (`hostile-text-links.pdf` line 6). The random nonce in the tag names is the real boundary and
  holds; this is only an ambiguity for the model.
- **O4.** PDF.js keeps its 10 most recently rendered pages, not only the pages near the viewport: after jumping from page
  100 to page 1 the canvases of pages 85 to 100 stay until later pages push them out (walk recorded in the test
  annotation, maximum 10 canvases and 21.9 MB heap). The bound is real and small; "only pages near the viewport hold
  canvases" is true loosely.
- **O5.** `find`: starting a new query right after another (typed `njkp+-0`, then `marmot`) occasionally ended at "47 of
  100" instead of "1 of 100" in both full-suite runs at load average above 20, in 2 of 16 runs with 10 parallel browsers (load 17), and in
  0 of 6 runs at load 10 and 0 of 1 idle manual run. The total was always right. Not reproduced with a deliberate zero-gap query change when idle.
  I did not isolate the cause (suspect PDF.js's incremental find while pages are still being scanned); the test now asserts
  the total only for that sequence, and the position is asserted on a fresh bar in the "marmot" test.
- **O6.** Skia-shaped Arabic (presentation forms drawn glyph by glyph in visual order) cannot be selected whole by a drag
  from the first DOM glyph to the last: the end glyphs of the RTL spans were left out in the one run that mattered (40 of
  42 characters). That is browser selection behaviour on mixed-direction spans, not the reader; the test asserts a
  contiguous run covering more than 85%. Hebrew (clean logical order) is selected exactly, both lines, at every zoom.
- **O7.** Skia's `ToUnicode` for Type3 CJK glyphs also uses the Kangxi Radicals Supplement block (U+2EE6 for 鸟, U+2EE9 for
  黄, U+2EDB for 风). NFKC does not fix those, see D5.

## Gaps (what could not be produced or checked offline)

- **JBIG2:** only a generic region coded with MMR. Arithmetic-coded generic regions, symbol dictionaries with text regions
  (what scanners and `jbig2enc` produce) and refinement are not covered: no encoder is installed and a hand-written MQ
  encoder was out of proportion. **JPEG 2000:** one lossless 8-bit RGB tile; no alpha, 16-bit, palette, CMYK, multi-tile
  or progressive stream.
- **Embedded font kinds:** no true Type1 (`FontFile`), no OpenType-CFF in `FontFile3 /OpenType`, and no embedded CID-keyed
  CFF (`CIDFontType0C`) for CJK (Skia turns CFF into Type3 and Ghostscript cannot load the Noto `.ttc`); CJK TrueType
  (Droid Sans Fallback) and CJK Type3 are covered instead. `standard_fonts/` is still not requested by any fixture
  (system fonts cover the non-embedded Helvetica here).
- **Arabic and bidi:** no PDF with a clean logical-order Arabic text layer (Skia shapes into presentation forms; LibreOffice,
  Word and Quartz are not available) and no mixed LTR/RTL paragraph.
- **Encryption:** no RC4 R3, no `/EncryptMetadata false`, no public-key handler, no non-ASCII or very long passwords for
  R4 (Latin-1) and R6 (UTF-8 truncated to 127 bytes).
- **Size:** the exactly-100-MiB test uses a sparse file of zeros (fails on content in about 15 s), so it proves the
  boundary, not the time or memory of a real 100 MiB document; memory release on close is judged by worker termination,
  zero canvases and the JS heap, not by an `ArrayBuffer` snapshot.
- **Not run:** a physical mouse, touch, screen readers (NVDA, VoiceOver, Orca), headed Chrome, branded Chrome, Windows
  and macOS, real Groq, real voices (Listen is checked on the no-voice path and on a scripted `chrome.tts`), print and
  download paths (the reader has none), visual-regression screenshots. The closed-shadow-root toolbar and card are only
  covered by their own phases' axe tests.

## DOM hooks and contract used

Only what `components/reader/Reader.tsx` documents (listed under Method). Nothing was needed beyond it. If any of these
change, edit `tests/e2e/p7-accept-support/reader.ts`. The suite also relies on: `chrome.runtime.sendMessage` being
the channel for `AI_EXPLAIN` (recorded by an init script), `GET_VOICES` replying with `data.engines.*.voices`, the
shared toolbar/card selectors in `spike-b-support/toolbar.ts` and `p5-card-support/harness.ts`, and the fixed link
confirmation texts "Open link" / "Cancel".

## What to re-run after the implementer finishes

1. Rebuild (`WXT_OUT_DIR=.output-p7-accept npx wxt build`) and run the whole suite (about 4 minutes with `--workers=3`).
2. Expected: 209 pass. When D1, D3, D4 or D5 is fixed, its `test.fail` test turns red ("Expected to fail, but passed"):
   delete that one `test.fail(...)` line (marked `DEFECT Dn` in the comment above it).
3. If selectors or texts in `components/reader` change: edit `p7-accept-support/reader.ts` only.
4. If the fixtures are regenerated: `npx tsx scripts/fixtures/make-accept-pdfs.ts`, then `--verify`, `git diff --stat
   tests/fixtures/pdf/accept` (byte-identical on this machine; on another machine Skia output depends on the installed
   fonts and Chromium, in that case commit the new files and `manifest.json` together).
5. Re-check O5 only if find tests turn flaky; the suite is otherwise stable.

