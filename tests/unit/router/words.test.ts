import { beforeEach, describe, expect, it } from 'vitest';
import { listWords, getWord } from '../../../lib/data/words';
import { parseWordMessage, parseLibraryMessage } from '../../../lib/contracts/words';
import { reduceUrl } from '../../../lib/router/handlers/words';
import { wordKey } from '../../../shared/api-contract/words';
import {
  REQ_A,
  REQ_B,
  contentSender,
  createHarness,
  pageSender,
  panelSender,
  popupSender,
  type Harness,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST' } };
const FP = 'e'.repeat(64);

const meaning = {
  title: 'bank',
  summary: 'A financial institution.',
  contextualMeaning: 'Where she keeps money.',
  definition: 'An organisation that holds money.',
  examples: [{ sentence: 'The bank opens at nine.', note: 'Noun.' }, { sentence: 'I bank there.' }],
  caveat: 'Could also be a river bank.',
  model: 'openai/gpt-oss-20b',
};
const snapshot = (over: object = {}) => ({
  selectionId: REQ_B,
  source: 'webpage',
  kind: 'word',
  text: 'Bank',
  contextBefore: 'She went to the ',
  contextAfter: ' to deposit money.',
  languageHint: 'en',
  ...over,
});
const save = (over: object = {}) => ({
  v: 1,
  type: 'SAVE_WORD',
  snapshot: snapshot(),
  meaning,
  ...over,
});
const pdfSnapshot = snapshot({ source: 'pdf', page: 4 });

describe('SAVE_WORD sender rules', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it.each([
    ['a content script', contentSender(5)],
    ['the reader (with a pdf)', pageSender('/reader.html', 3)],
    ['the practice page', pageSender('/practice.html', 4)],
    ['the side panel', panelSender(5)],
  ])('%s may save, UNSAVE and ask GET_WORD_SAVED', async (name, sender) => {
    const reader = name.startsWith('the reader');
    const message = reader
      ? save({ snapshot: pdfSnapshot, pdf: { fingerprint: FP, title: 'Paper' } })
      : save();
    const reply = (await h.call(message, sender)) as { ok: boolean; data: { wordKey: string } };
    expect(reply.ok).toBe(true);
    expect(reply.data.wordKey).toBe(await wordKey('bank'));
    expect(await h.call({ v: 1, type: 'GET_WORD_SAVED', text: 'BANK ' }, sender)).toMatchObject({
      ok: true,
      data: { saved: true, wordKey: reply.data.wordKey },
    });
    expect(
      await h.call({ v: 1, type: 'UNSAVE_WORD', wordKey: reply.data.wordKey }, sender),
    ).toMatchObject({
      ok: true,
      data: { removed: true },
    });
    expect(await h.call({ v: 1, type: 'GET_WORD_SAVED', text: 'bank' }, sender)).toMatchObject({
      data: { saved: false },
    });
  });

  it.each([
    ['the options page', pageSender('/options.html')],
    ['the onboarding page', pageSender('/onboarding.html')],
    ['the popup', popupSender()],
    ['the library', pageSender('/library.html')],
    ['an unknown extension page', { id: contentSender().id, url: 'chrome-extension://x/y.html' }],
  ])('refuses all three routes from %s and saves nothing', async (_name, sender) => {
    expect(await h.call(save(), sender)).toMatchObject(INVALID);
    expect(await h.call({ v: 1, type: 'UNSAVE_WORD', wordKey: FP }, sender)).toMatchObject(INVALID);
    expect(await h.call({ v: 1, type: 'GET_WORD_SAVED', text: 'bank' }, sender)).toMatchObject(
      INVALID,
    );
    expect(await listWords()).toEqual([]);
  });

  it('refuses sentences and passages, over-long text and a stray key', async () => {
    for (const bad of [
      save({ snapshot: snapshot({ kind: 'sentence' }) }),
      save({ snapshot: snapshot({ kind: 'passage' }) }),
      save({ snapshot: snapshot({ kind: 'phrase', text: 'x'.repeat(201) }) }),
      save({ extra: 1 }),
      save({ meaning: { ...meaning, extra: 'x' } }),
      save({ meaning: { ...meaning, summary: 'x'.repeat(601) } }),
      save({ source: { kind: 'webpage', url: 'https://evil.example/', title: 't' } }),
      save({ url: 'https://evil.example/' }),
      { ...save(), v: 2 },
    ]) {
      expect(await h.call(bad, contentSender())).toMatchObject(INVALID);
    }
    expect(await listWords()).toEqual([]);
  });
});

