# Phase 9: performance budgets, package inspection and release candidate

Status 2026-10-23. Scope: the Phase 9 performance items (reader memory budget, toolbar p95, AI latency tracking), the release ZIP inspection, and the release-candidate pipeline for **1.0.0**. Specs: `tests/e2e/p9-perf-*.spec.ts`. Gates: `scripts/` and `.github/workflows/ci.yml`.

## Machine and method

All numbers below come from one shared Linux development box (16 cores, 64 GB, Chromium from Playwright 1.64, new headless mode), **never idle**: other test runs were active, so the 1-minute load average was **7 to 15** (0.45 to 0.9 per core). The specs record `os.loadavg()` with every result, and flag `quietMachine` (load per core under 0.5); none of these runs was quiet. Where a number has a budget it is stated with the margin, so a quiet machine can only do better. Each figure is the median of 3 rounds (or the value of 2 identical runs when the metric is deterministic), and each spec was run twice. Reproduce with:

```sh
WXT_OUT_DIR=.output-p9-perf npm run build
CLAVIS_EXTENSION_DIR=.output-p9-perf/chrome-mv3 npx playwright test tests/e2e/p9-perf-memory.spec.ts tests/e2e/p9-perf-ai-latency.spec.ts --output <dir>
CLAVIS_EXTENSION_DIR=.output-p9-perf/chrome-mv3 CLAVIS_LATENCY_STRICT=1 CLAVIS_P9_LOADS=30 npx playwright test tests/e2e/p9-perf-toolbar.spec.ts --output <dir>
```

Each spec writes its numbers to `<output dir>/p9-perf-*.json` and logs them. In CI (and by default) the specs assert only generous ceilings, so load cannot make them flake; `CLAVIS_LATENCY_STRICT=1` asserts the real toolbar budgets.

## 1. Reader memory budget

Fixture: a generated text PDF (800 pages, 38 text lines each, 1.1 MB; deterministic, never committed; `CLAVIS_P9_PDF_PAGES` changes the size). The reader opens it, is scrolled end to end in 25 steps, jumps 24 times to pseudo-random pages (fixed seed), changes zoom (1, 1.75, page-width, 0.5, 1), then replaces it with a 1-page PDF, which runs the same `close()` cleanup (`viewer.setDocument(null)`, `linkService.setDocument(null)`, `loadingTask.destroy()`).

### What the budget says

| Quantity | Budget (enforced) | Measured (2 runs) | Notes |
| --- | --- | --- | --- |
| Pages holding a canvas | at most 14 | 10 | PDF.js: visible pages + 10-page buffer; the 800 placeholders stay (cheap) |
| Canvas elements | at most 20 | 12 | |
| Canvas backing store, all pages together | at most 48 Mpx (192 MB) | 10.1 Mpx (38.6 MB) | 4x headroom; one canvas is capped at 16.7 Mpx by `MAX_CANVAS_PIXELS` |
| JS heap retained after the walk (GC forced), above the empty reader | at most 50 MB | +6.1 MB (3.6 to 9.7) | main-thread V8 heap of the reader page |
| JS heap peak while walking (garbage included) | at most 150 MB | 22 to 24 MB | |
| JS heap after closing, above baseline | at most 20 MB | +3.0 MB | |
| DOM nodes after closing, above baseline | at most 1,500 | +39 (404 to 443) | 20,694 nodes while the 800-page document is open |
| PDF.js workers after closing | at most 1 | 1 | the new document's; the old one is terminated |

### Whole-browser memory (Linux only, `/proc`)

The JS heap is small because the cost is native: canvases, the PDF.js worker and Skia caches. The spec therefore also sums **PSS over the browser process tree** (found by its unique `--user-data-dir`, so other Chrome instances are not counted), using the same walk:

| Moment | Total MB | Renderer MB |
| --- | --- | --- |
| Reader open, empty | 259 to 401 | 112 to 167 |
| 800-page PDF open, scrolled end to end (peak) | 550 to 601 | 375 to 406 |
| After closing (poll up to 40 s) | 337 to 394 | 174 to 205 |

