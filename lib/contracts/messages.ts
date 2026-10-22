import { z } from 'zod';
import { LIMITS, MESSAGE_VERSION } from '../config/constants';
import { errorEnvelopeSchema } from './errors';
import { explainRequestSchema } from './explain';
import { idSchema, languageTagSchema } from './primitives';
import { ttsRateSchema } from './settings';

const v = z.literal(MESSAGE_VERSION);

// ---------------------------------------------------------------------------
// Public routes: callable from content scripts and the reader. Untrusted.
// ---------------------------------------------------------------------------

export const aiExplainMessageSchema = z.strictObject({
  v,
  type: z.literal('AI_EXPLAIN'),
  payload: explainRequestSchema,
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
]);
export type PublicMessage = z.infer<typeof publicMessageSchema>;

// ---------------------------------------------------------------------------
// Privileged routes: extension pages only (secret boundary rule 4). Kept in a
// SEPARATE union so a public parser can never accept them. Sender checks are
// the router's job; these schemas only validate shape.
// ---------------------------------------------------------------------------

export const keyStorageSchema = z.enum(['local', 'session']);
export type KeyStorage = z.infer<typeof keyStorageSchema>;

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

export const privilegedMessageSchema = z.discriminatedUnion('type', [
  setApiKeyMessageSchema,
  testApiKeyMessageSchema,
  removeApiKeyMessageSchema,
]);
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
