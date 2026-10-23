import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend, interpretReply } from '../../../components/explanation/backend';
import { installCatalog, makeSnapshot, resultFor } from './support';

beforeEach(() => installCatalog());

const request = {
  requestId: '11111111-1111-4111-8111-111111111111',
  snapshot: makeSnapshot(),
  mode: 'core' as const,
  detailLevel: 'standard' as const,
};

describe('interpretReply', () => {
  it('reads a result', () => {
    const result = resultFor(request);
    expect(interpretReply({ ok: true, data: result })).toEqual({ kind: 'result', result });
  });
  it('treats no reply as NO_RESPONSE and junk as BAD_REPLY', () => {
    expect(interpretReply(undefined)).toEqual({ kind: 'error', code: 'NO_RESPONSE' });
    expect(interpretReply(null)).toEqual({ kind: 'error', code: 'NO_RESPONSE' });
    expect(interpretReply('x')).toEqual({ kind: 'error', code: 'BAD_REPLY' });
    expect(interpretReply({ ok: true, data: { nope: 1 } })).toEqual({
      kind: 'error',
      code: 'BAD_REPLY',
    });
    expect(interpretReply({ ok: false })).toEqual({ kind: 'error', code: 'BAD_REPLY' });
  });
  it('maps an error envelope and keeps retryAfterMs, never the provider message', () => {
    expect(
      interpretReply({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'gsk_secret', retryAfterMs: 4000 },
      }),
    ).toEqual({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 4000 });
    expect(interpretReply({ ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } })).toEqual({
      kind: 'error',
      code: 'INTERNAL_ERROR',
    });
  });
  it('keeps the "local-limit" reason of Clavis own throttle, for RATE_LIMITED only', () => {
    expect(
      interpretReply({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 3000, reason: 'local-limit' },
      }),
    ).toEqual({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 3000, reason: 'local-limit' });
    expect(
      interpretReply({
        ok: false,
        error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 3000 },
      }),
    ).toEqual({ kind: 'error', code: 'RATE_LIMITED', retryAfterMs: 3000 });
    expect(
      interpretReply({
        ok: false,
        error: { code: 'TIMEOUT', message: 'x', reason: 'local-limit' },
      }),
    ).toEqual({ kind: 'error', code: 'TIMEOUT' });
  });
  it('SETUP_REQUIRED with reason "disclosure" asks for the one-time confirmation', () => {
    expect(
      interpretReply({
        ok: false,
        error: { code: 'SETUP_REQUIRED', message: '', reason: 'disclosure' },
      }),
    ).toEqual({ kind: 'disclosure' });
  });
  it('accepts nothing but SETUP_REQUIRED with reason "disclosure" as the confirmation (contract only)', () => {
    for (const error of [
      { code: 'DISCLOSURE_REQUIRED', message: '' },
      { code: 'SETUP_REQUIRED', message: '', disclosureRequired: true },
      { code: 'SETUP_REQUIRED', message: '', reason: 'other' },
      { code: 'INVALID_API_KEY', message: '', reason: 'disclosure' },
    ]) {
      expect(interpretReply({ ok: false, error }).kind).toBe('error');
    }
    expect(
      interpretReply({
        ok: false,
        disclosureRequired: true,
        error: { code: 'SETUP_REQUIRED', message: '' },
      }),
    ).toEqual({ kind: 'error', code: 'SETUP_REQUIRED' });
  });
  it('plain SETUP_REQUIRED stays "connect Groq"', () => {
    expect(interpretReply({ ok: false, error: { code: 'SETUP_REQUIRED', message: '' } })).toEqual({
      kind: 'error',
      code: 'SETUP_REQUIRED',
    });
  });
});

describe('createBackend', () => {
  it('sends AI_EXPLAIN with the version and no acknowledgement by default', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, data: resultFor(request) });
    await createBackend(send).explain(request, false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toEqual({ v: 1, type: 'AI_EXPLAIN', payload: request });
  });
  it('adds acknowledgeDisclosure only when asked', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await createBackend(send).explain(request, true);
    expect(send.mock.calls[0]?.[0]).toEqual({
      v: 1,
      type: 'AI_EXPLAIN',
      payload: request,
      acknowledgeDisclosure: true,
    });
  });
  it('never retries a paid call, not even when nobody answers or the send throws', async () => {
    const silent = vi.fn().mockResolvedValue(undefined);
    expect(await createBackend(silent).explain(request, false)).toEqual({
      kind: 'error',
      code: 'NO_RESPONSE',
    });
    expect(silent).toHaveBeenCalledTimes(1);
    const throwing = vi.fn().mockRejectedValue(new Error('Receiving end does not exist'));
    expect(await createBackend(throwing).explain(request, false)).toEqual({
      kind: 'error',
      code: 'NO_RESPONSE',
    });
    expect(throwing).toHaveBeenCalledTimes(1);
  });
  it('sends AI_CANCEL, OPEN_SETTINGS and GET_PUBLIC_SETTINGS with the version', async () => {
    const send = vi
      .fn()
      .mockImplementation((message: { type: string }) =>
        Promise.resolve(
          message.type === 'GET_PUBLIC_SETTINGS'
            ? { ok: true, data: { explanationLanguage: 'fr' } }
            : { ok: true, data: { opened: true } },
        ),
      );
    const backend = createBackend(send);
    backend.cancel('abc');
    expect(await backend.openSettings('model')).toBe(true);
    expect(await backend.openSettings()).toBe(true);
    expect(await backend.explanationLanguage()).toBe('fr');
    expect(send.mock.calls.map((call) => call[0])).toEqual([
      { v: 1, type: 'AI_CANCEL', requestId: 'abc' },
      { v: 1, type: 'OPEN_SETTINGS', section: 'model' },
      { v: 1, type: 'OPEN_SETTINGS' },
      { v: 1, type: 'GET_PUBLIC_SETTINGS' },
    ]);
  });
  it('reports a failed OPEN_SETTINGS as false', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'INVALID_REQUEST', message: '' } });
    expect(await createBackend(send).openSettings('key')).toBe(false);
  });
});
