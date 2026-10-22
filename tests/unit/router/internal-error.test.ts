import { describe, expect, it, vi } from 'vitest';
import { replyForThrown } from '../../../lib/router/router';
import { StorageUnavailableError } from '../../../lib/storage/errors';

describe('replyForThrown', () => {
  it('maps an unexpected failure to INTERNAL_ERROR without echoing the error text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = replyForThrown(new Error('gsk_TEST_must_not_leak_0123456789'));
    expect(reply).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(reply)).not.toContain('gsk_TEST');
  });

  it('keeps STORAGE_UNAVAILABLE for a failed storage lockdown', () => {
    expect(replyForThrown(new StorageUnavailableError())).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
  });
});
