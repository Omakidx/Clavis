import type { Page, Worker } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * Spike D (D-07): what does speech do in the BUILT extension on THIS machine?
 *
 * The assertions encode the honesty rule (FR-023): a reply is a success only if
 * some engine really has a voice; with no voice anywhere it must be NO_VOICE.
 * The tests adapt to the machine, so the same spec also runs on a machine that
 * does have speech-dispatcher + espeak-ng (then it asserts the positive path).
 *
 * Caveat: this runs in Playwright's bundled Chromium, which can differ from the
 * user's branded Chrome (voice sources, headless audio). Audio itself cannot be
 * heard or asserted here; see docs/decisions/spike-d-voices.md for manual steps.
 */

/** Minimal typing for the `chrome.*` APIs used inside page/worker evaluate callbacks (tsconfig.node.json has no chrome types). */
declare const chrome: {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<{ documentUrl?: string }[]>;
  };
  tts: {
    getVoices(): Promise<
      {
        voiceName?: string;
        lang?: string;
        remote?: boolean;
        extensionId?: string;
        eventTypes?: string[];
      }[]
    >;
    speak(
      text: string,
      options: { onEvent: (event: { type: string; errorMessage?: string }) => void },
    ): Promise<void>;
  };
  offscreen: { closeDocument(): Promise<void> };
};

interface Voice {
  name: string;
  lang: string;
  remote: boolean;
  engine: string;
}
interface Capability {
  engine: string;
  voices: Voice[];
  probes: { engine: string; voiceCount: number; error?: string }[];
}
interface Reply {
  ok: boolean;
  requestId?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const newId = (): string => crypto.randomUUID();

async function openPage(
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

function send(page: Page, message: unknown): Promise<unknown> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

const speak = (page: Page, text: string, rate = 1, lang?: string): Promise<Reply> =>
  send(page, {
    v: 1,
    type: 'TTS_SPEAK',
    requestId: newId(),
    text,
    rate,
    ...(lang === undefined ? {} : { lang }),
  }) as Promise<Reply>;

async function diagnose(page: Page): Promise<{
  ok: boolean;
  data: {
    capability: Capability;
    offscreenApi: { getContexts: boolean; hasDocument: boolean; matchClients: boolean };
    userAgent: string;
  };
}> {
  return (await send(page, { v: 1, type: 'SPEECH_DIAGNOSE' })) as never;
}

const offscreenDocs = (worker: Worker): Promise<{ documentUrl?: string }[]> =>
  worker.evaluate(() =>
    chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    }),
  );

const WORD = 'bank';
const SENTENCE =
  'The river bank was steep, so we walked along the water slowly; it was a quiet afternoon.';

