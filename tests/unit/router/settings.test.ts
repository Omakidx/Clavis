import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ONBOARDING,
  DEFAULT_PREFERENCES,
  clearAllDataResultSchema,
  messageReplySchema,
  settingsSnapshotSchema,
  siteAccessStatusSchema,
} from '../../../lib/contracts';
import { STORAGE_KEYS, StorageUnavailableError } from '../../../lib/storage';
import {
  FAKE_KEY,
  KEY_MESSAGES,
  SETTINGS_MESSAGES,
  createHarness,
  pageSender,
  popupSender,
} from './harness';

const snapshotReply = messageReplySchema(settingsSnapshotSchema);
const options = pageSender('/options.html');
const update = (patch: object) => ({ v: 1, type: 'UPDATE_PREFERENCES', patch });

describe('GET_SETTINGS', () => {
  it('returns defaults for a fresh install, in the contract shape', async () => {
    const h = createHarness();
    expect(
      snapshotReply.parse(await h.call(SETTINGS_MESSAGES['GET_SETTINGS'], popupSender())),
    ).toEqual({
      ok: true,
      data: { preferences: DEFAULT_PREFERENCES, onboarding: DEFAULT_ONBOARDING },
    });
  });

  it('never carries key information', async () => {
    const h = createHarness();
    await h.call(KEY_MESSAGES['SET_API_KEY'], options);
    const text = JSON.stringify(await h.call(SETTINGS_MESSAGES['GET_SETTINGS'], options));
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('1234');
  });
});

