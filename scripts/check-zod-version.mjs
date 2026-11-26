#!/usr/bin/env node
// shared/api-contract is compiled against three different zod installs (root, server/, dashboard/).
// They must be the same exact version (docs/clavis-sync-design.md §9). Compares the locked versions
// and requires server/ and dashboard/ to pin it exactly in package.json.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const locked = {};
const problems = [];
for (const dir of ['.', 'server', 'dashboard']) {
  const lock = readJson(path.join(dir, 'package-lock.json'));
  locked[dir] = lock.packages?.['node_modules/zod']?.version;
  if (!locked[dir]) problems.push(`${dir}/package-lock.json has no zod entry`);
}
for (const dir of ['server', 'dashboard']) {
  const declared = readJson(path.join(dir, 'package.json')).dependencies?.zod;
  if (!/^\d+\.\d+\.\d+$/.test(declared ?? '')) {
    problems.push(`${dir}/package.json must pin zod to an exact version (found "${declared}")`);
  }
}
const versions = new Set(Object.values(locked));
if (versions.size > 1) problems.push(`zod versions differ: ${JSON.stringify(locked)}`);

if (problems.length) {
  for (const p of problems) console.error(`zod check: ${p}`);
  process.exit(1);
}
console.log(`zod check: all packages use zod ${[...versions][0]}`);
