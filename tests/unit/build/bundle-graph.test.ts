import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
// @ts-expect-error The build gate is a plain Node ESM script without TypeScript declarations.
import { createBundleGraph } from '../../../scripts/bundle-graph.mjs';

const directories: string[] = [];

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(tmpdir(), 'clavis-bundle-graph-'));
  directories.push(dir);
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(dir, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  return createBundleGraph(dir);
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('built JavaScript static import graph', () => {
  it('follows renamed and transitive chunks without depending on their names', async () => {
    const graph = fixture({
      'chunks/reader-X7.js': 'import "./shared-Z2.js";',
      'chunks/shared-Z2.js': 'export { value } from "./dependency-A9.js";',
      'chunks/dependency-A9.js': 'export const value = 1;',
    });
    expect(await graph.staticClosure(['chunks/reader-X7.js'])).toEqual([
      'chunks/dependency-A9.js',
      'chunks/reader-X7.js',
      'chunks/shared-Z2.js',
    ]);
  });

  it('deduplicates shared chunks and excludes startup chunks from lazy UI', async () => {
    const graph = fixture({
      'chunks/reader.js': 'import "./shared.js";',
      'chunks/toolbar.js': 'import "./shared.js"; import "./lazy.js";',
      'chunks/explanation.js': 'import "./shared.js"; import "./lazy.js";',
      'chunks/shared.js': 'export const shared = 1;',
      'chunks/lazy.js': 'export const lazy = 1;',
    });
    const startup = new Set(await graph.staticClosure(['chunks/reader.js']));
    const lazy = await graph.staticClosure(['chunks/toolbar.js', 'chunks/explanation.js']);
    expect(lazy.filter((file: string) => !startup.has(file))).toEqual([
      'chunks/explanation.js',
      'chunks/lazy.js',
      'chunks/toolbar.js',
    ]);
  });

  it('handles static import cycles once', async () => {
    const graph = fixture({
      'chunks/a.js': 'import "./b.js";',
      'chunks/b.js': 'import "./a.js";',
    });
    expect(await graph.staticClosure(['chunks/a.js'])).toEqual(['chunks/a.js', 'chunks/b.js']);
  });

  it('ignores dynamic imports and import.meta references', async () => {
    const graph = fixture({
      'chunks/reader.js': 'import "./startup.js"; import("./pdf.js"); import.meta.url;',
      'chunks/startup.js': 'export const startup = 1;',
    });
    expect(await graph.staticClosure(['chunks/reader.js'])).toEqual([
      'chunks/reader.js',
      'chunks/startup.js',
    ]);
  });

  it('fails when a local static import is missing', async () => {
    const graph = fixture({ 'chunks/reader.js': 'import "./missing.js";' });
    await expect(graph.staticClosure(['chunks/reader.js'])).rejects.toThrow(
      'chunks/reader.js: static import is missing: ./missing.js',
    );
  });

  it('rejects static imports outside the build directory', async () => {
    const graph = fixture({ 'chunks/reader.js': 'import "../../outside.js";' });
    await expect(graph.staticClosure(['chunks/reader.js'])).rejects.toThrow(
      'chunks/reader.js: static import escapes build directory: ../../outside.js',
    );
  });

  it('charges shared imports to startup only in the size gate', () => {
    const reader = 'import "./shared.js";';
    const toolbar = 'import "./shared.js"; export const toolbar = 1;';
    const shared = 'export const shared = 1;';
    fixture({
      'chunks/reader-A.js': reader,
      'chunks/toolbar-B.js': toolbar,
      'chunks/shared.js': shared,
    });
    const dir = directories.at(-1)!;
    const budgets = path.join(dir, 'budgets.json');
    writeFileSync(
      budgets,
      JSON.stringify({
        buildDir: dir,
        budgets: [
          {
            id: 'startup',
            files: ['chunks/reader-*.js'],
            includeStaticImports: true,
            aggregate: true,
            maxGzipBytes: 10000,
            required: true,
          },
          {
            id: 'lazy',
            files: ['chunks/toolbar-*.js'],
            includeStaticImports: true,
            excludeStaticImportsOf: ['chunks/reader-*.js'],
            aggregate: true,
            maxGzipBytes: gzipSync(toolbar, { level: 9 }).length,
            required: true,
          },
        ],
      }),
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/check-bundle-size.mjs', '--budgets', budgets],
      {
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: all content-script budgets hold.');
  });
});
