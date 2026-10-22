import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KeyStatus } from '../../../lib/contracts';
import { describeError } from '../../../lib/ui-client/errors';
import {
  checkKeyInput,
  classifyKeyResult,
  connectKey,
  looksLikeGroqKey,
} from '../../../lib/ui-client/key-flow';
import { installCatalog } from './support';

beforeEach(() => installCatalog());

const status = (patch: Partial<KeyStatus> = {}): KeyStatus => ({
  hasKey: true,
  storage: 'local',
  last4: '1234',
  verification: 'valid',
  verifiedAt: 1,
  models: [],
  ...patch,
});

describe('checkKeyInput', () => {
  it('trims and accepts a normal key', () => {
    expect(checkKeyInput('  gsk_TEST1234  ')).toEqual({ ok: true, value: 'gsk_TEST1234' });
  });
  it('rejects empty, whitespace inside, control characters and over-long text', () => {
    expect(checkKeyInput('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkKeyInput('gsk_TEST 1234')).toEqual({ ok: false, reason: 'format' });
    expect(checkKeyInput('gsk_TEST\n1234')).toEqual({ ok: false, reason: 'format' });
    expect(checkKeyInput('gsk_TEST\u0007')).toEqual({ ok: false, reason: 'format' });
    expect(checkKeyInput('g'.repeat(513))).toEqual({ ok: false, reason: 'format' });
  });
  it('only hints, never blocks, on a missing gsk_ prefix', () => {
    expect(looksLikeGroqKey('gsk_TEST1')).toBe(true);
    expect(looksLikeGroqKey('sk-other')).toBe(false);
    expect(checkKeyInput('sk-other').ok).toBe(true);
  });
});

describe('classifyKeyResult', () => {
  it('keeps valid, invalid, unverified and unchecked apart', () => {
    expect(classifyKeyResult({ ok: true, data: status() }).kind).toBe('valid');
    expect(classifyKeyResult({ ok: true, data: status({ verification: 'invalid' }) }).kind).toBe(
      'invalid',
    );
    expect(classifyKeyResult({ ok: true, data: status({ verification: 'unverified' }) }).kind).toBe(
      'unverified',
    );
    expect(classifyKeyResult({ ok: true, data: status({ verification: 'never' }) }).kind).toBe(
      'unchecked',
    );
  });
  it('maps check failures reported as error codes onto the same distinctions', () => {
    const fail = (code: Parameters<typeof describeError>[0]) => ({
      ok: false as const,
      error: describeError(code),
    });
    expect(classifyKeyResult(fail('INVALID_API_KEY')).kind).toBe('invalid');
    expect(classifyKeyResult(fail('NETWORK_ERROR')).kind).toBe('unverified');
    expect(classifyKeyResult(fail('TIMEOUT')).kind).toBe('unverified');
    expect(classifyKeyResult(fail('STORAGE_UNAVAILABLE')).kind).toBe('error');
  });
});

describe('connectKey', () => {
  it('saves, then tests when the save did not verify', async () => {
    const setApiKey = vi.fn(() =>
      Promise.resolve({ ok: true as const, data: status({ verification: 'never' }) }),
    );
    const testApiKey = vi.fn(() => Promise.resolve({ ok: true as const, data: status() }));
    const outcome = await connectKey('gsk_TEST1234', 'session', { setApiKey, testApiKey });
    expect(setApiKey).toHaveBeenCalledWith('gsk_TEST1234', 'session');
    expect(testApiKey).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('valid');
  });
  it('does not test again when the save already verified the key', async () => {
    const setApiKey = vi.fn(() => Promise.resolve({ ok: true as const, data: status() }));
    const testApiKey = vi.fn();
    await connectKey('gsk_TEST1234', 'local', { setApiKey, testApiKey } as never);
    expect(testApiKey).not.toHaveBeenCalled();
  });
  it('stops at a failed save', async () => {
    const setApiKey = vi.fn(() =>
      Promise.resolve({ ok: false as const, error: describeError('STORAGE_UNAVAILABLE') }),
    );
    const testApiKey = vi.fn();
    const outcome = await connectKey('gsk_TEST1234', 'local', { setApiKey, testApiKey } as never);
    expect(outcome.kind).toBe('error');
    expect(testApiKey).not.toHaveBeenCalled();
  });
});
