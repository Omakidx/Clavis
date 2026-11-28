import { expect, test } from './support/fixtures';

// /privacy is a static page generated at build time from docs/privacy-policy.md and served by the API.
test.describe('privacy page', () => {
  test('renders the policy with the strict CSP, no inline style/script, and resolving anchors', async ({
    page,
    request,
  }) => {
    const res = await request.get('/privacy');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    expect(res.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(res.headers()['cache-control']).toContain('max-age=');
    const html = await res.text();
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).not.toMatch(/<script/i);
    expect((await request.get('/privacy/')).status()).toBe(200);

    await page.goto('/privacy');
    await expect(page).toHaveTitle('Clavis privacy policy');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('privacy policy');
    await expect(page.getByRole('link', { name: /Clavis dashboard/ })).toHaveAttribute('href', '/');

    // No inline style attributes or inline scripts in the live DOM either.
    expect(await page.locator('[style]').count()).toBe(0);
    expect(await page.locator('script:not([src])').count()).toBe(0);

    // Every in-page anchor points at an element that exists, and ids are unique.
    const { broken, dupes, count } = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id);
      const hrefs = [...document.querySelectorAll('a[href^="#"]')]
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.length > 1 && h !== '#policy');
      return {
        count: hrefs.length,
        broken: hrefs.filter((h) => !document.getElementById(decodeURIComponent(h.slice(1)))),
        dupes: ids.filter((id, i) => ids.indexOf(id) !== i),
      };
    });
    expect(count).toBeGreaterThan(0);
    expect(broken).toEqual([]);
    expect(dupes).toEqual([]);
    expect(await page.locator('#how-long-data-is-kept').count()).toBe(1);
  });

  test('external links open safely and unknown paths still get the SPA', async ({
    page,
    request,
  }) => {
    await page.goto('/privacy');
    const external = page.locator('main a[href^="http"]');
    for (const a of await external.all()) {
      await expect(a).toHaveAttribute('rel', 'noopener noreferrer');
    }
    const spa = await request.get('/definitely-not-a-page');
    expect(spa.status()).toBe(200);
    expect(await spa.text()).toContain('<div id="root">');
  });
});
