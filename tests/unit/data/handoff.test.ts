import { describe, expect, it } from 'vitest';
import {
  STORE,
  closeDb,
  deleteDatabase,
  getAll,
  transact,
  type FileHandoff,
} from '../../../lib/data/db';
import {
  STALE_HANDOFF_MS,
  dropHandoff,
  putHandoff,
  sweepStaleHandoffs,
  takeHandoff,
} from '../../../lib/data/handoff';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const all = () =>
  transact([STORE.fileHandoff], 'readonly', (tx) =>
    getAll<FileHandoff>(tx.objectStore(STORE.fileHandoff)),
  );

describe('fileHandoff lifecycle (design 6.6)', () => {
  it('take reads the entry and deletes it in the same step', async () => {
    await deleteDatabase().catch(() => undefined);
    await putHandoff(A, new Blob(['%PDF-1.7']), 'upload');
    const blob = await takeHandoff(A, 'upload');
    expect(blob?.size).toBe(8);
    expect(await all()).toEqual([]);
    expect(await takeHandoff(A, 'upload')).toBeNull();
  });

  it('an entry left for the other direction is not consumed', async () => {
    await putHandoff(A, new Blob(['x']), 'download');
    expect(await takeHandoff(A, 'upload')).toBeNull();
    expect(await all()).toHaveLength(1);
    await dropHandoff(A, 'upload');
    expect(await all()).toHaveLength(1); // not its direction: left alone
    await dropHandoff(A, 'download');
    expect(await all()).toEqual([]);
  });

  it('the startup sweep deletes entries older than 10 minutes and keeps newer ones', async () => {
    const now = 10_000_000;
    await putHandoff(A, new Blob(['old']), 'upload', () => now - STALE_HANDOFF_MS - 1);
    await putHandoff(B, new Blob(['new']), 'download', () => now - STALE_HANDOFF_MS + 1_000);
    expect(await sweepStaleHandoffs(() => now)).toBe(1);
    expect((await all()).map((entry) => entry.fingerprint)).toEqual([B]);
    expect(await sweepStaleHandoffs(() => now + STALE_HANDOFF_MS)).toBe(1);
    expect(await all()).toEqual([]);
    await closeDb();
  });

  it('a put never overwrites an entry of the other direction, and a drop only removes its own', async () => {
    await deleteDatabase().catch(() => undefined);
    expect(await putHandoff(A, new Blob(['up']), 'upload')).toBe(true);
    expect(await putHandoff(A, new Blob(['down']), 'download')).toBe(false);
    expect((await all())[0]?.direction).toBe('upload');
    expect(await putHandoff(A, new Blob(['up2']), 'upload')).toBe(true); // same direction replaces
    await dropHandoff(A, 'download');
    expect(await all()).toHaveLength(1);
    await dropHandoff(A, 'upload');
    expect(await all()).toEqual([]);
    await closeDb();
  });
});
