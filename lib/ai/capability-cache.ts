import type { StorageAreaLike } from '../storage/area';

/**
 * What the account's model actually did, as opposed to what the static table
 * (lib/ai/capabilities.ts) expects. Remembered so a rejected option is not re-tried (and
 * re-rejected) on every call: each retry costs a round trip (architecture §6, FR-040).
 */
export interface ObservedCapabilities {
  /** `true`: a json_schema request succeeded. `false`: Groq rejected `response_format` json_schema. */
  jsonSchema?: boolean;
  /** `false`: Groq rejected `reasoning_effort` for this model. */
  reasoningEffort?: boolean;
}

export interface CapabilityCache {
  get(model: string): Promise<ObservedCapabilities>;
  /** Merge an observation for one model. Never throws. */
  record(model: string, observed: ObservedCapabilities): Promise<void>;
  /** Forget one model, or all of them. Used when the model preference or the key changes. */
  invalidate(model?: string): Promise<void>;
}

/** Key of the optional persisted copy. In the `clavis.` namespace, so CLEAR_ALL_DATA sweeps it. */
export const CAPABILITY_STORAGE_KEY = 'clavis.model-capabilities';

/** A verdict is re-probed after this long, so a provider that adds support is noticed. */
export const CAPABILITY_TTL_MS = 12 * 60 * 60 * 1000;
/** Bound on remembered models (a model list can be long; only a few are ever used). */
export const MAX_CACHED_MODELS = 32;

interface Entry extends ObservedCapabilities {
  at: number;
}

export interface CapabilityCacheOptions {
  now?: () => number;
  ttlMs?: number;
  /**
   * Optional persistence, normally `chrome.storage.session` (the background restarts after
   * about 30 s idle, which would otherwise forget every verdict). Holds non-secret booleans only.
   */
  store?: StorageAreaLike;
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['at'] === 'number' &&
    Number.isFinite(entry['at']) &&
    (entry['jsonSchema'] === undefined || typeof entry['jsonSchema'] === 'boolean') &&
    (entry['reasoningEffort'] === undefined || typeof entry['reasoningEffort'] === 'boolean')
  );
}

/** In-memory cache, optionally mirrored to a storage area. Storage failures never fail a request. */
export function createCapabilityCache(options: CapabilityCacheOptions = {}): CapabilityCache {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? CAPABILITY_TTL_MS;
  const { store } = options;
  // Insertion order doubles as recency: re-inserting on write keeps the oldest first.
  const entries = new Map<string, Entry>();
  let hydrated: Promise<void> | undefined;

  function hydrate(): Promise<void> {
    if (store === undefined) return Promise.resolve();
    hydrated ??= (async () => {
      try {
        const raw = (await store.get(CAPABILITY_STORAGE_KEY))[CAPABILITY_STORAGE_KEY];
        if (typeof raw !== 'object' || raw === null) return;
        for (const [model, entry] of Object.entries(raw as Record<string, unknown>)) {
          // Observations made before this worker started never override newer in-memory ones.
          if (isEntry(entry) && !entries.has(model)) entries.set(model, entry);
        }
      } catch {
        // Unreadable storage behaves like an empty cache.
      }
    })();
    return hydrated;
  }

  async function persist(): Promise<void> {
    if (store === undefined) return;
    try {
      if (entries.size === 0) await store.remove(CAPABILITY_STORAGE_KEY);
      else await store.set({ [CAPABILITY_STORAGE_KEY]: Object.fromEntries(entries) });
    } catch {
      // Persistence is an optimisation.
    }
  }

  return {
    async get(model) {
      await hydrate();
      const entry = entries.get(model);
      if (entry === undefined) return {};
      if (now() - entry.at > ttlMs || entry.at > now() + ttlMs) {
        entries.delete(model);
        return {};
      }
      const { at: _at, ...observed } = entry;
      return observed;
    },

    async record(model, observed) {
      await hydrate();
      const current = entries.get(model);
      // A stale verdict is not merged into a fresh observation.
      const live = current !== undefined && now() - current.at <= ttlMs ? current : undefined;
      const next: Entry = { ...(live ?? {}), ...observed, at: now() };
      entries.delete(model);
      entries.set(model, next);
      while (entries.size > MAX_CACHED_MODELS) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      await persist();
    },

    async invalidate(model) {
      await hydrate();
      if (model === undefined) entries.clear();
      else entries.delete(model);
      await persist();
    },
  };
}
