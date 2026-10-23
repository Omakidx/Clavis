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
  closeOffscreen,
  offscreenDocuments,
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

test('GET_VOICES from options reports the platform, both engines and the offscreen availability', async () => {
  const options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  expect(await offscreenDocuments(ext.serviceWorker)).toHaveLength(0);

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
  expect(report?.engines.offscreen.available).toBe(true);
  // Both engines are always listed so the D-07 comparison can be made from Settings.
  expect(Array.isArray(report?.engines.chromeTts.voices)).toBe(true);
  expect(Array.isArray(report?.engines.offscreen.voices)).toBe(true);
  const total =
    (report?.engines.chromeTts.voices.length ?? 0) + (report?.engines.offscreen.voices.length ?? 0);
  if (total === 0) expect(report?.defaultEngine).toBe('none');
  // The probe is bounded (one voice wait plus document start, hard limit 4 s) ...
  expect(tookMs).toBeLessThan(5_500);
  // ... and the document it needed is closed again.
  await expect.poll(async () => (await offscreenDocuments(ext.serviceWorker)).length).toBe(0);
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
    expect(reply.data?.engines.offscreen.available).toBe(true);
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

test.describe('offscreen document hardening (Phase 3 review INFO-9)', () => {
  const COMMANDS = [
    { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_GET_VOICES' },
    {
      v: 1,
      target: 'offscreen',
      type: 'SPEECH_OFFSCREEN_SPEAK',
      requestId: '11111111-1111-4111-8111-111111111111',
      text: 'bank',
      rate: 1,
    },
    { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_STOP' },
  ];

  test('obeys the service worker only: not a content script, not any extension page', async () => {
    // A document for the commands to be sent to (any earlier probe has closed its own).
    await expect.poll(async () => (await offscreenDocuments(ext.serviceWorker)).length).toBe(0);
    await ext.serviceWorker.evaluate(
      `chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'test' })`,
    );
    try {
      // The worker (sender.url is the worker script) gets an answer.
      const fromWorker = await sendWhenReady(
        `chrome.runtime.sendMessage(${JSON.stringify(COMMANDS[0])})`,
      );
      expect(fromWorker).toMatchObject({ ok: true, supported: true });

      const pages: Page[] = [];
      for (const name of ['options', 'popup', 'onboarding', 'reader', 'practice']) {
        pages.push(await openExtensionPage(ext.context, ext.extensionId, name));
      }
      for (const extensionPage of pages) {
        for (const command of COMMANDS) {
          // No reply from the offscreen page (undefined), and no router route answers it either.
          expect((await sendFromPage(extensionPage, command)) ?? null).toBeNull();
        }
      }
      for (const command of COMMANDS) {
        expect(
          (await world.evaluate(
            `chrome.runtime.sendMessage(${JSON.stringify(command)}).catch(() => null)`,
          )) ?? null,
        ).toBeNull();
      }
    } finally {
      await closeOffscreen(ext.serviceWorker).catch(() => undefined);
    }
  });

  /** The page may still be loading right after creation; retry until its listener is there. */
  async function sendWhenReady(expression: string): Promise<unknown> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await ext.serviceWorker.evaluate(expression);
      } catch (error) {
        if (Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});
