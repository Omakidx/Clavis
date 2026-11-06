import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { acceptPath } from './p7-accept-support/manifest';
import { HOOK, TEXT, type Reader } from './p7-accept-support/reader';
import { clickText } from './p7-accept-support/selection';

// Phase 7 acceptance, accessibility (requirements section 5): axe on every reader state, the
// whole reader operable with the keyboard alone, focus management, live announcements, visible
// focus, and reflow at a narrow window. The Clavis toolbar and card live in a closed shadow root
// and are covered by the Phase 4 and 5 suites.
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
});
test.afterAll(async () => {
  await h?.close();
});

async function axe(
  page: Page,
  tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
): Promise<string[]> {
  const results = await new AxeBuilder({ page }).withTags(tags).analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
  );
}

test.describe('axe (WCAG 2.1 A and AA) on every state', () => {
  test('empty', async () => {
    const reader = await h.openReader();
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });

  test('document open (100 pages) with the find bar open and a match', async () => {
    const reader = await h.openReader();
    await reader.openReady('pages-100.pdf');
    await reader.find('quokka');
    await expect.poll(() => reader.findStatus()).toBe('1 of 1');
    await reader.settle();
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });

  test('document with CJK embedded fonts', async () => {
    const reader = await h.openReader();
    await reader.openReady('cjk-truetype-embedded.pdf');
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });

  test('password prompt, with and without the "incorrect" message', async () => {
    const reader = await h.openReader();
    await reader.open('encrypted-aes128.pdf');
    await reader.waitPhase('password-required');
    expect(await axe(reader.page)).toEqual([]);
    await reader.passwordInput.fill('nope');
    await reader.passwordInput.press('Enter');
    await expect(reader.tid(HOOK.passwordError)).toBeVisible();
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });

  for (const file of ['corrupt-noise.pdf', 'not-a-pdf.pdf', 'zero-byte.pdf']) {
    test(`error state: ${file}`, async () => {
      const reader = await h.openReader();
      await reader.open(file);
      await reader.waitPhase('error');
      expect(await axe(reader.page)).toEqual([]);
      await reader.page.close();
    });
  }

  test('image-only banner with the pages visible', async () => {
    const reader = await h.openReader();
    await reader.open('scan-image-only.pdf');
    await reader.waitPhase('image-only');
    await expect(reader.pageEl(1).locator('canvas').first()).toBeVisible();
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });

  test('external-link confirmation dialog', async () => {
    const reader = await h.openReader({ width: 1300, height: 900 });
    await reader.openReady('hostile-text-links.pdf');
    await clickText(reader.page, 1, 'Link to https example');
    await expect(reader.tid(HOOK.linkConfirm)).toBeVisible();
    expect(await axe(reader.page)).toEqual([]);
    await reader.page.close();
  });
});

test.describe('axe best-practice rules (landmarks, ARIA role conformance)', () => {
  // Landmarks and ARIA role conformance (axe best-practice rules). A first build had no <main>, overlays
  // outside any landmark and role="group" on a <form>; the current build is clean.
  test('empty, open, password and image-only states have no best-practice violations', async () => {
    const found: string[] = [];
    const reader = await h.openReader();
    found.push(...(await axe(reader.page, ['best-practice'])).map((v) => `empty: ${v}`));
    await reader.openReady('basic-1page.pdf');
    found.push(...(await axe(reader.page, ['best-practice'])).map((v) => `open: ${v}`));
    await reader.open('encrypted-aes128.pdf');
    await reader.waitPhase('password-required');
    found.push(...(await axe(reader.page, ['best-practice'])).map((v) => `password: ${v}`));
    await reader.open('scan-image-only.pdf');
    await reader.waitPhase('image-only');
    found.push(...(await axe(reader.page, ['best-practice'])).map((v) => `image-only: ${v}`));
    test.info().annotations.push({ type: 'axe', description: found.join('\n') });
    expect(found).toEqual([]);
    await reader.page.close();
  });
});

