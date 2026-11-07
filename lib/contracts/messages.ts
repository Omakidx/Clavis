import { z } from 'zod';
import { LIMITS, MESSAGE_VERSION } from '../config/constants';
import { errorEnvelopeSchema } from './errors';
import { explainRequestSchema } from './explain';
import { idSchema, languageTagSchema } from './primitives';
import { keyStorageSchema } from './key-storage';
import { voiceNameSchema } from './speech';
import { preferencesPatchSchema, siteAccessChoiceSchema, ttsRateSchema } from './setup';

const v = z.literal(MESSAGE_VERSION);

// ---------------------------------------------------------------------------
// Public routes: callable from content scripts and the reader. Untrusted.
// ---------------------------------------------------------------------------

export const aiExplainMessageSchema = z.strictObject({
  v,
  type: z.literal('AI_EXPLAIN'),
  payload: explainRequestSchema,
  /**
   * Set only after the user confirmed the one-time "Send this to Groq?" prompt in the card
   * (requirements §4.1 firstSendBody, D-16) with a trusted click. When the disclosure was never
   * acknowledged, the background records the acknowledgement and proceeds; without it the
   * background replies SETUP_REQUIRED with `reason: 'disclosure'` on the error envelope. Ignored once acknowledged.
   */
  acknowledgeDisclosure: z.literal(true).optional(),
});

/**
 * Content script → background: inject the explanation card script into the sender's frame
 * (D-08: the card is not part of the always-loaded observer). Idempotent per frame.
 */
export const loadExplainCardMessageSchema = z.strictObject({
  v,
  type: z.literal('LOAD_EXPLAIN_CARD'),
});

/** Inject only the packaged toolbar into the browser-supplied sender document. */
export const loadToolbarMessageSchema = z.strictObject({ v, type: z.literal('LOAD_TOOLBAR') });

/** Card / practice page / reader → background: open the Settings page, optionally at a section. */
export const openSettingsMessageSchema = z.strictObject({
  v,
  type: z.literal('OPEN_SETTINGS'),
  section: z.enum(['key', 'model', 'privacy', 'voice', 'site', 'pdfHelp']).optional(),
});

export const aiCancelMessageSchema = z.strictObject({
  v,
  type: z.literal('AI_CANCEL'),
  requestId: idSchema,
});

export const ttsSpeakMessageSchema = z.strictObject({
  v,
  type: z.literal('TTS_SPEAK'),
  requestId: idSchema,
  text: z.string().trim().min(1).max(LIMITS.maxSelectionChars),
  lang: languageTagSchema.optional(),
  rate: ttsRateSchema,
  /** Speak with this exact voice (Settings "Test voice"); otherwise the preference or best match. */
  voiceName: voiceNameSchema.optional(),
  /** Request real word-boundary pushes during this utterance. */
  trackWords: z.boolean().optional(),
});

export const ttsStopMessageSchema = z.strictObject({
  v,
  type: z.literal('TTS_STOP'),
  requestId: idSchema.optional(),
});

export const getPublicSettingsMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_PUBLIC_SETTINGS'),
});

export const getAiStatusMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_AI_STATUS'),
});

export const publicMessageSchema = z.discriminatedUnion('type', [
  aiExplainMessageSchema,
  aiCancelMessageSchema,
  ttsSpeakMessageSchema,
  ttsStopMessageSchema,
  getPublicSettingsMessageSchema,
  getAiStatusMessageSchema,
  loadExplainCardMessageSchema,
  loadToolbarMessageSchema,
  openSettingsMessageSchema,
]);
export type PublicMessage = z.infer<typeof publicMessageSchema>;

// ---------------------------------------------------------------------------
// Privileged routes: extension pages only (secret boundary rule 4). Kept in a
// SEPARATE union so a public parser can never accept them. Sender checks are
// the router's job; these schemas only validate shape. Allowed senders
// (Phase 2 security review, LOW-5):
//   - key routes (SET/TEST/REMOVE_API_KEY, GET_KEY_STATUS, CLEAR_ALL_DATA):
//     exactly /options.html and /onboarding.html
//   - settings and status routes: /options.html, /onboarding.html, /popup.html
//   Never the reader (it shows untrusted PDFs).
// ---------------------------------------------------------------------------

/** Secret-bearing string: no whitespace or control characters, bounded length. */
const apiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.maxApiKeyChars)
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  .regex(/^[^\s\u0000-\u001f\u007f]+$/, 'API key must not contain whitespace');

export const setApiKeyMessageSchema = z.strictObject({
  v,
  type: z.literal('SET_API_KEY'),
  apiKey: apiKeySchema,
  storage: keyStorageSchema,
});

export const testApiKeyMessageSchema = z.strictObject({
  v,
  type: z.literal('TEST_API_KEY'),
});

export const removeApiKeyMessageSchema = z.strictObject({
  v,
  type: z.literal('REMOVE_API_KEY'),
});

export const getKeyStatusMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_KEY_STATUS'),
});

/** Full preferences + onboarding state for extension pages. */
export const getSettingsMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_SETTINGS'),
});

