import { SETTINGS_SECTION_ANCHORS } from '../../lib/config/constants';
import messages from '../../public/_locales/en/messages.json';
import type {
  KeyStatus,
  Preferences,
  SettingsSnapshot,
  SiteAccessChoice,
} from '../../lib/contracts/setup';
import { DEFAULT_PREFERENCES } from '../../lib/contracts/setup';
import type { ErrorCode, ErrorReason } from '../../lib/contracts/errors';
import {
  LOCAL_VOICES,
  MODEL,
  MODELS,
  ONLINE_VOICES,
  fakeResult,
  sampleHandoff,
  voicesReport,
  type FakeExplainRequest,
} from './fixtures';
import { resolvePreviewTarget, standalonePreviewUrl } from './navigation';

/**
 * A hand-written stand-in for the Chrome extension APIs, so the extension pages run in a normal
 * browser tab (design preview, dev/preview/README.md). It is NOT the real background router:
 * `runtime.sendMessage` answers with canned replies shaped like the real ones
 * (lib/contracts/**), keyed by message type, and the scenario switch (`?state=`) picks which
 * situation (no key, rate limited, offline, no voice, ...) the replies describe.
 *
 * `createFakeBackground` is pure (no globals), so a script can check every canned reply against
 * the real Zod schemas; `installFakeChrome` wires it to `globalThis.chrome` / `globalThis.browser`.
 */

export const SCENARIOS = {
  connected: 'Key connected and verified, everything works (default).',
  fresh: 'Fresh install: nothing set up, onboarding not completed, no key, no site access.',
  'no-key': 'Set up, but no Groq key: Explain asks the user to connect one.',
  'key-invalid': 'A key is saved but Groq rejected it (401): Explain says the key is invalid.',
  disclosure: 'Key saved, first-send "Send this to Groq?" confirmation still owed.',
  'rate-limited': 'Groq answers 429 with a retry delay.',
  offline: 'Explain fails with a network error (and navigator.onLine reports false).',
  timeout: 'Explain times out.',
  'bad-format': 'The model returned something unusable (INVALID_RESPONSE).',
  'no-voice': 'No speech engine at all (Linux, no speech-dispatcher): Listen shows install help.',
  'online-only': 'Only online voices exist: Listen explains how to allow them.',
  'no-access': 'Set up and connected, but all-sites access was declined.',
} as const;
export type Scenario = keyof typeof SCENARIOS;

export function isScenario(value: string | null): value is Scenario {
  return value !== null && value in SCENARIOS;
}

export interface PreviewOptions {
  scenario: Scenario;
  /** Milliseconds an AI_EXPLAIN reply takes. */
  delayMs: number;
  /** `none`: the side panel has no hand-off (its empty state). */
  handoff: 'sample' | 'none';
}

export function optionsFromSearch(search: string): PreviewOptions {
  const params = new URLSearchParams(search);
  const state = params.get('state');
  const delay = Number(params.get('delay') ?? '');
  return {
    scenario: isScenario(state) ? state : 'connected',
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : 400,
    handoff: params.get('handoff') === 'none' ? 'none' : 'sample',
  };
}

// ---------------------------------------------------------------------------------------------
// i18n, as Chrome does it
// ---------------------------------------------------------------------------------------------

interface CatalogEntry {
  message: string;
  placeholders?: Record<string, { content: string }>;
}
let catalog = messages as unknown as Record<string, CatalogEntry>;

/** `chrome.i18n.getMessage`: named `$NAME$` placeholders, then `$1`..`$9`, `$$` is a dollar sign. */
export function getMessage(key: string, substitutions?: string | string[]): string {
  const entry = catalog[key];
  if (entry === undefined) return '';
  const subs = substitutions === undefined ? [] : [substitutions].flat();
  const named = Object.fromEntries(
    Object.entries(entry.placeholders ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value.content,
    ]),
  );
  return entry.message
    .replace(/\$\$/g, '\uE000')
    .replace(/\$([A-Za-z0-9_@]+)\$/g, (whole, name: string) => named[name.toLowerCase()] ?? whole)
    .replace(/\$([1-9])/g, (_whole, n: string) => subs[Number(n) - 1] ?? '')
    .replace(/\uE000/g, '$');
}

// Editing messages.json updates the strings without a page reload (components pick them up on
// their next render).
import.meta.hot?.accept('../../public/_locales/en/messages.json', (module) => {
  if (module?.default) catalog = module.default as typeof catalog;
});

