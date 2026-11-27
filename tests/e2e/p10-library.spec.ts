import type { Page, Route } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { FAKE_KEY, openExtensionPage } from './p3-support/background';
import {
  CARD,
  cardOf,
  explainWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { chatBody } from './p5-card-support/harness';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { tb } from './spike-b-support/toolbar';

// Clavis Sync P1, signed out: save a word from the card, find it in the Library, ask about it
// (Groq answered by the test), delete it, export; and a PDF's reading progress and saved words.
// Everything is local: the only network the extension uses is the (fake) Groq (design 12).

declare const indexedDB: IDBFactory;

/** Every record of every store of clavis-data, read from an extension page. */
function dumpDb(page: Page): Promise<Record<string, Record<string, unknown>[]>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, Record<string, unknown>[]>>((resolve, reject) => {
        const open = indexedDB.open('clavis-data', 1);
        // The database must already exist (a page created it): never create an empty one here.
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          const tx = db.transaction(names);
          const out: Record<string, Record<string, unknown>[]> = {};
          let left = names.length;
          for (const name of names) {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => {
              out[name] = request.result as Record<string, unknown>[];
              if (--left === 0) {
                db.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
}

/** Answer the library's chat (its system prompt says "vocabulary tutor"); everything else falls through. */
async function fakeTutor(h: { ext: { context: import('@playwright/test').BrowserContext } }) {
  const prompts: {
    model: string;
    messages: { role: string; content: string }[];
    [key: string]: unknown;
  }[] = [];
  const authorizations: (string | undefined)[] = [];
  const answers = { next: 'It comes from the Greek "kartes" and "graphein".' };
  await h.ext.context.route('https://api.groq.com/**/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON() as (typeof prompts)[number];
    if (!body.messages[0]?.content.includes('vocabulary tutor')) return route.fallback();
    prompts.push(body);
    authorizations.push(
      await route
        .request()
        .headerValue('authorization')
        .then((v) => v ?? undefined),
    );
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(answers.next),
    });
  });
  return { prompts, authorizations, answers };
}

test.describe.configure({ mode: 'serial', timeout: 90_000 });

test.describe('words: card, library and chat', () => {
  let h: CardHarness;
  test.beforeAll(async () => {
    h = await startCardHarness();
  });
  test.afterAll(async () => {
    await h?.close();
  });

  test('save from the card, see it in the library, chat, export and delete it', async () => {
    const tutor = await fakeTutor(h);
    const { page, dispose } = await h.open();
    try {
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.ready('core'));
      await card.waitFor('[data-clavis="card-save"]');
      await card.click('[data-clavis="card-save"]');
      await expect
        .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '', { timeout: 10_000 })
        .toBe('Saved');
      await expect
        .poll(async () => (await card.text(CARD.live)) ?? '')
        .toContain('Saved to your library.');
    } finally {
      await dispose();
    }

    const library = await openExtensionPage(h.ext.context, h.ext.extensionId, 'library');
    const item = library.getByTestId('library-item');
    await expect(item).toHaveCount(1);
    await item.click();
    const detail = library.getByTestId('library-detail');
    await expect(detail.getByRole('heading', { level: 2, name: 'cartographer' })).toBeVisible();
    await expect(detail).toContainText('The land beside a river.');
    // The source comes from the browser's tab: origin + path and the page title, no query.
    const source = library.getByTestId('library-source');
    await expect(source).toContainText('Plain article');
    await expect(source).toContainText(`${h.server.origin}/article.html`);

    // Chat: the user's own key, one request, plain text back.
    await library.getByRole('textbox', { name: 'Your question' }).fill('Where does it come from?');
    await library.getByTestId('library-chat-send').click();
    const log = library.getByRole('log', { name: 'Chat about cartographer' });
    await expect(log).toContainText('Where does it come from?');
    await expect(log).toContainText('It comes from the Greek "kartes" and "graphein".');
    expect(tutor.prompts).toHaveLength(1);
    const sent = tutor.prompts[0]!;
    expect(sent['response_format']).toBeUndefined();
    expect(sent.messages[1]?.content).toContain('Where does it come from?');
    expect(sent.messages[1]?.content).toMatch(
      /<word_[0-9a-f]{16}>cartographer<\/word_[0-9a-f]{16}>/,
    );
    expect(tutor.authorizations).toEqual([`Bearer ${FAKE_KEY}`]);

    // S-09: nothing in the local database carries the key.
    const stores = await dumpDb(library);
    expect(JSON.stringify(stores)).not.toContain(FAKE_KEY);
    expect(stores['chat']).toHaveLength(2);
    expect(stores['words']?.[0]).toMatchObject({ text: 'cartographer', dirty: 0, deleted: 0 });

    // A second question carries the first as history.
    await library.getByRole('textbox', { name: 'Your question' }).fill('And the plural?');
    await library.getByTestId('library-chat-send').click();
    await expect(log).toContainText('And the plural?');
    expect(tutor.prompts).toHaveLength(2);
    expect(tutor.prompts[1]!.messages[1]?.content).toContain('User: Where does it come from?');

    // The chat survives a reload (it is in IndexedDB).
    await library.reload();
    await library.getByTestId('library-item').click();
    await expect(library.getByRole('log')).toContainText('And the plural?');

    // Export: a local JSON file with the word and its chat.
    const download = library.waitForEvent('download');
    await library.getByTestId('library-export').click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('clavis-saved-words.json');
    const text = await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8');
    const exported = JSON.parse(text) as { words: { text: string; chat: unknown[] }[] };
    expect(exported.words).toHaveLength(1);
    expect(exported.words[0]).toMatchObject({ text: 'cartographer' });
    expect(exported.words[0]!.chat).toHaveLength(4);
    expect(text).not.toContain(FAKE_KEY);

    // Delete: after a confirmation the word and its chat are gone.
    await library.getByTestId('library-delete').click();
    await expect(library.getByRole('alertdialog')).toContainText('Delete "cartographer"?');
    await library.waitForTimeout(600); // the confirm button ignores clicks right after it appears
    await library.getByTestId('library-dialog-confirm').click();
    await expect(library.getByTestId('library-words-empty')).toBeVisible();
    const after = await dumpDb(library);
    expect(after['words']).toEqual([]);
    expect(after['chat']).toEqual([]);

    // Saved words and chat never reached the Clavis API or any host but the fake Groq (signed out).
    expect(h.groqUrls.every((url) => new URL(url).host === 'api.groq.com')).toBe(true);
    await library.close();
  });

  test('toggling Save again removes the word; the popup opens the library', async () => {
    const { page, dispose } = await h.open();
    try {
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.ready('core'));
      await card.click('[data-clavis="card-save"]');
      await expect
        .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '')
        .toBe('Saved');
      await card.click('[data-clavis="card-save"]');
      await expect
        .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '')
        .toBe('Save word');
    } finally {
      await dispose();
    }
    const library = await openExtensionPage(h.ext.context, h.ext.extensionId, 'library');
    await expect(library.getByTestId('library-words-empty')).toBeVisible();

    const popup = await openExtensionPage(h.ext.context, h.ext.extensionId, 'popup');
    const opened = h.ext.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Library' }).click();
    const tab = await opened;
    await expect(tab).toHaveURL(/\/library\.html#documents$/);
    await tab.close();
    await popup.close();
    await library.close();
  });

  test('without a key the chat says so and keeps the question', async () => {
    const { page, dispose } = await h.open();
    try {
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.ready('core'));
      await card.click('[data-clavis="card-save"]');
      await expect
        .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '')
        .toBe('Saved');
    } finally {
      await dispose();
    }
    await h.options.evaluate(() =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage({ v: 1, type: 'REMOVE_API_KEY' }),
    );
    const library = await openExtensionPage(h.ext.context, h.ext.extensionId, 'library');
    await library.getByTestId('library-item').click();
    await library.getByRole('textbox', { name: 'Your question' }).fill('Why?');
    await library.getByTestId('library-chat-send').click();
    await expect(library.getByRole('alert')).toContainText('Connect your Groq key');
    await expect(library.getByRole('textbox', { name: 'Your question' })).toHaveValue('Why?');
    await library.close();
  });
});

