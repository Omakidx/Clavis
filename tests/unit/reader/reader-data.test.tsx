// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ContinueReading,
  PROGRESS_DEBOUNCE_MS,
  ReaderResume,
} from '../../../components/reader/ReaderData';
import { getDocument, saveProgress } from '../../../lib/data/documents';
import type { PdfReaderController, ReaderSnapshot } from '../../../lib/pdf/controller';
import { EMPTY_STATE, titleFromFileName } from '../../../lib/pdf/state';
import { installCatalog } from '../ui-client/support';

const FP = 'a'.repeat(64);
const out = { signedIn: () => Promise.resolve(false) };

function fakeController(overrides: Record<string, unknown> = {}) {
  const position = { page: 1, pageOffset: 0 };
  const controller = {
    documentId: FP,
    fileBytes: 4096,
    getPosition: vi.fn(() => ({ ...position })),
    restorePosition: vi.fn((to: { page: number; pageOffset: number }) => {
      Object.assign(position, to);
      return true;
    }),
    ...overrides,
  };
  return { controller: controller as unknown as PdfReaderController, position, fn: controller };
}

const snapshotOf = (over: Partial<ReaderSnapshot> = {}, page = 1): ReaderSnapshot => ({
  state: { phase: 'ready', name: 'Big Paper.PDF', pageCount: 12, page, zoom: 1 },
  view: { pageCount: 12, page, zoom: 1, scaleValue: 'page-width' },
  find: { state: 'idle', current: 0, total: 0 } as never,
  renderCount: 1,
  pageErrors: 0,
  annotationsLimited: false,
  fileName: 'Big Paper.PDF',
  ...over,
});

function mount(controller: PdfReaderController, snapshot = snapshotOf(), documentKey = 1) {
  const container = document.createElement('div');
  document.body.append(container);
  const ref = { current: container };
  const view = render(
    <ReaderResume
      controller={controller}
      containerRef={ref}
      snapshot={snapshot}
      documentKey={documentKey}
    />,
  );
  return { container, view, ref };
}

