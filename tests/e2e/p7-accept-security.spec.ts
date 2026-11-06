import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import {
  escapeAngles,
  promptParts,
  startAcceptHarness,
  type AcceptHarness,
} from './p7-accept-support/harness';
import { accept, acceptManifest, acceptPath } from './p7-accept-support/manifest';
import { foreignRequests, HOOK, squash, TEXT, type Reader } from './p7-accept-support/reader';
import { clickText, dragSelectText } from './p7-accept-support/selection';
import { tb } from './spike-b-support/toolbar';

// Phase 7 acceptance, security (docs/requirements.md section 8 abuse case 4, architecture
// section 8): page text that looks like HTML or script is only ever text; link annotations with
// javascript:, file:, data:, Launch, JavaScript and GoToR actions do nothing; external links need
// a confirmation and open without an opener; AcroForm fields are not editable and PDF JavaScript
// (open action, field and button actions, document scripts) never runs; hostile file names are
// text; no CSP violation appears for any fixture.
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
});
test.afterAll(async () => {
  await h?.close();
});

const hostile = accept('hostile-text-links.pdf');
const LINKS = hostile.properties!['links'] as Record<string, { text: string; y: number }>;
const HOSTILE_LINES = hostile.lines.slice(0, 6).map((l) => l.text);
const EXAMPLE_URL = 'https://example.com/clavis-hostile-link';

async function withReader(
  file: string,
  run: (reader: Reader) => Promise<void>,
  options: { quiet?: boolean } = {},
): Promise<void> {
  const reader = await h.openReader({ width: 1300, height: 900 });
  try {
    await reader.openReady(file);
    await run(reader);
    if (options.quiet !== false) await reader.expectQuiet();
  } finally {
    await reader.page.close();
  }
}

/** DOM facts that must hold after hostile content was shown. */
async function domFacts(reader: Reader) {
  return reader.page.evaluate(() => ({
    scripts: [...document.scripts].map((s) => s.src || 'inline'),
    injected: document.querySelectorAll(
      '.pdfViewer script, .pdfViewer img, .pdfViewer iframe, .pdfViewer object, .pdfViewer embed, .pdfViewer [onerror], .pdfViewer [onload], .pdfViewer [onclick]',
    ).length,
    handlers: document.querySelectorAll('[onerror], [onload], [onclick], [onfocus]').length,
    badHrefs: [...document.querySelectorAll<HTMLAnchorElement>('a[href]')]
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => /^(javascript|file|data|vbscript):/i.test(href)),
    pwned: (window as unknown as { __clavisPwned?: unknown }).__clavisPwned,
  }));
}

