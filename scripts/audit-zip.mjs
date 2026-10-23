#!/usr/bin/env node
// Release ZIP audit (docs/architecture.md section 11 item 6; FR-075, FR-076, FR-077).
// Usage: node scripts/audit-zip.mjs [--zip <file>] [--strict] [--allowlist <file>] [--budgets <file>]
// The store ZIP size cap is `maxZipBytes` in scripts/size-budgets.json (checked here because the ZIP
// only exists after `npm run zip`).
// Default target: newest .output/*-chrome.zip. Exit 0 = clean, 1 = violations, 2 = bad input.
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
const outputDir = path.join(root, '.output');

function parseArgs(argv) {
  const opts = { zip: undefined, strict: false, allowlist: undefined, budgets: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--zip') opts.zip = path.resolve(argv[++i] ?? '');
    else if (arg === '--allowlist') opts.allowlist = path.resolve(argv[++i] ?? '');
    else if (arg === '--budgets') opts.budgets = path.resolve(argv[++i] ?? '');
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
  [/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g, 'PEM private key'],
];

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
    console.error('No .output/*-chrome.zip found. Run "npm run zip" first.');
    return 2;
  }
  const allowlistPath = opts.allowlist ?? path.join(root, 'scripts', 'expected-permissions.json');
  const expected = JSON.parse(readFileSync(allowlistPath, 'utf8'));

  const failures = [];
  const warnings = [];
  const fail = (check, message) => failures.push({ check, message });
  const warn = (check, message) => warnings.push({ check, message });

  const budgetsPath = opts.budgets ?? path.join(root, 'scripts', 'size-budgets.json');
  const maxZipBytes = JSON.parse(readFileSync(budgetsPath, 'utf8')).maxZipBytes;

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

  // 1. Entry names: path safety and forbidden files.
  for (const entry of entries) {
    const segments = entry.name.split('/');
    if (entry.name.startsWith('/') || /^[A-Za-z]:/.test(entry.name) || segments.includes('..')) {
      fail('names', `unsafe path in archive: ${entry.name}`);
    }
    for (const [pattern, label] of FORBIDDEN_NAME) {
      if (pattern.test(entry.name)) fail('names', `${label}: ${entry.name}`);
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
  for (const entry of entries) {
    if (
      entry.size > 0 &&
      !TEXT_EXT.test(entry.name) &&
      !/\.(?:woff2?|png|jpe?g|gif|ico|wasm|bin|pdf)$/i.test(entry.name) &&
      // PDF.js runtime data (D-06): CMaps, standard fonts, ICC profiles and licence files.
      !/^pdfjs\/(?:.+\.(?:bcmap|pfb|ttf|icc)|.*LICENSE[^/]*)$/i.test(entry.name)
    ) {
      warn('files', `unrecognised file type shipped: ${entry.name}`);
    }
    const data = entry.read();
    // latin1 keeps byte offsets and lets the secret patterns also match inside binaries.
    const text = data.toString('latin1');
    stats.scanned++;

    // A test build with the Should-priority flags forced on (wxt.config.ts, CLAVIS_FORCE_FEATURES=1)
    // marks every chunk; such a build must never be zipped for release.
    if (SCRIPT_EXT.test(entry.name) && text.includes(FORCED_FEATURES_MARKER)) {
      fail(
        'forced-features',
        `${entry.name} comes from a CLAVIS_FORCE_FEATURES test build (Grammar and Translate forced on). Rebuild without that variable.`,
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
        /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\d:\w.-])/gi,
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
