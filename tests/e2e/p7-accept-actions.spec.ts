import { expect, test } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import {
  finishAudio,
  installScriptedTts,
  LISTEN,
  listenOf,
  scriptedCalls,
  scriptedStops,
} from './p6-listen-support/listen';
import { startAcceptHarness, promptParts, type AcceptHarness } from './p7-accept-support/harness';
import { accept, pageLines } from './p7-accept-support/manifest';
import { collapse, squash, type Reader } from './p7-accept-support/reader';
import { dblclickWord, dragSelectText } from './p7-accept-support/selection';
import { SEL, tb } from './spike-b-support/toolbar';

// Phase 7 acceptance: FR-053. A selection in the PDF reader offers the SAME toolbar, Listen and
// Explain as a web page. Listen has no voice on this machine, so it must say so with the Linux
// hint; Explain goes through the real background and the real prompt builder with Groq answered
// by the test, and the request is inspected: selection, same-page context (at most 1,000
// characters combined), nothing about the file, the key only in the Authorization header.
let h: AcceptHarness;
let noVoices = false;
test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
  noVoices = await h.noVoices();
});
test.afterAll(async () => {
  await h?.close();
});

const MAX_CONTEXT = 1000;

async function withReader(
  file: string,
  run: (reader: Reader) => Promise<void>,
  options: { password?: string; zoom?: string } = {},
): Promise<void> {
  const reader = await h.openReader({ width: 1300, height: 900 });
  try {
    await reader.openReady(
      file,
      options.password === undefined ? {} : { password: options.password },
    );
    if (options.zoom !== undefined) await reader.setZoom(options.zoom);
    await run(reader);
    await reader.expectQuiet();
  } finally {
    await reader.page.close();
  }
}

async function explain(reader: Reader): Promise<void> {
  h.groq.reset();
  await tb(reader.page).click('explain');
  await cardOf(reader.page).waitFor(CARD.ready('core'));
}

test('a double-clicked word shows the shared toolbar with Listen and Explain, and sends nothing', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    h.groq.reset();
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    expect(collapse(await reader.selectionText())).toBe('zeppelin');
    // The same buttons as on a web page.
    for (const action of ['listen', 'explain'] as const) {
      expect(
        await tb(reader.page).evalIn<boolean>(SEL.action(action), 'function () { return true; }'),
        action,
      ).toBe(true);
    }
    await reader.page.waitForTimeout(500);
    // Selecting is not a request (FR-017).
    expect(h.groq.calls).toHaveLength(0);
    expect(await reader.explainSnapshots()).toEqual([]);
    // The toolbar lies inside the window, near the selection.
    const box = await tb(reader.page).box();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(1300);
    expect(box.y + box.height).toBeLessThanOrEqual(900);
  });
});

test('Listen on this machine (no voices): the honest message and the Linux hint, no spinner, and no Groq call', async () => {
  test.skip(!noVoices, 'This machine has voices; the no-voice path does not apply.');
  await withReader('basic-1page.pdf', async (reader) => {
    h.groq.reset();
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    const listen = listenOf(reader.page);
    await listen.click('listen');
    await listen.waitMessage();
    expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
    expect(await listen.toolbar.text(LISTEN.hint)).toBe(
      'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
    );
    expect(await listen.listenButton()).toMatchObject({
      label: 'Listen',
      state: null,
      disabled: null,
      spinner: false,
    });
    expect(h.groq.calls).toHaveLength(0);
  });
});

