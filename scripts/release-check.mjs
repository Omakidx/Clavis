#!/usr/bin/env node
// Release-candidate gate (Phase 9/10): runs every deterministic check needed before a ZIP is
// uploaded to the Chrome Web Store, then prints the artifact path and its SHA-256.
//
// Usage: node scripts/release-check.mjs [--dry-run] [--skip-check] [--skip-repro] [--require-clean]
//   --dry-run        print the plan and exit (used by scripts/selftest.mjs to pin the gate list)
//   --skip-check     skip `npm run check` (typecheck, lint, format, unit tests) for a quick re-run
//   --skip-repro     skip the second, independent build that must produce a byte-identical ZIP
//   --require-clean  fail when the working tree has uncommitted changes (use for the final RC)
// Environment: WXT_OUT_DIR picks the output directory (default .output); the reproducibility build
// uses "<dir>-repro" and removes it afterwards. The browser E2E suites are a separate gate (they
// need Chromium and several minutes); CI runs them, see .github/workflows/ci.yml.
//
// The steps stop at the first failure. Exit 0 = every gate passed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const known = new Set(['--dry-run', '--skip-check', '--skip-repro', '--require-clean']);
for (const arg of args) {
  if (!known.has(arg)) {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}
const dryRun = args.has('--dry-run');

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version);
const outName = process.env['WXT_OUT_DIR'] ?? '.output';
const outDir = path.resolve(root, outName);
const reproName = `${outName.replace(/[\\/]+$/, '')}-repro`;
const reproDir = path.resolve(root, reproName);
const zipName = `${pkg.name}-${version}-chrome.zip`;
const zipPath = path.join(outDir, zipName);
const rel = (file) => path.relative(root, file) || '.';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const node = process.execPath;

/** @typedef {{ name: string, cmd: string, args: string[], env?: Record<string, string> }} Step */
/** @type {Step[]} */
const steps = [
  ...(args.has('--skip-check')
    ? []
    : [{ name: 'typecheck, lint, format, unit tests', cmd: npm, args: ['run', 'check'] }]),
  { name: 'production build', cmd: npm, args: ['run', 'build'] },
  { name: 'bundle size budgets', cmd: npm, args: ['run', 'size'] },
  { name: 'package the ZIP', cmd: npm, args: ['run', 'zip'] },
  {
    name: 'audit the ZIP (strict)',
    cmd: npm,
    args: ['run', 'audit:zip', '--', '--zip', zipPath, '--expect-version', version],
  },
  { name: 'gate self-test (negative cases)', cmd: node, args: ['scripts/selftest.mjs'] },
  {
    name: 'secret scan (gitleaks required)',
    cmd: node,
    args: ['scripts/scan-secrets.mjs', '--require'],
  },
];

const display = (step) => `${path.basename(step.cmd).replace(/\.cmd$/, '')} ${step.args.join(' ')}`;

function git(...gitArgs) {
  const run = spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

console.log(`Clavis release check: ${pkg.name} ${version}`);
console.log(`  output dir ${rel(outDir)}, artifact ${zipName}`);
console.log('  steps:');
steps.forEach((step, i) => console.log(`    ${i + 1}. ${step.name}: ${display(step)}`));
if (!args.has('--skip-repro')) {
  console.log(
    `    ${steps.length + 1}. reproducibility: second clean build in ${rel(reproDir)}, compare ZIP bytes`,
  );
}
if (dryRun) process.exit(0);

function fail(message) {
  console.error(`\nRELEASE CHECK FAILED: ${message}`);
  process.exit(1);
}

// Preconditions that no later step can detect.
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  fail(`package.json version "${version}" must be x.y.z (Chrome rejects pre-release suffixes)`);
}
if (
  process.env['CLAVIS_FORCE_FEATURES'] !== undefined &&
  process.env['CLAVIS_FORCE_FEATURES'] !== ''
) {
  fail('CLAVIS_FORCE_FEATURES is set: that is a test build (Grammar and Translate forced on)');
}
const dirty = (git('status', '--porcelain') ?? '').length > 0;
if (dirty && args.has('--require-clean'))
  fail('working tree has uncommitted changes (--require-clean)');

