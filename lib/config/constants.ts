/**
 * Single source of truth for Clavis configuration constants.
 *
 * Everything here is non-secret and extension-ID independent. Nothing in this
 * file may ever hold an API key or a user-specific value.
 * See docs/architecture.md §3, §4, §6 and docs/requirements.md §4.2-§4.3.
 */

/** Wire-format version carried by every cross-context message (`v`). */
export const MESSAGE_VERSION = 1 as const;

/** Groq provider endpoints (architecture §6). Reached only over https. */
export const GROQ = {
  apiBase: 'https://api.groq.com/openai/v1',
  chatCompletionsUrl: 'https://api.groq.com/openai/v1/chat/completions',
  modelsUrl: 'https://api.groq.com/openai/v1/models',
  /** Narrow host permission pattern; never request `<all_urls>` for Groq. */
  hostPermission: 'https://api.groq.com/*',
} as const;

/**
 * Model CANDIDATES, not shipped defaults (decision D-09).
 *
 * The final quick/deep defaults are set from Spike A measurements (quality and
 * p95 latency on the regression fixtures, plus at least one non-reasoning
 * model). Both are reasoning models, so `reasoning_effort` and the
 * `max_completion_tokens` budget must be tuned before these become defaults.
 * They must also be verified against the user's actual model list; never
 * silently upgrade to a billable tier.
 */
export const MODEL_CANDIDATES = {
  quick: 'openai/gpt-oss-20b',
  deep: 'openai/gpt-oss-120b',
} as const;

/** Input ceilings (requirements §4.2, normative). Engineering defaults, not Groq maxima. */
export const LIMITS = {
  /** Maximum selected/spoken text, in UTF-16 code units, after trimming. */
  maxSelectionChars: 2000,
  /** Maximum combined `contextBefore` + `contextAfter` length. */
  maxContextChars: 1000,
  /**
   * Upper bound on the serialized size of one inbound message. The largest
   * legitimate message is ~3,000 chars of text (up to 4 UTF-8 bytes each) plus
   * JSON overhead, so 32 KiB leaves headroom while stopping memory abuse.
   */
  maxMessageBytes: 32 * 1024,
  /** Bounded length of a BCP-47-ish language tag. */
  maxLanguageTagChars: 35,
  /** Bounded length of a model identifier. */
  maxModelIdChars: 128,
  /** Bounded length of a user-visible error message. */
  maxErrorMessageChars: 500,
  /** Bounded length of an API key accepted by the privileged routes. */
  maxApiKeyChars: 512,
} as const;

/** Text-to-speech rates (requirements §4.3). */
export const TTS_RATES = {
  normal: 1.0,
  slow: 0.75,
  min: 0.5,
  max: 2.0,
} as const;

/**
 * Optional host permissions requested at runtime from a user gesture so the
 * content observer can run on websites (architecture §3).
 */
export const OPTIONAL_SITE_ORIGINS = ['http://*/*', 'https://*/*'] as const;

/** Registered content script id for the dynamically registered observer. */
export const CONTENT_SCRIPT_ID = 'clavis-observer' as const;

/** Extension page routes. Root-relative so they are independent of the extension ID. */
export const EXTENSION_PAGES = {
  popup: '/popup.html',
  onboarding: '/onboarding.html',
  options: '/options.html',
  reader: '/reader.html',
} as const;

/** Network timeouts in milliseconds. Every external call must be bounded. */
export const REQUEST_TIMEOUT_MS = {
  /** Default for an explain request. */
  default: 30_000,
  /** Key verification via the models endpoint. */
  keyValidation: 10_000,
} as const;
