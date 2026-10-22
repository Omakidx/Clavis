import { expect, test } from './fixtures';
import {
  dragSelectSpan,
  externalRequests,
  fixtureInfo,
  fixturePath,
  loadFixture,
  normalize,
  openFixtureReady,
  openReader,
  selectionEquals,
  waitForPhase,
} from './spike-c-helpers';

test.describe.configure({ timeout: 90_000 });

test.describe('Spike C: honest states for unusual PDFs', () => {
  test('image-only PDF keeps its pages visible and says OCR is not available', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await openFixtureReady(page, 'image-only.pdf', 'image-only', { expectText: false });
    const message = page.getByTestId('state-image-only');
    await expect(message).toBeVisible();
    await expect(message).toContainText('image-only');
    await expect(message).toContainText('OCR');
    await expect(page.getByTestId('page-count')).toHaveText('of 3');
    // No phantom text: the text layers hold nothing selectable.
    const text = await page.locator('.textLayer').allTextContents();
    expect(text.join('').trim()).toBe('');
    expect(problems).toEqual([]);
  });

  test('corrupt PDF shows a specific error and the reader stays usable', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await loadFixture(page, 'corrupt.pdf');
    await waitForPhase(page, 'error');
    const alert = page.getByTestId('state-error');
    await expect(alert).toHaveAttribute('data-code', 'CORRUPT');
    await expect(alert).toContainText('damaged');
    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    // Not a crash: a valid file opens straight afterwards.
    await openFixtureReady(page, 'text-1page.pdf');
  });

  test('empty file and non-PDF file are rejected without loading PDF.js', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    const input = page.getByTestId('file-input');
    await input.setInputFiles({
      name: 'empty.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.alloc(0),
    });
    await waitForPhase(page, 'error');
    await expect(page.getByTestId('state-error')).toHaveAttribute('data-code', 'CORRUPT');

    await input.setInputFiles({
      name: 'notes.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('This is plain text, not a PDF document.'),
    });
    await expect(page.getByTestId('state-error')).toHaveAttribute('data-code', 'UNSUPPORTED');
  });

  test('password-protected PDF: wrong password is refused, right password opens, cancel returns', async ({
    context,
    extensionId,
  }) => {
    const info = fixtureInfo('encrypted.pdf');
    const { page, problems } = await openReader(context, extensionId);
    await loadFixture(page, 'encrypted.pdf');
    await waitForPhase(page, 'password-required');
    const prompt = page.getByTestId('password-prompt');
    await expect(prompt).toBeVisible();
    await expect(page.getByTestId('password-error')).toHaveCount(0);

    await prompt.getByLabel('PDF password').fill('definitely-wrong');
    await prompt.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByTestId('password-error')).toBeVisible({ timeout: 20_000 });

    await page.getByTestId('password-prompt').getByLabel('PDF password').fill(info.password!);
    await page.getByTestId('password-prompt').getByRole('button', { name: 'Open' }).click();
    await waitForPhase(page, 'ready');
    await expect(
      page.locator('.page[data-page-number="1"] .textLayer span').first(),
    ).toBeAttached();
    const spans = await page.locator('.textLayer span').allTextContents();
    expect(spans.map(normalize)).toContain(info.sentences[0]!.text);
    // The typed password is never rendered back into the DOM.
    expect(await page.content()).not.toContain(info.password!);
    expect(problems.filter((p) => p.includes(info.password!))).toEqual([]);

    // Cancel path: a second encrypted open, dismissed.
    await loadFixture(page, 'encrypted.pdf');
    await waitForPhase(page, 'password-required');
    await page.getByTestId('password-prompt').getByRole('button', { name: 'Cancel' }).click();
    await waitForPhase(page, 'empty');
  });

  test('external links need confirmation; internal links navigate; cancel opens nothing', async ({
    context,
    extensionId,
  }) => {
    await context.route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }),
    );
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'links.pdf');
    const external = page.locator('.annotationLayer a[title^="https://example.com"]');
    await expect(external).toBeAttached();

    // Cancel: dialog shows the URL, nothing opens.
    let opened = 0;
    context.on('page', () => (opened += 1));
    await external.click();
    const dialog = page.getByTestId('link-confirm');
    await expect(dialog).toContainText('https://example.com/clavis-fixture');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await page.waitForTimeout(500);
    expect(opened).toBe(0);

    // Confirm: a new tab opens at the link.
    const popup = context.waitForEvent('page');
    await external.click();
    await page.getByTestId('link-confirm').getByRole('button', { name: 'Open link' }).click();
    expect((await popup).url()).toBe('https://example.com/clavis-fixture');
    await (await popup).close();

    // Internal GoTo link needs no confirmation.
    await page.locator('.annotationLayer a[title="Jump to the second page."]').click();
    await expect(page.getByTestId('link-confirm')).toHaveCount(0);
    await expect(page.getByTestId('page-input')).toHaveValue('2', { timeout: 10_000 });
  });

  test('drag-and-drop opens a PDF', async ({ context, extensionId }) => {
    const { page } = await openReader(context, extensionId);
    const { readFileSync } = await import('node:fs');
    const bytes = readFileSync(fixturePath('text-1page.pdf')).toString('base64');
    await page.evaluate(async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([data], 'dropped.pdf', { type: 'application/pdf' }));
      const target = document.querySelector('.reader')!;
      target.dispatchEvent(
        new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
      target.dispatchEvent(
        new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }),
      );
    }, bytes);
    await waitForPhase(page, 'ready');
    await expect(
      page.locator('.page[data-page-number="1"] .textLayer span').first(),
    ).toBeAttached();
  });
});

