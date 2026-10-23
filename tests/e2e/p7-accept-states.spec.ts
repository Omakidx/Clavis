import { chmodSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { acceptManifest, accept, acceptPath, pageLines } from './p7-accept-support/manifest';
import { HOOK, squash, TEXT } from './p7-accept-support/reader';
import { manyPages, sparsePdf, tempDir, writeTemp } from './p7-accept-support/synth';
import { clavisKeys, readStorage } from './p3-support/background';
import { dblclickWord } from './p7-accept-support/selection';
import { tb } from './spike-b-support/toolbar';

// Phase 7 acceptance: FR-055 (loading, encrypted, corrupt, malformed and missing-text states:
// specific, actionable, no crash), the size and page limits of docs/architecture.md section 8,
// and the PDF rows of the requirements section 7 error catalog. Every state is reached the way a
// user reaches it: by choosing a file.
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
});
test.afterAll(async () => {
  await h?.close();
});

const MAX_BYTES = 100 * 1024 * 1024;

test.describe('FR-055 passwords (AES-128, AES-256, owner password only)', () => {
  for (const file of ['encrypted-aes128.pdf', 'encrypted-aes256.pdf']) {
    test(`${file}: prompt, wrong password, right password opens and the text is correct`, async () => {
      const info = accept(file);
      const password = info.password!;
      const reader = await h.openReader();
      const seen: string[] = [];
      reader.page.on('console', (m) => seen.push(m.text()));
      await reader.open(file);
      await reader.waitPhase('password-required');
      const prompt = reader.tid(HOOK.passwordPrompt);
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText(file);
      // No page is shown behind the prompt.
      expect((await reader.canvasStats()).canvasCount).toBe(0);
      await expect(reader.passwordInput).toBeFocused();
      expect(await reader.passwordInput.getAttribute('type')).toBe('password');

      // Empty submit does nothing.
      await prompt.getByRole('button', { name: TEXT.passwordSubmit }).click();
      expect(await reader.phase()).toBe('password-required');
      await expect(reader.tid(HOOK.passwordError)).toHaveCount(0);

      // Several wrong passwords: the same prompt with an error, never a lock-up or a loop.
      for (const wrong of ['wrong-1', info.ownerPassword!.slice(0, -1), 'x'.repeat(300)]) {
        await reader.passwordInput.fill(wrong);
        await prompt.getByRole('button', { name: TEXT.passwordSubmit }).click();
        await expect(reader.tid(HOOK.passwordError)).toHaveText(TEXT.passwordIncorrect);
        expect(await reader.phase()).toBe('password-required');
        await expect(reader.passwordInput).toHaveValue('');
      }

      // The right password opens it, with Enter from the keyboard.
      await reader.passwordInput.fill(password);
      await reader.passwordInput.press('Enter');
      await reader.waitPhase('ready');
      await reader.waitFirstPage();
      const text = squash(await reader.pageText(1));
      for (const line of pageLines(info, 1)) expect(text).toContain(squash(line.text));
      expect(await reader.pageCountText()).toBe(`of ${info.pages}`);

      // The password is nowhere: not in the page, the title, web storage, console, messages, the
      // extension's storage or any request.
      const everywhere = await reader.page.evaluate(() => {
        const inputs = [...document.querySelectorAll('input, textarea')].map(
          (el) => (el as HTMLInputElement).value,
        );
        return JSON.stringify([
          document.documentElement.outerHTML,
          document.title,
          location.href,
          inputs,
          { ...localStorage },
          { ...sessionStorage },
        ]);
      });
      expect(everywhere).not.toContain(password);
      expect(seen.join('\n')).not.toContain(password);
      expect(JSON.stringify(await reader.sentMessages())).not.toContain(password);
      expect(JSON.stringify(await readStorage(h.ext.serviceWorker, 'local'))).not.toContain(
        password,
      );
      expect(JSON.stringify(await readStorage(h.ext.serviceWorker, 'session'))).not.toContain(
        password,
      );
      expect(h.requests.join('\n')).not.toContain(password);
      expect(await clavisKeys(h.ext.serviceWorker, 'local')).not.toContain(password);
      await reader.expectQuiet({ allowConsoleErrors: /Incorrect Password|PasswordException/ });
      await reader.page.close();
    });
  }

  test('the owner password also opens a user-password file (full access)', async () => {
    const info = accept('encrypted-aes128.pdf');
    const reader = await h.openReader();
    await reader.openReady('encrypted-aes128.pdf', { password: info.ownerPassword! });
    expect(await reader.pageText(1)).toContain('The quick brown fox');
    await reader.page.close();
  });

  test('Cancel leaves the prompt, shows no document and the reader opens another file', async () => {
    const reader = await h.openReader();
    await reader.open('encrypted-aes256.pdf');
    await reader.waitPhase('password-required');
    await reader.cancelPassword();
    await expect(reader.tid(HOOK.passwordPrompt)).toHaveCount(0);
    expect(await reader.phase()).not.toBe('password-required');
    expect((await reader.canvasStats()).canvasCount).toBe(0);
    await reader.openReady('basic-1page.pdf');
    expect(await reader.pageText(1)).toContain('zeppelin');
    await reader.expectQuiet({ allowConsoleErrors: /Password/ });
    await reader.page.close();
  });

  test('choosing a different file while the prompt is open replaces the prompt', async () => {
    const reader = await h.openReader();
    await reader.open('encrypted-aes128.pdf');
    await reader.waitPhase('password-required');
    await reader.open('basic-1page.pdf');
    await reader.waitPhase('ready');
    await expect(reader.tid(HOOK.passwordPrompt)).toHaveCount(0);
    await reader.waitFirstPage();
    expect(await reader.pageText(1)).toContain('zeppelin');
    await reader.page.close();
  });

  test('a password prompt can be completed with the keyboard alone', async () => {
    const info = accept('encrypted-aes256.pdf');
    const reader = await h.openReader();
    await reader.open('encrypted-aes256.pdf');
    await reader.waitPhase('password-required');
    await reader.page.keyboard.type(info.password!);
    await reader.page.keyboard.press('Enter');
    await reader.waitPhase('ready');
    await reader.page.close();
  });

  test('owner-password-only (print restricted): opens at once without a prompt and text is selectable', async () => {
    const reader = await h.openReader();
    await reader.open('owner-only-no-print.pdf');
    await reader.waitPhase('ready');
    await expect(reader.tid(HOOK.passwordPrompt)).toHaveCount(0);
    await reader.waitFirstPage();
    expect(await reader.pageText(1)).toContain('The quick brown fox');
    await reader.expectQuiet();
    await reader.page.close();
  });
});

