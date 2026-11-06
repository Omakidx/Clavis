import { expect, test, type Page } from '@playwright/test';
import { clavisKeys, openExtensionPage, readStorage, send } from './p3-support/background';
import { contentWorld, type ContentWorld } from './p3-support/content-world';
import { CARD, cardOf, chatBody, explainWord } from './p5-card-support/harness';
import { fakeGroq } from './p5-support/groq';
import { openFixtureReady } from './p7-reader-support/helpers';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';
import { startWorld, type World } from './p8-accept-support/world';
import { waitForRegistration } from './spike-b-support/extension';
import { startFixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';
import { installScript, pause, type Script } from './p9-support/card';
import { walkOnboardingAccessAlreadyGranted } from './p9-support/onboarding';
import { installLedger, type Ledger } from './p9-support/ledger';
import { primeWorkerRoutes, restartableGranted } from './p9-support/restart';
import {
  CANARY,
  EXTENSION_PAGE_RECORDER,
  MAIN_WORLD_SNIFFER,
  collectLogs,
  dumpDom,
  installRecorder,
  leaksIn,
  pageStores,
  readRecorder,
  type Recorded,
} from './p9-support/secrets';

// Phase 9, "Add chrome.runtime/storage message integration tests and secret-boundary checks" and
// "Inspect content-script messages/DOM/storage to confirm key never leaves trusted extension
// contexts" (FR-070, NFR privacy "zero exposure of API keys to page DOM or content scripts",
// abuse case 1, architecture section 9 "Secret boundary (normative)").
//
// A canary key is typed into the REAL onboarding wizard of a new profile, then used through every
// surface (web page card, side panel, PDF reader) in success and in failure, while the test records
// everything that could expose it: every console line of every page and worker, every message a
// content script or extension page sends, receives or gets back, every storage event delivered to a
// content script, the DOM of every page including closed shadow roots, web storage, and every
// network request. The provider is made hostile on purpose: its error bodies echo the key.
//
// Earlier suites prove single facts (storage denied to a content script, refused routes, last4
// only, no key in the Settings DOM). This one proves the whole session leaks nothing.

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let world: World;
let ledger: Ledger;
let script: Script;
let logs: string[];
const recorders: { label: string; get(): Promise<Recorded> }[] = [];
const sniffers: { label: string; page: Page }[] = [];

/** A provider whose every failure repeats the key and the prompt back (the worst a server can do). */
const echoBody = (key: string): string =>
  JSON.stringify({
    error: {
      message: `Invalid API Key ${key}. Authorization: Bearer ${key}`,
      type: 'invalid_request_error',
      code: 'invalid_api_key',
    },
  });

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  logs = collectLogs(world.ext.context);
  ledger = await installLedger(world.ext.context);
  script = await installScript(world.ext.context);
});
test.afterAll(async () => {
  await world?.close();
});

/** Everything observable so far, searched for the canary. */
async function sweep(label: string, pages: Page[]): Promise<void> {
  const problems: string[] = [];
  for (const line of logs)
    if (leaksIn(line).length) problems.push(`console: ${line.slice(0, 160)}`);
  for (const entry of ledger.entries) {
    if (leaksIn(`${entry.url}\n${entry.body ?? ''}`).length && entry.host !== 'api.groq.com') {
      problems.push(`request to ${entry.host}`);
    }
    if (entry.host === 'api.groq.com' && leaksIn(entry.url).length) problems.push('groq url');
  }
  for (const page of pages) {
    if (page.isClosed()) continue;
    if (leaksIn(await dumpDom(page)).length) problems.push(`DOM of ${page.url()}`);
    if (leaksIn(await pageStores(page)).length) problems.push(`web storage of ${page.url()}`);
  }
  for (const sniffer of sniffers) {
    if (sniffer.page.isClosed()) continue;
    const seen = await sniffer.page.evaluate(() =>
      JSON.stringify((globalThis as { __p9sniff?: string[] }).__p9sniff ?? []),
    );
    if (leaksIn(seen).length) problems.push(`page-visible events of ${sniffer.label}`);
  }
  for (const recorder of recorders) {
    const rec = await recorder.get().catch(() => undefined);
    if (rec === undefined) continue;
    for (const [kind, items] of Object.entries(rec)) {
      for (const item of items as string[]) {
        if (leaksIn(item).length) problems.push(`${recorder.label} ${kind}: ${item.slice(0, 120)}`);
      }
    }
  }
  expect(problems, `the key leaked (${label})`).toEqual([]);
  expect(ledger.blocked, 'nothing tried to leave for another host').toEqual([]);
}