describe('SAVE_WORD source derivation (never from the payload for webpages)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  const sourceOf = async (): Promise<unknown> => (await listWords())[0]?.source;

  it("takes a content script's source from sender.tab, reduced to origin + path", async () => {
    await h.call(save(), {
      ...contentSender(5, 'https://frame.example/embed'),
      tab: {
        id: 5,
        url: 'https://news.example/a/story?token=SECRET&x=1#section',
        title: '  The   story  ',
      },
    } as never);
    expect(await sourceOf()).toEqual({
      kind: 'webpage',
      url: 'https://news.example/a/story',
      title: 'The story',
    });
    expect(JSON.stringify(await listWords())).not.toContain('SECRET');
  });

  it('keeps no address for a tab that is not http(s) or has none', async () => {
    await h.call(save(), {
      ...contentSender(5),
      tab: { id: 5, url: 'file:///etc/passwd' },
    } as never);
    expect(await sourceOf()).toEqual({ kind: 'webpage', url: null, title: null });
  });

  it('refuses a pdf part from a content script, the practice page and the side panel', async () => {
    const withPdf = save({ pdf: { fingerprint: FP, title: 'x' } });
    expect(await h.call(withPdf, contentSender())).toMatchObject(INVALID);
    expect(
      await h.call({ ...withPdf, snapshot: pdfSnapshot }, pageSender('/practice.html')),
    ).toMatchObject(INVALID);
    expect(await h.call({ ...withPdf, snapshot: pdfSnapshot }, panelSender(5))).toMatchObject(
      INVALID,
    );
    expect(await listWords()).toEqual([]);
  });

  it("requires the pdf part and snapshot.page from the reader, and uses only the reader's own pdf", async () => {
    const reader = pageSender('/reader.html', 3);
    expect(await h.call(save({ snapshot: pdfSnapshot }), reader)).toMatchObject(INVALID); // no pdf
    expect(
      await h.call(
        save({ snapshot: snapshot({ source: 'pdf' }), pdf: { fingerprint: FP, title: 'P' } }),
        reader,
      ),
    ).toMatchObject(INVALID); // no page
    expect(await h.call(save({ pdf: { fingerprint: FP, title: 'P' } }), reader)).toMatchObject(
      INVALID,
    ); // not a pdf selection
    expect(await listWords()).toEqual([]);

    expect(
      await h.call(
        save({ snapshot: pdfSnapshot, pdf: { fingerprint: FP, title: 'Paper' } }),
        reader,
      ),
    ).toMatchObject({ ok: true });
    expect(await sourceOf()).toEqual({ kind: 'pdf', fingerprint: FP, title: 'Paper', page: 4 });
    // A reader that could not hash the file saves with a null fingerprint.
    await h.call(
      save({
        snapshot: { ...pdfSnapshot, text: 'river' },
        pdf: { fingerprint: null, title: null },
      }),
      reader,
    );
    expect((await getWord(await wordKey('river')))?.source).toEqual({
      kind: 'pdf',
      fingerprint: null,
      title: null,
      page: 4,
    });
  });

  it('gives the practice page a webpage source with no address', async () => {
    await h.call(save(), pageSender('/practice.html', 4));
    expect(await sourceOf()).toEqual({ kind: 'webpage', url: null, title: null });
  });

  it("asks chrome.tabs for the side panel's own tab and nothing the message says", async () => {
    await h.call(save(), panelSender(42));
    expect(h.tabsGet).toHaveBeenCalledWith(42);
    expect(await sourceOf()).toEqual({
      kind: 'webpage',
      url: 'https://news.example/story',
      title: 'The story',
    });
  });

  it("has no source address when the panel's tab cannot be read", async () => {
    h.tabsGet.mockRejectedValueOnce(new Error('No tab'));
    await h.call(save(), panelSender(42));
    expect(await sourceOf()).toEqual({ kind: 'webpage', url: null, title: null });
  });

  it("keeps a PDF selection's page for the panel, with no fingerprint", async () => {
    await h.call(save({ snapshot: pdfSnapshot }), panelSender(5));
    expect(await sourceOf()).toEqual({ kind: 'pdf', fingerprint: null, title: null, page: 4 });
    expect(h.tabsGet).not.toHaveBeenCalled();
  });

  it('refuses a PDF page the shared schema would refuse (page > 5000)', async () => {
    const reader = pageSender('/reader.html', 3);
    expect(
      await h.call(
        save({ snapshot: { ...pdfSnapshot, page: 5001 }, pdf: { fingerprint: FP, title: 'P' } }),
        reader,
      ),
    ).toMatchObject(INVALID);
  });

  it('stores what the shared WordData schema accepts: text, language, context, meaning, createdAt', async () => {
    await h.call(save(), contentSender());
    const [word] = await listWords();
    expect(word).toMatchObject({
      wordKey: await wordKey('Bank'),
      text: 'Bank',
      language: 'en',
      contextBefore: 'She went to the ',
      contextAfter: ' to deposit money.',
      meaning,
      dirty: 0,
    });
    expect(Number.isInteger(word!.createdAt)).toBe(true);
  });

  it('re-saving replaces meaning, context and source and keeps the key', async () => {
    await h.call(save(), contentSender());
    await h.call(
      save({
        snapshot: snapshot({ text: ' bank ', contextBefore: 'new ' }),
        meaning: { ...meaning, summary: 'Newer.' },
      }),
      pageSender('/practice.html', 4),
    );
    const words = await listWords();
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({
      contextBefore: 'new ',
      meaning: { summary: 'Newer.' },
      source: { url: null },
      rev: 2,
    });
  });

  it('limits one sender to 30 saves a minute', async () => {
    let limited = 0;
    for (let i = 0; i < 32; i++) {
      const reply = (await h.call(
        save({ snapshot: snapshot({ text: `word${i}` }) }),
        contentSender(),
      )) as {
        error?: { code: string };
      };
      if (reply.error?.code === 'RATE_LIMITED') limited++;
    }
    expect(limited).toBe(2);
  });
});