test.describe('FR-055 broken and unusual files: a specific message, no crash, the reader stays usable', () => {
  const broken: { file: string; code: string; text: string }[] = [
    { file: 'zero-byte.pdf', code: 'CORRUPT', text: TEXT.corrupt },
    { file: 'corrupt-noise.pdf', code: 'CORRUPT', text: TEXT.corrupt },
    { file: 'not-a-pdf.pdf', code: 'UNSUPPORTED', text: TEXT.unsupported },
  ];
  for (const { file, code, text } of broken) {
    test(`${file}: ${code} with the actionable message, then another file opens normally`, async () => {
      const reader = await h.openReader();
      await reader.open(file);
      await reader.waitPhase('error');
      expect(await reader.error()).toEqual({ code, text });
      await expect(reader.tid(HOOK.stateError)).toHaveAttribute('role', 'alert');
      // The action is offered: choose another file.
      await expect(reader.page.getByRole('button', { name: TEXT.chooseAnother })).toBeVisible();
      await reader.openReady('basic-1page.pdf');
      await expect(reader.tid(HOOK.stateError)).toHaveCount(0);
      expect(await reader.pageText(1)).toContain('zeppelin');
      expect(await reader.page.evaluate(() => window.__clavisPwned)).toBeUndefined();
      await reader.expectQuiet({
        allowConsoleErrors: /Invalid PDF|InvalidPDF|Missing PDF|Warning/,
      });
      await reader.page.close();
    });
  }

  test('the HTML in not-a-pdf.pdf is never run or rendered', async () => {
    const reader = await h.openReader();
    await reader.open('not-a-pdf.pdf');
    await reader.waitPhase('error');
    expect(await reader.page.evaluate(() => window.__clavisPwned)).toBeUndefined();
    expect(await reader.page.evaluate(() => document.querySelectorAll('h1').length)).toBe(1); // the reader's own title
    expect(reader.observed.dialogs).toEqual([]);
    await reader.page.close();
  });

  test('a file with 200 bytes of junk before %PDF- still opens (header anywhere in the first 1 KiB)', async () => {
    const reader = await h.openReader();
    await reader.openReady('leading-junk.pdf');
    expect(await reader.pageText(1)).toContain('zeppelin');
    await reader.page.close();
  });

  for (const file of ['corrupt-truncated.pdf', 'xfa-only.pdf']) {
    test(`${file}: ends in a defined state (document or specific error), never blank or hung`, async () => {
      const reader = await h.openReader();
      await reader.open(file);
      const phase = await reader.waitPhase(['ready', 'image-only', 'error'], 30_000);
      if (phase === 'error') {
        const { code, text } = await reader.error();
        expect(['CORRUPT', 'UNSUPPORTED']).toContain(code);
        expect(text.length).toBeGreaterThan(20);
      } else {
        // A document: the controls are consistent with it.
        await expect(reader.tid(HOOK.pageCount)).toHaveText(/^of \d+$/);
      }
      // Still alive and able to open the next file.
      await reader.openReady('basic-1page.pdf');
      await reader.expectQuiet({ allowConsoleErrors: /./ });
      await reader.page.close();
    });
  }

  test('a structurally valid PDF with ZERO pages ends in a defined state, never an endless "Opening..."', async () => {
    const reader = await h.openReader();
    await reader.open('zero-pages.pdf');
    const phase = await reader.waitPhase(['ready', 'image-only', 'error'], 10_000);
    if (phase === 'error')
      expect(['CORRUPT', 'UNSUPPORTED']).toContain((await reader.error()).code);
    await reader.page.close();
  });

  test('XFA-only form: UNSUPPORTED with the existing message (not a blank "Please wait" page)', async () => {
    const reader = await h.openReader();
    await reader.open('xfa-only.pdf');
    const phase = await reader.waitPhase(['ready', 'image-only', 'error']);
    expect(phase).toBe('error');
    expect((await reader.error()).code).toBe('UNSUPPORTED');
    await reader.page.close();
  });

  test('a file the browser cannot read (permissions removed) gives the PERMISSION message', async () => {
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, 'unreadable.pdf');
      copyFileSync(acceptPath('basic-1page.pdf'), file);
      chmodSync(file, 0o000);
      const reader = await h.openReader();
      await reader.openPath(file).catch(() => undefined);
      const phase = await reader.waitPhase(['error', 'ready'], 15_000);
      test.info().annotations.push({ type: 'observed', description: `chmod 000 -> ${phase}` });
      expect(phase).toBe('error');
      const { code, text } = await reader.error();
      expect(code).toBe('PERMISSION');
      expect(text).toContain("couldn't read this file");
      await reader.page.close();
    } finally {
      tmp.dispose();
    }
  });

  test('a second file opened while the first is still loading wins (no stale state)', async () => {
    const reader = await h.openReader();
    await reader.open('pages-100.pdf');
    await reader.open('basic-1page.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    await expect(reader.page.getByTestId(HOOK.fileName)).toHaveText('basic-1page.pdf');
    await expect.poll(() => reader.pageCountText()).toBe('of 1');
    await reader.settle({ quietMs: 1200 });
    expect(await reader.pageCountText()).toBe('of 1');
    expect((await reader.canvasStats()).pages).toBe(1);
    await reader.page.close();
  });
});

