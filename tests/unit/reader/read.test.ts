// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { readFileBytes } from '../../../lib/pdf/read';

const blobOf = (size: number): Blob => new Blob([new Uint8Array(size).fill(7)]);

/** A Blob whose stream yields `chunk` bytes at a time. */
function chunked(size: number, chunk: number): Blob {
  const blob = blobOf(size);
  return Object.assign(blob, {
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < size; i += chunk) {
            controller.enqueue(new Uint8Array(Math.min(chunk, size - i)).fill(7));
          }
          controller.close();
        },
      }),
  });
}

describe('readFileBytes', () => {
  it('reads every byte into one buffer and reports monotonic progress up to the total', async () => {
    const onProgress = vi.fn();
    const bytes = await readFileBytes(chunked(10_000, 1500), { onProgress });
    expect(bytes).toHaveLength(10_000);
    expect(bytes!.every((b) => b === 7)).toBe(true);
    const loaded = onProgress.mock.calls.map(([p]) => p.loaded as number);
    expect(loaded).toEqual([1500, 3000, 4500, 6000, 7500, 9000, 10_000]);
    expect(onProgress.mock.calls.every(([p]) => p.total === 10_000)).toBe(true);
  });

  it('stops and returns null once cancelled', async () => {
    let calls = 0;
    const bytes = await readFileBytes(chunked(10_000, 1000), {
      isCancelled: () => ++calls > 3,
    });
    expect(bytes).toBeNull();
  });

  it('falls back to arrayBuffer() where Blob#stream is missing and still reports completion', async () => {
    const blob = Object.assign(blobOf(100), { stream: undefined });
    const onProgress = vi.fn();
    const bytes = await readFileBytes(blob as unknown as Blob, { onProgress });
    expect(bytes).toHaveLength(100);
    expect(onProgress).toHaveBeenCalledExactlyOnceWith({ loaded: 100, total: 100 });
  });

  it('copes with a file that grows while it is read', async () => {
    const blob = Object.assign(blobOf(10), { stream: () => chunked(30, 10).stream() });
    expect(await readFileBytes(blob)).toHaveLength(30);
  });

  it('rejects with the underlying error when the file cannot be read', async () => {
    const blob = Object.assign(blobOf(10), {
      stream: () =>
        new ReadableStream({
          pull() {
            throw Object.assign(new Error('x'), { name: 'NotReadableError' });
          },
        }),
    });
    await expect(readFileBytes(blob)).rejects.toMatchObject({ name: 'NotReadableError' });
  });
});
