import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

declare const indexedDB: IDBFactory;
declare const BroadcastChannel: new (name: string) => { postMessage(message: unknown): void };

// Clavis Sync P1: the library page (saved words, chat, documents, the delete dialog) passes axe in
// light and dark and reflows at narrow widths. Records are seeded the way the background writes them.
test.describe.configure({ timeout: 90_000 });

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
  }));
  expect(summary, `axe violations: ${label}`).toEqual([]);
}

async function noHorizontalScroll(page: Page, label: string) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, `horizontal scroll: ${label}`).toBeLessThanOrEqual(client);
}

async function seed(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('clavis-data', 1);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const sync = { clientModifiedAt: 1_700_000_000_000, seq: null, dirty: 0, rev: 1, deleted: 0 };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['words', 'chat', 'documents', 'highlights'], 'readwrite');
      tx.objectStore('words').put({
        wordKey: 'a'.repeat(64),
        text: 'quokka',
        language: 'en',
        meaning: {
          title: 'quokka',
          summary: 'A small marsupial that lives on islands off Western Australia.',
          contextualMeaning: 'Here it names the animal.',
          definition: 'A short-tailed macropod.',
          examples: [{ sentence: 'We saw a quokka on the path.' }],
          caveat: 'The word comes from a Noongar name.',
          model: 'openai/gpt-oss-20b',
        },
        contextBefore: 'On the island we met a ',
        contextAfter: ' that was not afraid of us.',
        source: {
          kind: 'webpage',
          url: 'https://example.com/travel/island',
          title: 'Island travel notes',
        },
        createdAt: 1_700_000_000_000,
        ...sync,
      });
      tx.objectStore('chat').put({
        id: '00000000-0000-4000-8000-000000000001',
        wordKey: 'a'.repeat(64),
        role: 'user',
        content: 'Why does it smile?',
        createdAt: 1_700_000_001_000,
        ...sync,
      });
      tx.objectStore('chat').put({
        id: '00000000-0000-4000-8000-000000000002',
        wordKey: 'a'.repeat(64),
        role: 'assistant',
        content: 'Its mouth is shaped that way.',
        model: 'openai/gpt-oss-20b',
        createdAt: 1_700_000_002_000,
        ...sync,
      });
      tx.objectStore('documents').put({
        fingerprint: 'b'.repeat(64),
        title: 'A long paper title that should wrap nicely on a very narrow screen',
        pageCount: 12,
        lastPage: 5,
        pageOffset: 0.3,
        fileBytes: 12345,
        storageState: 'none',
        ...sync,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    new BroadcastChannel('clavis-data').postMessage({ stores: ['words', 'chat', 'documents'] });
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} colour scheme`, () => {
    test.use({ colorScheme: scheme });

    for (const width of [1000, 360, 320]) {
      test(`library at ${width}px: empty, a word with its chat, the delete dialog, documents`, async ({
        context,
        extensionId,
      }) => {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`chrome-extension://${extensionId}/library.html`);
        await expect(page.getByTestId('library-words-empty')).toBeVisible();
        await axe(page, `empty ${scheme} ${width}`);

        await seed(page);
        await page.getByTestId('library-item').click();
        await expect(page.getByRole('log')).toContainText('Its mouth is shaped that way.');
        await axe(page, `word ${scheme} ${width}`);
        await noHorizontalScroll(page, `word ${width}`);

        await page.getByTestId('library-delete').click();
        await expect(page.getByRole('alertdialog')).toBeVisible();
        await expect(page.getByTestId('library-dialog-cancel')).toBeFocused();
        await axe(page, `dialog ${scheme} ${width}`);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('alertdialog')).toHaveCount(0);
        await expect(page.getByTestId('library-delete')).toBeFocused();

        await page.getByTestId('library-tab-documents').click();
        await expect(page.getByTestId('library-doc')).toHaveCount(1);
        await axe(page, `documents ${scheme} ${width}`);
        await noHorizontalScroll(page, `documents ${width}`);
        await page.close();
      });
    }
  });
}