const timings = [];
function run(step, env = {}) {
  console.log(`\n=== ${step.name}\n$ ${display(step)}`);
  const started = Date.now();
  const result = spawnSync(step.cmd, step.args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32' && step.cmd.endsWith('.cmd'),
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  timings.push(`${step.name}: ${seconds}s`);
  if (result.status !== 0) fail(`"${step.name}" exited with ${result.status ?? result.signal}`);
}

// A stale ZIP of the same name must not be mistaken for the one this run builds.
rmSync(zipPath, { force: true });

for (const step of steps) run(step);

// The ZIP must exist under the exact name, and its manifest must carry the package.json version.
if (!existsSync(zipPath)) fail(`${rel(zipPath)} was not produced by "npm run zip"`);
const zipBytes = readFileSync(zipPath);
const manifestEntry = readZip(zipBytes).find((entry) => entry.name === 'manifest.json');
if (!manifestEntry) fail('manifest.json is missing from the ZIP');
const manifest = JSON.parse(manifestEntry.read().toString('utf8'));
if (manifest.version !== version) {
  fail(`manifest version ${manifest.version} differs from package.json version ${version}`);
}
const builtManifest = JSON.parse(
  readFileSync(path.join(outDir, 'chrome-mv3', 'manifest.json'), 'utf8'),
);
if (builtManifest.version !== version) {
  fail(`built manifest version ${builtManifest.version} differs from package.json ${version}`);
}

const sha256 = createHash('sha256').update(zipBytes).digest('hex');

// Reproducibility: an independent clean build in another directory must give the same bytes.
let reproducible = 'skipped (--skip-repro)';
if (!args.has('--skip-repro')) {
  rmSync(reproDir, { recursive: true, force: true });
  const env = { WXT_OUT_DIR: reproName };
  try {
    // `wxt zip` builds first, so this is a full independent build plus packaging.
    run({ name: 'reproducibility: second build and ZIP', cmd: npm, args: ['run', 'zip'] }, env);
    const second = readFileSync(path.join(reproDir, zipName));
    const secondSha = createHash('sha256').update(second).digest('hex');
    if (secondSha === sha256) {
      reproducible = 'yes (byte-identical ZIP from an independent clean build)';
    } else {
      const index = (buffer) =>
        new Map(
          readZip(buffer)
            .filter((entry) => !entry.isDirectory)
            .map((entry) => [
              entry.name,
              `${entry.size}:${createHash('sha256').update(entry.read()).digest('hex')}`,
            ]),
        );
      const a = index(zipBytes);
      const b = index(second);
      const differing = [...new Set([...a.keys(), ...b.keys()])].filter(
        (name) => a.get(name) !== b.get(name),
      );
      console.error(`\nSecond build SHA-256 ${secondSha} differs from ${sha256}.`);
      console.error(
        differing.length > 0
          ? `Entries that differ (${differing.length}):\n  ${differing.slice(0, 20).join('\n  ')}`
          : 'All entry contents are identical, so only ZIP metadata (timestamps, order) differs.',
      );
      fail('the build is not reproducible');
    }
  } finally {
    rmSync(reproDir, { recursive: true, force: true });
  }
}

writeFileSync(`${zipPath}.sha256`, `${sha256}  ${zipName}\n`);

console.log('\n================ RELEASE CANDIDATE ================');
console.log(`version        ${version}`);
console.log(`artifact       ${zipPath}`);
console.log(
  `size           ${zipBytes.length} bytes (${(zipBytes.length / 1048576).toFixed(2)} MiB)`,
);
console.log(`sha256         ${sha256}`);
console.log(`checksum file  ${zipPath}.sha256`);
console.log(`reproducible   ${reproducible}`);
console.log(
  `git commit     ${git('rev-parse', 'HEAD') ?? 'unknown'}${dirty ? ' (working tree has uncommitted changes)' : ''}`,
);
console.log(`timings        ${timings.join('; ')}`);
console.log(
  '\nOK: all deterministic release gates passed. Not covered here: browser E2E (CI), the manual release smoke test (docs/execution-phases.md), Phase 10 store steps.',
);