test('Explain a word: the card opens, ONE request goes to Groq with the word, the key only in the header', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    await explain(reader);
    const card = cardOf(reader.page);
    expect(await card.text(CARD.text)).toBe('zeppelin');
    const chats = h.groq.chats();
    expect(chats).toHaveLength(1);
    const call = chats[0]!;
    expect(call.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(call.authorization).toMatch(/^Bearer gsk_TEST/);
    const parts = promptParts(call.body);
    expect(parts.selected).toBe('zeppelin');
    // Only the snippet leaves the browser: not the file name, not the page number, not the key.
    const wire = JSON.stringify(call.body);
    expect(wire).not.toContain('basic-1page');
    expect(wire).not.toContain('gsk_TEST');
    expect(wire.length).toBeLessThan(12_000);
    // Nothing else was requested from Groq (no prefetched tabs).
    expect(h.groq.calls).toHaveLength(1);
    // The message the reader sent to the background says: a PDF word on page 1.
    const [snapshot] = await reader.explainSnapshots();
    expect(snapshot).toMatchObject({ source: 'pdf', kind: 'word', text: 'zeppelin', page: 1 });
  });
});

test('Explain a sentence: the whole sentence is sent, labelled as a PDF sentence on its page', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    const line = pageLines(accept('basic-1page.pdf'), 1)[0]!;
    await dragSelectText(reader.page, 1, line.text);
    await tb(reader.page).waitShown();
    await reader.expectSelection(line.text, collapse);
    await explain(reader);
    const parts = promptParts(h.groq.chats()[0]!.body);
    expect(collapse(parts.selected)).toBe(line.text);
    const [snapshot] = await reader.explainSnapshots();
    expect(snapshot).toMatchObject({ source: 'pdf', page: 1 });
    expect(['sentence', 'phrase', 'passage']).toContain(snapshot!.kind);
  });
});

test('a CJK sentence (embedded TrueType) reaches Groq intact', async () => {
  await withReader('cjk-truetype-embedded.pdf', async (reader) => {
    const line = pageLines(accept('cjk-truetype-embedded.pdf'), 1)[1]!;
    await dragSelectText(reader.page, 1, line.text);
    await tb(reader.page).waitShown();
    await explain(reader);
    expect(squash(promptParts(h.groq.chats()[0]!.body).selected)).toBe(squash(line.text));
  });
});

test('an AES-256 encrypted CJK document works end to end: password, selection, Explain', async () => {
  const info = accept('encrypted-aes256.pdf');
  await withReader(
    'encrypted-aes256.pdf',
    async (reader) => {
      const line = pageLines(info, 1)[0]!;
      await dragSelectText(reader.page, 1, line.text);
      await tb(reader.page).waitShown();
      await explain(reader);
      expect(squash(promptParts(h.groq.chats()[0]!.body).selected)).toBe(squash(line.text));
      // The password never travels anywhere: not in the Groq body, not in any message.
      expect(JSON.stringify(h.groq.chats()[0]!.body)).not.toContain(info.password!);
      expect(JSON.stringify(await reader.sentMessages())).not.toContain(info.password!);
    },
    { password: info.password! },
  );
});

test('Chrome-printed CJK whose text layer uses Kangxi radicals: Explain receives the real ideographs, not look-alike code points', async () => {
  const info = accept('cjk-kangxi-radicals.pdf');
  await withReader('cjk-kangxi-radicals.pdf', async (reader) => {
    const line = pageLines(info, 1)[0]!;
    await dragSelectText(reader.page, 1, line.text, { nfkc: true });
    await tb(reader.page).waitShown();
    await explain(reader);
    const sent = promptParts(h.groq.chats()[0]!.body).selected;
    expect(sent).not.toMatch(/[\u2F00-\u2FD5]/);
    expect(squash(sent).normalize('NFKC')).toBe(squash(line.text).normalize('NFKC'));
  });
});

