/** Only these extension pages have a matching screen in the design preview. */
const SCREENS = {
  '/options.html': { galleryId: 'settings', screen: 'settings' },
  '/onboarding.html': { galleryId: 'onboarding-1', screen: 'onboarding' },
  '/practice.html': { galleryId: 'practice', screen: 'practice' },
  '/reader.html': { galleryId: 'reader-empty', screen: 'reader' },
  '/sidepanel.html': { galleryId: 'sidepanel', screen: 'sidepanel' },
} as const;

export type PreviewTarget =
  | { kind: 'screen'; galleryId: string; screen: string; hash: string }
  | { kind: 'external'; href: string };

/** Recognize exact preview extension pages and safe external links, never arbitrary schemes. */
export function resolvePreviewTarget(target: string, previewOrigin: string): PreviewTarget | null {
  let url: URL;
  try {
    url = new URL(target, previewOrigin);
  } catch {
    return null;
  }

  const extensionPage = url.protocol === 'chrome-extension:' && url.host === 'clavis-preview';
  const rootLink =
    target.startsWith('/') && !target.startsWith('//') && url.origin === previewOrigin;
  if (extensionPage || rootLink) {
    const screen = SCREENS[url.pathname as keyof typeof SCREENS];
    if (screen === undefined || url.search !== '') return null;
    // Settings is the only preview screen whose deep-link anchors are supported.
    const hash =
      url.pathname === '/options.html' && /^#section-[a-z0-9-]+$/.test(url.hash) ? url.hash : '';
    return { kind: 'screen', ...screen, hash };
  }

  if (/^(https?:)?\/\//i.test(target) && (url.protocol === 'https:' || url.protocol === 'http:'))
    return { kind: 'external', href: url.href };
  return null;
}

/** A standalone screen carries the current scenario/theme into the requested destination. */
export function standalonePreviewUrl(
  target: Extract<PreviewTarget, { kind: 'screen' }>,
  search: string,
): string {
  const current = new URLSearchParams(search);
  const next = new URLSearchParams({ screen: target.screen });
  for (const key of ['state', 'theme', 'delay']) {
    const value = current.get(key);
    if (value !== null) next.set(key, value);
  }
  if (target.screen === 'onboarding') next.set('step', '1');
  if (target.screen === 'sidepanel') next.set('tab', '1');
  return `/dev/preview/screen.html?${next.toString()}${target.hash}`;
}
