import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../../../lib/account/api';
import {
  NotSignedInError,
  SessionLostError,
  StorageLockedError,
} from '../../../lib/account/tokens';
import { createDocumentHandlers, titleHeaders } from '../../../lib/router/handlers/documents';
import { parseDocumentMessage } from '../../../lib/contracts/documents';
import {
  DOCUMENT_MESSAGES,
  FP,
  contentSender,
  createHarness,
  pageSender,
  panelSender,
  popupSender,
  type Harness,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST' } };

const view = (state: 'none' | 'stored', fingerprint = FP) => ({
  document: {
    fingerprint,
    title: 'Paper',
    pageCount: 3,
    lastPage: 2,
    pageOffset: 0,
    fileBytes: 8,
    clientModifiedAt: 1_700_000_000_000,
    highlightCount: 0,
    storage: { state, bytes: state === 'stored' ? 8 : null, storedAt: null },
  },
});

describe('DOCUMENT_* senders (design 7.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('upload and fetch are the reader only; remove file is the reader and the library', async () => {
    const reader = pageSender('/reader.html');
    const library = pageSender('/library.html');
    for (const sender of [
      contentSender(),
      popupSender(),
      panelSender(),
      pageSender('/options.html'),
      library,
    ]) {
      expect(await h.call(DOCUMENT_MESSAGES['DOCUMENT_UPLOAD'], sender)).toMatchObject(INVALID);
      expect(await h.call(DOCUMENT_MESSAGES['DOCUMENT_FETCH'], sender)).toMatchObject(INVALID);
    }
    for (const sender of [
      contentSender(),
      popupSender(),
      panelSender(),
      pageSender('/options.html'),
    ]) {
      expect(await h.call(DOCUMENT_MESSAGES['DOCUMENT_REMOVE_FILE'], sender)).toMatchObject(
        INVALID,
      );
    }
    expect(h.handoff.take).not.toHaveBeenCalled();
    expect(h.documentTokens.request).not.toHaveBeenCalled();
    expect(h.documentTokens.requestBlob).not.toHaveBeenCalled();

    expect(await h.call(DOCUMENT_MESSAGES['DOCUMENT_FETCH'], reader)).toMatchObject({ ok: true });
    for (const sender of [reader, library]) {
      expect(await h.call(DOCUMENT_MESSAGES['DOCUMENT_REMOVE_FILE'], sender)).toMatchObject({
        ok: true,
      });
    }
  });

  it('validates the shape strictly: Hex64 fingerprint, bounded title, no extra keys, version', async () => {
    const reader = pageSender('/reader.html');
    const bad = [
      { v: 1, type: 'DOCUMENT_UPLOAD', fingerprint: 'A'.repeat(64), title: 'x' },
      { v: 1, type: 'DOCUMENT_UPLOAD', fingerprint: 'a'.repeat(63), title: 'x' },
      { v: 1, type: 'DOCUMENT_UPLOAD', fingerprint: FP, title: 'x'.repeat(301) },
      { v: 1, type: 'DOCUMENT_UPLOAD', fingerprint: FP },
      { v: 1, type: 'DOCUMENT_UPLOAD', fingerprint: FP, title: 'x', blob: 'bytes' },
      { v: 2, type: 'DOCUMENT_UPLOAD', fingerprint: FP, title: 'x' },
      { v: 1, type: 'DOCUMENT_FETCH', fingerprint: '../etc/passwd' },
      { v: 1, type: 'DOCUMENT_FETCH', fingerprint: `${FP}?x=1` },
      { v: 1, type: 'DOCUMENT_REMOVE_FILE' },
    ];
    for (const message of bad) {
      expect(await h.call(message, reader)).toMatchObject(INVALID);
    }
    expect(h.handoff.take).not.toHaveBeenCalled();
    expect(parseDocumentMessage(DOCUMENT_MESSAGES['DOCUMENT_FETCH']).ok).toBe(true);
  });
});