export const updatePreferencesMessageSchema = z.strictObject({
  v,
  type: z.literal('UPDATE_PREFERENCES'),
  patch: preferencesPatchSchema,
});

export const resetPreferencesMessageSchema = z.strictObject({
  v,
  type: z.literal('RESET_PREFERENCES'),
});

/** FR-002: the user acknowledged the data disclosure (D-16 copy). */
export const acceptDisclosureMessageSchema = z.strictObject({
  v,
  type: z.literal('ACCEPT_DISCLOSURE'),
});

/** Records onboarding progress; the site-access choice is persisted so we never re-prompt. */
export const updateOnboardingMessageSchema = z
  .strictObject({
    v,
    type: z.literal('UPDATE_ONBOARDING'),
    completed: z.boolean().optional(),
    siteAccessChoice: siteAccessChoiceSchema.optional(),
  })
  .refine(
    (m) => m.completed !== undefined || m.siteAccessChoice !== undefined,
    'Nothing to update',
  );

/** Voices available per engine on this device (Settings voice chooser, FR-025; D-07 check). */
export const getVoicesMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_VOICES'),
});

export const getSiteAccessStatusMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_SITE_ACCESS_STATUS'),
});

/** FR-078: remove the key, preferences, onboarding state and caches. */
export const clearAllDataMessageSchema = z.strictObject({
  v,
  type: z.literal('CLEAR_ALL_DATA'),
});

export const privilegedMessageSchema = z.discriminatedUnion('type', [
  setApiKeyMessageSchema,
  testApiKeyMessageSchema,
  removeApiKeyMessageSchema,
  getKeyStatusMessageSchema,
  getSettingsMessageSchema,
  updatePreferencesMessageSchema,
  resetPreferencesMessageSchema,
  acceptDisclosureMessageSchema,
  updateOnboardingMessageSchema,
  getSiteAccessStatusMessageSchema,
  getVoicesMessageSchema,
  clearAllDataMessageSchema,
]);

/** Privileged routes that touch the key; only /options.html and /onboarding.html may send them. */
export const KEY_ROUTES = [
  'SET_API_KEY',
  'TEST_API_KEY',
  'REMOVE_API_KEY',
  'GET_KEY_STATUS',
  'CLEAR_ALL_DATA',
] as const satisfies readonly PrivilegedMessage['type'][];
export type PrivilegedMessage = z.infer<typeof privilegedMessageSchema>;

/** Every message the background may receive. */
export type ExtensionMessage = PublicMessage | PrivilegedMessage;

// ---------------------------------------------------------------------------
// Reply envelope. Keys and authorization headers are NEVER returned.
// ---------------------------------------------------------------------------

/** Build the reply envelope schema for a given `data` schema. */
export function messageReplySchema<T extends z.ZodType>(data: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), requestId: idSchema.optional(), data }),
    z.strictObject({
      ok: z.literal(false),
      requestId: idSchema.optional(),
      error: errorEnvelopeSchema,
    }),
  ]);
}

export type MessageReply<T> =
  | { ok: true; requestId?: string | undefined; data: T }
  | {
      ok: false;
      requestId?: string | undefined;
      error: z.infer<typeof errorEnvelopeSchema>;
    };

// ---------------------------------------------------------------------------
// Never-throwing parsers
// ---------------------------------------------------------------------------

/** Why a message was rejected. Issue details carry paths and codes only, never input values. */
export interface MessageIssue {
  path: string;
  code: string;
}

export type MessageParseResult<T> =
  | { ok: true; message: T }
  | { ok: false; reason: 'too_large' | 'unserializable' | 'invalid'; issues: MessageIssue[] };

const MAX_REPORTED_ISSUES = 10;
const MAX_ISSUE_PATH_CHARS = 64;

/** Serialized size in UTF-8 bytes, or `undefined` if the value is not JSON-serializable. */
function serializedSize(input: unknown): number | undefined {
  try {
    const json = JSON.stringify(input);
    return json === undefined ? undefined : new TextEncoder().encode(json).length;
  } catch {
    return undefined;
  }
}

function parseMessage<T extends z.ZodType>(
  schema: T,
  input: unknown,
): MessageParseResult<z.infer<T>> {
  const size = serializedSize(input);
  if (size === undefined) return { ok: false, reason: 'unserializable', issues: [] };
  if (size > LIMITS.maxMessageBytes) return { ok: false, reason: 'too_large', issues: [] };

  const result = schema.safeParse(input);
  if (result.success) return { ok: true, message: result.data };
  return {
    ok: false,
    reason: 'invalid',
    issues: result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
      path: issue.path.map(String).join('.').slice(0, MAX_ISSUE_PATH_CHARS),
      code: issue.code,
    })),
  };
}

/** Validate an inbound message from an untrusted context. Accepts public routes only. */
export function parsePublicMessage(input: unknown): MessageParseResult<PublicMessage> {
  return parseMessage(publicMessageSchema, input);
}

/** Validate an inbound message on the privileged route. The caller must have verified the sender. */
export function parsePrivilegedMessage(input: unknown): MessageParseResult<PrivilegedMessage> {
  return parseMessage(privilegedMessageSchema, input);
}
