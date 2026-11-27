import { describe, expect, it } from 'vitest';
import { getDocument, saveProgress, setStorageState } from '../../../lib/data/documents';
import { detachForKeep, markAllDirty } from '../../../lib/sync/store';

const FP = 'a'.repeat(64);
const seed = async () => {
  await saveProgress(
    FP,
    { title: 'Paper', pageCount: 3, fileBytes: 10, lastPage: 2, pageOffset: 0 },
    { signedIn: () => Promise.resolve(false) },
  );
  await setStorageState(FP, 'stored');
  expect((await getDocument(FP))?.storageState).toBe('stored');
};

describe('which files an account holds is forgotten when a record changes accounts', () => {
  it('sign-out with a kept copy: the document no longer claims a stored file', async () => {
    await seed();
    await detachForKeep();
    const doc = await getDocument(FP);
    expect(doc?.storageState).toBe('none');
    expect(doc?.lastPage).toBe(2); // progress stays
  });

  it('first sign-in: documents are new to the account and claim no stored file', async () => {
    await seed();
    await markAllDirty();
    const doc = await getDocument(FP);
    expect(doc?.storageState).toBe('none');
    expect(doc?.dirty).toBe(1);
  });
});
