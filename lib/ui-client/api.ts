import { z } from 'zod';
import type { KeyStorage } from '../contracts/key-storage';
import { explainResultSchema, type ExplainRequest } from '../contracts/explain';
import { speakResultSchema, stopResultSchema, voicesReportSchema } from '../contracts/speech';
import {
  aiStatusSchema,
  keyStatusSchema,
  publicSettingsSchema,
  settingsSnapshotSchema,
  siteAccessStatusSchema,
  type PreferencesPatch,
  type SiteAccessChoice,
} from '../contracts/setup';
import { request, type ClientResult } from './request';

const clearedSchema = z.strictObject({ cleared: z.literal(true) });

/**
 * Typed wrappers for the background's message routes (lib/contracts/messages.ts). One place
 * builds the wire messages so no page hand-writes a message type. Key routes are accepted only
 * from /options.html and /onboarding.html; the background enforces that, not this file.
 */
export const api = {
  // ---- Privileged: settings and status (options, onboarding, popup) ----------------
  getSettings: () => request({ type: 'GET_SETTINGS' }, settingsSnapshotSchema),
  updatePreferences: (patch: PreferencesPatch) =>
    request({ type: 'UPDATE_PREFERENCES', patch }, settingsSnapshotSchema),
  resetPreferences: () => request({ type: 'RESET_PREFERENCES' }, settingsSnapshotSchema),
  acceptDisclosure: () => request({ type: 'ACCEPT_DISCLOSURE' }, settingsSnapshotSchema),
  updateOnboarding: (update: { completed?: boolean; siteAccessChoice?: SiteAccessChoice }) =>
    request({ type: 'UPDATE_ONBOARDING', ...update }, settingsSnapshotSchema),
  getSiteAccessStatus: () => request({ type: 'GET_SITE_ACCESS_STATUS' }, siteAccessStatusSchema),
  /** Voices per engine on this device (Settings voice chooser, FR-025). */
  getVoices: () => request({ type: 'GET_VOICES' }, voicesReportSchema),

  // ---- Privileged: key routes (options and onboarding only) --------------------------
  /** The key travels in this one message and is never stored, logged or echoed by the page. */
  setApiKey: (apiKey: string, storage: KeyStorage) =>
    request({ type: 'SET_API_KEY', apiKey, storage }, keyStatusSchema),
  testApiKey: () => request({ type: 'TEST_API_KEY' }, keyStatusSchema),
  removeApiKey: () => request({ type: 'REMOVE_API_KEY' }, keyStatusSchema),
  getKeyStatus: () => request({ type: 'GET_KEY_STATUS' }, keyStatusSchema),
  clearAllData: () => request({ type: 'CLEAR_ALL_DATA' }, clearedSchema),

  // ---- Public ---------------------------------------------------------------------------
  getAiStatus: () => request({ type: 'GET_AI_STATUS' }, aiStatusSchema),
  getPublicSettings: () => request({ type: 'GET_PUBLIC_SETTINGS' }, publicSettingsSchema),
  // Paid call: never retried automatically (a restart must not cause a second Groq request).
  explain: (payload: ExplainRequest) =>
    request({ type: 'AI_EXPLAIN', payload }, explainResultSchema, {}, { retry: false }),
  /** Speak from an extension page (Settings "Test voice"). Replies once audio has started. */
  speak: (input: {
    requestId: string;
    text: string;
    lang?: string;
    rate: number;
    voiceName?: string;
  }) => request({ type: 'TTS_SPEAK', ...input }, speakResultSchema, {}, { retry: false }),
  stopSpeaking: (requestId?: string) =>
    request(
      { type: 'TTS_STOP', ...(requestId === undefined ? {} : { requestId }) },
      stopResultSchema,
    ),
} as const;

export type Api = typeof api;
export type { ClientResult };
