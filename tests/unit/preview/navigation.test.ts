import { describe, expect, it, vi } from 'vitest';
import { createFakeBackground } from '../../../dev/preview/fake-chrome';
import { resolvePreviewTarget, standalonePreviewUrl } from '../../../dev/preview/navigation';

const ORIGIN = 'http://localhost:3000';

function screen(target: string) {
  const route = resolvePreviewTarget(target, ORIGIN);
  if (route?.kind !== 'screen') throw new Error(`Expected a preview screen for ${target}`);
  return route;
}

describe('preview navigation', () => {
  it.each([
    ['chrome-extension://clavis-preview/options.html#section-help-pdf', 'settings', 'settings'],
    ['chrome-extension://clavis-preview/onboarding.html', 'onboarding-1', 'onboarding'],
    ['/practice.html', 'practice', 'practice'],
    ['chrome-extension://clavis-preview/reader.html', 'reader-empty', 'reader'],
    ['chrome-extension://clavis-preview/sidepanel.html', 'sidepanel', 'sidepanel'],
  ])('maps %s for both gallery and standalone screens', (target, galleryId, standalone) => {
    const route = screen(target);
    expect(route.galleryId).toBe(galleryId);
    expect(route.screen).toBe(standalone);
  });

  it('preserves scenario, theme, and settings deep link in a standalone preview', () => {
    const route = screen('chrome-extension://clavis-preview/options.html#section-help-pdf');
    expect(standalonePreviewUrl(route, '?screen=popup&state=no-key&theme=dark&delay=800')).toBe(
      '/dev/preview/screen.html?screen=settings&state=no-key&theme=dark&delay=800#section-help-pdf',
    );
  });

  it('starts onboarding at step one and clears a stale fixture selection', () => {
    const route = screen('/onboarding.html');
    expect(
      standalonePreviewUrl(route, '?screen=reader&pdf=text-1page&step=6&state=fresh&theme=light'),
    ).toBe('/dev/preview/screen.html?screen=onboarding&state=fresh&theme=light&step=1');
  });

  it('keeps external web links external and rejects unknown or unsafe routes', () => {
    expect(resolvePreviewTarget('https://console.groq.com/keys', ORIGIN)).toEqual({
      kind: 'external',
      href: 'https://console.groq.com/keys',
    });
    expect(resolvePreviewTarget('javascript:alert(1)', ORIGIN)).toBeNull();
    expect(resolvePreviewTarget('chrome-extension://other/options.html', ORIGIN)).toBeNull();
    expect(
      resolvePreviewTarget('chrome-extension://clavis-preview/unknown.html', ORIGIN),
    ).toBeNull();
    expect(resolvePreviewTarget('/options.html/evil', ORIGIN)).toBeNull();
    expect(resolvePreviewTarget('//evil.example/options.html', ORIGIN)).toEqual({
      kind: 'external',
      href: 'http://evil.example/options.html',
    });
    expect(resolvePreviewTarget('#section-key', ORIGIN)).toBeNull();
  });

  it('routes simulated popup Explain to practice without claiming text was selected', async () => {
    const background = createFakeBackground({
      scenario: 'connected',
      delayMs: 0,
      handoff: 'sample',
    });
    const opened = vi.fn();
    background.events.onOpen.add(opened);
    await expect(background.handle({ type: 'CLAVIS_INJECT_TAB', tabId: 1 })).resolves.toEqual({
      ok: true,
      shown: false,
    });
    expect(opened).toHaveBeenCalledExactlyOnceWith(
      'chrome-extension://clavis-preview/practice.html',
    );
  });
});
