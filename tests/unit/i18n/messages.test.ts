import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import rawCatalog from '../../../public/_locales/en/messages.json';
import { t } from '../../../lib/i18n';

const catalog: Record<string, { message?: unknown; description?: unknown }> = rawCatalog;

// Source of every t('...') call site, read as text so no Node typings are needed.
const sources = import.meta.glob<string>(
  ['../../../entrypoints/**/*.{ts,tsx}', '../../../components/**/*.{ts,tsx}'],
  { query: '?raw', import: 'default', eager: true },
);

// requirements.md section 4.1 "Approved disclosure copy".
const DISCLOSURE_KEYS = [
  'disclosureTitle',
  'disclosureSelect',
  'disclosureListen',
  'disclosureExplain',
  'disclosurePdf',
  'disclosureNoServer',
  'disclosureAccept',
  'firstSendBody',
  'firstSendConfirm',
  'firstSendCancel',
  'siteAccessTitle',
  'siteAccessBody',
  'siteAccessGrant',
  'siteAccessSkip',
  'keyStoreLocal',
  'keyStoreSession',
  'keyWarning',
];

describe('messages.json catalog', () => {
  it('gives every message a non-empty message and description', () => {
    for (const [key, entry] of Object.entries(catalog)) {
      expect(typeof entry.message, `${key}.message`).toBe('string');
      expect((entry.message as string).trim(), `${key}.message`).not.toBe('');
      expect(typeof entry.description, `${key}.description`).toBe('string');
      expect((entry.description as string).trim(), `${key}.description`).not.toBe('');
    }
  });

  it('contains all 17 approved disclosure keys', () => {
    expect(DISCLOSURE_KEYS).toHaveLength(17);
    for (const key of DISCLOSURE_KEYS) {
      expect(catalog, key).toHaveProperty(key);
    }
  });

  it('keeps extName and extDescription for the manifest', () => {
    expect(catalog).toHaveProperty('extName');
    expect(catalog).toHaveProperty('extDescription');
  });

  it('defines every key referenced via t() in entrypoints and components', () => {
    const referenced = new Set<string>();
    for (const source of Object.values(sources)) {
      for (const match of source.matchAll(/\bt\(\s*['"]([A-Za-z0-9_]+)['"]/g)) {
        referenced.add(match[1] as string);
      }
    }
    expect(referenced.size).toBeGreaterThan(0);
    for (const key of referenced) {
      expect(catalog, `t('${key}') is not defined in messages.json`).toHaveProperty(key);
    }
  });
});

describe('t()', () => {
  it('returns the localized message from browser.i18n', () => {
    const spy = vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('Hello');
    expect(t('extName')).toBe('Hello');
    expect(spy).toHaveBeenCalledWith('extName', undefined);
  });

  it('returns a visible marker in dev when the browser has no message', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('');
    expect(t('extName')).toContain('extName');
  });
});
