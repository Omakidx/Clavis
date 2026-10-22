import { z } from 'zod';
import { TTS_RATES } from '../config/constants';
import { languageTagSchema, modelIdSchema } from './primitives';

export const ttsRateSchema = z.number().min(TTS_RATES.min).max(TTS_RATES.max);

/**
 * Non-secret settings readable by any extension context (secret boundary rule 3).
 * `hasKey` is a boolean only; there is intentionally no field that could carry
 * the key, its suffix or its storage location. Strict so none can be added by
 * accident at a parse boundary.
 */
export const publicSettingsSchema = z.strictObject({
  hasKey: z.boolean(),
  model: modelIdSchema,
  explanationLanguage: languageTagSchema,
  ttsRate: ttsRateSchema,
  ttsLang: languageTagSchema.optional(),
});
export type PublicSettings = z.infer<typeof publicSettingsSchema>;