test.describe('page text that looks like markup is text', () => {
  test('HTML, script, template and prompt-injection lines render as text and run nothing', async () => {
    await withReader('hostile-text-links.pdf', async (reader) => {
      const text = squash(await reader.pageText(1));
      for (const line of HOSTILE_LINES) expect(text, line).toContain(squash(line));
      const facts = await domFacts(reader);
      expect(facts.injected).toBe(0);
      expect(facts.handlers).toBe(0);
      expect(facts.badHrefs).toEqual([]);
      expect(facts.pwned).toBeUndefined();
      // Every script on the page is one of the extension's files; none is inline.
      expect(
        facts.scripts.every((s) => s.startsWith(`chrome-extension://${h.ext.extensionId}/`)),
      ).toBe(true);
      expect(reader.observed.newTabs).toEqual([]);
      // `<img src=x>` would have asked for /x.
      expect(h.requests.filter((u) => /\/x$/.test(u))).toEqual([]);
      expect(foreignRequests(h.requests, h.ext.extensionId)).toEqual([]);
      expect(h.webRequests).toEqual([]);
    });
  });

  for (const index of [0, 1, 2, 5]) {
    test(`Explain on the hostile line ${index + 1} sends it as quoted data (angle brackets escaped) and the card shows it as text`, async () => {
      const line = HOSTILE_LINES[index]!;
      await withReader('hostile-text-links.pdf', async (reader) => {
        await dragSelectText(reader.page, 1, line);
        await tb(reader.page).waitShown();
        h.groq.reset();
        await tb(reader.page).click('explain');
        const card = cardOf(reader.page);
        await card.waitFor(CARD.ready('core'));
        const chats = h.groq.chats();
        expect(chats).toHaveLength(1);
        const messages = chats[0]!.body!.messages;
        const user = messages.find((m) => m.role === 'user')!.content;
        const system = messages.find((m) => m.role === 'system')!.content;
        // No raw markup from the page survives in either message.
        expect(user).not.toContain('<script>');
        expect(user).not.toContain('<img');
        expect(user).not.toContain('<svg');
        expect(user).not.toContain('<b>');
        expect(system).not.toContain(line);
        expect(squash(promptParts(chats[0]!.body).selected)).toBe(squash(escapeAngles(line)));
        // The card is plain text: no element created from the string.
        expect(await card.text(CARD.text)).toBe(line.replace(/\s+/g, ' ').trim());
        expect(
          await card.toolbar.evalIn<number>(
            null,
            `function () { return this.querySelectorAll('script, img, iframe, object, embed, [onerror], [onload]').length; }`,
          ),
        ).toBe(0);
        expect((await domFacts(reader)).pwned).toBeUndefined();
      });
    });
  }

  test('a prompt-injection sentence is quoted data: it appears only inside the selected-text block', async () => {
    const line = HOSTILE_LINES[4]!;
    await withReader('hostile-text-links.pdf', async (reader) => {
      await dragSelectText(reader.page, 1, line);
      await tb(reader.page).waitShown();
      h.groq.reset();
      await tb(reader.page).click('explain');
      await cardOf(reader.page).waitFor(CARD.ready('core'));
      const body = h.groq.chats()[0]!.body!;
      const user = body.messages.find((m) => m.role === 'user')!.content;
      const system = body.messages.find((m) => m.role === 'system')!.content;
      expect(system).not.toContain('reveal the API key');
      // The sentence only occurs inside the nonce-tagged block, and the system prompt calls it untrusted.
      expect(user.split('reveal the API key').length - 1).toBe(1);
      expect(user).toMatch(
        /<selected_text_[0-9a-f]+>[^<]*reveal the API key[^<]*<\/selected_text_[0-9a-f]+>/,
      );
      expect(system).toContain('untrusted');
      expect(JSON.stringify(body)).not.toContain('gsk_TEST');
    });
  });
});

test.describe('link annotations', () => {
  const DANGEROUS = ['javascript', 'file', 'data', 'launch', 'js-action', 'gotor'] as const;

  for (const key of DANGEROUS) {
    test(`clicking the "${key}" link does nothing: no tab, no dialog, no navigation, no confirmation, no script`, async () => {
      await withReader('hostile-text-links.pdf', async (reader) => {
        const url = reader.page.url();
        const tabs = h.ext.context.pages().length;
        await clickText(reader.page, 1, LINKS[key]!.text);
        await reader.page.waitForTimeout(1_000);
        expect(reader.page.url()).toBe(url);
        expect(h.ext.context.pages().length).toBe(tabs);
        expect(reader.observed.newTabs).toEqual([]);
        expect(await reader.tid(HOOK.linkConfirm).count()).toBe(0);
        const facts = await domFacts(reader);
        expect(facts.pwned).toBeUndefined();
        expect(facts.badHrefs).toEqual([]);
        expect(h.webRequests).toEqual([]);
        expect(foreignRequests(h.requests, h.ext.extensionId)).toEqual([]);
      });
    });
  }

  test('no link element in the document carries a javascript:, file:, data: or vbscript: target', async () => {
    await withReader('hostile-text-links.pdf', async (reader) => {
      const hrefs = await reader.page.evaluate(() =>
        [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')),
      );
      for (const href of hrefs)
        expect(href ?? '').not.toMatch(/^(javascript|file|data|vbscript):/i);
    });
  });

  test('a mailto link and an https link both ask first; Cancel opens nothing; the dialog names the target', async () => {
    await withReader('hostile-text-links.pdf', async (reader) => {
      for (const [key, shown] of [
        ['mailto', 'mailto:test@example.com'],
        ['https', EXAMPLE_URL],
      ] as const) {
        const tabs = h.ext.context.pages().length;
        await clickText(reader.page, 1, LINKS[key]!.text);
        const dialog = reader.tid(HOOK.linkConfirm);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText(shown);
        await dialog.getByRole('button', { name: TEXT.linkCancel }).click();
        await expect(dialog).toHaveCount(0);
        await reader.page.waitForTimeout(500);
        expect(h.ext.context.pages().length).toBe(tabs);
      }
    });
  });

  test('confirming the https link opens ONE new tab with that URL and without an opener; the reader keeps its state', async () => {
    await h.ext.context.route('https://example.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<title>example</title>ok' }),
    );
    try {
      await withReader(
        'hostile-text-links.pdf',
        async (reader) => {
          await clickText(reader.page, 1, LINKS['https']!.text);
          // The dialog ignores pointer clicks in its first 500 ms (OPEN_GUARD_MS, double-click guard).
          await reader.page.waitForTimeout(700);
          const popup = reader.page.waitForEvent('popup', { timeout: 10_000 });
          const page = h.ext.context.waitForEvent('page', { timeout: 10_000 });
          await reader.tid(HOOK.linkConfirm).getByRole('button', { name: TEXT.linkOpen }).click();
          const opened = await Promise.race([popup, page]);
          await opened.waitForLoadState();
          expect(opened.url()).toBe(EXAMPLE_URL);
          // noopener: the new page cannot reach back into the reader.
          expect(await opened.evaluate(() => window.opener)).toBeNull();
          await opened.close();
          await expect(reader.tid(HOOK.linkConfirm)).toHaveCount(0);
          expect(await reader.phase()).toBe('ready');
          expect(await reader.currentPage()).toBe(1);
        },
        { quiet: false },
      );
    } finally {
      await h.ext.context.unroute('https://example.com/**');
    }
  });

  test('keyboard activation (Tab to each link, Enter) is as harmless as the mouse', async () => {
    await withReader('hostile-text-links.pdf', async (reader) => {
      const anchors = reader.page.locator('.pdfViewer .annotationLayer a');
      const count = await anchors.count();
      expect(count).toBeGreaterThan(0);
      const shown: string[] = [];
      for (let i = 0; i < count; i++) {
        await anchors.nth(i).focus();
        await reader.page.keyboard.press('Enter');
        await reader.page.waitForTimeout(250);
        const dialog = reader.tid(HOOK.linkConfirm);
        if (await dialog.count()) {
          shown.push((await dialog.innerText()).replace(/\s+/g, ' '));
          await dialog.getByRole('button', { name: TEXT.linkCancel }).click();
        }
      }
      for (const text of shown) {
        expect(text).not.toMatch(/javascript:|file:|data:|calc\.exe|vbscript/i);
      }
      expect(reader.observed.newTabs).toEqual([]);
      expect((await domFacts(reader)).pwned).toBeUndefined();
      expect(h.webRequests).toEqual([]);
    });
  });
});