/** Every request to Groq carried the key ONLY in the Authorization header. */
function expectKeyOnlyInAuthorization(): void {
  const calls = [...world.groq.calls, ...script.seen];
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.authorization).toBe(`Bearer ${CANARY}`);
  }
  for (const entry of ledger.entries.filter((e) => e.host === 'api.groq.com')) {
    expect(leaksIn(entry.url)).toEqual([]);
    expect(entry.method === 'POST' ? (entry.body ?? '') : '').not.toContain(CANARY);
    expect(entry.source).toBe('service-worker');
  }
}

async function webPage(path = 'article.html'): Promise<{ page: Page; world: ContentWorld }> {
  const page = await world.ext.context.newPage();
  await page.addInitScript(MAIN_WORLD_SNIFFER);
  const content = await contentWorld(page);
  await page.goto(`${world.server.origin}/${path}`);
  await content.ready();
  await installRecorder(content);
  sniffers.push({ label: `web page ${sniffers.length + 1}`, page });
  recorders.push({
    label: `content script ${recorders.length + 1}`,
    get: () => readRecorder(content),
  });
  return { page, world: content };
}

test('onboarding with the real wizard: the typed key is verified, stored in one place and shown nowhere', async () => {
  const onboarding = world.onboarding;
  const setup = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await walkOnboardingAccessAlreadyGranted(onboarding, setup);
  await setup.close();

  // The trusted page was handed the key and let it go: the field is empty, the key is not in its DOM.
  expect(leaksIn(await dumpDom(onboarding))).toEqual([]);
  // One models request verified it; no paid request was made.
  expect(ledger.models()).toHaveLength(1);
  expect(ledger.chats()).toHaveLength(0);

  // Storage: the key sits in exactly one record of storage.local, nowhere else.
  const local = await readStorage(world.ext.serviceWorker, 'local');
  const session = await readStorage(world.ext.serviceWorker, 'session');
  const sync = (await world.ext.serviceWorker.evaluate(() =>
    chrome.storage.sync.get(null),
  )) as Record<string, unknown>;
  const holders = Object.entries(local).filter(([, value]) =>
    JSON.stringify(value).includes(CANARY),
  );
  expect(holders).toHaveLength(1);
  expect(JSON.stringify(session)).not.toContain(CANARY);
  expect(JSON.stringify(sync)).not.toContain(CANARY);
  expect(Object.keys(sync)).toEqual([]);
  expect(await clavisKeys(world.ext.serviceWorker, 'local')).toEqual(
    expect.arrayContaining([holders[0]![0]]),
  );

  await sweep('after onboarding', [onboarding]);
});

