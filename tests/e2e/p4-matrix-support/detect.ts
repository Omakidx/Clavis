import type { Page } from '@playwright/test';
import {
  acceptableKinds,
  methodsFor,
  normalize,
  type Fixture,
  type ForwardKey,
  type Kind,
  type Method,
  type Target,
} from './manifest';
import {
  clearSelection,
  hostShown,
  locate,
  nearProblems,
  overlaps,
  perform,
  readProbe,
  readSelection,
  resetProbe,
  type Surface,
} from './page';
import { clickAction, readCardText, readKind, toolbar, toolbarBox, SEL } from './toolbar';

/** The headline requirement (requirements.md section 1): basic selection detection >= 95%. */
export const DETECTION_RATE_THRESHOLD = 0.95;
/** A selection must raise the toolbar within this time to count as detected. */
export const DETECTION_TIMEOUT_MS = 1500;
/** Product budgets (tech-stack.md section 6): first toolbar on a page / later toolbars, p95. */
export const FIRST_TOOLBAR_BUDGET_MS = 150;
export const LATER_TOOLBAR_BUDGET_MS = 50;

export type Outcome = 'pass' | 'fail' | 'invalid';

export interface Attempt {
  fixture: string;
  target: string;
  kind: string;
  method: Method;
  outcome: Outcome;
  /** Why it failed, or why it is invalid (the browser did not select the intended text). */
  reason: string;
  expected: string;
  selected: string;
  /** Node-side wait until the host was displayed. */
  appearMs: number | null;
  /** Page-side latency from the last mouseup/keyup to the toolbar being displayed (mouse methods). */
  latencyMs: number | null;
  kindSeen: string | null;
  captured: 'match' | 'mismatch' | 'unavailable';
  capturedText: string | null;
  /** The toolbar overlapped the selected text (FR-012 "not blocking content"). */
  covers: boolean;
  /** First attempt on a freshly loaded page (the "first toolbar" budget applies). */
  first: boolean;
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 8,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Bring the page to "no selection, no toolbar" between attempts, then give the observer time to
 * forget the previous selection (it ignores an unchanged range, so an immediate re-selection of
 * the same text would otherwise be skipped).
 */
export async function resetState(page: Page, surfaces: Surface[], modal = false): Promise<void> {
  for (const surface of surfaces) {
    await clearSelection(surface);
    if (!(await waitFor(async () => !(await hostShown(surface)), 400))) {
      // A press inside the toolbar keeps it alive; the user's ways out are Escape or a click
      // elsewhere. Escape would also close a modal dialog, so a dialog gets a click on itself.
      if (modal) {
        await page.evaluate(() => {
          const dialog = document.querySelector('dialog');
          const rect = dialog?.getBoundingClientRect();
          (window as unknown as { __p4click?: [number, number] }).__p4click = rect
            ? [rect.left + 6, rect.top + 6]
            : [5, 5];
        });
        const [x, y] = await page.evaluate(
          () => (window as unknown as { __p4click: [number, number] }).__p4click,
        );
        await page.mouse.click(x, y);
      } else {
        await page.keyboard.press('Escape');
      }
      await waitFor(async () => !(await hostShown(surface)), 800);
      await clearSelection(surface);
    }
  }
  await page.waitForTimeout(220);
  for (const surface of surfaces) {
    if (await hostShown(surface)) throw new Error('toolbar still visible after reset');
  }
  if (modal) {
    await page.evaluate(() => {
      const dialog = document.querySelector('dialog');
      if (dialog !== null && !dialog.open) dialog.showModal();
    });
  }
}

/** Does the captured card text equal the expected selection (cards may cap long text). */
export function captureMatches(card: string, expected: string): boolean {
  const text = normalize(card).replace(/…$/, '');
  if (text === expected) return true;
  return text.length >= 100 && text.length < expected.length && expected.startsWith(text);
}

export interface AttemptContext {
  page: Page;
  surface: Surface;
  /** Every surface (main page and frames) that may hold a toolbar. */
  surfaces: Surface[];
  fixture: Fixture;
  /** Whether to read the captured text through the card (Explain click). */
  readCapture: boolean;
}

export async function attemptSelection(
  ctx: AttemptContext,
  target: Target,
  method: Method,
): Promise<Attempt> {
  const { page, surface, fixture } = ctx;
  const base = {
    fixture: fixture.id,
    target: target.id,
    kind: acceptableKinds(target).join('|'),
    method,
    appearMs: null,
    latencyMs: null,
    kindSeen: null,
    captured: 'unavailable' as const,
    capturedText: null,
    covers: false,
    first: false,
  };
  const make = (
    outcome: Outcome,
    reason: string,
    expected: string,
    selected: string,
    extra: Partial<Attempt> = {},
  ): Attempt => ({ ...base, outcome, reason, expected, selected, ...extra });

  await resetState(page, ctx.surfaces, fixture.modal === true);
  const spec =
    target.paragraph !== undefined
      ? { paragraph: target.paragraph, startsWith: target.startsWith ?? '' }
      : { context: target.context ?? target.text ?? '', text: target.text ?? '' };
  const located = await locate(surface, spec);
  const expected = normalize(target.paragraph !== undefined ? located.text : (target.text ?? ''));
  if (located.obstructed.length > 0) {
    return make('invalid', `fixture: ${located.obstructed.join('; ')}`, expected, '');
  }

  const forwardKey: ForwardKey = target.forwardKey ?? fixture.forwardKey ?? 'ArrowRight';
  await resetProbe(surface);
  await perform(page, surface, { method, located, expected, forwardKey });
  const afterInput = Date.now();

  const selection = await readSelection(surface);
  const selected = normalize(selection.text);
  if (selected !== expected) {
    return make('invalid', 'the browser did not select the intended text', expected, selected);
  }

  const appeared = await waitFor(() => hostShown(surface), DETECTION_TIMEOUT_MS);
  const appearMs = appeared ? Date.now() - afterInput : null;
  if (!appeared) {
    return make('fail', `no toolbar within ${DETECTION_TIMEOUT_MS} ms`, expected, selected);
  }
  // Keyboard selections settle through a short debounce after the last key.
  if (method === 'keyboard') await page.waitForTimeout(120);

  const timing = await readProbe(surface);
  const latencyMs =
    timing.t0 !== null && timing.tDom !== null && method !== 'keyboard' && method !== 'triple'
      ? timing.tDom - timing.t0
      : null;
  const known = { appearMs, latencyMs };

  let kindSeen: string | null | undefined;
  try {
    kindSeen = await readKind(surface);
    if (
      kindSeen !== null &&
      kindSeen !== undefined &&
      !(acceptableKinds(target) as string[]).includes(kindSeen)
    ) {
      // The final capture may still be in flight; give it a moment before judging.
      await waitFor(
        async () => {
          kindSeen = await readKind(surface);
          return (acceptableKinds(target) as string[]).includes(kindSeen ?? '');
        },
        600,
        40,
      );
    }
  } catch (error) {
    return make(
      'fail',
      `toolbar host without a readable panel: ${String(error)}`,
      expected,
      selected,
      known,
    );
  }
  const kindOk =
    kindSeen === null ||
    kindSeen === undefined ||
    (acceptableKinds(target) as string[]).includes(kindSeen);
  if (!kindOk) {
    return make(
      'fail',
      `classified as ${String(kindSeen)}, expected ${acceptableKinds(target).join(' or ')}`,
      expected,
      selected,
      { ...known, kindSeen: kindSeen ?? null },
    );
  }

  let covers: boolean;
  let problems: string[] = [];
  try {
    const box = await toolbarBox(surface);
    const viewport = await surface.evaluate(() => ({
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    }));
    const live = await readSelection(surface);
    if (live.bounds !== null) problems = nearProblems(box, live.bounds, viewport);
    covers = live.rects.some((rect) => overlaps(box, rect));
  } catch (error) {
    return make('fail', `toolbar not measurable: ${String(error)}`, expected, selected, {
      ...known,
      kindSeen: kindSeen ?? null,
    });
  }
  const placement = { ...known, kindSeen: kindSeen ?? null, covers };
  if (problems.length > 0) {
    return make(
      'fail',
      `toolbar not near the selection: ${problems.join(', ')}`,
      expected,
      selected,
      placement,
    );
  }

  let captured: Attempt['captured'] = 'unavailable';
  let capturedText: string | null = null;
  if (ctx.readCapture) {
    try {
      await clickAction(surface, 'explain');
      const text = await readCardText(surface);
      if (text !== undefined) {
        capturedText = text;
        captured = captureMatches(text, expected) ? 'match' : 'mismatch';
      }
    } catch {
      captured = 'unavailable';
    }
  }
  if (captured === 'mismatch') {
    return make(
      'fail',
      `captured text differs from the selection: "${capturedText ?? ''}"`,
      expected,
      selected,
      {
        ...placement,
        captured,
        capturedText,
      },
    );
  }
  return make('pass', '', expected, selected, { ...placement, captured, capturedText });
}

export interface Summary {
  total: number;
  pass: number;
  fail: number;
  invalid: number;
  /** pass / (pass + fail); invalid attempts (the browser did not select the target) are excluded. */
  rate: number;
}

export function summarize(attempts: Attempt[]): Summary {
  const pass = attempts.filter((a) => a.outcome === 'pass').length;
  const fail = attempts.filter((a) => a.outcome === 'fail').length;
  const invalid = attempts.filter((a) => a.outcome === 'invalid').length;
  return {
    total: attempts.length,
    pass,
    fail,
    invalid,
    rate: pass + fail === 0 ? 0 : pass / (pass + fail),
  };
}

export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ] as number;
}

export type { Kind };
export { methodsFor, SEL, toolbar };
