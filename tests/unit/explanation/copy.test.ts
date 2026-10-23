// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyPlainText } from '../../../components/explanation/copy';

// Source of the whole card, read as text: the fallback must not exist in any form.
const sources = import.meta.glob<string>(
  ['../../../components/explanation/*.{ts,tsx}', '../../../entrypoints/explain-card.ts'],
  { query: '?raw', import: 'default', eager: true },
);

afterEach(() => {
  vi.restoreAllMocks();
  delete (window.navigator as unknown as Record<string, unknown>)['clipboard'];
});

function withClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
}

describe('copyPlainText', () => {
  it('uses the async clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withClipboard(writeText);
    expect(await copyPlainText(document, 'plain text')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('plain text');
  });

  it('reports failure when the clipboard is missing (plain http) and creates nothing in the page', async () => {
    const create = vi.spyOn(document, 'createElement');
    (document as unknown as Record<string, unknown>)['execCommand'] = vi.fn(() => true);
    expect(await copyPlainText(document, 'secret answer')).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(document.querySelector('textarea')).toBeNull();
    expect(
      (document as unknown as { execCommand: ReturnType<typeof vi.fn> }).execCommand,
    ).not.toHaveBeenCalled();
    delete (document as unknown as Record<string, unknown>)['execCommand'];
  });

  it('reports failure when the clipboard refuses, and never falls back to a selection or copy event', async () => {
    withClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    const events: string[] = [];
    document.addEventListener('copy', () => events.push('copy'), true);
    const select = vi.spyOn(document, 'getSelection');
    expect(await copyPlainText(document, 'secret answer')).toBe(false);
    expect(events).toEqual([]);
    expect(select).not.toHaveBeenCalled();
  });

  it('has no textarea or execCommand path anywhere in the card source', () => {
    const files = Object.entries(sources).filter(([name]) => !name.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const [name, source] of files) {
      // Comments may explain why; code may not use it.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code, name).not.toMatch(/execCommand|createElement\(\s*['"]textarea|\.select\(\)/);
    }
  });
});
