import { describe, expect, it } from 'vitest';
import rawCatalog from '../../../public/_locales/en/messages.json';

// Phase 8 placeholder sweep: a message nothing refers to is a leftover (a "coming soon" line, a
// spike diagnostic, a state that no longer exists). Every key must be referenced from code, from
// the manifest (`__MSG_key__`), or from the speech/site-access modules that pick keys at run time.
const sources = import.meta.glob<string>(
  [
    '../../../entrypoints/**/*.{ts,tsx}',
    '../../../components/**/*.{ts,tsx}',
    '../../../lib/**/*.ts',
    '../../../wxt.config.ts',
  ],
  { query: '?raw', import: 'default', eager: true },
);

describe('messages.json', () => {
  it('has no key that nothing uses', () => {
    const text = Object.values(sources).join('\n');
    const unused = Object.keys(rawCatalog).filter(
      (key) => !new RegExp(`(?<![A-Za-z0-9])${key}(?![A-Za-z0-9])`).test(text),
    );
    expect(unused).toEqual([]);
  });
});
