import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { contentWorld, type ContentWorld } from './p3-support/content-world';
import { installScriptedTts } from './p6-listen-support/listen';
import {
  SENTENCE,
  WORD,
  newId,
  contextTypes,
  openExtensionPage,
  sendFromPage,
  speakMessage,
  type SpeechReply,
  type VoicesReply,
} from './p6-speech-support/speech';

// Phase 6, Listen in the BUILT extension with a scripted empty voice catalog on every OS.
// The honesty rule (FR-023): never a started state without a voice, and platform-appropriate
// installation guidance. Native speech voices may arrive after the first enumeration, so the
// empty catalog is explicit rather than inferred from a temporarily empty native list.
//
// Audio itself cannot be heard or asserted here (D-14: by hand); see p6-speech-events.spec.ts for
// the started/ended/cancelled paths with a scripted chrome.tts.

let ext: LaunchedExtension;
let server: FixtureServer;
let page: Page;
let world: ContentWorld;
let options: Page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
  // Native voice enumeration is asynchronous on macOS. Model an empty device explicitly so
  // these negative cases cannot turn into successful native playback halfway through the test.
  await installScriptedTts(ext.serviceWorker, []);
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  const report = (await sendFromPage(options, { v: 1, type: 'GET_VOICES' })) as VoicesReply;
  expect(report.ok).toBe(true);
  expect(report.data?.engines.chromeTts.voices).toEqual([]);
  expect(report.data?.engines.offscreen.voices).toEqual([]);
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

const fromContentScript = (message: unknown): Promise<SpeechReply | undefined> =>
  world.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

const NO_VOICE = {
  ok: false,
  error: {
    code: 'NO_VOICE',
    ...(process.platform === 'linux' ? { reason: 'no-voice-linux' } : {}),
  },
};

for (const [label, text] of [
  ['a word', WORD],
  ['a full sentence', SENTENCE],
] as const) {
  test.describe(`TTS_SPEAK for ${label}`, () => {
    test('from a content script is NO_VOICE with the platform-appropriate reason, never a started state', async () => {
      const message = speakMessage(text);
      const reply = await fromContentScript(message);
      expect(reply).toMatchObject({ ...NO_VOICE, requestId: message.requestId });
      expect(reply?.error?.reason).toBe(
        process.platform === 'linux' ? 'no-voice-linux' : undefined,
      );
      expect(reply).not.toHaveProperty('data');
      expect(reply?.error?.message).toMatch(/\S/);
      // The text is not echoed anywhere.
      expect(JSON.stringify(reply)).not.toContain(text);
    });

    test('from the practice page is NO_VOICE with the platform-appropriate reason', async () => {
      const practice = await openExtensionPage(ext.context, ext.extensionId, 'practice');
      const reply = (await sendFromPage(practice, speakMessage(text))) as SpeechReply;
      expect(reply).toMatchObject(NO_VOICE);
      expect(reply).not.toHaveProperty('data');
      await practice.close();
    });
  });
}

test('the reader, popup and options pages get the same honest answer', async () => {
  for (const name of ['reader', 'popup', 'options']) {
    const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
    const reply = (await sendFromPage(extensionPage, speakMessage(WORD))) as SpeechReply;
    expect(reply, name).toMatchObject(NO_VOICE);
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

test('the first no-voice answer takes about one voice wait; later answers are immediate', async () => {
  // A fresh browser, so this worker has not yet learned that the machine has no voices.
  const fresh = await launchExtension();
  try {
    await installScriptedTts(fresh.serviceWorker, []);
    const page = await openExtensionPage(fresh.context, fresh.extensionId, 'practice');
    const first = Date.now();
    const firstReply = (await sendFromPage(page, speakMessage(WORD))) as SpeechReply;
    const firstMs = Date.now() - first;
    expect(firstReply).toMatchObject(NO_VOICE);
    // chrome.tts waits once (1.5 s) for late-loading voices; nothing else is waited for.
    test.info().annotations.push({ type: 'first-no-voice-ms', description: String(firstMs) });
    expect(firstMs).toBeLessThan(3_000);

    const second = Date.now();
    expect(await sendFromPage(page, speakMessage(SENTENCE))).toMatchObject(NO_VOICE);
    expect(Date.now() - second).toBeLessThan(750);
  } finally {
    await fresh.close();
  }
});

test('no offscreen document is ever created (D-07: chrome.tts only)', async () => {
  await fromContentScript(speakMessage(WORD));
  await sendFromPage(options, { v: 1, type: 'GET_VOICES' });
  expect(await contextTypes(ext.serviceWorker)).not.toContain('OFFSCREEN_DOCUMENT');
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