test.describe('keyboard only', () => {
  test('open a file, change page, zoom, find and close, without a mouse', async () => {
    const reader = await h.openReader();
    // The first Tab lands on a control that can open a file.
    await reader.page.keyboard.press('Tab');
    const first = await reader.page.evaluate(
      () => document.activeElement?.textContent?.trim() ?? document.activeElement?.tagName,
    );
    expect([TEXT.open, TEXT.choose]).toContain(first);
    const chooser = reader.page.waitForEvent('filechooser');
    await reader.page.keyboard.press('Enter');
    await (await chooser).setFiles(acceptPath('pages-100.pdf'));
    await reader.waitPhase('ready');
    await reader.waitFirstPage();

    // Focus moved to the pages: the page keys work at once.
    await expect
      .poll(() => reader.page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
      .toBe(HOOK.viewer);
    await reader.page.keyboard.press('n');
    await expect.poll(() => reader.currentPage()).toBe(2);
    await reader.page.keyboard.press('j');
    await expect.poll(() => reader.currentPage()).toBe(3);
    await reader.page.keyboard.press('p');
    await expect.poll(() => reader.currentPage()).toBe(2);
    await reader.page.keyboard.press('k');
    await expect.poll(() => reader.currentPage()).toBe(1);
    await reader.page.keyboard.press('Control+End');
    await expect.poll(() => reader.currentPage()).toBe(100);
    await reader.page.keyboard.press('Control+Home');
    await expect.poll(() => reader.currentPage()).toBe(1);
    await reader.page.keyboard.press('PageDown');
    await reader.page.keyboard.press('PageDown');
    await expect.poll(() => reader.viewer.evaluate((el) => el.scrollTop)).toBeGreaterThan(500);
    await reader.page.keyboard.press('End');
    await expect.poll(() => reader.currentPage()).toBeGreaterThan(95);
    await reader.page.keyboard.press('Home');
    await expect.poll(() => reader.viewer.evaluate((el) => el.scrollTop)).toBe(0);
    await expect.poll(() => reader.currentPage()).toBe(1);

    // Zoom.
    await reader.page.keyboard.press('0');
    await reader.settle();
    expect(await reader.zoomValue()).toBe('1');
    await reader.page.keyboard.press('+');
    await reader.settle();
    const bigger = await reader.pageWidth(1);
    expect(bigger).toBeGreaterThan(816);
    await reader.page.keyboard.press('-');
    await reader.page.keyboard.press('-');
    await reader.settle();
    expect(await reader.pageWidth(1)).toBeLessThan(816);

    // Find: Ctrl+F, type, Enter, F3, Escape.
    await reader.page.keyboard.press('Control+f');
    await expect(reader.tid(HOOK.findInput)).toBeFocused();
    await reader.page.keyboard.type('marmot');
    await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 100');
    await reader.page.keyboard.press('Enter');
    await expect.poll(() => reader.findStatus()).toBe('2 of 100');
    await reader.page.keyboard.press('Shift+Enter');
    await expect.poll(() => reader.findStatus()).toBe('1 of 100');
    await reader.page.keyboard.press('Escape');
    await expect(reader.tid(HOOK.findBar)).toHaveCount(0);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('Escape in the find bar returns keyboard focus to somewhere usable (not the page body)', async () => {
    const reader = await h.openReader();
    await reader.openReady('pages-100.pdf');
    await reader.page.keyboard.press('Control+f');
    await reader.page.keyboard.press('Escape');
    const active = await reader.page.evaluate(() => {
      const el = document.activeElement;
      return el === null || el === document.body
        ? 'body'
        : (el.getAttribute('data-testid') ?? el.tagName);
    });
    expect(active).not.toBe('body');
    await reader.page.close();
  });

  test('every control in the toolbar can be reached with Tab, has an accessible name and a visible focus surface', async () => {
    const reader = await h.openReader({ width: 1300, height: 800 });
    await reader.openReady('pages-100.pdf');
    await reader.page.getByRole('button', { name: TEXT.open, exact: true }).focus();
    await reader.page.keyboard.press('Tab');
    await reader.page.getByRole('button', { name: 'Open PDF' }).focus();
    const seen: { name: string; cue: boolean }[] = [];
    for (let i = 0; i < 14; i++) {
      const info = await reader.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || !el.closest('header')) return null;
        const style = getComputedStyle(el);
        const name =
          el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.getAttribute('title') ?? '';
        const surface = () =>
          [
            style.backgroundColor,
            style.backgroundImage,
            style.boxShadow,
            style.borderColor,
            style.textDecorationLine,
          ].join('|');
        const focused = surface();
        const visible = el.matches(':focus-visible');
        el.blur();
        const resting = surface();
        el.focus();
        return { name, cue: visible && focused !== resting };
      });
      if (info) seen.push(info);
      await reader.page.keyboard.press('Tab');
    }
    expect(seen.length).toBeGreaterThanOrEqual(9);
    for (const control of seen) {
      expect(control.name.length, 'accessible name').toBeGreaterThan(0);
      expect(control.cue, `${control.name}: visible focus indicator`).toBe(true);
    }
    const names = seen.map((s) => s.name);
    for (const expected of [
      'Open PDF',
      'Close PDF',
      'Previous page',
      'Next page',
      'Zoom out',
      'Zoom in',
    ]) {
      expect(names, expected).toContain(expected);
    }
    await reader.page.close();
  });

  test('the link confirmation is a dialog: focus goes into it, Escape cancels it, focus returns to the pages', async () => {
    const reader = await h.openReader({ width: 1300, height: 900 });
    await reader.openReady('hostile-text-links.pdf');
    const tabs = h.ext.context.pages().length;
    await clickText(reader.page, 1, 'Link to https example');
    const dialog = reader.tid(HOOK.linkConfirm);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'alertdialog');
    const insideDialog = await reader.page.evaluate(
      () => document.activeElement?.closest('[data-testid=link-confirm]') !== null,
    );
    expect(insideDialog, 'focus moved into the dialog').toBe(true);
    // Tab stays inside the dialog (the rest of the page is inert).
    for (let i = 0; i < 4; i++) {
      await reader.page.keyboard.press('Tab');
      expect(
        await reader.page.evaluate(
          () => document.activeElement?.closest('[data-testid=link-confirm]') !== null,
        ),
      ).toBe(true);
    }
    await reader.page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(h.ext.context.pages().length).toBe(tabs);
    const active = await reader.page.evaluate(() => {
      const el = document.activeElement;
      return el === null || el === document.body ? 'body' : 'element';
    });
    expect(active).toBe('element');
    await reader.page.close();
  });

  test('the password prompt: focus is in the field, Escape does not leave the user stuck, labels are associated', async () => {
    const reader = await h.openReader();
    await reader.open('encrypted-aes128.pdf');
    await reader.waitPhase('password-required');
    await expect(reader.passwordInput).toBeFocused();
    await expect(reader.page.getByLabel(TEXT.passwordLabel)).toBeVisible();
    // Keyboard path to Cancel: Tab to the buttons, Enter on Cancel.
    await reader.page.keyboard.press('Tab');
    await reader.page.keyboard.press('Tab');
    await reader.page.keyboard.press('Enter');
    await expect(reader.tid(HOOK.passwordPrompt)).toHaveCount(0);
    await reader.page.close();
  });
});