test.describe('spike D: speech in the built extension', () => {
  test('records the voice matrix (chrome.tts and offscreen speechSynthesis)', async ({
    context,
    serviceWorker,
    extensionId,
  }, testInfo) => {
    const page = await openPage(context, extensionId);

    const chromeTtsVoices = await serviceWorker.evaluate(async () =>
      (await chrome.tts.getVoices()).map((v) => ({
        name: v.voiceName ?? '',
        lang: v.lang ?? '',
        remote: v.remote === true,
        extensionId: v.extensionId ?? '',
        eventTypes: v.eventTypes ?? [],
      })),
    );

    const docsBefore = await offscreenDocs(serviceWorker);
    const report = await diagnose(page);
    expect(report.ok).toBe(true);
    const docsAfter = await offscreenDocs(serviceWorker);

    const offscreenProbe = report.data.capability.probes.find(
      (p) => p.engine === 'offscreen-web-speech',
    );
    // Direct view of speechSynthesis.getVoices() inside the offscreen document. Sent from
    // the service worker (the only trusted sender); a tab-hosted page must be ignored.
    const offscreenVoices = await serviceWorker.evaluate(
      () =>
        chrome.runtime.sendMessage({
          v: 1,
          target: 'offscreen',
          type: 'SPEECH_OFFSCREEN_GET_VOICES',
        }) as Promise<{ ok: boolean; supported: boolean; voices: Voice[] }>,
    );
    const fromTabPage = await send(page, {
      v: 1,
      target: 'offscreen',
      type: 'SPEECH_OFFSCREEN_GET_VOICES',
    });
    expect(fromTabPage ?? null).toBeNull();

    const matrix = {
      browser: report.data.userAgent,
      offscreenApi: report.data.offscreenApi,
      chromeTts: { count: chromeTtsVoices.length, voices: chromeTtsVoices },
      offscreen: {
        documentsBeforeProbe: docsBefore.length,
        documentsAfterProbe: docsAfter.length,
        documentUrl: docsAfter[0]?.documentUrl,
        probe: offscreenProbe,
        speechSynthesisSupported: offscreenVoices.supported,
        count: offscreenVoices.voices.length,
        voices: offscreenVoices.voices,
      },
      routedEngine: report.data.capability.engine,
    };
    console.log(`SPIKE-D VOICE MATRIX\n${JSON.stringify(matrix, null, 2)}`);
    await testInfo.attach('voice-matrix.json', {
      body: JSON.stringify(matrix, null, 2),
      contentType: 'application/json',
    });

    // The offscreen document was created on demand and answered, with or without voices.
    expect(docsBefore).toHaveLength(0);
    expect(docsAfter).toHaveLength(1);
    expect(offscreenProbe?.error).toBeUndefined();
    expect(offscreenVoices.ok).toBe(true);
    // The service and the raw APIs agree on what exists.
    expect(report.data.capability.probes.find((p) => p.engine === 'chrome-tts')?.voiceCount).toBe(
      chromeTtsVoices.length,
    );
    expect(offscreenProbe?.voiceCount).toBe(offscreenVoices.voices.length);
    // The API-availability findings the decision doc relies on.
    expect(report.data.offscreenApi.getContexts).toBe(true);
  });

  test('raw engine behaviour with no voice: what chrome.tts and speechSynthesis do on their own', async ({
    context,
    serviceWorker,
    extensionId,
  }, testInfo) => {
    // Measures the failure modes the start timeout exists for; also informs the
    // "call speechSynthesis directly in the reader page" option (no offscreen).
    const raw = await serviceWorker.evaluate(
      () =>
        new Promise<{ events: string[]; error: string | null }>((resolve) => {
          const events: string[] = [];
          let error: string | null = null;
          const finish = (): void => resolve({ events, error });
          setTimeout(finish, 3_000);
          chrome.tts
            .speak('bank', {
              onEvent: (e) => events.push(e.type + (e.errorMessage ? `:${e.errorMessage}` : '')),
            })
            .catch((e: unknown) => {
              error = String(e);
            });
        }),
    );

    const page = await openPage(context, extensionId);
    const web = await page.evaluate(
      () =>
        new Promise<{ supported: boolean; voices: number; events: string[] }>((resolve) => {
          const events: string[] = [];
          const supported = 'speechSynthesis' in window;
          if (!supported) return resolve({ supported, voices: 0, events });
          const u = new SpeechSynthesisUtterance('bank');
          u.onstart = () => events.push('start');
          u.onend = () => events.push('end');
          u.onerror = (e) => events.push(`error:${e.error}`);
          speechSynthesis.speak(u);
          setTimeout(() => {
            speechSynthesis.cancel();
            resolve({ supported, voices: speechSynthesis.getVoices().length, events });
          }, 3_000);
        }),
    );
    const rawReport = { chromeTtsRawSpeak: raw, extensionPageSpeechSynthesis: web };
    console.log(`SPIKE-D RAW BEHAVIOUR\n${JSON.stringify(rawReport, null, 2)}`);
    await testInfo.attach('raw-behaviour.json', {
      body: JSON.stringify(rawReport, null, 2),
      contentType: 'application/json',
    });
    // Nothing to assert about audio itself; the point is the recorded evidence. Sanity only:
    expect(Array.isArray(raw.events)).toBe(true);
    expect(web.supported).toBe(true);
  });

  for (const [label, text] of [
    ['a word', WORD],
    ['a full sentence', SENTENCE],
  ] as const) {
    test(`TTS_SPEAK for ${label} is honest: NO_VOICE without voices, real start with voices`, async ({
      context,
      extensionId,
    }, testInfo) => {
      const page = await openPage(context, extensionId);
      const report = await diagnose(page);
      const { capability } = report.data;
      const anyVoice = capability.voices.length > 0;

      const reply = await speak(page, text);
      await testInfo.attach(`reply-${label.replace(/\s/g, '-')}.json`, {
        body: JSON.stringify({ capabilityEngine: capability.engine, reply }, null, 2),
        contentType: 'application/json',
      });
      console.log(
        `SPIKE-D SPEAK (${label}) engine=${capability.engine} -> ${JSON.stringify(reply)}`,
      );

      if (!anyVoice) {
        // Acceptance criterion: no fake "playing" state when no voice exists.
        expect(reply.ok).toBe(false);
        expect(reply.error?.code).toBe('NO_VOICE');
        expect(reply.error?.message).toMatch(/\S/);
        expect(reply).not.toHaveProperty('data');
      } else if (reply.ok) {
        expect(reply.data?.['state']).toBe('started');
        expect(reply.data?.['engine']).toBe(capability.engine);
        // Positive path: the utterance must reach a terminal state we are told about, and Stop works.
        const stopped = (await send(page, {
          v: 1,
          type: 'TTS_STOP',
          requestId: reply.requestId,
        })) as Reply;
        expect(stopped.ok).toBe(true);
      } else {
        // Voices exist but never started: still an explicit error, never a success.
        expect(reply.error?.code).toBe('NO_VOICE');
      }
    });
  }

  test('TTS_STOP is safe with nothing playing, with and without a requestId', async ({
    context,
    extensionId,
  }) => {
    const page = await openPage(context, extensionId);
    const bare = (await send(page, { v: 1, type: 'TTS_STOP' })) as Reply;
    expect(bare).toMatchObject({ ok: true, data: { stopped: false } });

    const stale = (await send(page, { v: 1, type: 'TTS_STOP', requestId: newId() })) as Reply;
    expect(stale).toMatchObject({ ok: true, data: { stopped: false } });
  });

  test('invalid requests get an error envelope and unrelated messages are left alone', async ({
    context,
    extensionId,
  }) => {
    const page = await openPage(context, extensionId);

    const badRate = await speak(page, WORD, 9);
    expect(badRate.ok).toBe(false);
    expect(badRate.error?.code).not.toBe('NO_VOICE');

    const tooLong = await speak(page, 'x'.repeat(2001));
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'SELECTION_TOO_LONG' } });

    // A type no route owns is left unanswered (GET_AI_STATUS is a routed public message since Phase 3).
    const other = await send(page, { v: 1, type: 'GET_API_KEY' });
    expect(other ?? null).toBeNull();
  });

  test('offscreen document lifecycle: created on demand, reused, and recreated after close', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    const page = await openPage(context, extensionId);
    expect(await offscreenDocs(serviceWorker)).toHaveLength(0);

    // Two speaks in a row (and a parallel pair) must share one document and never throw "single document".
    const replies = await Promise.all([speak(page, WORD), speak(page, SENTENCE)]);
    for (const reply of replies) {
      expect(['NO_VOICE', 'REQUEST_CANCELLED', undefined]).toContain(reply.error?.code);
    }
    await speak(page, WORD);

    const capability = (await diagnose(page)).data.capability;
    if (capability.engine === 'chrome-tts') {
      test.skip(true, 'chrome.tts has voices here, so the offscreen document is never needed.');
    }
    expect(await offscreenDocs(serviceWorker)).toHaveLength(1);

    await serviceWorker.evaluate(() => chrome.offscreen.closeDocument());
    expect(await offscreenDocs(serviceWorker)).toHaveLength(0);

    // The next request transparently recreates it.
    await speak(page, WORD);
    expect(await offscreenDocs(serviceWorker)).toHaveLength(1);
  });

  test('offscreen document is closed by the idle timer in the real extension', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    test.setTimeout(60_000);
    const page = await openPage(context, extensionId);
    const capability = (await diagnose(page)).data.capability; // creates the document
    test.skip(
      capability.probes.find((p) => p.engine === 'chrome-tts')?.voiceCount !== 0,
      'chrome.tts has voices here, so the offscreen engine is not exercised.',
    );
    expect(await offscreenDocs(serviceWorker)).toHaveLength(1);
    // SPEECH_TIMING.offscreenIdleCloseMs is 20 s; allow generous slack.
    await expect
      .poll(async () => (await offscreenDocs(serviceWorker)).length, {
        timeout: 35_000,
        intervals: [1_000],
      })
      .toBe(0);
  });
});