Growth while open: **+291 to +293 MB**. After closing: back to **+73 to +78 MB** above the empty reader (the loop stops as soon as growth is at most 100 MB; in three one-off manual runs, 10 s after closing, the total was between 58 MB below and 146 MB above the empty-reader figure, and about 30 MB lower again once the tab was closed). The baseline moves by about 140 MB between runs on a loaded machine (shared renderer reuse), so the budgets are on the **growth**: at most **500 MB** while open and at most **200 MB** after closing.

One-off scaling check (not in the suite): renderer growth was 315 MB at 200 pages, 262 MB at 800 pages and 312 MB at 1,600 pages. **Memory is bounded by the viewport and the render buffer, not by the page count**; the number of pages costs DOM nodes (about 25 per placeholder with text layers present, 20,694 nodes for 800 pages) and a little heap.

### Page with toolbar, card and side panel

| Quantity | Budget (enforced) | Measured |
| --- | --- | --- |
| Page JS heap, idle observer | n/a | 1.1 MB |
| ...with the toolbar shown | n/a | 1.4 MB |
| ...with the card (core and Roots loaded) | growth at most 10 MB | +0.6 MB (1.7 MB) |
| Side panel page JS heap | at most 30 MB | 6.6 MB |
| 15 select, Explain and dismiss cycles (GC forced), heap growth | at most 10 MB | +0.4 MB |

The DOM node counter is **not** a usable leak signal: it counts garbage Oilpan has not collected and swung between 126 and 780 nodes over 40 cycles with no trend (checked without any DevTools DOM calls, which would themselves retain nodes). The spec bounds it at 2,500 as a catastrophe check and relies on the heap.

### Limits of this measurement

- The PDF.js worker's own JS heap is invisible to the page's protocol session; the process-level PSS covers it.
- Linux only. Windows/macOS memory was not measured (the process spec skips there; the heap and canvas bounds run everywhere).
- A 5,000-page file (the `MAX_PDF_PAGES` cap) was not opened; the 1,600-page run shows no growth beyond the viewport cost.

## 2. Toolbar latency (D-08, NFR)

Budgets: first toolbar on a page at most **150 ms p95** including the lazy UI load, later toolbars at most **50 ms p95**, from selection end to toolbar visible (the conservative `frame` figure, one animation frame after the DOM change). Production build, 30 page loads per round (first iteration discarded), 3 rounds per CPU setting. Reported figure: **median of the 3 rounds' p95**.

| Setting | First toolbar p95 (rounds) | Median | Repeat toolbar p95 (rounds) | Median |
| --- | --- | --- | --- | --- |
| 1x CPU, run A (`STRICT`, load 11 to 14) | 47.5, 39.7, 48.3 | **47.5 ms** | 30.9, 31.1, 26.7 | **30.9 ms** |
| 1x CPU, run B (load 13 to 15) | 45.0, 52.0, 53.7 | **52.0 ms** | 27.5, 31.0, 30.0 | **30.0 ms** |
| 4x CPU, run A | 130.6, 110.8, 135.1 | **130.6 ms** | 36.1, 28.4, 39.3 | **36.1 ms** |
| 4x CPU, run B | 124.1, 135.3, 146.4 | **135.3 ms** | 43.8, 34.3, 31.2 | **34.3 ms** |

Both budgets hold at 1x (first 3x under, repeat 1.6x under) and at 4x CPU slowdown. The 4x first-toolbar figure is the tight one: **individual rounds reached 146.4 ms against 150 ms** on a machine at about 0.9 load per core, so on a similarly loaded CI runner the 4x number would flake. That is why CI asserts a 3x ceiling and `CLAVIS_LATENCY_STRICT=1` is manual. The Phase 8 caveat (an isolated 4x outlier of 219.6 ms) did not recur in 15 rounds. A run on a genuinely quiet machine is still a release-day item.

## 3. AI latency tracking (no backend SLA)

