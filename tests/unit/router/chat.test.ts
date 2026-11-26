import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqError } from '../../../lib/ai/errors';
import { appendChatPair, listChat, MAX_MESSAGES_PER_WORD } from '../../../lib/data/chat';
import { STORE_NAMES, getAll, transact } from '../../../lib/data/db';
import { saveProgress } from '../../../lib/data/documents';
import { putWord, deleteWord } from '../../../lib/data/words';
import { LIBRARY_LIMITER_KEY } from '../../../lib/router/handlers/chat';
import { wordKey } from '../../../shared/api-contract/words';
import { sampleWord } from '../data/fixtures';
import {
  FAKE_KEY,
  KEY_MESSAGES,
  MODELS,
  REQ_A,
  REQ_B,
  SETTINGS_MESSAGES,
  contentSender,
  createHarness,
  makeReady,
  pageSender,
  panelSender,
  popupSender,
  type Harness,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST' } };
const library = () => pageSender('/library.html', 8);
const send = (key: string, message = 'Is it related to banco?', requestId = REQ_A) => ({
  v: 1,
  type: 'WORD_CHAT_SEND',
  requestId,
  wordKey: key,
  message,
});

let h: Harness;
let key: string;
beforeEach(async () => {
  h = createHarness();
  key = await wordKey('bank');
  await putWord(key, sampleWord(), { signedIn: () => Promise.resolve(false) });
});

describe('WORD_CHAT_SEND and WORD_CHAT_CANCEL senders (S-05: the library only)', () => {
  it.each([
    ['a content script', contentSender()],
    ['the reader', pageSender('/reader.html', 3)],
    ['the practice page', pageSender('/practice.html', 4)],
    ['the side panel', panelSender(5)],
    ['the popup', popupSender()],
    ['the options page', pageSender('/options.html')],
    ['the onboarding page', pageSender('/onboarding.html')],
  ])('refuses both from %s without calling Groq or writing', async (_n, sender) => {
    await makeReady(h);
    expect(await h.call(send(key), sender)).toMatchObject(INVALID);
    expect(
      await h.call({ v: 1, type: 'WORD_CHAT_CANCEL', requestId: REQ_A }, sender),
    ).toMatchObject(INVALID);
    expect(h.chatProvider.chat).not.toHaveBeenCalled();
    expect(await listChat(key)).toEqual([]);
  });

  it('accepts both from the library', async () => {
    await makeReady(h);
    expect(await h.call(send(key), library())).toMatchObject({ ok: true });
    expect(
      await h.call({ v: 1, type: 'WORD_CHAT_CANCEL', requestId: REQ_A }, library()),
    ).toMatchObject({
      ok: true,
      data: { cancelled: false },
    });
  });

  it('refuses a bad shape from the library', async () => {
    await makeReady(h);
    for (const bad of [
      { ...send(key), message: '' },
      { ...send(key), wordKey: 'nope' },
      { ...send(key), extra: 1 },
      { ...send(key), v: 9 },
    ]) {
      expect(await h.call(bad, library())).toMatchObject(INVALID);
    }
    expect(h.chatProvider.chat).not.toHaveBeenCalled();
  });
});

describe('ACCEPT_DISCLOSURE gets a separate allow rule for the library, and no other settings route does', () => {
  it('lets the library acknowledge the disclosure', async () => {
    expect(await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], library())).toMatchObject({
      ok: true,
    });
    expect((await h.settingsStore.getOnboarding()).disclosureAcceptedAt).not.toBeNull();
  });

  it('keeps every other settings and key route closed to the library', async () => {
    for (const [type, message] of Object.entries({ ...SETTINGS_MESSAGES, ...KEY_MESSAGES })) {
      if (type === 'ACCEPT_DISCLOSURE') continue;
      expect(await h.call(message, library()), `${type} from the library`).toMatchObject(INVALID);
    }
  });
});

