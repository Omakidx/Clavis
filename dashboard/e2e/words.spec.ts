import { getJson } from './support/api';
import { wordKey } from '../../shared/api-contract/words';
import { API_ORIGIN } from './support/stack';
import { expect, readerTest, test } from './support/fixtures';

readerTest.describe('saved words list (read-only reader account)', () => {
  readerTest('lists newest first and keyset-paginates with Load more', async ({ rpage: page }) => {
    await page.goto('/words');
    await expect(page.getByRole('heading', { level: 1, name: 'Saved words' })).toBeVisible();
    const items = page.getByRole('list', { name: 'Saved words' }).getByRole('listitem');
    await expect(items).toHaveCount(25);
    await expect(items.first()).toContainText('pdf-word');
    await expect(page.getByTestId('words-count')).toHaveText('Showing 25 words');
    await page.getByRole('button', { name: 'Load more' }).click();
    await expect(items).toHaveCount(33);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    await expect(page.getByTestId('words-count')).toHaveText('33 words');
    await expect(items.last()).toContainText('alpha-00');
  });

  readerTest('searches by text and reflects the query in the URL', async ({ rpage: page }) => {
    await page.goto('/words');
    await page.getByLabel('Search saved words').fill('alpha-0');
    await expect(page).toHaveURL(/\/words\?q=alpha-0$/);
    const items = page.getByRole('list', { name: 'Saved words' }).getByRole('listitem');
    await expect(items).toHaveCount(10);
    await page.getByLabel('Search saved words').fill('no-such-word-zzz');
    await expect(page.getByText('No saved words match')).toBeVisible();
    // Deep link and Back restore the query.
    await page.goto('/words?q=ephemeral');
    await expect(page.getByLabel('Search saved words')).toHaveValue('ephemeral');
    await expect(items).toHaveCount(1);
  });

  readerTest(
    'word detail shows meaning, context, source and a read-only chat',
    async ({ rpage: page }) => {
      await page.goto('/words?q=ephemeral');
      await page.getByRole('link', { name: 'ephemeral' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'ephemeral' })).toBeFocused();
      await expect(page.getByText('Lasting a very short time.')).toBeVisible();
      await expect(page.getByText('Used here to mean brief.')).toBeVisible();
      await expect(page.locator('blockquote')).toHaveText('The joy was ephemeral but lovely.');
      const chat = page.getByRole('list', { name: 'Chat messages' });
      await expect(chat.getByRole('listitem')).toHaveCount(2);
      await expect(chat).toContainText('Give me a synonym.');
      await expect(chat).toContainText('Fleeting or transient.');
      await expect(page.getByTestId('chat-note')).toHaveText(
        'Continue this chat in the Clavis extension.',
      );
      // Read-only: no composer of any kind on the page.
      await expect(
        page.locator('textarea, input[type="text"], [contenteditable="true"]'),
      ).toHaveCount(0);
      await expect(page.getByRole('textbox')).toHaveCount(0);
      await page.getByRole('link', { name: '← All saved words' }).click();
      await expect(page).toHaveURL(`${API_ORIGIN}/words`);
    },
  );

  readerTest(
    'text that looks like HTML is rendered as text, never as markup',
    async ({ rpage: page }) => {
      await page.goto('/words?q=onerror');
      const card = page.getByRole('list', { name: 'Saved words' }).getByRole('listitem');
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('<img src=x onerror="window.__pwned=1">');
      await expect(card).toContainText('<script>window.__pwned=1</script> summary');
      await card.getByRole('link').click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        '<img src=x onerror="window.__pwned=1">',
      );
      const main = page.locator('main');
      await expect(main).toContainText('<b>bold</b> definition');
      await expect(main).toContainText('<i>example</i> sentence');
      await expect(main).toContainText('Before <b>bold</b>');
      await expect(main).toContainText('It is **not** HTML.');
      await expect(main).toContainText('<script>window.__pwned=1</script>');
      // No element created from any saved text.
      await expect(main.locator('img, script, svg, b, i, u')).toHaveCount(0);
      expect(
        await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned),
      ).toBeUndefined();
    },
  );

  readerTest(
    'the source URL opens only after a confirmation, in a new tab without opener',
    async ({ rpage: page }) => {
      await page.goto('/words?q=ephemeral');
      await page.getByRole('link', { name: 'ephemeral' }).click();
      await page.getByRole('button', { name: /Open source page/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Open this website?' });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText('https://example.com/article');
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      const link = dialog.getByRole('link', { name: 'Open in a new tab' });
      await expect(link).toHaveAttribute('target', '_blank');
      await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      await expect(link).toHaveAttribute('href', 'https://example.com/article');
      // Escape cancels without opening anything and returns focus to the opener.
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('button', { name: /Open source page/ })).toBeFocused();
    },
  );

  readerTest('a PDF source is shown as text with its page', async ({ rpage: page }) => {
    await page.goto('/words?q=pdf-word');
    await page.getByRole('link', { name: 'pdf-word' }).click();
    await expect(page.getByText('PDF: Stored paper, page 7')).toBeVisible();
    await expect(page.getByRole('button', { name: /Open source page/ })).toHaveCount(0);
  });

  readerTest('an unknown word key shows a not-found message', async ({ rpage: page }) => {
    await page.goto(`/words/${'b'.repeat(64)}`);
    await expect(page.getByRole('heading', { name: 'Saved word not found' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('no longer exists');
    await page.goto('/words/not-hex');
    await expect(page.getByRole('heading', { name: 'Saved word not found' })).toBeVisible();
  });
});

// Regression: messageCount once counted every user's chat messages (same unqualified-column subquery).
readerTest("chat message count is the word's own messages", async ({ rpage: page, seed }) => {
  // Another user's chat messages must not leak into this user's count.
  await seed({ words: [{ text: 'someone-else', chat: [{ role: 'user', content: 'hi' }] }] });
  await page.goto('/words?q=ephemeral');
  await expect(page.getByText('2 chat messages', { exact: true })).toBeVisible();
});

test.describe('saved words: failures and deletion', () => {
  test('empty state', async ({ signedIn }) => {
    const { page } = await signedIn();
    await expect(page.getByText('You have no saved words yet.')).toBeVisible();
  });

  test('delete asks for confirmation; cancel keeps the word, confirm removes it everywhere', async ({
    signedIn,
  }) => {
    const { page, account } = await signedIn({
      words: [{ text: 'keep-me' }, { text: 'delete-me', at: 5 }],
    });
    await page.getByRole('button', { name: 'Delete delete-me' }).click();
    const dialog = page
      .getByRole('alertdialog')
      .or(page.getByRole('dialog', { name: 'Delete this saved word?' }));
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('button', { name: 'Delete delete-me' })).toBeFocused();
    await expect(page.getByText('delete-me', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Delete delete-me' }).click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.getByRole('button', { name: 'Delete delete-me' }).click();
    await dialog.getByRole('button', { name: 'Delete word' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('delete-me', { exact: true })).toHaveCount(0);
    await expect(page.getByText('keep-me', { exact: true })).toBeVisible();

    const key = await wordKey('delete-me');
    expect((await getJson(account.bearer, `/v1/words/${key}`)).status).toBe(404);
    expect((await getJson(account.bearer, `/v1/words/${await wordKey('keep-me')}`)).status).toBe(
      200,
    );
  });

  test('a failed delete keeps the dialog open with a message', async ({ signedIn }) => {
    const { page } = await signedIn({ words: [{ text: 'stubborn' }] });
    await page.route('**/v1/words/*', (r) =>
      r.request().method() === 'DELETE'
        ? r.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'INTERNAL', message: 'boom' } }),
          })
        : r.continue(),
    );
    await page.getByRole('button', { name: 'Delete stubborn' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this saved word?' });
    await dialog.getByRole('button', { name: 'Delete word' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Something went wrong on our side');
    await expect(page.getByText('stubborn', { exact: true }).first()).toBeVisible();
  });

  test('rate limiting shows how long to wait, with a retry', async ({ signedIn }) => {
    const { page } = await signedIn();
    let limited = true;
    await page.route('**/v1/words?*', (r) => {
      if (!limited) return r.continue();
      return r.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'retry-after': '3' },
        body: JSON.stringify({
          error: { code: 'RATE_LIMITED', message: 'slow down', retryAfterMs: 3000 },
        }),
      });
    });
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.getByRole('link', { name: 'Saved words' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Too many requests. Try again in 3 seconds.',
    );
    limited = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByText('You have no saved words yet.')).toBeVisible();
  });

  test('a network failure shows an error with a retry', async ({ signedIn }) => {
    const { page } = await signedIn();
    await page.route('**/v1/words?*', (r) => r.abort('connectionreset'));
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.getByRole('link', { name: 'Saved words' }).click();
    await expect(page.getByRole('alert')).toContainText('cannot be reached');
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('a response that does not match the contract is rejected, not rendered', async ({
    signedIn,
  }) => {
    const { page } = await signedIn();
    await page.route('**/v1/words?*', (r) =>
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ nope: 1 }], nextCursor: null }),
      }),
    );
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.getByRole('link', { name: 'Saved words' }).click();
    await expect(page.getByRole('alert')).toContainText('could not read');
  });

  test('deleting every word on the first page loads the next page instead of the empty state', async ({
    signedIn,
  }) => {
    const words = Array.from({ length: 26 }, (_, i) => ({
      text: `sweep-${String(i).padStart(2, '0')}`,
      at: i,
    }));
    const { page } = await signedIn({ words });
    const items = page.getByRole('list', { name: 'Saved words' }).getByRole('listitem');
    await expect(items).toHaveCount(25);
    for (let i = 0; i < 25; i++) {
      await items
        .first()
        .getByRole('button', { name: /^Delete / })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete word' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }
    await expect(page.getByText('You have no saved words yet.')).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('sweep-00');
  });
});
