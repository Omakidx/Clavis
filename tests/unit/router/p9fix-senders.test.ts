import { beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_ID,
  REQ_A,
  REQ_B,
  contentSender,
  createHarness,
  explainMessage,
  makeReady,
  pageSender,
  panelSender,
  popupSender,
  type Harness,
} from './harness';

// Phase 9 audit I1 (AI_EXPLAIN / AI_CANCEL senders) and I2 (TTS_SPEAK voiceName senders).

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST' } };

describe('AI_EXPLAIN and AI_CANCEL senders (I1)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await makeReady(h);
  });

  it.each([
    ['the options page', pageSender('/options.html')],
    ['the onboarding page', pageSender('/onboarding.html')],
    ['the popup', popupSender()],
  ])('refuses both from %s without calling the provider', async (_name, sender) => {
    expect(await h.call(explainMessage(REQ_A), sender)).toMatchObject(INVALID);
    expect(await h.call({ v: 1, type: 'AI_CANCEL', requestId: REQ_A }, sender)).toMatchObject(
      INVALID,
    );
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it.each([
    ['a content script', contentSender()],
    ['the reader', pageSender('/reader.html', 3)],
    ['the practice page', pageSender('/practice.html', 4)],
    ['the side panel', panelSender(5)],
  ])('still accepts both from %s', async (_name, sender) => {
    expect(await h.call(explainMessage(REQ_A), sender)).toMatchObject({ ok: true });
    expect(await h.call({ v: 1, type: 'AI_CANCEL', requestId: REQ_A }, sender)).toMatchObject({
      ok: true,
    });
  });

  it('refuses a foreign extension and an unknown page', async () => {
    const foreign = { id: 'someoneelse', url: 'chrome-extension://someoneelse/reader.html' };
    expect(await h.call(explainMessage(REQ_A), foreign)).toMatchObject(INVALID);
    expect(h.provider.explain).not.toHaveBeenCalled();
  });
});

describe('TTS_SPEAK voiceName senders (I2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  const speak = (extra: object = {}, requestId = REQ_A) => ({
    v: 1,
    type: 'TTS_SPEAK',
    requestId,
    text: 'bank',
    rate: 1,
    ...extra,
  });
  const NAMED = { voiceName: 'chrome-tts-en-US' };

  it.each([
    ['a content script', contentSender()],
    ['the reader', pageSender('/reader.html', 3)],
    ['the practice page', pageSender('/practice.html', 4)],
    ['the side panel', panelSender(5)],
    ['the popup', popupSender()],
  ])('refuses an explicit voice from %s and speaks nothing', async (_name, sender) => {
    expect(await h.call(speak(NAMED), sender)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(h.chromeTts.speakCalls).toHaveLength(0);
  });

  it('still speaks from those senders without a voiceName (the saved preference applies)', async () => {
    for (const [id, sender] of [
      [REQ_A, contentSender()],
      [REQ_B, pageSender('/reader.html', 3)],
    ] as const) {
      expect(await h.call(speak({}, id), sender)).toMatchObject({ ok: true });
    }
    expect(h.chromeTts.speakCalls.length).toBeGreaterThan(0);
  });

  it.each([
    ['the options page', pageSender('/options.html')],
    ['the onboarding page', pageSender('/onboarding.html')],
  ])('accepts an explicit voice from %s (Settings "Test voice")', async (_name, sender) => {
    expect(await h.call(speak(NAMED), sender)).toMatchObject({ ok: true });
    expect(h.chromeTts.speakCalls.at(-1)).toMatchObject({ voice: { name: 'chrome-tts-en-US' } });
  });

  it('does not mistake a content script that spoofs an options url for Settings', async () => {
    const spoof = {
      id: RUNTIME_ID,
      url: 'https://evil.example/chrome-extension/options.html',
      frameId: 0,
      tab: { id: 5, url: 'https://evil.example/' },
    };
    expect(await h.call(speak(NAMED), spoof)).toMatchObject({ ok: false });
    expect(h.chromeTts.speakCalls).toHaveLength(0);
  });
});
