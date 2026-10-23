#!/usr/bin/env node
// Release ZIP audit (docs/architecture.md section 11 item 6; FR-075, FR-076, FR-077).
// Usage: node scripts/audit-zip.mjs [--zip <file>] [--strict] [--allowlist <file>] [--budgets <file>]
//                                   [--expect-version <x.y.z>]
// --expect-version fails when manifest.version differs (release:check passes package.json's version, so
// a stale ZIP from an earlier build cannot be audited as the release candidate).
// The store ZIP size caps are `maxZipBytes` (compressed) and `maxUnpackedBytes` (sum of entries) in
// scripts/size-budgets.json (checked here because the ZIP only exists after `npm run zip`).
// Default target: newest <outDir>/*-chrome.zip, where outDir is $WXT_OUT_DIR or .output. Exit 0 = clean, 1 = violations, 2 = bad input.
// --strict turns warnings into failures (the npm script "audit:zip" always passes it).
//
// Limitation: remote-code detection is regex based on literal URLs ("https://...", "//..."). A URL
// built at run time (string concatenation, template parts, data read from storage or the network)
// is invisible here. The MV3 CSP (script-src 'self' 'wasm-unsafe-eval') is the runtime backstop, and
// the expected CSP is enforced exactly, so remote scripts cannot execute even if one slips past.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Same default and override as wxt.config.ts, so a scratch build (WXT_OUT_DIR=.output-x) is audited as is.
const outputDir = path.resolve(root, process.env['WXT_OUT_DIR'] ?? '.output');