test('Explain on a web page, success and every failure: the key appears in no message, reply, event, DOM, storage or log a page or content script can see', async () => {
  const { page, world: content } = await webPage();
  const options = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  const refresh = async (): Promise<void> => {
    // A 401 flags the stored key as rejected (FR-072); put it back before the next failure.
    await send(options, { v: 1, type: 'SET_API_KEY', apiKey: CANARY, storage: 'local' });
  };

  // success: core, then a lazy tab
  let card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  await sweep('after a successful Explain', [page]);

  // failures with an echoing provider: 401, 403, 500, 429 (with a hostile Retry-After), garbage
  const failures: [string, () => void][] = [
    [
      '401',
      () =>
        (script.handler = (r) =>
          r.fulfill({ status: 401, contentType: 'application/json', body: echoBody(CANARY) })),
    ],
    [
      '403',
      () =>
        (script.handler = (r) =>
          r.fulfill({ status: 403, contentType: 'application/json', body: echoBody(CANARY) })),
    ],
    [
      '500',
      () =>
        (script.handler = (r) =>
          r.fulfill({ status: 500, contentType: 'text/plain', body: `boom ${CANARY}` })),
    ],
    [
      '429',
      () =>
        (script.handler = (r) =>
          r.fulfill({
            status: 429,
            contentType: 'application/json',
            headers: { 'retry-after': '1', 'x-leak': CANARY },
            body: echoBody(CANARY),
          })),
    ],
    [
      'garbage',
      () =>
        (script.handler = (r) =>
          r.fulfill({
            status: 200,
            contentType: 'application/json',
            body: chatBody(`not json ${CANARY}`),
          })),
    ],
    ['offline', () => (script.handler = (r) => r.abort('internetdisconnected'))],
  ];
  for (const [name, arm] of failures) {
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    arm();
    card = await explainWord(page, 'river');
    await card.waitFor(CARD.error, 20_000);
    const text =
      (await card.toolbar.evalIn<string>(null, 'function () { return this.textContent; }')) ?? '';
    expect(leaksIn(text), `card text after ${name}`).toEqual([]);
    await sweep(`after ${name}`, [page]);
    script.handler = undefined;
    await refresh();
  }

  // The same through the raw envelope a content script receives, for every provider failure (a
  // second tab: each tab has its own rate-limit bucket).
  const raw = await webPage();
  for (const status of [400, 401, 403, 404, 408, 413, 429, 500, 502, 503]) {
    script.handler = (r) =>
      r.fulfill({ status, contentType: 'application/json', body: echoBody(CANARY) });
    await refresh();
    const reply = await raw.world.evaluate<unknown>(
      `chrome.runtime.sendMessage(${JSON.stringify({
        v: 1,
        type: 'AI_EXPLAIN',
        payload: {
          requestId: crypto.randomUUID(),
          snapshot: {
            selectionId: crypto.randomUUID(),
            source: 'webpage',
            kind: 'word',
            text: 'bank',
          },
          mode: 'core',
          detailLevel: 'standard',
        },
      })})`,
    );
    expect(leaksIn(JSON.stringify(reply)), `HTTP ${status} envelope`).toEqual([]);
    expect(JSON.stringify(reply)).not.toMatch(/Bearer|Authorization|x-leak/i);
  }
  script.handler = undefined;
  await refresh();
  await raw.page.close();

  // The side panel (a trusted extension page, opened as a tab so it can be read).
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  await card.click(CARD.sidePanel);
  await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
  const panel = await openPanelPage(
    world.ext.context,
    world.ext.extensionId,
    await tabIdOf(world.ext.serviceWorker, page),
  );
  await expect(panel.getByTestId('panel-selected')).toBeVisible();
  await panel
    .getByTestId('panel-load')
    .first()
    .click()
    .catch(() => undefined);
  await pause(400);
  await sweep('with the side panel open', [page, panel, options]);

  // What the content script ever sent: only the public routes, and nothing that carries a key.
  const rec = await readRecorder(content);
  const types = new Set(rec.sent.map((s) => (JSON.parse(s) as { type: string }).type));
  const allowed = new Set([
    'AI_EXPLAIN',
    'AI_CANCEL',
    'TTS_SPEAK',
    'TTS_STOP',
    'GET_PUBLIC_SETTINGS',
    'GET_AI_STATUS',
    'LOAD_EXPLAIN_CARD',
    'OPEN_SETTINGS',
    'OPEN_SIDE_PANEL',
  ]);
  expect([...types].filter((t) => !allowed.has(t))).toEqual([]);
  expect(types.has('AI_EXPLAIN')).toBe(true);
  // Storage events reach a content script only for areas it may read: none of ours.
  expect(rec.changes.filter((c) => /^(local|session):/.test(c))).toEqual([]);

  // Everything above reached Groq with the key in the header and nowhere else.
  expectKeyOnlyInAuthorization();
  await panel.close();
  await options.close();
  await page.close();
});

