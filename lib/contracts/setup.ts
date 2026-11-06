import { z } from 'zod';
import { TTS_RATES } from '../config/constants';
import { languageTagSchema, modelIdSchema } from './primitives';
import { keyStorageSchema } from './key-storage';
import { voiceNameSchema } from './speech';

// Phase 3 contracts: preferences, onboarding state, key/AI/site-access status.
// Shared by the background (owner of storage) and the extension pages (onboarding,
// options, popup). Strict objects throughout so nothing extra can be smuggled in.

export const ttsRateSchema = z.number().min(TTS_RATES.min).max(TTS_RATES.max);

/** FR-006 reading level for explanations. */
export const readingLevelSchema = z.enum(['simple', 'standard', 'advanced']);
export type ReadingLevel = z.infer<typeof readingLevelSchema>;

/**
 * FR-006 tooltip behaviour: `automatic` shows the toolbar on every qualifying
 * selection (needs site access); `on-demand` shows it only via the context menu,
 * the popup button or the keyboard shortcut.
 */
export const tooltipBehaviorSchema = z.enum(['automatic', 'on-demand']);
export type TooltipBehavior = z.infer<typeof tooltipBehaviorSchema>;

/** Lower-case hostname for the per-site disable list (no scheme, port or path). */
export const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
    'Expected a lower-case hostname',
  );

export const MAX_DISABLED_SITES = 500;

/** User preferences (non-secret). Stored in chrome.storage.local by the background. */
export const preferencesSchema = z.strictObject({
  explanationLanguage: languageTagSchema,
  /** Translate target; absent follows explanationLanguage for existing users. */
  translationLanguage: languageTagSchema.optional(),
  readingLevel: readingLevelSchema,
  tooltipBehavior: tooltipBehaviorSchema,
  ttsRate: ttsRateSchema,
  ttsLang: languageTagSchema.optional(),
  /** Preferred voice name (FR-025); absent = best match for ttsLang / the selection. */
  ttsVoice: voiceNameSchema.optional(),
  /** Absent = use the default model chosen in D-09. */
  model: modelIdSchema.optional(),
  disabledSites: z.array(hostnameSchema).max(MAX_DISABLED_SITES),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  explanationLanguage: 'en',
  readingLevel: 'standard',
  tooltipBehavior: 'automatic',
  ttsRate: TTS_RATES.normal,
  disabledSites: [],
};

/** Partial update; at least one field. `null` clears an optional field. */
export const preferencesPatchSchema = z
  .strictObject({
    explanationLanguage: languageTagSchema.optional(),
    translationLanguage: languageTagSchema.nullable().optional(),
    readingLevel: readingLevelSchema.optional(),
    tooltipBehavior: tooltipBehaviorSchema.optional(),
    ttsRate: ttsRateSchema.optional(),
    ttsLang: languageTagSchema.nullable().optional(),
    ttsVoice: voiceNameSchema.nullable().optional(),
    model: modelIdSchema.nullable().optional(),
    disabledSites: z.array(hostnameSchema).max(MAX_DISABLED_SITES).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'Patch must change at least one field');
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;

/** What the user chose for optional all-sites access (D-02); persisted so we never re-prompt. */
export const siteAccessChoiceSchema = z.enum(['unset', 'granted', 'declined']);
export type SiteAccessChoice = z.infer<typeof siteAccessChoiceSchema>;

export const onboardingStateSchema = z.strictObject({
  completed: z.boolean(),
  /** Epoch ms when the data disclosure (FR-002, D-16) was acknowledged; null = not yet. */
  disclosureAcceptedAt: z.number().int().nonnegative().nullable(),
  siteAccessChoice: siteAccessChoiceSchema,
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const DEFAULT_ONBOARDING: OnboardingState = {
  completed: false,
  disclosureAcceptedAt: null,
  siteAccessChoice: 'unset',
};

/** Full settings snapshot for extension pages (no secrets). */
export const settingsSnapshotSchema = z.strictObject({
  preferences: preferencesSchema,
  onboarding: onboardingStateSchema,
});
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;

/**
 * Non-secret settings readable by ANY context, including content scripts
 * (secret boundary rule 3). `hasKey` is a boolean only: no field may carry the
 * key, its suffix or its storage location.
 */
export const publicSettingsSchema = z.strictObject({
  hasKey: z.boolean(),
  disclosureAccepted: z.boolean(),
  explanationLanguage: languageTagSchema,
  /** Translate target; absent follows explanationLanguage for existing users. */
  translationLanguage: languageTagSchema.optional(),
  readingLevel: readingLevelSchema,
  tooltipBehavior: tooltipBehaviorSchema,
  ttsRate: ttsRateSchema,
  ttsLang: languageTagSchema.optional(),
  model: modelIdSchema.optional(),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

/** A model the user's key can use, from the Groq model list. */
export const modelInfoSchema = z.strictObject({
  id: modelIdSchema,
  supportsJsonSchema: z.boolean(),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/** Result of the last key check (FR-004): `unverified` = network failure, not an invalid key. */
export const keyVerificationSchema = z.enum(['never', 'valid', 'invalid', 'unverified']);
export type KeyVerification = z.infer<typeof keyVerificationSchema>;

/** Fixed classification of a 403 key-check response; never provider text or arbitrary codes. */
export const forbiddenReasonSchema = z.enum([
  'model_permission_org',
  'model_permission_project',
  'model_permission',
  'permission_restriction',
  'region_block',
  'edge_block',
  'unknown',
]);
export type ForbiddenReason = z.infer<typeof forbiddenReasonSchema>;

/** Keyless reachability after an authenticated models request returned 403. */
export const accessProbeSchema = z.enum([
  'auth-required',
  'forbidden',
  'unreachable',
  'other-response',
]);
export type AccessProbe = z.infer<typeof accessProbeSchema>;

/**
 * Key status for extension pages only (privileged route). Shows at most the last
 * four characters (secret boundary rule 5), never the key.
 */
export const keyStatusSchema = z.strictObject({
  hasKey: z.boolean(),
  storage: keyStorageSchema.nullable(),
  last4: z.string().length(4).nullable(),
  verification: keyVerificationSchema,
  verifiedAt: z.number().int().nonnegative().nullable(),
  /** Numeric HTTP response from the latest failed verification; absent for network failures. */
  verificationHttpStatus: z.number().int().min(100).max(599).optional(),
  forbiddenReason: forbiddenReasonSchema.optional(),
  accessProbe: accessProbeSchema.optional(),
  /** Models available to the key at the last successful check (empty if never checked). */
  models: z.array(modelInfoSchema).max(200),
});
export type KeyStatus = z.infer<typeof keyStatusSchema>;

/** Public AI readiness summary (GET_AI_STATUS); safe for content scripts. */
export const aiStatusSchema = z.strictObject({
  state: z.enum([
    'setup_required', // no key
    'disclosure_required', // key present, disclosure not acknowledged
    'invalid_key', // last check said 401
    'ready', // key present (verified or not yet checked)
    'storage_unavailable', // storage lockdown failed; key routes refused
  ]),
  model: modelIdSchema.optional(),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;

/** Site-access status for extension pages (D-02). */
export const siteAccessStatusSchema = z.strictObject({
  /** Chrome currently grants the optional http/https origins. */
  granted: z.boolean(),
  /** The observer is registered with chrome.scripting. */
  registered: z.boolean(),
  choice: siteAccessChoiceSchema,
});
export type SiteAccessStatus = z.infer<typeof siteAccessStatusSchema>;