describe('route schemas', () => {
  it('are strict, versioned and bounded', () => {
    expect(parseWordMessage({ v: 1, type: 'UNSAVE_WORD', wordKey: 'a'.repeat(64) }).ok).toBe(true);
    expect(parseWordMessage({ v: 1, type: 'UNSAVE_WORD', wordKey: 'A'.repeat(64) }).ok).toBe(false);
    expect(parseWordMessage({ v: 1, type: 'UNSAVE_WORD', wordKey: 'a'.repeat(64), x: 1 }).ok).toBe(
      false,
    );
    expect(parseWordMessage({ v: 1, type: 'GET_WORD_SAVED', text: '   ' }).ok).toBe(false);
    expect(parseWordMessage({ v: 1, type: 'GET_WORD_SAVED', text: 'x'.repeat(201) }).ok).toBe(
      false,
    );
    expect(parseWordMessage({ v: 1, type: 'WORD_CHAT_SEND' }).ok).toBe(false);

    const send = {
      v: 1,
      type: 'WORD_CHAT_SEND',
      requestId: REQ_A,
      wordKey: 'a'.repeat(64),
      message: 'hi',
    };
    expect(parseLibraryMessage(send).ok).toBe(true);
    expect(parseLibraryMessage({ ...send, message: '' }).ok).toBe(false);
    expect(parseLibraryMessage({ ...send, message: ' '.repeat(5) }).ok).toBe(false);
    expect(parseLibraryMessage({ ...send, message: 'x'.repeat(2001) }).ok).toBe(false);
    expect(parseLibraryMessage({ ...send, extra: true }).ok).toBe(false);
    expect(parseLibraryMessage({ ...send, requestId: 'nope' }).ok).toBe(false);
    expect(parseLibraryMessage({ v: 1, type: 'WORD_CHAT_CANCEL', requestId: REQ_A }).ok).toBe(true);
    expect(parseLibraryMessage({ v: 1, type: 'WORD_CHAT_CANCEL' }).ok).toBe(false);
    expect(parseLibraryMessage({ v: 1, type: 'SYNC_KICK' }).ok).toBe(true);
    expect(parseLibraryMessage({ v: 1, type: 'SYNC_KICK', pull: true }).ok).toBe(true);
    expect(parseLibraryMessage({ v: 1, type: 'SYNC_KICK', pull: false }).ok).toBe(false);
    expect(parseLibraryMessage({ v: 1, type: 'SYNC_KICK', extra: 1 }).ok).toBe(false);
    // The two families never accept each other's types.
    expect(parseWordMessage({ v: 1, type: 'SYNC_KICK' }).ok).toBe(false);
    expect(parseLibraryMessage({ v: 1, type: 'GET_WORD_SAVED', text: 'a' }).ok).toBe(false);
  });

  it('refuses an oversized body before parsing it', () => {
    const huge = save({ snapshot: snapshot({ contextBefore: 'x'.repeat(40_000) }) });
    expect(parseWordMessage(huge).ok).toBe(false);
  });
});

