import type { browser } from 'wxt/browser';
import { CONTENT_SCRIPT_ID, OPTIONAL_SITE_ORIGINS } from '../config/constants';
import { OBSERVER_SCRIPT_FILE } from './messages';

type Permissions = Pick<typeof browser.permissions, 'contains'>;
type Scripting = Pick<
  typeof browser.scripting,
  | 'registerContentScripts'
  | 'unregisterContentScripts'
  | 'getRegisteredContentScripts'
  | 'updateContentScripts'
>;
type RegisteredScript = Parameters<typeof browser.scripting.registerContentScripts>[0][number];

export interface RegistrationDeps {
  permissions: Permissions;
  scripting: Scripting;
}

/** Pages where Chrome never runs extension scripts; excluding them avoids pointless injection attempts. */
export const EXCLUDED_MATCHES = [
  'https://chromewebstore.google.com/*',
  'https://chrome.google.com/webstore/*',
] as const;

/**
 * The runtime-registered observer (D-02, architecture section 3 step 3). The
 * `matches` are the optional host permissions themselves: the script only runs
 * where Chrome has actually granted access.
 */
export function buildRegisteredScript(): RegisteredScript {
  return {
    id: CONTENT_SCRIPT_ID,
    js: [OBSERVER_SCRIPT_FILE],
    matches: [...OPTIONAL_SITE_ORIGINS],
    excludeMatches: [...EXCLUDED_MATCHES],
    allFrames: true,
    // about:blank and srcdoc frames (reader apps, embedded editors) have no http(s) URL of their own.
    matchOriginAsFallback: true,
    runAt: 'document_idle',
    persistAcrossSessions: true,
  };
}

/**
 * `matchOriginAsFallback` is not accepted before Chrome 119. The manifest minimum is now
 * at least 119 (exact value: wxt.config.ts), so the retry below is a safety net for a
 * lowered minimum: it drops the property (losing about:blank/srcdoc frames only) instead of
 * failing to register at all.
 */
async function writeScript(write: (scripts: RegisteredScript[]) => Promise<void>): Promise<void> {
  try {
    await write([buildRegisteredScript()]);
  } catch (error) {
    if (!/matchOriginAsFallback|unexpected property/i.test(String(error))) throw error;
    const { matchOriginAsFallback: _unsupported, ...legacy } = buildRegisteredScript();
    await write([legacy]);
  }
}

/** Whether the user currently grants Clavis access to all http(s) sites. */
export async function hasSiteAccess(permissions: Permissions): Promise<boolean> {
  try {
    return await permissions.contains({ origins: [...OPTIONAL_SITE_ORIGINS] });
  } catch {
    return false;
  }
}

export type ReconcileOutcome = 'registered' | 'unregistered' | 'unchanged';

async function isRegistered(scripting: Scripting): Promise<boolean> {
  const found = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  return found.length > 0;
}

/**
 * Make the registration match the grant. Idempotent: safe to run on every
 * worker start, on install/update and on every permission event.
 *
 * `force` rewrites an existing registration in place (extension update, so a
 * stale `js` path from the previous build cannot linger). It uses
 * `updateContentScripts`, not unregister + register, so there is never a moment
 * when pages load without the observer.
 */
export async function reconcileRegistration(
  deps: RegistrationDeps,
  options: { force?: boolean } = {},
): Promise<ReconcileOutcome> {
  const [granted, registered] = await Promise.all([
    hasSiteAccess(deps.permissions),
    isRegistered(deps.scripting),
  ]);
  if (!granted) {
    if (!registered) return 'unchanged';
    await deps.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return 'unregistered';
  }
  if (registered) {
    if (options.force !== true) return 'unchanged';
    await writeScript((scripts) => deps.scripting.updateContentScripts(scripts));
    return 'registered';
  }
  await writeScript((scripts) => deps.scripting.registerContentScripts(scripts));
  return 'registered';
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run reconciliations one at a time. `permissions.onAdded` and the startup
 * check can overlap, and registering the same id twice is an error.
 */
export function reconcileSerialized(
  deps: RegistrationDeps,
  options: { force?: boolean } = {},
): Promise<ReconcileOutcome> {
  const run = queue.then(() => reconcileRegistration(deps, options));
  queue = run.catch(() => undefined);
  return run;
}
