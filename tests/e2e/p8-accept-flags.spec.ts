import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { clavisKeys, readStorage, send } from './p3-support/background';
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

// Phase 8, what the PRODUCTION build must and must not contain (D-24, FR-036, FR-037, FR-042,
// FR-043): the side panel ships; the Grammar and Translate tabs stay flagged off until a live
// evaluation (a forced-flags build is a test build and must never ship); the cross-selection
// answer cache (FR-043, Later) does not exist: nothing about a selection or an answer is stored,
// and asking again asks Groq again.
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

test('the build has the flags off and was not made with the forced-flags test switch', async () => {
  const sources = walk(extensionPath).filter((f) => /\.(js|mjs)$/.test(f));
  const marker = sources.filter((f) =>
    readFileSync(f, 'utf8').includes('CLAVIS_FORCED_FEATURES_BUILD_NEVER_SHIP'),
  );
  expect(marker, 'forced-flags marker in the build').toEqual([]);
  // Wherever the flags are compiled in, both are false.
  const flagged = sources
    .map((f) => readFileSync(f, 'utf8'))
    .flatMap((text) => [...text.matchAll(/grammarTab:(!?\d|!?\w+),translateTab:(!?\d|!?\w+)/g)]);
  expect(flagged.length).toBeGreaterThan(0);
  for (const hit of flagged) {
    expect(hit[1], 'grammarTab').toBe('!1');
    expect(hit[2], 'translateTab').toBe('!1');
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

test('no tab set, in the card or in the side panel, ever offers Grammar or Translate', async () => {
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
      expect(labels, `card tabs for a ${name}`).not.toContain('translate');
      await card.click(CARD.sidePanel);
      await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
      const panel = await openPanelPage(
        world.ext.context,
        world.ext.extensionId,
        await tabIdOf(world.ext.serviceWorker, page),
      );
      const parts = await panel
        .getByTestId('panel-section')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-mode')));
      expect(parts, `panel parts for a ${name}`).not.toContain('grammar');
      expect(parts, `panel parts for a ${name}`).not.toContain('translate');
      expect(await panel.locator('body').innerText()).not.toMatch(/grammar|translat/i);
      await panel.close();
    } finally {
      await dispose();
    }
  }
  expect(calls.map((c) => c.mode).filter((m) => m === 'grammar' || m === 'translate')).toEqual([]);
});

test('Settings does not mention Grammar, Translate or a cache', async () => {
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await expect(page.getByTestId('voice-counts')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() =>
    document.querySelectorAll('details').forEach((d) => d.setAttribute('open', '')),
  );
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/grammar|translat|cache|history|vocabulary/i);
  await page.close();
});

test('a request for a Grammar or Translate answer is refused by the service worker and never reaches Groq', async () => {
  const { page } = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  world.groqUrls.length = 0;
  calls.length = 0;
  for (const mode of ['grammar', 'translate']) {
    const reply = await send(
      page,
      explainMessage(mode, { targetLanguage: 'French', acknowledge: true }),
    );
    expect(reply?.ok, mode).toBe(false);
  }
  expect(calls).toEqual([]);
  expect(world.groqUrls.filter((u) => u.endsWith('/chat/completions'))).toEqual([]);
  await page.close();
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
