import { expect, test } from './fixtures';
import {
  dragSelectSpan,
  externalRequests,
  openReader,
  selectionEquals,
  waitForPhase,
  type ReaderSession,
} from './p7-reader-support/helpers';
import { promptParts, setUpAi } from './p7-reader-support/ai';
import {
  FULL_PAGE_LINK_URL,
  HOSTILE_LINES,
  HOSTILE_URLS,
  floodPdf,
  fullPageLinkPdf,
  hostilePdf,
  mediaPdf,
} from './p7-reader-support/pdfs';
import { CARD, cardOf } from './p5-card-support/harness';
import { tb } from './spike-b-support/toolbar';

// Phase 7 hardening. A PDF is untrusted input and the reader is a TRUSTED extension page, so what a
// PDF contains must never become markup, script, navigation or an editable field on that page.
test.describe.configure({ timeout: 120_000 });

const HOSTILE_NAME = '<img src=x onerror="window.__pwned=11">.pdf';

async function openHostile(session: ReaderSession): Promise<void> {
  await session.page.getByTestId('file-input').setInputFiles({
    name: HOSTILE_NAME,
    mimeType: 'application/pdf',
    buffer: await hostilePdf(),
  });
  await waitForPhase(session.page, 'ready');
  await expect(
    session.page.locator('.page[data-page-number="1"] .textLayer span').first(),
  ).toBeAttached();
  await expect(session.page.locator('.annotationLayer a').first()).toBeAttached();
}

const pwned = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned);

test.describe('markup-like text in a PDF', () => {
  test('is shown and selected as plain text; no element, handler or script is created from it', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page, problems, dialogs, requests } = session;
    await openHostile(session);

    // The text layer carries the strings literally, as text nodes.
    const layerText = await page.locator('.page[data-page-number="1"] .textLayer').textContent();
    for (const line of HOSTILE_LINES) expect(layerText).toContain(line);

    // No element exists that the PDF's text could have created (the reader's own UI has none either).
    const injected = await page.evaluate(
      () =>
        document.querySelectorAll(
          '.pdfViewer img, .pdfViewer script, .pdfViewer svg, .pdfViewer iframe, .pdfViewer object, .pdfViewer embed, [onerror], [onload], [onclick]:not(button)',
        ).length,
    );
    expect(injected).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.outerHTML.includes('<img src=x')),
    ).toBe(false);
    // Every script on the page is one of the extension's own files.
    expect(
      await page.evaluate(() =>
        [...document.scripts].every((s) => s.src.startsWith(location.origin)),
      ),
    ).toBe(true);

    // The PDF's title is markup too; the tab title uses only the file name, as text.
    await expect(page.getByTestId('file-name')).toHaveText(HOSTILE_NAME);
    await expect(page).toHaveTitle(`${HOSTILE_NAME} — Clavis PDF reader`);

    expect(await pwned(page)).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    expect(externalRequests(requests, extensionId)).toEqual([]);
  });

  test('selected hostile text is quoted as data in the explanation request and drawn as text in the card', async ({
    context,
    extensionId,
  }) => {
    const { groq } = await setUpAi(context, extensionId);
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openHostile(session);
    const line = HOSTILE_LINES[1];
    await dragSelectSpan(page, line);
    await selectionEquals(page, line);
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));

    // The card shows the text through a text node: nothing in it is an element made from the PDF.
    expect(await card.text(CARD.text)).toBe(line);
    const made = await card.toolbar.evalIn<number>(
      null,
      `function () { return this.querySelector('[data-clavis="card-text"]').querySelectorAll('script, img, svg, iframe, [onerror], [onload]').length; }`,
    );
    expect(made).toBe(0);

    // The request carries the angle brackets escaped, so the text cannot close the quoting tags.
    const prompt = groq.chats()[0]!.body!.messages[1]!.content;
    const parts = promptParts(prompt);
    expect(parts.selected).toBe('&lt;script&gt;window.__pwned=2&lt;/script&gt;');
    expect(prompt).not.toContain('<script>');
    expect(await pwned(page)).toBeUndefined();
  });
});

