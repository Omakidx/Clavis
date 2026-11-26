import { describe, expect, it } from 'vitest';
import {
  ApiError,
  ChatData,
  DeleteAccountRequest,
  DocumentData,
  ENDPOINTS,
  ERROR_CODES,
  ERROR_STATUS,
  ExtensionGoogleRequest,
  FileTitleHeader,
  HighlightData,
  LIMITS,
  PullQuery,
  PullResponse,
  PushRequest,
  PushResponse,
  RefreshRequest,
  ServerChange,
  WordData,
  normalize,
  wordKey,
} from '../../../shared/api-contract';

const hex = (c: string) => c.repeat(64);
const now = 1_760_000_000_000;
const uuid = '3f2b8c1e-6d1a-4c1b-9a53-2f4d5e6a7b8c';

const meaning = { title: 'serendipity', summary: 'A happy accident.', model: 'llama-3.3-70b' };
const word = {
  text: 'serendipity',
  meaning,
  source: { kind: 'webpage' as const, url: 'https://example.com/a', title: null },
  createdAt: now,
};
const highlight = {
  fingerprint: hex('a'),
  page: 3,
  start: 10,
  end: 20,
  color: 'yellow' as const,
  createdAt: now,
};

describe('normalize and wordKey', () => {
  it('applies NFKC, trims, collapses whitespace and lowercases', () => {
    expect(normalize('  Hello \t\n  WORLD ')).toBe('hello world');
    expect(normalize('ＦＵＬＬＷＩＤＴＨ')).toBe('fullwidth'); // NFKC
    expect(normalize('ﬁne')).toBe('fine'); // ligature
    expect(normalize('Café')).toBe(normalize('Café')); // composed vs decomposed
    expect(normalize('a 　b')).toBe('a b'); // exotic spaces
    expect(normalize('')).toBe('');
  });

  it('hashes the normalized text with SHA-256 hex', async () => {
    // sha256("hello")
    expect(await wordKey('  HELLO ')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(await wordKey('Foo   Bar')).toBe(await wordKey('foo bar'));
    expect(await wordKey('a')).not.toBe(await wordKey('b'));
  });
});

describe('error envelope', () => {
  it('maps every code to an HTTP status', () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    expect(ERROR_STATUS.CURSOR_EXPIRED).toBe(410);
    expect(ERROR_STATUS.QUOTA_EXCEEDED).toBe(422);
  });
  it('validates the envelope and rejects unknown keys and codes', () => {
    expect(
      ApiError.safeParse({ error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 1000 } })
        .success,
    ).toBe(true);
    expect(ApiError.safeParse({ error: { code: 'NOPE', message: 'x' } }).success).toBe(false);
    expect(
      ApiError.safeParse({ error: { code: 'INTERNAL', message: 'x', extra: 1 } }).success,
    ).toBe(false);
  });
});

describe('WordData', () => {
  it('accepts a valid word and trims text', () => {
    expect(WordData.parse({ ...word, text: '  hi  ' }).text).toBe('hi');
  });
  it('rejects unknown keys at every level', () => {
    expect(WordData.safeParse({ ...word, apiKey: 'x' }).success).toBe(false);
    expect(WordData.safeParse({ ...word, meaning: { ...meaning, extra: 1 } }).success).toBe(false);
    expect(WordData.safeParse({ ...word, source: { ...word.source, extra: 1 } }).success).toBe(
      false,
    );
  });
  it('enforces size limits', () => {
    expect(WordData.safeParse({ ...word, text: 'x'.repeat(201) }).success).toBe(false);
    expect(WordData.safeParse({ ...word, text: '   ' }).success).toBe(false);
    expect(
      WordData.safeParse({ ...word, meaning: { ...meaning, summary: 'x'.repeat(601) } }).success,
    ).toBe(false);
    expect(
      WordData.safeParse({ ...word, meaning: { ...meaning, title: 'x'.repeat(121) } }).success,
    ).toBe(false);
    expect(WordData.safeParse({ ...word, language: 'x'.repeat(36) }).success).toBe(false);
    expect(
      WordData.safeParse({
        ...word,
        meaning: {
          ...meaning,
          examples: [{ sentence: 'a' }, { sentence: 'b' }, { sentence: 'c' }],
        },
      }).success,
    ).toBe(false);
  });
  it('limits context to 1000 characters combined', () => {
    expect(
      WordData.safeParse({ ...word, contextBefore: 'a'.repeat(500), contextAfter: 'b'.repeat(500) })
        .success,
    ).toBe(true);
    expect(
      WordData.safeParse({ ...word, contextBefore: 'a'.repeat(501), contextAfter: 'b'.repeat(500) })
        .success,
    ).toBe(false);
    expect(WordData.safeParse({ ...word, contextBefore: 'a'.repeat(1001) }).success).toBe(false);
  });
  it('rejects timestamps before 2020 and non-integers', () => {
    expect(WordData.safeParse({ ...word, createdAt: 1000 }).success).toBe(false);
    expect(WordData.safeParse({ ...word, createdAt: now + 0.5 }).success).toBe(false);
  });
  it('validates the pdf source', () => {
    const pdf = { kind: 'pdf', fingerprint: hex('b'), title: null, page: 5 };
    expect(WordData.safeParse({ ...word, source: pdf }).success).toBe(true);
    expect(WordData.safeParse({ ...word, source: { ...pdf, page: 0 } }).success).toBe(false);
    expect(WordData.safeParse({ ...word, source: { ...pdf, fingerprint: 'ABC' } }).success).toBe(
      false,
    );
  });
});

