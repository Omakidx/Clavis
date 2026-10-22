import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { contentWorld, type ContentWorld } from './p3-support/content-world';
import { FAKE_KEY, mockGroq, openExtensionPage, send, type Reply } from './p3-support/background';

// Phase 3, secret boundary in the BUILT extension: what a website's content script, the
// reader and the popup can and cannot do. The observer is registered at runtime (site
// access stands in as granted via the manifest copy, see spike-b-support/extension.ts).

let ext: LaunchedExtension;
let server: FixtureServer;
let page: Page;
let world: ContentWorld;
let options: Page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await mockGroq(ext.context, { current: 'ok' });
  await waitForRegistration(ext.serviceWorker);

  // A key is stored (persistent) and the disclosure accepted, so there is something to steal.
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });

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

/** Send a message from the content-script world and return the reply (or the thrown error text). */
const fromContentScript = (message: unknown): Promise<Reply | undefined> =>
  world.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

test.describe('content script (a website context)', () => {
  test('cannot read storage.local or storage.session: the key is unreachable', async () => {
    for (const area of ['local', 'session']) {
      const outcome = await world.evaluate<{ ok: boolean; text: string }>(
        `chrome.storage.${area}.get(null).then(
           (items) => ({ ok: true, text: JSON.stringify(items) }),
           (error) => ({ ok: false, text: String(error && error.message) }),
         )`,
      );
      // Denied outright (TRUSTED_CONTEXTS), and in no case does it hand back the key.
      expect(outcome.ok, `storage.${area} must be denied`).toBe(false);
      expect(outcome.text).not.toContain(FAKE_KEY);
    }
    // The key really is in storage.local, so a denial is not just an empty store.
    const stored = await ext.serviceWorker.evaluate(() =>
      chrome.storage.local.get(null).then((items) => JSON.stringify(items)),
    );
    expect(stored).toContain(FAKE_KEY);
  });

  test('is refused every privileged route with INVALID_REQUEST', async () => {
    const privileged = [
      { v: 1, type: 'SET_API_KEY', apiKey: 'gsk_TESTattacker00000000000000000', storage: 'local' },
      { v: 1, type: 'GET_KEY_STATUS' },
      { v: 1, type: 'TEST_API_KEY' },
      { v: 1, type: 'REMOVE_API_KEY' },
      { v: 1, type: 'CLEAR_ALL_DATA' },
      { v: 1, type: 'GET_SETTINGS' },
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'simple' } },
      { v: 1, type: 'RESET_PREFERENCES' },
      { v: 1, type: 'ACCEPT_DISCLOSURE' },
      { v: 1, type: 'UPDATE_ONBOARDING', completed: true },
      { v: 1, type: 'GET_SITE_ACCESS_STATUS' },
    ];
    for (const message of privileged) {
      const reply = await fromContentScript(message);
      expect(reply, message.type).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
      expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
      expect(JSON.stringify(reply)).not.toContain('last4');
    }
    // Nothing changed behind the refusals.
    expect(await send(options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
      ok: true,
      data: { hasKey: true, last4: 'AbCd' },
    });
    expect(await send(options, { v: 1, type: 'GET_SETTINGS' })).toMatchObject({
      data: { preferences: { readingLevel: 'standard' } },
    });
  });

  test('can read the public settings (hasKey only) and AI status, never the key', async () => {
    const settings = await fromContentScript({ v: 1, type: 'GET_PUBLIC_SETTINGS' });
    expect(settings).toMatchObject({ ok: true, data: { hasKey: true, disclosureAccepted: true } });
    expect(Object.keys(settings?.data ?? {}).sort()).toEqual([
      'disclosureAccepted',
      'explanationLanguage',
      'hasKey',
      'readingLevel',
      'tooltipBehavior',
      'ttsRate',
    ]);
    expect(JSON.stringify(settings)).not.toContain(FAKE_KEY);
    expect(await fromContentScript({ v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      ok: true,
      data: { state: 'ready' },
    });
  });

  test('a malformed or forged public message gets INVALID_REQUEST, unknown types get no reply', async () => {
    expect(
      await fromContentScript({ v: 1, type: 'GET_PUBLIC_SETTINGS', apiKey: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(
      await fromContentScript({ v: 1, type: 'AI_EXPLAIN', payload: { requestId: 'nope' } }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    // Not claimed by the router: the call resolves with no reply at all.
    expect((await fromContentScript({ v: 1, type: 'GET_API_KEY' })) ?? null).toBeNull();
  });

  test('the page itself (main world) has no way to message the extension', async () => {
    const reachable = await page.evaluate(
      () =>
        typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome?.runtime
          ?.sendMessage,
    );
    expect(reachable).toBe('undefined');
  });
});

test.describe('other extension pages', () => {
  test('the reader and the practice page cannot use key routes, but can use public ones', async () => {
    for (const name of ['reader', 'practice']) {
      const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
      for (const message of [
        { v: 1, type: 'GET_KEY_STATUS' },
        {
          v: 1,
          type: 'SET_API_KEY',
          apiKey: 'gsk_TESTattacker00000000000000000',
          storage: 'local',
        },
        { v: 1, type: 'REMOVE_API_KEY' },
        { v: 1, type: 'GET_SETTINGS' },
      ]) {
        expect(await send(extensionPage, message), `${name} ${message.type}`).toMatchObject({
          ok: false,
          error: { code: 'INVALID_REQUEST' },
        });
      }
      expect(await send(extensionPage, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
        ok: true,
      });
      await extensionPage.close();
    }
  });

  test('the popup can read settings but not touch the key', async () => {
    const popup = await openExtensionPage(ext.context, ext.extensionId, 'popup');
    expect(await send(popup, { v: 1, type: 'GET_SETTINGS' })).toMatchObject({ ok: true });
    expect(await send(popup, { v: 1, type: 'GET_SITE_ACCESS_STATUS' })).toMatchObject({
      ok: true,
      data: { granted: true, registered: true },
    });
    for (const message of [
      { v: 1, type: 'GET_KEY_STATUS' },
      { v: 1, type: 'REMOVE_API_KEY' },
      { v: 1, type: 'CLEAR_ALL_DATA' },
    ]) {
      expect(await send(popup, message), message.type).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    await popup.close();
  });

  test('the key survives every refusal above', async () => {
    expect(await send(options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'local' },
    });
  });
});
