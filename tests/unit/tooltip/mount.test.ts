// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isInsideComposed, modalDialogOf } from '../../../components/tooltip/mount';
import { setBody } from '../selection/dom';

/** jsdom has no `:modal`: treat a dialog as modal when it carries `data-modal`. */
function stubModal(): void {
  const matches = Element.prototype.matches;
  vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    return selector === ':modal' ? this.hasAttribute('data-modal') : matches.call(this, selector);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('modalDialogOf (where the toolbar host is mounted)', () => {
  it('finds the modal dialog around a text node', () => {
    stubModal();
    setBody('<dialog open data-modal><p>Inside <b>text</b></p></dialog><p id="out">Outside</p>');
    const text = document.querySelector('b')!.firstChild;
    expect(modalDialogOf(text)).toBe(document.querySelector('dialog'));
    expect(modalDialogOf(document.getElementById('out')!.firstChild)).toBeNull();
  });

  it('ignores a dialog that is not modal (it does not make the page inert)', () => {
    stubModal();
    setBody('<dialog open><p>Inside</p></dialog>');
    expect(modalDialogOf(document.querySelector('p'))).toBeNull();
  });

  it('looks through shadow roots: a selection in a web component inside the dialog', () => {
    stubModal();
    setBody('<dialog open data-modal><div id="host"></div></dialog>');
    const root = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    span.textContent = 'inside shadow';
    root.append(span);
    expect(modalDialogOf(span.firstChild)).toBe(document.querySelector('dialog'));
  });

  it('picks the innermost modal dialog of nested ones', () => {
    stubModal();
    setBody('<dialog data-modal><dialog data-modal id="inner"><p>x</p></dialog></dialog>');
    expect(modalDialogOf(document.querySelector('p'))?.id).toBe('inner');
  });

  it('returns null for no node, and survives a browser without :modal', () => {
    expect(modalDialogOf(null)).toBeNull();
    setBody('<dialog open><p>Inside</p></dialog>');
    // jsdom throws a SyntaxError for the unknown pseudo-class: that must read as "not modal".
    expect(modalDialogOf(document.querySelector('p'))).toBeNull();
  });
});

describe('isInsideComposed', () => {
  it('is true for the node itself, its descendants and shadow content, false otherwise', () => {
    setBody('<aside id="a"><div id="host"></div></aside><p id="p">x</p>');
    const aside = document.getElementById('a') as HTMLElement;
    const root = (document.getElementById('host') as HTMLElement).attachShadow({ mode: 'open' });
    const span = document.createElement('span');
    root.append(span);
    expect(isInsideComposed(aside, aside)).toBe(true);
    expect(isInsideComposed(span, aside)).toBe(true);
    expect(isInsideComposed(document.getElementById('p'), aside)).toBe(false);
    expect(isInsideComposed(null, aside)).toBe(false);
  });
});
