import { vi } from 'vitest';
import { browser } from 'wxt/browser';
import catalog from '../../../public/_locales/en/messages.json';
import { TTS_RATES } from '../../../lib/config/constants';
import {
  DEFAULT_ONBOARDING,
  DEFAULT_PREFERENCES,
  parsePrivilegedMessage,
  parsePublicMessage,
  type ErrorCode,
  type ErrorReason,
  type KeyStatus,
  type KeyVerification,
  type ModelInfo,
  type OnboardingState,
  type Preferences,
  type VoicesReport,
} from '../../../lib/contracts';

type CatalogEntry = { message: string; placeholders?: Record<string, { content: string }> };
const entries = catalog as unknown as Record<string, CatalogEntry>;

/** Real English text for `t()` (fakeBrowser has no catalog), including `$NAME$` substitutions. */
export function installCatalog(): void {
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(((
    key: string,
    substitutions?: string | string[],
  ) => {
    const entry = entries[key];
    if (entry === undefined) return '';
    const values = substitutions === undefined ? [] : [substitutions].flat();
    return entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => {
      const content =
        entry.placeholders?.[name.toLowerCase()]?.content ??
        Object.entries(entry.placeholders ?? {}).find(
          ([placeholder]) => placeholder.toLowerCase() === name.toLowerCase(),
        )?.[1].content;
      const index = Number(content?.replace('$', '')) - 1;
      return values[index] ?? whole;
    });
  }) as unknown as typeof browser.i18n.getMessage);
}

export interface FakeBackendOptions {
  /** What Groq says about a key: used by SET_API_KEY (when `verifyOnSet`) and TEST_API_KEY. */
  groq?: 'valid' | 'invalid' | 'offline';
  models?: ModelInfo[];
  /** SET_API_KEY replies with the check already done (otherwise `never`, and the page tests). */
  verifyOnSet?: boolean;
  preferences?: Partial<Preferences>;
  onboarding?: Partial<OnboardingState>;
  key?: { value: string; storage: 'local' | 'session' };
  /** Reply with nothing this many times first (a restarting service worker). */
  silentReplies?: number;
  /** What GET_VOICES reports (default: no voice anywhere, on Linux). */
  voices?: VoicesReport;
  /** What TTS_SPEAK answers (default `started`). */
  speak?:
    | 'started'
    | 'started-remote'
    | 'no-voice'
    | 'no-voice-linux'
    | 'no-voice-language'
    | 'online-only'
    | 'start-failed';
}

/** A device with no voices (this Linux machine) and no fallback engine. */
export const NO_VOICES: VoicesReport = {
  platform: 'linux',
  defaultEngine: 'none',
  engines: {
    chromeTts: { voices: [] },
    offscreen: { available: false, voices: [] },
  },
};

/**
 * An in-memory stand-in for the background's Phase 3 routes. Every message is checked with the
 * REAL contract parsers, so a page that sends something the background would reject fails here.
 */
