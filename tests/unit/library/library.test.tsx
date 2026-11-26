// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Library, tabFromHash } from '../../../components/library/Library';
import { buildWordsExport } from '../../../components/library/export';
import { filterWords } from '../../../components/library/SavedWords';
import { appendChatPair, listChat } from '../../../lib/data/chat';
import { saveProgress, getDocument } from '../../../lib/data/documents';
import { createIdbHighlightStore } from '../../../lib/data/highlights';
import { getWord, listWords, putWord } from '../../../lib/data/words';
import { createFakeBackend, installCatalog } from '../ui-client/support';
import { KEY_A, KEY_B, sampleWord } from '../data/fixtures';

const out = { signedIn: () => Promise.resolve(false) };
const NOW = 1_700_000_000_000;

async function seed() {
  await putWord(KEY_A, sampleWord({ text: 'bank', createdAt: NOW }), out);
  await putWord(
    KEY_B,
    sampleWord({
      text: 'river bend',
      createdAt: NOW + 5000,
      meaning: {
        title: 'river bend',
        summary: 'A curve in a river.',
        definition: 'A bend.',
        examples: [{ sentence: 'We camped at the bend.' }],
        caveat: 'Maybe idiomatic.',
        model: 'm',
      },
      source: { kind: 'pdf', fingerprint: 'c'.repeat(64), title: 'Geography', page: 3 },
      contextBefore: undefined as never,
      contextAfter: undefined as never,
    }),
    out,
  );
}

type Handler = (message: { type: string; [key: string]: unknown }) => unknown;
let handler: Handler;
const sent: { type: string; [key: string]: unknown }[] = [];

beforeEach(() => {
  installCatalog();
  sent.length = 0;
  handler = () => ({ ok: false, error: { code: 'INVALID_REQUEST', message: 'x' } });
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { type: string }) => {
    sent.push(message);
    return Promise.resolve(handler(message));
  }) as never);
  window.location.hash = '';
});
afterEach(() => cleanup());

describe('tabFromHash', () => {
  it('opens the documents tab only for #documents', () => {
    expect(tabFromHash('#documents')).toBe('documents');
    expect(tabFromHash('')).toBe('words');
    expect(tabFromHash('#anything')).toBe('words');
  });
});

