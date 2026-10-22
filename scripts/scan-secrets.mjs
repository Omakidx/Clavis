#!/usr/bin/env node
// Runs the gitleaks CLI with the repository config: git history (when commits exist) plus the working tree.
// Usage: node scripts/scan-secrets.mjs [--require]
// Without --require a missing gitleaks binary is a skip notice (local convenience); CI passes --require.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = process.argv.includes('--require');

const probe = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
if (probe.error || probe.status !== 0) {
  const message =
    'gitleaks is not installed or not on PATH (https://github.com/gitleaks/gitleaks/releases).';
  if (require) {
    console.error(`${message} It is required here.`);
    process.exit(1);
  }
  console.log(`SKIPPED secret scan: ${message} CI runs it.`);
  process.exit(0);
}
console.log(`gitleaks ${probe.stdout.trim()}`);

const common = ['--config', '.gitleaks.toml', '--redact', '--no-banner', '--exit-code', '1'];
const hasCommits =
  spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: root }).status === 0;
const scans = [
  ...(hasCommits ? [['git history', ['git', ...common, root]]] : []),
  ['working tree', ['dir', ...common, root]],
];
if (!hasCommits) console.log('No commits yet: skipping git history scan.');

let status = 0;
for (const [label, args] of scans) {
  console.log(`\n== gitleaks: ${label}`);
  const run = spawnSync('gitleaks', args, { cwd: root, stdio: 'inherit' });
  if (run.status !== 0) status = 1;
}
console.log(status === 0 ? '\nOK: no secrets found.' : '\nFAILED: gitleaks reported findings.');
process.exit(status);
