import { getJson, makePdf, uploadPdf } from './support/api';
import { API_ORIGIN } from './support/stack';
import {
  expect,
  FILES_SKIP_REASON,
  filesReady,
  readerTest,
  signIn,
  test,
} from './support/fixtures';

readerTest.describe('documents (read-only reader account)', () => {
  readerTest(
    'lists documents with progress, highlights and stored size, and paginates',
    async ({ rpage: page }) => {
      await page.goto('/documents');
      await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
      const items = page.getByRole('list', { name: 'Documents' }).getByRole('listitem');
      await expect(items).toHaveCount(25);
      const stored = items.filter({ hasText: 'Stored paper' });
      await expect(stored).toContainText('Page 12 of 40');
      await expect(
        stored.getByRole('progressbar', { name: 'Reading progress for Stored paper' }),
      ).toHaveAttribute('value', '12');
      await expect(stored).toContainText(/\d+ highlights/);
      const local = items.filter({ hasText: 'Local only' });
      await expect(local).toContainText('Not started');
      await expect(local).toContainText('File not stored in your account');
      await expect(local.getByRole('link', { name: /Download/ })).toHaveCount(0);
      await expect(local.getByRole('button', { name: /Remove file for/ })).toHaveCount(0);
      await expect(local.getByRole('button', { name: 'Delete document Local only' })).toBeVisible();
      await page.getByRole('button', { name: 'Load more' }).click();
      await expect(items).toHaveCount(28);
      await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    },
  );

  readerTest('shows the stored-PDF quota bar from account usage', async ({ rpage: page }) => {
    readerTest.skip(!filesReady(), FILES_SKIP_REASON);
    await page.goto('/documents');
    const account = await page.evaluate(
      async () =>
        (await fetch('/v1/account')).json() as Promise<{
          usage: { storageUsedBytes: number; storageQuotaBytes: number };
        }>,
    );
    expect(account.usage.storageUsedBytes).toBeGreaterThan(0);
    const bar = page.getByTestId('quota-bar');
    await expect(bar).toHaveAttribute('max', String(account.usage.storageQuotaBytes));
    await expect(bar).toHaveAttribute('value', String(account.usage.storageUsedBytes));
    await expect(page.getByText(/Stored PDFs: .* of 100 MB used/)).toBeVisible();
  });

  readerTest(
    'Download is a plain attachment link to the file endpoint',
    async ({ rpage: page }) => {
      readerTest.skip(!filesReady(), FILES_SKIP_REASON);
      await page.goto('/documents');
      const stored = page
        .getByRole('list', { name: 'Documents' })
        .getByRole('listitem')
        .filter({ hasText: 'Stored paper' });
      const link = stored.getByRole('link', { name: 'Download Stored paper' });
      await expect(link).toHaveAttribute('href', /^\/v1\/documents\/[0-9a-f]{64}\/file$/);
      await expect(link).toHaveAttribute('download', '');
      const downloadPromise = page.waitForEvent('download');
      await link.click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    },
  );
});

// Regression: highlightCount once counted every user's highlights (unqualified columns in a correlated subquery).
readerTest("highlight count is the document's own highlights", async ({ rpage: page, seed }) => {
  // Another user's highlights must not leak into this user's count.
  await seed({
    docs: [
      { title: 'Other user', fingerprint: makePdf('other-user-hl').fingerprint, highlights: 4 },
    ],
  });
  await page.goto('/documents');
  const stored = page
    .getByRole('list', { name: 'Documents' })
    .getByRole('listitem')
    .filter({ hasText: 'Stored paper' });
  await expect(stored.getByText('3 highlights', { exact: true })).toBeVisible();
});

