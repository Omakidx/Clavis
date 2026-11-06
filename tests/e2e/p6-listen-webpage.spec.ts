import { expect, test } from '@playwright/test';
import { dblclickText, dragSelect } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import {
  CARD,
  cardOf,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { LISTEN, listenOf } from './p6-listen-support/listen';
import { send } from './p3-support/background';

// Phase 6, Listen on a web page in the BUILT extension on a machine WITHOUT voices (this Linux
// machine: no speech-dispatcher). FR-023: never a playing state without a voice, an actionable
// message instead, and the Linux hint. No Groq key is stored: Listen must not need one.
let h: CardHarness;
let noVoices = false;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  h = await startCardHarness({ key: false });
  const report = await send(h.options, { v: 1, type: 'GET_VOICES' });
  const data = report?.data as
    { engines: { chromeTts: { voices: unknown[] }; offscreen: { voices: unknown[] } } } | undefined;
  noVoices =
    report?.ok === true &&
    data?.engines.chromeTts.voices.length === 0 &&
    data.engines.offscreen.voices.length === 0;
});
test.afterAll(async () => {
  await h?.close();
});
test.beforeEach(() => {
  test.skip(!noVoices, 'This machine has voices; see p6-listen-voices.spec.ts for that path.');
});

test('a word: Listen shows the no-voice message with the Linux hint, never a playing state', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    expect(await listen.listenButton()).toMatchObject({ label: 'Speak', state: null });

    await listen.click('listen');
    await listen.waitMessage();
    expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
    expect(await listen.toolbar.text(LISTEN.hint)).toBe(
      'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
    );
    // The button is usable again: no permanent spinner, no Stop, no disabled state.
    expect(await listen.listenButton()).toMatchObject({
      label: 'Speak',
      state: null,
      disabled: null,
      spinner: false,
    });
    expect(await listen.exists(LISTEN.voiceSettings)).toBe(true);
    // Announced to screen readers.
    await listen.until(
      () => listen.toolbar.live(),
      (text) => /isn't available/.test(text ?? ''),
      'live message',
    );
    expect(await listen.toolbar.live()).toContain('speech-dispatcher');
    // Never asked Groq for anything (FR-017).
    expect(h.groqUrls).toEqual([]);
  } finally {
    await dispose();
  }
});

test('a sentence: the same honest answer, and a second press tries again', async () => {
  const { page, dispose } = await h.open();
  try {
    await dragSelect(page, page, 'The old bank stood', 'almost two hundred years.');
    await tb(page).waitShown();
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitMessage();
    expect(await listen.toolbar.text(LISTEN.hint)).toContain('espeak-ng');
    await listen.click('listen');
    await listen.waitMessage();
    expect((await listen.listenButton())?.state).toBeNull();
  } finally {
    await dispose();
  }
});

test('Voice settings opens Settings at the Voice section', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitMessage();
    const opened = h.ext.context.waitForEvent('page');
    await listen.click('voice-settings');
    const settings = await opened;
    await settings.waitForURL(/\/options\.html#section-voice$/);
    await expect(settings.getByRole('heading', { name: 'Voice', level: 2 })).toBeVisible();
    await settings.close();
  } finally {
    await dispose();
  }
});

test('the Slow toggle is a pressed/unpressed button and does not start playback', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    expect(await listen.pressed()).toBe('false');
    await listen.click('slow');
    await listen.until(
      () => listen.pressed(),
      (value) => value === 'true',
      'Slow pressed',
    );
    expect(await listen.exists(LISTEN.message)).toBe(false);
    expect((await listen.listenButton())?.state).toBeNull();
  } finally {
    await dispose();
  }
});

test('an open explanation card survives pressing Listen (Phase 5 follow-up)', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    await tb(page).click('explain');
    const card = cardOf(page);
    // No key: the card shows how to connect Groq. It is a real, open card.
    await card.waitFor(CARD.error);
    const slot = await card.exists(CARD.slot);
    expect(slot).toBe(true);

    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitMessage();
    expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
    // The card is still there with its content, and the page selection is unchanged.
    expect(await card.exists(CARD.slot)).toBe(true);
    expect(await card.text(CARD.error)).toContain('Connect your Groq key to use Explain.');
    expect(await listen.toolbar.isShown(SEL.toolbar)).toBe(true);
  } finally {
    await dispose();
  }
});

test('Escape dismisses the toolbar and its message; a new selection starts clean', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    const listen = listenOf(page);
    await listen.click('listen');
    await listen.waitMessage();
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await dblclickText(page, page, 'old');
    await tb(page).waitShown();
    expect(await listen.exists(LISTEN.message)).toBe(false);
    expect((await listen.listenButton())?.label).toBe('Speak');
  } finally {
    await dispose();
  }
});
