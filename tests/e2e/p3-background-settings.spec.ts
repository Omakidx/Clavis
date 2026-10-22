import { expect, test } from './fixtures';
import {
  FAKE_KEY,
  clavisKeys,
  mockGroq,
  openExtensionPage,
  readStorage,
  restartWorker,
  send,
} from './p3-support/background';

// Phase 3: preferences, onboarding state and CLEAR_ALL_DATA in the built extension.

const DEFAULTS = {
  explanationLanguage: 'en',
  readingLevel: 'standard',
  tooltipBehavior: 'automatic',
  ttsRate: 1,
  disabledSites: [],
};

test.describe('preferences', () => {
  test('start as defaults, persist across a worker restart, and reset to defaults', async ({
    context,
    extensionId,
  }) => {
    const options = await openExtensionPage(context, extensionId, 'options');
    expect(await send(options, { v: 1, type: 'GET_SETTINGS' })).toEqual({
      ok: true,
      data: {
        preferences: DEFAULTS,
        onboarding: { completed: false, disclosureAcceptedAt: null, siteAccessChoice: 'unset' },
      },
    });

    const updated = await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: {
        explanationLanguage: 'es',
        readingLevel: 'simple',
        ttsRate: 0.75,
        ttsLang: 'es-ES',
        model: 'openai/gpt-oss-120b',
      },
    });
    expect(updated?.data?.preferences).toEqual({
      ...DEFAULTS,
      explanationLanguage: 'es',
      readingLevel: 'simple',
      ttsRate: 0.75,
      ttsLang: 'es-ES',
      model: 'openai/gpt-oss-120b',
    });

    await restartWorker(context, options);
    expect((await send(options, { v: 1, type: 'GET_SETTINGS' }))?.data?.preferences).toMatchObject({
      explanationLanguage: 'es',
      readingLevel: 'simple',
      ttsRate: 0.75,
    });
    // The public view (content scripts) shows only the non-secret subset.
    expect(await send(options, { v: 1, type: 'GET_PUBLIC_SETTINGS' })).toMatchObject({
      data: { explanationLanguage: 'es', ttsLang: 'es-ES', model: 'openai/gpt-oss-120b' },
    });

    // null clears an optional field.
    const cleared = await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { model: null },
    });
    expect(cleared?.data?.preferences).not.toHaveProperty('model');

    await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { disabledSites: ['news.example'] },
    });
    const reset = await send(options, { v: 1, type: 'RESET_PREFERENCES' });
    // Reset restores language, level, speed, tooltip and model; the per-site list is kept.
    expect(reset?.data?.preferences).toEqual({ ...DEFAULTS, disabledSites: ['news.example'] });
  });

  test('invalid patches are rejected and change nothing', async ({ context, extensionId }) => {
    const options = await openExtensionPage(context, extensionId, 'options');
    for (const patch of [
      {},
      { ttsRate: 9 },
      { readingLevel: 'x' },
      { disabledSites: ['Bad Host'] },
    ]) {
      expect(await send(options, { v: 1, type: 'UPDATE_PREFERENCES', patch })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect((await send(options, { v: 1, type: 'GET_SETTINGS' }))?.data?.preferences).toEqual(
      DEFAULTS,
    );
  });
});

test.describe('onboarding state', () => {
  test('the disclosure time and the site-access choice persist', async ({
    context,
    extensionId,
  }) => {
    const onboarding = await openExtensionPage(context, extensionId, 'onboarding');
    const first = await send(onboarding, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    const at = first?.data?.onboarding?.['disclosureAcceptedAt'];
    expect(typeof at).toBe('number');
    await send(onboarding, { v: 1, type: 'UPDATE_ONBOARDING', siteAccessChoice: 'declined' });
    await send(onboarding, { v: 1, type: 'UPDATE_ONBOARDING', completed: true });
    // A second acknowledgement does not move the recorded time.
    expect((await send(onboarding, { v: 1, type: 'ACCEPT_DISCLOSURE' }))?.data?.onboarding).toEqual(
      { completed: true, disclosureAcceptedAt: at, siteAccessChoice: 'declined' },
    );

    await restartWorker(context, onboarding);
    expect((await send(onboarding, { v: 1, type: 'GET_SETTINGS' }))?.data?.onboarding).toEqual({
      completed: true,
      disclosureAcceptedAt: at,
      siteAccessChoice: 'declined',
    });
    expect(await send(onboarding, { v: 1, type: 'GET_SITE_ACCESS_STATUS' })).toMatchObject({
      ok: true,
      data: { granted: false, registered: false, choice: 'declined' },
    });
  });
});

test.describe('CLEAR_ALL_DATA', () => {
  test('leaves no Clavis record in either storage area', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await mockGroq(context, { current: 'ok' });
    const options = await openExtensionPage(context, extensionId, 'options');
    await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
    await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    await send(options, {
      v: 1,
      type: 'UPDATE_PREFERENCES',
      patch: { explanationLanguage: 'fr', disabledSites: ['a.test'] },
    });
    // Put a session key in too (a leftover from an earlier choice), as the worst case.
    await serviceWorker.evaluate(() =>
      chrome.storage.session.set({ 'clavis.api-key': { v: 1, data: { key: 'gsk_TESTleftover' } } }),
    );
    expect((await clavisKeys(serviceWorker, 'local')).length).toBeGreaterThan(2);

    expect(await send(options, { v: 1, type: 'CLEAR_ALL_DATA' })).toEqual({
      ok: true,
      data: { cleared: true },
    });
    expect(await clavisKeys(serviceWorker, 'local')).toEqual([]);
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([]);
    expect(JSON.stringify(await readStorage(serviceWorker, 'local'))).not.toContain('gsk_TEST');
    expect(JSON.stringify(await readStorage(serviceWorker, 'session'))).not.toContain('gsk_TEST');

    // Back to a fresh install: defaults, no key, setup required.
    expect(await send(options, { v: 1, type: 'GET_SETTINGS' })).toEqual({
      ok: true,
      data: {
        preferences: DEFAULTS,
        onboarding: { completed: false, disclosureAcceptedAt: null, siteAccessChoice: 'unset' },
      },
    });
    expect(await send(options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
      data: { hasKey: false },
    });
    expect(await send(options, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      data: { state: 'setup_required' },
    });
    // Reading state must not have re-created any record.
    expect(await clavisKeys(serviceWorker, 'local')).toEqual([]);
  });
});