test.describe('context comes from the SAME page and never exceeds 1,000 characters combined', () => {
  async function selectAndExplain(reader: Reader, page: number, word: string) {
    await reader.goToPageIfNeeded(page);
    await dblclickWord(reader.page, page, word);
    await tb(reader.page).waitShown();
    await explain(reader);
    const snapshots = await reader.explainSnapshots();
    const snapshot = snapshots[snapshots.length - 1]!;
    const parts = promptParts(h.groq.chats()[0]!.body);
    return { snapshot, parts };
  }

  test('first word of the middle page: nothing from page 1 is used as context', async () => {
    await withReader('context-pages.pdf', async (reader) => {
      const { snapshot, parts } = await selectAndExplain(reader, 2, 'begins');
      expect(snapshot).toMatchObject({ source: 'pdf', page: 2, text: 'begins' });
      const before = snapshot.contextBefore ?? '';
      const after = snapshot.contextAfter ?? '';
      expect(before + after).not.toContain('ALPHAONE');
      expect(before + after).not.toContain('OMEGATHREE');
      expect(before.length + after.length).toBeLessThanOrEqual(MAX_CONTEXT);
      expect(after).toContain('MIDDLETWO');
      // The prompt carries the same context blocks.
      expect(parts.before ?? '').toBe(before);
      expect(parts.after ?? '').toBe(after);
    });
  });

  test('last words of the middle page: nothing from page 3 is used as context', async () => {
    await withReader('context-pages.pdf', async (reader) => {
      const { snapshot } = await selectAndExplain(reader, 2, 'ends');
      expect(snapshot).toMatchObject({ page: 2, text: 'ends' });
      const all = (snapshot.contextBefore ?? '') + (snapshot.contextAfter ?? '');
      expect(all).not.toContain('OMEGATHREE');
      expect(all).not.toContain('ALPHAONE');
      expect(all.length).toBeLessThanOrEqual(MAX_CONTEXT);
      expect(snapshot.contextBefore ?? '').toContain('MIDDLETWO');
    });
  });

  test('first word of page 3 and a word of page 1: neighbouring pages stay out', async () => {
    await withReader('context-pages.pdf', async (reader) => {
      const third = await selectAndExplain(reader, 3, 'Third');
      expect(third.snapshot.page).toBe(3);
      expect(
        (third.snapshot.contextBefore ?? '') + (third.snapshot.contextAfter ?? ''),
      ).not.toContain('MIDDLETWO');
      await reader.page.keyboard.press('Escape');
      const first = await selectAndExplain(reader, 1, 'Another');
      expect(first.snapshot.page).toBe(1);
      expect(
        (first.snapshot.contextBefore ?? '') + (first.snapshot.contextAfter ?? ''),
      ).not.toContain('MIDDLETWO');
    });
  });

  test('a word in the middle of a 30-line page gets context on both sides, bounded at 1,000 characters', async () => {
    await withReader('context-pages.pdf', async (reader) => {
      const { snapshot } = await selectAndExplain(reader, 2, 'banks');
      const before = snapshot.contextBefore ?? '';
      const after = snapshot.contextAfter ?? '';
      expect(before.length, 'some context before').toBeGreaterThan(0);
      expect(after.length, 'some context after').toBeGreaterThan(0);
      expect(before.length + after.length).toBeLessThanOrEqual(MAX_CONTEXT);
      // The page itself is far bigger than the bound, so the bound is really being applied.
      expect((await reader.pageText(2)).length).toBeGreaterThan(MAX_CONTEXT * 1.5);
      expect(before + after).toContain('middle page');
    });
  });
});

