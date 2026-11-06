import { expect, test } from './fixtures';
import { openExtensionPage } from './p3-ui-support/pages';
import {
  LISTEN,
  articleFrame,
  finishAudio,
  installScriptedTts,
  listenOf,
  scriptedCalls,
  selectArticleWord,
} from './p6-listen-support/listen';

// Phase 6: the practice page's Listen behaves like a web page's (same controller, same toolbar).
// The result panel below the article mirrors the toolbar's states.

const sendFromPage = (page: import('@playwright/test').Page, message: unknown) =>
  page.evaluate(
    (m) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage(m),
    message,
  ) as Promise<{ ok: boolean; data?: { engines: Record<string, { voices: unknown[] }> } }>;

test('without voices: the toolbar and the panel both say so, with the Linux hint, and nothing plays', async ({
  context,
  extensionId,
}) => {
  test.skip(process.platform !== 'linux', 'This case checks Linux no-voice installation guidance.');
  // GET_VOICES is an options/onboarding/popup route: ask from the options page.
  const options = await openExtensionPage(context, extensionId, 'options');
  const report = await sendFromPage(options.page, { v: 1, type: 'GET_VOICES' });
  await options.page.close();
  const { page, errors } = await openExtensionPage(context, extensionId, 'practice');
  test.skip(
    !report.ok ||
      (report.data?.engines['chromeTts']?.voices.length ?? 0) > 0 ||
      (report.data?.engines['offscreen']?.voices.length ?? 0) > 0,
    'This machine has voices.',
  );
  const frame = await articleFrame(page);
  await selectArticleWord(page, frame, 'bank', 1);
  const listen = listenOf(page, frame);
  await listen.click('listen');
  await listen.waitMessage();
  expect(await listen.toolbar.text(LISTEN.message)).toBe("Voice isn't available on this device.");
  expect(await listen.toolbar.text(LISTEN.hint)).toContain('speech-dispatcher');
  expect(await listen.listenButton()).toMatchObject({
    label: 'Speak',
    state: null,
    spinner: false,
  });

  const problem = page.getByTestId('practice-problem');
  await expect(problem).toContainText("Voice isn't available on this device.");
  await expect(problem).toContainText('Install speech-dispatcher');
  await expect(page.getByText('Reading aloud…')).toHaveCount(0);

  // Voice settings from the toolbar opens Settings at the Voice section.
  await listen.click('voice-settings');
  await expect
    .poll(() => context.pages().map((p) => p.url()))
    .toContainEqual(expect.stringMatching(/\/options\.html#section-voice$/));
  expect(errors).toEqual([]);
});

test('with a voice: playing, Stop, Slow, Replay and the panel follow the real events', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  await installScriptedTts(serviceWorker);
  const { page, errors } = await openExtensionPage(context, extensionId, 'practice');
  const frame = await articleFrame(page);
  await selectArticleWord(page, frame, 'bank', 1);
  const listen = listenOf(page, frame);
  const before = (await scriptedCalls(serviceWorker)).length;

  await listen.click('listen');
  await listen.waitLabel('Stop');
  await expect(page.getByTestId('practice-result')).toContainText('Reading aloud…');
  expect((await scriptedCalls(serviceWorker)).at(-1)).toMatchObject({ chars: 4, rate: 1 });

  await listen.click('listen');
  await listen.waitLabel('Speak');
  await expect(page.getByTestId('practice-result')).toContainText('Stopped.');

  await listen.click('slow');
  await listen.click('listen');
  await listen.waitLabel('Stop');
  expect((await scriptedCalls(serviceWorker)).at(-1)).toMatchObject({ rate: 0.75 });
  await finishAudio(serviceWorker);
  await listen.waitLabel('Replay');
  await expect(page.getByTestId('practice-result')).toContainText('Finished reading aloud.');
  expect((await scriptedCalls(serviceWorker)).length).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});