test.describe('the first chat message asks for the disclosure', () => {
  let h: CardHarness;
  test.beforeAll(async () => {
    h = await startCardHarness({ acknowledged: false });
  });
  test.afterAll(async () => {
    await h?.close();
  });

  test('shows it once, accepts it, and then sends', async () => {
    const tutor = await fakeTutor(h);
    const library = await openExtensionPage(h.ext.context, h.ext.extensionId, 'library');
    // Seed a word the way the background would (the card itself needs the disclosure first).
    await library.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('clavis-data', 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('words', 'readwrite');
        tx.objectStore('words').put({
          wordKey: 'a'.repeat(64),
          text: 'quokka',
          meaning: { title: 'quokka', summary: 'A small marsupial.', model: 'm' },
          source: { kind: 'webpage', url: null, title: null },
          createdAt: 1_700_000_000_000,
          clientModifiedAt: 1_700_000_000_000,
          seq: null,
          dirty: 0,
          rev: 1,
          deleted: 0,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      new BroadcastChannel('clavis-data').postMessage({ stores: ['words'] });
    });
    await library.getByTestId('library-item').click();
    await library.getByRole('textbox', { name: 'Your question' }).fill('Where do they live?');
    await library.getByTestId('library-chat-send').click();
    const prompt = library.getByTestId('library-disclosure');
    await expect(prompt).toContainText('Send this to Groq?');
    expect(tutor.prompts).toHaveLength(0);
    await prompt.getByTestId('library-disclosure-confirm').click();
    await expect(library.getByRole('log')).toContainText('Where do they live?');
    expect(tutor.prompts).toHaveLength(1);
    await library.close();
  });
});

test.describe('PDFs: reading progress and saved words', () => {
  let h: AcceptHarness;
  test.beforeAll(async () => {
    h = await startAcceptHarness({ key: true });
  });
  test.afterAll(async () => {
    await h?.close();
  });

  test('the place in a PDF is saved and restored when the same file is opened again', async () => {
    const reader = await h.openReader();
    await reader.openWithFileChooser('pages-100.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    await reader.goToPage(40);
    expect(await reader.currentPage()).toBe(40);
    // Saved 2 s after the last change (debounced).
    await expect
      .poll(async () => (await dumpDb(reader.page))['documents']?.[0]?.['lastPage'], {
        timeout: 15_000,
        intervals: [500],
      })
      .toBe(40);
    const record = (await dumpDb(reader.page))['documents']![0]!;
    expect(record).toMatchObject({ title: 'pages-100', pageCount: 100, lastPage: 40, dirty: 0 });
    expect(record['fingerprint']).toMatch(/^[0-9a-f]{64}$/);

    // A new reader tab: the empty state offers it, and opening the same file returns to page 40.
    await reader.page.reload();
    await expect(reader.page.getByTestId('reader-continue')).toContainText('pages-100');
    await expect(reader.page.getByTestId('reader-continue')).toContainText('Page 40 of 100');
    await reader.openWithFileChooser('pages-100.pdf');
    await reader.waitPhase('ready');
    await expect(reader.page.getByTestId('reader-resumed')).toContainText('page 40');
    await expect.poll(() => reader.currentPage(), { timeout: 15_000 }).toBe(40);
    await reader.page.getByRole('button', { name: 'Back to start' }).click();
    await expect.poll(() => reader.currentPage(), { timeout: 15_000 }).toBe(1);
    await reader.page.close();
  });

  test('a word saved from the PDF reader keeps the file and page, and shows in the library', async () => {
    const reader = await h.openReader();
    await reader.openWithFileChooser('pages-100.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    await reader.goToPage(88);
    await selectWordByDoubleClick(reader.page, 'quokka', 88);
    await tb(reader.page).waitShown();
    await tb(reader.page).click('explain');
    const card = cardOf(reader.page);
    await card.waitFor(CARD.ready('core'));
    await card.click('[data-clavis="card-save"]');
    await expect
      .poll(async () => (await card.text('[data-clavis="card-save"]')) ?? '')
      .toBe('Saved');
    const words = (await dumpDb(reader.page))['words']!;
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({
      text: 'quokka',
      source: { kind: 'pdf', title: 'pages-100', page: 88 },
    });
    expect((words[0]!['source'] as { fingerprint: string }).fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const library = await openExtensionPage(h.ext.context, h.ext.extensionId, 'library');
    await library.getByTestId('library-item').click();
    await expect(library.getByTestId('library-source')).toContainText('pages-100, page 88');
    await library.getByTestId('library-tab-documents').click();
    await expect(library.getByTestId('library-doc').first()).toContainText('pages-100');
    await library.close();
    await reader.page.close();
  });
});