test('a selection over 2,000 characters shows "Selection too long"; trimming sends only the first 2,000 characters', async () => {
  test.setTimeout(90_000);
  await withReader(
    'context-pages.pdf',
    async (reader) => {
      await reader.goToPageIfNeeded(2);
      const lines = pageLines(accept('context-pages.pdf'), 2);
      const first = lines[0]!.text;
      const last = lines[lines.length - 1]!.text;
      // Drag from the first glyph of the first line to the last glyph of the last line.
      await dragSelectText(reader.page, 2, first);
      const startPoint = await reader.page.evaluate(() => {
        const range = document.getSelection()!.getRangeAt(0).cloneRange();
        return range.toString().length;
      });
      expect(startPoint).toBeGreaterThan(5);
      // Extend with shift+click on the last line's last glyph (what a user does to grow a selection).
      const { locateText } = await import('./p7-accept-support/selection');
      const located = await locateText(reader.page, 2, last);
      await reader.page.keyboard.down('Shift');
      await reader.page.mouse.click(
        (located.last.left + located.last.right) / 2,
        (located.last.top + located.last.bottom) / 2,
      );
      await reader.page.keyboard.up('Shift');
      await expect
        .poll(async () => (await reader.selectionText()).length, { timeout: 10_000 })
        .toBeGreaterThan(2000);
      await tb(reader.page).waitShown(SEL.limit);
      const selected = collapse(await reader.selectionText());
      await tb(reader.page).click('trim');
      await tb(reader.page).waitShown(SEL.trimmed);
      const trimmed = (await tb(reader.page).text(SEL.trimmedText)) ?? '';
      expect(trimmed.length).toBeLessThanOrEqual(2000);
      expect(collapse(selected).startsWith(collapse(trimmed).slice(0, 200))).toBe(true);
      h.groq.reset();
      await tb(reader.page).click('explain');
      await cardOf(reader.page).waitFor(CARD.ready('core'));
      const sent = promptParts(h.groq.chats()[0]!.body).selected;
      expect(sent.length).toBeLessThanOrEqual(2000);
      expect(sent.length).toBeGreaterThan(1500);
    },
    { zoom: '0.75' },
  );
});

test('with the page rotated 90 and zoomed to 175%, a selection still shows the toolbar and Explain works', async () => {
  await withReader(
    'rotated-0-90-180-270.pdf',
    async (reader) => {
      await reader.goToPage(2);
      const line = pageLines(accept('rotated-0-90-180-270.pdf'), 2)[0]!;
      await dragSelectText(reader.page, 2, line.text);
      await tb(reader.page).waitShown();
      const box = await tb(reader.page).box();
      expect(box.x + box.width).toBeLessThanOrEqual(1300);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      await explain(reader);
      expect(collapse(promptParts(h.groq.chats()[0]!.body).selected)).toBe(line.text);
      const [snapshot] = await reader.explainSnapshots();
      expect(snapshot).toMatchObject({ source: 'pdf', page: 2 });
    },
    { zoom: '1.75' },
  );
});

test('Escape and a click elsewhere dismiss the toolbar, like on a web page', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    await reader.page.keyboard.press('Escape');
    await tb(reader.page).waitHidden();
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    await reader.page.mouse.click(1250, 850);
    await tb(reader.page).waitHidden();
  });
});

test('closing the document or opening another one dismisses the toolbar and the card (nothing stale is left over)', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    await dblclickWord(reader.page, 1, 'zeppelin');
    await tb(reader.page).waitShown();
    await explain(reader);
    const card = cardOf(reader.page);
    expect(await card.text(CARD.text)).toBe('zeppelin');
    // Replace the document: the old selection's UI goes away.
    await reader.open('columns-3.pdf');
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    await tb(reader.page).waitHidden();
    await expect.poll(() => card.exists(CARD.card), { timeout: 8_000 }).toBe(false);
    expect(collapse(await reader.selectionText())).toBe('');
    // And again with Close PDF.
    await dblclickWord(reader.page, 1, 'Alpha');
    await tb(reader.page).waitShown();
    await explain(reader);
    await reader.page.getByRole('button', { name: 'Close PDF', exact: true }).click();
    await reader.waitPhase('empty');
    await tb(reader.page).waitHidden();
    await expect.poll(() => card.exists(CARD.card), { timeout: 8_000 }).toBe(false);
  });
});

test('a selection that is not inside the pages (toolbar of the reader itself) never opens the Clavis toolbar', async () => {
  await withReader('basic-1page.pdf', async (reader) => {
    await reader.page.getByRole('heading', { level: 1 }).dblclick();
    await reader.page.waitForTimeout(500);
    expect(await tb(reader.page).hostCount()).toBe(0);
  });
});

