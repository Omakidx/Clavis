import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { contentWorld, type ContentWorld } from './p3-support/content-world';
import {
  SENTENCE,
  WORD,
  openExtensionPage,
  sendFromPage,
  speakMessage,
  type SpeechReply,
  type VoicesReply,
} from './p6-speech-support/speech';

// Phase 6: the POSITIVE path (voices present, started, ended/cancelled events) in the BUILT
// extension. This machine has no voices, so `chrome.tts` inside the service worker is replaced by
// a scripted engine that behaves like Chrome's: `start` after speak, `interrupted` on the
// utterance it replaces or that is stopped, `end` when the test says the audio finished. Every
// other piece is the real build: router, sender classification, voice choice, preferences in
// storage, and tabs.sendMessage delivery to the asking document.
//
// Nothing here proves audio is audible (D-14: by hand).

let ext: LaunchedExtension;
let server: FixtureServer;
let options: Page;
let pageA: Page;
let pageB: Page;
let worldA: ContentWorld;
let worldB: ContentWorld;

interface TtsEventSeen {
  v: number;
  type: string;
  requestId: string;
  state: string;
}

const VOICES = [
  { voiceName: 'Test Voice US', lang: 'en-US', remote: false, eventTypes: ['start', 'end'] },
  { voiceName: 'Test Voice GB', lang: 'en-GB', remote: false, eventTypes: ['start', 'end'] },
  { voiceName: 'Test Voix FR', lang: 'fr-FR', remote: false, eventTypes: ['start', 'end'] },
];

async function installScriptedTts(
  voices: typeof VOICES,
  options: { failStartVoiceNames?: string[] } = {},
): Promise<void> {
  await ext.serviceWorker.evaluate(
    (input) => {
      const list = input.voices;
      type Api = { runtime?: { id?: string }; tts: Record<string, unknown> };
      const g = globalThis as unknown as {
        chrome: Api;
        browser?: Api;
        __tts?: unknown;
      };
      // Match the namespace selected by wxt/browser in the built speech engine.
      const api = g.browser?.runtime?.id ? g.browser : g.chrome;
      const state = {
        voices: list,
        calls: [] as { voiceName?: string; lang?: string; rate?: number; chars: number }[],
        current: undefined as undefined | ((e: { type: string }) => void),
        failStartVoiceNames: [] as string[],
      };
      g.__tts = state;
      state.failStartVoiceNames = input.failStartVoiceNames;
      api.tts['getVoices'] = () => Promise.resolve(state.voices);
      api.tts['speak'] = (
        text: string,
        opts: {
          voiceName?: string;
          lang?: string;
          rate?: number;
          onEvent: (e: { type: string }) => void;
        },
      ) => {
        state.calls.push({
          ...(opts.voiceName === undefined ? {} : { voiceName: opts.voiceName }),
          ...(opts.lang === undefined ? {} : { lang: opts.lang }),
          ...(opts.rate === undefined ? {} : { rate: opts.rate }),
          chars: text.length,
        });
        state.current = opts.onEvent;
        const mine = opts.onEvent;
        setTimeout(() => {
          if (state.current !== mine) return;
          if (opts.voiceName !== undefined && state.failStartVoiceNames.includes(opts.voiceName)) {
            state.current = undefined;
            mine({ type: 'error' });
            return;
          }
          mine({ type: 'start' });
        }, 5);
        return Promise.resolve();
      };
      api.tts['stop'] = () => {
        const current = state.current;
        state.current = undefined;
        current?.({ type: 'interrupted' });
      };
    },
    { voices, failStartVoiceNames: options.failStartVoiceNames ?? [] },
  );
}

/** The scripted audio finished (what `end` means to Chrome). */
const finishAudio = (): Promise<void> =>
  ext.serviceWorker.evaluate(() => {
    const state = (globalThis as unknown as { __tts: { current?: (e: { type: string }) => void } })
      .__tts;
    const current = state.current;
    state.current = undefined;
    current?.({ type: 'end' });
  });

const ttsCalls = (): Promise<
  { voiceName?: string; lang?: string; rate?: number; chars: number }[]
> =>
  ext.serviceWorker.evaluate(
    () =>
      (globalThis as unknown as { __tts: { calls: never[] } }).__tts.calls as {
        voiceName?: string;
        lang?: string;
        rate?: number;
        chars: number;
      }[],
  );

async function listenForEvents(world: ContentWorld): Promise<void> {
  await world.evaluate(`(() => {
    if (!globalThis.__ev) {
      globalThis.__ev = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (m && m.type === 'TTS_EVENT') globalThis.__ev.push(m);
      });
    }
    return true;
  })()`);
}

