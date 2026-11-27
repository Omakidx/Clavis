import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_MESSAGES,
  RUNTIME_ID,
  contentSender,
  createHarness,
  pageSender,
  panelSender,
  popupSender,
} from './harness';

const h = createHarness();

describe('account routes', () => {
  it('ACCOUNT_GET_STATUS answers an extension page with the status and no token', async () => {
    const reply = (await h.call(
      ACCOUNT_MESSAGES['ACCOUNT_GET_STATUS'],
      pageSender('/options.html'),
    )) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(reply.ok).toBe(true);
    expect(reply.data).toMatchObject({ signedIn: false, sync: { state: 'idle', pending: 0 } });
    expect(JSON.stringify(reply)).not.toMatch(/[Tt]oken/);
  });

  it('ACCOUNT_SIGN_IN from the popup runs the sign-in once and replies ok', async () => {
    const reply = await h.call(ACCOUNT_MESSAGES['ACCOUNT_SIGN_IN'], popupSender());
    expect(reply).toMatchObject({ ok: true });
    expect(h.accountService.signIn).toHaveBeenCalledTimes(1);
  });

  it('a failed sign-in becomes an error envelope with the code only', async () => {
    h.accountService.signIn.mockResolvedValueOnce({ ok: false, code: 'CANCELLED' } as never);
    const reply = (await h.call(ACCOUNT_MESSAGES['ACCOUNT_SIGN_IN'], popupSender())) as {
      ok: boolean;
      error: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('CANCELLED');
  });

  it('ACCOUNT_SIGN_OUT passes keepLocalCopy and requires it to be a boolean', async () => {
    await h.call(
      { v: 1, type: 'ACCOUNT_SIGN_OUT', keepLocalCopy: true },
      pageSender('/options.html'),
    );
    expect(h.accountService.signOut).toHaveBeenLastCalledWith(true);
    for (const bad of [
      { v: 1, type: 'ACCOUNT_SIGN_OUT' },
      { v: 1, type: 'ACCOUNT_SIGN_OUT', keepLocalCopy: 'yes' },
      { v: 1, type: 'ACCOUNT_SIGN_OUT', keepLocalCopy: true, extra: 1 },
    ]) {
      expect(await h.call(bad, pageSender('/options.html'))).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
  });

  it('refuses every route to the wrong sender with INVALID_REQUEST and runs nothing', async () => {
    const before = h.accountService.signIn.mock.calls.length;
    for (const sender of [contentSender(), panelSender(5), pageSender('/reader.html')]) {
      expect(await h.call(ACCOUNT_MESSAGES['ACCOUNT_SIGN_IN'], sender)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    expect(
      await h.call(ACCOUNT_MESSAGES['ACCOUNT_SIGN_OUT_EVERYWHERE'], pageSender('/library.html')),
    ).toMatchObject({ ok: false });
    expect(await h.call(ACCOUNT_MESSAGES['SYNC_NOW'], pageSender('/reader.html'))).toMatchObject({
      ok: false,
    });
    expect(h.accountService.signIn.mock.calls.length).toBe(before);
    void RUNTIME_ID;
  });

  it('SYNC_NOW maps the run result', async () => {
    expect(await h.call(ACCOUNT_MESSAGES['SYNC_NOW'], popupSender())).toMatchObject({ ok: true });
    h.syncEngine.syncNow.mockResolvedValueOnce({ status: 'error', code: 'NETWORK' } as never);
    expect(await h.call(ACCOUNT_MESSAGES['SYNC_NOW'], popupSender())).toMatchObject({
      ok: false,
      error: { code: 'NETWORK_ERROR' },
    });
    h.syncEngine.syncNow.mockResolvedValueOnce({ status: 'signed-out' } as never);
    expect(await h.call(ACCOUNT_MESSAGES['SYNC_NOW'], popupSender())).toMatchObject({
      ok: false,
      error: { code: 'NOT_SIGNED_IN' },
    });
  });

  it('SYNC_KICK from a page is accepted (reader, library, options), from a content script it is not', async () => {
    expect(await h.call({ v: 1, type: 'SYNC_KICK' }, pageSender('/reader.html'))).toMatchObject({
      ok: true,
    });
    expect(await h.call({ v: 1, type: 'SYNC_KICK' }, contentSender())).toMatchObject({ ok: false });
  });
});
