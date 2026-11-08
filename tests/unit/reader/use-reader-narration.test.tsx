// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReaderNarration } from '../../../components/reader/useReaderNarration';
import type { ReaderPageText } from '../../../lib/pdf/reader-text';

const { speakMock, settingsMock, stopMock, messageListeners } = vi.hoisted(() => ({
  speakMock: vi.fn(),
  settingsMock: vi.fn(),
  stopMock: vi.fn(),
  messageListeners: [] as ((message: unknown, sender: { id: string; url: string }) => unknown)[],
}));
vi.mock('wxt/browser', () => ({
  browser: {
    i18n: { getMessage: (key: string) => key },
    runtime: {
      id: 'test-extension',
      getURL: (path: string) => `chrome-extension://test-extension${path}`,
      onMessage: {
        addListener: (
          listener: (message: unknown, sender: { id: string; url: string }) => unknown,
        ) => messageListeners.push(listener),
        removeListener: (
          listener: (message: unknown, sender: { id: string; url: string }) => unknown,
        ) => {
          const index = messageListeners.indexOf(listener);
          if (index >= 0) messageListeners.splice(index, 1);
        },
      },
    },
  },
}));
vi.mock('../../../lib/pdf/reader-speech', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/pdf/reader-speech')>(
    '../../../lib/pdf/reader-speech',
  );
  return {
    ...actual,
    readerSpeech: { getPublicSettings: settingsMock, speak: speakMock, stopSpeaking: stopMock },
  };
});

const model = (page: number, text: string): ReaderPageText => ({
  page,
  text,
  runs: [{ index: 0, start: 0, end: text.length }],
  paragraphs: [{ start: 0, end: text.length }],
});
const controller = (pages: ReaderPageText[]) =>
  ({
    readPageText: vi.fn(async (page: number) => pages.find((item) => item.page === page) ?? null),
    getSnapshot: vi.fn(() => ({ view: { page: 1 } })),
    goToPage: vi.fn(),
  }) as never;