test.describe('links in a PDF', () => {
  test('javascript:, file:, chrome: and data: links do nothing; https needs the confirmation dialog', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page, problems, dialogs, requests } = session;
    await openHostile(session);

    // Every link the PDF draws is neutral until the user confirms: href is '#' for all of them.
    const anchors = await page.locator('.annotationLayer a').evaluateAll((els) =>
      els.map((a) => ({
        href: a.getAttribute('href'),
        title: a.getAttribute('title'),
        target: a.getAttribute('target'),
        rel: a.getAttribute('rel'),
      })),
    );
    // PDF.js drops javascript:, file:, chrome: and data: targets and the JavaScript action while
    // it parses, so only the https link is drawn as a link at all (lib/pdf/links.ts refuses the
    // same targets again, unit-tested, should a future PDF.js let one through).
    expect(anchors).toHaveLength(1);
    for (const a of anchors) {
      expect(a.href).toBe('#');
      expect(a.target).toBeNull();
      expect(a.rel ?? '').toContain('noopener');
    }
    // Only a safe link ever gets a (credential-free) address shown in its title.
    const titles = anchors.map((a) => a.title ?? '').filter(Boolean);
    expect(titles).toEqual([HOSTILE_URLS.https]);

    const pagesBefore = context.pages().length;
    const links = page.locator('.annotationLayer a');
    const count = await links.count();
    for (let i = 0; i < count; i++) {
      const title = (await links.nth(i).getAttribute('title')) ?? '';
      if (title !== '') continue; // the https link is handled below
      await links.nth(i).click({ force: true });
    }
    await page.waitForTimeout(500);
    expect(await page.getByTestId('link-confirm').count()).toBe(0);
    expect(context.pages().length).toBe(pagesBefore);
    expect(page.url()).toMatch(/\/reader\.html$/);
    expect(await pwned(page)).toBeUndefined();
    expect(dialogs).toEqual([]);

    // The https link asks first, shows the exact address, and Cancel opens nothing.
    await page.locator(`.annotationLayer a[title="${HOSTILE_URLS.https}"]`).click();
    const confirm = page.getByTestId('link-confirm');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(HOSTILE_URLS.https);
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    expect(context.pages().length).toBe(pagesBefore);

    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
    expect(externalRequests(requests, extensionId)).toEqual([]);
  });

  test('a link activated from the keyboard asks too, and focus returns to the link afterwards', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openHostile(session);
    const link = page.locator(`.annotationLayer a[title="${HOSTILE_URLS.https}"]`);
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('link-confirm')).toBeVisible();
    // The page behind the dialog is inert: Tab stays inside it.
    await page.keyboard.press('Tab');
    await expect(
      page.getByTestId('link-confirm').getByRole('button', { name: 'Open link' }),
    ).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('link-confirm')).toHaveCount(0);
    await expect(link).toBeFocused();
  });
});

test.describe('scripts, forms and editing inside a PDF', () => {
  test('document JavaScript (OpenAction and a link action) never runs; no dialog, no global', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page, dialogs } = session;
    await openHostile(session);
    await page.waitForTimeout(800);
    // Click the link whose action is JavaScript (the last link drawn).
    const links = page.locator('.annotationLayer a');
    await links.last().click({ force: true });
    await page.waitForTimeout(500);
    expect(await pwned(page)).toBeUndefined();
    expect(dialogs).toEqual([]);
    // PDF.js has no scripting manager here and was told so.
    expect(await page.locator('script[src*="quickjs"], script[src*="sandbox"]').count()).toBe(0);
  });

  test('a form field is not rendered as an editable control; nothing in the viewer accepts input', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await openHostile(session);
    const editable = await page.evaluate(() => ({
      inputs: document.querySelectorAll('.pdfViewer input, .pdfViewer textarea, .pdfViewer select')
        .length,
      editable: document.querySelectorAll('.pdfViewer [contenteditable]').length,
      editors: document.querySelectorAll('.annotationEditorLayer, .annotationEditorParamsToolbar')
        .length,
      widgets: document.querySelectorAll('.annotationLayer .textWidgetAnnotation').length,
    }));
    expect(editable).toEqual({ inputs: 0, editable: 0, editors: 0, widgets: 0 });
  });

  test('plain-text URLs in the text are not turned into links', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page } = session;
    await page.getByTestId('file-input').setInputFiles({
      name: 'urls.pdf',
      mimeType: 'application/pdf',
      buffer: await (async () => {
        const { PDFDocument, StandardFonts } = await import('pdf-lib');
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Helvetica);
        doc.addPage([612, 792]).drawText('See https://example.com/auto-link for more.', {
          x: 54,
          y: 700,
          size: 14,
          font,
        });
        return Buffer.from(await doc.save());
      })(),
    });
    await waitForPhase(page, 'ready');
    await expect(page.locator('.textLayer span').first()).toBeAttached();
    await page.waitForTimeout(500);
    expect(await page.locator('.annotationLayer a').count()).toBe(0);
  });
});