const eventsSeen = (world: ContentWorld): Promise<TtsEventSeen[]> =>
  world.evaluate<TtsEventSeen[]>('JSON.parse(JSON.stringify(globalThis.__ev || []))');

const speakFrom = (world: ContentWorld, message: unknown): Promise<SpeechReply> =>
  world.evaluate<SpeechReply>(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

async function setPreferences(patch: Record<string, unknown>): Promise<void> {
  const reply = (await sendFromPage(options, {
    v: 1,
    type: 'UPDATE_PREFERENCES',
    patch,
  })) as { ok: boolean };
  expect(reply.ok).toBe(true);
}

test.beforeEach(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
  await installScriptedTts(VOICES);
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  // Prove the real app-visible engine reads the mock, rather than the runner's native voices.
  const report = (await sendFromPage(options, { v: 1, type: 'GET_VOICES' })) as VoicesReply;
  expect(report).toMatchObject({
    ok: true,
    data: {
      engines: { chromeTts: { voices: VOICES.map((voice) => ({ name: voice.voiceName })) } },
    },
  });
  pageA = await ext.context.newPage();
  worldA = await contentWorld(pageA);
  await pageA.goto(`${server.origin}/article.html`);
  await worldA.ready();
  await listenForEvents(worldA);
});

test.afterEach(async () => {
  await worldA?.dispose();
  await worldB?.dispose();
  await ext?.close();
  await server?.close();
});

async function openSecondPage(): Promise<void> {
  pageB = await ext.context.newPage();
  worldB = await contentWorld(pageB);
  await pageB.goto(`${server.origin}/article.html`);
  await worldB.ready();
  await listenForEvents(worldB);
}

test('TTS_SPEAK replies started only after the engine started, then `ended` reaches the asking page', async () => {
  const message = speakMessage(SENTENCE, { lang: 'en-US', rate: 0.75 });
  const reply = await speakFrom(worldA, message);
  expect(reply).toMatchObject({
    ok: true,
    requestId: message.requestId,
    data: {
      state: 'started',
      engine: 'chrome-tts',
      voiceName: 'Test Voice US',
      lang: 'en-US',
      remote: false,
    },
  });
  // The whole sentence went to the engine in ONE utterance with the requested rate.
  expect(await ttsCalls()).toEqual([
    { voiceName: 'Test Voice US', lang: 'en-US', rate: 0.75, chars: SENTENCE.length },
  ]);
  expect(await eventsSeen(worldA)).toEqual([]);

  await finishAudio();
  await expect
    .poll(() => eventsSeen(worldA))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: message.requestId, state: 'ended' }]);
});

test('a second request supersedes the first: it is told `cancelled`, the other page only hears its own end', async () => {
  await openSecondPage();
  const first = speakMessage(WORD, { lang: 'en-US' });
  const second = speakMessage(SENTENCE, { lang: 'en-GB' });
  expect(await speakFrom(worldA, first)).toMatchObject({ ok: true });
  expect(await speakFrom(worldB, second)).toMatchObject({
    ok: true,
    data: { voiceName: 'Test Voice GB', lang: 'en-GB' },
  });

  await expect
    .poll(() => eventsSeen(worldA))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: first.requestId, state: 'cancelled' }]);
  expect(await eventsSeen(worldB)).toEqual([]);

  await finishAudio();
  await expect
    .poll(() => eventsSeen(worldB))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: second.requestId, state: 'ended' }]);
  // Page A never hears about B's request.
  expect(await eventsSeen(worldA)).toHaveLength(1);
});

test('TTS_STOP from the asking tab cancels and says so; another tab cannot stop it', async () => {
  await openSecondPage();
  const message = speakMessage(WORD, { lang: 'en-US' });
  await speakFrom(worldA, message);

  expect(await speakFrom(worldB, { v: 1, type: 'TTS_STOP' })).toMatchObject({
    ok: true,
    data: { stopped: false },
  });
  expect(await eventsSeen(worldA)).toEqual([]);

  expect(
    await speakFrom(worldA, { v: 1, type: 'TTS_STOP', requestId: message.requestId }),
  ).toMatchObject({
    ok: true,
    data: { stopped: true },
  });
  await expect
    .poll(() => eventsSeen(worldA))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: message.requestId, state: 'cancelled' }]);
});