test('the PDF reader (a trusted page that renders untrusted files): Explain, failure and the card leak nothing', async () => {
  const reader = await world.ext.context.newPage();
  await reader.addInitScript(EXTENSION_PAGE_RECORDER);
  await reader.setViewportSize({ width: 1100, height: 700 });
  await reader.goto(`chrome-extension://${world.ext.extensionId}/reader.html`);
  await openFixtureReady(reader, 'text-1page.pdf');
  recorders.push({
    label: 'reader',
    get: () => reader.evaluate(() => (globalThis as { __p9rec?: Recorded }).__p9rec as Recorded),
  });

  await selectWordByDoubleClick(reader, 'quick');
  await tb(reader).waitShown();
  await tb(reader).click('explain');
  const card = cardOf(reader);
  await card.waitFor(CARD.ready('core'));
  await sweep('reader, success', [reader]);

  script.handler = (r) =>
    r.fulfill({ status: 401, contentType: 'application/json', body: echoBody(CANARY) });
  await reader.keyboard.press('Escape');
  await tb(reader).waitHidden();
  await selectWordByDoubleClick(reader, 'brown');
  await tb(reader).waitShown();
  await tb(reader).click('explain');
  await cardOf(reader).waitFor(CARD.error, 15_000);
  await sweep('reader, 401', [reader]);
  script.handler = undefined;

  // The reader can never read, set or remove the key (a hostile PDF would reach exactly this).
  const keyRoutes = [
    { v: 1, type: 'GET_KEY_STATUS' },
    { v: 1, type: 'SET_API_KEY', apiKey: 'gsk_TESTattacker00000000000000000', storage: 'local' },
    { v: 1, type: 'REMOVE_API_KEY' },
    { v: 1, type: 'GET_SETTINGS' },
    { v: 1, type: 'CLEAR_ALL_DATA' },
  ];
  for (const message of keyRoutes) {
    const reply = await send(reader, message);
    expect(reply, message.type).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  }
  await reader.close();
  // Restore the verified key state the 401 flagged.
  const options = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: CANARY, storage: 'local' });
  await options.close();
});

test('a content script cannot widen storage access, read any area, or hear storage changes; sync holds nothing', async () => {
  const { page, world: content } = await webPage();
  const probe = await content.evaluate<Record<string, string>>(`(async () => {
    const reason = (e) => 'rejected: ' + (e && e.message);
    const out = {};
    for (const area of ['local', 'session']) {
      out[area + '.get'] = await chrome.storage[area].get(null).then((v) => 'resolved ' + JSON.stringify(v), reason);
      out[area + '.getKeys'] = await chrome.storage[area].get('clavis.apiKey').then((v) => 'resolved ' + JSON.stringify(v), reason);
      out[area + '.set'] = await chrome.storage[area].set({ attacker: 1 }).then(() => 'resolved', reason);
      out[area + '.remove'] = await chrome.storage[area].remove('clavis.apiKey').then(() => 'resolved', reason);
      out[area + '.clear'] = await chrome.storage[area].clear().then(() => 'resolved', reason);
      out[area + '.widen'] = await chrome.storage[area].setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).then(() => 'resolved', reason);
      out[area + '.after'] = await chrome.storage[area].get(null).then(() => 'resolved', reason);
    }
    out['sync.get'] = await chrome.storage.sync.get(null).then((v) => 'resolved ' + JSON.stringify(v), reason);
    return out;
  })()`);
  for (const area of ['local', 'session']) {
    for (const op of ['get', 'getKeys', 'set', 'remove', 'clear', 'widen', 'after']) {
      expect(probe[`${area}.${op}`], `${area}.${op}`).toMatch(/^rejected: /);
    }
  }
  expect(probe['sync.get']).toBe('resolved {}');
  // The refused writes changed nothing.
  const local = await readStorage(world.ext.serviceWorker, 'local');
  expect(local['attacker']).toBeUndefined();
  expect(JSON.stringify(local)).toContain(CANARY);
  // Content scripts cannot message another extension's or the page's world either: only runtime.id.
  expect(
    await content.evaluate<string>(
      `chrome.runtime.sendMessage('abcdefghijklmnopabcdefghijklmnop', { v: 1, type: 'GET_KEY_STATUS' }).then(() => 'resolved', (e) => 'rejected')`,
    ),
  ).toBe('rejected');
  await page.close();
});

