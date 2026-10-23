import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ERROR_CODES, type ErrorCode } from '../../../lib/contracts';
import { describeError } from '../../../lib/ui-client/errors';
import { browser } from 'wxt/browser';
import { api } from '../../../lib/ui-client/api';
import { request, type RequestDeps } from '../../../lib/ui-client/request';
import { installCatalog } from './support';

beforeEach(() => installCatalog());

const dataSchema = z.strictObject({ n: z.number() });

function deps(replies: unknown[]): RequestDeps & { sent: unknown[]; waits: number[] } {
  const queue = [...replies];
  const sent: unknown[] = [];
  const waits: number[] = [];
  return {
    sent,
    waits,
    retryDelayMs: 25,
    send: (message) => {
      sent.push(message);
      const next = queue.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

describe('request', () => {
  it('adds the protocol version and returns validated data', async () => {
    const d = deps([{ ok: true, data: { n: 3 } }]);
    const result = await request({ type: 'GET_SETTINGS' }, dataSchema, d);
    expect(result).toEqual({ ok: true, data: { n: 3 } });
    expect(d.sent).toEqual([{ v: 1, type: 'GET_SETTINGS' }]);
  });

  it('rejects a reply whose data does not match the schema instead of trusting it', async () => {
    const result = await request(
      { type: 'GET_SETTINGS' },
      dataSchema,
      deps([{ ok: true, data: { n: 'three' } }]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('BAD_REPLY');
  });

  it('rejects extra fields in the data (strict contracts)', async () => {
    const result = await request(
      { type: 'GET_SETTINGS' },
      dataSchema,
      deps([{ ok: true, data: { n: 1, apiKey: 'gsk_TESTleak' } }]),
    );
    expect(result.ok).toBe(false);
  });

  it('retries once when nobody answers (service worker restarting) and then succeeds', async () => {
    const d = deps([undefined, { ok: true, data: { n: 1 } }]);
    const result = await request({ type: 'GET_SETTINGS' }, dataSchema, d);
    expect(result).toEqual({ ok: true, data: { n: 1 } });
    expect(d.sent).toHaveLength(2);
    expect(d.waits).toEqual([25]);
  });

  it('treats a thrown "receiving end does not exist" like a missing reply', async () => {
    const d = deps([
      new Error('Could not establish connection. Receiving end does not exist.'),
      { ok: true, data: { n: 2 } },
    ]);
    expect(await request({ type: 'GET_SETTINGS' }, dataSchema, d)).toEqual({
      ok: true,
      data: { n: 2 },
    });
  });

  it('gives a clear retryable error after the single retry is also unanswered', async () => {
    const d = deps([undefined, undefined, { ok: true, data: { n: 9 } }]);
    const result = await request({ type: 'GET_SETTINGS' }, dataSchema, d);
    expect(d.sent).toHaveLength(2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_RESPONSE');
      expect(result.error.action).toBe('retry');
      expect(result.error.message).toMatch(/isn't responding/);
    }
  });

  it('does not retry a real error reply', async () => {
    const d = deps([{ ok: false, error: { code: 'INVALID_API_KEY', message: 'x' } }]);
    const result = await request({ type: 'TEST_API_KEY' }, dataSchema, d);
    expect(d.sent).toHaveLength(1);
    expect(result.ok).toBe(false);
  });

  it('never logs the message it sends (it may carry an API key)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    await request(
      { type: 'SET_API_KEY', apiKey: 'gsk_TESTsecretvalue', storage: 'local' },
      dataSchema,
      deps([undefined, undefined]),
    );
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('retry: false (paid or non-idempotent routes)', () => {
  it('sends once and reports NO_RESPONSE when nobody answers', async () => {
    const d = deps([undefined, { ok: true, data: { n: 1 } }]);
    const result = await request({ type: 'AI_EXPLAIN' }, dataSchema, d, { retry: false });
    expect(d.sent).toHaveLength(1);
    expect(d.waits).toEqual([]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_RESPONSE');
      expect(result.error.action).toBe('retry');
    }
  });

  it('api.explain never sends a second paid request when the reply is missing', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    const result = await api.explain({
      requestId: '2d8a3a8e-0c1b-4d63-a1de-0f6a9f6f3a11',
      snapshot: {
        selectionId: '3d8a3a8e-0c1b-4d63-a1de-0f6a9f6f3a11',
        source: 'webpage',
        kind: 'word',
        text: 'bank',
      },
      mode: 'core',
      detailLevel: 'standard',
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_RESPONSE');
  });

  it('keeps the single retry for reads', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await api.getSettings();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('error mapping', () => {
  const RAW = 'raw provider text: Invalid API Key gsk_TESTleak';

  it('maps every error code to localized text and never shows the envelope message', async () => {
    for (const code of ERROR_CODES) {
      const result = await request(
        { type: 'X' },
        dataSchema,
        deps([{ ok: false, error: { code, message: RAW } }]),
      );
      expect(result.ok, code).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe(code);
      expect(result.error.message, code).not.toBe('');
      expect(result.error.message, code).not.toContain('⟦');
      expect(result.error.message, code).not.toContain('raw provider text');
      expect(result.error.message, code).not.toContain('gsk_');
    }
  });

  it.each<[ErrorCode, string]>([
    ['INVALID_API_KEY', 'update-key'],
    ['SETUP_REQUIRED', 'connect'],
    ['NETWORK_ERROR', 'retry'],
    ['TIMEOUT', 'retry'],
    ['RATE_LIMITED', 'retry'],
    ['MODEL_UNAVAILABLE', 'open-settings'],
    ['STORAGE_UNAVAILABLE', 'retry'],
    ['INVALID_REQUEST', 'none'],
  ])('%s offers the "%s" action', (code, action) => {
    expect(describeError(code).action).toBe(action);
  });

  it('turns a retry delay into seconds for rate limits', () => {
    expect(describeError('RATE_LIMITED', 2500).message).toContain('3 seconds');
    expect(describeError('RATE_LIMITED').message).not.toContain('seconds');
  });

  it("words Clavis's own throttle as Clavis's, and Groq's 429 as Groq's", () => {
    const own = describeError('RATE_LIMITED', 2500, 'local-limit');
    expect(own.message).toBe('Too many requests from Clavis. Try again in about 3 seconds.');
    expect(describeError('RATE_LIMITED', undefined, 'local-limit').message).toMatch(
      /^Too many requests from Clavis\./,
    );
    expect(own.message).not.toContain('Groq');
    expect(describeError('RATE_LIMITED', 2500).message).toContain("Groq's rate limit");
    expect(describeError('RATE_LIMITED').message).toContain("Groq's rate limit");
  });

  it('413 has its own message: the selection was too long, not a connection problem', () => {
    expect(describeError('SELECTION_TOO_LONG').message).toContain('too long');
    expect(describeError('SELECTION_TOO_LONG').message).not.toContain('connection');
  });
});
