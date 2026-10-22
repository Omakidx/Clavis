// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { extractContext, findContextScope } from '../../../lib/selection/context';
import { mockLayout, selectText, setBody } from './dom';

beforeEach(() => mockLayout());
afterEach(() => {
  delete (Element.prototype as { checkVisibility?: unknown }).checkVisibility;
});

describe('extractContext', () => {
  it('returns the text before and after the selection within the same paragraph', () => {
    setBody('<p>The old bank by the river was closed. It reopened in spring.</p>');
    const range = selectText('bank');
    expect(extractContext(range)).toEqual({
      before: 'The old',
      after: 'by the river was closed. It reopened in spring.',
    });
  });

  it('does not add spaces inside words split by inline markup', () => {
    setBody('<p>The <b>ban</b>kers met <i>to</i>day and <span>decided</span> nothing.</p>');
    const range = selectText('met');
    const { before, after } = extractContext(range);
    expect(before).toBe('The bankers');
    expect(after).toBe('today and decided nothing.');
  });

  it('keeps context inside the nearest block and never reads neighbouring blocks', () => {
    setBody('<div><p>First paragraph text.</p><p>Second one here.</p><p>Third.</p></div>');
    const range = selectText('one');
    const { before, after } = extractContext(range);
    expect(before).toBe('Second');
    expect(after).toBe('here.');
    expect(findContextScope(range).tagName).toBe('P');
  });

  it('joins text across blocks with a space when the selection spans blocks', () => {
    setBody('<article><p>Alpha beta.</p><p>Gamma delta.</p></article>');
    const range = document.createRange();
    range.setStart(document.body.querySelector('p')!.firstChild!, 6);
    range.setEnd(document.body.querySelectorAll('p')[1]!.firstChild!, 5);
    const { before, after } = extractContext(range);
    expect(before).toBe('Alpha');
    expect(after).toBe('delta.');
  });

  it('skips scripts, styles, forms, navigation, buttons and hidden text', () => {
    setBody(
      '<div>Visible before <script>var secret = 1;</script><style>.a{}</style>' +
        '<nav>Home About</nav><form>Name: <input value="x"></form><button>Buy</button>' +
        '<span hidden>hidden text</span><span aria-hidden="true">aria text</span> ' +
        '<b id="t">target</b> after<noscript>no script</noscript> visible after</div>',
    );
    const range = selectText('target');
    const { before, after } = extractContext(range);
    expect(before).toBe('Visible before');
    expect(after).toBe('after visible after');
  });

  it('never exceeds the combined context limit, even for huge blocks', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(5000);
    setBody(`<p>${filler}TARGET${filler}</p>`);
    const range = selectText('TARGET');
    const { before, after } = extractContext(range);
    expect(before.length + after.length).toBeLessThanOrEqual(LIMITS.maxContextChars);
    expect(before.length).toBeGreaterThan(300);
    expect(after.length).toBeGreaterThan(300);
  });

  it('starts and ends on word boundaries when it has to cut', () => {
    const words = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    setBody(`<p>${words} TARGET ${words}</p>`);
    const { before, after } = extractContext(selectText('TARGET'));
    expect(before.startsWith('word')).toBe(true);
    expect(after.split(' ').at(-1)).toMatch(/^word\d+$/);
  });

  it('stays cheap on pages made of thousands of tiny hidden nodes', () => {
    const hidden = '<span hidden>x</span>'.repeat(20000);
    setBody(`<div>${hidden}<b id="t">target</b></div>`);
    const started = performance.now();
    const { before } = extractContext(selectText('target'));
    expect(performance.now() - started).toBeLessThan(250);
    expect(before).toBe('');
  });

  it('works for a selection whose boundaries are elements, not text nodes', () => {
    setBody('<p>Before <b>bold</b> after</p>');
    const p = document.body.querySelector('p')!;
    const range = document.createRange();
    range.setStart(p, 1);
    range.setEnd(p, 2);
    expect(extractContext(range)).toEqual({ before: 'Before', after: 'after' });
  });

  it('returns empty context for a selection that fills its block', () => {
    setBody('<p>Only this</p>');
    const range = document.createRange();
    range.selectNodeContents(document.body.querySelector('p')!);
    expect(extractContext(range)).toEqual({ before: '', after: '' });
  });
});

describe('extractContext skips text a reader cannot see (security review LOW-4)', () => {
  /** A paragraph with one visible sentence on each side and the given hidden fragment before the target. */
  function context(hidden: string): { before: string; after: string } {
    setBody(
      `<p>Visible before. ${hidden} <b id="t">target</b> hidden-after-marker visible after.</p>`,
    );
    return extractContext(selectText('target'));
  }

  it.each([
    ['opacity:0', '<span style="opacity:0">SECRET</span>'],
    ['an ancestor with opacity:0', '<span style="opacity:0"><i>SECRET</i></span>'],
    ['visibility:hidden', '<span style="visibility:hidden">SECRET</span>'],
    ['display:none', '<span style="display:none">SECRET</span>'],
    ['font-size:0 (no boxes)', '<span style="font-size:0" data-rect="none">SECRET</span>'],
    ['transparent text', '<span data-style=\'{"color":"rgba(0, 0, 0, 0)"}\'>SECRET</span>'],
    [
      'clip: rect(0 0 0 0)',
      '<span data-style=\'{"clip":"rect(0px, 0px, 0px, 0px)"}\'>SECRET</span>',
    ],
    ['clip-path: inset(100%)', '<span data-style=\'{"clipPath":"inset(100%)"}\'>SECRET</span>'],
    ['left:-9999px positioning', '<span data-rect="-10000,0,-9900,20">SECRET</span>'],
    ['text-indent:-9999px (above the page)', '<span data-rect="0,-500,100,-480">SECRET</span>'],
    [
      'a 1px overflow:hidden box (screen-reader-only idiom)',
      '<span style="overflow:hidden" data-box="0,0,1,1"><i>SECRET</i></span>',
    ],
    [
      'an overflow:hidden box the text lies completely outside of',
      '<span style="overflow:hidden" data-box="0,0,50,20"><i data-rect="500,0,600,20">SECRET</i></span>',
    ],
  ])('does not leak text hidden with %s', (_name, hidden) => {
    const { before, after } = context(hidden);
    expect(before).toBe('Visible before.');
    expect(`${before} ${after}`).not.toContain('SECRET');
    expect(after).toBe('hidden-after-marker visible after.');
  });

  it('keeps text in an overflow:auto scroller that is merely scrolled out of view', () => {
    const { before } = context(
      '<span style="overflow:auto" data-box="0,0,50,20"><i data-rect="500,0,600,20">SCROLLED</i></span>',
    );
    expect(before).toContain('SCROLLED');
  });

  it('keeps ordinary visible text', () => {
    expect(context('<span>FINE</span>').before).toBe('Visible before. FINE');
  });

  it('asks checkVisibility for opacity, visibility and content-visibility (every option spelling)', () => {
    const calls: object[] = [];
    (Element.prototype as { checkVisibility?: unknown }).checkVisibility = vi.fn(function (
      this: Element,
      options: object,
    ) {
      calls.push(options);
      return !this.hasAttribute('data-cv-hidden');
    });
    const { before } = context('<span data-cv-hidden>SECRET</span>');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toMatchObject({
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
    expect(before).toBe('Visible before.');
  });
});