test('every route, from a content script: only the nine public ones answer, all the rest refuse; no reply carries the key', async () => {
  const { page, world: content } = await webPage();
  const id = (): string => crypto.randomUUID();
  const snapshot = { selectionId: id(), source: 'webpage', kind: 'word', text: 'bank' };
  const refused: Record<string, unknown> = {
    SET_API_KEY: {
      v: 1,
      type: 'SET_API_KEY',
      apiKey: 'gsk_TESTattacker00000000000000000',
      storage: 'local',
    },
    TEST_API_KEY: { v: 1, type: 'TEST_API_KEY' },
    REMOVE_API_KEY: { v: 1, type: 'REMOVE_API_KEY' },
    GET_KEY_STATUS: { v: 1, type: 'GET_KEY_STATUS' },
    CLEAR_ALL_DATA: { v: 1, type: 'CLEAR_ALL_DATA' },
    GET_SETTINGS: { v: 1, type: 'GET_SETTINGS' },
    UPDATE_PREFERENCES: { v: 1, type: 'UPDATE_PREFERENCES', patch: { model: 'x' } },
    RESET_PREFERENCES: { v: 1, type: 'RESET_PREFERENCES' },
    ACCEPT_DISCLOSURE: { v: 1, type: 'ACCEPT_DISCLOSURE' },
    UPDATE_ONBOARDING: { v: 1, type: 'UPDATE_ONBOARDING', completed: true },
    GET_SITE_ACCESS_STATUS: { v: 1, type: 'GET_SITE_ACCESS_STATUS' },
    GET_VOICES: { v: 1, type: 'GET_VOICES' },
    GET_SIDE_PANEL_STATE: { v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 1 },
  };
  for (const [type, message] of Object.entries(refused)) {
    const reply = await content.evaluate<unknown>(
      `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
    );
    expect(reply, type).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(leaksIn(JSON.stringify(reply))).toEqual([]);
  }
  // Internal routes with their own reply shape (popup only).
  expect(
    await content.evaluate<unknown>(
      `chrome.runtime.sendMessage({ v: 1, type: 'CLAVIS_INJECT_TAB', tabId: 1 })`,
    ),
  ).toMatchObject({ ok: false });
  // Old spike routes are gone for everyone.
  for (const type of ['SPEECH_DIAGNOSE', 'GET_API_KEY', 'GET_KEY', 'SPEECH_OFFSCREEN_SPEAK']) {
    const reply = await content.evaluate<unknown>(
      `chrome.runtime.sendMessage({ v: 1, type: ${JSON.stringify(type)} })`,
    );
    expect(reply ?? null, type).toBeNull();
  }
  // The public ones answer with a valid envelope and never the key.
  const publicMessages = [
    { v: 1, type: 'GET_PUBLIC_SETTINGS' },
    { v: 1, type: 'GET_AI_STATUS' },
    { v: 1, type: 'AI_CANCEL', requestId: id() },
    { v: 1, type: 'TTS_STOP' },
    { v: 1, type: 'OPEN_SIDE_PANEL', handoff: { snapshot, results: [] } },
    { v: 1, type: 'TTS_SPEAK', requestId: id(), text: 'bank', rate: 1 },
  ];
  for (const message of publicMessages) {
    const reply = await content.evaluate<{ ok?: boolean } | undefined>(
      `chrome.runtime.sendMessage(${JSON.stringify(message)})`,
    );
    expect(reply, message.type).toBeDefined();
    expect(leaksIn(JSON.stringify(reply)), message.type).toEqual([]);
  }
  expect(
    await content.evaluate<unknown>(
      `chrome.runtime.sendMessage({ v: 1, type: 'GET_PUBLIC_SETTINGS' })`,
    ),
  ).toMatchObject({
    ok: true,
    data: { hasKey: true },
  });
  await page.close();
  // None of it disturbed the stored key.
  const options = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  expect(await send(options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
    ok: true,
    data: { hasKey: true, storage: 'local' },
  });
  await options.close();
});

test('the page itself (main world) never sees a message, a storage event or the key during all of it', async () => {
  for (const sniffer of sniffers) {
    if (sniffer.page.isClosed()) continue;
    const seen = await sniffer.page.evaluate(
      () => (globalThis as { __p9sniff?: string[] }).__p9sniff ?? [],
    );
    // No window message from the extension, no storage event, no policy violation.
    expect(seen.filter((s) => /^(message|storage|securitypolicyviolation):/.test(s))).toEqual([]);
  }
  expect(sniffers.length).toBeGreaterThan(1);
});

test('removing the key leaves nothing of it in any storage area, log or request; a session-only key never touches storage.local', async () => {
  const options = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await send(options, { v: 1, type: 'REMOVE_API_KEY' });
  for (const area of ['local', 'session'] as const) {
    expect(JSON.stringify(await readStorage(world.ext.serviceWorker, area)), area).not.toContain(
      CANARY,
    );
  }
  // Session-only (FR-071): in memory-backed storage.session, never written to storage.local.
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: CANARY, storage: 'session' });
  expect(JSON.stringify(await readStorage(world.ext.serviceWorker, 'local'))).not.toContain(CANARY);
  expect(JSON.stringify(await readStorage(world.ext.serviceWorker, 'session'))).toContain(CANARY);
  await sweep('after removal and a session-only key', [options]);
  await send(options, { v: 1, type: 'REMOVE_API_KEY' });
  await options.close();
  // The worker's own console (it logs metadata only) never held the key at any point.
  expect(logs.filter((l) => leaksIn(l).length)).toEqual([]);
  expect(logs.some((l) => /groq_explain_failed|explain/i.test(l))).toBe(true);
});

test('after the browser restarts, the content script still cannot read storage and the stored key still works', async () => {
  test.setTimeout(120_000);
  const server = await startFixtureServer();
  const profile = await restartableGranted();
  try {
    let launched = await profile.launch();
    let groq = await fakeGroq(launched.context);
    await waitForRegistration(launched.serviceWorker);
    const options = await openExtensionPage(launched.context, launched.extensionId, 'options');
    await send(options, { v: 1, type: 'SET_API_KEY', apiKey: CANARY, storage: 'local' });
    await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    await options.close();
    await profile.close();

    // Quit and start Chrome again: new browser process, same profile, same extension.
    launched = await profile.launch();
    groq = await fakeGroq(launched.context);
    await primeWorkerRoutes(launched.serviceWorker, () => groq.calls.length);
    await waitForRegistration(launched.serviceWorker);
    const page = await launched.context.newPage();
    const content = await contentWorld(page);
    await page.goto(`${server.origin}/article.html`);
    await content.ready();
    const denied = await content.evaluate<string[]>(`Promise.all(['local', 'session'].map((area) =>
      chrome.storage[area].get(null).then(() => 'readable', (e) => 'denied')))`);
    expect(denied).toEqual(['denied', 'denied']);
    expect(
      await content.evaluate<string>(
        `chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).then(() => 'resolved', () => 'rejected')`,
      ),
    ).toBe('rejected');
    // The key survived the restart and is usable: one Explain from the page, one paid request.
    groq.reset();
    const reply = await content.evaluate<{ ok: boolean }>(
      `chrome.runtime.sendMessage(${JSON.stringify({
        v: 1,
        type: 'AI_EXPLAIN',
        payload: {
          requestId: crypto.randomUUID(),
          snapshot: {
            selectionId: crypto.randomUUID(),
            source: 'webpage',
            kind: 'word',
            text: 'bank',
          },
          mode: 'core',
          detailLevel: 'standard',
        },
      })})`,
    );
    expect(reply.ok, JSON.stringify(reply)).toBe(true);
    expect(groq.chats()).toHaveLength(1);
    expect(groq.chats()[0]?.authorization).toBe(`Bearer ${CANARY}`);
    expect(JSON.stringify(reply)).not.toContain(CANARY);
    // A second content-script read, long after start-up, is still denied.
    await pause(1500);
    expect(
      await content.evaluate<string>(
        `chrome.storage.local.get(null).then(() => 'readable', () => 'denied')`,
      ),
    ).toBe('denied');
    await content.dispose();
    await page.close();
  } finally {
    await profile.dispose();
    await server.close();
  }
});

test('the storage access level persists across a browser restart: even with a service worker that does nothing, a content script is still denied (nothing re-applies the lockdown)', async () => {
  test.setTimeout(120_000);
  const server = await startFixtureServer();
  const profile = await restartableGranted();
  try {
    // Launch 1: the real extension, a stored key (and the lockdown the real worker applies).
    let launched = await profile.launch();
    const groq = await fakeGroq(launched.context);
    await primeWorkerRoutes(launched.serviceWorker, () => groq.calls.length);
    await waitForRegistration(launched.serviceWorker);
    const options = await openExtensionPage(launched.context, launched.extensionId, 'options');
    await send(options, { v: 1, type: 'SET_API_KEY', apiKey: CANARY, storage: 'local' });
    const stored = await readStorage(launched.serviceWorker, 'local');
    expect(JSON.stringify(stored)).toContain(CANARY);
    await options.close();
    await profile.close();

    // Launch 2: the same profile, but the worker's code is gone, so NOTHING can call setAccessLevel.
    // If Chrome did not persist the level, the key would be readable from the page's content script.
    await profile.silenceWorker();
    launched = await profile.launch();
    const page = await launched.context.newPage();
    const content = await contentWorld(page);
    await page.goto(`${server.origin}/article.html`);
    await content.ready();
    const reads = await content.evaluate<string[]>(`Promise.all(['local', 'session'].map((area) =>
      chrome.storage[area].get(null).then((v) => JSON.stringify(v), () => 'denied')))`);
    expect(reads.map((r) => (r.includes(CANARY) ? 'THE KEY' : r))).toEqual(['denied', 'denied']);
    await content.dispose();
    await page.close();
  } finally {
    await profile.dispose();
    await server.close();
  }
});

test('control for the two restart tests: when nothing ever applied the lockdown, injected extension code in a web page CAN read the stored key', async () => {
  test.setTimeout(90_000);
  const server = await startFixtureServer();
  const profile = await restartableGranted();
  try {
    await profile.silenceWorker();
    const launched = await profile.launch();
    const options = await openExtensionPage(launched.context, launched.extensionId, 'options');
    // An extension page is a trusted context: it can write the record the real worker would.
    await options.evaluate(
      (key) => chrome.storage.local.set({ 'clavis.api-key': { v: 1, data: key } }),
      CANARY,
    );
    const page = await launched.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    // Run extension code in the page's isolated world (what a content script is) and let it read.
    const read = await options.evaluate(async (url) => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab!.id! },
        func: () =>
          chrome.storage.local.get(null).then(
            (v) => JSON.stringify(v),
            () => 'denied',
          ),
      });
      return result!.result as string;
    }, page.url());
    expect(read).toContain(CANARY);
  } finally {
    await profile.dispose();
    await server.close();
  }
});

test('control: the sweep really finds the key when it is there (a page that prints it is caught in its DOM, console and storage)', async () => {
  const page = await world.ext.context.newPage();
  await page.goto(`${world.server.origin}/article.html`);
  await page.evaluate((key) => {
    const host = document.createElement('div');
    const leak = document.createElement('p');
    leak.setAttribute('title', key);
    leak.textContent = 'leak';
    host.attachShadow({ mode: 'closed' }).append(leak);
    document.body.append(host);
    localStorage.setItem('k', key);
    console.log(key);
  }, CANARY);
  await pause(200);
  expect(leaksIn(await dumpDom(page))).not.toEqual([]);
  expect(leaksIn(await pageStores(page))).not.toEqual([]);
  expect(logs.filter((l) => leaksIn(l).length)).not.toEqual([]);
  // Remove the planted marks so the rest of the session stays meaningful.
  logs.length = 0;
  await page.close();
});
