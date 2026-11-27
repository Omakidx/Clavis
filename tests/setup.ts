import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach } from 'vitest';

// Every test starts with empty extension storage, no listeners and an empty IndexedDB (a fresh
// factory is a fresh set of databases; lib/data/db.ts re-opens when the factory changes).
beforeEach(() => {
  fakeBrowser.reset();
  globalThis.indexedDB = new IDBFactory();
});
