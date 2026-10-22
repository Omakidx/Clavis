import { describe, expect, it, vi } from 'vitest';
import { PASSWORD_INCORRECT, PASSWORD_NEEDED, PasswordGate } from '../../../lib/pdf/password';

/** The PDF.js constants must stay in step with the values this module hard-codes. */
describe('password constants', () => {
  it('match pdfjs PasswordResponses', async () => {
    const { PasswordResponses } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    expect(PASSWORD_NEEDED).toBe(PasswordResponses.NEED_PASSWORD);
    expect(PASSWORD_INCORRECT).toBe(PasswordResponses.INCORRECT_PASSWORD);
  });
});

describe('PasswordGate (mocked PDF.js onPassword callback)', () => {
  it('prompts without the incorrect flag on the first request', () => {
    const onPrompt = vi.fn();
    const gate = new PasswordGate(onPrompt, vi.fn());
    gate.request(vi.fn(), PASSWORD_NEEDED);
    expect(onPrompt).toHaveBeenCalledWith({ incorrect: false });
    expect(gate.isPending).toBe(true);
  });

  it('flags a wrong password on the retry request', () => {
    const onPrompt = vi.fn();
    const gate = new PasswordGate(onPrompt, vi.fn());
    gate.request(vi.fn(), PASSWORD_NEEDED);
    gate.request(vi.fn(), PASSWORD_INCORRECT);
    expect(onPrompt).toHaveBeenLastCalledWith({ incorrect: true });
  });

  it('hands the typed password straight to PDF.js exactly once', () => {
    const updatePassword = vi.fn();
    const gate = new PasswordGate(vi.fn(), vi.fn());
    gate.request(updatePassword, PASSWORD_NEEDED);
    expect(gate.submit('hunter2')).toBe(true);
    expect(updatePassword).toHaveBeenCalledExactlyOnceWith('hunter2');
    expect(gate.isPending).toBe(false);
    // A second submit has nothing to answer: stale UI events cannot replay the password.
    expect(gate.submit('hunter2')).toBe(false);
    expect(updatePassword).toHaveBeenCalledTimes(1);
  });

  it('a new request replaces the previous callback', () => {
    const first = vi.fn();
    const second = vi.fn();
    const gate = new PasswordGate(vi.fn(), vi.fn());
    gate.request(first, PASSWORD_NEEDED);
    gate.request(second, PASSWORD_INCORRECT);
    gate.submit('pw');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('pw');
  });

  it('cancel notifies once and drops the callback', () => {
    const updatePassword = vi.fn();
    const onCancel = vi.fn();
    const gate = new PasswordGate(vi.fn(), onCancel);
    gate.request(updatePassword, PASSWORD_NEEDED);
    gate.cancel();
    gate.cancel();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(gate.submit('late')).toBe(false);
    expect(updatePassword).not.toHaveBeenCalled();
  });

  it('cancel without a pending request does nothing', () => {
    const onCancel = vi.fn();
    new PasswordGate(vi.fn(), onCancel).cancel();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('reset drops the callback silently (document replaced or closed)', () => {
    const onCancel = vi.fn();
    const gate = new PasswordGate(vi.fn(), onCancel);
    gate.request(vi.fn(), PASSWORD_NEEDED);
    gate.reset();
    expect(gate.isPending).toBe(false);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('never logs the password', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const gate = new PasswordGate(vi.fn(), vi.fn());
    gate.request(vi.fn(), PASSWORD_NEEDED);
    gate.submit('super-secret-value');
    for (const spy of spies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain('super-secret-value');
    }
  });
});
