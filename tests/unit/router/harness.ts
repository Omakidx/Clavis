import { vi } from 'vitest';
import { GroqError } from '../../../lib/ai/errors';
import type { GroqModel } from '../../../lib/ai/groq';
import type { ExplainResult } from '../../../lib/contracts';
import { createAiHandlers, type AiProvider } from '../../../lib/router/handlers/ai';
import { createKeyService } from '../../../lib/router/handlers/key';
import { createSettingsHandlers } from '../../../lib/router/handlers/settings';
import { createAiGuard } from '../../../lib/router/limiter';
import { createMessageListener, type Route } from '../../../lib/router/router';
import { buildRoutes } from '../../../lib/router/routes';
import type { SenderLike } from '../../../lib/router/sender';
import { createSpeechHandlers } from '../../../lib/speech/background';
import { SpeechService } from '../../../lib/speech/service';
import { createApiKeyStore, createSettingsStore } from '../../../lib/storage';
import { MemoryArea } from '../storage/memory-area';
import { FakeEngine, voice } from '../speech/helpers';

export const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const ORIGIN = `chrome-extension://${RUNTIME_ID}`;
export const REQ_A = '11111111-1111-4111-8111-111111111111';
export const REQ_B = '22222222-2222-4222-8222-222222222222';
export const FAKE_KEY = 'gsk_TESTabcdefghijklmnopqrstuvwx1234';

// ---- senders ----------------------------------------------------------------

export const contentSender = (tabId = 5, url = 'https://example.com/article'): SenderLike => ({
  id: RUNTIME_ID,
  url,
  frameId: 0,
  tab: { id: tabId, url },
});

/** An extension page in its own tab (options, onboarding, reader, practice). */
export const pageSender = (path: string, tabId: number | null = 9): SenderLike => ({
  id: RUNTIME_ID,
  url: `${ORIGIN}${path}`,
  frameId: 0,
  ...(tabId === null ? {} : { tab: { id: tabId, url: `${ORIGIN}${path}` } }),
});

/** The popup has no tab. */
export const popupSender = (): SenderLike => pageSender('/popup.html', null);

export const offscreenSender = (): SenderLike => ({
  id: RUNTIME_ID,
  url: `${ORIGIN}/offscreen.html`,
});

// ---- messages -----------------------------------------------------------------

export const snapshot = { selectionId: REQ_B, source: 'webpage', kind: 'word', text: 'bank' };
export const explainMessage = (requestId = REQ_A, over: object = {}) => ({
  v: 1,
  type: 'AI_EXPLAIN',
  payload: { requestId, snapshot, mode: 'core', detailLevel: 'standard', ...over },
});

export const PUBLIC_MESSAGES: Record<string, unknown> = {
  AI_EXPLAIN: explainMessage(),
  AI_CANCEL: { v: 1, type: 'AI_CANCEL', requestId: REQ_A },
  TTS_SPEAK: { v: 1, type: 'TTS_SPEAK', requestId: REQ_A, text: 'bank', rate: 1 },
  TTS_STOP: { v: 1, type: 'TTS_STOP' },
  GET_PUBLIC_SETTINGS: { v: 1, type: 'GET_PUBLIC_SETTINGS' },
  GET_AI_STATUS: { v: 1, type: 'GET_AI_STATUS' },
};

export const KEY_MESSAGES: Record<string, unknown> = {
  SET_API_KEY: { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' },
  TEST_API_KEY: { v: 1, type: 'TEST_API_KEY' },
  REMOVE_API_KEY: { v: 1, type: 'REMOVE_API_KEY' },
  GET_KEY_STATUS: { v: 1, type: 'GET_KEY_STATUS' },
  CLEAR_ALL_DATA: { v: 1, type: 'CLEAR_ALL_DATA' },
};

export const SETTINGS_MESSAGES: Record<string, unknown> = {
  GET_SETTINGS: { v: 1, type: 'GET_SETTINGS' },
  UPDATE_PREFERENCES: { v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'simple' } },
  RESET_PREFERENCES: { v: 1, type: 'RESET_PREFERENCES' },
  ACCEPT_DISCLOSURE: { v: 1, type: 'ACCEPT_DISCLOSURE' },
  UPDATE_ONBOARDING: { v: 1, type: 'UPDATE_ONBOARDING', completed: true },
  GET_SITE_ACCESS_STATUS: { v: 1, type: 'GET_SITE_ACCESS_STATUS' },
};

export const PRIVILEGED_MESSAGES = { ...KEY_MESSAGES, ...SETTINGS_MESSAGES };

// ---- the assembled background -----------------------------------------------

