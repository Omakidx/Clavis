import type { BrowserContext, Page, Worker } from '@playwright/test';

/** The id Chrome gave the tab showing `page` (read in the service worker, where tab urls are visible). */
export async function tabIdOf(worker: Worker, page: Page): Promise<number> {
  const url = page.url();
  return (await worker.evaluate(
    `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(url)})?.id)`,
  )) as number;
}

/**
 * The side panel page for `tabId`, opened as an ordinary tab. The real panel is the same page at
 * the same path (`sidepanel.html?tab=<id>`), but a Playwright page can be driven with locators.
 * Its sender is tab-bearing here (the real panel is tab-less); the router treats both as the panel.
 */
export async function openPanelPage(
  context: BrowserContext,
  extensionId: string,
  tabId: number,
): Promise<Page> {
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tab=${tabId}`);
  return panel;
}

/** The side panels Chrome really created (a `SIDE_PANEL` context), as their document urls. */
export async function realPanelUrls(worker: Worker): Promise<string[]> {
  return (await worker.evaluate(
    `chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then((c) => c.map((x) => x.documentUrl))`,
  )) as string[];
}

/** Per-tab options Chrome holds for the side panel. */
export function panelOptions(
  worker: Worker,
  tabId: number,
): Promise<{ enabled: boolean; path?: string; tabId?: number }> {
  return worker.evaluate(`chrome.sidePanel.getOptions({ tabId: ${tabId} })`) as Promise<{
    enabled: boolean;
    path?: string;
  }>;
}
