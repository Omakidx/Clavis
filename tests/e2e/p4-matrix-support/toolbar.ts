import type { Page } from '@playwright/test';
import { SEL, tb, type ActionName, type ToolbarProbe } from '../spike-b-support/toolbar';
import { frameOffset, pageOf, type Box, type Surface } from './page';

/**
 * The ONE place that knows how the matrix reaches the toolbar. The toolbar's root is closed, so it
 * is read through the DevTools protocol helper written for Spike B (no test hook ships in the
 * extension). If the implementer renames that helper or its selectors, adapt this file only.
 *
 * Observable contract relied on (all inside the closed root):
 *   [data-clavis="panel"][data-kind=word|phrase|sentence|passage]
 *   [data-clavis="toolbar"] with role=toolbar and an accessible name
 *   button[data-action=listen|slow|explain] (Slow is an aria-pressed toggle)
 *   [data-clavis="listen-status"][data-status] the Listen report line (Listen opens no card)
 *   [data-clavis="card"] / [data-clavis="card-text"]: the captured text after an action
 */
export { SEL };
export const toolbar = (surface: Surface): ToolbarProbe => tb(surface);

/** Phase 6 added the Slow toggle; the shared helper's `ActionName` does not list it yet. */
export type Action = ActionName | 'slow';

export async function readKind(surface: Surface): Promise<string | null | undefined> {
  return toolbar(surface).attr(SEL.panel, 'data-kind');
}

export async function toolbarBox(surface: Surface): Promise<Box> {
  return toolbar(surface).box();
}

/** Text of the whole closed root (every state message and label). */
export async function rootText(surface: Surface): Promise<string> {
  return (
    (await toolbar(surface).evalIn<string>(
      null,
      `function () { return this.textContent ?? ''; }`,
    )) ?? ''
  );
}

/** Accessible names of every button in the root, in DOM order. */
export async function buttonNames(surface: Surface): Promise<string[]> {
  return (
    (await toolbar(surface).evalIn<string[]>(
      null,
      `function () {
        return Array.from(this.querySelectorAll('button, [role=button]')).map(
          (b) => (b.getAttribute('aria-label') || b.textContent || '').trim(),
        );
      }`,
    )) ?? []
  );
}

/** Real mouse click on the first button whose visible name matches `pattern`. */
export async function clickButtonNamed(
  page: Page,
  surface: Surface,
  pattern: RegExp,
): Promise<void> {
  const box = await toolbar(surface).evalIn<Box | null>(
    null,
    `function () {
      const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const button = Array.from(this.querySelectorAll('button, [role=button]')).find((b) =>
        pattern.test((b.getAttribute('aria-label') || b.textContent || '').trim()),
      );
      if (!button) return null;
      const r = button.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    }`,
  );
  if (box === undefined || box === null) throw new Error(`no button matching ${pattern}`);
  const offset = await frameOffset(surface);
  await page.mouse.click(offset.x + box.x + box.width / 2, offset.y + box.y + box.height / 2);
}

/** Real click on a toolbar button (Listen, Explain, and the too-long state's trim action). */
export async function clickAction(surface: Surface, action: Action): Promise<void> {
  await toolbar(surface).click(action as ActionName);
}

/** Selector of a toolbar button by its data-action (Listen, Slow, Explain, trim, close). */
export const actionSelector = (action: Action): string => SEL.action(action as ActionName);

export const LISTEN_STATUS = '[data-clavis="listen-status"]';

/** The Listen report line (Phase 6): its `data-status` and visible text, or undefined when absent. */
export async function readListenStatus(
  surface: Surface,
  timeoutMs = 3000,
): Promise<{ status: string | null; text: string } | undefined> {
  const probe = toolbar(surface);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe
      .evalIn<{ status: string | null; text: string }>(
        LISTEN_STATUS,
        `function () { return { status: this.getAttribute('data-status'), text: (this.textContent || '').trim() }; }`,
      )
      .catch(() => undefined);
    if (value !== undefined && value.text !== '') return value;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
}

/** `data-mode` of the panel: actions | too-long | notice (null when the build has no such attribute). */
export async function readMode(surface: Surface): Promise<string | null | undefined> {
  return toolbar(surface).attr(SEL.panel, 'data-mode');
}

/** The captured text the card shows after an action, or undefined when no card appears. */
export async function readCardText(surface: Surface, timeoutMs = 600): Promise<string | undefined> {
  const probe = toolbar(surface);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await probe.text(SEL.cardText).catch(() => undefined);
    if (text !== undefined && text !== '') return text;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** Page that owns a surface (frames included). */
export const owner = (surface: Surface): Page => pageOf(surface);
