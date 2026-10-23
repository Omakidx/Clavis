// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { FindBar } from '../../../components/reader/FindBar';
import type { FindStatus } from '../../../lib/pdf/find';

beforeEach(() => {
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(
    ((key: string, subs?: string | string[]) =>
      `${key}${subs === undefined ? '' : `(${[subs].flat().join(',')})`}`) as never,
  );
});

const idle: FindStatus = { state: 'idle', current: 0, total: 0 };

function setup(props: Partial<Parameters<typeof FindBar>[0]> = {}) {
  const handlers = {
    onQuery: vi.fn(),
    onToggleCase: vi.fn(),
    onStep: vi.fn(),
    onClose: vi.fn(),
  };
  render(
    <FindBar
      query="bank"
      caseSensitive={false}
      find={idle}
      inputRef={{ current: null }}
      barRef={{ current: null }}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

describe('<FindBar>', () => {
  it('is a labelled search landmark with a status region', () => {
    setup();
    expect(screen.getByRole('search', { name: 'readerFindLabel' })).toBeInTheDocument();
    expect(screen.getByTestId('find-status')).toHaveAttribute('role', 'status');
  });

  it('steps with Enter and Shift+Enter in the box and with the buttons', async () => {
    const h = setup();
    const user = userEvent.setup();
    await user.click(screen.getByTestId('find-input'));
    await user.keyboard('{Enter}');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.click(screen.getByRole('button', { name: 'readerFindNext' }));
    await user.click(screen.getByRole('button', { name: 'readerFindPrev' }));
    expect(h.onStep.mock.calls).toEqual([[false], [true], [false], [true]]);
  });

  it('disables stepping while the query is blank', () => {
    setup({ query: '   ' });
    expect(screen.getByRole('button', { name: 'readerFindNext' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'readerFindPrev' })).toBeDisabled();
  });

  it('shows the match count, "not found" and "searching" from the status', () => {
    const { unmount } = render(<div />);
    unmount();
    for (const [find, text] of [
      [{ state: 'found', current: 2, total: 5 }, 'readerFindCount(2,5)'],
      [{ state: 'not-found', current: 0, total: 0 }, 'readerFindNotFound'],
      [{ state: 'pending', current: 0, total: 0 }, 'readerFindPending'],
    ] as const) {
      document.body.replaceChildren();
      setup({ find });
      expect(screen.getByTestId('find-status')).toHaveTextContent(text);
    }
  });

  it('shows nothing for an empty query even if the controller still reports a result', () => {
    setup({ query: '', find: { state: 'found', current: 1, total: 3 } });
    expect(screen.getByTestId('find-status')).toHaveTextContent('');
  });

  it('reports the case toggle as pressed and toggles it', async () => {
    const h = setup({ caseSensitive: true });
    const toggle = screen.getByRole('button', { name: 'readerFindCase' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await userEvent.setup().click(toggle);
    expect(h.onToggleCase).toHaveBeenCalledTimes(1);
  });

  it('forwards typing and the close button', async () => {
    const h = setup({ query: '' });
    const user = userEvent.setup();
    await user.type(screen.getByTestId('find-input'), 'ab');
    expect(h.onQuery.mock.calls.map(([v]) => v)).toEqual(['a', 'b']);
    await user.click(screen.getByRole('button', { name: 'readerFindClose' }));
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });
});