test.describe('double click on a full-page link (MEDIUM-1)', () => {
  test('the second click of a double click cannot press "Open link"; a deliberate click can', async ({
    context,
    extensionId,
  }) => {
    await context.route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stub</title>' }),
    );
    const session = await openReader(context, extensionId);
    const { page } = session;
    await page.getByTestId('file-input').setInputFiles({
      name: 'clickjack.pdf',
      mimeType: 'application/pdf',
      buffer: await fullPageLinkPdf(),
    });
    await waitForPhase(page, 'ready');
    const link = page.locator('.annotationLayer a').first();
    await expect(link).toBeAttached();

    // Learn where "Open link" appears (single click, then cancel).
    await link.click({ position: { x: 200, y: 200 } });
    const open = page.getByTestId('link-confirm').getByRole('button', { name: 'Open link' });
    await expect(open).toBeVisible();
    const box = (await open.boundingBox())!;
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('link-confirm')).toHaveCount(0);

    // Double-click exactly where the button will be: click 1 opens the dialog, click 2 lands on it.
    const pagesBefore = context.pages().length;
    await page.mouse.dblclick(target.x, target.y);
    await page.waitForTimeout(900);
    expect(context.pages().length).toBe(pagesBefore);
    await expect(page.getByTestId('link-confirm')).toBeVisible();

    // A deliberate single click, well after the dialog appeared, opens it.
    const popup = context.waitForEvent('page');
    await open.click();
    expect((await popup).url()).toBe(FULL_PAGE_LINK_URL);
    await (await popup).close();
  });
});

test.describe('media and attachment annotations (MEDIUM-2)', () => {
  test('RichMedia, Screen, Sound and FileAttachment annotations are never drawn, and no audio or video exists', async ({
    context,
    extensionId,
  }) => {
    const session = await openReader(context, extensionId);
    const { page, problems } = session;
    await page.getByTestId('file-input').setInputFiles({
      name: 'media.pdf',
      mimeType: 'application/pdf',
      buffer: await mediaPdf(),
    });
    await waitForPhase(page, 'ready');
    // The ordinary link on the same page IS drawn, so the annotation layer did render.
    await expect(
      page.locator('.annotationLayer a[title="https://example.com/media-ok"]'),
    ).toBeAttached();
    await page.waitForTimeout(500);
    const found = await page.evaluate(() => ({
      media: document.querySelectorAll('.mediaAnnotation, .mediaPlayButton').length,
      attachments: document.querySelectorAll('.fileAttachmentAnnotation').length,
      players: document.querySelectorAll('audio, video, source, track, object, embed, iframe')
        .length,
      sections: document.querySelectorAll('.annotationLayer section').length,
    }));
    expect(found).toEqual({ media: 0, attachments: 0, players: 0, sections: 1 });
    expect(problems.filter((p) => p.startsWith('pageerror'))).toEqual([]);
  });

  test('the extension-page CSP forbids media, frames and base overrides on the reader page', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    const violations = await page.evaluate(
      () =>
        new Promise<string[]>((resolve) => {
          const seen: string[] = [];
          document.addEventListener('securitypolicyviolation', (e) =>
            seen.push(e.violatedDirective),
          );
          const audio = document.createElement('audio');
          // Network media. (Chrome does not apply media-src to blob: media, which is what PDF.js
          // would use; the annotation allowlist is what stops that, see the test above.)
          audio.src = 'https://example.com/clip.mp3';
          audio.preload = 'auto';
          document.body.append(audio);
          audio.load();
          const frame = document.createElement('iframe');
          frame.src = 'https://example.com/';
          document.body.append(frame);
          const base = document.createElement('base');
          base.href = 'https://example.com/';
          document.head.append(base);
          setTimeout(() => {
            audio.remove();
            frame.remove();
            base.remove();
            resolve(seen);
          }, 800);
        }),
    );
    expect(violations.join(' ')).toContain('media-src');
    expect(violations.join(' ')).toContain('frame-src');
    expect(violations.join(' ')).toContain('base-uri');
  });
});

test.describe('annotation flood (LOW-1)', () => {
  test('a page with 20,000 link annotations draws at most 1,000, says so, and stays responsive', async ({
    context,
    extensionId,
  }) => {
    test.slow();
    const session = await openReader(context, extensionId);
    const { page } = session;
    await page.getByTestId('file-input').setInputFiles({
      name: 'flood.pdf',
      mimeType: 'application/pdf',
      buffer: await floodPdf(20_000),
    });
    await waitForPhase(page, 'ready');
    await expect(page.getByTestId('state-annotations-limited')).toBeVisible({ timeout: 30_000 });
    const sections = await page.locator('.annotationLayer section').count();
    expect(sections).toBeGreaterThan(0);
    expect(sections).toBeLessThanOrEqual(1000);
    // Not frozen: a round trip to the page is quick, and the text is still there.
    const started = Date.now();
    await page.evaluate(() => 1);
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(page.locator('.textLayer span').first()).toBeAttached();
    await expect(page.getByTestId('state-annotations-limited')).toContainText('too many');
  });

  test('an ordinary page does not show the notice', async ({ context, extensionId }) => {
    const session = await openReader(context, extensionId);
    await openHostile(session);
    await expect(session.page.getByTestId('state-annotations-limited')).toHaveCount(0);
  });
});
