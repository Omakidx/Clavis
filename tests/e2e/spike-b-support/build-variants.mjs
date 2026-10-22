// Builds the three UI-loading variants of the Spike B toolbar (D-08) from the same source:
//   node tests/e2e/spike-b-support/build-variants.mjs
// Output: .output-spike-b-a, .output-spike-b-b, .output-spike-b-c (git-ignored by `.output-*`)
// plus .output-spike-b (no variable set = variant c, the recommended default) used by the
// functional specs. Run those against another variant with
// CLAVIS_EXTENSION_DIR=.output-spike-b-a/chrome-mv3.
// It prints raw and gzip (level 9) sizes of the always-loaded observer and the lazy UI.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const variants = [
  ['a', '.output-spike-b-a'],
  ['b', '.output-spike-b-b'],
  ['c', '.output-spike-b-c'],
  [undefined, '.output-spike-b'],
];

const kb = (n) => `${(n / 1024).toFixed(2)} KB`;
const rows = [];
for (const [variant, outDir] of variants) {
  execFileSync('npx', ['wxt', 'build'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      WXT_OUT_DIR: outDir,
      ...(variant === undefined ? {} : { VITE_CLAVIS_TOOLBAR_VARIANT: variant }),
    },
  });
  const dir = path.join(outDir, 'chrome-mv3', 'content-scripts');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
    const bytes = readFileSync(path.join(dir, file));
    rows.push({
      build: outDir,
      file: `content-scripts/${file}`,
      raw: kb(statSync(path.join(dir, file)).size),
      gzip: kb(gzipSync(bytes, { level: 9 }).length),
    });
  }
}
console.table(rows);
