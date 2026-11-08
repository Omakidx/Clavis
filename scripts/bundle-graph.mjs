// Resolve the static JavaScript imports emitted by Vite. Dynamic imports are
// intentionally excluded: they belong to the feature that loads them later.
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { init, parse } from 'es-module-lexer';

export function createBundleGraph(buildDir) {
  const base = path.resolve(buildDir);
  const importsByFile = new Map();

  function resolveImport(importer, specifier) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
    const clean = specifier.split(/[?#]/, 1)[0];
    const target = path.resolve(
      clean.startsWith('/') ? base : path.dirname(path.join(base, importer)),
      clean.replace(/^\//, ''),
    );
    const relative = path.relative(base, target).split(path.sep).join('/');
    if (relative.startsWith('../') || relative === '..' || path.isAbsolute(relative))
      throw new Error(`${importer}: static import escapes build directory: ${specifier}`);
    try {
      if (!statSync(target).isFile()) throw new Error('not a file');
    } catch {
      throw new Error(`${importer}: static import is missing: ${specifier}`);
    }
    return relative;
  }

  async function importsOf(file) {
    if (importsByFile.has(file)) return importsByFile.get(file);
    await init;
    const source = readFileSync(path.join(base, file), 'utf8');
    const [records] = parse(source, file);
    const imports = records
      .filter((record) => record.d === -1 && record.n !== undefined)
      .map((record) => resolveImport(file, record.n))
      .filter((target) => target !== null);
    importsByFile.set(file, imports);
    return imports;
  }

  return {
    async staticClosure(roots) {
      const seen = new Set();
      async function visit(file) {
        if (seen.has(file)) return;
        seen.add(file);
        for (const dependency of await importsOf(file)) await visit(dependency);
      }
      for (const root of roots) await visit(root);
      return [...seen].sort();
    },
  };
}
