// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider, useToast } from '../../../components/common/Toast';
import { installCatalog } from '../ui-client/support';

function Harness() {
  const toast = useToast();
  return (
    <>
      <button onClick={() => toast?.show({ content: 'Saved.', tone: 'success' })}>Save</button>
      <button onClick={() => toast?.show({ content: 'Could not save.', tone: 'danger' })}>
        Fail
      </button>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Settings toast host', () => {
  it('starts empty, replaces rather than stacks, expires and repeats identical feedback', () => {
    installCatalog();
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    expect(screen.queryByTestId('settings-toast')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByTestId('settings-toast')).toHaveLength(1);
    expect(screen.getByTestId('settings-toast')).toHaveTextContent('Saved.');
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByTestId('settings-toast')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByTestId('settings-toast')).toHaveTextContent('Saved.');
    fireEvent.click(screen.getByRole('button', { name: 'Fail' }));
    expect(screen.getAllByTestId('settings-toast')).toHaveLength(1);
    expect(screen.getByTestId('settings-toast')).toHaveTextContent('Could not save.');
    act(() => vi.advanceTimersByTime(6999));
    expect(screen.getByTestId('settings-toast')).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('settings-toast')).toBeNull();
  });

  it('pauses while hovered or focused and offers an accessible close button', () => {
    installCatalog();
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const card = screen.getByTestId('settings-toast');
    act(() => vi.advanceTimersByTime(2000));
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(5000));
    expect(card).toBeVisible();
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(1999));
    expect(card).toBeVisible();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByTestId('settings-toast')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const focusedCard = screen.getByTestId('settings-toast');
    const close = screen.getByRole('button', { name: 'Dismiss notification' });
    fireEvent.focus(close);
    act(() => vi.advanceTimersByTime(5000));
    expect(focusedCard).toBeVisible();
    fireEvent.click(close);
    expect(screen.queryByTestId('settings-toast')).toBeNull();
  });
});