describe('reduceUrl', () => {
  it.each([
    ['https://a.example/p?q=1#h', 'https://a.example/p'],
    ['http://user:pw@a.example:8080/x/y', 'http://a.example:8080/x/y'],
    ['https://a.example', 'https://a.example/'],
    ['chrome://settings', null],
    ['javascript:alert(1)', null],
    ['not a url', null],
    [undefined, null],
  ])('%s -> %s', (input, expected) => {
    expect(reduceUrl(input)).toBe(expected);
  });
});

describe('SYNC_KICK and the library senders', () => {
  const kick = { v: 1, type: 'SYNC_KICK' };
  it.each([
    ['the reader', pageSender('/reader.html', 3)],
    ['the library', pageSender('/library.html', 8)],
    ['the options page', pageSender('/options.html')],
  ])('accepts SYNC_KICK from %s (a no-op for now)', async (_n, sender) => {
    expect(await createHarness().call(kick, sender)).toMatchObject({ ok: true });
    expect(await createHarness().call({ ...kick, pull: true }, sender)).toMatchObject({ ok: true });
  });

  it.each([
    ['a content script', contentSender()],
    ['the popup', popupSender()],
    ['the side panel', panelSender(5)],
    ['the practice page', pageSender('/practice.html', 4)],
    ['the onboarding page', pageSender('/onboarding.html')],
  ])('refuses SYNC_KICK from %s', async (_n, sender) => {
    expect(await createHarness().call(kick, sender)).toMatchObject(INVALID);
  });
});

describe('content scripts may only touch words of their own origin (M-1)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  const tab = (id: number, url: string, extra: object = {}) =>
    ({ ...contentSender(id, url), tab: { id, url, ...extra } }) as never;
  const unsave = (key: string) => ({ v: 1, type: 'UNSAVE_WORD', wordKey: key });
  const reader = () => pageSender('/reader.html', 3);

  it('cannot UNSAVE a reader-saved word or a word from another origin; the record is unchanged', async () => {
    await h.call(
      save({ snapshot: pdfSnapshot, pdf: { fingerprint: FP, title: 'Paper' } }),
      reader(),
    );
    const key = await wordKey('Bank');
    const before = await getWord(key);
    expect(await h.call(unsave(key), tab(7, 'https://news.example/a'))).toMatchObject(INVALID);
    expect(await getWord(key)).toEqual(before);

    await h.call(save({ snapshot: snapshot({ text: 'river' }) }), tab(5, 'https://one.example/x'));
    const rKey = await wordKey('river');
    const rBefore = await getWord(rKey);
    expect(await h.call(unsave(rKey), tab(7, 'https://two.example/x'))).toMatchObject(INVALID);
    expect(await getWord(rKey)).toEqual(rBefore);
  });

  it("a content SAVE does not replace a PDF-sourced word (or another origin's) and says so", async () => {
    await h.call(
      save({ snapshot: pdfSnapshot, pdf: { fingerprint: FP, title: 'Paper' } }),
      reader(),
    );
    const key = await wordKey('Bank');
    const before = await getWord(key);
    const reply = await h.call(
      save({ meaning: { ...meaning, summary: 'Overwritten!' } }),
      tab(7, 'https://news.example/a'),
    );
    expect(reply).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(await getWord(key)).toEqual(before);
    expect((await getWord(key))?.meaning.summary).toBe('A financial institution.');
  });

  it('GET_WORD_SAVED says saved only for words of the same origin', async () => {
    await h.call(save(), tab(5, 'https://one.example/x'));
    const ask = { v: 1, type: 'GET_WORD_SAVED', text: 'bank' };
    expect(await h.call(ask, tab(7, 'https://one.example/other?q=1'))).toMatchObject({
      data: { saved: true },
    });
    expect(await h.call(ask, tab(7, 'https://two.example/x'))).toMatchObject({
      data: { saved: false },
    });
    // The extension's own pages keep seeing every word.
    expect(await h.call(ask, pageSender('/practice.html', 4))).toMatchObject({
      data: { saved: true },
    });
  });

  it('a same-origin content sender still toggles normally', async () => {
    const sender = (id: number) => tab(id, 'https://one.example/x');
    expect(await h.call(save(), sender(5))).toMatchObject({ ok: true });
    expect(
      await h.call(save({ meaning: { ...meaning, summary: 'Newer.' } }), sender(8)),
    ).toMatchObject({ ok: true });
    expect((await listWords())[0]?.meaning.summary).toBe('Newer.');
    expect(await h.call(unsave(await wordKey('Bank')), sender(5))).toMatchObject({
      ok: true,
      data: { removed: true },
    });
    expect(await listWords()).toEqual([]);
  });

  it('extension senders keep the current behaviour (the reader may replace a webpage word)', async () => {
    await h.call(save(), tab(5, 'https://one.example/x'));
    expect(
      await h.call(save({ snapshot: pdfSnapshot, pdf: { fingerprint: FP, title: 'P' } }), reader()),
    ).toMatchObject({ ok: true });
    expect((await listWords())[0]?.source.kind).toBe('pdf');
  });

  it('the 31st UNSAVE in a minute from one tab is RATE_LIMITED (other tabs are not)', async () => {
    const codes: string[] = [];
    for (let i = 0; i < 31; i++) {
      const reply = (await h.call(unsave('c'.repeat(64)), tab(7, 'https://one.example/x'))) as {
        error?: { code: string };
      };
      codes.push(reply.error?.code ?? 'ok');
    }
    expect(codes.slice(0, 30).every((c) => c === 'ok')).toBe(true);
    expect(codes[30]).toBe('RATE_LIMITED');
    expect(await h.call(unsave('c'.repeat(64)), tab(8, 'https://one.example/x'))).toMatchObject({
      ok: true,
    });
  });

  it('the 61st GET_WORD_SAVED in a minute from one tab is RATE_LIMITED', async () => {
    let last: unknown;
    for (let i = 0; i < 61; i++) {
      last = await h.call(
        { v: 1, type: 'GET_WORD_SAVED', text: 'bank' },
        tab(7, 'https://one.example/x'),
      );
      if (i < 60) expect(last).toMatchObject({ ok: true });
    }
    expect(last).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
  });
});

