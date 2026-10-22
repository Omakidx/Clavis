import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectionSnapshotSchema } from '../../../lib/contracts';
import { newSelectionId } from '../../../lib/selection/ids';

describe('newSelectionId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('produces RFC 4122 v4 UUIDs accepted by the contract schema', () => {
    for (let i = 0; i < 50; i++) {
      const id = newSelectionId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(
        selectionSnapshotSchema.safeParse({
          selectionId: id,
          source: 'webpage',
          kind: 'word',
          text: 'bank',
        }).success,
      ).toBe(true);
    }
  });

  it('works on plain-http pages where crypto.randomUUID does not exist', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(newSelectionId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is unique per call', () => {
    expect(new Set(Array.from({ length: 200 }, newSelectionId)).size).toBe(200);
  });
});