describe('WORD_CHAT_SEND', () => {
  it('needs a key, then an acknowledged disclosure, before anything goes to Groq', async () => {
    expect(await h.call(send(key), library())).toMatchObject({
      ok: false,
      error: { code: 'SETUP_REQUIRED' },
    });
    await h.call(KEY_MESSAGES['SET_API_KEY'], pageSender('/options.html'));
    const reply = (await h.call(send(key), library())) as {
      error: { code: string; reason?: string };
    };
    expect(reply.error).toMatchObject({ code: 'SETUP_REQUIRED', reason: 'disclosure' });
    expect(h.chatProvider.chat).not.toHaveBeenCalled();
    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], library());
    expect(await h.call(send(key), library())).toMatchObject({ ok: true });
  });

  it("asks the provider with the key, the user's model and a prompt about the word, then stores both messages", async () => {
    await makeReady(h);
    h.chatProvider.chat.mockResolvedValueOnce({
      text: 'Yes: Spanish "banco".',
      model: 'openai/gpt-oss-20b',
    });
    const reply = (await h.call(send(key, 'Is it related to banco?'), library())) as {
      ok: boolean;
      data: {
        userMessageId: string;
        assistant: { id: string; role: string; content: string; model: string };
      };
    };
    expect(reply.ok).toBe(true);
    expect(reply.data.assistant).toMatchObject({
      role: 'assistant',
      content: 'Yes: Spanish "banco".',
      model: 'openai/gpt-oss-20b',
    });
    const [prompt, options] = h.chatProvider.chat.mock.calls[0]!;
    expect(options).toMatchObject({ apiKey: FAKE_KEY, model: 'openai/gpt-oss-20b' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(prompt[1]?.content).toContain('Is it related to banco?');
    expect(prompt[1]?.content).toContain('<word_feedface00000000>bank</word_feedface00000000>');
    expect(prompt[1]?.content).toContain('She went to the ');
    const stored = await listChat(key);
    expect(stored.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Is it related to banco?'],
      ['assistant', 'Yes: Spanish "banco".'],
    ]);
    expect(stored[0]?.id).toBe(reply.data.userMessageId);
    expect(stored[1]?.model).toBe('openai/gpt-oss-20b');
  });

  it('sends the earlier messages as history on the next question', async () => {
    await makeReady(h);
    await h.call(send(key, 'first question'), library());
    h.chatProvider.chat.mockClear();
    await h.call(send(key, 'second question'), library());
    const body = h.chatProvider.chat.mock.calls[0]![0][1]?.content ?? '';
    expect(body).toContain('User: first question');
    expect(body).toContain('Assistant: An answer.');
  });

  it('refuses a word that is not saved (NOT_FOUND) and one deleted meanwhile, writing nothing', async () => {
    await makeReady(h);
    expect(await h.call(send('a'.repeat(64)), library())).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    h.chatProvider.chat.mockImplementationOnce(async () => {
      await deleteWord(key, { signedIn: () => Promise.resolve(false) });
      return { text: 'late', model: MODELS[0]!.id };
    });
    expect(await h.call(send(key), library())).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(await listChat(key)).toEqual([]);
  });

  it('rejects the question that would take the word past 200 messages (LIMIT_EXCEEDED) before calling Groq', async () => {
    await makeReady(h);
    const at = { signedIn: () => Promise.resolve(false) };
    for (let i = 0; i < MAX_MESSAGES_PER_WORD / 2 - 1; i++) {
      await appendChatPair(
        key,
        [
          {
            id: crypto.randomUUID(),
            role: 'user',
            content: 'q',
            createdAt: 1_700_000_000_000 + i * 2,
          },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: 'a',
            model: 'm',
            createdAt: 1_700_000_000_001 + i * 2,
          },
        ],
        at,
      );
    }
    expect(await listChat(key)).toHaveLength(198);
    // 198 + 2 = 200 still fits...
    expect(await h.call(send(key, 'the 100th question'), library())).toMatchObject({ ok: true });
    expect(await listChat(key)).toHaveLength(200);
    h.chatProvider.chat.mockClear();
    // ...and the next one is refused without a paid call.
    expect(await h.call(send(key, 'one too many'), library())).toMatchObject({
      ok: false,
      error: { code: 'LIMIT_EXCEEDED' },
    });
    expect(h.chatProvider.chat).not.toHaveBeenCalled();
    expect(await listChat(key)).toHaveLength(200);
  });

  it('writes nothing when Groq fails, and maps the error (a rejected key is marked invalid)', async () => {
    await makeReady(h);
    h.chatProvider.chat.mockRejectedValueOnce(
      new GroqError('RATE_LIMITED', { retryAfterMs: 4000, status: 429 }),
    );
    expect(await h.call(send(key), library())).toMatchObject({
      ok: false,
      requestId: REQ_A,
      error: { code: 'RATE_LIMITED', retryAfterMs: 4000, httpStatus: 429 },
    });
    h.chatProvider.chat.mockRejectedValueOnce(new GroqError('INVALID_API_KEY', { status: 401 }));
    expect(await h.call(send(key, 'again', REQ_B), library())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_API_KEY' },
    });
    expect(await listChat(key)).toEqual([]);
    expect(await h.call(send(key, 'third'), library())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_API_KEY' },
    });
  });

  it('keeps no secret or provider text in a failure reply', async () => {
    await makeReady(h);
    h.chatProvider.chat.mockRejectedValueOnce(new Error(`boom ${FAKE_KEY}`));
    const reply = await h.call(send(key), library());
    expect(reply).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });

  it('can be cancelled by WORD_CHAT_CANCEL: nothing is written', async () => {
    await makeReady(h);
    let release: (() => void) | undefined;
    h.chatProvider.chat.mockImplementationOnce(
      (_m, { signal }) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ text: 'too late', model: MODELS[0]!.id });
          signal?.addEventListener('abort', () => reject(new GroqError('REQUEST_CANCELLED')));
        }),
    );
    const pending = h.send(send(key), library());
    await vi.waitFor(() => expect(h.chatProvider.chat).toHaveBeenCalled());
    expect(
      await h.call({ v: 1, type: 'WORD_CHAT_CANCEL', requestId: REQ_A }, library()),
    ).toMatchObject({
      ok: true,
      data: { cancelled: true },
    });
    expect(await pending.reply).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    release?.();
    expect(await listChat(key)).toEqual([]);
  });

  it('shares ONE guard bucket and one in-flight slot across library tabs (page:/library.html), 20 a minute', async () => {
    expect(LIBRARY_LIMITER_KEY).toBe('page:/library.html');
    await makeReady(h);
    const codes: string[] = [];
    for (let i = 0; i < 22; i++) {
      const tab = pageSender('/library.html', 100 + i);
      const reply = (await h.call(send(key, `q${i}`, crypto.randomUUID()), tab)) as {
        ok: boolean;
        error?: { code: string; reason?: string };
      };
      if (!reply.ok) codes.push(`${reply.error?.code}/${reply.error?.reason}`);
    }
    expect(codes.filter((c) => c === 'RATE_LIMITED/local-limit')).toHaveLength(2);
    expect(h.guard.buckets.size).toBe(1);
  });

  it('a newer question aborts the one still waiting (one in flight)', async () => {
    await makeReady(h);
    h.chatProvider.chat.mockImplementationOnce(
      (_m, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new GroqError('REQUEST_CANCELLED')));
        }),
    );
    const first = h.send(send(key, 'first'), library());
    await vi.waitFor(() => expect(h.chatProvider.chat).toHaveBeenCalled());
    expect(await h.call(send(key, 'second', REQ_B), pageSender('/library.html', 9))).toMatchObject({
      ok: true,
    });
    expect(await first.reply).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
  });
});