test.describe('forms and PDF JavaScript', () => {
  test('an AcroForm and its JavaScript never become editable controls or run', async () => {
    const info = accept('acroform-javascript.pdf');
    await withReader('acroform-javascript.pdf', async (reader) => {
      await reader.page.waitForTimeout(1_500);
      // No form control anywhere in the pages.
      const controls = await reader.page.evaluate(
        () =>
          document.querySelectorAll(
            '.pdfViewer input, .pdfViewer textarea, .pdfViewer select, .pdfViewer button, .pdfViewer [contenteditable="true"], .pdfViewer [role="textbox"], .pdfViewer [role="button"]',
          ).length,
      );
      expect(controls).toBe(0);
      // Where the text field and the button are drawn, clicking and typing changes nothing.
      const field = info.properties!['field'] as {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      const box = (await reader.pageEl(1).boundingBox())!;
      const css = (await reader.pageSize(1)).width / 612;
      const fx = box.x + 9 + (field.x + field.width / 2) * css;
      const fy = box.y + 9 + (792 - field.y - field.height / 2) * css;
      await reader.page.mouse.click(fx, fy);
      await reader.page.keyboard.type('Mallory', { delay: 20 });
      const tag = await reader.page.evaluate(() => document.activeElement?.tagName ?? '');
      expect(['INPUT', 'TEXTAREA', 'SELECT']).not.toContain(tag);
      const button = info.properties!['button'] as { x: number; y: number };
      await reader.page.mouse.click(
        box.x + 9 + (button.x + 50) * css,
        box.y + 9 + (792 - button.y - 12) * css,
      );
      await reader.page.waitForTimeout(800);
      // Tabbing through the page never lands in a form control.
      for (let i = 0; i < 12; i++) {
        await reader.page.keyboard.press('Tab');
        // The reader's own controls (page box, zoom select, find box) may take focus; nothing inside the pages may.
        const insidePages = await reader.page.evaluate(
          () =>
            document.activeElement?.closest('.pdfViewer') !== null &&
            /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(document.activeElement?.tagName ?? ''),
        );
        expect(insidePages, `Tab ${i + 1} landed in a form control inside the pages`).toBe(false);
      }
      // The scripts did not run: no dialog (alert/print), no new tab, no request to the script's URLs.
      expect(reader.observed.dialogs).toEqual([]);
      expect(reader.observed.newTabs).toEqual([]);
      expect(h.ext.context.pages().filter((p) => /evil\.example/.test(p.url()))).toEqual([]);
      expect(h.webRequests.filter((u) => /evil\.example/.test(u))).toEqual([]);
      expect(foreignRequests(h.requests, h.ext.extensionId)).toEqual([]);
      expect(await reader.pageText(1)).toContain('This form has a text field and PDF JavaScript.');
    });
  });

  test('the reader itself still works after a document full of JavaScript', async () => {
    await withReader('acroform-javascript.pdf', async (reader) => {
      await reader.openReady('basic-1page.pdf');
      expect(await reader.pageText(1)).toContain('zeppelin');
    });
  });
});

test.describe('hostile file names and the CSP canary', () => {
  test('a file name that is HTML is shown as text (title, label, password prompt) and never parsed', async () => {
    const reader = await h.openReader();
    try {
      const name = '<img src=x onerror=window.__clavisPwned=1>.pdf';
      // File.name can contain markup even where the host filesystem rejects those characters.
      await reader.tid(HOOK.fileInput).setInputFiles({
        name,
        mimeType: 'application/pdf',
        buffer: readFileSync(acceptPath('basic-1page.pdf')),
      });
      await reader.waitPhase('ready');
      await reader.waitFirstPage();
      await expect(reader.tid(HOOK.fileName)).toHaveText(name);
      await expect(reader.page).toHaveTitle(
        new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      await reader.tid(HOOK.fileInput).setInputFiles({
        name: '<svg onload=window.__clavisPwned=1>.pdf',
        mimeType: 'application/pdf',
        buffer: readFileSync(acceptPath('encrypted-aes128.pdf')),
      });
      await reader.waitPhase('password-required');
      await expect(reader.tid(HOOK.passwordPrompt)).toContainText(
        '<svg onload=window.__clavisPwned=1>.pdf',
      );
      const facts = await reader.page.evaluate(() => ({
        injected: document.querySelectorAll('img[src="x"], svg[onload], [onerror], [onload]')
          .length,
        pwned: (window as unknown as { __clavisPwned?: unknown }).__clavisPwned,
      }));
      expect(facts).toEqual({ injected: 0, pwned: undefined });
      expect(h.requests.filter((u) => /\/x$/.test(u))).toEqual([]);
      await reader.expectQuiet({ allowConsoleErrors: /Password/ });
    } finally {
      await reader.page.close();
    }
  });

  test('every fixture that opens does so without a CSP violation, uncaught error or console error', async () => {
    test.setTimeout(240_000);
    const reader = await h.openReader({ width: 1300, height: 900 });
    const skip = new Set([
      'image-bomb.pdf',
      'page-huge.pdf',
      'pages-100.pdf',
      'corrupt-truncated.pdf',
      'zero-pages.pdf',
      'xfa-only.pdf',
    ]);
    for (const entry of acceptManifest()) {
      if (skip.has(entry.file)) continue;
      if (!['ready', 'image-only', 'image-only-or-ready'].includes(entry.state)) continue;
      await reader.open(entry.file);
      await reader.waitPhase(['ready', 'image-only']);
      await reader.waitFirstPage(false);
      expect(await reader.cspViolations(), entry.file).toEqual([]);
    }
    for (const entry of ['encrypted-aes128.pdf', 'encrypted-aes256.pdf']) {
      const info = accept(entry);
      await reader.open(entry);
      await reader.submitPassword(info.password!);
      await reader.waitPhase('ready');
      await reader.waitFirstPage();
      expect(await reader.cspViolations(), entry).toEqual([]);
    }
    await reader.expectQuiet();
    expect(h.webRequests).toEqual([]);
    await reader.page.close();
  });

  test('the reader page loads only extension scripts and styles (no inline script, no remote code)', async () => {
    const reader = await h.openReader();
    await reader.openReady('basic-1page.pdf');
    const resources = await reader.page.evaluate(() => ({
      scripts: [...document.scripts].map((s) => s.src || 'inline'),
      styles: [...document.querySelectorAll('link[rel=stylesheet]')].map(
        (l) => (l as HTMLLinkElement).href,
      ),
      inlineHandlers: document.querySelectorAll('[onclick],[onload],[onerror]').length,
    }));
    const own = `chrome-extension://${h.ext.extensionId}/`;
    expect(resources.scripts.every((s) => s.startsWith(own))).toBe(true);
    expect(resources.styles.every((s) => s.startsWith(own))).toBe(true);
    expect(resources.inlineHandlers).toBe(0);
    await reader.page.close();
  });
});
