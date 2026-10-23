// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { PasswordPrompt } from '../../../components/reader/PasswordPrompt';
import { LinkConfirm, OPEN_GUARD_MS } from '../../../components/reader/LinkConfirm';
import { StateMessage } from '../../../components/reader/StateMessage';
import type { ReaderState } from '../../../lib/pdf/state';

// t() resolves keys through browser.i18n; echo the key (and substitutions) so assertions are exact.
// restoreMocks is on globally, so the spy is installed before every test.
beforeEach(() => {
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(
    ((key: string, subs?: string | string[]) =>
      `${key}${subs === undefined ? '' : `(${[subs].flat().join(',')})`}`) as never,
  );
});

const renderState = (state: ReaderState, dragging = false) =>
  render(<StateMessage state={state} dragging={dragging} />);

describe('StateMessage', () => {
  it('explains the reader when empty, and names the drop target while dragging', () => {
    const { unmount } = renderState({ phase: 'empty' });
    const empty = screen.getByTestId('state-empty');
    expect(empty).toHaveTextContent('readerEmptyTitle');
    expect(empty).toHaveTextContent('readerEmptyBody');
    expect(empty).toHaveTextContent('readerEmptyHint');
    // Why Chrome's own viewer cannot host Clavis, and how to get the file here.
    expect(empty).toHaveTextContent('readerEmptyChrome');
    expect(empty).toHaveTextContent('readerShortcutsHint');
    unmount();
    renderState({ phase: 'empty' }, true);
    expect(screen.getByTestId('state-empty')).toHaveTextContent('readerDropActive');
  });

  it('offers the file picker from the empty state and from an error', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(
      <StateMessage state={{ phase: 'empty' }} dragging={false} onOpen={onOpen} />,
    );
    await user.click(screen.getByRole('button', { name: 'readerEmptyChoose' }));
    unmount();
    render(
      <StateMessage
        state={{ phase: 'error', code: 'CORRUPT', message: 'x' }}
        dragging={false}
        onOpen={onOpen}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'readerChooseAnother' }));
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('shows read progress while loading', () => {
    renderState({ phase: 'loading', name: 'big.pdf', progress: 0.42 });
    const bar = screen.getByTestId('state-progress');
    expect(bar).toHaveAttribute('value', '42');
    expect(bar).toHaveAttribute('aria-label', 'readerLoading(big.pdf)');
  });

  it('announces loading with the file name', () => {
    renderState({ phase: 'loading', name: 'book.pdf' });
    expect(screen.getByRole('status')).toHaveTextContent('readerLoading(book.pdf)');
  });

  it.each([
    ['CORRUPT', 'readerErrorCorrupt'],
    ['PERMISSION', 'readerErrorPermission'],
    ['UNSUPPORTED', 'readerErrorUnsupported'],
    ['RENDER', 'readerErrorRender'],
  ] as const)('shows a distinct alert for %s', (code, key) => {
    renderState({ phase: 'error', code, message: 'diagnostic' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(key);
    expect(alert).toHaveAttribute('data-code', code);
  });

  it('puts the limit in MB into the too-large message', () => {
    renderState({ phase: 'error', code: 'TOO_LARGE', message: 'x' });
    expect(screen.getByRole('alert')).toHaveTextContent('readerErrorTooLarge(100)');
  });

  it('names the page limit when a document has too many pages', () => {
    renderState({ phase: 'error', code: 'TOO_LARGE', message: 'x', limit: 'pages' });
    expect(screen.getByRole('alert')).toHaveTextContent('readerErrorTooManyPages(5000)');
  });

  it('says image-only without claiming selectable text', () => {
    renderState({ phase: 'image-only', name: 'scan.pdf', pageCount: 3 });
    expect(screen.getByTestId('state-image-only')).toHaveTextContent('readerImageOnly');
  });

  it('renders nothing for ready (the pages themselves are the content)', () => {
    const { container } = renderState({
      phase: 'ready',
      name: 'a.pdf',
      pageCount: 1,
      page: 1,
      zoom: 1,
    });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('PasswordPrompt', () => {
  it('submits the typed password once and clears the field', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <PasswordPrompt
        fileName="locked.pdf"
        incorrect={false}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    const input = screen.getByLabelText('readerPasswordLabel');
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveFocus();
    await user.type(input, 'hunter2{Enter}');
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('hunter2');
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not submit an empty password', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <PasswordPrompt fileName="a.pdf" incorrect={false} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    await user.click(screen.getByRole('button', { name: 'readerPasswordSubmit' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('flags a wrong password with an alert and aria-invalid', () => {
    render(<PasswordPrompt fileName="a.pdf" incorrect onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('readerPasswordIncorrect');
    expect(screen.getByLabelText('readerPasswordLabel')).toHaveAttribute('aria-invalid', 'true');
  });

  it('cancel calls onCancel', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(
      <PasswordPrompt fileName="a.pdf" incorrect={false} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    await user.click(screen.getByRole('button', { name: 'readerPasswordCancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('LinkConfirm', () => {
  it('shows the URL as text, focuses Cancel and cancels with Escape', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(<LinkConfirm url="https://example.com/<b>x</b>" onAnswer={onAnswer} />);
    // The URL is a text node: no element is created from it.
    expect(screen.getByTestId('link-confirm').querySelector('b')).toBeNull();
    expect(screen.getByTestId('link-confirm')).toHaveTextContent(
      'readerLinkConfirmBody(https://example.com/<b>x</b>)',
    );
    expect(screen.getByRole('button', { name: 'readerLinkCancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
  });

  it('opens only on the explicit button and keeps Tab inside the dialog', async () => {
    const onAnswer = vi.fn();
    const user = userEvent.setup();
    render(<LinkConfirm url="https://example.com/" onAnswer={onAnswer} />);
    // Cancel is last in order: Tab wraps to Open, Shift+Tab wraps back.
    await user.tab();
    expect(screen.getByRole('button', { name: 'readerLinkOpen' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'readerLinkCancel' })).toHaveFocus();
    // Keyboard activation is immediate; pointer clicks are guarded (see the guard tests below).
    screen.getByRole('button', { name: 'readerLinkOpen' }).focus();
    await user.keyboard('{Enter}');
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(true);
  });

  describe('double-click guard (MEDIUM-1)', () => {
    afterEach(() => vi.useRealTimers());

    it('ignores pointer clicks on Open right after the dialog appears, and any part of a multi-click', async () => {
      const onAnswer = vi.fn();
      render(<LinkConfirm url="https://example.com/" onAnswer={onAnswer} />);
      const open = screen.getByRole('button', { name: 'readerLinkOpen' });
      // The second click of a double click lands here almost at once.
      fireEvent.click(open, { detail: 1 });
      fireEvent.click(open, { detail: 2 });
      fireEvent.click(open, { detail: 3 });
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it('accepts a deliberate single click after the guard time, but never a multi-click', async () => {
      vi.useFakeTimers();
      const onAnswer = vi.fn();
      render(<LinkConfirm url="https://example.com/" onAnswer={onAnswer} />);
      const open = screen.getByRole('button', { name: 'readerLinkOpen' });
      await vi.advanceTimersByTimeAsync(OPEN_GUARD_MS + 50);
      fireEvent.click(open, { detail: 2 });
      expect(onAnswer).not.toHaveBeenCalled();
      fireEvent.click(open, { detail: 1 });
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('keyboard activation (detail 0) works immediately', () => {
      const onAnswer = vi.fn();
      render(<LinkConfirm url="https://example.com/" onAnswer={onAnswer} />);
      fireEvent.click(screen.getByRole('button', { name: 'readerLinkOpen' }), { detail: 0 });
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith(true);
    });

    it('Cancel is never delayed', () => {
      const onAnswer = vi.fn();
      render(<LinkConfirm url="https://example.com/" onAnswer={onAnswer} />);
      fireEvent.click(screen.getByRole('button', { name: 'readerLinkCancel' }), { detail: 1 });
      expect(onAnswer).toHaveBeenCalledExactlyOnceWith(false);
    });
  });
});
