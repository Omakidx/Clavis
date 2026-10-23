import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  fixtureInfo,
  loadFixture,
  openFindBar,
  openFixtureReady,
  openReader,
  waitForPhase,
} from './p7-reader-support/helpers';
import { HOSTILE_URLS, hostilePdf } from './p7-reader-support/pdfs';

// Accessibility of the reader shell: axe on every state, keyboard order, focus management, live
// regions, reduced motion and forced colours.
test.describe.configure({ timeout: 120_000 });

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
  }));
  expect(summary, `axe violations: ${label}`).toEqual([]);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme} colour scheme`, () => {
    test.use({ colorScheme: scheme });

    test('empty state', async ({ context, extensionId }) => {
      const { page } = await openReader(context, extensionId);
      await page.emulateMedia({ colorScheme: scheme });
      await axe(page, 'empty');
    });

    test('loaded document with the find bar open', async ({ context, extensionId }) => {
      const { page } = await openReader(context, extensionId);
      await page.emulateMedia({ colorScheme: scheme });
      await openFixtureReady(page, 'text-1page.pdf');
      await axe(page, 'loaded');
      const find = await openFindBar(page);
      await find.fill('the');
      await expect(page.getByTestId('find-status')).toHaveText(/of 3/, { timeout: 15_000 });
      await axe(page, 'loaded + find bar');
    });

    test('password prompt, with and without the wrong-password message', async ({
      context,
      extensionId,
    }) => {
      const { page } = await openReader(context, extensionId);
      await page.emulateMedia({ colorScheme: scheme });
      await loadFixture(page, 'encrypted.pdf');
      await waitForPhase(page, 'password-required');
      await axe(page, 'password prompt');
      const field = page.getByTestId('password-prompt').getByLabel('PDF password');
      await field.fill('wrong-password');
      await field.press('Enter');
      await expect(page.getByTestId('password-error')).toBeVisible({ timeout: 20_000 });
      await axe(page, 'wrong password');
      expect(fixtureInfo('encrypted.pdf').password).toBeTruthy();
    });

    test('error state, image-only notice and the link confirmation', async ({
      context,
      extensionId,
    }) => {
      const { page } = await openReader(context, extensionId);
      await page.emulateMedia({ colorScheme: scheme });
      await loadFixture(page, 'corrupt.pdf');
      await waitForPhase(page, 'error');
      await axe(page, 'error');

      await loadFixture(page, 'image-only.pdf');
      await waitForPhase(page, 'image-only');
      await expect(page.getByTestId('state-image-only')).toBeVisible();
      await axe(page, 'image-only');

      await page.getByTestId('file-input').setInputFiles({
        name: 'links.pdf',
        mimeType: 'application/pdf',
        buffer: await hostilePdf(),
      });
      await waitForPhase(page, 'ready');
      await page.locator(`.annotationLayer a[title="${HOSTILE_URLS.https}"]`).click();
      await expect(page.getByTestId('link-confirm')).toBeVisible();
      await axe(page, 'link confirmation');
    });
  });
}

test.describe('keyboard and focus', () => {
  test('Tab visits the controls in reading order, each has a name, and focus is always visible', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    // Tab order from the first control; the pages and their text come after the toolbar.
    await page.getByRole('button', { name: 'Open PDF' }).focus();
    const stops: string[] = [];
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab');
      const stop = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const style = getComputedStyle(el);
        const name =
          el.getAttribute('aria-label') ||
          (el as HTMLInputElement).labels?.[0]?.textContent ||
          el.textContent?.trim() ||
          '';
        return {
          name,
          tag: el.tagName.toLowerCase(),
          outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2,
        };
      });
      if (stop === null) break;
      expect(stop.name, `control #${i} has an accessible name`).not.toBe('');
      expect(stop.outline, `${stop.name} shows a focus ring`).toBe(true);
      stops.push(stop.name);
    }
    expect(stops.slice(0, 9)).toEqual([
      'Close PDF',
      'Previous page',
      'Page',
      'Next page',
      'Zoom out',
      'Zoom level',
      'Zoom in',
      'Fit width',
      'Find',
    ]);
    expect(stops[9]).toBe('PDF pages');
  });

  test('page changes and the open/close of a document reach a polite live region', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    const live = page.getByTestId('live-region');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await openFixtureReady(page, 'text-100pages.pdf');
    await expect(live).toHaveText('Opened text-100pages.pdf. Page count: 100.');
    await page.keyboard.press('n');
    await expect(live).toHaveText('Page 2 of 100', { timeout: 5000 });
    await page.getByRole('button', { name: 'Close PDF' }).click();
    await expect(live).toHaveText('PDF closed.');
  });

  test('states are announced by their own live roles: loading is a status, errors are alerts', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await loadFixture(page, 'corrupt.pdf');
    await waitForPhase(page, 'error');
    await expect(page.getByRole('alert').filter({ hasText: 'damaged' })).toBeVisible();
    await loadFixture(page, 'image-only.pdf');
    await waitForPhase(page, 'image-only');
    await expect(page.getByTestId('state-image-only')).toHaveAttribute('role', 'status');
  });

  test('the viewer behind a password prompt or an open dialog is out of the tab order (inert)', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await loadFixture(page, 'encrypted.pdf');
    await waitForPhase(page, 'password-required');
    expect(
      await page
        .getByTestId('viewer-container')
        .evaluate((el) => (el as HTMLElement & { inert: boolean }).inert),
    ).toBe(true);
  });

  test('Close PDF puts focus on Open PDF instead of dropping it', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    await page.getByRole('button', { name: 'Close PDF' }).click();
    await expect(page.getByRole('button', { name: 'Open PDF' })).toBeFocused();
  });
});