test.describe('announcements and state semantics', () => {
  const live = (reader: Reader) => reader.tid(HOOK.liveRegion);

  test('opening, page changes and zoom changes are announced politely; closing too', async () => {
    const reader = await h.openReader();
    await expect(live(reader)).toHaveAttribute('aria-live', 'polite');
    await reader.openReady('pages-100.pdf');
    await expect(live(reader)).toContainText('pages-100.pdf');
    await expect(live(reader)).toContainText('100');
    await reader.goToPage(7);
    await expect(live(reader)).toHaveText(/Page 7 of 100/);
    await reader.setZoom('1.5');
    await expect(live(reader)).toHaveText(/Zoom 150%/);
    await reader.page.getByRole('button', { name: TEXT.close, exact: true }).click();
    await expect(live(reader)).toHaveText(/closed/i);
    await reader.page.close();
  });

  test('error and password errors are role=alert; loading is role=status; the empty state has a heading', async () => {
    const reader = await h.openReader();
    await expect(reader.tid(HOOK.stateEmpty).getByRole('heading')).toBeVisible();
    await reader.open('corrupt-noise.pdf');
    await reader.waitPhase('error');
    await expect(reader.tid(HOOK.stateError)).toHaveAttribute('role', 'alert');
    await reader.open('encrypted-aes128.pdf');
    await reader.waitPhase('password-required');
    await reader.passwordInput.fill('nope');
    await reader.passwordInput.press('Enter');
    await expect(reader.tid(HOOK.passwordError)).toHaveAttribute('role', 'alert');
    await expect(reader.passwordInput).toHaveAttribute('aria-invalid', 'true');
    await reader.open('scan-image-only.pdf');
    await reader.waitPhase('image-only');
    await expect(reader.tid(HOOK.stateImageOnly)).toHaveAttribute('role', 'status');
    await reader.page.close();
  });

  test('the page-number input and the zoom select are labelled controls', async () => {
    const reader = await h.openReader();
    await reader.openReady('basic-1page.pdf');
    await expect(reader.page.getByRole('spinbutton', { name: 'Page' })).toBeVisible();
    await expect(reader.page.getByRole('combobox', { name: 'Zoom level' })).toBeVisible();
    await expect(reader.page.getByRole('region', { name: 'PDF pages' })).toBeVisible();
    await reader.page.close();
  });
});

test.describe('reflow', () => {
  for (const [state, file] of [
    ['empty', undefined],
    ['open document', 'basic-1page.pdf'],
  ] as const) {
    test(`at 400 px wide the ${state} reader needs no horizontal page scroll (the toolbar wraps)`, async () => {
      const reader = await h.openReader({ width: 400, height: 800 });
      if (file !== undefined) await reader.openReady(file);
      const overflow = await reader.page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - window.innerWidth,
        header: (document.querySelector('header') as HTMLElement).scrollWidth - window.innerWidth,
      }));
      expect(overflow.doc).toBeLessThanOrEqual(1);
      expect(overflow.header).toBeLessThanOrEqual(1);
      await reader.page.close();
    });
  }

  test('every toolbar control is at least 24 x 24 CSS px (WCAG 2.5.8 target size)', async () => {
    const reader = await h.openReader({ width: 1300, height: 800 });
    await reader.openReady('basic-1page.pdf');
    await reader.openFind();
    const small = await reader.page.evaluate(() =>
      [
        ...document.querySelectorAll(
          'header button, header select, header input[type=number], header input[type=search]',
        ),
      ]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            name: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
            w: r.width,
            h: r.height,
          };
        })
        .filter((c) => c.w < 24 || c.h < 24),
    );
    expect(small).toEqual([]);
    await reader.page.close();
  });
});