test.describe('FR-055 image-only and missing text', () => {
  test('a scan shows the image-only message (no OCR promised); pages are visible; nothing selectable', async () => {
    const reader = await h.openReader();
    await reader.open('scan-image-only.pdf');
    await reader.waitPhase('image-only');
    const banner = reader.tid(HOOK.stateImageOnly);
    await expect(banner).toBeVisible();
    await expect(banner).toHaveText(TEXT.imageOnly);
    await expect(reader.pageEl(1).locator('canvas').first()).toBeVisible();
    expect(await reader.pageCountText()).toBe('of 2');
    // The picture of text is really drawn.
    const ink = await reader
      .pageEl(1)
      .locator('canvas')
      .first()
      .evaluate((canvas: HTMLCanvasElement) => {
        const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i]! < 100) dark++;
        return dark;
      });
    expect(ink).toBeGreaterThan(500);
    expect(squash(await reader.pageText(1))).toBe('');
    // Navigation still works on a scan.
    await reader.goToPage(2);
    await reader.expectQuiet();
    await reader.page.close();
  });

  test('a picture cover followed by text is NOT called image-only', async () => {
    const reader = await h.openReader();
    await reader.open('cover-then-text.pdf');
    await reader.waitPhase('ready');
    await expect(reader.tid(HOOK.stateImageOnly)).toHaveCount(0);
    await reader.goToPage(2);
    expect(await reader.pageText(2)).toContain('Chapter one starts');
    await reader.page.close();
  });

  test('five picture pages then a text page: the banner may show (Spike C limitation) but page 6 stays selectable and searchable', async () => {
    const reader = await h.openReader();
    await reader.open('scan-then-text.pdf');
    const phase = await reader.waitPhase(['ready', 'image-only']);
    test
      .info()
      .annotations.push({ type: 'observed', description: `scan-then-text.pdf -> ${phase}` });
    await reader.goToPage(6);
    expect(await reader.pageText(6)).toContain('Real text finally appears on page six.');
    // Selecting a word on page 6 still gives the toolbar, whatever the banner says.
    await dblclickWord(reader.page, 6, 'finally');
    await tb(reader.page).waitShown();
    expect(squash(await reader.selectionText())).toBe('finally');
    await reader.find('finally');
    await expect.poll(() => reader.findStatus()).toBe('1 of 1');
    await reader.page.close();
  });
});

