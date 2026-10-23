import { describe, expect, it } from 'vitest';
import {
  commandForKey,
  type KeyEventLike,
  type ReaderCommand,
  type ShortcutContext,
} from '../../../lib/pdf/shortcuts';

const key = (k: string, over: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});
const ctx = (over: Partial<ShortcutContext> = {}): ShortcutContext => ({
  hasDocument: true,
  findOpen: false,
  editable: false,
  inFindBar: false,
  ...over,
});

describe('reader shortcuts', () => {
  it.each<[string, ReaderCommand]>([
    ['PageDown', 'scroll-down'],
    ['PageUp', 'scroll-up'],
    ['Home', 'scroll-start'],
    ['End', 'scroll-end'],
    ['n', 'next-page'],
    ['j', 'next-page'],
    ['p', 'previous-page'],
    ['k', 'previous-page'],
    ['+', 'zoom-in'],
    ['=', 'zoom-in'],
    ['-', 'zoom-out'],
    ['_', 'zoom-out'],
    ['0', 'zoom-actual'],
  ])('%s -> %s', (k, command) => {
    expect(commandForKey(key(k), ctx())).toBe(command);
  });

  it('maps Ctrl/Cmd+Home and +End to the first and last page', () => {
    expect(commandForKey(key('Home', { ctrlKey: true }), ctx())).toBe('first-page');
    expect(commandForKey(key('End', { metaKey: true }), ctx())).toBe('last-page');
  });

  it('does nothing when no document is open, so Chrome keeps Ctrl+F', () => {
    expect(commandForKey(key('f', { ctrlKey: true }), ctx({ hasDocument: false }))).toBeNull();
    expect(commandForKey(key('n'), ctx({ hasDocument: false }))).toBeNull();
    expect(commandForKey(key('PageDown'), ctx({ hasDocument: false }))).toBeNull();
  });

  it('opens find on Ctrl+F and Cmd+F, from anywhere including the find box and text fields', () => {
    expect(commandForKey(key('f', { ctrlKey: true }), ctx())).toBe('open-find');
    expect(commandForKey(key('F', { metaKey: true }), ctx())).toBe('open-find');
    expect(commandForKey(key('f', { ctrlKey: true }), ctx({ editable: true }))).toBe('open-find');
    expect(
      commandForKey(key('f', { ctrlKey: true }), ctx({ findOpen: true, inFindBar: true })),
    ).toBe('open-find');
    // Ctrl+Alt+F is something else.
    expect(commandForKey(key('f', { ctrlKey: true, altKey: true }), ctx())).toBeNull();
  });

  it('never acts on plain keys while typing in a field', () => {
    for (const k of ['n', 'p', '+', '-', '0', 'PageDown', 'Home', 'End']) {
      expect(commandForKey(key(k), ctx({ editable: true })), k).toBeNull();
    }
  });

  it('leaves other Ctrl/Cmd/Alt shortcuts to the browser', () => {
    for (const k of ['n', 'p', '+', '-', '0', 'PageDown']) {
      expect(commandForKey(key(k, { ctrlKey: true }), ctx()), `ctrl+${k}`).toBeNull();
      expect(commandForKey(key(k, { metaKey: true }), ctx()), `meta+${k}`).toBeNull();
      expect(commandForKey(key(k, { altKey: true }), ctx()), `alt+${k}`).toBeNull();
    }
  });

  it('leaves Shift+PageDown/Home/End to text selection', () => {
    for (const k of ['PageDown', 'PageUp', 'Home', 'End']) {
      expect(commandForKey(key(k, { shiftKey: true }), ctx()), k).toBeNull();
    }
  });

  describe('find bar', () => {
    it('closes on Escape only from inside the open bar', () => {
      expect(commandForKey(key('Escape'), ctx({ findOpen: true, inFindBar: true }))).toBe(
        'close-find',
      );
      expect(commandForKey(key('Escape'), ctx({ findOpen: true, inFindBar: false }))).toBeNull();
      expect(commandForKey(key('Escape'), ctx({ findOpen: false, inFindBar: true }))).toBeNull();
    });

    it('steps with F3 / Ctrl+G (Shift reverses) while the bar is open, even in the box', () => {
      const open = ctx({ findOpen: true, editable: true, inFindBar: true });
      expect(commandForKey(key('F3'), open)).toBe('find-next');
      expect(commandForKey(key('F3', { shiftKey: true }), open)).toBe('find-previous');
      expect(commandForKey(key('g', { ctrlKey: true }), open)).toBe('find-next');
      expect(commandForKey(key('G', { metaKey: true, shiftKey: true }), open)).toBe(
        'find-previous',
      );
      expect(commandForKey(key('F3'), ctx({ findOpen: false }))).toBeNull();
    });
  });
});