describe('ChatData', () => {
  const user = { wordKey: hex('c'), role: 'user' as const, content: 'hi', createdAt: now };
  it('enforces role rules', () => {
    expect(ChatData.safeParse(user).success).toBe(true);
    expect(ChatData.safeParse({ ...user, content: 'x'.repeat(2001) }).success).toBe(false);
    expect(ChatData.safeParse({ ...user, model: 'm' }).success).toBe(false);
    const assistant = { ...user, role: 'assistant' as const };
    expect(ChatData.safeParse(assistant).success).toBe(false);
    expect(
      ChatData.safeParse({ ...assistant, model: 'm', content: 'x'.repeat(4000) }).success,
    ).toBe(true);
    expect(
      ChatData.safeParse({ ...assistant, model: 'm', content: 'x'.repeat(4001) }).success,
    ).toBe(false);
    expect(ChatData.safeParse({ ...user, content: '' }).success).toBe(false);
  });
  it('rejects unknown keys', () => {
    expect(ChatData.safeParse({ ...user, id: uuid }).success).toBe(false);
  });
});

describe('DocumentData and HighlightData', () => {
  it('bounds document fields and rejects server-owned storage fields', () => {
    const doc = { title: null, pageCount: 10, lastPage: 2, pageOffset: 0.5, fileBytes: 1000 };
    expect(DocumentData.safeParse(doc).success).toBe(true);
    expect(DocumentData.safeParse({ ...doc, pageOffset: 1.1 }).success).toBe(false);
    expect(DocumentData.safeParse({ ...doc, pageCount: 5001 }).success).toBe(false);
    expect(DocumentData.safeParse({ ...doc, fileBytes: 0 }).success).toBe(false);
    expect(DocumentData.safeParse({ ...doc, storageState: 'stored' }).success).toBe(false);
    expect(DocumentData.safeParse({ ...doc, title: 'x'.repeat(301) }).success).toBe(false);
  });
  it('requires end > start and valid colors', () => {
    expect(HighlightData.safeParse(highlight).success).toBe(true);
    expect(HighlightData.safeParse({ ...highlight, end: 10 }).success).toBe(false);
    expect(HighlightData.safeParse({ ...highlight, color: 'red' }).success).toBe(false);
    expect(HighlightData.safeParse({ ...highlight, end: 10_000_001 }).success).toBe(false);
  });
});

