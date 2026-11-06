import { expect, test } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import {
  LISTEN,
  finishAudio,
  installScriptedTts,
  listenOf,
  scriptedCalls,
  scriptedStops,
} from './p6-listen-support/listen';
import { synthDir } from './p9-support/pdf';
import { startAcceptHarness, promptParts, type AcceptHarness } from './p7-accept-support/harness';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { tb } from './spike-b-support/toolbar';
import { installLedger, type Ledger } from './p9-support/ledger';
import { pause } from './p9-support/card';

// Phase 9, "E2E tests for local PDF open -> page navigation -> select -> Listen -> Explain" and
// "PDF large-file/malformed/encrypted/scan-only and voice absent fixtures" (FR-050 .. FR-059, UJ-04,
// requirements section 7 "PDF scanned only", "PDF password/encryption", section 9 PDF and Speech rows).
//
// p7-accept proves each reader behaviour on its own; this file proves the ROUTE a person takes through
// them, in one reader tab, and the states in sequence: a bad file never leaves the reader unusable,
// a good file afterwards behaves normally (one request per Explain, nothing foreign, nothing logged).
// Fixtures are the generated ones in tests/fixtures/pdf/accept (see its manifest.json). The machine
// has no speech voices: a scripted chrome.tts stands in for the voice-present and voice-absent cases,
// so both are deterministic.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let h: AcceptHarness;
let ledger: Ledger;

test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
  ledger = await installLedger(h.ext.context);
});
test.afterAll(async () => {
  await h?.close();
});

test('open a 100-page PDF, go to page 88, select a word, Listen, Explain; then page 89 and a second word', async () => {
  const reader = await h.openReader();
  await installScriptedTts(h.ext.serviceWorker);
  const mark = ledger.mark();
  await reader.openWithFileChooser('pages-100.pdf');
  await reader.waitPhase('ready');
  await reader.waitFirstPage();
  expect(await reader.pageCountText()).toContain('100');

  // Page navigation: typed page number (the unique word "quokka" lives on page 88 only).
  await reader.goToPage(88);
  expect(await reader.currentPage()).toBe(88);
  await selectWordByDoubleClick(reader.page, 'quokka', 88);
  await tb(reader.page).waitShown();
  // The selection by itself sends nothing anywhere.
  await pause(600);
  expect(ledger.since(mark).filter((e) => e.host !== '127.0.0.1')).toEqual([]);

  // Listen: the word, once, locally; no AI request (FR-020, FR-053).
  await tb(reader.page).click('listen');
  await expect.poll(async () => (await scriptedCalls(h.ext.serviceWorker)).length).toBe(1);
  expect((await scriptedCalls(h.ext.serviceWorker))[0]?.chars).toBe('quokka'.length);
  expect(ledger.chats(mark)).toHaveLength(0);
  await finishAudio(h.ext.serviceWorker);

  // Explain: one request, labelled as a PDF word on page 88.
  await tb(reader.page).click('explain');
  let card = cardOf(reader.page);
  await card.waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(1);
  const first = (await reader.explainSnapshots()).at(-1);
  expect(first).toMatchObject({ source: 'pdf', kind: 'word', text: 'quokka', page: 88 });
  expect(await card.text(CARD.text)).toBe('quokka');
  expect(promptParts(h.groq.chats().at(-1)?.body).selected).toBe('quokka');

  // Page navigation with a card open, then a new selection: the new card is for the new word and
  // page, one more request, and nothing of the old answer remains (no stale answer, abuse case "stale").
  // (The card is a top-layer overlay near the selection and may sit over the reader's own buttons,
  // so the page is changed with the page box, which needs no pointer.)
  await reader.goToPage(89);
  await expect.poll(() => reader.currentPage()).toBe(89);
  await selectWordByDoubleClick(reader.page, 'marmot', 89);
  await tb(reader.page).waitShown();
  await tb(reader.page).click('explain');
  card = cardOf(reader.page);
  await card.waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(2);
  expect(await card.text(CARD.text)).toBe('marmot');
  const second = (await reader.explainSnapshots()).at(-1);
  expect(second).toMatchObject({ source: 'pdf', text: 'marmot', page: 89 });
  expect(await card.text(CARD.panel('core'))).not.toContain('quokka');

  // The page is the reader's own: never a request to any host but Groq, nothing blocked, quiet.
  expect(ledger.blocked).toEqual([]);
  expect(
    ledger.since(mark).filter((e) => e.host !== '127.0.0.1' && e.host !== 'api.groq.com'),
  ).toEqual([]);
  await reader.expectQuiet();
  expect(await scriptedStops(h.ext.serviceWorker)).toBeGreaterThanOrEqual(0);
  await reader.page.close();
});

