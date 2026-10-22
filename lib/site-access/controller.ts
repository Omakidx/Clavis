import { OPTIONAL_SITE_ORIGINS } from '../config/constants';
import type { SiteAccessChoice } from '../contracts';
import { logger } from '../security/logger';
import { injectObserverIntoOpenTabs, type OpenTabsDeps } from './open-tabs';
import {
  DEFAULT_SITE_POLICY,
  hasSiteAccess,
  isObserverRegistered,
  reconcileSerialized,
  type ReconcileOutcome,
  type RegistrationDeps,
  type SitePolicy,
} from './registration';

export interface SiteAccessControllerDeps {
  registration: RegistrationDeps;
  openTabs: OpenTabsDeps;
  /** The user's current preferences, as a registration policy. Read on every reconcile. */
  readPolicy(): Promise<SitePolicy>;
  /** Persist what the user chose (FR-009) so onboarding never re-prompts. */
  recordChoice(choice: Extract<SiteAccessChoice, 'granted' | 'declined'>): Promise<void>;
}

export interface SiteAccessController {
  /**
   * Make the registration match the grant and the preferences. When this newly registers
   * the observer, already-open tabs get it too, so nobody has to reload.
   */
  reconcile(options?: { force?: boolean }): Promise<ReconcileOutcome>;
  /** Live grant and registration state for GET_SITE_ACCESS_STATUS. */
  getStatus(): Promise<{ granted: boolean; registered: boolean }>;
  /** `permissions.onAdded`: reconcile, and persist the choice if our origins were granted. */
  handlePermissionsAdded(permissions: { origins?: string[] | undefined }): Promise<void>;
  /** `permissions.onRemoved`: reconcile, and persist the choice if our origins were revoked. */
  handlePermissionsRemoved(permissions: { origins?: string[] | undefined }): Promise<void>;
}

function touchesSiteOrigins(permissions: { origins?: string[] | undefined }): boolean {
  const origins = permissions.origins ?? [];
  return OPTIONAL_SITE_ORIGINS.some((origin) => origins.includes(origin));
}

export function createSiteAccessController(deps: SiteAccessControllerDeps): SiteAccessController {
  async function policy(): Promise<SitePolicy> {
    try {
      return await deps.readPolicy();
    } catch {
      return DEFAULT_SITE_POLICY;
    }
  }

  async function reconcile(options: { force?: boolean } = {}): Promise<ReconcileOutcome> {
    const current = await policy();
    const outcome = await reconcileSerialized(deps.registration, {
      ...(options.force === true ? { force: true } : {}),
      policy: current,
    });
    if (outcome === 'registered') {
      // Newly registered (grant, or back to automatic): the registered script only
      // covers later navigations, so reach the tabs that are open now.
      const result = await injectObserverIntoOpenTabs(deps.openTabs, current);
      logger.debug('site_access_open_tabs', { status: result.injected });
    }
    return outcome;
  }

  async function record(choice: 'granted' | 'declined'): Promise<void> {
    try {
      await deps.recordChoice(choice);
    } catch {
      logger.warn('site_access_choice_not_saved');
    }
  }

  return {
    reconcile,

    getStatus: async () => ({
      granted: await hasSiteAccess(deps.registration.permissions),
      registered: await isObserverRegistered(deps.registration.scripting),
    }),

    handlePermissionsAdded: async (permissions) => {
      await reconcile();
      if (touchesSiteOrigins(permissions) && (await hasSiteAccess(deps.registration.permissions))) {
        await record('granted');
      }
    },

    handlePermissionsRemoved: async (permissions) => {
      await reconcile();
      if (
        touchesSiteOrigins(permissions) &&
        !(await hasSiteAccess(deps.registration.permissions))
      ) {
        await record('declined');
      }
    },
  };
}
