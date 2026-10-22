import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';

/**
 * Drive Chrome's NATIVE UI (permission prompt, context menu, extensions menu) with
 * xdotool. Playwright cannot see these. Needs a display, so run under `xvfb-run -a`
 * with CLAVIS_E2E_REAL_UI=1; the coordinates were tuned for Chrome for Testing 156
 * on Linux with the default window layout and may need adjusting for other builds.
 */
export const realUiEnabled = process.env['CLAVIS_E2E_REAL_UI'] === '1';

export function xdotool(...args: string[]): string {
  return execFileSync('xdotool', args, { encoding: 'utf8' }).trim();
}

export function screenshotRoot(path: string): void {
  execFileSync('import', ['-window', 'root', path]);
}

/** Geometry of the (only) visible Chromium window. */
export function browserWindow(): { x: number; y: number; width: number; height: number } {
  const id = xdotool('search', '--onlyvisible', '--name', '.').split('\n')[0] as string;
  const geometry = xdotool('getwindowgeometry', id);
  const position = /Position: (-?\d+),(-?\d+)/.exec(geometry);
  const size = /Geometry: (\d+)x(\d+)/.exec(geometry);
  if (position === null || size === null) throw new Error(`cannot parse ${geometry}`);
  return {
    x: Number(position[1]),
    y: Number(position[2]),
    width: Number(size[1]),
    height: Number(size[2]),
  };
}

/**
 * Screen position of the page's (0,0): the window's screen offset plus its chrome
 * (tab strip and toolbar). Needs a settled window, hence the short wait.
 */
export async function contentOrigin(page: Page): Promise<{ x: number; y: number }> {
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    x: screenX + (outerWidth - innerWidth) / 2,
    y: screenY + (outerHeight - innerHeight),
  }));
}

export function moveAndClick(x: number, y: number, button: '1' | '3' = '1'): void {
  xdotool('mousemove', String(Math.round(x)), String(Math.round(y)));
  xdotool('click', button);
}

/** Right-click the on-screen centre of a viewport box, opening Chrome's context menu. */
export async function rightClickBox(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const origin = await contentOrigin(page);
  moveAndClick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2, '3');
}

/**
 * Click the Extensions (puzzle) button, then the "Clavis" entry in its menu.
 * That is the real toolbar-icon activation: it grants `activeTab` and opens the popup.
 */
export async function openClavisPopup(page: Page): Promise<void> {
  const win = browserWindow();
  const puzzleX = win.x + win.width - 113;
  const puzzleY = win.y + 63;
  moveAndClick(puzzleX, puzzleY);
  // Never block the event loop here (no `xdotool sleep`): Playwright must stay alive to
  // resume the popup target Chrome opens, or the popup never loads.
  await page.waitForTimeout(800);
  moveAndClick(puzzleX - 202, puzzleY + 141);
  await page.waitForTimeout(1200);
}

/** Click the first (primary) button of the Clavis popup. */
export function clickPopupPrimaryButton(): void {
  const win = browserWindow();
  const puzzleX = win.x + win.width - 113;
  moveAndClick(puzzleX - 163, win.y + 63 + 93);
}
