import { LIMITS } from '../config/constants';
import type { KeyStorage } from '../contracts/key-storage';
import type { KeyStatus } from '../contracts/setup';
import { api, type Api } from './api';
import type { ClientError } from './errors';
import type { ClientResult } from './request';

/** Client-side shape check so an obviously wrong paste never leaves the page. */
export type KeyInputCheck = { ok: true; value: string } | { ok: false; reason: 'empty' | 'format' };

// eslint-disable-next-line no-control-regex -- the point is to reject control characters
const FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

/** Mirrors the background's `apiKeySchema` (trimmed, no whitespace or control characters, bounded). */
export function checkKeyInput(raw: string): KeyInputCheck {
  const value = raw.trim();
  if (value === '') return { ok: false, reason: 'empty' };
  if (value.length > LIMITS.maxApiKeyChars || FORBIDDEN.test(value)) {
    return { ok: false, reason: 'format' };
  }
  return { ok: true, value };
}

/** Soft hint only: Groq keys start with `gsk_`, but the format is not a promise. */
export function looksLikeGroqKey(value: string): boolean {
  return value.trim().startsWith('gsk_');
}

/**
 * What a key action means for the user, with the three states the spec requires kept apart:
 * `valid`, `invalid` (Groq said no) and `unverified` (Clavis could not reach Groq, so nothing is
 * known). `unchecked` = saved but not tested yet. `error` = the action itself failed.
 */
export type KeyOutcome =
  | { kind: 'valid' | 'invalid' | 'unverified' | 'unchecked'; status: KeyStatus | null }
  | { kind: 'error'; error: ClientError };

export function classifyKeyResult(result: ClientResult<KeyStatus>): KeyOutcome {
  if (result.ok) {
    switch (result.data.verification) {
      case 'valid':
        return { kind: 'valid', status: result.data };
      case 'invalid':
        return { kind: 'invalid', status: result.data };
      case 'unverified':
        return { kind: 'unverified', status: result.data };
      case 'never':
        return { kind: 'unchecked', status: result.data };
    }
  }
  const { error } = result;
  // The background may report a failed check as an error code instead of a status; either way
  // the distinction between "Groq refused" and "could not reach Groq" must survive.
  if (error.code === 'INVALID_API_KEY') return { kind: 'invalid', status: null };
  if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') {
    return { kind: 'unverified', status: null };
  }
  return { kind: 'error', error };
}

type KeyApi = Pick<Api, 'setApiKey' | 'testApiKey'>;

/**
 * Save the key, then check it with Groq if the save did not already do so. The key is passed
 * straight through and not retained here.
 */
export async function connectKey(
  apiKey: string,
  storage: KeyStorage,
  client: KeyApi = api,
): Promise<KeyOutcome> {
  const saved = await client.setApiKey(apiKey, storage);
  const first = classifyKeyResult(saved);
  if (first.kind !== 'unchecked') return first;
  return classifyKeyResult(await client.testApiKey());
}

export async function testKey(client: Pick<Api, 'testApiKey'> = api): Promise<KeyOutcome> {
  return classifyKeyResult(await client.testApiKey());
}
