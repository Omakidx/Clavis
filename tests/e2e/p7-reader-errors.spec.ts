import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures';
import {
  fixtureInfo,
  fixturePath,
  loadFixture,
  openFixtureReady,
  openReader,
  waitForPhase,
} from './p7-reader-support/helpers';
import { blankPagesPdf } from './p7-reader-support/pdfs';

// FR-055: every unusual file gets a specific, actionable message and the reader stays usable.
test.describe.configure({ timeout: 120_000 });

test.describe('empty state and drop target', () => {
  test('explains the reader, why Chrome cannot host it, and offers the picker', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    const empty = page.getByTestId('state-empty');
    await expect(empty.getByRole('heading', { name: 'Read a PDF with Clavis' })).toBeVisible();
    await expect(empty).toContainText("Chrome's built-in PDF viewer can't show Clavis");
    await expect(empty).toContainText('drop one anywhere on this page');
    await expect(empty).toContainText('Listening never sends anything');
    // One toolbar button called "Open PDF"; the large button has its own name.
    await expect(page.getByRole('button', { name: 'Open PDF' })).toHaveCount(1);
    const chooser = page.waitForEvent('filechooser');
    await empty.getByRole('button', { name: 'Choose a PDF…' }).click();
    const fileChooser = await chooser;
    expect(fileChooser.isMultiple()).toBe(false);
  });

  test('a file dragged over the page shows a clear drop target; leaving hides it; dropping opens', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    const { readFileSync } = await import('node:fs');
    const b64 = readFileSync(fixturePath('text-1page.pdf')).toString('base64');
    const drag = (type: string, relatedTarget = false) =>
      page.evaluate(
        ([kind, b64, related]) => {
          const data = Uint8Array.from(atob(b64 as string), (c) => c.charCodeAt(0));
          const dt = new DataTransfer();
          dt.items.add(new File([data], 'dropped.pdf', { type: 'application/pdf' }));
          const target = document.querySelector('.reader')!;
          target.dispatchEvent(
            new DragEvent(kind as string, {
              dataTransfer: dt,
              bubbles: true,
              cancelable: true,
              relatedTarget: related ? document.body : null,
            }),
          );
        },
        [type, b64, relatedTarget] as const,
      );
    await drag('dragover');
    const target = page.getByTestId('drop-target');
    await expect(target).toBeVisible();
    await expect(target).toContainText('Drop the PDF to open it');
    await expect(page.locator('.reader')).toHaveAttribute('data-dragging', 'true');
    await drag('dragleave');
    await expect(target).toHaveCount(0);
    await drag('dragover');
    await expect(target).toBeVisible();
    await drag('drop');
    await expect(target).toHaveCount(0);
    await waitForPhase(page, 'ready');
    await expect(page.getByTestId('file-name')).toHaveText('dropped.pdf');
  });

  test('dragging something that is not a file does nothing', async ({ context, extensionId }) => {
    const { page } = await openReader(context, extensionId);
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'just text');
      document
        .querySelector('.reader')!
        .dispatchEvent(
          new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
        );
    });
    await expect(page.getByTestId('drop-target')).toHaveCount(0);
  });
});

