import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clavisKeys, readStorage, send } from './p3-support/background';
import { contentWorld } from './p3-support/content-world';
import { openExtensionPage } from './p3-ui-support/pages';
import { CARD, cardOf } from './p5-card-support/harness';
import { explainMessage } from './p5-support/groq';
import { extensionPath } from './fixtures';
import { dblclickText, dragSelect } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { tagAnswers, type ChatCall } from './p8-accept-support/answers';
import { setUpKey } from './p8-accept-support/setup';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';

// What the PRODUCTION build must and must not contain (D-24, FR-036, FR-037, FR-042, FR-043): the
// side panel ships; the Translate tab ships (its live evaluation passed, 96/96); the Grammar tab
// stays flagged off (90% on the default model, below the bar) and a forced-flags build is a test
// build that must never ship; the cross-selection answer cache (FR-043, Later) does not exist:
// nothing about a selection or an answer is stored, and asking again asks Groq again.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let world: World;
let calls: ChatCall[];

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  calls = await tagAnswers(world.ext.context);
  await setUpKey(world);
});
test.afterAll(async () => {
  await world?.close();
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

test('the build has Translate on, Grammar off and was not made with the forced-flags test switch', async () => {
  const sources = walk(extensionPath).filter((f) => /\.(js|mjs)$/.test(f));
  const marker = sources.filter((f) =>
    readFileSync(f, 'utf8').includes('CLAVIS_FORCED_FEATURES_BUILD_NEVER_SHIP'),
  );
  expect(marker, 'forced-flags marker in the build').toEqual([]);
  // Wherever the flags are compiled in: Grammar is false (!1) and Translate is true (!0).
  const flagged = sources
    .map((f) => readFileSync(f, 'utf8'))
    .flatMap((text) => [...text.matchAll(/grammarTab:(!?\d|!?\w+),translateTab:(!?\d|!?\w+)/g)]);
  expect(flagged.length).toBeGreaterThan(0);
  for (const hit of flagged) {
    expect(hit[1], 'grammarTab').toBe('!1');
    expect(hit[2], 'translateTab').toBe('!0');
  }
});

test('the manifest ships the side panel (FR-042) with no shared default panel, and no cache or history permission', async () => {
  const manifest = JSON.parse(readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8')) as {
    permissions: string[];
    side_panel?: unknown;
  };
  expect(manifest.permissions).toContain('sidePanel');
  expect(manifest.side_panel).toBeUndefined();
  for (const forbidden of ['history', 'unlimitedStorage', 'downloads', 'bookmarks']) {
    expect(manifest.permissions).not.toContain(forbidden);
  }
  const page = await world.ext.context.newPage();
  await page.goto(`chrome-extension://${world.ext.extensionId}/sidepanel.html?tab=1`);
  await expect(page.getByTestId('panel-empty')).toBeVisible();
  await page.close();
});

test('every tab set, in the card and in the side panel, offers Translate and never Grammar', async () => {
  calls.length = 0;
  for (const [name, from, to] of [
    ['word', 'cartographer', 'cartographer'],
    ['phrase', 'old bank', 'beside'],
    ['sentence', 'The old bank stood', 'two hundred years.'],
    ['passage', 'The old bank stood', 'quiet affection.'],
  ] as const) {
    const { page, dispose } = await openWebpage(world, `article.html?flags=${name}`);
    try {
      await page.bringToFront();
      await dragSelect(page, page, from, to);
      await tb(page).waitShown();
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      const labels = ((await card.tabs()) ?? []).map((t) => t.label.toLowerCase());
      expect(labels, `card tabs for a ${name}`).not.toContain('grammar');
      expect(labels.at(-1), `card tabs for a ${name}`).toBe('translate');
      await card.click(CARD.sidePanel);
      await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
      const panel = await openPanelPage(
        world.ext.context,
        world.ext.extensionId,
        await tabIdOf(world.ext.serviceWorker, page),
      );
      await expect(panel.getByTestId('panel-section').first()).toBeVisible();
      const parts = await panel
        .getByTestId('panel-section')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-mode')));
      expect(parts, `panel parts for a ${name}`).not.toContain('grammar');
      expect(parts.at(-1), `panel parts for a ${name}`).toBe('translate');
      expect(await panel.locator('body').innerText()).not.toMatch(/grammar/i);
      await panel.close();
    } finally {
      await dispose();
    }
  }
  // Opening the card and the panel asks for the core answer only: Translate waits for its tab.
  expect(calls.map((c) => c.mode).filter((m) => m !== 'core')).toEqual([]);
});

test('Translate asks once when its tab is opened, in the explanation language, and not again on reopen', async () => {
  const options = (await openExtensionPage(world.ext.context, world.ext.extensionId, 'options'))
    .page;
  await send(options, { v: 1, type: 'UPDATE_PREFERENCES', patch: { explanationLanguage: 'fr' } });
  const prompts: string[] = [];
  const record = (request: import('@playwright/test').Request): void => {
    if (request.url().endsWith('/chat/completions')) prompts.push(request.postData() ?? '');
  };
  world.ext.context.on('request', record);
  const { page, dispose } = await openWebpage(world, 'article.html?translate=1');
  try {
    await page.bringToFront();
    await dragSelect(page, page, 'The old bank stood', 'two hundred years.');
    await tb(page).waitShown();
    calls.length = 0;
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect(calls.map((c) => c.mode)).toEqual(['core']);
    await card.click(CARD.tab('translate'));
    await card.waitFor(CARD.ready('translate'));
    expect(calls.map((c) => c.mode)).toEqual(['core', 'translate']);
    const translate = prompts.filter((p) => p.includes('(mode: translate)'));
    expect(translate).toHaveLength(1);
    expect(translate[0]).toContain('BCP-47 tag \\"fr\\"');
    expect(await card.text(CARD.panel('translate'))).toContain('Translation into French');
    // Reopening a loaded tab, and closing and re-pressing Explain on the same selection, are free.
    await card.click(CARD.tab('core'));
    await card.click(CARD.tab('translate'));
    await page.waitForTimeout(300);
    expect(calls.map((c) => c.mode)).toEqual(['core', 'translate']);
  } finally {
    world.ext.context.off('request', record);
    await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { explanationLanguage: 'en' },
    });
    await options.close();
    await dispose();
  }
});