export function createFakeBackend(options: FakeBackendOptions = {}) {
  const state = {
    groq: options.groq ?? 'valid',
    models: options.models ?? [
      { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
      { id: 'llama-3.3-70b-versatile', supportsJsonSchema: false },
    ],
    verifyOnSet: options.verifyOnSet ?? false,
    preferences: { ...DEFAULT_PREFERENCES, ...options.preferences } as Preferences,
    onboarding: { ...DEFAULT_ONBOARDING, ...options.onboarding } as OnboardingState,
    key: options.key ?? null,
    verification: 'never' as KeyVerification,
    verifiedAt: null as number | null,
    knownModels: [] as ModelInfo[],
    silent: options.silentReplies ?? 0,
    siteGranted: false,
    failNext: null as ErrorCode | null,
    voices: options.voices ?? NO_VOICES,
    speak: options.speak ?? 'started',
  };
  const calls: Array<{ type: string; [k: string]: unknown }> = [];

  const ok = (data: unknown) => ({ ok: true as const, data });
  const fail = (code: ErrorCode, reason?: ErrorReason) => ({
    ok: false as const,
    error: {
      code,
      message: 'internal detail that must never be shown: gsk_RAW_PROVIDER_TEXT',
      ...(reason === undefined ? {} : { reason }),
    },
  });
  const keyStatus = (): KeyStatus => ({
    hasKey: state.key !== null,
    storage: state.key?.storage ?? null,
    last4: state.key === null ? null : state.key.value.slice(-4),
    verification: state.key === null ? 'never' : state.verification,
    verifiedAt: state.key === null ? null : state.verifiedAt,
    models: state.key === null ? [] : state.knownModels,
  });
  const snapshot = () => ok({ preferences: state.preferences, onboarding: state.onboarding });

  function check(): KeyStatus | ReturnType<typeof fail> {
    if (state.groq === 'invalid') {
      state.verification = 'invalid';
      state.knownModels = [];
    } else if (state.groq === 'offline') {
      state.verification = 'unverified';
    } else {
      state.verification = 'valid';
      state.knownModels = state.models;
    }
    state.verifiedAt = Date.now();
    return keyStatus();
  }

  function handle(raw: unknown): unknown {
    if (state.silent > 0) {
      state.silent -= 1;
      return undefined;
    }
    const type = (raw as { type?: string }).type ?? '?';
    // Never record the key itself.
    calls.push({ type, ...(type === 'SET_API_KEY' ? {} : (raw as object)) });
    if (state.failNext !== null) {
      const code = state.failNext;
      state.failNext = null;
      return fail(code);
    }
    const privileged = parsePrivilegedMessage(raw);
    const message = privileged.ok ? privileged.message : null;
    if (message === null) {
      const publicParsed = parsePublicMessage(raw);
      if (!publicParsed.ok) return fail('INVALID_REQUEST');
      if (publicParsed.message.type === 'GET_AI_STATUS') {
        const aiState =
          state.key === null
            ? 'setup_required'
            : state.verification === 'invalid'
              ? 'invalid_key'
              : state.onboarding.disclosureAcceptedAt === null
                ? 'disclosure_required'
                : 'ready';
        return ok({ state: aiState });
      }
      if (publicParsed.message.type === 'GET_PUBLIC_SETTINGS') {
        const p = state.preferences;
        return ok({
          hasKey: state.key !== null,
          disclosureAccepted: state.onboarding.disclosureAcceptedAt !== null,
          explanationLanguage: p.explanationLanguage,
          readingLevel: p.readingLevel,
          tooltipBehavior: p.tooltipBehavior,
          ttsRate: p.ttsRate,
          ...(p.ttsLang === undefined ? {} : { ttsLang: p.ttsLang }),
        });
      }
      if (publicParsed.message.type === 'AI_EXPLAIN') return fail('SETUP_REQUIRED');
      if (publicParsed.message.type === 'TTS_SPEAK') {
        if (state.speak === 'no-voice') return fail('NO_VOICE');
        if (state.speak === 'no-voice-linux') return fail('NO_VOICE', 'no-voice-linux');
        if (state.speak === 'no-voice-language') return fail('NO_VOICE', 'no-voice-language');
        if (state.speak === 'online-only') return fail('NO_VOICE', 'online-only');
        if (state.speak === 'start-failed') return fail('NO_VOICE', 'start-failed');
        return ok({
          state: 'started',
          engine: 'chrome-tts',
          remote: state.speak === 'started-remote',
        });
      }
      if (publicParsed.message.type === 'TTS_STOP') return ok({ stopped: true });
      return ok({});
    }
    switch (message.type) {
      case 'GET_SETTINGS':
        return snapshot();
      case 'UPDATE_PREFERENCES': {
        const { patch } = message;
        const next: Preferences = { ...state.preferences };
        for (const [field, value] of Object.entries(patch)) {
          if (value === null) delete (next as Record<string, unknown>)[field];
          else (next as Record<string, unknown>)[field] = value;
        }
        state.preferences = next;
        return snapshot();
      }
      case 'RESET_PREFERENCES':
        state.preferences = { ...DEFAULT_PREFERENCES };
        return snapshot();
      case 'ACCEPT_DISCLOSURE':
        state.onboarding = { ...state.onboarding, disclosureAcceptedAt: Date.now() };
        return snapshot();
      case 'UPDATE_ONBOARDING':
        state.onboarding = {
          ...state.onboarding,
          ...(message.completed === undefined ? {} : { completed: message.completed }),
          ...(message.siteAccessChoice === undefined
            ? {}
            : { siteAccessChoice: message.siteAccessChoice }),
        };
        return snapshot();
      case 'GET_KEY_STATUS':
        return ok(keyStatus());
      case 'SET_API_KEY':
        state.key = { value: message.apiKey, storage: message.storage };
        state.verification = 'never';
        state.verifiedAt = null;
        state.knownModels = [];
        if (state.verifyOnSet) check();
        return ok(keyStatus());
      case 'TEST_API_KEY':
        if (state.key === null) return fail('SETUP_REQUIRED');
        return ok(check());
      case 'REMOVE_API_KEY':
        state.key = null;
        state.verification = 'never';
        state.verifiedAt = null;
        state.knownModels = [];
        return ok(keyStatus());
      case 'GET_VOICES':
        return ok(state.voices);
      case 'GET_SITE_ACCESS_STATUS':
        return ok({
          granted: state.siteGranted,
          registered: state.siteGranted,
          choice: state.onboarding.siteAccessChoice,
        });
      case 'CLEAR_ALL_DATA':
        state.key = null;
        state.verification = 'never';
        state.knownModels = [];
        state.preferences = { ...DEFAULT_PREFERENCES, ttsRate: TTS_RATES.normal };
        state.onboarding = { ...DEFAULT_ONBOARDING };
        return ok({ cleared: true });
    }
  }

  return { state, calls, handle, keyStatus };
}

export type FakeBackend = ReturnType<typeof createFakeBackend>;

/** Route `browser.runtime.sendMessage` to the fake backend. */
export function installBackend(backend: FakeBackend): void {
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: unknown) =>
    Promise.resolve(backend.handle(message))) as unknown as typeof browser.runtime.sendMessage);
}

export interface FakePermissions {
  granted: boolean;
  request: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

/** A `browser.permissions` stub whose prompt answer the test controls. */
export function installPermissions(initial: {
  granted: boolean;
  answer?: boolean;
}): FakePermissions {
  const state: FakePermissions = {
    granted: initial.granted,
    request: vi.fn(() => {
      state.granted = initial.answer ?? true;
      return Promise.resolve(initial.answer ?? true);
    }),
    remove: vi.fn(() => {
      state.granted = false;
      return Promise.resolve(true);
    }),
  };
  const noop = { addListener: vi.fn(), removeListener: vi.fn() };
  Object.assign(browser, {
    permissions: {
      contains: vi.fn(() => Promise.resolve(state.granted)),
      request: state.request,
      remove: state.remove,
      onAdded: noop,
      onRemoved: noop,
    },
  });
  return state;
}