test.describe('FR-055 limits (docs/architecture.md section 8)', () => {
  test('more than 5,000 pages: the "more than 5,000 pages" message appears quickly and the page stays responsive', async () => {
    test.setTimeout(120_000);
    const tmp = tempDir();
    try {
      const file = writeTemp(tmp.dir, 'pages-5001.pdf', manyPages(5001));
      const reader = await h.openReader();
      const started = Date.now();
      await reader.openPath(file);
      await reader.waitPhase('error', 60_000);
      const { code, text } = await reader.error();
      expect(code).toBe('TOO_LARGE');
      expect(text).toBe(TEXT.tooManyPages(5000));
      expect(Date.now() - started).toBeLessThan(45_000);
      // No viewer was built for it, and the tab still answers.
      expect((await reader.canvasStats()).pages).toBe(0);
      expect(await reader.page.evaluate(() => 1 + 1)).toBe(2);
      await reader.openReady('basic-1page.pdf');
      await reader.expectQuiet();
      await reader.page.close();
    } finally {
      tmp.dispose();
    }
  });

  test('exactly 5,000 pages opens; only a handful of canvases exist; the last page is reachable', async () => {
    test.setTimeout(180_000);
    const tmp = tempDir();
    try {
      const file = writeTemp(tmp.dir, 'pages-5000.pdf', manyPages(5000));
      const reader = await h.openReader();
      await reader.openPath(file);
      await reader.waitPhase('ready', 90_000);
      await reader.waitFirstPage();
      expect(await reader.pageCountText()).toBe('of 5000');
      expect((await reader.canvasStats()).canvasCount).toBeLessThanOrEqual(14);
      await reader.goToPage(5000);
      expect(await reader.currentPage()).toBe(5000);
      const stats = await reader.canvasStats();
      expect(stats.canvasCount).toBeLessThanOrEqual(14);
      expect(stats.withCanvas).toContain(5000);
      await reader.expectQuiet();
      await reader.page.close();
    } finally {
      tmp.dispose();
    }
  });

  test('a file one byte over 100 MiB is refused from its size alone, with the size message', async () => {
    test.setTimeout(60_000);
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, 'huge.pdf');
      sparsePdf(file, MAX_BYTES + 1);
      const reader = await h.openReader();
      const started = Date.now();
      await reader.openPath(file);
      await reader.waitPhase('error');
      const { code, text } = await reader.error();
      expect(code).toBe('TOO_LARGE');
      expect(text).toBe(TEXT.tooLarge(100));
      // Refused without reading it: well under what reading 100 MiB takes.
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(await reader.page.workers().length).toBe(0);
      await reader.openReady('basic-1page.pdf');
      await reader.page.close();
    } finally {
      tmp.dispose();
    }
  });

  test('a file of exactly 100 MiB is NOT refused for its size (it fails on its content instead)', async () => {
    test.setTimeout(120_000);
    const tmp = tempDir();
    try {
      const file = path.join(tmp.dir, 'at-limit.pdf');
      sparsePdf(file, MAX_BYTES);
      const reader = await h.openReader();
      await reader.openPath(file);
      const phase = await reader.waitPhase(['error', 'ready'], 100_000);
      expect(phase).toBe('error');
      const { code } = await reader.error();
      expect(code).not.toBe('TOO_LARGE');
      expect(['CORRUPT', 'UNSUPPORTED']).toContain(code);
      await reader.openReady('basic-1page.pdf');
      await reader.page.close();
    } finally {
      tmp.dispose();
    }
  });

  test('a 400-megapixel image in a 50 KB file is skipped: the page opens with its text, nothing is drawn for the image', async () => {
    const reader = await h.openReader({ width: 1200, height: 1000 });
    await reader.open('image-bomb.pdf');
    await reader.waitPhase('ready', 60_000);
    await reader.waitFirstPage();
    await reader.setZoom('1');
    expect(await reader.pageText(1)).toContain('Image bomb below');
    // The image box is x 72..540, y 200..668 (pt); a skipped image leaves it white, a decoded one black.
    const centre = await reader
      .pageEl(1)
      .locator('canvas')
      .first()
      .evaluate((canvas: HTMLCanvasElement) => {
        const css = canvas.getBoundingClientRect().width / 612;
        const sx = canvas.width / canvas.getBoundingClientRect().width;
        const x = Math.round(306 * css * sx);
        const y = Math.round((792 - 434) * css * sx);
        const [r, g, b] = canvas.getContext('2d')!.getImageData(x, y, 1, 1).data;
        return [r, g, b];
      });
    expect(centre).toEqual([255, 255, 255]);
    expect(await reader.page.evaluate(() => 1 + 1)).toBe(2);
    await reader.expectQuiet({ allowConsoleErrors: /./ });
    await reader.page.close();
  });

  test('a 14400 x 14400 pt page: canvas stays within 4096 x 4096 pixels at 100% and at 175%, and the page is usable', async () => {
    test.setTimeout(90_000);
    const reader = await h.openReader({ width: 1200, height: 900 });
    await reader.open('page-huge.pdf');
    await reader.waitPhase('ready', 60_000);
    await reader.waitFirstPage();
    for (const zoom of ['1', '1.75', 'page-width']) {
      await reader.setZoom(zoom);
      const stats = await reader.canvasStats();
      expect(stats.maxCanvasPixels, `zoom ${zoom}`).toBeLessThanOrEqual(4096 * 4096);
      expect(await reader.page.evaluate(() => 1 + 1)).toBe(2);
    }
    expect(await reader.pageText(1)).toContain('Huge page');
    await reader.expectQuiet({ allowConsoleErrors: /./ });
    await reader.page.close();
  });
});

