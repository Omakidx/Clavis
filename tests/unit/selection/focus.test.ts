// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownsFocus } from '../../../lib/selection/focus';
import { setBody } from './dom';

afterEach(() => vi.restoreAllMocks());

describe('ownsFocus (which frame reacts to the shortcut)', () => {
  it('a frame whose document has focus owns it, top frame or not', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(ownsFocus(document, true)).toBe(true);
    expect(ownsFocus(document, false)).toBe(true);
  });

  it('a child frame without focus does not take it', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(ownsFocus(document, false)).toBe(false);
  });

  it('with no focused frame (focus in the browser UI) the top frame takes it', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    setBody('<p>text</p>');
    expect(ownsFocus(document, true)).toBe(true);
  });

  it('a frame whose focused element is a child frame never owns focus, even though hasFocus is true for it', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    setBody('<iframe id="f"></iframe>');
    (document.getElementById('f') as HTMLElement).focus();
    expect(document.activeElement?.localName).toBe('iframe');
    expect(ownsFocus(document, true)).toBe(false);
  });
});
