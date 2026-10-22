import type { browser } from 'wxt/browser';
import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import {
  OBSERVER_SCRIPT_PATH,
  UI_SCRIPT_PATH,
  isInjectTabMessage,
  isInjectUiMessage,
  openSelectionMessage,
  type InjectReason,
  type InjectResult,
} from './messages';

type Scripting = Pick<typeof browser.scripting, 'executeScript'>;
type Tabs = Pick<typeof browser.tabs, 'sendMessage'>;

export interface InjectionDeps {
  scripting: Scripting;
  tabs: Tabs;
  /** `runtime.id`, to reject messages from other extensions. */
  runtimeId: string;
  /** `runtime.getURL('/')`, to tell extension pages from content scripts. */
  extensionUrlPrefix: string;
  /** Files the declined-access path injects: observer + UI, or observer only when the UI is bundled. */
  files: ScriptPublicPath[];
}

/** Which files to inject for each UI loading option (a and b load a UI script; c bundles it). */
export function filesForVariant(variant: 'a' | 'b' | 'c'): ScriptPublicPath[] {
  return variant === 'c' ? [OBSERVER_SCRIPT_PATH] : [OBSERVER_SCRIPT_PATH, UI_SCRIPT_PATH];
}

const RESTRICTED_HOSTS = new Set(['chromewebstore.google.com']);

/**
 * Only http(s) pages can be scripted. The Chrome Web Store is http(s) but
 * blocked by Chrome, so it is treated as restricted too. Anything without a
 * URL is allowed through: the real attempt decides.
 */
export function isInjectableUrl(url: string | undefined): boolean {
  if (url === undefined || url === '') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (RESTRICTED_HOSTS.has(parsed.hostname)) return false;
  return !(parsed.hostname === 'chrome.google.com' && parsed.pathname.startsWith('/webstore'));
}

/** Map a Chrome scripting error to a user-facing reason. Never includes page data. */
export function classifyInjectError(error: unknown): InjectReason {
  const message = error instanceof Error ? error.message : '';
  if (/gallery|chrome:\/\/|chrome-extension:\/\/|about:|view-source/i.test(message)) {
    return 'restricted';
  }
  if (/cannot access|must request permission|activeTab/i.test(message)) return 'no-access';
  return 'failed';
}

type Injected = { ok: true; frames: number[] } | { ok: false; reason: InjectReason };

/** Inject into one frame, or (frameId undefined) into every frame the grant covers. */
async function injectFiles(
  scripting: Scripting,
  tabId: number,
  frameId: number | undefined,
  files: ScriptPublicPath[],
): Promise<Injected> {
  try {
    const results = await scripting.executeScript({
      target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
      files,
    });
    return { ok: true, frames: frameId === undefined ? results.map((r) => r.frameId) : [frameId] };
  } catch (error) {
    return { ok: false, reason: classifyInjectError(error) };
  }
}

/** Ask one injected observer to show the toolbar for its selection. */
async function openSelection(
  tabs: Tabs,
  tabId: number,
  frameId: number,
  focus: boolean,
): Promise<boolean> {
  try {
    const reply = (await tabs.sendMessage(tabId, openSelectionMessage(focus), { frameId })) as
      { ok?: boolean; shown?: boolean } | undefined;
    return reply?.shown === true;
  } catch {
    return false;
  }
}

/**
 * Declined-access path (D-02 step 5, FR-018): with only the `activeTab` grant,
 * inject observer + UI into ONE frame (context menu) or all reachable frames
 * (popup button, shortcut) of ONE tab, then open the toolbar for the selection
 * that is already there. Never throws.
 */
export async function explainInTab(
  deps: InjectionDeps,
  target: { tabId: number; frameId: number | undefined; url: string | undefined },
  options: { focus?: boolean } = {},
): Promise<InjectResult> {
  if (!isInjectableUrl(target.url)) return { ok: false, reason: 'restricted' };
  const injected = await injectFiles(deps.scripting, target.tabId, target.frameId, deps.files);
  if (!injected.ok) return injected;
  // Only the frame that holds the selection answers `shown: true`; ask every injected frame.
  const answers = await Promise.all(
    injected.frames.map((frame) =>
      openSelection(deps.tabs, target.tabId, frame, options.focus === true),
    ),
  );
  return { ok: true, shown: answers.some(Boolean) };
}

/** Context-menu entry id. */
export const CONTEXT_MENU_ID = 'clavis-explain';

/**
 * Keyboard command name. Declared in the manifest `commands` (wxt.config.ts, proposed in the
 * Spike B report); the handler below is inert until then. A command is a user gesture, so it
 * also grants `activeTab`: it is a third way in for users who declined site access.
 */
export const COMMAND_EXPLAIN = 'explain-selection';

export function handleCommand(
  deps: InjectionDeps,
  command: string,
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
): Promise<InjectResult> | undefined {
  if (command !== COMMAND_EXPLAIN) return undefined;
  if (tab?.id === undefined) return Promise.resolve({ ok: false, reason: 'failed' });
  // The selection may be in any frame, and keyboard users need focus moved into the toolbar.
  return explainInTab(deps, { tabId: tab.id, frameId: undefined, url: tab.url }, { focus: true });
}

export function handleContextMenuClick(
  deps: InjectionDeps,
  info: { menuItemId: string | number; frameId?: number | undefined; pageUrl?: string | undefined },
  tab: { id?: number | undefined; url?: string | undefined } | undefined,
): Promise<InjectResult> | undefined {
  if (info.menuItemId !== CONTEXT_MENU_ID) return undefined;
  if (tab?.id === undefined) return Promise.resolve({ ok: false, reason: 'failed' });
  return explainInTab(deps, {
    tabId: tab.id,
    frameId: info.frameId ?? 0,
    url: tab.url ?? info.pageUrl,
  });
}

interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined } | undefined;
}

/**
 * Route the Spike B messages. Returns a pending reply for messages it owns and
 * `undefined` for everything else, so other modules' listeners keep working.
 */
export function routeInjectionMessage(
  deps: InjectionDeps,
  raw: unknown,
  sender: SenderLike,
): Promise<InjectResult> | undefined {
  if (isInjectUiMessage(raw)) {
    // Option (a): a content script asks for the UI to be injected into its own frame.
    const tabId = sender.tab?.id;
    if (sender.id !== deps.runtimeId || tabId === undefined) {
      return Promise.resolve({ ok: false, reason: 'failed' });
    }
    // about:blank and about:srcdoc frames run the observer through matchOriginAsFallback
    // and are fine; anything else non-http(s) is restricted.
    const inheritsOrigin = sender.url === 'about:blank' || sender.url === 'about:srcdoc';
    if (!inheritsOrigin && !isInjectableUrl(sender.url)) {
      return Promise.resolve({ ok: false, reason: 'restricted' });
    }
    return injectFiles(deps.scripting, tabId, sender.frameId ?? 0, [UI_SCRIPT_PATH]).then(
      (injected) => (injected.ok ? { ok: true, shown: false } : injected),
    );
  }
  if (isInjectTabMessage(raw)) {
    // Popup fallback: only extension pages may inject into an arbitrary tab.
    const fromExtensionPage =
      sender.id === deps.runtimeId && sender.url?.startsWith(deps.extensionUrlPrefix) === true;
    if (!fromExtensionPage) return Promise.resolve({ ok: false, reason: 'failed' });
    return explainInTab(deps, { tabId: raw.tabId, frameId: undefined, url: raw.url });
  }
  return undefined;
}
