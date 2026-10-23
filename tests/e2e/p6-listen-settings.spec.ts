import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { openExtensionPage } from './p3-ui-support/pages';
import { finishAudio, installScriptedTts, scriptedCalls } from './p6-listen-support/listen';

// Phase 6, Settings > Voice (FR-025, FR-006) in the built extension: what this device really has,
// per engine (this is where the D-07 check is read off), the voice chooser, Test voice, and the
// honest empty state. This Linux machine has no voices; the scripted chrome.tts of the positive
// tests stands in for a device that has some.

const sendFromPage = (page: import('@playwright/test').Page, message: unknown) =>
  page.evaluate(
    (m) =>
      (
        globalThis as unknown as {
          chrome: { runtime: { sendMessage(m: unknown): Promise<unknown> } };
        }
      ).chrome.runtime.sendMessage(m),
    message,
  ) as Promise<{ ok: boolean; data?: { platform: string; engines: Record<string, unknown> } }>;

test.describe('Voice section, no voices on this device', () => {
  test('shows zero voices per engine, the Linux hint, and disables what cannot work', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'options');
    const report = await sendFromPage(page, { v: 1, type: 'GET_VOICES' });
    test.skip(
      !report.ok ||
        (report.data?.engines['chromeTts'] as { voices: unknown[] }).voices.length > 0 ||
        (report.data?.engines['offscreen'] as { voices: unknown[] }).voices.length > 0,
      'This machine has voices.',
    );
    const section = page.getByRole('region', { name: 'Voice' });
    await expect(section).toBeVisible();
    const counts = section.getByTestId('voice-counts');
    await expect(counts).toContainText('Chrome voices: 0');
    await expect(counts).toContainText(/Fallback voices: (0|not in use)/);
    await expect(section.getByText('No voices found on this device')).toBeVisible();
    if (report.data?.platform === 'linux') {
      await expect(
        section.getByText(
          'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
        ),
      ).toBeVisible();
    }
    await expect(section.getByRole('button', { name: 'Test voice' })).toBeDisabled();
    await expect(section.getByRole('combobox', { name: 'Voice', exact: true })).toBeDisabled();
    // Language and default speed live here and still save.
    await section.getByRole('radio', { name: 'Slow' }).check();
    await expect(section.getByText('Saved.')).toBeVisible();
    await section.getByRole('radio', { name: 'Normal' }).check();

    const results = await new AxeBuilder({ page }).include('#section-voice').analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the toolbar and card route "Voice settings" to the Voice section', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'practice');
    // OPEN_SETTINGS with the new `voice` section, sent exactly as the toolbar sends it.
    const reply = await sendFromPage(page, { v: 1, type: 'OPEN_SETTINGS', section: 'voice' });
    expect(reply.ok).toBe(true);
    // (The install-time onboarding tab may also be opening: find the tab by its URL.)
    await expect
      .poll(() => context.pages().map((p) => p.url()))
      .toContainEqual(expect.stringMatching(/\/options\.html#section-voice$/));
    const settings = context.pages().find((p) => /options\.html#section-voice$/.test(p.url()))!;
    await expect(settings.locator('#section-voice')).toBeVisible();
    await expect(
      settings.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', {
        name: 'Voice',
      }),
    ).toBeVisible();
  });
});

test.describe('Voice section, with voices (scripted chrome.tts)', () => {
  test('lists voices by engine, saves the choice, and Test voice speaks with that voice', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    await installScriptedTts(serviceWorker);
    const { page, errors } = await openExtensionPage(context, extensionId, 'options');
    const section = page.getByRole('region', { name: 'Voice' });
    await expect(section.getByTestId('voice-counts')).toContainText('Chrome voices: 3');
    await expect(section.getByText('No voices found on this device')).toHaveCount(0);
    const chooser = section.getByRole('combobox', { name: 'Voice', exact: true });
    await expect(chooser.locator('optgroup[label="Chrome voices"] option')).toHaveCount(3);
    await expect(chooser.locator('option').first()).toHaveText('Automatic (best match)');
    await expect(chooser.locator('option', { hasText: 'Test Voix FR' })).toHaveText(
      'Test Voix FR (fr-FR) (online)',
    );

    // Filter by language: only the French voice remains.
    await section.getByRole('combobox', { name: 'Show voices for' }).selectOption('fr');
    await expect(chooser.locator('option', { hasText: 'Test Voice US' })).toHaveCount(0);
    await section.getByRole('combobox', { name: 'Show voices for' }).selectOption('');

    // An online voice is only used when chosen, and choosing it says what that means (D-22).
    await expect(page.getByTestId('voice-online-note')).toHaveCount(0);
    await chooser.selectOption('Test Voix FR');
    await expect(page.getByTestId('voice-online-note')).toContainText(
      'the selected text is sent to that service',
    );
    await chooser.selectOption('Test Voice GB');
    await expect(page.getByTestId('voice-online-note')).toHaveCount(0);
    await expect(section.getByText('Saved.')).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole('region', { name: 'Voice' })
        .getByRole('combobox', { name: 'Voice', exact: true }),
    ).toHaveValue('Test Voice GB');

    const before = (await scriptedCalls(serviceWorker)).length;
    const test_ = page
      .getByRole('region', { name: 'Voice' })
      .getByRole('button', { name: 'Test voice' });
    await test_.click();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByText('Playing the test sentence.')).toBeVisible();
    const calls = await scriptedCalls(serviceWorker);
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)).toMatchObject({ voiceName: 'Test Voice GB' });

    await finishAudio(serviceWorker);
    await expect(page.getByRole('button', { name: 'Test voice' })).toBeVisible();
    await expect(page.getByText('Test finished.')).toBeVisible();

    // Back to Automatic clears the preference.
    await page
      .getByRole('region', { name: 'Voice' })
      .getByRole('combobox', { name: 'Voice', exact: true })
      .selectOption('');
    await expect(page.getByText('Saved.')).toBeVisible();

    const results = await new AxeBuilder({ page }).include('#section-voice').analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' | ')}`),
    ).toEqual([]);
    expect(errors).toEqual([]);
  });
});
