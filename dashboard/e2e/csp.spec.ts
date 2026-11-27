import { expect, readerTest, test } from './support/fixtures';

// Design §8.1: script-src 'self'; style-src 'self'. The `guard` fixture (auto) fails every test in this
// suite that logs a CSP violation or an uncaught page error; these tests walk every page and state.
test.describe('CSP', () => {
  test('the SPA shell is served with the strict policy and no inline script or style', async ({
    request,
  }) => {
    const res = await request.get('/');
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers()['referrer-policy']).toBe('no-referrer');
    const html = await res.text();
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/\sstyle=/i);
  });

  test('an injected inline script is blocked by the policy (the guard would see it)', async ({
    page,
    guard,
  }) => {
    await page.goto('/');
    const violation = page.waitForEvent('console', {
      predicate: (m) => m.text().includes('CSPVIOLATION'),
    });
    await page.evaluate(() => {
      const s = document.createElement('script');
      s.textContent = 'window.__ran = 1';
      document.head.append(s);
    });
    await violation;
    expect(
      await page.evaluate(() => (window as unknown as { __ran?: number }).__ran),
    ).toBeUndefined();
    // The violation was provoked on purpose: clear it so the guard does not fail the test.
    expect(guard.some((p) => p.includes('CSPVIOLATION script-src-elem'))).toBe(true);
    guard.length = 0;
  });
});

readerTest.describe('CSP across pages', () => {
  readerTest(
    'every page and dialog runs without violations or inline styles',
    async ({ rpage: page }) => {
      for (const path of [
        '/',
        '/words',
        '/words?q=onerror',
        '/documents',
        '/account',
        '/missing',
      ]) {
        await page.goto(path);
        await expect(page.locator('main')).toBeVisible();
      }
      await page.goto('/words?q=ephemeral');
      await page.getByRole('link', { name: 'ephemeral' }).click();
      await page.getByRole('button', { name: /Open source page/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.goto('/documents');
      await page.getByRole('button', { name: 'Delete document Local only' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      expect(await page.locator('[style]').count()).toBe(0);
      expect(await page.locator('script:not([src])').count()).toBe(0);
    },
  );
});
