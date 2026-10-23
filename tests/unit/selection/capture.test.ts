// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { selectionSnapshotSchema } from '../../../lib/contracts';
import { captureSelection, measureRange, trimCaptured } from '../../../lib/selection/capture';
import { markOwnUi } from '../../../lib/selection/own-ui';
import { clearSelection, mockRangeRects, selectText, setBody } from './dom';

beforeEach(() => mockRangeRects());
afterEach(() => {
  clearSelection();
  document.documentElement.removeAttribute('lang');
  document.documentElement.removeAttribute('dir');
});

describe('captureSelection', () => {
  it('builds a snapshot the contract schema accepts', () => {
    document.documentElement.lang = 'en';
    setBody('<p>The old bank by the river was closed.</p>');
    selectText('bank');
    const captured = captureSelection();
    expect(captured).not.toBeNull();
    const parsed = selectionSnapshotSchema.safeParse(captured?.snapshot);
    expect(parsed.success).toBe(true);
    expect(captured?.snapshot).toMatchObject({
      source: 'webpage',
      kind: 'word',
      text: 'bank',
      contextBefore: 'The old',
      contextAfter: 'by the river was closed.',
      languageHint: 'en',
    });
    expect(captured?.overLimit).toBe(false);
  });

  it('adds no unknown keys (the contract is strict)', () => {
    setBody('<p>Hello there world</p>');
    selectText('there');
    expect(Object.keys(captureSelection()!.snapshot).sort()).toEqual(
      ['contextAfter', 'contextBefore', 'kind', 'selectionId', 'source', 'text'].sort(),
    );
  });

  it('normalizes whitespace in the selected text', () => {
    setBody('<p>one   two\n\n  three</p>');
    selectText('one   two\n\n  three');
    expect(captureSelection()?.snapshot.text).toBe('one two three');
    expect(captureSelection()?.snapshot.kind).toBe('phrase');
  });

  it('reads the language from the nearest lang attribute and drops invalid tags', () => {
    document.documentElement.lang = 'en';
    setBody('<p lang="fr">Le chat</p><p lang="not a tag!">Hello</p>');
    selectText('Le chat');
    expect(captureSelection()?.snapshot.languageHint).toBe('fr');
    selectText('Hello');
    expect(captureSelection()?.snapshot.languageHint).toBeUndefined();
  });

  it('detects right-to-left text direction', () => {
    setBody('<p dir="rtl" style="direction: rtl">كتاب جميل</p>');
    selectText('كتاب');
    expect(captureSelection()?.dir).toBe('rtl');
  });

  it('truncates an over-limit selection to the limit and flags it', () => {
    setBody(`<p>${'abcd '.repeat(2000)}</p>`);
    const range = document.createRange();
    range.selectNodeContents(document.body.querySelector('p')!);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const captured = captureSelection();
    expect(captured?.overLimit).toBe(true);
    expect(captured?.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(captured?.snapshot.kind).toBe('passage');
    expect(selectionSnapshotSchema.safeParse(captured?.snapshot).success).toBe(true);
  });

  it('ignores a collapsed selection and a missing selection', () => {
    setBody('<p>Hello world</p>');
    expect(captureSelection()).toBeNull();
    const range = selectText('Hello');
    range.collapse(true);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    expect(captureSelection()).toBeNull();
  });

  it.each([
    ['textarea', '<textarea id="f">secret words here</textarea>'],
    ['text input', '<input id="f" value="secret words here">'],
    ['password input', '<input id="f" type="password" value="secret words here">'],
    ['contenteditable', '<div id="f" contenteditable="true">secret words here</div>'],
    [
      'contenteditable="plaintext-only"',
      '<div id="f" contenteditable="plaintext-only">secret words here</div>',
    ],
    ['role=textbox (audit M1)', '<div id="f" role="textbox">secret words here</div>'],
    ['role=textbox child', '<div role="textbox"><span id="f">secret words here</span></div>'],
  ])('ignores selections inside a %s', (_name, html) => {
    setBody(`<p>Outside</p>${html}`);
    const field = document.getElementById('f')!;
    if (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA') {
      (field as HTMLInputElement).focus();
      (field as HTMLInputElement).select();
    } else {
      selectText('secret');
    }
    expect(captureSelection()).toBeNull();
  });

  it('allows a selection inside contenteditable="false" islands', () => {
    setBody('<div contenteditable="false"><p id="t">read only words</p></div>');
    selectText('read only');
    expect(captureSelection()).not.toBeNull();
  });

  it('ignores selections that are not rendered', () => {
    setBody('<p>Hello world</p>');
    selectText('Hello');
    mockRangeRects([]);
    expect(captureSelection()).toBeNull();
  });

  it('ignores selections inside Clavis own UI', () => {
    setBody('<div id="own"><span>own text</span></div><p>Page</p>');
    markOwnUi(document.getElementById('own') as Element);
    selectText('own text');
    expect(captureSelection()).toBeNull();
  });

  it('returns rects from the live range for repositioning', () => {
    setBody('<p>Hello world</p>');
    selectText('Hello');
    const captured = captureSelection()!;
    expect(captured.getRects()?.first).toMatchObject({ left: 100, top: 200 });
  });

  it('gives each capture a fresh selectionId', () => {
    setBody('<p>Hello world</p>');
    selectText('Hello');
    const a = captureSelection()!.snapshot.selectionId;
    const b = captureSelection()!.snapshot.selectionId;
    expect(a).not.toBe(b);
  });
});

function selectAll(html: string): void {
  setBody(html);
  const range = document.createRange();
  range.selectNodeContents(document.body.querySelector('p')!);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

describe('measureRange (anchor boxes)', () => {
  it('ignores zero-width boxes such as the start of the next block after a triple-click', () => {
    setBody('<p>Hello world</p>');
    const range = selectText('Hello');
    mockRangeRects([
      { left: 100, top: 200, right: 300, bottom: 220, width: 200, height: 20 },
      { left: 100, top: 240, right: 100, bottom: 260, width: 0, height: 20 },
    ]);
    const rects = measureRange(range);
    expect(rects?.last).toMatchObject({ top: 200, bottom: 220 });
    expect(rects?.bounds.bottom).toBe(220);
  });

  it('falls back to zero-width boxes when nothing else has width (an empty line)', () => {
    setBody('<p>Hello world</p>');
    const range = selectText('Hello');
    mockRangeRects([{ left: 100, top: 200, right: 100, bottom: 220, width: 0, height: 20 }]);
    expect(measureRange(range)).not.toBeNull();
  });
});

describe('over-limit selection and trimCaptured', () => {
  const text = 'abcd '.repeat(2000).trim();

  it('keeps the normalized overflow for the trim and nothing for a normal selection', () => {
    selectAll(`<p>${text}</p>`);
    const captured = captureSelection()!;
    expect(captured.overLimit).toBe(true);
    expect(captured.fullText).toBe(text.slice(0, LIMITS.maxSelectionChars * 4).trim());
    setBody('<p>Hello world</p>');
    selectText('Hello');
    expect(captureSelection()?.fullText).toBeUndefined();
  });

  it('trims to a word boundary, with a new schema-valid snapshot and no contextAfter', () => {
    selectAll(`<p>Intro here. <b>${text}</b> Outro words.</p>`);
    const long = captureSelection();
    // The <p> as a whole is selected; use the bold part so there is context on both sides.
    const range = document.createRange();
    range.selectNodeContents(document.body.querySelector('b')!);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const captured = captureSelection()!;
    expect(long?.overLimit).toBe(true);
    expect(captured.snapshot.contextAfter).toBe('Outro words.');

    const trimmed = trimCaptured(captured);
    expect(trimmed.overLimit).toBe(false);
    expect(trimmed.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(trimmed.snapshot.text.endsWith('abcd')).toBe(true);
    expect(trimmed.snapshot.text.length).toBe(1999);
    expect(trimmed.snapshot.kind).toBe('passage');
    expect(trimmed.snapshot.selectionId).not.toBe(captured.snapshot.selectionId);
    expect(trimmed.snapshot.contextBefore).toBe('Intro here.');
    expect(trimmed.snapshot).not.toHaveProperty('contextAfter');
    expect(selectionSnapshotSchema.safeParse(trimmed.snapshot).success).toBe(true);
    // The range (and so the toolbar's anchor) is the same selection.
    expect(trimmed.range).toBe(captured.range);
    expect(trimmed.getRects()).toEqual(captured.getRects());
    expect(trimmed).not.toHaveProperty('fullText');
  });

  it('carries the language hint and reclassifies the trimmed text', () => {
    document.documentElement.lang = 'en';
    selectAll(`<p>${text}</p>`);
    const trimmed = trimCaptured(captureSelection()!);
    expect(trimmed.snapshot.languageHint).toBe('en');
  });

  it('a selection that is only just over the limit loses at most the last partial word', () => {
    const justOver = `${'word '.repeat(399)}${'x'.repeat(10)}`;
    selectAll(`<p>${justOver}</p>`);
    const captured = captureSelection()!;
    expect(captured.overLimit).toBe(true);
    const trimmed = trimCaptured(captured);
    expect(trimmed.snapshot.text).toBe('word '.repeat(399).trim());
  });
});
