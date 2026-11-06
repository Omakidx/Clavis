import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import rawCatalog from '../../../public/_locales/en/messages.json';

// Phase 8 placeholder sweep: a message nothing refers to is a leftover (a "coming soon" line, a
// spike diagnostic, a state that no longer exists). Every key must be referenced from code, from
// the manifest (`__MSG_key__`), or from the speech/site-access modules that pick keys at run time.
// Read maintained source directly so the inventory includes newly added components.
const root = fileURLToPath(new URL('../../../', import.meta.url));
const sources = ['entrypoints', 'components', 'lib'].flatMap((directory) => {
  const base = join(root, directory);
  return readdirSync(base, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => readFileSync(join(base, file), 'utf8'));
});
sources.push(readFileSync(join(root, 'wxt.config.ts'), 'utf8'));

describe('messages.json', () => {
  it('has no key that nothing uses', () => {
    const text = sources.join('\n');
    const unused = Object.keys(rawCatalog).filter(
      (key) => !new RegExp(`(?<![A-Za-z0-9])${key}(?![A-Za-z0-9])`).test(text),
    );
    expect(unused).toEqual([]);
  });
});
