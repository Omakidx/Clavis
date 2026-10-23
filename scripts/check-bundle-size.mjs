#!/usr/bin/env node
// Content-script bundle-size budget check (docs/tech-stack.md section 6, D-08).
// Usage: node scripts/check-bundle-size.mjs [--dir <build dir>] [--budgets <file>] [--verbose]
// Aggregate rows that match more than 3 files show `first (+N more)`; --verbose lists every file.
// Exit 0 when every budget holds, 1 on an overrun or a missing required file, 2 on bad input.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {
    dir: undefined,
    budgets: path.join(root, 'scripts', 'size-budgets.json'),
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dir') opts.dir = argv[++i];
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--budgets') opts.budgets = path.resolve(argv[++i] ?? '');
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

/** Expands a build-relative pattern. Only `*` within a single path segment is supported. */
function expand(buildDir, pattern) {
  const posix = pattern.split('\\').join('/');
  if (!posix.includes('*')) {
    try {
      return statSync(path.join(buildDir, posix)).isFile() ? [posix] : [];
    } catch {
      return [];
    }
  }
  const slash = posix.lastIndexOf('/');
  const dir = slash === -1 ? '' : posix.slice(0, slash);
  const filePattern = posix.slice(slash + 1);
  if (dir.includes('*'))
    throw new Error(`Wildcards are only supported in the file name: ${pattern}`);
  const regex = new RegExp(
    `^${filePattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
  );
  let names;
  try {
    names = readdirSync(path.join(buildDir, dir));
  } catch {
    return [];
  }
  return names.filter((name) => regex.test(name)).map((name) => (dir ? `${dir}/${name}` : name));
}

const summarize = (files, verbose) =>
  files.length > 3 && !verbose ? `${files[0]} (+${files.length - 1} more)` : files.join(' + ');

const kb = (bytes) => `${(bytes / 1024).toFixed(2)} KB`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const config = JSON.parse(readFileSync(opts.budgets, 'utf8'));
  const buildDir = path.resolve(root, opts.dir ?? config.buildDir);
  try {
    statSync(buildDir);
  } catch {
    console.error(`Build directory not found: ${buildDir}\nRun "npm run build" first.`);
    return 2;
  }

  const rows = [];
  const problems = [];

  for (const budget of config.budgets) {
    const matched = [...new Set(budget.files.flatMap((pattern) => expand(buildDir, pattern)))];
    const label =
      budget.files.length > 1
        ? `${budget.files[0]} (+${budget.files.length - 1} more)`
        : budget.files[0];
    if (matched.length === 0) {
      if (budget.required) {
        rows.push({ id: budget.id, file: label, status: 'MISSING' });
        problems.push(`${budget.id}: required file not found (${budget.files.join(', ')})`);
      } else {
        rows.push({ id: budget.id, file: label, status: 'skipped (absent)' });
      }
      continue;
    }
    const measured = matched.map((file) => {
      const raw = readFileSync(path.join(buildDir, file));
      return { file, raw: raw.length, gzip: gzipSync(raw, { level: 9 }).length };
    });
    const groups = budget.aggregate
      ? [{ label: summarize(matched, opts.verbose), items: measured }]
      : measured.map((m) => ({ label: m.file, items: [m] }));
    for (const group of groups) {
      const raw = group.items.reduce((sum, m) => sum + m.raw, 0);
      const gzip = group.items.reduce((sum, m) => sum + m.gzip, 0);
      const over = gzip > budget.maxGzipBytes;
      rows.push({
        id: budget.id,
        file: group.label,
        raw,
        gzip,
        max: budget.maxGzipBytes,
        status: over ? 'OVER BUDGET' : 'ok',
      });
      if (over) {
        problems.push(
          `${budget.id}: ${group.label} is ${kb(gzip)} gzipped, budget ${kb(budget.maxGzipBytes)} ` +
            `(over by ${gzip - budget.maxGzipBytes} bytes)`,
        );
      }
    }
  }

  console.log(`Bundle size budgets (gzip level 9) in ${path.relative(root, buildDir) || '.'}\n`);
  const header = ['budget', 'file', 'raw', 'gzip', 'max', 'status'];
  const table = rows.map((r) => [
    r.id,
    r.file,
    r.raw === undefined ? '-' : kb(r.raw),
    r.gzip === undefined ? '-' : kb(r.gzip),
    r.max === undefined ? '-' : kb(r.max),
    r.status,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i].length)));
  const fmt = (row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  console.log(fmt(header));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of table) console.log(fmt(row));

  if (problems.length > 0) {
    console.error(`\nFAILED (${problems.length}):`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }
  console.log('\nOK: all content-script budgets hold.');
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 2;
}