test.describe('documents: quota, empty, removal and deletion', () => {
  test('empty state and an empty quota bar', async ({ signedIn }) => {
    const { page } = await signedIn();
    await page.getByRole('link', { name: 'Documents' }).click();
    await expect(page.getByText('You have no PDFs yet.')).toBeVisible();
    const bar = page.getByTestId('quota-bar');
    await expect(bar).toHaveAttribute('value', '0');
    await expect(bar).toHaveAttribute('max', '104857600');
    await expect(page.getByText('Stored PDFs: 0 B of 100 MB used')).toBeVisible();
  });

  test('Delete document confirms, deletes on the server and updates the list', async ({
    signedIn,
  }) => {
    const gone = makePdf('delete-doc');
    const keep = makePdf('keep-doc');
    const { page, account } = await signedIn({
      docs: [
        { title: 'Delete me', fingerprint: gone.fingerprint, pageCount: 3, lastPage: 1, at: 2 },
        { title: 'Keep me', fingerprint: keep.fingerprint, pageCount: 3, lastPage: 1, at: 1 },
      ],
    });
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.getByRole('button', { name: 'Delete document Delete me' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this document?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByText('Delete me', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Delete document Delete me' }).click();
    await dialog.getByRole('button', { name: 'Delete document' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Delete me', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Keep me', { exact: true })).toBeVisible();
    expect((await getJson(account.bearer, `/v1/documents/${gone.fingerprint}`)).status).toBe(404);
    expect((await getJson(account.bearer, `/v1/documents/${keep.fingerprint}`)).status).toBe(200);
  });

  test('Remove file frees the quota but keeps the document, progress and highlights', async ({
    seed,
    page,
  }) => {
    test.skip(!filesReady(), FILES_SKIP_REASON);
    const pdf = makePdf('remove-file');
    const account = await seed({
      docs: [
        {
          title: 'With file',
          fingerprint: pdf.fingerprint,
          pageCount: 9,
          lastPage: 4,
          highlights: 2,
        },
      ],
    });
    const up = await uploadPdf(account.bearer, pdf, 'With file');
    expect(up.ok).toBe(true);
    await signIn(page, account.email);
    await page.getByRole('link', { name: 'Documents' }).click();

    const row = page.getByRole('list', { name: 'Documents' }).getByRole('listitem');
    await expect(row).toContainText(`Stored in your account: ${pdf.bytes.length} B`);
    await expect(page.getByTestId('quota-bar')).toHaveAttribute('value', String(pdf.bytes.length));

    await page.getByRole('button', { name: 'Remove file for With file' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the stored file?' });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(row).toContainText('Stored in your account');
    await page.getByRole('button', { name: 'Remove file for With file' }).click();
    await dialog.getByRole('button', { name: 'Remove file' }).click();
    await expect(dialog).toBeHidden();

    await expect(row).toContainText('File not stored in your account');
    await expect(row.getByRole('link', { name: /Download/ })).toHaveCount(0);
    await expect(row).toContainText(/\d+ highlights/);
    await expect(row).toContainText('Page 4 of 9');
    await expect(page.getByTestId('quota-bar')).toHaveAttribute('value', '0');

    const doc = await getJson<{ document: { storage: { state: string } } }>(
      account.bearer,
      `/v1/documents/${pdf.fingerprint}`,
    );
    expect(doc.body.document.storage.state).toBe('none');
    const download = await fetch(`${API_ORIGIN}/v1/documents/${pdf.fingerprint}/file`, {
      headers: { authorization: `Bearer ${account.bearer.token}` },
    });
    expect(download.status).toBe(404);
  });

  test('a failed action keeps the dialog open with a message', async ({ signedIn }) => {
    const pdf = makePdf('fail-delete');
    const { page } = await signedIn({
      docs: [{ title: 'Stubborn doc', fingerprint: pdf.fingerprint, pageCount: 2 }],
    });
    await page.getByRole('link', { name: 'Documents' }).click();
    await page.route('**/v1/documents/*', (r) =>
      r.request().method() === 'DELETE'
        ? r.fulfill({
            status: 429,
            contentType: 'application/json',
            body: JSON.stringify({
              error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 2000 },
            }),
          })
        : r.continue(),
    );
    await page.getByRole('button', { name: 'Delete document Stubborn doc' }).click();
    const dialog = page.getByRole('dialog', { name: 'Delete this document?' });
    await dialog.getByRole('button', { name: 'Delete document' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Too many requests');
  });

  test('deleting every document on the first page loads the next page instead of the empty state', async ({
    signedIn,
  }) => {
    const docs = Array.from({ length: 26 }, (_, i) => ({
      title: `Doc ${String(i).padStart(2, '0')}`,
      fingerprint: makePdf(`sweep-${i}`).fingerprint,
      pageCount: 2,
      at: 100 - i,
    }));
    const { page } = await signedIn({ docs });
    await page.getByRole('link', { name: 'Documents' }).click();
    const items = page.getByRole('list', { name: 'Documents' }).getByRole('listitem');
    await expect(items).toHaveCount(25);
    for (let i = 0; i < 25; i++) {
      await items
        .first()
        .getByRole('button', { name: /Delete document/ })
        .click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete document' }).click();
      await expect(page.getByRole('dialog')).toBeHidden();
    }
    await expect(page.getByText('You have no PDFs yet.')).toHaveCount(0);
    await expect(items).toHaveCount(1);
    await expect(items.first()).toContainText('Doc 25');
  });
});