describe('UPDATE_PREFERENCES (FR-006)', () => {
  it('persists a validated patch and returns the new snapshot', async () => {
    const h = createHarness();
    const reply = snapshotReply.parse(
      await h.call(
        update({ explanationLanguage: 'es', readingLevel: 'simple', ttsRate: 0.75 }),
        options,
      ),
    );
    expect(reply).toMatchObject({
      ok: true,
      data: {
        preferences: { explanationLanguage: 'es', readingLevel: 'simple', ttsRate: 0.75 },
      },
    });
    // Persists: a new store over the same area sees it.
    expect(await h.settingsStore.getPreferences()).toMatchObject({ explanationLanguage: 'es' });
    expect(h.local.keys()).toEqual([STORAGE_KEYS.preferences]);
  });

  it('null clears optional fields', async () => {
    const h = createHarness();
    await h.call(update({ ttsLang: 'en-GB', model: 'm' }), options);
    const reply = snapshotReply.parse(
      await h.call(update({ ttsLang: null, model: null }), options),
    );
    expect(reply).toMatchObject({ ok: true });
    if (reply.ok) {
      expect(reply.data.preferences).not.toHaveProperty('ttsLang');
      expect(reply.data.preferences).not.toHaveProperty('model');
    }
  });

  it.each([
    ['empty patch', {}],
    ['unknown field', { apiKey: 'x' }],
    ['bad rate', { ttsRate: 5 }],
    ['bad level', { readingLevel: 'expert' }],
    ['bad hostname', { disabledSites: ['Not A Host'] }],
    ['scheme in hostname', { disabledSites: ['https://a.test'] }],
    ['too many sites', { disabledSites: Array.from({ length: 501 }, (_, i) => `h${i}.test`) }],
  ])('rejects %s with INVALID_REQUEST and stores nothing', async (_name, patch) => {
    const h = createHarness();
    expect(await h.call(update(patch), options)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    expect(h.local.keys()).toEqual([]);
  });

  it('applies the site policy only when tooltip behaviour or disabled sites change', async () => {
    const h = createHarness();
    await h.call(update({ readingLevel: 'simple' }), options);
    expect(h.siteAccess.reconcile).not.toHaveBeenCalled();
    await h.call(update({ tooltipBehavior: 'on-demand' }), options);
    expect(h.siteAccess.reconcile).toHaveBeenCalledTimes(1);
    await h.call(update({ disabledSites: ['a.test'] }), options);
    expect(h.siteAccess.reconcile).toHaveBeenCalledTimes(2);
  });

  it('still succeeds if re-applying the site policy fails (the setting is saved)', async () => {
    const h = createHarness();
    h.siteAccess.reconcile.mockRejectedValue(new Error('scripting failed'));
    expect(await h.call(update({ tooltipBehavior: 'on-demand' }), options)).toMatchObject({
      ok: true,
      data: { preferences: { tooltipBehavior: 'on-demand' } },
    });
  });

  it('reports STORAGE_UNAVAILABLE when storage fails', async () => {
    const h = createHarness();
    h.local.failWith = new Error('quota');
    expect(await h.call(update({ ttsRate: 1.5 }), options)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
    expect(new StorageUnavailableError().message).toMatch(/\S/);
  });
});

describe('RESET_PREFERENCES (FR-006, FR-078)', () => {
  it('keeps the disabled-sites list: only language, level, speed, tooltip and model reset', async () => {
    const h = createHarness();
    await h.call(
      update({ readingLevel: 'advanced', tooltipBehavior: 'on-demand', disabledSites: ['a.test'] }),
      options,
    );
    const reply = snapshotReply.parse(
      await h.call(SETTINGS_MESSAGES['RESET_PREFERENCES'], options),
    );
    expect(reply).toMatchObject({
      ok: true,
      data: { preferences: { ...DEFAULT_PREFERENCES, disabledSites: ['a.test'] } },
    });
    expect((await h.settingsStore.getPreferences()).disabledSites).toEqual(['a.test']);
  });

  it('restores the defaults, keeping onboarding state and the key', async () => {
    const h = createHarness();
    await h.call(KEY_MESSAGES['SET_API_KEY'], options);
    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options);
    await h.call(update({ explanationLanguage: 'fr', model: 'm' }), options);
    const reply = snapshotReply.parse(
      await h.call(SETTINGS_MESSAGES['RESET_PREFERENCES'], options),
    );
    expect(reply).toMatchObject({ ok: true, data: { preferences: DEFAULT_PREFERENCES } });
    if (reply.ok) expect(reply.data.onboarding.disclosureAcceptedAt).not.toBeNull();
    expect(h.local.data.has(STORAGE_KEYS.apiKey)).toBe(true);
    expect(h.siteAccess.reconcile).toHaveBeenCalled();
  });
});

describe('ACCEPT_DISCLOSURE and UPDATE_ONBOARDING', () => {
  it('records the disclosure time once', async () => {
    let clock = 5_000;
    const h = createHarness({ now: () => clock });
    const first = snapshotReply.parse(
      await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options),
    );
    clock = 9_000;
    const second = snapshotReply.parse(
      await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options),
    );
    expect(first).toMatchObject({ data: { onboarding: { disclosureAcceptedAt: 5_000 } } });
    expect(second).toMatchObject({ data: { onboarding: { disclosureAcceptedAt: 5_000 } } });
  });

  it('persists completion and the site-access choice so the user is never re-prompted', async () => {
    const h = createHarness();
    await h.call({ v: 1, type: 'UPDATE_ONBOARDING', siteAccessChoice: 'declined' }, options);
    const reply = snapshotReply.parse(
      await h.call({ v: 1, type: 'UPDATE_ONBOARDING', completed: true }, options),
    );
    expect(reply).toMatchObject({
      ok: true,
      data: { onboarding: { completed: true, siteAccessChoice: 'declined' } },
    });
    expect(await h.settingsStore.getOnboarding()).toMatchObject({ siteAccessChoice: 'declined' });
  });

  it.each([{ siteAccessChoice: 'maybe' }, { completed: 'yes' }, { disclosureAcceptedAt: 1 }])(
    'rejects %j',
    async (extra) => {
      const h = createHarness();
      expect(await h.call({ v: 1, type: 'UPDATE_ONBOARDING', ...extra }, options)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    },
  );
});

