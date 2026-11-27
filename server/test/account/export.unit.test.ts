import { describe, expect, it, vi } from 'vitest';
import { withDeadline } from '../../src/account/export';

describe('withDeadline', () => {
  it('rejects when the deadline wins and hands the late value to onLate (so a stream can be cancelled)', async () => {
    const late = vi.fn();
    let resolve!: (v: string) => void;
    const slow = new Promise<string>((r) => (resolve = r));
    await expect(withDeadline(slow, 20, late)).rejects.toThrow('deadline');
    expect(late).not.toHaveBeenCalled();
    resolve('stream');
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith('stream'));
  });

  it('does not call onLate when the value arrives in time, and swallows a late rejection', async () => {
    const late = vi.fn();
    expect(await withDeadline(Promise.resolve(1), 1000, late)).toBe(1);
    expect(late).not.toHaveBeenCalled();
    let reject!: (e: Error) => void;
    const p = new Promise<number>((_, r) => (reject = r));
    await expect(withDeadline(p, 10, late)).rejects.toThrow('deadline');
    reject(new Error('later')); // must not surface as an unhandled rejection
    await new Promise((r) => setTimeout(r, 20));
    expect(late).not.toHaveBeenCalled();
  });
});
