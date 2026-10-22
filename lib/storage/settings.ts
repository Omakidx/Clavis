import type { z } from 'zod';
import {
  DEFAULT_ONBOARDING,
  DEFAULT_PREFERENCES,
  onboardingStateSchema,
  preferencesSchema,
  type OnboardingState,
  type Preferences,
  type PreferencesPatch,
  type SettingsSnapshot,
  type SiteAccessChoice,
} from '../contracts';
import { createQueue, type StorageAreaLike } from './area';
import { StorageUnavailableError } from './errors';
import { STORAGE_KEYS, unwrapRecord, wrapRecord } from './keys';

/** Fields the onboarding routes may change. `disclosureAcceptedAt` has its own method. */
export interface OnboardingPatch {
  completed?: boolean | undefined;
  siteAccessChoice?: SiteAccessChoice | undefined;
}

export interface SettingsStore {
  /** Always resolves: missing, corrupt or unreadable data yields defaults. */
  getPreferences(): Promise<Preferences>;
  /** Merge a validated patch (`null` clears an optional field). Rejects with StorageUnavailableError. */
  updatePreferences(patch: PreferencesPatch): Promise<Preferences>;
  /**
   * FR-006: language, reading level, speed, tooltip behaviour, voice and model go back to
   * `DEFAULT_PREFERENCES`. The per-site disable list (FR-009) is managed separately and is KEPT.
   */
  resetPreferences(): Promise<Preferences>;
  getOnboarding(): Promise<OnboardingState>;
  updateOnboarding(patch: OnboardingPatch): Promise<OnboardingState>;
  /** FR-002. Idempotent: the first acknowledgement time is kept. */
  acceptDisclosure(): Promise<OnboardingState>;
  getSnapshot(): Promise<SettingsSnapshot>;
  /** Run `task` after every queued write and before the next (CLEAR_ALL_DATA). */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

export interface SettingsStoreDeps {
  area: StorageAreaLike;
  now?: () => number;
}

function defaultPreferences(): Preferences {
  return { ...DEFAULT_PREFERENCES, disabledSites: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dedupe(sites: readonly string[]): string[] {
  return [...new Set(sites)];
}

/**
 * Validate stored preferences. A record that fails as a whole is repaired field by
 * field, so one corrupt value resets only itself and never the user's other choices.
 */
export function parsePreferences(raw: unknown): Preferences {
  const data = unwrapRecord(raw);
  if (data === undefined) return defaultPreferences();
  const whole = preferencesSchema.safeParse(data);
  if (whole.success) return { ...whole.data, disabledSites: dedupe(whole.data.disabledSites) };

  const source = isRecord(data) ? data : {};
  const repaired: Record<string, unknown> = { ...defaultPreferences() };
  for (const [field, schema] of Object.entries(preferencesSchema.shape) as [string, z.ZodType][]) {
    const parsed = schema.safeParse(source[field]);
    if (parsed.success && parsed.data !== undefined) repaired[field] = parsed.data;
  }
  const result = preferencesSchema.safeParse(repaired);
  return result.success ? result.data : defaultPreferences();
}

export function parseOnboarding(raw: unknown): OnboardingState {
  const data = unwrapRecord(raw);
  const whole = onboardingStateSchema.safeParse(data);
  if (whole.success) return whole.data;
  const source = isRecord(data) ? data : {};
  const repaired: Record<string, unknown> = { ...DEFAULT_ONBOARDING };
  for (const [field, schema] of Object.entries(onboardingStateSchema.shape) as [
    string,
    z.ZodType,
  ][]) {
    const parsed = schema.safeParse(source[field]);
    if (parsed.success) repaired[field] = parsed.data;
  }
  const result = onboardingStateSchema.safeParse(repaired);
  return result.success ? result.data : { ...DEFAULT_ONBOARDING };
}

/** Apply a validated patch: `null` removes an optional field, `undefined` leaves it alone. */
export function applyPreferencesPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const next: Record<string, unknown> = { ...current };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[field];
    else next[field] = value;
  }
  const merged = preferencesSchema.parse(next);
  return { ...merged, disabledSites: dedupe(merged.disabledSites) };
}

export function createSettingsStore(deps: SettingsStoreDeps): SettingsStore {
  const { area } = deps;
  const now = deps.now ?? Date.now;
  const serial = createQueue();

  async function readRaw(key: string): Promise<unknown> {
    try {
      return (await area.get(key))[key];
    } catch {
      // Reads never throw: unreadable storage behaves like empty storage.
      return undefined;
    }
  }

  async function write(key: string, data: unknown): Promise<void> {
    try {
      await area.set({ [key]: wrapRecord(data) });
    } catch {
      throw new StorageUnavailableError();
    }
  }

  const getPreferences = async (): Promise<Preferences> =>
    parsePreferences(await readRaw(STORAGE_KEYS.preferences));
  const getOnboarding = async (): Promise<OnboardingState> =>
    parseOnboarding(await readRaw(STORAGE_KEYS.onboarding));

  return {
    getPreferences,
    getOnboarding,
    exclusive: serial,

    updatePreferences: (patch) =>
      serial(async () => {
        const next = applyPreferencesPatch(await getPreferences(), patch);
        await write(STORAGE_KEYS.preferences, next);
        return next;
      }),

    resetPreferences: () =>
      serial(async () => {
        const { disabledSites } = await getPreferences();
        const next: Preferences = { ...defaultPreferences(), disabledSites };
        try {
          if (disabledSites.length === 0) await area.remove(STORAGE_KEYS.preferences);
          else await area.set({ [STORAGE_KEYS.preferences]: wrapRecord(next) });
        } catch {
          throw new StorageUnavailableError();
        }
        return next;
      }),

    updateOnboarding: (patch) =>
      serial(async () => {
        const current = await getOnboarding();
        const next: OnboardingState = {
          ...current,
          ...(patch.completed === undefined ? {} : { completed: patch.completed }),
          ...(patch.siteAccessChoice === undefined
            ? {}
            : { siteAccessChoice: patch.siteAccessChoice }),
        };
        await write(STORAGE_KEYS.onboarding, next);
        return next;
      }),

    acceptDisclosure: () =>
      serial(async () => {
        const current = await getOnboarding();
        if (current.disclosureAcceptedAt !== null) return current;
        const next: OnboardingState = { ...current, disclosureAcceptedAt: now() };
        await write(STORAGE_KEYS.onboarding, next);
        return next;
      }),

    getSnapshot: async () => ({
      preferences: await getPreferences(),
      onboarding: await getOnboarding(),
    }),
  };
}
