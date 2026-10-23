import { expect, test } from '@playwright/test';
import { dragSelect } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import {
  CARD,
  explainWord,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { send } from './p3-support/background';
import {
  LISTEN,
  finishAudio,
  installScriptedTts,
  listenOf,
  scriptedCalls,
  scriptedStops,
} from './p6-listen-support/listen';

// Phase 6, Listen's POSITIVE path in the built extension. This machine has no voices, so
// `chrome.tts` inside the service worker is a scripted engine (start after speak, interrupted when
// stopped or replaced, end when the test says so). The toolbar, the observer, the router, the
// voice choice and tabs.sendMessage delivery of TTS_EVENT are the real build. Audio itself cannot
// be asserted here (D-14: by hand).
let h: CardHarness;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  h = await startCardHarness();
  await installScriptedTts(h.ext.serviceWorker);
});
test.afterAll(async () => {
  await h?.close();
});

test('idle -> playing (Stop) -> Replay after the audio ended, with only the selected text spoken', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    const before = (await scriptedCalls(h.ext.serviceWorker)).length;
    await listen.click('listen');
    // Playing only after the engine really started: the label becomes Stop.
    await listen.waitLabel('Stop');
    expect(await listen.listenButton()).toMatchObject({ state: 'playing', spinner: false });
    await listen.until(
      () => listen.toolbar.live(),
      (text) => text === 'Playing.',
      'Playing. announced',
    );

    const calls = await scriptedCalls(h.ext.serviceWorker);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toMatchObject({ chars: 'cartographer'.length, rate: 1 });

    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
    expect((await listen.listenButton())?.state).toBeNull();

    // Replay speaks the same text again.
    await listen.click('listen');
    await listen.waitLabel('Stop');
    expect((await scriptedCalls(h.ext.serviceWorker)).at(-1)?.chars).toBe('cartographer'.length);
    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
  } finally {
    await dispose();
  }
});

test('Stop stops the audio and goes back to Listen', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    const stopsBefore = await scriptedStops(h.ext.serviceWorker);
    await listen.click('listen');
    await listen.waitLabel('Stop');
    await listen.click('listen');
    await listen.waitLabel('Listen');
    await expect.poll(() => scriptedStops(h.ext.serviceWorker)).toBeGreaterThan(stopsBefore);
    await listen.until(
      () => listen.toolbar.live(),
      (text) => text === 'Stopped.',
      'Stopped. announced',
    );
  } finally {
    await dispose();
  }
});

test('Slow speaks at 0.75 for the next playback, and the toggle is remembered for the selection', async () => {
  const { page, dispose } = await h.open();
  try {
    await dragSelect(page, page, 'The old bank stood', 'almost two hundred years.');
    await tb(page).waitShown();
    const listen = listenOf(page);
    await listen.click('slow');
    await listen.until(
      () => listen.pressed(),
      (v) => v === 'true',
      'Slow pressed',
    );
    await listen.click('listen');
    await listen.waitLabel('Stop');
    expect((await scriptedCalls(h.ext.serviceWorker)).at(-1)).toMatchObject({ rate: 0.75 });
    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
    await listen.click('listen');
    await listen.waitLabel('Stop');
    expect((await scriptedCalls(h.ext.serviceWorker)).at(-1)).toMatchObject({ rate: 0.75 });
    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
    await listen.click('slow');
    await listen.click('listen');
    await listen.waitLabel('Stop');
    expect((await scriptedCalls(h.ext.serviceWorker)).at(-1)).toMatchObject({ rate: 1 });
    await finishAudio(h.ext.serviceWorker);
  } finally {
    await dispose();
  }
});

test('an open explanation card survives Listen, and Explain does not stop playback', async () => {
  const { page, dispose } = await h.open();
  try {
    h.groq.reset();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const chats = h.groq.chats().length;
    const listen = listenOf(page);

    await listen.click('listen');
    await listen.waitLabel('Stop');
    // Card is still open and unchanged; no extra request was made.
    expect(await card.exists(CARD.ready('core'))).toBe(true);
    expect(await card.text(CARD.text)).toBe('cartographer');
    expect(h.groq.chats()).toHaveLength(chats);

    // Roots in the card (a second Explain request) does not stop the audio either.
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    expect((await listen.listenButton())?.label).toBe('Stop');

    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
    expect(await card.exists(CARD.slot)).toBe(true);
  } finally {
    await dispose();
  }
});

test('a new selection stops the previous utterance', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitLabel('Stop');
    const stops = await scriptedStops(h.ext.serviceWorker);
    await dragSelect(page, page, 'The old bank stood', 'almost two hundred years.');
    await expect.poll(() => scriptedStops(h.ext.serviceWorker)).toBeGreaterThan(stops);
    await listen.until(
      () => listen.listenButton(),
      (b) => b?.label === 'Listen',
      'reset label',
    );
  } finally {
    await dispose();
  }
});

test('a remote voice is noted once', async () => {
  const { page, dispose } = await h.open();
  try {
    await send(h.options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { ttsVoice: 'Test Voix FR', ttsLang: 'fr' },
    });
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitLabel('Stop');
    await listen.until(
      () => listen.toolbar.text(LISTEN.note),
      (text) => text === 'This voice sends the text to an online service.',
      'remote note',
    );
    await finishAudio(h.ext.serviceWorker);
    await listen.waitLabel('Replay');
    await send(h.options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { ttsVoice: null, ttsLang: null },
    });
  } finally {
    await dispose();
  }
});