test.describe('Spike C: fully offline, no network', () => {
  test('opens, renders and selects text while the browser is offline; only chrome-extension:// requests occur', async ({
    context,
    extensionId,
  }) => {
    const { page, requests, problems } = await openReader(context, extensionId);
    await context.setOffline(true);
    try {
      for (const file of [
        'text-1page.pdf',
        'multi-column.pdf',
        'image-only.pdf',
        'encrypted.pdf',
      ]) {
        await loadFixture(page, file);
        if (file === 'encrypted.pdf') {
          await waitForPhase(page, 'password-required');
          const prompt = page.getByTestId('password-prompt');
          await prompt.getByLabel('PDF password').fill(fixtureInfo(file).password!);
          await prompt.getByRole('button', { name: 'Open' }).click();
        }
        await waitForPhase(page, file === 'image-only.pdf' ? 'image-only' : 'ready');
        await expect(page.locator('.page[data-page-number="1"] canvas').first()).toBeVisible();
        if (file === 'text-1page.pdf') {
          const sentence = fixtureInfo(file).sentences[0]!.text;
          await dragSelectSpan(page, sentence);
          await selectionEquals(page, sentence);
        }
      }
      expect(problems).toEqual([]);
    } finally {
      await context.setOffline(false);
    }
    const external = externalRequests(requests, extensionId);
    expect(external, 'requests outside chrome-extension://').toEqual([]);
    const own = requests.filter((u) => u.startsWith(`chrome-extension://${extensionId}/`));
    const summary = [
      ...new Set(own.map((u) => u.replace(`chrome-extension://${extensionId}/`, ''))),
    ];
    console.log(`[spike-c] extension requests while opening PDFs:\n${summary.join('\n')}`);
    // The tracker sees the worker and the lazily loaded PDF.js chunks, so it is not blind.
    expect(summary.some((u) => /pdf\.worker\.min-.*\.mjs$/.test(u))).toBe(true);
    expect(summary.some((u) => u.startsWith('chunks/pdf'))).toBe(true);
  });

  test('the worker is a chrome-extension:// URL and no inline or remote script runs', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const info = await page.evaluate(() => ({
      origin: location.origin,
      scripts: [...document.scripts].map((s) => s.src || '(inline)'),
    }));
    expect(info.origin).toBe(`chrome-extension://${extensionId}`);
    expect(info.scripts.every((s) => s.startsWith(`chrome-extension://${extensionId}/`))).toBe(
      true,
    );
  });
});
