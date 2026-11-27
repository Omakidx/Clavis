import { describe, expect, it } from 'vitest';
import { ClavisExport, exportPdfPath } from '../../../shared/api-contract';

const fp = 'a'.repeat(64);
const word = {
  text: 'w',
  meaning: { title: 't', summary: 's', model: 'm' },
  source: { kind: 'webpage' as const, url: null, title: null },
  createdAt: 1_800_000_000_000,
  key: fp,
  clientModifiedAt: 1_800_000_000_000,
  messages: [],
};
const doc = {
  title: null,
  pageCount: null,
  lastPage: null,
  pageOffset: null,
  fileBytes: null,
  fingerprint: fp,
  clientModifiedAt: 1_800_000_000_000,
  highlightCount: 0,
  storage: { state: 'none' as const, bytes: null, storedAt: null },
  highlights: [],
};
const base = {
  format: 'clavis-export' as const,
  version: 1 as const,
  exportedAt: '2026-11-27T10:00:00.000Z',
  savedWords: [word],
  documents: [doc],
};

describe('ClavisExport schema', () => {
  it('accepts the server shape (account and file present)', () => {
    const r = ClavisExport.safeParse({
      ...base,
      account: { email: 'a@b.test', displayName: null, createdAt: 1_800_000_000_000 },
      documents: [{ ...doc, file: exportPdfPath(fp) }],
    });
    expect(r.success).toBe(true);
  });
  it('accepts the signed-out local shape (no account, no file)', () => {
    expect(ClavisExport.safeParse(base).success).toBe(true);
    expect(ClavisExport.safeParse({ ...base, documents: [{ ...doc, file: null }] }).success).toBe(
      true,
    );
  });
  it('rejects wrong format, version, file paths and unknown fields', () => {
    expect(ClavisExport.safeParse({ ...base, format: 'x' }).success).toBe(false);
    expect(ClavisExport.safeParse({ ...base, version: 2 }).success).toBe(false);
    expect(ClavisExport.safeParse({ ...base, exportedAt: 'yesterday' }).success).toBe(false);
    expect(
      ClavisExport.safeParse({ ...base, documents: [{ ...doc, file: '../x.pdf' }] }).success,
    ).toBe(false);
    expect(ClavisExport.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });
});
