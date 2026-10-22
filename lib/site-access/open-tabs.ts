import type { browser } from 'wxt/browser';
import { OPTIONAL_SITE_ORIGINS } from '../config/constants';
import { isInjectableUrl } from './injection';
import { OBSERVER_SCRIPT_PATH } from './messages';
import type { SitePolicy } from './registration';

interface TabLike {
  id?: number | undefined;
  url?: string | undefined;
  discarded?: boolean | undefined;
}
type Tabs = { query(queryInfo: { url: string[] }): Promise<TabLike[]> };
type Scripting = Pick<typeof browser.scripting, 'executeScript'>;

export interface OpenTabsDeps {
  tabs: Tabs;
  scripting: Scripting;
}

export interface OpenTabsResult {
  injected: number;
  skipped: number;
  failed: number;
}

/** Tabs injected at once: enough to be quick, few enough not to stall the worker. */
const CONCURRENCY = 4;
/** Safety cap on how many open tabs one grant touches. */
const MAX_TABS = 300;

function hostOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    // `host.` (a trailing dot) is the same site as `host` but a different string.
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return undefined;
  }
}

/**
 * Inject the observer into already-open http(s) tabs, so a user who just granted site
 * access does not have to reload (Spike B finding 4). The registered script only runs on
 * later navigations. After the grant `tabs.query({ url })` works because Chrome now
 * reports URLs for those origins.
 *
 * Only the top frame of each tab is injected (see below). Skips restricted pages (Web Store), discarded tabs (they get the registered script when
 * they load) and sites the user disabled. Failures are tolerated and counted: a tab can
 * navigate or close between the query and the injection. A tab that already has the
 * observer (registered script raced us) is safe: the observer guards against a second copy.
 * Never throws and never logs page data.
 */
export async function injectObserverIntoOpenTabs(
  deps: OpenTabsDeps,
  policy: SitePolicy,
): Promise<OpenTabsResult> {
  const result: OpenTabsResult = { injected: 0, skipped: 0, failed: 0 };
  let tabs: TabLike[];
  try {
    tabs = await deps.tabs.query({ url: [...OPTIONAL_SITE_ORIGINS] });
  } catch {
    return result;
  }
  const disabled = new Set(policy.disabledSites);
  const targets: number[] = [];
  for (const tab of tabs.slice(0, MAX_TABS)) {
    const host = hostOf(tab.url);
    const eligible =
      tab.id !== undefined &&
      tab.discarded !== true &&
      tab.url !== undefined &&
      isInjectableUrl(tab.url) &&
      (host === undefined || !disabled.has(host));
    if (eligible) targets.push(tab.id as number);
    else result.skipped += 1;
  }

  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < targets.length; index = next++) {
      try {
        await deps.scripting.executeScript({
          // Top frame only. `allFrames` would also reach iframes of disabled sites (executeScript
          // ignores excludeMatches); subframes get the observer on their next load through the
          // registration, which does honour the exclusions.
          target: { tabId: targets[index] as number, frameIds: [0] },
          files: [OBSERVER_SCRIPT_PATH],
        });
        result.injected += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));
  return result;
}