const settings = { ok: true, data: { ttsRate: 1 } };
const acceptedSpeak = { ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } };
const background = { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' };
const send = (
  type: 'TTS_BOUNDARY' | 'TTS_EVENT',
  requestId: string,
  extra: Record<string, unknown> = {},
) => {
  for (const listener of messageListeners) {
    listener({ v: 1, type, requestId, ...extra }, background);
  }
};
const lastSpeak = () => speakMock.mock.calls.at(-1)![0] as { requestId: string; text: string };

beforeEach(() => {
  messageListeners.length = 0;
  speakMock.mockReset().mockResolvedValue(acceptedSpeak);
  settingsMock.mockReset().mockResolvedValue(settings);
  stopMock.mockReset().mockResolvedValue({ ok: true, data: { stopped: true } });
});
afterEach(cleanup);

describe('useReaderNarration', () => {
  it('advances to the next page only after an ended event', async () => {
    const pages = [model(1, 'page one text'), model(2, 'page two text')];
    const containerRef = { current: document.createElement('div') };
    const hook = renderHook(() => useReaderNarration(controller(pages), containerRef, 1, 0, 2));
    await act(async () => hook.result.current.start('range', 1, 2));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    const first = lastSpeak();
    act(() => send('TTS_EVENT', first.requestId, { state: 'ended' }));
    await waitFor(() => expect(speakMock.mock.calls).toHaveLength(2));
    expect(lastSpeak().text).toBe('page two text');
    expect(hook.result.current.page).toBe(2);
  });

  it('skips pages without readable text in a requested page range', async () => {
    const pages = [model(1, ' \n '), model(2, 'page two text')];
    const hook = renderHook(() =>
      useReaderNarration(controller(pages), { current: document.createElement('div') }, 1, 0, 2),
    );
    await act(async () => hook.result.current.start('range', 1, 2));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    expect(lastSpeak().text).toBe('page two text');
    expect(hook.result.current.page).toBe(2);
  });

  it('treats cancellation as an error and never starts the next page', async () => {
    const pages = [model(1, 'page one text'), model(2, 'page two text')];
    const hook = renderHook(() =>
      useReaderNarration(controller(pages), { current: document.createElement('div') }, 1, 0, 2),
    );
    await act(async () => hook.result.current.start('range', 1, 2));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    act(() => send('TTS_EVENT', lastSpeak().requestId, { state: 'cancelled' }));
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(speakMock.mock.calls).toHaveLength(1);
  });

  it('resumes at the last real word boundary after pause', async () => {
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'first second third')]),
        { current: document.createElement('div') },
        1,
        0,
        1,
      ),
    );
    act(() => {
      void hook.result.current.start('range', 1, 1);
    });
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    const first = lastSpeak();
    act(() => send('TTS_BOUNDARY', first.requestId, { charIndex: 6 }));
    act(() => hook.result.current.pause());
    expect(hook.result.current.status).toBe('paused');
    await act(async () => hook.result.current.resume());
    await waitFor(() => expect(speakMock.mock.calls).toHaveLength(2));
    expect(lastSpeak().text).toBe('second third');
  });

  it('does not reclaim a stopped session when a pending speak reply arrives late', async () => {
    let finish!: (reply: typeof acceptedSpeak) => void;
    speakMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'text')]),
        { current: document.createElement('div') },
        1,
        0,
        1,
      ),
    );
    await act(async () => hook.result.current.start('range', 1, 1));
    await waitFor(() => expect(speakMock).toHaveBeenCalled());
    act(() => hook.result.current.stop());
    await act(async () => finish(acceptedSpeak));
    expect(hook.result.current.status).toBe('idle');
    expect(stopMock).toHaveBeenCalled();
  });

  it('cancels startup when paused while public settings are still pending', async () => {
    let finish!: (reply: typeof settings) => void;
    settingsMock.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'text')]),
        { current: document.createElement('div') },
        1,
        0,
        1,
      ),
    );
    act(() => {
      void hook.result.current.start('range', 1, 1);
    });
    await waitFor(() => expect(settingsMock).toHaveBeenCalled());
    act(() => hook.result.current.pause());
    await act(async () => finish(settings));
    expect(hook.result.current.status).toBe('idle');
    expect(speakMock).not.toHaveBeenCalled();
  });

  it('speaks only the requested page range and fails invalid range bounds without a speech request', async () => {
    const pages = [model(1, 'one'), model(2, 'two'), model(3, 'three')];
    const hook = renderHook(() =>
      useReaderNarration(controller(pages), { current: document.createElement('div') }, 1, 0, 3),
    );
    await act(async () => hook.result.current.start('range', 2, 2));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    expect(lastSpeak().text).toBe('two');
    act(() => send('TTS_EVENT', lastSpeak().requestId, { state: 'ended' }));
    await waitFor(() => expect(hook.result.current.status).toBe('complete'));
    expect(speakMock.mock.calls).toHaveLength(1);

    await act(async () => hook.result.current.start('range', 0, 9));
    expect(hook.result.current.status).toBe('error');
    expect(speakMock.mock.calls).toHaveLength(1);
  });

  it('speaks only the selected page-local offsets', async () => {
    const container = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset['pageNumber'] = '1';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const span = document.createElement('span');
    span.setAttribute('role', 'presentation');
    span.dir = 'ltr';
    span.textContent = 'first second third';
    textLayer.append(span);
    page.append(textLayer);
    container.append(page);
    document.body.append(container);
    const text = span.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 12);
    selection.addRange(range);
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'first second third')]),
        { current: container },
        1,
        0,
        1,
      ),
    );
    await act(async () => hook.result.current.start('selection', 1, 1));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    expect(lastSpeak().text).toBe('second');
    selection.removeAllRanges();
  });

  it('normalizes PDF Kangxi radicals before speech without changing source offsets', async () => {
    const container = document.createElement('div');
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset['pageNumber'] = '1';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    const span = document.createElement('span');
    span.setAttribute('role', 'presentation');
    span.dir = 'ltr';
    span.textContent = '⽇本語';
    textLayer.append(span);
    page.append(textLayer);
    container.append(page);
    document.body.append(container);
    const text = span.firstChild!;
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent!.length);
    selection.removeAllRanges();
    selection.addRange(range);
    const hook = renderHook(() =>
      useReaderNarration(controller([model(1, '⽇本語')]), { current: container }, 1, 0, 1),
    );

    await act(async () => hook.result.current.start('selection', 1, 1));
    await waitFor(() => expect(hook.result.current.status).toBe('playing'));
    expect(lastSpeak().text).toBe('日本語');
    expect(lastSpeak().text.length).toBe(text.textContent!.length);
    selection.removeAllRanges();
  });

  it('reports a rejected speech start and does not leave playback active', async () => {
    speakMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'NO_VOICE', message: 'No voice.' },
    });
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'text')]),
        { current: document.createElement('div') },
        1,
        0,
        1,
      ),
    );
    await act(async () => hook.result.current.start('range', 1, 1));
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(hook.result.current.error).toBe('readerListenNoVoice');
  });

  it('stops a possibly started speech request when its reply is lost', async () => {
    speakMock.mockRejectedValueOnce(new Error('reply lost'));
    const hook = renderHook(() =>
      useReaderNarration(
        controller([model(1, 'text')]),
        { current: document.createElement('div') },
        1,
        0,
        1,
      ),
    );
    await act(async () => hook.result.current.start('range', 1, 1));
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(stopMock).toHaveBeenCalledWith(lastSpeak().requestId);
  });

  it('reports extraction errors without attempting speech', async () => {
    const hook = renderHook(() =>
      useReaderNarration(controller([]), { current: document.createElement('div') }, 1, 0, 1),
    );
    await act(async () => hook.result.current.start('range', 1, 1));
    await waitFor(() => expect(hook.result.current.status).toBe('error'));
    expect(speakMock).not.toHaveBeenCalled();
  });
});