describe('PushRequest', () => {
  const upsert = { kind: 'word', op: 'upsert', key: hex('d'), clientModifiedAt: now, data: word };
  it('accepts every change variant', () => {
    const changes = [
      upsert,
      { kind: 'word', op: 'delete', key: hex('d'), clientModifiedAt: now },
      {
        kind: 'chat',
        op: 'insert',
        id: uuid,
        data: { wordKey: hex('d'), role: 'user', content: 'hi', createdAt: now },
      },
      {
        kind: 'document',
        op: 'upsert',
        key: hex('a'),
        clientModifiedAt: now,
        data: { title: null, pageCount: null, lastPage: null, pageOffset: null, fileBytes: null },
      },
      { kind: 'document', op: 'delete', key: hex('a'), clientModifiedAt: now },
      { kind: 'highlight', op: 'upsert', id: uuid, clientModifiedAt: now, data: highlight },
      { kind: 'highlight', op: 'delete', id: uuid, fingerprint: hex('a'), clientModifiedAt: now },
    ];
    expect(PushRequest.safeParse({ changes }).success).toBe(true);
  });
  it('rejects empty, oversize, unknown-key and mismatched kind/op changes', () => {
    expect(PushRequest.safeParse({ changes: [] }).success).toBe(false);
    expect(
      PushRequest.safeParse({ changes: Array(LIMITS.maxPushChanges + 1).fill(upsert) }).success,
    ).toBe(false);
    expect(
      PushRequest.safeParse({ changes: Array(LIMITS.maxPushChanges).fill(upsert) }).success,
    ).toBe(true);
    expect(PushRequest.safeParse({ changes: [upsert], extra: 1 }).success).toBe(false);
    expect(PushRequest.safeParse({ changes: [{ ...upsert, extra: 1 }] }).success).toBe(false);
    expect(
      PushRequest.safeParse({ changes: [{ kind: 'chat', op: 'delete', id: uuid }] }).success,
    ).toBe(false);
    expect(
      PushRequest.safeParse({
        changes: [{ kind: 'word', op: 'delete', key: hex('d'), clientModifiedAt: now, data: word }],
      }).success,
    ).toBe(false);
    expect(PushRequest.safeParse({ changes: [{ ...upsert, key: 'XYZ' }] }).success).toBe(false);
    expect(PushRequest.safeParse({ changes: [{ kind: 'bogus', op: 'upsert' }] }).success).toBe(
      false,
    );
  });
});

describe('PushResponse, ServerChange, PullResponse', () => {
  it('accepts applied, stale and rejected results', () => {
    const current = {
      kind: 'word',
      key: hex('d'),
      seq: '12',
      deleted: false,
      clientModifiedAt: now,
      data: word,
    };
    const ok = PushResponse.safeParse({
      results: [
        { index: 0, status: 'applied', seq: '5' },
        { index: 1, status: 'stale', current },
        { index: 2, status: 'rejected', code: 'LIMIT_EXCEEDED' },
      ],
      serverTime: now,
    });
    expect(ok.success).toBe(true);
    expect(
      PushResponse.safeParse({
        results: [{ index: 0, status: 'rejected', code: 'INTERNAL' }],
        serverTime: now,
      }).success,
    ).toBe(false);
    expect(
      PushResponse.safeParse({
        results: [{ index: 0, status: 'applied', seq: '-1' }],
        serverTime: now,
      }).success,
    ).toBe(false);
  });
  it('validates all four ServerChange kinds', () => {
    expect(
      ServerChange.safeParse({
        kind: 'chat',
        id: uuid,
        seq: '1',
        data: { wordKey: hex('d'), role: 'user', content: 'x', createdAt: now },
      }).success,
    ).toBe(true);
    expect(
      ServerChange.safeParse({
        kind: 'document',
        key: hex('a'),
        seq: '2',
        deleted: true,
        clientModifiedAt: now,
        data: null,
        storage: { state: 'none', bytes: null },
      }).success,
    ).toBe(true);
    expect(
      ServerChange.safeParse({
        kind: 'highlight',
        id: uuid,
        seq: '3',
        deleted: false,
        clientModifiedAt: now,
        fingerprint: hex('a'),
        data: highlight,
      }).success,
    ).toBe(true);
    expect(
      ServerChange.safeParse({
        kind: 'word',
        key: hex('d'),
        seq: '1',
        deleted: true,
        clientModifiedAt: now,
        data: null,
        extra: 1,
      }).success,
    ).toBe(false);
  });
  it('validates pull query and response', () => {
    expect(PullQuery.parse({})).toEqual({ cursor: '0', limit: 500 });
    expect(PullQuery.parse({ cursor: '42', limit: '1000' })).toEqual({ cursor: '42', limit: 1000 });
    expect(PullQuery.safeParse({ limit: '1001' }).success).toBe(false);
    expect(PullQuery.safeParse({ limit: '0' }).success).toBe(false);
    expect(PullQuery.safeParse({ cursor: 'abc' }).success).toBe(false);
    expect(PullQuery.safeParse({ cursor: '1'.repeat(20) }).success).toBe(false);
    expect(PullResponse.safeParse({ changes: [], nextCursor: '0', hasMore: false }).success).toBe(
      true,
    );
  });
});

