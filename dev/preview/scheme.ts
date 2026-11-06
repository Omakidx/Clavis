/**
 * Force the light or dark look of a preview frame.
 *
 * The app's stylesheets switch with `@media (prefers-color-scheme: dark)`, which a page cannot
 * override. So this rewrites the media queries of every stylesheet it can reach (the page's,
 * constructable sheets, the open shadow roots the specimens register and same-origin frames):
 * the query for the chosen scheme becomes "always", the other one "never". The original text is
 * remembered, so switching back to "system" restores it. Vite's CSS hot updates replace the
 * <style> contents, which the observer notices and patches again.
 */

export type Scheme = 'system' | 'light' | 'dark';

const original = new WeakMap<CSSMediaRule, string>();
const roots = new Set<ShadowRoot>();
let current: Scheme = 'system';

const ALWAYS = '(min-width: 0px)';
const NEVER = '(min-width: 100000px)';

export const parseScheme = (value: string | null): Scheme =>
  value === 'light' || value === 'dark' ? value : 'system';

function patchRules(rules: CSSRuleList): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSMediaRule) {
      const base = original.get(rule) ?? rule.media.mediaText;
      if (/prefers-color-scheme/.test(base)) {
        original.set(rule, base);
        const next =
          current === 'system'
            ? base
            : base.replace(
                /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/g,
                (_all, kind: string) => (kind === current ? ALWAYS : NEVER),
              );
        if (rule.media.mediaText !== next) rule.media.mediaText = next;
      }
    }
    if ('cssRules' in rule) patchRules((rule as CSSGroupingRule).cssRules);
  }
}

function patchSheet(sheet: CSSStyleSheet): void {
  try {
    patchRules(sheet.cssRules);
  } catch {
    /* a cross-origin sheet (web fonts): nothing to do */
  }
}

function patchScope(scope: Document | ShadowRoot): void {
  for (const sheet of Array.from(scope.styleSheets)) patchSheet(sheet);
  for (const sheet of scope.adoptedStyleSheets) patchSheet(sheet);
}

export function applyScheme(): void {
  patchScope(document);
  for (const root of roots) patchScope(root);
  for (const frame of Array.from(document.querySelectorAll('iframe'))) {
    try {
      const doc = frame.contentDocument;
      if (doc !== null) {
        patchScope(doc);
        doc.documentElement.style.colorScheme = current === 'system' ? '' : current;
        doc.documentElement.dataset['previewTheme'] = current;
      }
    } catch {
      /* cross-origin frame */
    }
  }
  document.documentElement.style.colorScheme = current === 'system' ? '' : current;
  document.documentElement.dataset['previewTheme'] = current;
}

/** A shadow root whose adopted sheets should follow the forced scheme (the web page specimens). */
export function registerRoot(root: ShadowRoot): void {
  roots.add(root);
  applyScheme();
}

export function setScheme(scheme: Scheme): void {
  current = scheme;
  applyScheme();
}

export function initScheme(initial: Scheme): void {
  current = initial;
  applyScheme();
  const schedule = (() => {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        applyScheme();
      });
    };
  })();
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // Frames inside the page (the practice article) and constructed sheets have no mutation signal.
  setInterval(applyScheme, 1500);
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as { type?: unknown; theme?: unknown } | null;
    if (data !== null && typeof data === 'object' && data.type === 'clavis-preview-theme') {
      setScheme(parseScheme(typeof data.theme === 'string' ? data.theme : null));
    }
  });
}
