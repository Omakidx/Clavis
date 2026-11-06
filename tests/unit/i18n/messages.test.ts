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

  it('keeps the approved disclosure copy verbatim (D-16)', () => {
    // requirements.md section 4.1 "Approved disclosure copy". Do not weaken these.
    const approved: Record<string, string> = {
      disclosureTitle: 'Your reading stays on your device until you ask',
      disclosureSelect:
        'Selecting text does nothing by itself. Clavis notices the selection on your device and shows its toolbar.',
      disclosureListen:
        'Listen tries a matching on-device voice first, then an online voice if needed. Online voices send the selected text to their provider. Nothing is sent to Groq.',
      disclosureExplain:
        'Explain sends the text you selected, up to 1,000 characters of the text around it, and your chosen language to Groq, using your own API key. Groq handles it under its own terms and privacy policy.',
      disclosurePdf:
        'PDFs you open are read inside your browser and never uploaded. Selected text can be sent when you ask for an explanation or use an online voice.',
      disclosureNoServer: 'Clavis has no server of its own and collects no data about you.',
      disclosureAccept: 'I understand',
      firstSendBody:
        "Send this to Groq? Clavis will send the selected text and a little of the text around it to Groq to explain it. You'll only be asked once.",
      firstSendConfirm: 'Lookup',
      firstSendCancel: 'Cancel',
      siteAccessTitle: 'Show Clavis when you select text',
      siteAccessBody:
        'To show the toolbar automatically, Chrome will ask you to let Clavis read and change data on websites. Clavis uses this only to notice when you select text and to show its toolbar. It does not read pages in the background. Text leaves your device only when you ask for an explanation or use an online voice.',
      siteAccessGrant: 'Enable on websites',
      siteAccessSkip: "Not now — I'll use right-click instead",
      keyStoreLocal:
        "Remember on this device — Saved in Chrome's extension storage on this computer until you remove it. It is not encrypted: anyone with access to your Chrome profile could find it.",
      keyStoreSession:
        "Only for this session — Kept in memory and cleared when you close Chrome. You'll paste it again next time.",
      keyWarning: 'Never paste your key into a website or share it in a chat.',
    };
    expect(Object.keys(approved).sort()).toEqual([...DISCLOSURE_KEYS].sort());
    for (const [key, message] of Object.entries(approved)) {
      expect(catalog[key]?.message, key).toBe(message);
    }
  });

  it('never claims the key is encrypted or in a vault (FR-071)', () => {
    const storageCopy = [catalog['keyStoreLocal'], catalog['keyNotEncrypted']]
      .map((entry) => String(entry?.message))
      .join(' ');
    expect(storageCopy).toMatch(/not encrypted|does not encrypt/);
    for (const entry of Object.values(catalog)) {
      expect(String(entry.message)).not.toMatch(/\b(is|are|stays?) encrypted\b|\bsecure vault\b/i);
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
