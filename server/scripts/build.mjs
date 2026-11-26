// Bundles src/index.ts and src/migrate.ts into dist/ (design §9). shared/ sits outside this package,
// so every `zod` import (including shared/api-contract's) is forced to THIS package's copy.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
rmSync(path.join(root, 'dist'), { recursive: true, force: true });

const pinZod = {
  name: 'pin-zod',
  setup(b) {
    b.onResolve({ filter: /^zod(\/.*)?$/ }, (args) => {
      if (args.pluginData === 'pin-zod') return undefined; // our own re-resolve: use the default resolver
      return b.resolve(args.path, { kind: args.kind, resolveDir: root, pluginData: 'pin-zod' });
    });
  },
};

await build({
  entryPoints: {
    index: path.join(root, 'src/index.ts'),
    migrate: path.join(root, 'src/migrate.ts'),
  },
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  nodePaths: [path.join(root, 'node_modules')],
  external: ['pg-native'],
  plugins: [pinZod],
  // CommonJS dependencies (pg, pino) call require() inside the ESM bundle.
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
});
