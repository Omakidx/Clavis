// Code passed to page.evaluate / serviceWorker.evaluate runs inside the
// extension, where `chrome` exists. WXT exposes the API types as `Browser`.
import type { Browser } from '@wxt-dev/browser';

declare global {
  const chrome: typeof Browser;
}

export {};
