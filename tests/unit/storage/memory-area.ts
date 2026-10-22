import { vi } from 'vitest';
import type { StorageAreaLike } from '../../../lib/storage';

/** In-memory stand-in for a chrome.storage area. Values are cloned like the real API does. */
export class MemoryArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();
  failWith: Error | undefined;

  readonly get = vi.fn((keys: string | string[] | null): Promise<Record<string, unknown>> => {
    if (this.failWith) return Promise.reject(this.failWith);
    const names = keys === null ? [...this.data.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const name of names) {
      if (this.data.has(name)) out[name] = structuredClone(this.data.get(name));
    }
    return Promise.resolve(out);
  });

  readonly set = vi.fn((items: Record<string, unknown>): Promise<void> => {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const [name, value] of Object.entries(items)) this.data.set(name, structuredClone(value));
    return Promise.resolve();
  });

  readonly remove = vi.fn((keys: string | string[]): Promise<void> => {
    if (this.failWith) return Promise.reject(this.failWith);
    for (const name of Array.isArray(keys) ? keys : [keys]) this.data.delete(name);
    return Promise.resolve();
  });

  keys(): string[] {
    return [...this.data.keys()].sort();
  }
}
