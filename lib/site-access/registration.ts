import type { browser } from 'wxt/browser';
import { CONTENT_SCRIPT_ID, OPTIONAL_SITE_ORIGINS } from '../config/constants';
import { hostnameSchema } from '../contracts/setup';
import { OBSERVER_SCRIPT_FILE } from './messages';

type Permissions = Pick<typeof browser.permissions, 'contains'>;
type Scripting = Pick<
  typeof browser.scripting,
  'registerContentScripts' | 'unregisterContentScripts' | 'updateContentScripts'
> & {
  getRegisteredContentScripts(filter?: {
    ids?: string[];
  }): Promise<{ id: string; excludeMatches?: string[] | undefined }[]>;
};
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
 * What the user's preferences ask of the registration (FR-006, FR-009). The observer
 * cannot read preferences itself (storage is locked down to trusted contexts), so the
 * background translates them into registration state.
 */
export interface SitePolicy {
  /** `tooltipBehavior === 'automatic'`. On-demand keeps the observer unregistered. */
  automatic: boolean;
  /** Hostnames the user disabled Clavis on. Each is excluded exactly (no subdomains). */
  disabledSites: readonly string[];
}

export const DEFAULT_SITE_POLICY: SitePolicy = { automatic: true, disabledSites: [] };

/**
 * `excludeMatches` for a policy: the Web Store hosts plus `*://<host>/*` per disabled
 * site. The `*` scheme matches http and https and the pattern ignores the port. Entries
 * that are not valid hostnames are dropped, so one bad value can never make Chrome reject
 * the whole registration.
 */
export function excludeMatchesFor(disabledSites: readonly string[]): string[] {
  const hosts = new Set<string>();
  for (const host of disabledSites) {
    if (hostnameSchema.safeParse(host).success) hosts.add(host);
  }
  return [...EXCLUDED_MATCHES, ...[...hosts].map((host) => `*://${host}/*`)];
}

/**
 * The runtime-registered observer (D-02, architecture section 3 step 3). The
 * `matches` are the optional host permissions themselves: the script only runs
 * where Chrome has actually granted access.
 */
export function buildRegisteredScript(policy: SitePolicy = DEFAULT_SITE_POLICY): RegisteredScript {
  return {
    id: CONTENT_SCRIPT_ID,
    js: [OBSERVER_SCRIPT_FILE],
    matches: [...OPTIONAL_SITE_ORIGINS],
    excludeMatches: excludeMatchesFor(policy.disabledSites),
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
async function writeScript(
  write: (scripts: RegisteredScript[]) => Promise<void>,
  policy: SitePolicy,
): Promise<void> {
  try {
    await write([buildRegisteredScript(policy)]);
  } catch (error) {
    if (!/matchOriginAsFallback|unexpected property/i.test(String(error))) throw error;
    const { matchOriginAsFallback: _unsupported, ...legacy } = buildRegisteredScript(policy);
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

/**
 * - `registered`   the observer was NOT registered and now is (open tabs need injecting)
 * - `refreshed`    it was registered and was rewritten in place (forced, or exclusions changed)
 * - `unregistered` it was removed (access revoked, or on-demand mode)
 * - `unchanged`    nothing to do
 */
export type ReconcileOutcome = 'registered' | 'refreshed' | 'unregistered' | 'unchanged';

type Registered = Awaited<ReturnType<Scripting['getRegisteredContentScripts']>>[number];

async function findRegistered(scripting: Scripting): Promise<Registered | undefined> {
  const found = await scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  return found[0];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

export interface ReconcileOptions {
  force?: boolean;
  policy?: SitePolicy;
}

/**
 * Make the registration match the grant and the policy. Idempotent: safe to run on every
 * worker start, on install/update, on every permission event and on every preference change.
 *
 * The observer is registered only while access is granted AND the tooltip is automatic.
 * In on-demand mode it stays unregistered: the context menu, popup and shortcut still work
 * through `activeTab`.
 *
 * An existing registration is rewritten in place (`updateContentScripts`, never
 * unregister + register, so pages never load without the observer) when `force` is set
 * (extension update, so a stale `js` path cannot linger) or when its exclusions no longer
 * match the disabled-sites list.
 */
export async function reconcileRegistration(
  deps: RegistrationDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const policy = options.policy ?? DEFAULT_SITE_POLICY;
  const [granted, existing] = await Promise.all([
    hasSiteAccess(deps.permissions),
    findRegistered(deps.scripting),
  ]);
  if (!granted || !policy.automatic) {
    if (existing === undefined) return 'unchanged';
    await deps.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return 'unregistered';
  }
  if (existing !== undefined) {
    const drifted = !sameSet(
      existing.excludeMatches ?? [],
      excludeMatchesFor(policy.disabledSites),
    );
    if (options.force !== true && !drifted) return 'unchanged';
    await writeScript((scripts) => deps.scripting.updateContentScripts(scripts), policy);
    return 'refreshed';
  }
  await writeScript((scripts) => deps.scripting.registerContentScripts(scripts), policy);
  return 'registered';
}

/** Whether the observer is registered right now. Never throws. */
export async function isObserverRegistered(scripting: Scripting): Promise<boolean> {
  try {
    return (await findRegistered(scripting)) !== undefined;
  } catch {
    return false;
  }
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run reconciliations one at a time. `permissions.onAdded` and the startup
 * check can overlap, and registering the same id twice is an error.
 */
export function reconcileSerialized(
  deps: RegistrationDeps,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  const run = queue.then(() => reconcileRegistration(deps, options));
  queue = run.catch(() => undefined);
  return run;
}