describe('document handlers with a mocked token client', () => {
  function setup(over: Partial<Parameters<typeof createDocumentHandlers>[0]> = {}) {
    const tokens = {
      request: vi.fn(),
      requestBlob: vi.fn(),
    };
    const handoff = {
      take: vi.fn(() => Promise.resolve(new Blob(['%PDF-1.7 body']) as Blob | null)),
      put: vi.fn(() => Promise.resolve(true)),
      sweep: vi.fn(() => Promise.resolve(0)),
      drop: vi.fn(() => Promise.resolve()),
      markStorage: vi.fn(() => Promise.resolve(true)),
    };
    const onLocalChange = vi.fn();
    const handlers = createDocumentHandlers({
      tokens,
      enabled: true,
      signedIn: () => Promise.resolve(true),
      onLocalChange,
      take: handoff.take,
      put: handoff.put,
      drop: handoff.drop,
      sweep: handoff.sweep,
      markStorage: handoff.markStorage,
      ...over,
    });
    return { tokens, handoff, handlers, onLocalChange };
  }

  it('upload streams the blob with the title header, records the state and kicks sync', async () => {
    const { tokens, handoff, handlers, onLocalChange } = setup();
    tokens.request.mockResolvedValue(view('stored'));
    const reply = await handlers.upload({ fingerprint: FP, title: 'Ü & Paper' });
    expect(reply).toEqual({ ok: true, data: { storage: { state: 'stored', bytes: 8 } } });
    const spec = tokens.request.mock.calls[0]![0] as {
      method: string;
      path: string;
      blob: Blob;
      headers: Record<string, string>;
    };
    expect(spec.method).toBe('PUT');
    expect(spec.path).toBe(`/v1/documents/${FP}/file`);
    expect(spec.blob.type).toBe('application/pdf');
    expect(spec.headers['X-Clavis-Title']).toBe(encodeURIComponent('Ü & Paper'));
    expect(handoff.take).toHaveBeenCalledWith(FP, 'upload');
    expect(handoff.markStorage).toHaveBeenCalledWith(FP, 'stored');
    expect(handoff.drop).toHaveBeenCalledWith(FP, 'upload');
    expect(onLocalChange).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(reply)).not.toMatch(/token|Bearer/i);
  });

  it.each([
    ['QUOTA_EXCEEDED', 422, 'QUOTA_EXCEEDED'],
    ['FILE_TOO_LARGE', 413, 'FILE_TOO_LARGE'],
    ['NOT_A_PDF', 422, 'NOT_A_PDF'],
    ['FINGERPRINT_MISMATCH', 422, 'FINGERPRINT_MISMATCH'],
    ['UPLOAD_IN_PROGRESS', 409, 'UPLOAD_IN_PROGRESS'],
    ['CONFLICT', 409, 'UPLOAD_IN_PROGRESS'],
    ['LIMIT_EXCEEDED', 422, 'LIMIT_EXCEEDED'],
    ['PAYLOAD_TOO_LARGE', 413, 'FILE_TOO_LARGE'],
    ['UNSUPPORTED_MEDIA_TYPE', 415, 'NOT_A_PDF'],
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['RATE_LIMITED', 429, 'RATE_LIMITED'],
    ['UNAVAILABLE', 503, 'NETWORK_ERROR'],
    ['NETWORK', 0, 'NETWORK_ERROR'],
    ['INTERNAL', 500, 'NETWORK_ERROR'],
    ['VALIDATION_FAILED', 411, 'INTERNAL_ERROR'],
    ['FORBIDDEN', 403, 'INTERNAL_ERROR'],
    ['SESSION_REVOKED', 401, 'NOT_SIGNED_IN'],
    ['UNAUTHENTICATED', 401, 'NOT_SIGNED_IN'],
  ] as const)(
    'upload maps the server code %s to %s and still clears the handoff',
    async (code, status, expected) => {
      const { tokens, handoff, handlers, onLocalChange } = setup();
      tokens.request.mockRejectedValue(new ApiRequestError(code, status));
      expect(await handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
        ok: false,
        error: { code: expected },
      });
      expect(handoff.drop).toHaveBeenCalledWith(FP, 'upload');
      expect(handoff.markStorage).not.toHaveBeenCalled();
      expect(onLocalChange).not.toHaveBeenCalled();
    },
  );

  it.each([
    [new NotSignedInError(), 'NOT_SIGNED_IN'],
    [new SessionLostError(), 'NOT_SIGNED_IN'],
    [new StorageLockedError(), 'STORAGE_UNAVAILABLE'],
    [new Error('boom'), 'INTERNAL_ERROR'],
  ])('upload maps %s', async (error, expected) => {
    const { tokens, handlers } = setup();
    tokens.request.mockRejectedValue(error);
    expect(await handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: expected },
    });
  });

  it('signed out (or the flag off): no API call, the handoff is still read and deleted', async () => {
    for (const over of [{ signedIn: () => Promise.resolve(false) }, { enabled: false }]) {
      const { tokens, handoff, handlers } = setup(over);
      expect(await handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
        error: { code: 'NOT_SIGNED_IN' },
      });
      expect(await handlers.fetchFile({ fingerprint: FP })).toMatchObject({
        error: { code: 'NOT_SIGNED_IN' },
      });
      expect(await handlers.removeFile({ fingerprint: FP })).toMatchObject({
        error: { code: 'NOT_SIGNED_IN' },
      });
      expect(tokens.request).not.toHaveBeenCalled();
      expect(tokens.requestBlob).not.toHaveBeenCalled();
      expect(handoff.take).toHaveBeenCalledTimes(1);
      expect(handoff.drop).toHaveBeenCalledWith(FP, 'upload');
    }
  });

  it('upload refuses a missing, empty or oversized handoff without a request', async () => {
    const missing = setup();
    missing.handoff.take.mockResolvedValue(null);
    expect(await missing.handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
    const empty = setup();
    empty.handoff.take.mockResolvedValue(new Blob([]));
    expect(await empty.handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: 'NOT_A_PDF' },
    });
    const big = setup({ maxFileBytes: 4 });
    expect(await big.handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: 'FILE_TOO_LARGE' },
    });
    for (const s of [missing, empty, big]) expect(s.tokens.request).not.toHaveBeenCalled();
  });

  it('a second upload of the same file while one runs is UPLOAD_IN_PROGRESS', async () => {
    const { tokens, handlers } = setup();
    let finish: (value: unknown) => void = () => undefined;
    tokens.request.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = handlers.upload({ fingerprint: FP, title: 'P' });
    await vi.waitFor(() => expect(tokens.request).toHaveBeenCalled());
    expect(await handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: 'UPLOAD_IN_PROGRESS' },
    });
    finish(view('stored'));
    expect(await first).toMatchObject({ ok: true });
  });

  it('upload fails when the server answers another document', async () => {
    const { tokens, handlers } = setup();
    tokens.request.mockResolvedValue(view('stored', 'b'.repeat(64)));
    expect(await handlers.upload({ fingerprint: FP, title: 'P' })).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    });
  });

  it('fetch bounds the download at 15 MiB and leaves the blob in the handoff store', async () => {
    const { tokens, handoff, handlers } = setup();
    tokens.requestBlob.mockResolvedValue(new Blob(['%PDF-1.7']));
    expect(await handlers.fetchFile({ fingerprint: FP })).toEqual({ ok: true, data: {} });
    expect(tokens.requestBlob).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: `/v1/documents/${FP}/file`,
        maxBytes: 15_728_640,
      }),
    );
    expect(handoff.put).toHaveBeenCalledWith(FP, expect.any(Blob), 'download');
  });

  it.each([
    ['NOT_FOUND', 404, 'NOT_FOUND'],
    ['FILE_TOO_LARGE', 413, 'FILE_TOO_LARGE'],
    ['UNAVAILABLE', 503, 'NETWORK_ERROR'],
  ] as const)('fetch maps %s and stores nothing', async (code, status, expected) => {
    const { tokens, handoff, handlers } = setup();
    tokens.requestBlob.mockRejectedValue(new ApiRequestError(code, status));
    expect(await handlers.fetchFile({ fingerprint: FP })).toMatchObject({
      error: { code: expected },
    });
    expect(handoff.put).not.toHaveBeenCalled();
  });

  it('remove file deletes, marks the document and treats an already-gone file as done', async () => {
    const { tokens, handoff, handlers } = setup();
    tokens.request.mockResolvedValue(undefined);
    expect(await handlers.removeFile({ fingerprint: FP })).toEqual({ ok: true, data: {} });
    expect(tokens.request).toHaveBeenCalledWith({
      method: 'DELETE',
      path: `/v1/documents/${FP}/file`,
    });
    expect(handoff.markStorage).toHaveBeenCalledWith(FP, 'none');
    tokens.request.mockRejectedValue(new ApiRequestError('NOT_FOUND', 404));
    expect(await handlers.removeFile({ fingerprint: FP })).toMatchObject({ ok: true });
    tokens.request.mockRejectedValue(new ApiRequestError('NETWORK', 0));
    expect(await handlers.removeFile({ fingerprint: FP })).toMatchObject({
      error: { code: 'NETWORK_ERROR' },
    });
  });

  it('long or ill-formed titles still upload, with a header the server accepts', async () => {
    for (const title of ['文'.repeat(300), 'a\uD800', '😀'.repeat(300), '']) {
      const { tokens, handlers } = setup();
      tokens.request.mockResolvedValue(view('stored'));
      expect(await handlers.upload({ fingerprint: FP, title })).toMatchObject({ ok: true });
      const { headers } = tokens.request.mock.calls[0]![0] as { headers: Record<string, string> };
      const value = headers['X-Clavis-Title'];
      if (title === '') expect(value).toBeUndefined();
      else {
        expect(value!.length).toBeLessThanOrEqual(1800);
        expect(() => decodeURIComponent(value!)).not.toThrow();
      }
    }
    expect(titleHeaders('a\uD800')).toEqual({ 'X-Clavis-Title': 'a%EF%BF%BD' });
    // Whole code points only: nothing is cut in the middle of a character.
    const cut = decodeURIComponent(titleHeaders('文'.repeat(300))['X-Clavis-Title']!);
    expect(cut).toBe('文'.repeat(cut.length));
    expect(cut.length).toBe(200);
  });

  it('every handler sweeps stale handoff entries before it works', async () => {
    const { tokens, handoff, handlers } = setup();
    tokens.request.mockResolvedValue(view('stored'));
    tokens.requestBlob.mockResolvedValue(new Blob(['%PDF']));
    await handlers.upload({ fingerprint: FP, title: 'P' });
    await handlers.fetchFile({ fingerprint: FP });
    await handlers.removeFile({ fingerprint: FP });
    expect(handoff.sweep).toHaveBeenCalledTimes(3);
  });

  it('operations on one file do not cancel each other', async () => {
    // A fetch whose put is refused (an upload owns the entry) fails without touching it.
    const a = setup();
    a.tokens.requestBlob.mockResolvedValue(new Blob(['%PDF']));
    a.handoff.put.mockResolvedValue(false);
    expect(await a.handlers.fetchFile({ fingerprint: FP })).toMatchObject({
      error: { code: 'UPLOAD_IN_PROGRESS' },
    });
    expect(a.handoff.drop).not.toHaveBeenCalled();
    // The upload only ever drops its own direction; remove-file drops nothing.
    const b = setup();
    b.tokens.request.mockResolvedValue(undefined);
    await b.handlers.removeFile({ fingerprint: FP });
    expect(b.handoff.drop).not.toHaveBeenCalled();
    const c = setup();
    c.tokens.request.mockRejectedValue(new ApiRequestError('NETWORK', 0));
    await c.handlers.upload({ fingerprint: FP, title: 'P' });
    expect(c.handoff.drop.mock.calls).toEqual([[FP, 'upload']]);
  });
});
