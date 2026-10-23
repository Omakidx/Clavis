/** Progress of reading a local file into memory. `total` is the file size (known up front). */
export interface ReadProgress {
  loaded: number;
  total: number;
}

export interface ReadOptions {
  onProgress?: (progress: ReadProgress) => void;
  /** Checked between chunks; reading stops early (and returns null) once it is true. */
  isCancelled?: () => boolean;
}

/**
 * Read a local file into one preallocated buffer, reporting progress as chunks arrive (FR-050:
 * "show progress"). Memory: exactly the file size once, never a second copy, which matters at the
 * 100 MiB cap. Hosts without `Blob#stream` (old test environments) fall back to `arrayBuffer()`
 * and report completion only.
 *
 * Returns null when cancelled. Rejects with the underlying DOMException (NotReadableError,
 * NotAllowedError, ...) when the file cannot be read; the caller maps it to a PERMISSION state.
 */
export async function readFileBytes(
  file: Blob,
  options: ReadOptions = {},
): Promise<Uint8Array | null> {
  const total = file.size;
  if (typeof file.stream !== 'function') {
    const bytes = new Uint8Array(await file.arrayBuffer());
    options.onProgress?.({ loaded: bytes.length, total });
    return options.isCancelled?.() === true ? null : bytes;
  }
  const reader = file.stream().getReader();
  let bytes = new Uint8Array(total);
  let loaded = 0;
  try {
    for (;;) {
      if (options.isCancelled?.() === true) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (loaded + value.length > bytes.length) {
        // The file grew while it was being read: take what the stream delivers.
        const grown = new Uint8Array(loaded + value.length);
        grown.set(bytes.subarray(0, loaded));
        bytes = grown;
      }
      bytes.set(value, loaded);
      loaded += value.length;
      options.onProgress?.({ loaded, total: Math.max(total, loaded) });
    }
  } finally {
    reader.releaseLock();
  }
  return loaded === bytes.length ? bytes : bytes.slice(0, loaded);
}
