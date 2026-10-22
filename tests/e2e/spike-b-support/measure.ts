import type { BrowserContext, Page } from '@playwright/test';

/**
 * Page-side timing probe, injected with addInitScript so it runs in the MAIN world before
 * any page script. Both timestamps come from the same `performance.now()` clock:
 *
 *   t0     the last `mouseup` / `keyup` that ended the selection (capture phase, so it runs
 *          before the extension's own listener).
 *   tDom   a MutationObserver saw the toolbar host switch from display:none to display:block
 *          while popover-open (the root is closed, so the host is all a page can see; the
 *          extension renders, measures and positions the toolbar before it flips it). The
 *          observer callback runs as a microtask right after the extension's task, so
 *          this is accurate to well under 1 ms.
 *   tFrame the first requestAnimationFrame after tDom, i.e. when the browser starts the
 *          frame that paints the toolbar. This overestimates by 0..16.7 ms (avg ~8 ms at
 *          60 Hz) and is the conservative number.
 *
 * Neither includes the time Chrome needs to rasterize and present the frame, and Playwright's
 * CDP latency is excluded (nothing is timed on the Node side).
 */
export const PROBE_SCRIPT = `(() => {
  if (window.__clavisT) return;
  const t = { t0: null, tDom: null, tFrame: null };
  window.__clavisT = t;
  window.__clavisReset = () => { t.t0 = null; t.tDom = null; t.tFrame = null; };
  const mark = () => { t.t0 = performance.now(); t.tDom = null; t.tFrame = null; };
  addEventListener('mouseup', mark, true);
  addEventListener('keyup', mark, true);
  // The toolbar root is closed, so the page cannot look inside. What it CAN see is the host
  // element: a plain div[popover] that is display:none while idle, and display:block and
  // popover-open once the toolbar has been rendered, measured and positioned (all in one
  // task), so "host shown" is the same instant the toolbar becomes visible.
  const shown = () => {
    const host = document.querySelector(':root > div[popover]');
    return !!host && host.style.display === 'block' && host.matches(':popover-open');
  };
  const check = () => {
    if (t.t0 === null || t.tDom !== null || !shown()) return;
    t.tDom = performance.now();
    requestAnimationFrame(() => { t.tFrame = performance.now(); });
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
})();`;

export interface Timing {
  /** t0 to toolbar visible in the DOM (ms). */
  dom: number;
  /** t0 to the first frame that paints it (ms). */
  frame: number;
}

export async function installProbe(page: Page): Promise<void> {
  await page.addInitScript(PROBE_SCRIPT);
}

export async function resetProbe(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __clavisReset(): void }).__clavisReset());
}

/** Wait for the probe to finish a measurement and read it. */
export async function readTiming(page: Page): Promise<Timing> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __clavisT?: { tFrame: number | null } }).__clavisT?.tFrame != null,
    null,
    { timeout: 5000 },
  );
  const t = await page.evaluate(
    () =>
      (window as unknown as { __clavisT: { t0: number; tDom: number; tFrame: number } }).__clavisT,
  );
  return { dom: t.tDom - t.t0, frame: t.tFrame - t.t0 };
}

export async function throttleCpu(
  context: BrowserContext,
  page: Page,
  rate: number,
): Promise<void> {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/**
 * Stop the extension's service worker, as Chrome does after ~30 s idle, so the next
 * message pays the cold start. The worker is only visible to the ServiceWorker CDP domain
 * through a page of the extension's own origin, hence the helper page.
 */
export async function stopExtensionWorker(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  const helper = await context.newPage();
  try {
    await helper.goto(`chrome-extension://${extensionId}/popup.html`);
    const cdp = await context.newCDPSession(helper);
    const versions = new Map<string, { runningStatus: string }>();
    cdp.on('ServiceWorker.workerVersionUpdated', ({ versions: list }) => {
      for (const version of list) versions.set(version.versionId, version);
    });
    await cdp.send('ServiceWorker.enable');
    await helper.waitForTimeout(150);
    for (const [versionId, version] of versions) {
      if (version.runningStatus === 'running') {
        await cdp.send('ServiceWorker.stopWorker', { versionId });
      }
    }
    await helper.waitForTimeout(250);
  } finally {
    await helper.close();
  }
}

export interface Stats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile on the sorted sample. */
export function summarize(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ??
    NaN;
  return {
    n: sorted.length,
    min: sorted[0] ?? NaN,
    p50: rank(50),
    p95: rank(95),
    max: sorted[sorted.length - 1] ?? NaN,
    mean: sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1),
  };
}
