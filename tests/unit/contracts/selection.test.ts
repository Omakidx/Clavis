import { selectionSnapshotSchema } from '../../../lib/contracts';
import { snapshot } from './fixtures';

describe('selectionSnapshotSchema', () => {
  it('accepts a minimal webpage snapshot', () => {
    expect(selectionSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it('accepts a PDF snapshot with page, context and language hint', () => {
    const result = selectionSnapshotSchema.safeParse(
      snapshot({
        source: 'pdf',
        page: 3,
        contextBefore: 'Before ',
        contextAfter: ' after',
        languageHint: 'en-US',
        kind: 'sentence',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('trims text and accepts exactly 2,000 characters', () => {
    const result = selectionSnapshotSchema.safeParse(snapshot({ text: `  ${'a'.repeat(2000)}  ` }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toHaveLength(2000);
  });

  it('rejects 2,001 characters of text', () => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ text: 'a'.repeat(2001) })).success).toBe(
      false,
    );
  });

  it.each(['', '   ', '\n\t'])('rejects empty or whitespace-only text %j', (text) => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ text })).success).toBe(false);
  });

  it('accepts combined context of exactly 1,000 characters and rejects 1,001', () => {
    const ok = snapshot({ contextBefore: 'a'.repeat(600), contextAfter: 'b'.repeat(400) });
    const tooLong = snapshot({ contextBefore: 'a'.repeat(600), contextAfter: 'b'.repeat(401) });
    expect(selectionSnapshotSchema.safeParse(ok).success).toBe(true);
    const result = selectionSnapshotSchema.safeParse(tooLong);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['contextBefore']);
  });

  it('rejects a single context side longer than 1,000 characters', () => {
    expect(
      selectionSnapshotSchema.safeParse(snapshot({ contextAfter: 'x'.repeat(1001) })).success,
    ).toBe(false);
  });

  it('rejects page on a webpage snapshot', () => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ page: 1 })).success).toBe(false);
  });

  it.each([0, -1, 1.5])('rejects non-positive-integer pdf page %s', (page) => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ source: 'pdf', page })).success).toBe(
      false,
    );
  });

  it.each(['apiKey', 'html', 'cookies', 'url'])('rejects smuggled unknown key %s', (key) => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ [key]: 'x' })).success).toBe(false);
  });

  it('rejects a non-UUID selectionId, bad enum values and bad language hints', () => {
    expect(selectionSnapshotSchema.safeParse(snapshot({ selectionId: 'abc' })).success).toBe(false);
    expect(selectionSnapshotSchema.safeParse(snapshot({ source: 'file' })).success).toBe(false);
    expect(selectionSnapshotSchema.safeParse(snapshot({ kind: 'paragraph' })).success).toBe(false);
    expect(selectionSnapshotSchema.safeParse(snapshot({ languageHint: 'en US' })).success).toBe(
      false,
    );
    expect(
      selectionSnapshotSchema.safeParse(snapshot({ languageHint: 'x'.repeat(40) })).success,
    ).toBe(false);
  });

  it('accepts HTML-looking text as plain text (validation is not sanitization)', () => {
    const text = '<img src=x onerror=alert(1)> **bold** [link](javascript:alert(1))';
    const result = selectionSnapshotSchema.safeParse(snapshot({ text }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.text).toBe(text);
  });

  it('rejects non-object input without throwing', () => {
    for (const input of [null, undefined, 'text', 42, []]) {
      expect(selectionSnapshotSchema.safeParse(input).success).toBe(false);
    }
  });
});