export const RESULT: ExplainResult = {
  requestId: REQ_A,
  selectedText: 'bank',
  mode: 'core',
  title: 'bank',
  summary: 'A financial institution.',
  provider: 'groq',
  model: 'openai/gpt-oss-20b',
};

export const MODELS: GroqModel[] = [
  { id: 'openai/gpt-oss-20b', supportsJsonSchema: true, active: true },
  { id: 'openai/gpt-oss-120b', supportsJsonSchema: true },
  { id: 'whisper-large-v3', supportsJsonSchema: false },
  { id: 'llama-guard-4-12b', supportsJsonSchema: false },
];

export interface HarnessOptions {
  lockedDown?: boolean;
  now?: () => number;
}

/** The real router, handlers, stores and guard over in-memory storage and a scripted provider. */
export function createHarness(options: HarnessOptions = {}) {
  const local = new MemoryArea();
  const session = new MemoryArea();
  const state = { lockedDown: options.lockedDown ?? true };
  const now = options.now ?? Date.now;
  const lockedDown = (): Promise<boolean> => Promise.resolve(state.lockedDown);

  const settingsStore = createSettingsStore({ area: local, now });
  const keyStore = createApiKeyStore({ local, session, lockedDown });
  const guard = createAiGuard(now);

  const provider = {
    listModels: vi.fn<AiProvider['listModels']>(() => Promise.resolve(MODELS)),
    explain: vi.fn<AiProvider['explain']>(() => Promise.resolve(RESULT)),
  };
  const keyService = createKeyService({
    store: keyStore,
    provider,
    now,
    onKeyChanged: () => guard.inFlight.abortAll(),
  });
  const siteAccess = {
    reconcile: vi.fn(() => Promise.resolve('unchanged' as const)),
    getStatus: vi.fn(() => Promise.resolve({ granted: true, registered: true })),
  };
  const ai = createAiHandlers({
    settings: settingsStore,
    keys: keyStore,
    keyService,
    provider,
    guard,
    lockedDown,
  });
  const settings = createSettingsHandlers({
    settings: settingsStore,
    keys: keyStore,
    siteAccess,
    guard,
    areas: [local, session],
  });

  const chromeTts = new FakeEngine('chrome-tts', [voice('chrome-tts', 'en-US')]);
  const speechService = new SpeechService({ engines: [chromeTts], startTimeoutMs: 1_000 });
  const speech = createSpeechHandlers({
    service: speechService,
    offscreenEngine: { handlePageEvent: vi.fn(), handlePageIdle: vi.fn() },
    push: () => Promise.resolve(),
  });
  const injection = {
    scripting: { executeScript: vi.fn(() => Promise.resolve([{ frameId: 0 }])) },
    tabs: { sendMessage: vi.fn(() => Promise.resolve({ ok: true, shown: true })) },
    files: ['/content-scripts/content.js' as const],
  };

  const routes: Route[] = buildRoutes({
    ai,
    keys: keyService,
    settings,
    speech,
    injection: injection as never,
  });
  const listener = createMessageListener({
    identity: { runtimeId: RUNTIME_ID, extensionOrigin: ORIGIN },
    routes,
  });

  /**
   * Deliver a message like chrome.runtime would. `claimed` is the listener's return value
   * (`true` = the channel stays open, `undefined` = the message was not claimed);
   * `reply` resolves with whatever was sent back, or `undefined` if nothing was.
   */
  function send(message: unknown, sender: SenderLike) {
    let respond: (value: unknown) => void = () => undefined;
    const reply = new Promise<unknown>((resolve) => {
      respond = resolve;
    });
    let responded = false;
    const claimed = listener(message, sender, (value) => {
      responded = true;
      respond(value);
    });
    if (claimed !== true && !responded) respond(undefined);
    return { claimed, reply };
  }
  const call = (message: unknown, sender: SenderLike): Promise<unknown> =>
    send(message, sender).reply;

  return {
    local,
    session,
    state,
    settingsStore,
    keyStore,
    keyService,
    guard,
    provider,
    siteAccess,
    injection,
    chromeTts,
    speechService,
    routes,
    send,
    call,
  };
}

export type Harness = ReturnType<typeof createHarness>;

export function failWith(code: ConstructorParameters<typeof GroqError>[0], status?: number) {
  return new GroqError(code, status === undefined ? {} : { status });
}

/** Complete setup: key stored (local), disclosure accepted. */
export async function makeReady(h: Harness): Promise<void> {
  await h.call(KEY_MESSAGES['SET_API_KEY'], pageSender('/options.html'));
  await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], pageSender('/options.html'));
}
