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
  newId,
  offscreenDocuments,
  openExtensionPage,
  sendFromPage,
  speakMessage,
  type SpeechReply,
  type VoicesReply,
} from './p6-speech-support/speech';

// Phase 6, Listen in the BUILT extension on a machine WITHOUT voices (this Linux machine: no
// speech-dispatcher). The honesty rule (FR-023): never a started state without a voice, and the
// answer carries the Linux-specific reason. The tests ask GET_VOICES first and skip themselves on
// a machine that does have voices (they would then be asserting the opposite).
//
// Audio itself cannot be heard or asserted here (D-14: by hand); see p6-speech-events.spec.ts for
// the started/ended/cancelled paths with a scripted chrome.tts.

let ext: LaunchedExtension;
let server: FixtureServer;
let page: Page;
let world: ContentWorld;
let options: Page;
let noVoices = false;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  const report = (await sendFromPage(options, { v: 1, type: 'GET_VOICES' })) as VoicesReply;
  noVoices =
    report.ok &&
    report.data?.engines.chromeTts.voices.length === 0 &&
    report.data.engines.offscreen.voices.length === 0;
  page = await ext.context.newPage();
  world = await contentWorld(page);
  await page.goto(`${server.origin}/article.html`);
  await world.ready();
});

test.afterAll(async () => {
  await world?.dispose();
  await ext?.close();
  await server?.close();
});

test.beforeEach(() => {
  test.skip(!noVoices, 'This machine has speech voices; the no-voice path is not what it shows.');
});

const fromContentScript = (message: unknown): Promise<SpeechReply | undefined> =>
  world.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

const NO_VOICE_LINUX = {
  ok: false,
  error: { code: 'NO_VOICE', reason: 'no-voice-linux' },
};

for (const [label, text] of [
  ['a word', WORD],
  ['a full sentence', SENTENCE],
] as const) {
  test.describe(`TTS_SPEAK for ${label}`, () => {
    test('from a content script is NO_VOICE with the Linux reason, never a started state', async () => {
      const message = speakMessage(text);
      const reply = await fromContentScript(message);
      expect(reply).toMatchObject({ ...NO_VOICE_LINUX, requestId: message.requestId });
      expect(reply).not.toHaveProperty('data');
      expect(reply?.error?.message).toMatch(/\S/);
      // The text is not echoed anywhere.
      expect(JSON.stringify(reply)).not.toContain(text);
    });

    test('from the practice page is NO_VOICE with the Linux reason', async () => {
      const practice = await openExtensionPage(ext.context, ext.extensionId, 'practice');
      const reply = (await sendFromPage(practice, speakMessage(text))) as SpeechReply;
      expect(reply).toMatchObject(NO_VOICE_LINUX);
      expect(reply).not.toHaveProperty('data');
      await practice.close();
    });
  });
}

test('the reader, popup and options pages get the same honest answer', async () => {
  for (const name of ['reader', 'popup', 'options']) {
    const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
    const reply = (await sendFromPage(extensionPage, speakMessage(WORD))) as SpeechReply;
    expect(reply, name).toMatchObject(NO_VOICE_LINUX);
    if (name !== 'options') await extensionPage.close();
  }
});

test('a named voice that does not exist is NO_VOICE, not a substitute', async () => {
  const reply = (await sendFromPage(
    options,
    speakMessage(WORD, { voiceName: 'Imaginary Voice' }),
  )) as SpeechReply;
  expect(reply).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
  expect(reply).not.toHaveProperty('data');
});

test('the first no-voice answer is bounded, and later answers are immediate', async () => {
  // A fresh worker would repeat the wait; here the earlier tests already learned that there is no
  // voice. Force a new look with GET_VOICES, then measure the next request after it.
  await sendFromPage(options, { v: 1, type: 'GET_VOICES' });
  const first = Date.now();
  await fromContentScript(speakMessage(WORD));
  const firstMs = Date.now() - first;
  // chrome.tts and the offscreen document are probed concurrently: about one voice wait (1.5 s),
  // never the 3 s the engines needed one after the other. The hard bound is the 4 s probe limit.
  expect(firstMs).toBeLessThan(4_500);

  const second = Date.now();
  const reply = await fromContentScript(speakMessage(SENTENCE));
  expect(reply).toMatchObject(NO_VOICE_LINUX);
  expect(Date.now() - second).toBeLessThan(750);
  // The remembered "no voice" answer did not leave an offscreen document behind.
  await expect.poll(async () => (await offscreenDocuments(ext.serviceWorker)).length).toBe(0);
});

test('TTS_STOP is ok with nothing playing, from a content script and a page', async () => {
  expect(await fromContentScript({ v: 1, type: 'TTS_STOP' })).toMatchObject({
    ok: true,
    data: { stopped: false },
  });
  const stale = newId();
  expect(await fromContentScript({ v: 1, type: 'TTS_STOP', requestId: stale })).toMatchObject({
    ok: true,
    requestId: stale,
    data: { stopped: false },
  });
  expect(await sendFromPage(options, { v: 1, type: 'TTS_STOP' })).toMatchObject({
    ok: true,
    data: { stopped: false },
  });
});

test('invalid requests get an error envelope, never a speak attempt', async () => {
  expect(await fromContentScript(speakMessage(WORD, { rate: 9 }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' },
  });
  expect(await fromContentScript(speakMessage('x'.repeat(2001)))).toMatchObject({
    ok: false,
    error: { code: 'SELECTION_TOO_LONG' },
  });
  expect(await fromContentScript(speakMessage(WORD, { voiceName: '' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' },
  });
  expect(await fromContentScript(speakMessage(WORD, { engine: 'chrome-tts' }))).toMatchObject({
    ok: false,
    error: { code: 'INVALID_REQUEST' },
  });
});
