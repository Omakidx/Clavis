import { expect, test } from '@playwright/test';
import { CARD, cardOf, startCardHarness } from './p5-card-support/harness';
import { send } from './p3-support/background';
import { tagAnswers } from './p8-accept-support/answers';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';

const SPEAKER = '[data-clavis="card-translation-speak"]';

test('translated text speaks with the saved voice and rate, and leaving Translate stops it', async () => {
  const h = await startCardHarness();
  try {
    await tagAnswers(h.ext.context);
    await send(h.options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: {
        translationLanguage: 'fr',
        ttsLang: 'en-US',
        ttsVoice: 'Preferred French',
        ttsRate: 1.25,
      },
    });
    await h.ext.serviceWorker.evaluate(() => {
      const g = globalThis as unknown as {
        chrome: { tts: Record<string, unknown> };
        __translatedSpeech: {
          calls: { text: string; voiceName?: string; lang?: string; rate?: number }[];
          stops: number;
          current?: (e: { type: string }) => void;
        };
      };
      const state = (g.__translatedSpeech = { calls: [], stops: 0 } as typeof g.__translatedSpeech);
      g.chrome.tts['getVoices'] = () =>
        Promise.resolve([
          { voiceName: 'Other French', lang: 'fr-FR', remote: false, eventTypes: ['start', 'end'] },
          {
            voiceName: 'Preferred French',
            lang: 'fr-FR',
            remote: true,
            eventTypes: ['start', 'end'],
          },
          {
            voiceName: 'English Default',
            lang: 'en-US',
            remote: false,
            eventTypes: ['start', 'end'],
          },
        ]);
      g.chrome.tts['speak'] = (
        text: string,
        options: {
          voiceName?: string;
          lang?: string;
          rate?: number;
          onEvent: (e: { type: string }) => void;
        },
      ) => {
        state.calls.push({
          text,
          voiceName: options.voiceName,
          lang: options.lang,
          rate: options.rate,
        });
        state.current = options.onEvent;
        setTimeout(() => options.onEvent({ type: 'start' }), 5);
        return Promise.resolve();
      };
      g.chrome.tts['stop'] = () => {
        state.stops++;
        const current = state.current;
        state.current = undefined;
        current?.({ type: 'interrupted' });
      };
    });
    const { page, dispose } = await h.open('article.html?translation-speaker=1');
    try {
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      await card.click(CARD.tab('translate'));
      await card.waitFor(CARD.ready('translate'));
      await card.waitFor(SPEAKER);
      expect(await card.toolbar.attr(SPEAKER, 'aria-label')).toBe('Listen to translation');
      expect(
        await h.ext.serviceWorker.evaluate(
          () =>
            (globalThis as unknown as { __translatedSpeech: { calls: unknown[] } })
              .__translatedSpeech.calls.length,
        ),
      ).toBe(0);
      await card.click(SPEAKER);
      await expect
        .poll(() =>
          h.ext.serviceWorker.evaluate(
            () =>
              (globalThis as unknown as { __translatedSpeech: { calls: unknown[] } })
                .__translatedSpeech.calls,
          ),
        )
        .toEqual([
          { text: 'cartographer (fr)', voiceName: 'Preferred French', lang: 'fr-FR', rate: 1.25 },
        ]);
      await expect.poll(() => card.toolbar.attr(SPEAKER, 'aria-label')).toBe('Stop');
      expect(await card.toolbar.text('.ec__speech-note')).toBe('');
      expect(await card.toolbar.isShown('[data-clavis="listen-note"]')).toBe(false);
      await card.click(SPEAKER);
      await expect
        .poll(() => card.toolbar.attr(SPEAKER, 'aria-label'))
        .toBe('Listen to translation');
      await card.click(SPEAKER);
      await expect
        .poll(() =>
          h.ext.serviceWorker.evaluate(
            () =>
              (globalThis as unknown as { __translatedSpeech: { calls: unknown[] } })
                .__translatedSpeech.calls.length,
          ),
        )
        .toBe(2);
      await expect
        .poll(() => card.toolbar.attr('[data-action="listen"]', 'data-state'))
        .toBe('playing');
      // Let the playing button state settle before targeting the tab with real pointer coordinates.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await card.click(CARD.tab('core'));
      await expect.poll(() => card.toolbar.attr(CARD.tab('core'), 'aria-selected')).toBe('true');
      await expect
        .poll(() =>
          h.ext.serviceWorker.evaluate(
            () =>
              (globalThis as unknown as { __translatedSpeech: { current?: unknown } })
                .__translatedSpeech.current === undefined,
          ),
        )
        .toBe(true);
      await card.click(CARD.tab('translate'));
      await card.waitFor(SPEAKER);
      await page.screenshot({ path: '/tmp/clavis-translation-speaker.png' });
    } finally {
      await dispose();
    }
  } finally {
    await h.close();
  }
});