test.describe('error states', () => {
  test('too many pages: a clear limit message, no viewer built, and a good file opens next', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await page.getByTestId('file-input').setInputFiles({
      name: 'endless.pdf',
      mimeType: 'application/pdf',
      buffer: await blankPagesPdf(5001),
    });
    await waitForPhase(page, 'error');
    const alert = page.getByTestId('state-error');
    await expect(alert).toHaveAttribute('data-code', 'TOO_LARGE');
    await expect(alert).toContainText('more than 5000 pages');
    await expect(alert.getByRole('button', { name: 'Choose another PDF' })).toBeVisible();
    // The viewer never received the document: no page placeholders were built.
    expect(await page.locator('.pdfViewer .page').count()).toBe(0);
    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    await openFixtureReady(page, 'text-1page.pdf');
  });

  test('a document with exactly 5,000 pages opens', async ({ context, extensionId }) => {
    test.slow();
    const { page } = await openReader(context, extensionId);
    await page.getByTestId('file-input').setInputFiles({
      name: 'cap.pdf',
      mimeType: 'application/pdf',
      buffer: await blankPagesPdf(5000),
    });
    await expect(page.getByTestId('page-count')).toHaveText('of 5000', { timeout: 60_000 });
    expect(await page.locator('.pdfViewer .page').count()).toBe(5000);
  });

  test('a file over 100 MB is refused before it is read, naming the limit', async ({
    context,
    extensionId,
  }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clavis-big-'));
    const big = path.join(dir, 'huge.pdf');
    try {
      await writeFile(big, '%PDF-1.4\n');
      await truncate(big, 100 * 1024 * 1024 + 1); // sparse: no disk or memory cost
      const { page } = await openReader(context, extensionId);
      await page.getByTestId('file-input').setInputFiles(big);
      await waitForPhase(page, 'error');
      const alert = page.getByTestId('state-error');
      await expect(alert).toHaveAttribute('data-code', 'TOO_LARGE');
      await expect(alert).toContainText('larger than 100 MB');
      // Refused up front: PDF.js was never loaded for it.
      await expect(page.getByTestId('state-progress')).toHaveCount(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('reading a large file shows progress, and a file that is not a PDF is refused afterwards', async ({
    context,
    extensionId,
  }) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'clavis-big-'));
    const big = path.join(dir, 'notes.pdf');
    try {
      await truncate(big, 90 * 1024 * 1024).catch(async () => {
        await writeFile(big, '');
        await truncate(big, 90 * 1024 * 1024);
      });
      const { page } = await openReader(context, extensionId);
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __progress: string[] }).__progress = seen;
        new MutationObserver(() => {
          const bar = document.querySelector('[data-testid=state-progress]');
          if (bar) seen.push(bar.getAttribute('value') ?? '');
        }).observe(document.body, { subtree: true, childList: true, attributes: true });
      });
      await page.getByTestId('file-input').setInputFiles(big);
      await waitForPhase(page, 'error');
      await expect(page.getByTestId('state-error')).toHaveAttribute('data-code', 'UNSUPPORTED');
      const seen = await page.evaluate(
        () => (window as unknown as { __progress: string[] }).__progress,
      );
      // Several distinct percentages were shown on the way (a loading bar, not a frozen page).
      expect(new Set(seen).size).toBeGreaterThan(2);
      expect(seen.map(Number).every((n) => n >= 0 && n <= 100)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('corrupt file: message plus a button that opens the picker again', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await loadFixture(page, 'corrupt.pdf');
    await waitForPhase(page, 'error');
    const alert = page.getByTestId('state-error');
    await expect(alert).toHaveAttribute('data-code', 'CORRUPT');
    const chooser = page.waitForEvent('filechooser');
    await alert.getByRole('button', { name: 'Choose another PDF' }).click();
    await chooser;
  });

  test('a password prompt takes focus, flags a wrong password and never shows the password', async ({
    context,
    extensionId,
  }) => {
    const info = fixtureInfo('encrypted.pdf');
    const { page, problems } = await openReader(context, extensionId);
    await loadFixture(page, 'encrypted.pdf');
    await waitForPhase(page, 'password-required');
    const field = page.getByTestId('password-prompt').getByLabel('PDF password');
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill('definitely-wrong');
    await field.press('Enter');
    const error = page.getByTestId('password-error');
    await expect(error).toBeVisible({ timeout: 20_000 });
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('password-prompt').getByLabel('PDF password')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    // The wrong guess is gone from the field and from the page.
    await expect(page.getByTestId('password-prompt').getByLabel('PDF password')).toHaveValue('');
    expect(await page.content()).not.toContain('definitely-wrong');
    expect(problems.join('\n')).not.toContain('definitely-wrong');
    expect(problems.join('\n')).not.toContain(info.password!);
  });
});