beforeEach(() => {
  installCatalog();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('titleFromFileName', () => {
  it.each([
    ['Paper.pdf', 'Paper'],
    ['Big Paper.PDF', 'Big Paper'],
    ['archive.tar.pdf', 'archive.tar'],
    ['notes', 'notes'],
    ['.pdf', null],
    ['   .pdf', null],
    ['', null],
  ])('%s -> %s', (name, title) => {
    expect(titleFromFileName(name)).toBe(title);
  });

  it('cuts a long title at the record limit (300)', () => {
    expect(titleFromFileName(`${'x'.repeat(400)}.pdf`)).toHaveLength(300);
  });
});

describe('ReaderResume: reading progress', () => {
  it('records the document (title without .pdf, page count, file size) when a file opens', async () => {
    const { controller } = fakeController();
    mount(controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    expect(await getDocument(FP)).toMatchObject({
      title: 'Big Paper',
      pageCount: 12,
      fileBytes: 4096,
      lastPage: 1,
      pageOffset: 0,
    });
  });

  it('restores the saved place when lastPage > 1 and offers Back to start', async () => {
    await saveProgress(
      FP,
      { title: 'Big Paper', pageCount: 12, fileBytes: 4096, lastPage: 7, pageOffset: 0.4 },
      out,
    );
    const { controller, fn } = fakeController();
    const user = userEvent.setup();
    mount(controller);
    expect(await screen.findByTestId('reader-resumed')).toHaveTextContent(
      'Continued where you stopped, on page 7.',
    );
    expect(fn.restorePosition).toHaveBeenCalledWith({ page: 7, pageOffset: 0.4 });
    await user.click(screen.getByRole('button', { name: 'Back to start' }));
    expect(fn.restorePosition).toHaveBeenLastCalledWith({ page: 1, pageOffset: 0 });
    expect(screen.queryByTestId('reader-resumed')).toBeNull();
  });

  it('can dismiss the note, and says nothing for a document read only to page 1', async () => {
    await saveProgress(
      FP,
      { title: 't', pageCount: 3, fileBytes: 1, lastPage: 4, pageOffset: 0 },
      out,
    );
    const { controller } = fakeController();
    const user = userEvent.setup();
    mount(controller);
    await user.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('reader-resumed')).toBeNull();
    cleanup();

    const other = '9'.repeat(64);
    await saveProgress(
      other,
      { title: 't', pageCount: 3, fileBytes: 1, lastPage: 1, pageOffset: 0.3 },
      out,
    );
    const second = fakeController({ documentId: other });
    mount(second.controller);
    await waitFor(() => expect(second.fn.getPosition).toHaveBeenCalled());
    expect(second.fn.restorePosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reader-resumed')).toBeNull();
  });

  it('does nothing when no fingerprint could be computed or no document shows', async () => {
    const none = fakeController({ documentId: null });
    mount(none.controller);
    const idle = fakeController();
    mount(idle.controller, snapshotOf({ state: EMPTY_STATE, view: null, fileName: '' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(none.fn.restorePosition).not.toHaveBeenCalled();
    expect(idle.fn.getPosition).not.toHaveBeenCalled();
    expect(screen.queryByTestId('reader-resumed')).toBeNull();
  });

  it('saves 2 seconds after the last scroll (debounced), not before', async () => {
    const { controller, position } = fakeController();
    const { container } = mount(controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    position.page = 3;
    position.pageOffset = 0.5;
    container.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    position.page = 4;
    container.dispatchEvent(new Event('scroll')); // the timer restarts
    vi.advanceTimersByTime(PROGRESS_DEBOUNCE_MS - 1);
    expect((await getDocument(FP))?.lastPage).toBe(1);
    vi.advanceTimersByTime(1);
    vi.useRealTimers();
    await waitFor(async () => expect((await getDocument(FP))?.lastPage).toBe(4));
    expect((await getDocument(FP))?.pageOffset).toBe(0.5);
  });

  it('saves at once when the tab is hidden and on pagehide', async () => {
    const { controller, position } = fakeController();
    mount(controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    position.page = 5;
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 30));
    expect((await getDocument(FP))?.lastPage).toBe(1); // visible: nothing
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(async () => expect((await getDocument(FP))?.lastPage).toBe(5));
    position.page = 6;
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(async () => expect((await getDocument(FP))?.lastPage).toBe(6));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('saves the last known place when the file is replaced (the controller has already let go)', async () => {
    const { controller, position, fn } = fakeController();
    const { container, view } = mount(controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    position.page = 9;
    container.dispatchEvent(new Event('scroll'));
    fn.getPosition.mockReturnValue(null as never); // the controller was reset by the next openFile
    view.rerender(
      <ReaderResume
        controller={controller}
        containerRef={{ current: container }}
        snapshot={snapshotOf()}
        documentKey={2}
      />,
    );
    await waitFor(async () => expect((await getDocument(FP))?.lastPage).toBe(9));
  });

  it('does not write while nothing changed, and never throws when storage fails', async () => {
    const { container } = mount(fakeController().controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    const before = (await getDocument(FP))!.rev;
    window.dispatchEvent(new Event('pagehide'));
    container.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 30));
    expect((await getDocument(FP))!.rev).toBe(before);
    const original = globalThis.indexedDB;
    // @ts-expect-error simulate IndexedDB being unavailable
    globalThis.indexedDB = undefined;
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
    await new Promise((r) => setTimeout(r, 30));
    globalThis.indexedDB = original;
  });
});

describe('ContinueReading', () => {
  it('lists recently read PDFs with their progress and a button that opens the file picker', async () => {
    await saveProgress(
      '1'.repeat(64),
      { title: 'Old', pageCount: 10, fileBytes: 1, lastPage: 3, pageOffset: 0 },
      { ...out, now: () => 1_700_000_000_000 },
    );
    await saveProgress(
      '2'.repeat(64),
      { title: null, pageCount: null, fileBytes: null, lastPage: 8, pageOffset: 0 },
      { ...out, now: () => 1_700_000_100_000 },
    );
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ContinueReading onOpen={onOpen} />);
    const list = await screen.findByTestId('reader-continue');
    expect(list).toHaveTextContent('Continue reading');
    const items = list.querySelectorAll('li');
    expect(items[0]).toHaveTextContent('Untitled PDF');
    expect(items[0]).toHaveTextContent('Page 8');
    expect(items[1]).toHaveTextContent('Old');
    expect(items[1]).toHaveTextContent('Page 3 of 10');
    await user.click(screen.getByRole('button', { name: 'Open Old again' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows nothing when there is no progress to continue from (only highlights, or nothing)', async () => {
    const { container } = render(<ContinueReading onOpen={() => undefined} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('Clear all data (L-1)', () => {
  it('an open reader does not write its progress back afterwards', async () => {
    const { clearClavisStorage } = await import('../../../lib/storage');
    const { listDocuments } = await import('../../../lib/data/documents');
    const { resetClearedForTests } = await import('../../../components/reader/ReaderData');
    const { MemoryArea } = await import('../storage/memory-area');
    resetClearedForTests();
    const { controller, position } = fakeController();
    mount(controller);
    await waitFor(async () => expect(await getDocument(FP)).toBeDefined());
    await clearClavisStorage([new MemoryArea()]);
    await new Promise((r) => setTimeout(r, 50)); // the channel message arrives
    position.page = 4;
    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 50));
    expect(await listDocuments()).toEqual([]);
    resetClearedForTests();
  });
});
