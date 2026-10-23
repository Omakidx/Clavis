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
  contextTypes,
  newId,
  openExtensionPage,
  sendFromPage,
  type VoicesReply,
} from './p6-speech-support/speech';

// Phase 6: GET_VOICES (Settings voice chooser, D-07 check) and the speech boundary in the BUILT
// extension. On this Linux machine there are no voices; the report must say so plainly and the
// offscreen document is used for the probe only.

let ext: LaunchedExtension;
let server: FixtureServer;
let page: Page;
let world: ContentWorld;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
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

const GET_VOICES = { v: 1, type: 'GET_VOICES' };

test('GET_VOICES from options reports the platform and the chrome.tts voices; the offscreen slot is unavailable', async () => {
  const options = await openExtensionPage(ext.context, ext.extensionId, 'options');

  const started = Date.now();
  const reply = (await sendFromPage(options, GET_VOICES)) as VoicesReply;
  const tookMs = Date.now() - started;
  await test.info().attach('voices-report.json', {
    body: JSON.stringify({ tookMs, reply }, null, 2),
    contentType: 'application/json',
  });
  console.log(`P6 VOICES REPORT (${tookMs} ms)\n${JSON.stringify(reply, null, 2)}`);

  expect(reply.ok).toBe(true);
  const report = reply.data;
  expect(report?.platform).toBe(process.platform === 'linux' ? 'linux' : report?.platform);
  expect(Array.isArray(report?.engines.chromeTts.voices)).toBe(true);
  // D-07: no fallback engine; the slot stays in the contract, empty and unavailable.
  expect(report?.engines.offscreen).toEqual({ available: false, voices: [] });
  const chromeVoices = report?.engines.chromeTts.voices.length ?? 0;
  expect(report?.defaultEngine).toBe(chromeVoices === 0 ? 'none' : 'chrome-tts');
  // One voice wait at most (chrome.tts loads voices late on Linux).
  expect(tookMs).toBeLessThan(3_000);
});

test('GET_VOICES from the popup and onboarding pages works too', async () => {
  for (const name of ['popup', 'onboarding']) {
    const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
    expect(await sendFromPage(extensionPage, GET_VOICES), name).toMatchObject({ ok: true });
    await extensionPage.close();
  }
});

test('concurrent GET_VOICES calls all get a full answer', async () => {
  const options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  const replies = (await Promise.all([
    sendFromPage(options, GET_VOICES),
    sendFromPage(options, GET_VOICES),
    sendFromPage(options, GET_VOICES),
  ])) as VoicesReply[];
  for (const reply of replies) {
    expect(reply.ok).toBe(true);
    expect(reply.data?.engines.offscreen.available).toBe(false);
  }
});

test('a content script cannot call GET_VOICES, and neither can the reader or practice page', async () => {
  const fromContentScript = await world.evaluate<VoicesReply>(
    `chrome.runtime.sendMessage(${JSON.stringify(GET_VOICES)})`,
  );
  expect(fromContentScript).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  expect(fromContentScript).not.toHaveProperty('data');
  for (const name of ['reader', 'practice']) {
    const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
    expect(await sendFromPage(extensionPage, GET_VOICES), name).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    await extensionPage.close();
  }
});

test('SPEECH_DIAGNOSE is gone: nobody answers it', async () => {
  const options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  expect((await sendFromPage(options, { v: 1, type: 'SPEECH_DIAGNOSE' })) ?? null).toBeNull();
  expect(
    (await world.evaluate(
      `chrome.runtime.sendMessage({ v: 1, type: 'SPEECH_DIAGNOSE' }).catch(() => null)`,
    )) ?? null,
  ).toBeNull();
});

test('the offscreen fallback is gone (D-07): its messages are unanswered and no document opens', async () => {
  const options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  const messages = [
    { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_GET_VOICES' },
    { v: 1, type: 'SPEECH_OFFSCREEN_EVENT', requestId: newId(), state: 'ended' },
    { v: 1, type: 'SPEECH_OFFSCREEN_IDLE' },
  ];
  for (const message of messages) {
    expect((await sendFromPage(options, message)) ?? null).toBeNull();
    expect(
      (await world.evaluate(
        `chrome.runtime.sendMessage(${JSON.stringify(message)}).catch(() => null)`,
      )) ?? null,
    ).toBeNull();
  }
  // The page itself is not part of the build.
  const missing = await ext.context.newPage();
  const response = await missing
    .goto(`chrome-extension://${ext.extensionId}/offscreen.html`)
    .catch(() => null);
  expect(response === null || !response.ok()).toBe(true);
  expect(await contextTypes(ext.serviceWorker)).not.toContain('OFFSCREEN_DOCUMENT');
});