test.describe('image-only documents', () => {
  test('there is no selectable text, so the toolbar never appears', async () => {
    const reader = await h.openReader({ width: 1300, height: 900 });
    h.groq.reset();
    try {
      await reader.open('scan-image-only.pdf');
      await reader.waitPhase('image-only');
      await expect(reader.pageEl(1).locator('canvas').first()).toBeVisible();
      // Drag across the middle of the page where the picture of text is.
      const box = (await reader.pageEl(1).boundingBox())!;
      await reader.page.mouse.move(box.x + 80, box.y + 160);
      await reader.page.mouse.down();
      await reader.page.mouse.move(box.x + 600, box.y + 180, { steps: 10 });
      await reader.page.mouse.up();
      await reader.page.waitForTimeout(500);
      expect(squash(await reader.selectionText())).toBe('');
      expect(await tb(reader.page).hostCount()).toBe(0);
      expect(h.groq.calls).toHaveLength(0);
    } finally {
      await reader.page.close();
    }
  });
});

test.describe('without a key', () => {
  let bare: AcceptHarness;
  test.beforeAll(async () => {
    bare = await startAcceptHarness({ key: false });
  });
  test.afterAll(async () => {
    await bare?.close();
  });

  test('Explain asks the user to connect Groq (same as a web page); nothing is requested; Listen needs no key', async () => {
    const reader = await bare.openReader({ width: 1300, height: 900 });
    try {
      await reader.openReady('basic-1page.pdf');
      await dblclickWord(reader.page, 1, 'zeppelin');
      await tb(reader.page).waitShown();
      await tb(reader.page).click('explain');
      const card = cardOf(reader.page);
      await card.waitFor(CARD.error);
      expect(await card.text(CARD.error)).toContain('Connect your Groq key to use Explain.');
      expect(bare.groq.calls).toHaveLength(0);
      expect(bare.groqUrls).toEqual([]);
      await reader.expectQuiet();
    } finally {
      await reader.page.close();
    }
  });
});

test.describe('Listen with a (scripted) voice, the positive path', () => {
  let voiced: AcceptHarness;
  test.beforeAll(async () => {
    voiced = await startAcceptHarness({ key: false });
    await installScriptedTts(voiced.ext.serviceWorker);
  });
  test.afterAll(async () => {
    await voiced?.close();
  });

  test('a PDF word and a PDF sentence play, Stop, Slow and Replay follow the real events, and speaking sends nothing to Groq', async () => {
    const reader = await voiced.openReader({ width: 1300, height: 900 });
    try {
      await reader.openReady('basic-1page.pdf');
      const worker = voiced.ext.serviceWorker;
      const before = (await scriptedCalls(worker)).length;
      await dblclickWord(reader.page, 1, 'zeppelin');
      await tb(reader.page).waitShown();
      const listen = listenOf(reader.page);
      await listen.click('listen');
      await listen.waitLabel('Stop');
      expect((await scriptedCalls(worker)).at(-1)).toMatchObject({
        chars: 'zeppelin'.length,
        rate: 1,
      });
      // Stop.
      await listen.click('listen');
      await listen.waitLabel('Listen');
      expect(await scriptedStops(worker)).toBeGreaterThan(0);
      // Slow, then the audio finishes: Replay.
      await listen.click('slow');
      await listen.click('listen');
      await listen.waitLabel('Stop');
      expect((await scriptedCalls(worker)).at(-1)).toMatchObject({ rate: 0.75 });
      await finishAudio(worker);
      await listen.waitLabel('Replay');
      // A sentence is spoken whole, in one call.
      const line = pageLines(accept('basic-1page.pdf'), 1)[0]!;
      const calls = (await scriptedCalls(worker)).length;
      await dragSelectText(reader.page, 1, line.text);
      await tb(reader.page).waitShown();
      await listen.click('listen');
      await listen.waitLabel('Stop');
      const all = await scriptedCalls(worker);
      expect(all.length).toBe(calls + 1);
      expect(all.at(-1)!.chars).toBe(line.text.length);
      expect(all.length).toBeGreaterThan(before);
      expect(voiced.groq.calls).toHaveLength(0);
      await reader.expectQuiet();
    } finally {
      await reader.page.close();
    }
  });
});
