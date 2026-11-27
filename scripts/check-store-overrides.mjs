#!/usr/bin/env node
// Store-build override check (security review of Clavis Sync P2, L2/I2).
// Builds the extension WITHOUT forcing features but with every dev override variable set to a
// probe value, then greps the output: none of the probes, and none of the dev-only strings
// (http://localhost, localhost:<port>, 127.0.0.1, login_hint), may appear. A bare "localhost" is
// allowed: the per-site hostname validator (lib/ui-client/hostnames.ts) legitimately names it. Takes a full build (about 5 s).
// Usage: node scripts/check-store-overrides.mjs   (npm run check:store-overrides)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = mkdtempSync(path.join(tmpdir(), 'clavis-store-overrides-'));
const probes = {
  WXT_CLAVIS_GOOGLE_LOGIN_HINT: 'probe-hint-8d41@probe-leak.test',
  WXT_CLAVIS_GOOGLE_AUTH_URL: 'http://127.0.0.1:59998/probe-authorize',
  WXT_CLAVIS_API_ORIGIN: 'http://localhost:59997',
};
const forbidden = [
  ...Object.values(probes),
  'probe-hint-8d41',
  'probe-authorize',
  '59997',
  '59998',
  'http://localhost',
  'localhost:',
  '127.0.0.1',
  'login_hint',
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

try {
  const env = { ...process.env, ...probes, WXT_OUT_DIR: out };
  delete env.CLAVIS_FORCE_FEATURES;
  execFileSync('npx', ['wxt', 'build'], { cwd: root, env, stdio: 'ignore' });
  const build = path.join(out, 'chrome-mv3');
  const found = [];
  for (const file of files(build)) {
    if (!/\.(js|mjs|html|json|css)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const needle of forbidden) {
      if (text.includes(needle)) found.push(`${path.relative(build, file)}: ${needle}`);
    }
  }
  if (found.length > 0) {
    console.error('Dev-only strings found in a store build:\n  ' + found.join('\n  '));
    process.exitCode = 1;
  } else {
    console.log(
      `OK: no override value, http://localhost, localhost:<port>, 127.0.0.1 or login_hint in the store build (${forbidden.length} strings checked).`,
    );
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}
