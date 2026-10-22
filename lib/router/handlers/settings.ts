import { ZodError } from 'zod';
import type {
  ClearAllDataResult,
  MessageReply,
  PreferencesPatch,
  SettingsSnapshot,
  SiteAccessStatus,
} from '../../contracts';
import { logger } from '../../security/logger';
import type { SiteAccessController } from '../../site-access/controller';
import {
  clearClavisStorage,
  type ApiKeyStore,
  type SettingsStore,
  type StorageAreaLike,
  type OnboardingPatch,
} from '../../storage';
import type { AiGuard } from '../limiter';
import { failure, success } from '../replies';

export interface SettingsHandlerDeps {
  settings: SettingsStore;
  /** Its queue serialises CLEAR_ALL_DATA with SET/REMOVE_API_KEY. */
  keys: Pick<ApiKeyStore, 'exclusive'>;
  siteAccess: Pick<SiteAccessController, 'reconcile' | 'getStatus'>;
  guard: AiGuard;
  areas: StorageAreaLike[];
}

/** Preference fields that change what the observer registration should look like. */
const SITE_POLICY_FIELDS = ['tooltipBehavior', 'disabledSites'] as const;

export function createSettingsHandlers(deps: SettingsHandlerDeps) {
  const { settings } = deps;

  /** Re-apply the site policy; the settings write has already succeeded, so a failure here only logs. */
  async function applySitePolicy(): Promise<void> {
    try {
      await deps.siteAccess.reconcile();
    } catch {
      logger.warn('site_policy_apply_failed');
    }
  }

  async function snapshot(): Promise<MessageReply<SettingsSnapshot>> {
    return success(await settings.getSnapshot());
  }

  return {
    getSettings: snapshot,

    async updatePreferences(patch: PreferencesPatch): Promise<MessageReply<SettingsSnapshot>> {
      try {
        await settings.updatePreferences(patch);
      } catch (error) {
        if (error instanceof ZodError) return failure('INVALID_REQUEST');
        throw error;
      }
      if (SITE_POLICY_FIELDS.some((field) => field in patch)) await applySitePolicy();
      return snapshot();
    },

    async resetPreferences(): Promise<MessageReply<SettingsSnapshot>> {
      await settings.resetPreferences();
      await applySitePolicy();
      return snapshot();
    },

    async acceptDisclosure(): Promise<MessageReply<SettingsSnapshot>> {
      await settings.acceptDisclosure();
      return snapshot();
    },

    async updateOnboarding(patch: OnboardingPatch): Promise<MessageReply<SettingsSnapshot>> {
      await settings.updateOnboarding(patch);
      return snapshot();
    },

    async getSiteAccessStatus(): Promise<MessageReply<SiteAccessStatus>> {
      const [status, onboarding] = await Promise.all([
        deps.siteAccess.getStatus(),
        settings.getOnboarding(),
      ]);
      return success({ ...status, choice: onboarding.siteAccessChoice });
    },

    /**
     * FR-078. Removes the key (both areas), key metadata, preferences, onboarding state and
     * every other Clavis record, and aborts in-flight AI requests and forgets rate-limit state.
     *
     * It does NOT revoke Chrome permissions: optional site access stays granted until the
     * user revokes it. Deleting data must not silently change what Clavis may read, and
     * Settings has an explicit Revoke. The status route keeps reporting the live grant. The
     * registration is re-applied so per-site exclusions and on-demand mode reset together
     * with the preferences.
     */
    async clearAllData(): Promise<MessageReply<ClearAllDataResult>> {
      // Queue behind (and ahead of) key and settings writes, so a concurrent SET_API_KEY or
      // preference update cannot interleave with the sweep and leave a record behind.
      await deps.keys.exclusive(() => settings.exclusive(() => clearClavisStorage(deps.areas)));
      deps.guard.inFlight.abortAll();
      deps.guard.buckets.clear();
      await applySitePolicy();
      return success({ cleared: true });
    },
  };
}

export type SettingsHandlers = ReturnType<typeof createSettingsHandlers>;