test.describe('reduced motion and forced colours', () => {
  test('reduced motion: no transitions or smooth scrolling anywhere in the reader', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openFixtureReady(page, 'text-100pages.pdf');
    const motion = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('.reader, .reader *')) {
        const s = getComputedStyle(el);
        const longest = Math.max(
          ...s.transitionDuration
            .split(',')
            .map((d) => parseFloat(d) * (d.includes('ms') ? 1 : 1000)),
          ...s.animationDuration
            .split(',')
            .map((d) => parseFloat(d) * (d.includes('ms') ? 1 : 1000)),
        );
        if (longest > 1 || s.scrollBehavior === 'smooth') {
          offenders.push(`${el.tagName.toLowerCase()}.${el.className}`);
        }
      }
      return offenders.slice(0, 5);
    });
    expect(motion).toEqual([]);
  });

  test('forced colours: borders and focus use system colours and remain visible', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await page.emulateMedia({ forcedColors: 'active' });
    await openFixtureReady(page, 'text-1page.pdf');
    await openFindBar(page);
    const state = await page.evaluate(() => {
      const border = (sel: string) => {
        const s = getComputedStyle(document.querySelector(sel)!);
        return { width: parseFloat(s.borderTopWidth), style: s.borderTopStyle };
      };
      return {
        button: border('.clavis-button'),
        input: border('[data-testid=find-input]'),
        pressed: getComputedStyle(document.querySelector('[data-testid=find-toggle]')!)
          .outlineStyle,
      };
    });
    expect(state.button.width).toBeGreaterThan(0);
    expect(state.button.style).not.toBe('none');
    expect(state.input.width).toBeGreaterThan(0);
    expect(state.pressed).not.toBe('none'); // the pressed Find toggle is marked by an outline
    await axe(page, 'forced colours');
  });

  test('a narrow window (320 px) has no horizontal page scroll and every control stays reachable', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId, { width: 320, height: 640 });
    await openFixtureReady(page, 'text-1page.pdf');
    await openFindBar(page);
    const overflow = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
    for (const name of ['Open PDF', 'Close PDF', 'Zoom in', 'Find', 'Close find']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
    }
  });
});