describe('auth and account requests', () => {
  const g = {
    code: 'c',
    codeVerifier: 'a'.repeat(43),
    redirectUri: 'https://abc.chromiumapp.org/',
    nonce: 'n',
  };
  it('validates the Google exchange request', () => {
    expect(ExtensionGoogleRequest.safeParse(g).success).toBe(true);
    expect(ExtensionGoogleRequest.safeParse({ ...g, codeVerifier: 'short' }).success).toBe(false);
    expect(ExtensionGoogleRequest.safeParse({ ...g, codeVerifier: 'a'.repeat(129) }).success).toBe(
      false,
    );
    expect(ExtensionGoogleRequest.safeParse({ ...g, code: 'x'.repeat(2049) }).success).toBe(false);
    expect(ExtensionGoogleRequest.safeParse({ ...g, nonce: 'x'.repeat(65) }).success).toBe(false);
    expect(ExtensionGoogleRequest.safeParse({ ...g, redirectUri: 'not a url' }).success).toBe(
      false,
    );
    expect(ExtensionGoogleRequest.safeParse({ ...g, extra: 1 }).success).toBe(false);
  });
  it('validates refresh tokens and the delete confirmation', () => {
    expect(RefreshRequest.safeParse({ refreshToken: `crt_${'A'.repeat(43)}` }).success).toBe(true);
    expect(RefreshRequest.safeParse({ refreshToken: 'nope' }).success).toBe(false);
    expect(DeleteAccountRequest.safeParse({ confirm: 'DELETE' }).success).toBe(true);
    expect(DeleteAccountRequest.safeParse({ confirm: 'delete' }).success).toBe(false);
  });
  it('decodes and bounds the title header', () => {
    expect(FileTitleHeader.parse('My%20Book')).toBe('My Book');
    expect(FileTitleHeader.safeParse('%E0%A4%A').success).toBe(false);
    expect(FileTitleHeader.safeParse('a'.repeat(301)).success).toBe(false);
  });
});

describe('ENDPOINTS table', () => {
  it('covers every §5.4 endpoint exactly once', () => {
    const rows = Object.values(ENDPOINTS).map((e) => `${e.method} ${e.path}`);
    expect(rows.sort()).toEqual(
      [
        'GET /healthz',
        'GET /readyz',
        'GET /v1/meta',
        'POST /v1/auth/extension/google',
        'POST /v1/auth/extension/refresh',
        'POST /v1/auth/extension/logout',
        'GET /auth/google/start',
        'GET /auth/google/callback',
        'POST /auth/logout',
        'GET /v1/session',
        'GET /v1/account',
        'POST /v1/account/logout-all',
        'GET /v1/account/export',
        'DELETE /v1/account',
        'POST /v1/sync/push',
        'GET /v1/sync/pull',
        'GET /v1/words',
        'GET /v1/words/:key',
        'DELETE /v1/words/:key',
        'GET /v1/documents',
        'GET /v1/documents/:fp',
        'DELETE /v1/documents/:fp',
        'PUT /v1/documents/:fp/file',
        'GET /v1/documents/:fp/file',
        'DELETE /v1/documents/:fp/file',
      ].sort(),
    );
  });
  it('rejects non-hex path params', () => {
    expect(ENDPOINTS.wordGet.params.safeParse({ key: 'zzz' }).success).toBe(false);
    expect(ENDPOINTS.documentGet.params.safeParse({ fp: hex('a') }).success).toBe(true);
  });
  it('bounds list queries', () => {
    expect(ENDPOINTS.wordsList.query.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    expect(ENDPOINTS.wordsList.query.safeParse({ limit: '101' }).success).toBe(false);
    expect(ENDPOINTS.wordsList.query.parse({}).limit).toBe(50);
    expect(ENDPOINTS.documentsList.query.safeParse({ cursor: 'bad cursor!' }).success).toBe(false);
  });
});
