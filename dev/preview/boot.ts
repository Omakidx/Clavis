import { installFakeChrome, optionsFromSearch } from './fake-chrome';
import { initScheme, parseScheme } from './scheme';
import { resolvePreviewTarget, standalonePreviewUrl } from './navigation';

/**
 * Must be the FIRST import of a preview page: ES modules evaluate in import order, and the app
 * reads `globalThis.browser` when its own modules load (lib/i18n, lib/ui-client, ...).
 */
installFakeChrome(optionsFromSearch(location.search));
initScheme(parseScheme(new URLSearchParams(location.search).get('theme')));

// Ordinary extension-page anchors are not routed through chrome.tabs.create. Intercept only the
// known preview pages; leave in-page anchors and external links to the browser.
document.addEventListener('click', (event) => {
  const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (
    anchor === null ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  const href = anchor.getAttribute('href');
  if (href === null) return;
  const route = resolvePreviewTarget(href, location.origin);
  if (route?.kind !== 'screen') return;
  event.preventDefault();
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'clavis-preview-open', url: href }, location.origin);
  } else {
    location.assign(standalonePreviewUrl(route, location.search));
  }
});

// A real popup closes after opening another extension surface. The design preview must stay open
// long enough to show that surface, including when the popup is in a standalone tab.
if (new URLSearchParams(location.search).get('screen') === 'popup') {
  window.close = () => undefined;
}