test('Settings saves an independent translation language used only when Translate is opened', async () => {
  const options = (await openExtensionPage(world.ext.context, world.ext.extensionId, 'options'))
    .page;
  const prompts: string[] = [];
  const record = (request: import('@playwright/test').Request): void => {
    if (request.url().endsWith('/chat/completions')) prompts.push(request.postData() ?? '');
  };
  world.ext.context.on('request', record);
  try {
    await options.getByRole('link', { name: 'Preferences', exact: true }).click();
    await expect(options.getByLabel('Explanation language', { exact: true })).toBeVisible();
    await options.getByLabel('Explanation language', { exact: true }).selectOption('de');
    await options.getByLabel('Translation language', { exact: true }).selectOption('fr');
    await expect
      .poll(async () => {
        const reply = await send(options, { v: 1, type: 'GET_PUBLIC_SETTINGS' });
        return reply?.data;
      })
      .toMatchObject({ explanationLanguage: 'de', translationLanguage: 'fr' });

    await options.reload();
    await expect(options.getByLabel('Explanation language', { exact: true })).toHaveValue('de');
    await expect(options.getByLabel('Translation language', { exact: true })).toHaveValue('fr');

    const { page, dispose } = await openWebpage(world, 'article.html?translation-preference=1');
    try {
      await page.bringToFront();
      await dragSelect(page, page, 'The old bank stood', 'two hundred years.');
      await tb(page).waitShown();
      calls.length = 0;
      prompts.length = 0;
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      expect(calls.map((call) => call.mode)).toEqual(['core']);
      expect(prompts.filter((body) => body.includes('(mode: translate)'))).toEqual([]);
      const coreBody = JSON.parse(prompts[0] ?? '{}') as {
        messages?: { content: string }[];
      };
      expect(coreBody.messages?.map((message) => message.content).join('\n')).toContain(
        'BCP-47 "de"',
      );

      await card.click(CARD.tab('translate'));
      await card.waitFor(CARD.ready('translate'));
      expect(calls.map((call) => call.mode)).toEqual(['core', 'translate']);
      const translate = prompts.find((body) => body.includes('(mode: translate)'));
      const translateBody = JSON.parse(translate ?? '{}') as {
        messages?: { content: string }[];
      };
      expect(translateBody.messages?.map((message) => message.content).join('\n')).toContain(
        'BCP-47 tag "fr"',
      );
      expect(translateBody.messages?.map((message) => message.content).join('\n')).toContain(
        'BCP-47 "fr"',
      );
      expect(await card.text(CARD.panel('translate'))).toContain('Translation into French');
    } finally {
      await dispose();
    }
  } finally {
    world.ext.context.off('request', record);
    await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { explanationLanguage: 'en', translationLanguage: null },
    });
    await options.close();
  }
});