describe('incognito saves keep no source address (L-2)', () => {
  it('a content sender in an incognito tab stores url and title as null', async () => {
    const h = createHarness();
    await h.call(save(), {
      ...contentSender(5),
      tab: { id: 5, url: 'https://secret.example/p', title: 'Private', incognito: true },
    } as never);
    expect((await listWords())[0]).toMatchObject({
      text: 'Bank',
      meaning: { title: 'bank' },
      contextBefore: 'She went to the ',
      source: { kind: 'webpage', url: null, title: null },
    });
  });

  it('the side panel of an incognito tab does the same', async () => {
    const h = createHarness();
    h.tabsGet.mockResolvedValueOnce({
      url: 'https://secret.example/p',
      title: 'Private',
      incognito: true,
    } as never);
    await h.call(save(), panelSender(42));
    expect((await listWords())[0]?.source).toEqual({ kind: 'webpage', url: null, title: null });
  });
});

describe('titles are cut by code points (L-3)', () => {
  it('a 301-emoji tab title keeps whole surrogate pairs and fits the shared limit', async () => {
    const h = createHarness();
    await h.call(save(), {
      ...contentSender(5),
      tab: { id: 5, url: 'https://e.example/p', title: '😀'.repeat(301) },
    } as never);
    const title = (await listWords())[0]!.source as { title: string };
    expect(title.title).toBe('😀'.repeat(150));
    expect(title.title.length).toBeLessThanOrEqual(300);
    expect(/[\uD800-\uDBFF]$/.test(title.title)).toBe(false);
  });
});

describe('deleted words do not count against the word limit (I-2)', () => {
  it('a tombstone is not counted', async () => {
    const { putWord, deleteWord, MAX_WORDS } = await import('../../../lib/data/words');
    const { transact, STORE } = await import('../../../lib/data/db');
    const on = { signedIn: () => Promise.resolve(true) };
    await transact([STORE.words], 'readwrite', (tx) => {
      const store = tx.objectStore(STORE.words);
      for (let i = 0; i < MAX_WORDS; i++) {
        store.put({
          ...sampleW(),
          wordKey: i.toString(16).padStart(64, '0'),
          clientModifiedAt: 1,
          seq: null,
          dirty: 0,
          rev: 1,
          deleted: 0,
        });
      }
    });
    await expect(putWord('f'.repeat(64), sampleW(), on)).rejects.toThrow('word-limit');
    await deleteWord((0).toString(16).padStart(64, '0'), on); // now a tombstone
    await expect(putWord('f'.repeat(64), sampleW(), on)).resolves.toBeDefined();
  });
});
function sampleW() {
  return {
    text: 'x',
    meaning: { title: 'x', summary: 'y', model: 'm' },
    source: { kind: 'webpage' as const, url: null, title: null },
    createdAt: 1_700_000_000_000,
  };
}
