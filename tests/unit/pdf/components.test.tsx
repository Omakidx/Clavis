// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { PasswordPrompt } from '../../../components/reader/PasswordPrompt';
import { SelectionPanel } from '../../../components/reader/SelectionPanel';
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
  it('shows the open hint when empty and the drop hint while dragging', () => {
    const { unmount } = renderState({ phase: 'empty' });
    expect(screen.getByTestId('state-empty')).toHaveTextContent('readerEmptyHint');
    unmount();
    renderState({ phase: 'empty' }, true);
    expect(screen.getByTestId('state-empty')).toHaveTextContent('readerDropActive');
  });

  it('announces loading with the file name', () => {
    renderState({ phase: 'loading', name: 'book.pdf' });
    expect(screen.getByRole('status')).toHaveTextContent('readerLoading(book.pdf)');
  });

  it.each([
    ['CORRUPT', 'readerErrorCorrupt'],
    ['PERMISSION', 'readerErrorPermission'],
    ['UNSUPPORTED', 'readerErrorUnsupported'],
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

describe('SelectionPanel', () => {
  it('shows the empty message without a selection', () => {
    render(<SelectionPanel selection={null} />);
    expect(screen.getByTestId('selection-none')).toBeInTheDocument();
  });

  it('shows text, page and the snapshot source/kind of the last selection', () => {
    render(
      <SelectionPanel
        selection={{
          truncated: false,
          snapshot: {
            selectionId: '3f2b8c1e-5d4a-4c2b-9e1f-0a1b2c3d4e5f',
            source: 'pdf',
            kind: 'sentence',
            text: 'A selected sentence.',
            page: 4,
          },
        }}
      />,
    );
    expect(screen.getByTestId('selection-text')).toHaveTextContent('A selected sentence.');
    expect(screen.getByTestId('selection-page')).toHaveAttribute('data-page', '4');
    expect(document.querySelector('[data-source="pdf"][data-kind="sentence"]')).not.toBeNull();
  });
});
