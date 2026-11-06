// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountReaderSelection } from '../../../components/reader/selection-toolbar';
import { useReaderSelection } from '../../../components/reader/useReaderSelection';

vi.mock('../../../components/reader/selection-toolbar', () => ({
  mountReaderSelection: vi.fn(),
}));

const mount = vi.mocked(mountReaderSelection);
const handles: { stop: ReturnType<typeof vi.fn>; reposition: ReturnType<typeof vi.fn> }[] = [];

beforeEach(() => {
  handles.length = 0;
  mount.mockReset().mockImplementation(() => {
    const handle = { stop: vi.fn(), reposition: vi.fn() };
    handles.push(handle);
    return handle;
  });
});
afterEach(cleanup);

describe('PDF selection UI lifecycle', () => {
  it('keeps the command listener available and disposes document UI on close', () => {
    const ref = { current: document.createElement('div') };
    const { rerender, unmount } = renderHook(
      ({ key }: { key: number | null }) => useReaderSelection(ref, 0, key),
      { initialProps: { key: null } as { key: number | null } },
    );
    expect(mount).toHaveBeenCalledTimes(1);
    rerender({ key: 1 });
    expect(handles[0]!.stop).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    rerender({ key: null });
    expect(handles[1]!.stop).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(3);
    unmount();
    expect(handles[2]!.stop).toHaveBeenCalledOnce();
  });

  it('disposes the previous PDF on replacement, but keeps sessions across page renders', () => {
    const ref = { current: document.createElement('div') };
    const { rerender, unmount } = renderHook(
      ({ key, renders }) => useReaderSelection(ref, renders, key),
      { initialProps: { key: 1, renders: 0 } },
    );
    rerender({ key: 1, renders: 2 });
    expect(mount).toHaveBeenCalledTimes(1);
    expect(handles[0]!.stop).not.toHaveBeenCalled();
    rerender({ key: 2, renders: 2 });
    expect(handles[0]!.stop).toHaveBeenCalledOnce();
    expect(mount).toHaveBeenCalledTimes(2);
    unmount();
    expect(handles[1]!.stop).toHaveBeenCalledOnce();
  });
});
