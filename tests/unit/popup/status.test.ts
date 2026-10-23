import { describe, expect, it } from 'vitest';
import { GROQ_STATUS, isPdfTabUrl } from '../../../entrypoints/popup/status';

describe('isPdfTabUrl', () => {
  it.each([
    'https://example.com/a.pdf',
    'http://example.com/papers/Report.PDF',
    'https://example.com/a.pdf?download=1#page=2',
    'https://example.com/My%20File.pdf',
    'file:///home/me/doc.pdf',
  ])('recognises %s', (url) => {
    expect(isPdfTabUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'not a url',
    'https://example.com/',
    'https://example.com/a.pdf/view',
    'https://example.com/?file=a.pdf',
    'https://example.com/a.pdfx',
    'chrome-extension://abc/reader.html',
    'chrome://extensions/a.pdf',
    'https://example.com/%E0%A4%A.pdf',
  ])('does not mistake %s for a PDF', (url) => {
    expect(isPdfTabUrl(url)).toBe(false);
  });
});

describe('GROQ_STATUS', () => {
  it('explains every state that is not ready, and says nothing when it is', () => {
    expect(GROQ_STATUS.ready.notice).toEqual([]);
    for (const [state, view] of Object.entries(GROQ_STATUS)) {
      if (state !== 'ready') expect(view.notice.length, state).toBeGreaterThan(0);
    }
  });

  it('offers a fix only where there is one', () => {
    expect(GROQ_STATUS.setup_required.action).toBe('connect');
    expect(GROQ_STATUS.invalid_key.action).toBe('update-key');
    expect(GROQ_STATUS.storage_unavailable.action).toBe('none');
  });
});