// ---------------------------------------------------------------------------------------------
// The fake background
// ---------------------------------------------------------------------------------------------

type Envelope = { ok: true; data: unknown } | { ok: false; error: ErrorEnvelopeShape };
interface ErrorEnvelopeShape {
  code: ErrorCode;
  message: string;
  retryAfterMs?: number;
  reason?: ErrorReason;
}

const fail = (code: ErrorCode, extra: Partial<ErrorEnvelopeShape> = {}): Envelope => ({
  ok: false,
  error: { code, message: code.toLowerCase().replace(/_/g, ' '), ...extra },
});
const ok = (data: unknown): Envelope => ({ ok: true, data });

export interface FakeBackground {
  /** Answer one extension message. Resolves after the scenario's delay for AI_EXPLAIN. */
  handle(message: unknown): Promise<unknown>;
  /** Side effects the page would see (events, navigation requests). */
  readonly events: {
    onPermissionsChanged: Set<() => void>;
    onTts: Set<(message: unknown) => void>;
    onOpen: Set<(target: string) => void>;
    onStorage: Set<(changes: Record<string, unknown>, area: string) => void>;
  };
  readonly state: { granted: boolean };
}

const anchorFor = (section: string): string =>
  (SETTINGS_SECTION_ANCHORS as Record<string, string>)[section] ?? section;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createFakeBackground(options: PreviewOptions): FakeBackground {
  const { scenario } = options;
  const fresh = scenario === 'fresh';
  const declined = scenario === 'no-access';

  let preferences: Preferences = { ...DEFAULT_PREFERENCES, model: MODEL };
  let onboarding: SettingsSnapshot['onboarding'] = fresh
    ? { completed: false, disclosureAcceptedAt: null, siteAccessChoice: 'unset' }
    : {
        completed: true,
        disclosureAcceptedAt: scenario === 'disclosure' ? null : 1_760_000_000_000,
        siteAccessChoice: declined ? 'declined' : 'granted',
      };
  const hasKeyAtStart = !(fresh || scenario === 'no-key');
  let key: KeyStatus = hasKeyAtStart
    ? {
        hasKey: true,
        storage: 'local',
        last4: 'x7Qa',
        verification: scenario === 'key-invalid' ? 'invalid' : 'valid',
        verifiedAt: 1_760_000_000_000,
        models: scenario === 'key-invalid' ? [] : MODELS,
      }
    : {
        hasKey: false,
        storage: null,
        last4: null,
        verification: 'never',
        verifiedAt: null,
        models: [],
      };
  const state = { granted: !(fresh || declined) };

  const events: FakeBackground['events'] = {
    onPermissionsChanged: new Set(),
    onTts: new Set(),
    onOpen: new Set(),
    onStorage: new Set(),
  };

  const snapshot = (): SettingsSnapshot => ({
    preferences: { ...preferences },
    onboarding: { ...onboarding },
  });

  const aiState = (): 'setup_required' | 'disclosure_required' | 'invalid_key' | 'ready' => {
    if (!key.hasKey) return 'setup_required';
    if (key.verification === 'invalid') return 'invalid_key';
    if (onboarding.disclosureAcceptedAt === null) return 'disclosure_required';
    return 'ready';
  };

  const voiceKind =
    scenario === 'no-voice' ? 'none' : scenario === 'online-only' ? 'online-only' : 'normal';

  function explain(message: Record<string, unknown>): Envelope {
    const payload = message['payload'];
    const status = aiState();
    if (status === 'setup_required') return fail('SETUP_REQUIRED');
    if (status === 'invalid_key') return fail('INVALID_API_KEY');
    if (status === 'disclosure_required') {
      if (message['acknowledgeDisclosure'] !== true)
        return fail('SETUP_REQUIRED', { reason: 'disclosure' });
      onboarding = { ...onboarding, disclosureAcceptedAt: Date.now() };
    }
    if (scenario === 'rate-limited') return fail('RATE_LIMITED', { retryAfterMs: 20_000 });
    if (scenario === 'offline') return fail('NETWORK_ERROR');
    if (scenario === 'timeout') return fail('TIMEOUT');
    if (scenario === 'bad-format') return fail('INVALID_RESPONSE');
    return ok(fakeResult(payload as FakeExplainRequest));
  }

  function speak(message: Record<string, unknown>): Envelope {
    if (voiceKind === 'none') return fail('NO_VOICE', { reason: 'no-voice-linux' });
    if (voiceKind === 'online-only') return fail('NO_VOICE', { reason: 'online-only' });
    const requestId = message['requestId'];
    // The real background reports the end of playback with a TTS_EVENT; so does the fake.
    setTimeout(() => {
      for (const listener of events.onTts)
        listener({ v: 1, type: 'TTS_EVENT', requestId, state: 'ended' });
    }, 2500);
    const voice = LOCAL_VOICES[0];
    return ok({
      state: 'started',
      engine: 'chrome-tts',
      ...(typeof message['voiceName'] === 'string'
        ? { voiceName: message['voiceName'] }
        : { voiceName: voice?.name }),
      lang: typeof message['lang'] === 'string' ? message['lang'] : 'en-GB',
      remote: false,
    });
  }

  function verify(): void {
    if (!key.hasKey) return;
    const valid = scenario !== 'key-invalid';
    key = {
      ...key,
      verification: valid ? 'valid' : 'invalid',
      verifiedAt: Date.now(),
      models: valid ? MODELS : [],
    };
  }

  async function route(message: Record<string, unknown>): Promise<Envelope> {
    switch (message['type']) {
      // ---- settings ----
      case 'GET_SETTINGS':
        return ok(snapshot());
      case 'UPDATE_PREFERENCES': {
        const patch = isRecord(message['patch']) ? message['patch'] : {};
        const next: Record<string, unknown> = { ...preferences };
        for (const [name, value] of Object.entries(patch)) {
          if (value === null) delete next[name];
          else if (value !== undefined) next[name] = value;
        }
        preferences = next as unknown as Preferences;
        return ok(snapshot());
      }
      case 'RESET_PREFERENCES':
        preferences = { ...DEFAULT_PREFERENCES };
        return ok(snapshot());
      case 'ACCEPT_DISCLOSURE':
        onboarding = { ...onboarding, disclosureAcceptedAt: Date.now() };
        return ok(snapshot());
      case 'UPDATE_ONBOARDING':
        onboarding = {
          ...onboarding,
          ...(typeof message['completed'] === 'boolean' ? { completed: message['completed'] } : {}),
          ...(typeof message['siteAccessChoice'] === 'string'
            ? { siteAccessChoice: message['siteAccessChoice'] as SiteAccessChoice }
            : {}),
        };
        return ok(snapshot());
      case 'GET_SITE_ACCESS_STATUS':
        return ok({
          granted: state.granted,
          registered: state.granted,
          choice: onboarding.siteAccessChoice,
        });
      case 'GET_PUBLIC_SETTINGS':
        return ok({
          hasKey: key.hasKey,
          disclosureAccepted: onboarding.disclosureAcceptedAt !== null,
          explanationLanguage: preferences.explanationLanguage,
          ...(preferences.translationLanguage === undefined
            ? {}
            : { translationLanguage: preferences.translationLanguage }),
          readingLevel: preferences.readingLevel,
          tooltipBehavior: preferences.tooltipBehavior,
          ttsRate: preferences.ttsRate,
          ...(preferences.ttsLang === undefined ? {} : { ttsLang: preferences.ttsLang }),
          ...(preferences.model === undefined ? {} : { model: preferences.model }),
        });
      case 'GET_AI_STATUS':
        return ok({ state: aiState(), model: MODEL });
      // ---- key ----
      case 'GET_KEY_STATUS':
        return ok(key);
      case 'SET_API_KEY': {
        const apiKey = String(message['apiKey'] ?? '');
        key = {
          hasKey: true,
          storage: message['storage'] === 'session' ? 'session' : 'local',
          last4: apiKey.slice(-4).padStart(4, '*'),
          verification: 'never',
          verifiedAt: null,
          models: [],
        };
        verify();
        return ok(key);
      }
      case 'TEST_API_KEY':
        verify();
        return ok(key);
      case 'REMOVE_API_KEY':
        key = {
          hasKey: false,
          storage: null,
          last4: null,
          verification: 'never',
          verifiedAt: null,
          models: [],
        };
        return ok(key);
      case 'CLEAR_ALL_DATA':
        key = {
          hasKey: false,
          storage: null,
          last4: null,
          verification: 'never',
          verifiedAt: null,
          models: [],
        };
        preferences = { ...DEFAULT_PREFERENCES };
        onboarding = { completed: false, disclosureAcceptedAt: null, siteAccessChoice: 'unset' };
        return ok({ cleared: true });
      // ---- speech ----
      case 'GET_VOICES':
        return ok(voicesReport(voiceKind));
      case 'TTS_SPEAK':
        return speak(message);
      case 'TTS_STOP':
        return ok({ stopped: true });
      // ---- explain ----
      case 'AI_EXPLAIN':
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        return explain(message);
      case 'AI_CANCEL':
        return ok({ cancelled: false });
      case 'LOAD_EXPLAIN_CARD':
        return ok({ loaded: true });
      case 'OPEN_SETTINGS': {
        const section =
          typeof message['section'] === 'string' ? `#${anchorFor(message['section'])}` : '';
        for (const listener of events.onOpen)
          listener(`chrome-extension://clavis-preview/options.html${section}`);
        return ok({ opened: true });
      }
      // ---- side panel ----
      case 'OPEN_SIDE_PANEL':
        for (const listener of events.onOpen)
          listener('chrome-extension://clavis-preview/sidepanel.html');
        return ok({ opened: true });
      case 'GET_SIDE_PANEL_STATE':
        return ok({ revision: 1, handoff: options.handoff === 'none' ? null : sampleHandoff() });
      default:
        return fail('INVALID_REQUEST');
    }
  }

  return {
    events,
    state,
    async handle(message) {
      if (!isRecord(message)) return fail('INVALID_REQUEST');
      // The preview cannot inject into a real tab. Open the practice page instead, where the
      // visitor can select sample text; no selection has been shown yet.
      if (message['type'] === 'CLAVIS_INJECT_TAB') {
        for (const listener of events.onOpen)
          listener('chrome-extension://clavis-preview/practice.html');
        return { ok: true, shown: false };
      }
      return route(message);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Installing the globals
// ---------------------------------------------------------------------------------------------

type Listener = (...args: never[]) => unknown;

class FakeEvent {
  readonly listeners = new Set<Listener>();
  addListener(listener: Listener): void {
    this.listeners.add(listener);
  }
  removeListener(listener: Listener): void {
    this.listeners.delete(listener);
  }
  hasListener(listener: Listener): boolean {
    return this.listeners.has(listener);
  }
  dispatch(...args: unknown[]): void {
    for (const listener of [...this.listeners]) (listener as (...a: unknown[]) => unknown)(...args);
  }
}

export const PREVIEW_EXTENSION_ID = 'clavis-preview';
const ORIGIN = `chrome-extension://${PREVIEW_EXTENSION_ID}`;

/** The browser tab the popup believes it was opened on. */
const TAB = {
  id: 1,
  active: true,
  url: 'https://en.wikipedia.org/wiki/Cherry_blossom',
  title: 'Cherry blossom',
};

function storageArea(onChanged: FakeEvent, name: string) {
  const data = new Map<string, unknown>();
  const pick = (keys: unknown): Record<string, unknown> => {
    if (keys === null || keys === undefined) return Object.fromEntries(data);
    const list =
      typeof keys === 'string'
        ? [keys]
        : Array.isArray(keys)
          ? (keys as string[])
          : Object.keys(keys as object);
    const defaults = isRecord(keys) && !Array.isArray(keys) ? keys : {};
    return Object.fromEntries(
      list
        .filter((k) => data.has(k) || k in defaults)
        .map((k) => [k, data.has(k) ? data.get(k) : defaults[k]]),
    );
  };
  return {
    async get(keys?: unknown) {
      return pick(keys);
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: data.get(k), newValue: v };
        data.set(k, v);
      }
      onChanged.dispatch(changes, name);
    },
    async remove(keys: string | string[]) {
      for (const k of [keys].flat()) data.delete(k);
    },
    async clear() {
      data.clear();
    },
    async setAccessLevel() {},
    onChanged: new FakeEvent(),
  };
}

/** Install `globalThis.chrome` and `globalThis.browser` (the same object). Idempotent. */
export function installFakeChrome(options: PreviewOptions): FakeBackground {
  const background = createFakeBackground(options);
  const bgUrl = `${ORIGIN}/background.js`;

  const onMessage = new FakeEvent();
  background.events.onTts.add((message) => {
    // Playback reports come from "our service worker": id set, no tab, the worker's own url.
    onMessage.dispatch(message, { id: PREVIEW_EXTENSION_ID, url: bgUrl });
  });
  const onAdded = new FakeEvent();
  const onRemoved = new FakeEvent();
  const storageChanged = new FakeEvent();
  const send = (message: unknown, ...rest: unknown[]) => {
    const reply = background.handle(message);
    const callback = rest.find((arg) => typeof arg === 'function') as
      ((r: unknown) => void) | undefined;
    if (callback) {
      void reply.then(callback);
      return undefined;
    }
    return reply;
  };

  const openTarget = (target: string) => {
    for (const listener of background.events.onOpen) listener(target);
  };
  // The gallery switches its frame; a standalone preview navigates its own tab.
  background.events.onOpen.add((target) => {
    const route = resolvePreviewTarget(target, window.location.origin);
    if (route === null) return;
    if (window.parent !== window) {
      window.parent.postMessage(
        { type: 'clavis-preview-open', url: target },
        window.location.origin,
      );
    } else if (route.kind === 'screen') {
      window.location.assign(standalonePreviewUrl(route, window.location.search));
    } else {
      window.open(route.href, '_blank', 'noopener');
    }
  });

  const syncPermissions = (granted: boolean) => {
    background.state.granted = granted;
    (granted ? onAdded : onRemoved).dispatch({ origins: ['https://*/*', 'http://*/*'] });
  };

  const fake = {
    i18n: {
      getMessage,
      getUILanguage: () => 'en',
    },
    runtime: {
      id: PREVIEW_EXTENSION_ID,
      getURL: (path: string) => `${ORIGIN}/${path.replace(/^\//, '')}`,
      getManifest: () => ({ manifest_version: 3, name: 'Clavis', version: '1.0.0' }),
      getPlatformInfo: async () => ({ os: 'linux', arch: 'x86-64' }),
      lastError: undefined,
      sendMessage: send,
      onMessage,
      onInstalled: new FakeEvent(),
      onStartup: new FakeEvent(),
      openOptionsPage: async () => openTarget(`${ORIGIN}/options.html`),
    },
    storage: {
      local: storageArea(storageChanged, 'local'),
      session: storageArea(storageChanged, 'session'),
      sync: storageArea(storageChanged, 'sync'),
      onChanged: storageChanged,
    },
    permissions: {
      contains: async () => background.state.granted,
      request: async () => {
        syncPermissions(true);
        return true;
      },
      remove: async () => {
        syncPermissions(false);
        return true;
      },
      onAdded,
      onRemoved,
    },
    tabs: {
      query: async () => [TAB],
      create: async (properties: { url?: string }) => {
        if (properties.url) openTarget(properties.url);
        return { ...TAB, id: 2 };
      },
      getCurrent: async () => TAB,
      sendMessage: async () => undefined,
      onRemoved: new FakeEvent(),
      onUpdated: new FakeEvent(),
    },
    tts: {
      getVoices: (callback?: (voices: unknown[]) => void) => {
        const voices = (
          options.scenario === 'no-voice'
            ? []
            : options.scenario === 'online-only'
              ? ONLINE_VOICES
              : [...LOCAL_VOICES, ...ONLINE_VOICES]
        ).map((v) => ({
          voiceName: v.name,
          lang: v.lang,
          remote: v.remote,
        }));
        if (callback) callback(voices);
        return Promise.resolve(voices);
      },
      speak: () => undefined,
      stop: () => undefined,
      onVoicesChanged: new FakeEvent(),
    },
    sidePanel: {
      setOptions: async () => undefined,
      open: async () => undefined,
      setPanelBehavior: async () => undefined,
    },
    contextMenus: {
      create: () => undefined,
      removeAll: async () => undefined,
      onClicked: new FakeEvent(),
    },
    scripting: {
      executeScript: async () => [],
      registerContentScripts: async () => undefined,
      unregisterContentScripts: async () => undefined,
      getRegisteredContentScripts: async () => [],
    },
    action: { setBadgeText: async () => undefined, onClicked: new FakeEvent() },
    commands: { onCommand: new FakeEvent() },
  };

  const target = globalThis as unknown as Record<string, unknown>;
  target['chrome'] = fake;
  target['browser'] = fake;
  if (options.scenario === 'offline') {
    try {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    } catch {
      /* read-only in this browser: the card then words errors for an online browser */
    }
  }
  return background;
}
