import { expect, test } from './fixtures';
import { openFixtureReady, openReader } from './p7-reader-support/helpers';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { SEL, tb } from './spike-b-support/toolbar';

// Phase 8: the toolbar in the PDF reader behaves like the one on a web page (same code): it stays
// inside small windows, follows the colour scheme, and keeps touch-sized buttons.
test.describe.configure({ timeout: 90_000 });

const BAR = { light: 'rgb(246, 247, 235)', dark: 'rgb(32, 34, 27)' } as const;

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1000, 320]) {
    test(`reader toolbar, ${scheme}, ${width}px wide`, async ({ context, extensionId }) => {
      const { page } = await openReader(context, extensionId, { width, height: 700 });
      await page.emulateMedia({ colorScheme: scheme });
      await openFixtureReady(page, 'text-1page.pdf');
      await selectWordByDoubleClick(page, 'quick');
      const toolbar = tb(page);
      await toolbar.waitShown();

      const box = await toolbar.box();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y + box.height).toBeLessThanOrEqual(700);

      expect(
        await toolbar.evalIn<string>(
          SEL.toolbar,
          'function () { return getComputedStyle(this).backgroundColor; }',
        ),
      ).toBe(BAR[scheme]);
      const button = await toolbar.box(SEL.action('explain'));
      expect(button.height).toBeGreaterThanOrEqual(32);
      expect(button.width).toBeGreaterThanOrEqual(44);

      // Scrolling the reader keeps the toolbar on screen or hides it; it never leaves a stray box.
      await page.getByTestId('viewer-container').evaluate((el) => el.scrollBy(0, 400));
      const after = await toolbar.box().catch(() => null);
      if (after !== null && (await toolbar.isShown())) {
        expect(after.y + after.height).toBeLessThanOrEqual(700);
      }
    });
  }
}