describe('Library shell', () => {
  it('has labelled tabs that follow the arrow keys, Home and End', async () => {
    const user = userEvent.setup();
    render(<Library />);
    const words = screen.getByRole('tab', { name: 'Saved words' });
    const docs = screen.getByRole('tab', { name: 'Documents' });
    expect(screen.getByRole('tablist', { name: 'Library sections' })).toBeInTheDocument();
    expect(words).toHaveAttribute('aria-selected', 'true');
    expect(docs).toHaveAttribute('tabindex', '-1');
    words.focus();
    await user.keyboard('{ArrowRight}');
    expect(docs).toHaveAttribute('aria-selected', 'true');
    expect(docs).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveAttribute(
      'aria-labelledby',
      'library-tab-documents',
    );
    await user.keyboard('{Home}');
    expect(words).toHaveFocus();
    await user.keyboard('{End}');
    expect(docs).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(words).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the documents tab from the URL fragment', () => {
    window.location.hash = '#documents';
    render(<Library />);
    expect(screen.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Saved words', () => {
  it('says how to save a word when there are none', async () => {
    render(<Library />);
    expect(await screen.findByTestId('library-words-empty')).toHaveTextContent(
      'No saved words yet',
    );
  });

  it('lists words newest first, searches them and shows the meaning, context and source', async () => {
    await seed();
    const user = userEvent.setup();
    render(<Library />);
    const items = await screen.findAllByTestId('library-item');
    expect(items.map((i) => within(i).getByText(/bank|river bend/).textContent)).toEqual([
      'river bend',
      'bank',
    ]);
    expect(screen.getByTestId('library-count')).toHaveTextContent('2 saved');

    await user.type(screen.getByRole('searchbox', { name: 'Search saved words' }), 'CURVE');
    expect(screen.getAllByTestId('library-item')).toHaveLength(1);
    await user.clear(screen.getByRole('searchbox'));
    await user.type(screen.getByRole('searchbox'), 'zzz');
    expect(screen.getByTestId('library-no-match')).toHaveTextContent(
      'No saved word matches "zzz".',
    );
    await user.clear(screen.getByRole('searchbox'));

    await user.click(screen.getAllByTestId('library-item')[1]!);
    const detail = screen.getByTestId('library-detail');
    expect(within(detail).getByRole('heading', { level: 2, name: 'bank' })).toBeInTheDocument();
    expect(detail).toHaveTextContent('A financial institution.');
    expect(detail).toHaveTextContent('She went to the bank to deposit money.');
    expect(within(detail).getByTestId('library-source')).toHaveTextContent('A story');
    expect(within(detail).getByTestId('library-source')).toHaveTextContent(
      'https://example.com/story',
    );

    await user.click(screen.getAllByTestId('library-item')[0]!);
    expect(screen.getByTestId('library-source')).toHaveTextContent('Geography, page 3');
    expect(screen.getByTestId('library-detail')).toHaveTextContent('Maybe idiomatic.');
  });

  it('shows model output only as text, never as markup', async () => {
    await putWord(
      KEY_A,
      sampleWord({
        meaning: { title: '<img src=x onerror=alert(1)>', summary: '<b>bold</b>', model: 'm' },
      }),
      out,
    );
    const user = userEvent.setup();
    render(<Library />);
    await user.click(await screen.findByTestId('library-item'));
    const detail = screen.getByTestId('library-detail');
    expect(detail.querySelector('img')).toBeNull();
    expect(detail.querySelector('b')).toBeNull();
    expect(detail).toHaveTextContent('<b>bold</b>');
  });

  it('filterWords matches text, title and summary', async () => {
    await seed();
    const words = await listWords();
    expect(filterWords(words, '').length).toBe(2);
    expect(filterWords(words, 'financial').map((w) => w.text)).toEqual(['bank']);
    expect(filterWords(words, '  RIVER ').map((w) => w.text)).toEqual(['river bend']);
  });

  it('confirms before opening the source page, shows the address, and opens it with noopener', async () => {
    await seed();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Library />);
    await user.click((await screen.findAllByTestId('library-item'))[1]!);
    await user.click(screen.getByTestId('library-open-source'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('https://example.com/story');
    expect(screen.getByTestId('library-dialog-cancel')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(open).not.toHaveBeenCalled();

    await user.click(screen.getByTestId('library-open-source'));
    // A click right after the dialog appeared is ignored (the same guard as the reader's link dialog).
    await user.click(screen.getByTestId('library-dialog-confirm'));
    expect(open).not.toHaveBeenCalled();
    await user.click(screen.getByTestId('library-dialog-cancel'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('opens the page after the guard window, in a new tab with noopener and noreferrer', async () => {
    await seed();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const user = userEvent.setup();
    render(<Library />);
    await user.click((await screen.findAllByTestId('library-item'))[1]!);
    await user.click(screen.getByTestId('library-open-source'));
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now + 1000);
    await user.click(screen.getByTestId('library-dialog-confirm'));
    expect(open).toHaveBeenCalledWith('https://example.com/story', '_blank', 'noopener,noreferrer');
  });

  it('deletes a word and its chat after a confirmation, and says so', async () => {
    await seed();
    await appendChatPair(
      KEY_A,
      [
        {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          content: 'q',
          createdAt: NOW + 1,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          role: 'assistant',
          content: 'a',
          model: 'm',
          createdAt: NOW + 2,
        },
      ],
      out,
    );
    const user = userEvent.setup();
    render(<Library />);
    await user.click((await screen.findAllByTestId('library-item'))[1]!);
    await user.click(screen.getByTestId('library-delete'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete "bank"?');
    await user.click(screen.getByTestId('library-dialog-cancel'));
    expect(await getWord(KEY_A)).toBeDefined();

    await user.click(screen.getByTestId('library-delete'));
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    await user.click(screen.getByTestId('library-dialog-confirm'));
    await waitFor(async () => expect(await getWord(KEY_A)).toBeUndefined());
    expect(await listChat(KEY_A)).toEqual([]);
    await waitFor(() => expect(screen.getAllByTestId('library-item')).toHaveLength(1));
    expect(screen.getByText('Deleted "bank".')).toBeInTheDocument();
    expect(screen.queryByTestId('library-detail')).toBeNull();
  });

  it('exports the saved words and their chats as JSON, without sync bookkeeping', async () => {
    await seed();
    await appendChatPair(
      KEY_A,
      [
        {
          id: '00000000-0000-4000-8000-000000000001',
          role: 'user',
          content: 'Why?',
          createdAt: NOW + 1,
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          role: 'assistant',
          content: 'Because.',
          model: 'm',
          createdAt: NOW + 2,
        },
      ],
      out,
    );
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((blob: Blob) => (blobs.push(blob), 'blob:x'));
    URL.revokeObjectURL = vi.fn();
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(<Library />);
    await screen.findAllByTestId('library-item');
    await user.click(screen.getByTestId('library-export'));
    await waitFor(() => expect(click).toHaveBeenCalled());
    const data = JSON.parse(await blobs[0]!.text());
    expect(data).toMatchObject({ format: 'clavis-saved-words', version: 1 });
    expect(data.words.map((w: { text: string }) => w.text)).toEqual(['bank', 'river bend']);
    expect(data.words[0].chat.map((m: { content: string }) => m.content)).toEqual([
      'Why?',
      'Because.',
    ]);
    const text = JSON.stringify(data);
    for (const field of ['dirty', 'rev', 'clientModifiedAt', 'seq"', 'deleted'])
      expect(text).not.toContain(field);
    expect(
      await screen.findByText('Exported 2 saved words and 2 chat messages.'),
    ).toBeInTheDocument();
  });
});

describe('buildWordsExport', () => {
  it('orders words and messages oldest first and omits absent fields', async () => {
    await seed();
    const words = await listWords();
    const result = buildWordsExport(words, [], NOW);
    expect(result.words.map((w) => w.text)).toEqual(['bank', 'river bend']);
    expect(result.exportedAt).toBe(new Date(NOW).toISOString());
    expect(result.words[1]).not.toHaveProperty('contextBefore');
    expect(result.words[0]!.chat).toEqual([]);
  });
});

describe('Chat about a saved word', () => {
  const answer =
    (content = 'It comes from Italian.') =>
    async (message: { type: string; requestId?: string; wordKey?: string; message?: string }) => {
      if (message.type !== 'WORD_CHAT_SEND') return { ok: true, data: { cancelled: true } };
      await appendChatPair(
        message.wordKey!,
        [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            role: 'user',
            content: message.message!,
            createdAt: NOW + 10,
          },
          {
            id: '00000000-0000-4000-8000-0000000000a2',
            role: 'assistant',
            content: content,
            model: 'openai/gpt-oss-20b',
            createdAt: NOW + 11,
          },
        ],
        out,
      );
      return {
        ok: true,
        requestId: message.requestId,
        data: {
          userMessageId: '00000000-0000-4000-8000-0000000000a1',
          assistant: {
            id: '00000000-0000-4000-8000-0000000000a2',
            role: 'assistant',
            content,
            model: 'm',
            createdAt: NOW + 11,
          },
        },
      };
    };

  async function openChat() {
    await putWord(KEY_A, sampleWord(), out);
    const user = userEvent.setup();
    render(<Library />);
    await user.click(await screen.findByTestId('library-item'));
    return user;
  }

  it('sends a question from the library and shows both messages from IndexedDB', async () => {
    handler = answer('It comes from Italian "banca".');
    const user = await openChat();
    const input = screen.getByRole('textbox', { name: 'Your question' });
    expect(input).toHaveAttribute('maxlength', '2000');
    expect(await screen.findByText(/Ask a follow-up question/)).toBeInTheDocument();
    expect(screen.getByTestId('library-chat-send')).toBeDisabled();
    await user.type(input, 'Where does it come from?');
    await user.click(screen.getByTestId('library-chat-send'));
    const log = await screen.findByRole('log', { name: 'Chat about bank' });
    await waitFor(() => expect(log).toHaveTextContent('Where does it come from?'));
    expect(log).toHaveTextContent('It comes from Italian "banca".');
    expect(sent.find((m) => m.type === 'WORD_CHAT_SEND')).toMatchObject({
      v: 1,
      type: 'WORD_CHAT_SEND',
      wordKey: KEY_A,
      message: 'Where does it come from?',
    });
    expect(input).toHaveValue('');
    expect(await screen.findByText('Answer received.')).toBeInTheDocument();
  });

  it('renders an answer as text with its line breaks, never as markup', async () => {
    handler = answer('Line one\n<b>not bold</b>');
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'x');
    await user.click(screen.getByTestId('library-chat-send'));
    const log = await screen.findByRole('log');
    await waitFor(() => expect(log).toHaveTextContent('<b>not bold</b>'));
    expect(log.querySelector('b')).toBeNull();
  });

  it('sends with Ctrl+Enter', async () => {
    handler = answer();
    const user = await openChat();
    await user.type(
      screen.getByRole('textbox', { name: 'Your question' }),
      'Hi{Control>}{Enter}{/Control}',
    );
    await waitFor(() => expect(sent.some((m) => m.type === 'WORD_CHAT_SEND')).toBe(true));
  });

  it('shows the one-time disclosure when it is owed, accepts it, and sends again', async () => {
    let first = true;
    const ok = answer();
    handler = (message) => {
      if (message.type === 'ACCEPT_DISCLOSURE') return { ok: true, data: {} };
      if (first && message.type === 'WORD_CHAT_SEND') {
        first = false;
        return { ok: false, error: { code: 'SETUP_REQUIRED', message: 'x', reason: 'disclosure' } };
      }
      return ok(message as never);
    };
    // ACCEPT_DISCLOSURE replies with the settings snapshot; the page only needs ok.
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Why?');
    await user.click(screen.getByTestId('library-chat-send'));
    const prompt = await screen.findByTestId('library-disclosure');
    expect(prompt).toHaveTextContent('Send this to Groq?');
    expect(prompt).toHaveTextContent('using your own key');
    // Declining sends nothing more.
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('library-disclosure')).toBeNull();
    expect(sent.filter((m) => m.type === 'WORD_CHAT_SEND')).toHaveLength(1);
  });

  it('confirms the disclosure with ACCEPT_DISCLOSURE and then resends the same question', async () => {
    let first = true;
    const ok = answer();
    const fake = createFakeBackend();
    handler = (message) => {
      if (message.type === 'ACCEPT_DISCLOSURE') return fake.handle(message);
      if (first && message.type === 'WORD_CHAT_SEND') {
        first = false;
        return { ok: false, error: { code: 'SETUP_REQUIRED', message: 'x', reason: 'disclosure' } };
      }
      return ok(message as never);
    };
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Why?');
    await user.click(screen.getByTestId('library-chat-send'));
    await user.click(await screen.findByTestId('library-disclosure-confirm'));
    await waitFor(() => expect(sent.filter((m) => m.type === 'WORD_CHAT_SEND')).toHaveLength(2));
    expect(sent.map((m) => m.type)).toContain('ACCEPT_DISCLOSURE');
    expect(sent.filter((m) => m.type === 'WORD_CHAT_SEND').map((m) => m.message)).toEqual([
      'Why?',
      'Why?',
    ]);
  });

  it('keeps the question and offers Settings when no key is connected', async () => {
    handler = () => ({ ok: false, error: { code: 'SETUP_REQUIRED', message: 'x' } });
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Why?');
    await user.click(screen.getByTestId('library-chat-send'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect your Groq key');
    expect(screen.getByRole('textbox', { name: 'Your question' })).toHaveValue('Why?');
    await user.click(screen.getByRole('button', { name: 'Connect Groq' }));
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/options\.html#section-key$/),
    });
  });

  it('stops a question that is waiting: tells the background and ignores a late answer', async () => {
    let finish: (reply: unknown) => void = () => undefined;
    handler = (message) =>
      message.type === 'WORD_CHAT_SEND'
        ? new Promise((resolve) => (finish = resolve))
        : { ok: true, data: { cancelled: true } };
    const user = await openChat();
    await user.type(screen.getByRole('textbox', { name: 'Your question' }), 'Why?');
    await user.click(screen.getByTestId('library-chat-send'));
    expect(await screen.findByTestId('library-chat-asking')).toHaveTextContent('Asking…');
    await user.click(screen.getByTestId('library-chat-stop'));
    const request = sent.find((m) => m.type === 'WORD_CHAT_SEND')!;
    expect(sent.at(-1)).toMatchObject({
      type: 'WORD_CHAT_CANCEL',
      requestId: request['requestId'],
    });
    expect(await screen.findByText('Stopped. Nothing was saved.')).toBeInTheDocument();
    finish({
      ok: true,
      data: {
        userMessageId: '00000000-0000-4000-8000-0000000000a1',
        assistant: {
          id: '00000000-0000-4000-8000-0000000000a2',
          role: 'assistant',
          content: 'late',
          model: 'm',
          createdAt: 1,
        },
      },
    });
    await Promise.resolve();
    expect(screen.queryByText('late')).toBeNull();
    expect(screen.getByTestId('library-chat-send')).toBeEnabled();
  });

  it('says a full chat is full instead of offering the box (200 messages)', async () => {
    await putWord(KEY_A, sampleWord(), out);
    for (let i = 0; i < 99; i++) {
      await appendChatPair(
        KEY_A,
        [
          { id: crypto.randomUUID(), role: 'user', content: `q${i}`, createdAt: NOW + i * 2 },
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: `a${i}`,
            model: 'm',
            createdAt: NOW + i * 2 + 1,
          },
        ],
        out,
      );
    }
    const user = userEvent.setup();
    render(<Library />);
    await user.click(await screen.findByTestId('library-item'));
    // 198 messages: one more pair still fits.
    expect(await screen.findByTestId('library-chat-input')).toBeInTheDocument();
    await appendChatPair(
      KEY_A,
      [
        { id: crypto.randomUUID(), role: 'user', content: 'q', createdAt: NOW + 500 },
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'a',
          model: 'm',
          createdAt: NOW + 501,
        },
      ],
      out,
    );
    expect(await screen.findByTestId('library-chat-full')).toHaveTextContent(
      'limit of 200 messages',
    );
    expect(screen.queryByTestId('library-chat-input')).toBeNull();
  });
});

describe('Documents', () => {
  it('lists documents by recency with progress and highlight counts, and links to the reader', async () => {
    const fp1 = '1'.repeat(64);
    const fp2 = '2'.repeat(64);
    await saveProgress(
      fp1,
      { title: 'Old paper', pageCount: 10, fileBytes: 5, lastPage: 3, pageOffset: 0.2 },
      { ...out, now: () => NOW },
    );
    await saveProgress(
      fp2,
      { title: null, pageCount: null, fileBytes: null, lastPage: 7, pageOffset: 0 },
      { ...out, now: () => NOW + 1000 },
    );
    await createIdbHighlightStore(out).add(fp1, [
      {
        id: '00000000-0000-4000-8000-000000000011',
        page: 1,
        start: 0,
        end: 3,
        color: 'blue',
        createdAt: NOW,
      },
      {
        id: '00000000-0000-4000-8000-000000000012',
        page: 2,
        start: 0,
        end: 3,
        color: 'pink',
        createdAt: NOW,
      },
    ]);
    window.location.hash = '#documents';
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const user = userEvent.setup();
    render(<Library />);
    const docs = await screen.findAllByTestId('library-doc');
    expect(docs).toHaveLength(2);
    expect(docs[0]).toHaveTextContent('Untitled PDF');
    expect(docs[0]).toHaveTextContent('Page 7');
    expect(docs[0]).toHaveTextContent('0 highlights');
    expect(docs[1]).toHaveTextContent('Old paper');
    expect(docs[1]).toHaveTextContent('Page 3 of 10');
    expect(docs[1]).toHaveTextContent('2 highlights');
    expect(screen.getByTestId('library-docs-count')).toHaveTextContent('2 documents');
    await user.click(
      within(docs[1]!).getByRole('button', { name: 'Open the reader to continue Old paper' }),
    );
    expect(create).toHaveBeenCalledWith({ url: expect.stringMatching(/\/reader\.html$/) });
  });

  it('removes a document with its highlights after a confirmation', async () => {
    const fp = '1'.repeat(64);
    await saveProgress(
      fp,
      { title: 'Old paper', pageCount: 10, fileBytes: 5, lastPage: 3, pageOffset: 0.2 },
      out,
    );
    await createIdbHighlightStore(out).add(fp, [
      {
        id: '00000000-0000-4000-8000-000000000011',
        page: 1,
        start: 0,
        end: 3,
        color: 'blue',
        createdAt: NOW,
      },
    ]);
    window.location.hash = '#documents';
    const user = userEvent.setup();
    render(<Library />);
    await user.click(
      await screen.findByRole('button', { name: 'Remove Old paper from the library' }),
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'The PDF file itself is not touched.',
    );
    await user.click(screen.getByTestId('library-dialog-cancel'));
    expect(await getDocument(fp)).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Remove Old paper from the library' }));
    vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 1000);
    await user.click(screen.getByTestId('library-dialog-confirm'));
    await waitFor(async () => expect(await getDocument(fp)).toBeUndefined());
    expect(await createIdbHighlightStore(out).list(fp)).toEqual([]);
    expect(await screen.findByTestId('library-docs-empty')).toBeInTheDocument();
  });

  it('says what the tab is for when there is nothing yet', async () => {
    window.location.hash = '#documents';
    render(<Library />);
    expect(await screen.findByTestId('library-docs-empty')).toHaveTextContent('No documents yet');
  });
});