describe('GET_SITE_ACCESS_STATUS', () => {
  it('combines the live grant and registration with the persisted choice', async () => {
    const h = createHarness();
    const reply = messageReplySchema(siteAccessStatusSchema).parse(
      await h.call(SETTINGS_MESSAGES['GET_SITE_ACCESS_STATUS'], popupSender()),
    );
    expect(reply).toEqual({ ok: true, data: { granted: true, registered: true, choice: 'unset' } });
    await h.call({ v: 1, type: 'UPDATE_ONBOARDING', siteAccessChoice: 'granted' }, options);
    h.siteAccess.getStatus.mockResolvedValue({ granted: false, registered: false });
    expect(await h.call(SETTINGS_MESSAGES['GET_SITE_ACCESS_STATUS'], options)).toEqual({
      ok: true,
      data: { granted: false, registered: false, choice: 'granted' },
    });
  });
});

describe('CLEAR_ALL_DATA (FR-078)', () => {
  it('removes every Clavis record from both areas, aborts requests and resets limits', async () => {
    const h = createHarness();
    await h.call(KEY_MESSAGES['SET_API_KEY'], options);
    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options);
    await h.call(update({ explanationLanguage: 'fr' }), options);
    h.session.data.set(STORAGE_KEYS.apiKey, { v: 1, data: { key: 'x' } });
    h.local.data.set('clavis.some-future-cache', 1);
    const inflight = h.guard.inFlight.begin('tab:1', 'r1');
    h.guard.buckets.take('tab:1');

    const reply = messageReplySchema(clearAllDataResultSchema).parse(
      await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options),
    );
    expect(reply).toEqual({ ok: true, data: { cleared: true } });
    expect(h.local.keys()).toEqual([]);
    expect(h.session.keys()).toEqual([]);
    expect(inflight.signal.aborted).toBe(true);
    expect(h.guard.buckets.size).toBe(0);
    expect(await h.settingsStore.getSnapshot()).toEqual({
      preferences: DEFAULT_PREFERENCES,
      onboarding: DEFAULT_ONBOARDING,
    });
    // The registration is re-derived from the (now default) preferences.
    expect(h.siteAccess.reconcile).toHaveBeenCalled();
  });

  it('leaves unrelated storage alone and reports a storage failure', async () => {
    const h = createHarness();
    h.local.data.set('unrelated', 1);
    await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options);
    expect(h.local.keys()).toEqual(['unrelated']);
    h.local.failWith = new Error('x');
    expect(await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
  });

  it('is serialised with SET_API_KEY: a key written during the sweep lands AFTER it, never inside it (INFO-4)', async () => {
    const h = createHarness();
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const realGet = h.local.get.getMockImplementation()!;
    h.local.get.mockImplementation(async (keys) => {
      if (keys === null) {
        events.push('sweep-read');
        await gate; // hold the sweep between its read and its remove
      }
      return realGet(keys);
    });
    const realRemove = h.local.remove.getMockImplementation()!;
    h.local.remove.mockImplementation(async (keys) => {
      if (Array.isArray(keys) && keys.length > 2) events.push('sweep-remove');
      return realRemove(keys);
    });
    const realSet = h.local.set.getMockImplementation()!;
    h.local.set.mockImplementation(async (items) => {
      if ('clavis.api-key' in items) events.push('key-write');
      return realSet(items);
    });
    // Something for the sweep to remove (more than two keys, so it is recognisable above).
    await h.settingsStore.updatePreferences({ readingLevel: 'simple' });
    await h.settingsStore.acceptDisclosure();
    await h.keyStore.set(FAKE_KEY, 'local');
    events.length = 0;

    const cleared = h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options);
    await vi.waitFor(() => expect(events).toContain('sweep-read'));
    const set = h.call(KEY_MESSAGES['SET_API_KEY'], options);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(events).not.toContain('key-write'); // still queued behind the sweep
    release();
    await Promise.all([cleared, set]);
    expect(events.indexOf('sweep-remove')).toBeLessThan(events.indexOf('key-write'));
  });
});