describe('S-09: the Groq key never reaches an IndexedDB record', () => {
  const dump = () =>
    transact([...STORE_NAMES], 'readonly', async (tx) => {
      const out: unknown[] = [];
      for (const name of STORE_NAMES) out.push(await getAll(tx.objectStore(name)));
      return JSON.stringify(out);
    });

  it('is in no stored word, message, document, highlight or hand-off after saving and chatting', async () => {
    const secret = 'gsk_ONLY_IN_THE_KEY_STORE_0123456789abcdef';
    await h.call(
      { ...(KEY_MESSAGES['SET_API_KEY'] as object), apiKey: secret },
      pageSender('/options.html'),
    );
    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], pageSender('/options.html'));
    await h.call(
      {
        v: 1,
        type: 'SAVE_WORD',
        snapshot: { selectionId: REQ_B, source: 'webpage', kind: 'word', text: 'river' },
        meaning: { title: 'river', summary: 'A stream.', model: 'm' },
      },
      contentSender(),
    );
    await saveProgress('f'.repeat(64), {
      title: 'Paper',
      pageCount: 3,
      fileBytes: 10,
      lastPage: 2,
      pageOffset: 0.1,
    });
    const riverKey = await wordKey('river');
    h.chatProvider.chat.mockResolvedValueOnce({ text: 'A stream of water.', model: MODELS[0]!.id });
    expect(await h.call(send(riverKey, 'What is a river?'), library())).toMatchObject({ ok: true });

    // The key went to the provider and nowhere else.
    expect(h.chatProvider.chat.mock.calls[0]![1].apiKey).toBe(secret);
    expect(JSON.stringify(h.chatProvider.chat.mock.calls[0]![0])).not.toContain(secret);
    const stored = await dump();
    expect(stored).toContain('What is a river?');
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain('apiKey');
    expect(stored).not.toContain('Bearer');
  });

  it('is not in a reply either', async () => {
    await makeReady(h);
    const reply = await h.call(send(key), library());
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });
});