test('Settings does not mention Grammar or a cache', async () => {
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await page.getByRole('link', { name: 'Preferences', exact: true }).click();
  await expect(page.getByTestId('voice-counts')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')),
  );
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/grammar|cache|history|vocabulary/i);
  await page.close();
});

test('the service worker refuses a Grammar request, never sending it to Groq, and serves Translate', async () => {
  // From a web page's content-script world: the context the card lives in, and the only kind of
  // sender AI_EXPLAIN accepts (an extension page is refused whatever the mode).
  const page = await world.ext.context.newPage();
  const content = await contentWorld(page);
  await page.goto(`${world.server.origin}/article.html?refuse=1`);
  await content.ready();
  const call = (message: unknown): Promise<{ ok: boolean } | undefined> =>
    content.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);
  try {
    world.groqUrls.length = 0;
    calls.length = 0;
    expect(await call(explainMessage('grammar')), 'grammar').toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(calls).toEqual([]);
    expect(world.groqUrls.filter((u) => u.endsWith('/chat/completions'))).toEqual([]);
    expect(
      await call(explainMessage('translate', { targetLanguage: 'fr' })),
      'translate',
    ).toMatchObject({ ok: true, data: { mode: 'translate' } });
    expect(calls.map((c) => c.mode)).toEqual(['translate']);
  } finally {
    await content.dispose();
    await page.close();
  }
});

test('FR-043 is absent: explaining the same text again asks Groq again, and nothing about it is stored', async () => {
  calls.length = 0;
  for (const round of [1, 2]) {
    const { page, dispose } = await openWebpage(world, `article.html?cache=${round}`);
    try {
      await page.bringToFront();
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).click('explain');
      await cardOf(page).waitFor(CARD.ready('core'));
    } finally {
      await dispose();
    }
  }
  // The same word, twice, in two loads of the same page: two requests (no cross-selection cache).
  expect(calls.map((c) => `${c.mode}:${c.word}`)).toEqual([
    'core:cartographer',
    'core:cartographer',
  ]);

  // Nothing about the selection or its answer is on disk (storage areas, IndexedDB, caches).
  for (const area of ['local', 'session'] as const) {
    const stored = JSON.stringify(await readStorage(world.ext.serviceWorker, area));
    expect(stored, `${area} storage`).not.toContain('cartographer');
    expect(stored, `${area} storage`).not.toContain('Definition of');
    const names = await clavisKeys(world.ext.serviceWorker, area);
    expect(
      names.filter((n) => /cache|history|vocab|answer|explain/i.test(n)),
      `${area} keys`,
    ).toEqual([]);
  }
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  const stores = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((d) => d.name),
    caches: await caches.keys(),
    local: localStorage.length,
  }));
  expect(stores).toEqual({ databases: [], caches: [], local: 0 });
  await page.close();
});