Groq is replaced by a test server that answers after a fixed delay (0 and 600 ms). The spec measures what the **extension** adds, never Groq itself (measure Groq with a real free-tier account; see [p5-prompt-eval.md](p5-prompt-eval.md); no SLA is promised). 10 page loads per delay, each with a first Explain (card script injected) and a later Explain on the same page; clock resolution about 10 to 20 ms (the card is polled through the DevTools protocol).

| Phase | First Explain on a page p50 / p95 | Later Explain p50 / p95 |
| --- | --- | --- |
| Click to the request leaving | 40 / 68 to 99 ms | 17 to 20 / 24 to 43 ms |
| Answer arrives to card painted | 25 to 29 / 61 to 69 ms | 19 to 34 / 26 to 54 ms |
| Everything the extension adds | 66 to 90 / 113 to 126 ms | 38 to 56 / 53 to 74 ms |

Ceilings enforced (p95): first-Explain overhead 1,000 ms, later 750 ms, answer-to-paint 400 ms (8 to 10x the measured values), plus exactly one chat request per Explain. The measured overhead did not depend on the server delay.

## 4. ZIP inspection (`scripts/audit-zip.mjs`)

Existing checks kept: forced-features marker, secrets (`gsk_`, PEM), `.env`, `.map` files, key/cert file names, remote scripts and imports, inline scripts, dev-server URLs with ports in scripts, the CSP and permission allowlists, no `content_scripts`, PDF.js scripting sandbox, ZIP size cap. **Added in Phase 9** (every one has a negative case in `scripts/selftest.mjs`, now 150 cases):