test.describe('manifest and expected states', () => {
  // Every fixture in the manifest ends in the state the manifest says, through the real UI.
  for (const entry of acceptManifest()) {
    if (['password-required'].includes(entry.state)) continue; // covered above, with passwords
    if (
      ['corrupt-truncated.pdf', 'zero-pages.pdf', 'image-bomb.pdf', 'page-huge.pdf'].includes(
        entry.file,
      )
    )
      continue;
    test(`${entry.file} -> ${entry.state}`, async () => {
      test.setTimeout(60_000);
      const reader = await h.openReader();
      await reader.open(entry.file);
      const phase = await reader.waitPhase(
        ['ready', 'image-only', 'error', 'password-required'],
        45_000,
      );
      const expected: Record<string, string[]> = {
        ready: ['ready'],
        'image-only': ['image-only'],
        'image-only-or-ready': ['image-only', 'ready'],
        'error-corrupt': ['error'],
        'error-unsupported': ['error'],
        'ready-or-corrupt': ['ready', 'error'],
        'ready-or-unsupported': ['ready', 'error'],
      };
      expect(expected[entry.state], `${entry.file}`).toContain(phase);
      if (phase === 'error') {
        const { code } = await reader.error();
        if (entry.state === 'error-corrupt') expect(code).toBe('CORRUPT');
        if (entry.state === 'error-unsupported') expect(code).toBe('UNSUPPORTED');
      }
      await reader.page.close();
    });
  }
});