test('the event goes to the asking DOCUMENT: a page that replaced it in the same tab hears nothing', async () => {
  const message = speakMessage(WORD, { lang: 'en-US' });
  await speakFrom(worldA, message);
  await pageA.goto(`${server.origin}/article.html?again=1`);
  await worldA.ready();
  await listenForEvents(worldA);

  await finishAudio();
  await ext.serviceWorker.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  expect(await eventsSeen(worldA)).toEqual([]);
  // The worker carries on: the next request is served and its event arrives.
  const next = speakMessage(WORD, { lang: 'en-US' });
  expect(await speakFrom(worldA, next)).toMatchObject({ ok: true });
  await finishAudio();
  await expect
    .poll(() => eventsSeen(worldA))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: next.requestId, state: 'ended' }]);
});

test('an engine error after the start is reported as `error`, with no text', async () => {
  const message = speakMessage(SENTENCE, { lang: 'en-US' });
  await speakFrom(worldA, message);
  await ext.serviceWorker.evaluate(() => {
    const state = (globalThis as unknown as { __tts: { current?: (e: unknown) => void } }).__tts;
    state.current?.({ type: 'error', errorMessage: 'synthesis-failed' });
  });
  await expect
    .poll(() => eventsSeen(worldA))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: message.requestId, state: 'error' }]);
});

test('speaking from the practice page works and its events reach that page', async () => {
  const practice = await openExtensionPage(ext.context, ext.extensionId, 'practice');
  await practice.evaluate(() => {
    const g = globalThis as unknown as {
      __ev: unknown[];
      chrome: { runtime: { onMessage: { addListener(l: (m: { type?: string }) => void): void } } };
    };
    g.__ev = [];
    g.chrome.runtime.onMessage.addListener((m) => {
      if (m.type === 'TTS_EVENT') g.__ev.push(m);
    });
  });
  const message = speakMessage(WORD, { lang: 'en-US' });
  expect(await sendFromPage(practice, message)).toMatchObject({
    ok: true,
    data: { state: 'started' },
  });
  await finishAudio();
  await expect
    .poll(() => practice.evaluate(() => (globalThis as unknown as { __ev: unknown[] }).__ev))
    .toEqual([{ v: 1, type: 'TTS_EVENT', requestId: message.requestId, state: 'ended' }]);
});

