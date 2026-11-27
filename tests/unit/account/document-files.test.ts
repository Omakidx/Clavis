import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createApiClient } from '../../../lib/account/api';
import { createTokenClient, type TokenStore } from '../../../lib/account/tokens';

const ORIGIN = 'https://api.example.test';
const MAX = 1024;

function streamOf(chunks: Uint8Array[], cancelled: { value: boolean }): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      cancelled.value = true;
    },
  });
}

const api = (fetchFn: typeof fetch) => createApiClient({ origin: ORIGIN, fetch: fetchFn });

describe('ApiClient.requestBlob (download bounded at maxBytes)', () => {
  it('returns the bytes as a PDF blob and sends the bearer token without cookies', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(new Uint8Array([37, 80, 68, 70]), { status: 200 })),
    );
    const blob = await api(fetchFn as never).requestBlob({
      method: 'GET',
      path: '/v1/documents/x/file',
      token: 'T',
      maxBytes: MAX,
    });
    expect(blob.size).toBe(4);
    expect(blob.type).toBe('application/pdf');
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer T');
  });

  it('aborts a stream that grows past the limit (no Content-Length to trust)', async () => {
    const cancelled = { value: false };
    const chunks = [new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)];
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response(streamOf(chunks, cancelled), { status: 200 })),
    );
    await expect(
      api(fetchFn as never).requestBlob({ method: 'GET', path: '/f', maxBytes: MAX }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    expect(cancelled.value).toBe(true);
  });

  it('refuses at once when Content-Length already exceeds the limit', async () => {
    const response = new Response(new Uint8Array(10), {
      status: 200,
      headers: { 'Content-Length': String(MAX + 1) },
    });
    await expect(
      api((() => Promise.resolve(response)) as never).requestBlob({
        method: 'GET',
        path: '/f',
        maxBytes: MAX,
      }),
    ).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('maps an error envelope and a bare 404 to codes', async () => {
    const envelope = new Response(
      JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'x', retryAfterMs: 5000 } }),
      { status: 503 },
    );
    await expect(
      api((() => Promise.resolve(envelope)) as never).requestBlob({
        method: 'GET',
        path: '/f',
        maxBytes: MAX,
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE', retryAfterMs: 5000 });
    await expect(
      api((() => Promise.resolve(new Response('', { status: 404 }))) as never).requestBlob({
        method: 'GET',
        path: '/f',
        maxBytes: MAX,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('uploads and the token client', () => {
  it('request sends a blob body with its content type and not as JSON', async () => {
    const fetchFn = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    const blob = new Blob(['%PDF-'], { type: 'application/pdf' });
    await api(fetchFn as never).request({ method: 'PUT', path: '/f', blob, token: 'T' });
    const init = (fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');
  });

  it('requestBlob refreshes once on a 401 and repeats with the new token', async () => {
    const used: string[] = [];
    const client = {
      origin: ORIGIN,
      request: vi.fn(),
      requestBlob: vi.fn((spec: { token?: string }) => {
        used.push(spec.token ?? '');
        return used.length === 1
          ? Promise.reject(new ApiRequestError('TOKEN_EXPIRED', 401))
          : Promise.resolve(new Blob(['ok']));
      }),
    };
    const store: TokenStore = {
      readSession: () =>
        Promise.resolve({
          refreshToken: 'crt_x',
          refreshExpiresAt: 0,
          userId: 'u',
          email: 'e',
          displayName: null,
        }),
      readAccess: () => Promise.resolve({ accessToken: 'old', expiresAt: Date.now() + 3_600_000 }),
      writePair: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    };
    client.request.mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'crt_y',
      accessTokenExpiresAt: 1,
      refreshTokenExpiresAt: 1,
      user: { id: 'u', email: 'e', displayName: null },
    });
    const tokens = createTokenClient({
      store,
      api: client as never,
      onSessionLost: async () => undefined,
    });
    const blob = await tokens.requestBlob({ method: 'GET', path: '/f', maxBytes: MAX });
    expect(blob.size).toBe(2);
    expect(used).toEqual(['old', 'new']);
  });
});