function parseArgs(argv) {
  const opts = {
    zip: undefined,
    strict: false,
    allowlist: undefined,
    budgets: undefined,
    expectVersion: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--zip') opts.zip = path.resolve(argv[++i] ?? '');
    else if (arg === '--allowlist') opts.allowlist = path.resolve(argv[++i] ?? '');
    else if (arg === '--budgets') opts.budgets = path.resolve(argv[++i] ?? '');
    else if (arg === '--expect-version') opts.expectVersion = argv[++i] ?? '';
    else if (arg === '--strict') opts.strict = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function newestChromeZip() {
  let names = [];
  try {
    names = readdirSync(outputDir).filter((name) => name.endsWith('-chrome.zip'));
  } catch {
    // handled below
  }
  const ranked = names
    .map((name) => ({
      file: path.join(outputDir, name),
      mtime: statSync(path.join(outputDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return ranked[0]?.file;
}

const TEXT_EXT = /\.(?:html?|m?js|cjs|css|json|svg|txt|md|xml|webmanifest)$/i;
const SCRIPT_EXT = /\.(?:m?js|cjs)$/i;
/** Must equal FORCED_FEATURES_MARKER in wxt.config.ts. */
const FORCED_FEATURES_MARKER = 'CLAVIS_FORCED_FEATURES_BUILD_NEVER_SHIP';
const HTML_EXT = /\.html?$/i;

// File names that must never be in a store package.
const FORBIDDEN_NAME = [
  [/(^|\/)\.env(\..*)?$/i, 'environment file'],
  [/\.map$/i, 'source map'],
  [/\.(?:pem|key|p12|pfx)$/i, 'key or certificate material'],
  [/(^|\/)\.npmrc$/i, 'npm credentials file'],
  [/(^|\/)\.git(?:\/|ignore$|attributes$|config$)/i, 'git metadata'],
  [/(^|\/)node_modules\//i, 'node_modules directory'],
  [/(^|\/)\.DS_Store$/i, 'OS metadata file'],
  // The PDF.js scripting sandbox (an embedded JS engine for PDF forms) must never ship.
  [/quickjs|pdf\.sandbox/i, 'PDF.js scripting sandbox'],
  // Extension signing and debug keys, keystores, SSH keys, credential dumps.
  [/\.(?:crx|keystore|jks|p8|kdbx)$/i, 'extension package, keystore or key material'],
  [/(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i, 'SSH key'],
  [/(^|\/)(?:secrets?|credentials?)(?:\.[^/]*)?$/i, 'credentials file'],
  // Anything that belongs to the repository, not the product.
  [
    /(^|\/)(?:tests?|e2e|fixtures?|docs|scripts|coverage|playwright-report|test-results)\//i,
    'test, fixture, docs or tooling directory',
  ],
  [/\.(?:spec|test)\.[cm]?[jt]sx?$/i, 'test file'],
  [/\.(?:tsx?|mts|cts|md|log|tsbuildinfo)$/i, 'source, markdown, log or build-info file'],
  [
    /(^|\/)(?:package(?:-lock)?|tsconfig[^/]*|wxt\.config|playwright\.config)\.[^/]+$/i,
    'project config file',
  ],
];

// Manifest keys that widen the attack surface. Absent is the default; they pass only when
// expected-permissions.json carries an identical value for the key.
const RISKY_KEYS = [
  'web_accessible_resources',
  'externally_connectable',
  'sandbox',
  'oauth2',
  'key',
  'update_url',
  'chrome_url_overrides',
];

const stable = (value) =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );

// Content patterns that fail the audit. The matched text is never printed in full.
const SECRET_PATTERNS = [
  [/gsk_[A-Za-z0-9]{20,}/g, 'Groq API key (gsk_...)'],
  [/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY(?: BLOCK)?-----/g, 'PEM private key'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}/g, 'OpenAI/Anthropic-style API key (sk-...)'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key id'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, 'GitHub token'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'Slack token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'Google API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'JSON Web Token'],
  // A literal bearer credential; `Bearer ${key}` template parts do not match (no $ or { in the class).
  [/\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/g, 'hard-coded bearer credential'],
];

// Developer-only code that must not reach the store package. Test hooks follow the convention
// `__clavis*` (tests/e2e records messages with window.__clavisSent, the latency probe uses
// __clavisT); production code has none, so any occurrence is a leak. The forced-features marker
// is checked separately (its own message names the build variable).
const TEST_HOOK_PATTERNS = [
  [/\b__clavis\w*|\b__CLAVIS\w*/g, 'test hook global (__clavis*)'],
  [/\b__playwright\w*|\b__pw_\w+|\bplaywright\b/gi, 'Playwright reference'],
  [/\b__vitest\w*|\bvitest\b|@testing-library/g, 'unit-test framework reference'],
  [
    /\bCLAVIS_(?:FORCE_FEATURES|E2E\w*|TEST\w*|MEASURE\w*|LATENCY\w*)\b/g,
    'test-build environment variable',
  ],
];

// Fingerprints of a dev-server build (Vite/WXT HMR) as opposed to production output.
const DEV_BUILD_PATTERNS = [
  [
    /@vite\/client|\/@(?:fs|id)\/|import\.meta\.hot|__vite_ping|vite-hmr/g,
    'Vite dev-server/HMR code',
  ],
  [/[#@]\s*sourceURL\s*=/g, 'eval-wrapper //# sourceURL (dev build)'],
];

// Source maps: a comment pointing at one leaks the original source layout even if the .map file
// itself was stripped.
const SOURCE_MAP_COMMENT = /[#@]\s*sourceMappingURL\s*=/g;

// Dev servers are reached as host:port; a scheme-less "localhost:3000" is the same signature.
const HOST_PORT = /(?<![\w./:-])(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g;

const URL_HOST = /\b(?:https?|wss?):\/\/([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)/g;

const redact = (text) =>
  text.length <= 8 ? '***' : `${text.slice(0, 4)}...(${text.length} chars, redacted)`;

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function sameSet(actual, expected) {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    extra: [...a].filter((x) => !e.has(x)),
    missing: [...e].filter((x) => !a.has(x)),
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const zipPath = opts.zip ?? newestChromeZip();
  if (!zipPath) {
    console.error(
      `No ${path.relative(root, outputDir) || '.'}/*-chrome.zip found. Run "npm run zip" first.`,
    );
    return 2;
  }
  const allowlistPath = opts.allowlist ?? path.join(root, 'scripts', 'expected-permissions.json');
  const expected = JSON.parse(readFileSync(allowlistPath, 'utf8'));

  const failures = [];
  const warnings = [];
  const fail = (check, message) => failures.push({ check, message });
  const warn = (check, message) => warnings.push({ check, message });

  const budgetsPath = opts.budgets ?? path.join(root, 'scripts', 'size-budgets.json');
  const budgetsConfig = JSON.parse(readFileSync(budgetsPath, 'utf8'));
  const { maxZipBytes, maxUnpackedBytes } = budgetsConfig;

  const zipBuffer = readFileSync(zipPath);
  const entries = readZip(zipBuffer).filter((entry) => !entry.isDirectory);
  const names = new Set(entries.map((entry) => entry.name));
  console.log(`Auditing ${path.relative(root, zipPath) || zipPath}`);
  console.log(`  ${entries.length} files, ${(zipBuffer.length / 1024).toFixed(1)} KB compressed\n`);

  // 0. Store package size cap.
  if (typeof maxZipBytes === 'number') {
    const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    console.log(
      `  ZIP size ${zipBuffer.length} bytes (${mb(zipBuffer.length)}) of ${maxZipBytes} allowed (${mb(maxZipBytes)})\n`,
    );
    if (zipBuffer.length > maxZipBytes) {
      fail(
        'size',
        `ZIP is ${zipBuffer.length} bytes (${mb(zipBuffer.length)}), cap is ${maxZipBytes} bytes (${mb(maxZipBytes)}); over by ${zipBuffer.length - maxZipBytes} bytes`,
      );
    }
  }

  if (typeof maxUnpackedBytes === 'number') {
    const unpacked = entries.reduce((sum, entry) => sum + entry.size, 0);
    console.log(`  Unpacked size ${unpacked} bytes of ${maxUnpackedBytes} allowed\n`);
    if (unpacked > maxUnpackedBytes) {
      fail(
        'size',
        `entries unpack to ${unpacked} bytes, cap is ${maxUnpackedBytes} bytes; over by ${unpacked - maxUnpackedBytes} bytes`,
      );
    }
  }

  // 1. Entry names: path safety, forbidden files, and "every file is expected".
  const filePatterns = (expected.allowedFilePatterns ?? []).map((source) => new RegExp(source));
  if (filePatterns.length === 0) {
    fail(
      'config',
      'allowedFilePatterns is missing from the allowlist file; cannot judge the files',
    );
  }
  const seenNames = new Map();
  for (const entry of entries) {
    const segments = entry.name.split('/');
    if (entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name) || segments.includes('..')) {
      fail('names', `unsafe path in archive: ${entry.name}`);
    }
    // Duplicate names (the last one wins in some unzippers, the first in others) and names that
    // differ only by case (one file overwrites the other on Windows/macOS).
    const folded = entry.name.toLowerCase();
    if (seenNames.has(folded)) {
      fail(
        'names',
        `duplicate or case-colliding entries: ${seenNames.get(folded)} and ${entry.name}`,
      );
    }
    seenNames.set(folded, entry.name);
    if (segments.some((segment) => segment.startsWith('.'))) {
      fail('names', `hidden file or directory: ${entry.name}`);
    }
    for (const [pattern, label] of FORBIDDEN_NAME) {
      if (pattern.test(entry.name)) fail('names', `${label}: ${entry.name}`);
    }
    if (filePatterns.length > 0 && !filePatterns.some((pattern) => pattern.test(entry.name))) {
      fail('files', `unexpected file (matches no allowedFilePatterns entry): ${entry.name}`);
    }
  }

  // 2. Manifest.
  let manifest;
  if (!names.has('manifest.json')) {
    fail('manifest', 'manifest.json is not at the ZIP root');
  } else {
    try {
      manifest = JSON.parse(
        entries
          .find((e) => e.name === 'manifest.json')
          .read()
          .toString('utf8'),
      );
    } catch (error) {
      fail('manifest', `manifest.json is not valid JSON: ${error.message}`);
    }
  }

  if (manifest) {
    if (manifest.manifest_version !== 3)
      fail('manifest', `manifest_version is ${manifest.manifest_version}, expected 3`);
    if ('content_scripts' in manifest) {
      fail(
        'manifest',
        'content_scripts must be absent (D-02: registered at runtime after site access is granted)',
      );
    }
    for (const key of [
      'permissions',
      'optional_permissions',
      'host_permissions',
      'optional_host_permissions',
    ]) {
      const { extra, missing } = sameSet(manifest[key] ?? [], expected[key] ?? []);
      for (const item of extra)
        fail('permissions', `${key}: unexpected "${item}" (not in expected-permissions.json)`);
      for (const item of missing) fail('permissions', `${key}: expected "${item}" is missing`);
    }

    // Top-level key allowlist: anything not listed in expected-permissions.json fails.
    const allowedKeys = new Set(expected.allowedManifestKeys ?? []);
    for (const key of Object.keys(manifest)) {
      if (key === 'content_scripts') continue; // reported above with its own message
      if (RISKY_KEYS.includes(key)) {
        if (!(key in expected)) {
          fail('manifest', `risky manifest key "${key}" is present but not expected`);
        } else if (stable(manifest[key]) !== stable(expected[key])) {
          fail(
            'manifest',
            `"${key}" differs from expected-permissions.json: ${stable(manifest[key])}`,
          );
        } else if (
          key === 'web_accessible_resources' &&
          !(
            Array.isArray(manifest[key]) &&
            manifest[key].every((entry) => entry && entry.use_dynamic_url === true)
          )
        ) {
          fail('manifest', 'every web_accessible_resources entry must set use_dynamic_url: true');
        }
      } else if (!allowedKeys.has(key)) {
        fail('manifest', `unexpected manifest key "${key}" (not in allowedManifestKeys)`);
      }
    }
    // Values pinned in one place so a change is a visible diff to expected-permissions.json.
    for (const key of ['minimum_chrome_version', 'commands']) {
      if (!(key in expected)) continue;
      if (!(key in manifest)) {
        fail('manifest', `"${key}" is missing (expected ${stable(expected[key])})`);
      } else if (stable(manifest[key]) !== stable(expected[key])) {
        fail(
          'manifest',
          `"${key}" differs from expected-permissions.json: ${stable(manifest[key])} (expected ${stable(expected[key])})`,
        );
      }
    }

    const csp = manifest.content_security_policy;
    const cspText = typeof csp === 'string' ? csp : JSON.stringify(csp ?? {});
    // The only approved loosening is 'wasm-unsafe-eval' for PDF.js decoders (D-17); the CSP must
    // match expected-permissions.json exactly, and nothing else may weaken it.
    const expectedCsp = JSON.stringify(expected.content_security_policy ?? {});
    if (cspText !== expectedCsp) {
      fail(
        'manifest',
        `content_security_policy differs from expected-permissions.json: ${cspText}`,
      );
    }
    const cspWithoutWasm = cspText.replaceAll("'wasm-unsafe-eval'", '');
    if (
      /unsafe-eval|unsafe-inline|https?:\/\//i.test(cspWithoutWasm) ||
      /localhost|127\.0\.0\.1/.test(cspText)
    ) {
      fail(
        'manifest',
        `content_security_policy loosens the MV3 default or allows remote sources: ${cspText}`,
      );
    }
    if (/localhost|127\.0\.0\.1/.test(JSON.stringify(manifest))) {
      fail(
        'manifest',
        'manifest references localhost (a dev-server build leaked into the package)',
      );
    }

    // Referenced files must be in the package (FR-077: the ZIP itself must work).
    const referenced = new Set();
    const add = (value) => typeof value === 'string' && referenced.add(value.replace(/^\//, ''));
    add(manifest.background?.service_worker);
    add(manifest.action?.default_popup);
    add(manifest.options_page);
    add(manifest.options_ui?.page);
    add(manifest.side_panel?.default_path);
    Object.values(manifest.icons ?? {}).forEach(add);
    Object.values(manifest.action?.default_icon ?? {}).forEach(add);
    if (manifest.default_locale) add(`_locales/${manifest.default_locale}/messages.json`);
    for (const file of referenced) {
      if (!names.has(file)) fail('files', `manifest references ${file}, which is not in the ZIP`);
    }
  }

  // 3. File contents.
  const stats = { scanned: 0, evalWarnings: 0 };
  /** Host name -> files that mention it as a literal http(s)/ws(s) URL. */
  const urlHosts = new Map();
  const allowedHosts = Object.values(expected.allowedUrlHosts ?? {})
    .flat()
    .map((host) => host.toLowerCase());
  for (const entry of entries) {
    const data = entry.read();
    // latin1 keeps byte offsets and lets the secret patterns also match inside binaries.
    const text = data.toString('latin1');
    stats.scanned++;

    // A test build with the Should-priority flags forced on (wxt.config.ts, CLAVIS_FORCE_FEATURES=1)
    // marks every chunk; such a build must never be zipped for release.
    if (SCRIPT_EXT.test(entry.name) && text.includes(FORCED_FEATURES_MARKER)) {
      fail(
        'forced-features',
        `${entry.name} comes from a CLAVIS_FORCE_FEATURES test build (the Grammar tab forced on). Rebuild without that variable.`,
      );
    }

    for (const [pattern, label] of SECRET_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        fail(
          'secrets',
          `${label} in ${entry.name} line ${lineOf(text, match.index)}: ${redact(match[0])}`,
        );
      }
    }

    const isHtml = HTML_EXT.test(entry.name);
    const isScript = SCRIPT_EXT.test(entry.name);

    if (TEXT_EXT.test(entry.name)) {
      const at = (match) => `${entry.name} line ${lineOf(text, match.index)}`;
      for (const match of text.matchAll(SOURCE_MAP_COMMENT)) {
        fail('source-map', `sourceMappingURL comment in ${at(match)}`);
      }
      for (const [pattern, label] of [...TEST_HOOK_PATTERNS, ...DEV_BUILD_PATTERNS]) {
        for (const match of text.matchAll(pattern)) {
          fail('test-code', `${label} in ${at(match)}: ${redact(match[0])}`);
        }
      }
      // Dev-server addresses in any text file (HTML, CSS, JSON, scripts): host:port is the signature.
      // Scripts also get the scheme-qualified form below with its own message; the other text
      // files (HTML, CSS, JSON, SVG) get it here.
      for (const match of text.matchAll(HOST_PORT)) {
        fail('localhost', `dev-server address "${match[0]}" in ${at(match)}`);
      }
      if (!isScript) {
        for (const match of text.matchAll(
          /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)/gi,
        )) {
          fail('localhost', `dev-server URL "${match[0]}" in ${at(match)}`);
        }
      }
      for (const match of text.matchAll(URL_HOST)) {
        const host = match[1].toLowerCase();
        if (/^(?:localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(host)) continue; // localhost rules
        const files = urlHosts.get(host) ?? new Set();
        files.add(entry.name);
        urlHosts.set(host, files);
      }
    }

    if (isHtml) {
      for (const match of text.matchAll(/<script\b([^>]*)>/gi)) {
        const attrs = match[1];
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
        const url = src ? (src[1] ?? src[2] ?? src[3]) : undefined;
        if (url && /^(?:https?:)?\/\//i.test(url)) {
          fail(
            'remote-code',
            `remote <script src="${url}"> in ${entry.name} line ${lineOf(text, match.index)}`,
          );
        } else if (
          !url &&
          !/type\s*=\s*["']?(?:application\/(?:ld\+)?json|importmap)/i.test(attrs)
        ) {
          fail(
            'remote-code',
            `inline <script> in ${entry.name} line ${lineOf(text, match.index)} (blocked by MV3 CSP)`,
          );
        }
      }
      for (const match of text.matchAll(
        /<link\b[^>]*\brel\s*=\s*["']?(?:modulepreload|stylesheet)[^>]*\bhref\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi,
      )) {
        fail(
          'remote-code',
          `remote <link> in ${entry.name} line ${lineOf(text, match.index)}: ${match[0].slice(0, 80)}`,
        );
      }
    }

    if (isScript) {
      // `(?:https?:)?//` matches both absolute and protocol-relative remote URLs.
      const remotePatterns = [
        [/\bimport\s*\(\s*["'`](?:https?:)?\/\//g, 'remote dynamic import()'],
        [/\bfrom\s*["'](?:https?:)?\/\//g, 'remote static import'],
        [/\bimportScripts\s*\([^)]*["'`](?:https?:)?\/\//g, 'importScripts() of a remote URL'],
        [
          /\bnew\s+(?:Shared)?Worker\s*\(\s*(?:new\s+URL\s*\(\s*)?["'`](?:https?:)?\/\//g,
          'Worker created from a remote URL',
        ],
        [
          /\.src\s*=\s*["'`](?:https?:)?\/\/[^"'`]*\.js\b/g,
          'script element pointed at a remote .js URL',
        ],
        [
          /\bWebAssembly\s*\.\s*(?:instantiateStreaming|compileStreaming)\s*\([^;]{0,200}?\bfetch\s*\(\s*["'`](?:https?:)?\/\//g,
          'WebAssembly streaming compile of a remote URL',
        ],
        [/\bfetch\s*\(\s*["'`](?:https?:)?\/\/[^"'`]*\.wasm\b/g, 'fetch of a remote .wasm module'],
      ];
      for (const [pattern, label] of remotePatterns) {
        for (const match of text.matchAll(pattern)) {
          fail('remote-code', `${label} in ${entry.name} line ${lineOf(text, match.index)}`);
        }
      }

      // Dev-server leakage: WXT dev mode points the build at http://localhost:3000 (HMR, websockets).
      // A localhost URL WITH a port is the dev-server signature, so it fails. A bare localhost mention
      // can be a legitimate string inside a bundled library (URL parsing docs, regexes), so it only warns.
      for (const match of text.matchAll(
        /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)/gi,
      )) {
        fail(
          'localhost',
          `dev-server URL "${match[0]}" in ${entry.name} line ${lineOf(text, match.index)}`,
        );
      }
      for (const match of text.matchAll(
        /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?![\d:\w.-])/gi,
      )) {
        warn(
          'localhost',
          `localhost URL "${match[0]}" in ${entry.name} line ${lineOf(text, match.index)}`,
        );
      }

      // eval / new Function: MV3's default CSP already blocks them at runtime, and some bundled libraries
      // (for example zod's JIT feature probe) reference them inside try/catch. Warn so a person reviews it.
      const evalHits = [...text.matchAll(/(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(/g)];
      if (evalHits.length > 0) {
        stats.evalWarnings += evalHits.length;
        warn(
          'eval',
          `${evalHits.length} eval()/new Function() reference(s) in ${entry.name} (blocked by MV3 CSP; review that they are inert)`,
        );
      }
    }
  }

  // 4. Network inventory: every literal URL host in shipped text must be on the reviewed list.
  // Hosts that are only documentation or XML namespaces are on the list too; a NEW host (analytics,
  // a CDN, a second AI provider) is a visible diff to expected-permissions.json.
  const isAllowedHost = (host) =>
    allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  for (const [host, files] of [...urlHosts].sort(([a], [b]) => a.localeCompare(b))) {
    if (!isAllowedHost(host)) {
      fail(
        'egress',
        `URL host "${host}" is not in allowedUrlHosts (in ${[...files].slice(0, 3).join(', ')}${files.size > 3 ? ', ...' : ''})`,
      );
    }
  }

  // 5. Version: numeric dotted (Chrome rejects pre-release suffixes) and the expected one.
  if (manifest) {
    if (typeof manifest.version !== 'string' || !/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) {
      fail('version', `manifest version "${manifest.version}" is not 1-4 dot-separated integers`);
    }
    if (opts.expectVersion !== undefined && manifest.version !== opts.expectVersion) {
      fail(
        'version',
        `manifest version is "${manifest.version}", expected "${opts.expectVersion}" (stale ZIP?)`,
      );
    }
  }

  // Report.
  const section = (title, items) => {
    if (items.length === 0) return;
    console.log(`${title} (${items.length})`);
    for (const item of items) console.log(`  [${item.check}] ${item.message}`);
    console.log('');
  };
  if (manifest) {
    console.log('Manifest');
    console.log(`  name: ${manifest.name}  version: ${manifest.version}`);
    for (const key of ['permissions', 'host_permissions', 'optional_host_permissions']) {
      console.log(`  ${key}: ${JSON.stringify(manifest[key] ?? [])}`);
    }
    console.log(`  minimum_chrome_version: ${manifest.minimum_chrome_version}`);
    console.log(`  manifest keys: ${Object.keys(manifest).join(', ')}`);
    console.log(
      `  URL hosts in shipped text: ${[...urlHosts.keys()].sort().join(', ') || '(none)'}`,
    );
    console.log(`  content_scripts: ${'content_scripts' in manifest ? 'PRESENT' : 'absent'}\n`);
  }
  section('FAILURES', failures);
  section(opts.strict ? 'WARNINGS (strict: treated as failures)' : 'WARNINGS', warnings);

  const blocking = failures.length + (opts.strict ? warnings.length : 0);
  if (blocking > 0) {
    console.error(`AUDIT FAILED: ${failures.length} failure(s), ${warnings.length} warning(s).`);
    return 1;
  }
  console.log(
    `AUDIT PASSED: ${stats.scanned} files scanned, 0 failures, ${warnings.length} warning(s).`,
  );
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`audit-zip: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 2;
}