test.describe('voice choice with real preferences in storage', () => {
  test('the saved voice and language are used, and a vanished saved voice falls back honestly', async () => {
    await setPreferences({ ttsVoice: 'Test Voice GB', ttsLang: 'en-GB' });
    // No language and no voice in the message: both come from the preferences.
    expect(await speakFrom(worldA, speakMessage(WORD))).toMatchObject({
      ok: true,
      data: { voiceName: 'Test Voice GB', lang: 'en-GB' },
    });
    // The text is French: the saved English voice must not read it.
    expect(await speakFrom(worldA, speakMessage('banque', { lang: 'fr' }))).toMatchObject({
      ok: true,
      data: { voiceName: 'Test Voix FR', remote: false },
    });

    // The saved voice disappears from the device: best match for the language, named in the reply.
    await installScriptedTts(VOICES.filter((v) => v.voiceName !== 'Test Voice GB'));
    await sendFromPage(options, { v: 1, type: 'GET_VOICES' });
    expect(await speakFrom(worldA, speakMessage(WORD, { lang: 'en' }))).toMatchObject({
      ok: true,
      data: { voiceName: 'Test Voice US' },
    });
  });

  test('an explicit voice (Settings test) wins; an unknown one is NO_VOICE without a stand-in', async () => {
    await setPreferences({ ttsVoice: 'Test Voice US' });
    expect(
      await sendFromPage(options, speakMessage(WORD, { voiceName: 'Test Voice GB' })),
    ).toMatchObject({ ok: true, data: { voiceName: 'Test Voice GB', lang: 'en-GB' } });
    const calls = (await ttsCalls()).length;
    const reply = (await sendFromPage(
      options,
      speakMessage(WORD, { voiceName: 'Not Installed' }),
    )) as SpeechReply;
    expect(reply).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
    expect(reply).not.toHaveProperty('data');
    expect(await ttsCalls()).toHaveLength(calls);
  });

  test('no voice for the language: NO_VOICE with reason no-voice-language, never another language (FR-024)', async () => {
    const reply = await speakFrom(worldA, speakMessage('Haus', { lang: 'de' }));
    expect(reply).toMatchObject({
      ok: false,
      error: { code: 'NO_VOICE', reason: 'no-voice-language' },
    });
    expect(await ttsCalls()).toHaveLength(0);
  });

  test('Automatic uses a matching online voice when no local voice exists and reports that it is online', async () => {
    await installScriptedTts([
      { voiceName: 'Net Voice', lang: 'en-US', remote: true, eventTypes: ['start', 'end'] },
    ]);
    const automatic = await speakFrom(worldA, speakMessage(WORD, { lang: 'en-US' }));
    expect(automatic).toMatchObject({
      ok: true,
      data: { state: 'started', voiceName: 'Net Voice', remote: true },
    });
    expect(await ttsCalls()).toEqual([
      { voiceName: 'Net Voice', lang: 'en-US', rate: 1, chars: WORD.length },
    ]);
    // GET_VOICES still lists it (as remote) so Settings can offer it as an explicit choice.
    const report = (await sendFromPage(options, { v: 1, type: 'GET_VOICES' })) as VoicesReply;
    expect(report.data?.engines.chromeTts.voices).toEqual([
      { name: 'Net Voice', lang: 'en-US', engine: 'chrome-tts', remote: true },
    ]);
    // Explicit choices still work, and report the same online disclosure signal.
    expect(
      await sendFromPage(options, speakMessage(WORD, { voiceName: 'Net Voice' })),
    ).toMatchObject({ ok: true, data: { voiceName: 'Net Voice', remote: true } });
    await setPreferences({ ttsVoice: 'Net Voice' });
    expect(await speakFrom(worldA, speakMessage(WORD, { lang: 'en' }))).toMatchObject({
      ok: true,
      data: { voiceName: 'Net Voice', remote: true },
    });
  });

  test('Automatic retries with a matching online voice after a local voice fails to start', async () => {
    await installScriptedTts(
      [
        { voiceName: 'Net Voice', lang: 'en-US', remote: true, eventTypes: ['start', 'end'] },
        { voiceName: 'Local Voice', lang: 'en-US', remote: false, eventTypes: ['start', 'end'] },
      ],
      { failStartVoiceNames: ['Local Voice'] },
    );
    const reply = await speakFrom(worldA, speakMessage(WORD, { lang: 'en-US' }));
    expect(reply).toMatchObject({
      ok: true,
      data: { state: 'started', voiceName: 'Net Voice', remote: true },
    });
    expect((await ttsCalls()).map((call) => call.voiceName)).toEqual(['Local Voice', 'Net Voice']);
  });

  test('a local voice is chosen over a network voice of the same language', async () => {
    await installScriptedTts([
      { voiceName: 'Net Voice', lang: 'en-US', remote: true, eventTypes: ['start', 'end'] },
      { voiceName: 'Local Voice', lang: 'en-US', remote: false, eventTypes: ['start', 'end'] },
    ]);
    expect(await speakFrom(worldA, speakMessage(WORD, { lang: 'en-US' }))).toMatchObject({
      ok: true,
      data: { voiceName: 'Local Voice', remote: false },
    });
  });
});

test('a Stop sent while Listen is still starting wins: no audio starts afterwards (H1)', async () => {
  // The voice list is slow to load (what Linux does), so the request is still looking up voices.
  await ext.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as {
      chrome: { tts: { getVoices(): Promise<unknown> } };
      __tts: { voices: unknown };
    };
    const fast = g.chrome.tts.getVoices;
    g.chrome.tts.getVoices = () => new Promise((resolve) => setTimeout(() => resolve(fast()), 800));
  });
  const message = speakMessage(WORD, { lang: 'en-US' });
  const speaking = speakFrom(worldA, message);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(
    await speakFrom(worldA, { v: 1, type: 'TTS_STOP', requestId: message.requestId }),
  ).toMatchObject({
    ok: true,
    data: { stopped: true },
  });
  expect(await speaking).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect(await ttsCalls()).toHaveLength(0);
});

test('GET_VOICES lists the voices of this device for the Settings chooser', async () => {
  const reply = (await sendFromPage(options, { v: 1, type: 'GET_VOICES' })) as VoicesReply;
  expect(reply.ok).toBe(true);
  expect(reply.data?.defaultEngine).toBe('chrome-tts');
  expect(reply.data?.engines.chromeTts.voices).toEqual([
    { name: 'Test Voice US', lang: 'en-US', engine: 'chrome-tts', remote: false },
    { name: 'Test Voice GB', lang: 'en-GB', engine: 'chrome-tts', remote: false },
    { name: 'Test Voix FR', lang: 'fr-FR', engine: 'chrome-tts', remote: false },
  ]);
});
