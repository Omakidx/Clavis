import { describe, expect, it, vi } from 'vitest';
import { OFFSCREEN_PAGE_PATH, SPEECH_TIMING } from '../../../lib/speech/constants';
import { createOffscreenHost, type OffscreenEnvironment } from '../../../lib/speech/offscreen-host';

const PAGE_URL = `chrome-extension://abc${OFFSCREEN_PAGE_PATH}`;

function makeEnv(over: Partial<OffscreenEnvironment> = {}) {
  let open = false;
  const env = {
    runtime: {
      getURL: (path: string) => `chrome-extension://abc${path}`,
      sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
      getContexts: vi.fn(() => Promise.resolve(open ? [{ documentUrl: PAGE_URL }] : [])),
    },
    offscreen: {
      createDocument: vi.fn(async () => {
        await Promise.resolve();
        open = true;
      }),
      closeDocument: vi.fn(() => {
        open = false;
        return Promise.resolve();
      }),
    },
    sleep: () => Promise.resolve(),
    ...over,
  } as OffscreenEnvironment & {
    runtime: {
      getContexts: ReturnType<typeof vi.fn>;
      sendMessage: ReturnType<typeof vi.fn>;
    };
    offscreen: { createDocument: ReturnType<typeof vi.fn> };
  };
  return env;
}

describe('createOffscreenHost: creation', () => {
  it('creates an AUDIO_PLAYBACK document with a justification', async () => {
    const env = makeEnv();
    await createOffscreenHost(env).ensureDocument();
    expect(env.offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: expect.stringMatching(/\S{5,}/),
    });
  });

  it('reuses an existing document instead of creating another', async () => {
    const env = makeEnv();
    const host = createOffscreenHost(env);
    await host.ensureDocument();
    await host.ensureDocument();
    expect(env.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('shares one creation between concurrent callers', async () => {
    const env = makeEnv();
    const host = createOffscreenHost(env);
    await Promise.all([host.ensureDocument(), host.ensureDocument(), host.ensureDocument()]);
    expect(env.offscreen.createDocument).toHaveBeenCalledTimes(1);
  });

  it('treats "only a single offscreen document" as success (lost a race)', async () => {
    const env = makeEnv();
    env.offscreen.createDocument.mockRejectedValueOnce(
      new Error('Only a single offscreen document may be created.'),
    );
    await expect(createOffscreenHost(env).ensureDocument()).resolves.toBeUndefined();
  });

  it('surfaces other creation errors and can retry afterwards', async () => {
    const env = makeEnv();
    env.offscreen.createDocument.mockRejectedValueOnce(new Error('permission denied'));
    const host = createOffscreenHost(env);
    await expect(host.ensureDocument()).rejects.toThrow('permission denied');
    await expect(host.ensureDocument()).resolves.toBeUndefined();
  });
});

describe('createOffscreenHost: existence check across Chrome versions', () => {
  it('uses runtime.getContexts (Chrome 116+) filtered to the offscreen page', async () => {
    const env = makeEnv();
    const host = createOffscreenHost(env);
    expect(await host.hasDocument()).toBe(false);
    expect(env.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [PAGE_URL],
    });
  });

  it('falls back to offscreen.hasDocument (Chrome 150+) when getContexts is missing', async () => {
    const env = makeEnv();
    Reflect.deleteProperty(env.runtime, 'getContexts');
    env.offscreen.hasDocument = vi.fn(() => Promise.resolve(true));
    expect(await createOffscreenHost(env).hasDocument()).toBe(true);
  });

  it('falls back to clients.matchAll (pre-116 documented approach)', async () => {
    const env = makeEnv();
    Reflect.deleteProperty(env.runtime, 'getContexts');
    env.matchClients = vi.fn(() => Promise.resolve([{ url: PAGE_URL }]));
    expect(await createOffscreenHost(env).hasDocument()).toBe(true);
    env.matchClients = vi.fn(() => Promise.resolve([{ url: 'chrome-extension://abc/other.html' }]));
    expect(await createOffscreenHost(env).hasDocument()).toBe(false);
  });

  it('with no detection API at all still creates, tolerating the single-document error', async () => {
    const env = makeEnv();
    Reflect.deleteProperty(env.runtime, 'getContexts');
    env.offscreen.createDocument.mockRejectedValueOnce(
      new Error('Only a single offscreen document may be created.'),
    );
    await expect(createOffscreenHost(env).ensureDocument()).resolves.toBeUndefined();
  });
});

describe('createOffscreenHost: close and send', () => {
  it('closes only when a document exists', async () => {
    const env = makeEnv();
    const host = createOffscreenHost(env);
    await host.closeDocument();
    expect(env.offscreen.closeDocument).not.toHaveBeenCalled();
    await host.ensureDocument();
    await host.closeDocument();
    expect(env.offscreen.closeDocument).toHaveBeenCalledTimes(1);
  });

  it('retries while the page has not registered its listener yet', async () => {
    const env = makeEnv();
    env.runtime.sendMessage
      .mockRejectedValueOnce(
        new Error('Could not establish connection. Receiving end does not exist.'),
      )
      .mockResolvedValueOnce({ ok: true });
    await expect(createOffscreenHost(env).send({ a: 1 })).resolves.toEqual({ ok: true });
    expect(env.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('gives up after bounded retries and does not retry unrelated errors', async () => {
    const env = makeEnv();
    env.runtime.sendMessage.mockRejectedValue(new Error('Receiving end does not exist.'));
    await expect(createOffscreenHost(env).send({})).rejects.toThrow('Receiving end');
    expect(env.runtime.sendMessage).toHaveBeenCalledTimes(SPEECH_TIMING.offscreenSendRetries + 1);

    env.runtime.sendMessage.mockReset();
    env.runtime.sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
    await expect(createOffscreenHost(env).send({})).rejects.toThrow('invalidated');
    expect(env.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
