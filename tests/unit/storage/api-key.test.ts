import { describe, expect, it } from 'vitest';
import {
  KEY_RECORD_KEYS,
  NO_KEY_STATUS,
  STORAGE_KEYS,
  StorageUnavailableError,
  clearClavisStorage,
  createApiKeyStore,
  wrapRecord,
} from '../../../lib/storage';
import { MemoryArea } from './memory-area';

const KEY = 'gsk_TESTabcdefghijklmnopqrstuvwx1234';
const OTHER_KEY = 'gsk_TESTzzzzzzzzzzzzzzzzzzzzzzzzz9876';

function setup(lockedDown = true) {
  const local = new MemoryArea();
  const session = new MemoryArea();
  const state = { lockedDown };
  const store = createApiKeyStore({
    local,
    session,
    lockedDown: () => Promise.resolve(state.lockedDown),
  });
  return { local, session, state, store };
}

describe('api key store', () => {
  it('stores a persistent key in storage.local only, with metadata beside it', async () => {
    const { local, session, store } = setup();
    const status = await store.set(KEY, 'local');
    expect(status).toEqual({
      hasKey: true,
      storage: 'local',
      last4: '1234',
      verification: 'never',
      verifiedAt: null,
      models: [],
    });
    expect(local.keys()).toEqual([...KEY_RECORD_KEYS].sort());
    expect(session.keys()).toEqual([]);
  });

  it('stores a session-only key in storage.session only: nothing about it reaches local', async () => {
    const { local, session, store } = setup();
    await store.set(KEY, 'session');
    expect(session.keys()).toEqual([...KEY_RECORD_KEYS].sort());
    expect(local.keys()).toEqual([]);
    expect(JSON.stringify([...local.data])).not.toContain('1234');
  });

  it('never holds the key in both areas: setting one clears the other first', async () => {
    const { local, session, store } = setup();
    await store.set(KEY, 'local');
    await store.set(OTHER_KEY, 'session');
    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual([...KEY_RECORD_KEYS].sort());
    await store.set(KEY, 'local');
    expect(session.keys()).toEqual([]);
    expect((await store.read())?.apiKey).toBe(KEY);
  });

  it('keeps the secret out of metadata, storage key names and the status object', async () => {
    const { local, store } = setup();
    const status = await store.set(KEY, 'local');
    expect(JSON.stringify(status)).not.toContain(KEY);
    expect(JSON.stringify(local.data.get(STORAGE_KEYS.keyMeta))).not.toContain(KEY);
    for (const name of local.keys()) expect(name).not.toContain('gsk');
    expect(JSON.stringify(await store.getStatus())).not.toContain(KEY);
  });

  it('hides the last four characters of a short key (they would reveal most of it)', async () => {
    const { store } = setup();
    expect((await store.set('gsk_TESTshort', 'local')).last4).toBe('hort');
    expect((await store.set('shortkey', 'local')).last4).toBeNull();
  });

  it('reports no key when nothing is stored', async () => {
    const { store } = setup();
    expect(await store.read()).toBeUndefined();
    expect(await store.getStatus()).toEqual(NO_KEY_STATUS);
  });

  it('treats a corrupt key record as no key, and rebuilds missing metadata from the key', async () => {
    const { local, store } = setup();
    local.data.set(STORAGE_KEYS.apiKey, { v: 1, data: { key: 5 } });
    expect(await store.read()).toBeUndefined();
    local.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: KEY }));
    local.data.set(STORAGE_KEYS.keyMeta, 'garbage');
    expect(await store.getStatus()).toMatchObject({
      hasKey: true,
      storage: 'local',
      last4: '1234',
      verification: 'never',
    });
  });

  it('trusts the area, not the metadata, for where the key lives', async () => {
    const { local, store } = setup();
    await store.set(KEY, 'local');
    const meta = local.data.get(STORAGE_KEYS.keyMeta) as { data: { storage: string } };
    meta.data.storage = 'session';
    expect((await store.getStatus()).storage).toBe('local');
  });

  describe('fails closed (secret boundary rule 1)', () => {
    it('refuses to read, write or report while the lockdown has not succeeded', async () => {
      const { local, session, store } = setup(false);
      await expect(store.read()).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(store.getStatus()).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(store.set(KEY, 'local')).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(
        store.recordVerification(KEY, { verification: 'invalid' }),
      ).rejects.toBeInstanceOf(StorageUnavailableError);
      // Nothing was touched: not even a read.
      for (const area of [local, session]) {
        expect(area.get).not.toHaveBeenCalled();
        expect(area.set).not.toHaveBeenCalled();
      }
    });

    it('treats a rejecting lockdown promise like a failed lockdown', async () => {
      const store = createApiKeyStore({
        local: new MemoryArea(),
        session: new MemoryArea(),
        lockedDown: () => Promise.reject(new Error('boom')),
      });
      await expect(store.read()).rejects.toBeInstanceOf(StorageUnavailableError);
    });

    it('still lets the user delete the key when the lockdown failed (deleting exposes nothing)', async () => {
      const { local, session, state, store } = setup(true);
      await store.set(KEY, 'local');
      state.lockedDown = false;
      await store.remove();
      expect(local.keys()).toEqual([]);
      expect(session.keys()).toEqual([]);
    });

    it('maps a failing storage area to STORAGE_UNAVAILABLE', async () => {
      const { local, store } = setup();
      local.failWith = new Error('disk');
      await expect(store.read()).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(store.set(KEY, 'local')).rejects.toBeInstanceOf(StorageUnavailableError);
      await expect(store.remove()).rejects.toBeInstanceOf(StorageUnavailableError);
    });
  });

  describe('verification metadata (FR-004, FR-072)', () => {
    const models = [{ id: 'openai/gpt-oss-20b', supportsJsonSchema: true }];

    it('records a valid check with its models and time', async () => {
      const { store } = setup();
      await store.set(KEY, 'local');
      expect(
        await store.recordVerification(KEY, { verification: 'valid', models, at: 5 }),
      ).toMatchObject({
        verification: 'valid',
        verifiedAt: 5,
        models,
      });
      expect(await store.getStatus()).toMatchObject({ verification: 'valid', models });
    });

    it('an invalid result clears the verified state and models but keeps the key', async () => {
      const { store } = setup();
      await store.set(KEY, 'session');
      await store.recordVerification(KEY, { verification: 'valid', models, at: 5 });
      const status = await store.recordVerification(KEY, { verification: 'invalid' });
      expect(status).toMatchObject({
        hasKey: true,
        storage: 'session',
        last4: '1234',
        verification: 'invalid',
        verifiedAt: null,
        models: [],
      });
    });

    it('an unverified (network) result keeps the last known models and time', async () => {
      const { store } = setup();
      await store.set(KEY, 'local');
      await store.recordVerification(KEY, { verification: 'valid', models, at: 5 });
      expect(await store.recordVerification(KEY, { verification: 'unverified' })).toMatchObject({
        verification: 'unverified',
        verifiedAt: 5,
        models,
      });
    });

    it('ignores a result for a key that was replaced or removed meanwhile', async () => {
      const { store } = setup();
      await store.set(KEY, 'local');
      await store.set(OTHER_KEY, 'local');
      expect(await store.recordVerification(KEY, { verification: 'invalid' })).toBeUndefined();
      expect((await store.getStatus()).verification).toBe('never');
      await store.remove();
      expect(
        await store.recordVerification(OTHER_KEY, { verification: 'invalid' }),
      ).toBeUndefined();
      expect(await store.getStatus()).toEqual(NO_KEY_STATUS);
    });
  });

  it('remove clears the key and its metadata from BOTH areas', async () => {
    const { local, session, store } = setup();
    await store.set(KEY, 'local');
    session.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: OTHER_KEY }));
    session.data.set(STORAGE_KEYS.keyMeta, wrapRecord({}));
    await store.remove();
    expect(local.keys()).toEqual([]);
    expect(session.keys()).toEqual([]);
    expect(await store.read()).toBeUndefined();
  });

  it('prefers the more restrictive area if corruption left a key in both', async () => {
    const { local, session, store } = setup();
    local.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: KEY }));
    session.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: OTHER_KEY }));
    const stored = await store.read();
    expect(stored?.apiKey).toBe(OTHER_KEY);
    expect(stored?.storage).toBe('session');
  });
});

describe('clearClavisStorage (FR-078)', () => {
  it('removes every clavis.* record from both areas and nothing else', async () => {
    const local = new MemoryArea();
    const session = new MemoryArea();
    local.data.set(STORAGE_KEYS.preferences, wrapRecord({}));
    local.data.set(STORAGE_KEYS.onboarding, wrapRecord({}));
    local.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: KEY }));
    local.data.set('clavis.future-cache', 1);
    local.data.set('unrelated', 1);
    session.data.set(STORAGE_KEYS.apiKey, wrapRecord({ key: KEY }));
    await clearClavisStorage([local, session]);
    expect(local.keys()).toEqual(['unrelated']);
    expect(session.keys()).toEqual([]);
  });

  it('reports STORAGE_UNAVAILABLE when an area fails', async () => {
    const broken = new MemoryArea();
    broken.failWith = new Error('x');
    await expect(clearClavisStorage([broken])).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});