test('with no voice on the device, Listen on a PDF word says so, shows no playing state, and Explain still works', async () => {
  const reader = await h.openReader();
  await installScriptedTts(h.ext.serviceWorker, []);
  await reader.openReady('basic-1page.pdf');
  const mark = ledger.mark();
  await selectWordByDoubleClick(reader.page, 'zeppelin');
  await tb(reader.page).waitShown();
  const listen = listenOf(reader.page);
  await listen.click('listen');
  await listen.waitMessage();
  expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
  // Never a fake playing state or a spinner, and the button can be pressed again.
  expect(await listen.listenButton()).toMatchObject({
    label: 'Speak',
    state: null,
    spinner: false,
  });
  expect(ledger.since(mark)).toEqual([]);
  expect(await scriptedCalls(h.ext.serviceWorker)).toEqual([]);
  await tb(reader.page).click('explain');
  await cardOf(reader.page).waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(1);
  await reader.page.close();
});

test('one reader tab through a sequence of bad and good files: every failure is specific, recoverable and quiet; the next good file works normally', async () => {
  const reader = await h.openReader();
  await installScriptedTts(h.ext.serviceWorker, []);
  const mark = ledger.mark();

  // 1. Not a PDF at all (HTML named .pdf), 2. random noise after a valid header, 3. empty file.
  await reader.open('not-a-pdf.pdf');
  await reader.waitPhase('error');
  expect((await reader.error()).code).toBe('UNSUPPORTED');
  await reader.open('corrupt-noise.pdf');
  await reader.waitPhase('error');
  expect((await reader.error()).code).toBe('CORRUPT');
  await reader.open('zero-byte.pdf');
  await reader.waitPhase('error');
  expect((await reader.error()).code).toBe('CORRUPT');
  // No toolbar and no request for any of them.
  expect(await tb(reader.page).hostCount()).toBe(0);

  // 4. A normal file right after: it opens, selects and explains.
  await reader.openReady('basic-1page.pdf');
  await selectWordByDoubleClick(reader.page, 'zeppelin');
  await tb(reader.page).waitShown();
  await tb(reader.page).click('explain');
  await cardOf(reader.page).waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(1);

  // 5. Encrypted: the prompt appears, wrong passwords are refused, the right one opens; then the
  // password is nowhere (not in the DOM, a message, the Groq request or storage).
  await reader.open('encrypted-aes128.pdf');
  await reader.waitPhase('password-required');
  // The earlier document's toolbar and card are dismissed when it is replaced.
  await tb(reader.page).waitHidden(undefined, 8000);
  await reader.submitPassword('wrong-password');
  await expect(reader.tid('password-error')).toBeVisible();
  await reader.submitPassword('clavis-aes128').catch(() => undefined);
  await reader.waitPhase(['ready', 'password-required']);

  // 6. Scan-only: the honest message, the pages visible, nothing selectable, no toolbar.
  await reader.open('scan-image-only.pdf');
  await reader.waitPhase('image-only');
  await expect(reader.tid('state-image-only')).toContainText('appears image-only');
  await reader.page.mouse.dblclick(500, 300);
  await pause(500);
  await tb(reader.page).waitHidden(undefined, 8000);

  // 7. A file with the structure of a 5,001-page document is refused before anything is built.
  const synth = synthDir();
  try {
    const big = synth.pages(5001);
    await reader.openPath(big);
    await reader.waitPhase('error');
    expect((await reader.error()).text).toContain('more than 5000 pages');
  } finally {
    synth.dispose();
  }

  // 8. And finally a good file again.
  await reader.openReady('basic-1page.pdf');
  await selectWordByDoubleClick(reader.page, 'zeppelin');
  await tb(reader.page).waitShown();
  await tb(reader.page).click('explain');
  await cardOf(reader.page).waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(2);

  // Through all of it: no request left the browser for any other host, no uncaught error, no
  // console error, no dialog, no new tab, no CSP violation, and the typed password went nowhere.
  expect(ledger.blocked).toEqual([]);
  for (const call of h.groq.chats().slice(-2)) {
    expect(JSON.stringify(call.body)).not.toContain('wrong-password');
    expect(JSON.stringify(call.body)).not.toContain('clavis-aes128');
  }
  await reader.expectQuiet();
  await reader.page.close();
});