| Check | Fails on |
| --- | --- |
| Every file expected | any path matching no `allowedFilePatterns` entry in `expected-permissions.json` (unknown file types are now failures, not warnings); hidden files and directories; duplicate and case-colliding names |
| Not from the repository | `tests/`, `fixtures/`, `docs/`, `scripts/` directories; `*.spec.*`/`*.test.*`; `.ts`/`.md`/`.log`/`.tsbuildinfo`; `package.json`, `tsconfig*`, `wxt.config`, `playwright.config` |
| Debug and signing keys | `.crx`, `.keystore`, `.jks`, `.p8`, `.kdbx`, `id_rsa`-style SSH keys, `credentials*`/`secrets*` files (on top of `.pem`, `.key`, `.p12`, `.pfx`, `manifest.key`) |
| More secret shapes | OpenAI/Anthropic-style `sk-`, AWS access key ids, GitHub tokens, Slack tokens, Google API keys, JWTs, literal `Bearer <token>`, any `PRIVATE KEY` PEM header (matches are redacted in output) |
| Source maps | a `sourceMappingURL` comment (also legacy `//@`) in any JS/CSS/HTML/JSON/SVG file, even when the `.map` is gone |
| Test-only code | any `__clavis*` identifier (the test-hook convention: `__clavisSent`, `__clavisT`), Playwright and vitest/testing-library references, test-build variable names (`CLAVIS_FORCE_FEATURES`, `CLAVIS_E2E*` ...); the forced-features marker as before |
| Dev-build residue | Vite client/HMR (`@vite/client`, `import.meta.hot`), `//# sourceURL=` eval wrappers |
| Localhost in every text file | `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` with a port, with or without a scheme, in HTML, CSS, JSON, SVG and scripts (bare mentions still warn in scripts, and `--strict` fails them) |
| Network inventory | every literal `http(s)`/`ws(s)` URL host must be listed in `allowedUrlHosts` (`network`: `api.groq.com`; `links`: opened only after a click; `inert`: namespaces, docs, error text inside libraries). Suffix look-alikes (`api.groq.com.evil.example`, `evilgroq.com`) fail. A new analytics host or CDN is a visible diff |
| Unpacked size | entries summing above `maxUnpackedBytes` (7 MiB; the build is 5.2 MiB) |
| Version | not 1 to 4 dot-separated integers (Chrome rejects `1.0.0-rc.1`); `--expect-version` rejects a stale ZIP (release:check passes package.json's version) |

Not covered (and why): a URL built at run time is invisible to any static scan (the MV3 CSP is the backstop, as the script's header already says); static detection of unlicensed Chrome APIs is unreliable because the code calls `browser.*`, so the permission allowlist is the control. "Unsupported/disabled features": Grammar and Translate are guarded by the forced-features marker; `offscreen`, `unlimitedStorage` and any other permission fail the permission allowlist; the PDF scripting sandbox fails by name. The 1.0.0 ZIP has 241 files and passes `--strict` with 0 failures and 0 warnings.

## 5. Release candidate 1.0.0

- `package.json` version `1.0.0` (the lockfile's root entry matches). WXT copies it to the manifest; both the built manifest and the manifest inside the ZIP are verified equal to it.
- `npm run zip` already names the artifact from package.json: **`clavis-1.0.0-chrome.zip`** (`<name>-<version>-chrome.zip`), no timestamp or commit in the name; `release:check` fails if the file is not produced under exactly that name.
- `npm run release:check` (`scripts/release-check.mjs`) runs, in order, stopping at the first failure: `npm run check` (typecheck, lint, format, unit), `build`, `size`, `zip`, `audit:zip --strict --expect-version`, `selftest`, `scan-secrets --require`, then a **second independent build** in `<outDir>-repro` whose ZIP must be byte-identical; it prints the artifact path, size, SHA-256, git commit (and whether the tree is dirty) and writes `<zip>.sha256`. Flags: `--skip-check`, `--skip-repro`, `--require-clean` (CI uses it), `--dry-run` (the self-test pins the step list so a gate cannot be dropped silently). It refuses to run with `CLAVIS_FORCE_FEATURES` set. `WXT_OUT_DIR` (honoured by `audit-zip` and `check-bundle-size` too) keeps scratch runs out of `.output`.
- **Reproducibility**: two consecutive clean builds produced **byte-identical ZIPs** (same SHA-256), also when the second build ran in a different output directory. WXT writes fixed entry timestamps. Not tested: another machine, OS or Node version (CI runs it on the pinned `.nvmrc` Node).
- Bundle margins on this build: observer `observer.js` 17.12 of 18.00 KB gzip (the margin was 0.14 KB before the unlisted-script change; keep an eye on it), card 14.40 of 20, ZIP 2.50 MiB of 3.2 MiB.

## 6. CI (`.github/workflows/ci.yml`)

The `checks` job already ran typecheck, lint, format, unit, build, size, zip, audit, selftest and gitleaks (pinned CLI); `e2e` runs the whole Playwright suite (now including the p9 specs) on Linux, Windows and macOS; `e2e-real-ui` runs `spike-b-real-ui`, `p4-matrix-realui`, `p8-sidepanel-realui` and `p8-accept-realui` under xvfb. Changes: the `e2e` timeout is 30 minutes (the performance specs add a few minutes), and a new **`release-candidate`** job (main and `v*` tags, after `checks` and `e2e` pass) runs `npm run release:check -- --require-clean` on a clean checkout, writes artifact, SHA-256 and reproducibility result to the job summary, and uploads the ZIP and `.sha256` as `clavis-release-candidate` for 90 days. `actionlint` 1.7.12 reports no findings. `e2e-real-ui` stays `continue-on-error` (xdotool coordinates are untested on runners; make it blocking after its first green run on a real runner).

## 7. Findings and follow-ups

1. Observer budget margin is small (0.88 KB after the unlisted-script change; was 0.14 KB).
2. 4x-CPU first-toolbar p95 sits only 2 to 13% under budget on a loaded machine; confirm on a quiet one before treating it as comfortable.
3. Windows/macOS memory and latency are not measured; only Linux was available.
4. `.gitleaks.toml` allowlists `.output/` but not scratch builds (`.output-*`); a working-tree scan with one present passed anyway, but add `\.output-[^/]*/` if it ever flags (not edited here, outside `scripts/`).
5. The first real CI run (no remote yet) will exercise the `release-candidate` job, which has only been linted.
6. Phase 10 still needs the manual smoke test of the exact ZIP, the Windows/macOS pass and a dependency/advisory recheck.
