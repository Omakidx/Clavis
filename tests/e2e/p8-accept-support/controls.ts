import type { BrowserContext, Page } from '@playwright/test';

/** One thing a person can press, find or flip on an extension page. */
export interface Control {
  index: number;
  /** What a person would call it: its accessible text. */
  label: string;
  tag: string;
  kind: 'press' | 'select' | 'toggle';
  /** Inactive (`aria-disabled`): shown but explicitly not available right now. */
  inactive: boolean;
}

const MARK = 'data-sweep-index';

/**
 * Find every visible, enabled interactive control and number it (a `data-sweep-index` attribute,
 * removed again by `release`). Text inputs are not controls here: typing is not "pressing".
 */
export async function findControls(page: Page): Promise<Control[]> {
  return page.evaluate((mark) => {
    const selector = [
      'button',
      'a[href]',
      'summary',
      'select',
      '[role="button"]',
      '[role="tab"]',
      'input[type="checkbox"]',
      'input[type="radio"]',
    ].join(',');
    const out: {
      index: number;
      label: string;
      tag: string;
      kind: 'press' | 'select' | 'toggle';
      inactive: boolean;
    }[] = [];
    let index = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const hidden = style.visibility === 'hidden' || style.display === 'none';
      const srOnly = el.closest('.clavis-sr-only') !== null;
      // Inside a collapsed <details> a control cannot be reached until its summary is pressed.
      const folded = el.closest('details:not([open])') !== null && el.tagName !== 'SUMMARY';
      const disabled = (el as HTMLButtonElement).disabled === true;
      // A skip-to-content link is allowed to sit off screen until focused: still a control.
      if (hidden || disabled || srOnly || folded || (rect.width === 0 && rect.height === 0))
        continue;
      const input = el as HTMLInputElement;
      // A radio that is already chosen cannot "do" anything by being pressed again.
      if (input.type === 'radio' && input.checked) continue;
      el.setAttribute(mark, String(index));
      const label =
        el.getAttribute('aria-label') ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim() ?? '';
      out.push({
        index,
        label: label === '' ? (input.type ?? el.tagName) : label,
        tag: el.tagName.toLowerCase(),
        kind:
          el.tagName === 'SELECT'
            ? 'select'
            : input.type === 'checkbox' || input.type === 'radio'
              ? 'toggle'
              : 'press',
        inactive: el.getAttribute('aria-disabled') === 'true',
      });
      index += 1;
    }
    return out;
  }, MARK);
}

/** Count native file choosers, dialogs and downloads, which are "something happening" without any DOM change. */
export function watchEvents(
  context: BrowserContext,
  page: Page,
): { count(): number; dispose(): void } {
  let count = 0;
  const bump = (): void => {
    count += 1;
  };
  page.on('filechooser', bump);
  page.on('dialog', (dialog) => {
    bump();
    void dialog.dismiss().catch(() => undefined);
  });
  page.on('download', bump);
  const onPage = (): void => bump();
  context.on('page', onPage);
  return {
    count: () => count,
    dispose() {
      page.off('filechooser', bump);
      page.off('download', bump);
      context.off('page', onPage);
    },
  };
}

/** A page's state as a string; `null` when the page is gone (which is a change). */
export async function pageSignature(page: Page): Promise<string | null> {
  if (page.isClosed()) return null;
  try {
    return await page.evaluate(() => {
      const strip = (html: string): string => html.replace(/ data-sweep-index="\d+"/g, '');
      const values = Array.from(
        document.querySelectorAll<HTMLInputElement>('input,select,textarea'),
      )
        .map((el) => `${el.type}:${el.value}:${el.checked}`)
        .join('|');
      const scrolls = Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.scrollTop > 0 || el.scrollLeft > 0)
        .map((el) => `${el.tagName}${el.scrollTop}`)
        .join(',');
      const copied = (window as unknown as { __copied?: string[] }).__copied?.length ?? 0;
      return JSON.stringify({
        url: location.href,
        html: strip(document.documentElement.outerHTML),
        values,
        scroll: [scrollX, scrollY, scrolls],
        copied,
        selection: getSelection()?.toString() ?? '',
        frames: Array.from(document.querySelectorAll('iframe')).map((f) => {
          try {
            return f.contentDocument?.body.innerHTML.length ?? 0;
          } catch {
            return -1;
          }
        }),
      });
    });
  } catch {
    // Navigated away mid-read: that is a change too.
    return null;
  }
}
