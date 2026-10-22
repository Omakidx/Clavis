// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { requestSiteAccess, useSiteAccess } from '../../../lib/site-access/use-site-access';

type Listener = () => void;

function setup(initial: { granted: boolean; request?: () => Promise<boolean> }) {
  let granted = initial.granted;
  const added: Listener[] = [];
  const removed: Listener[] = [];
  const request = vi.fn(initial.request ?? (() => Promise.resolve(true)));
  Object.assign(browser, {
    permissions: {
      contains: vi.fn(() => Promise.resolve(granted)),
      request,
      onAdded: {
        addListener: (l: Listener) => void added.push(l),
        removeListener: vi.fn(),
      },
      onRemoved: {
        addListener: (l: Listener) => void removed.push(l),
        removeListener: vi.fn(),
      },
    },
  });
  return {
    request,
    setGranted: (value: boolean) => void (granted = value),
    fireAdded: () => added.forEach((l) => l()),
    fireRemoved: () => removed.forEach((l) => l()),
  };
}

beforeEach(() => vi.restoreAllMocks());

describe('requestSiteAccess', () => {
  it('requests exactly the optional http and https origins', async () => {
    const request = vi.fn(() => Promise.resolve(true));
    expect(await requestSiteAccess({ request } as never)).toBe('granted');
    expect(request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
  });

  it('maps a declined prompt to "denied" and a failure to "error"', async () => {
    expect(await requestSiteAccess({ request: () => Promise.resolve(false) } as never)).toBe(
      'denied',
    );
    expect(
      await requestSiteAccess({ request: () => Promise.reject(new Error('no gesture')) } as never),
    ).toBe('error');
  });
});

describe('useSiteAccess', () => {
  it('reports the current grant and follows permission events', async () => {
    const env = setup({ granted: false });
    const { result } = renderHook(() => useSiteAccess());
    expect(result.current.status).toBe('unknown');
    await waitFor(() => expect(result.current.status).toBe('not-granted'));

    env.setGranted(true);
    act(() => env.fireAdded());
    await waitFor(() => expect(result.current.status).toBe('granted'));

    env.setGranted(false);
    act(() => env.fireRemoved());
    await waitFor(() => expect(result.current.status).toBe('not-granted'));
  });

  it('calls permissions.request synchronously from grant() so the user gesture is kept', async () => {
    const env = setup({ granted: false });
    const { result } = renderHook(() => useSiteAccess());
    await waitFor(() => expect(result.current.status).toBe('not-granted'));

    act(() => result.current.grant());
    // No await between the click and the request: it must already have been called.
    expect(env.request).toHaveBeenCalledTimes(1);
    expect(result.current.requestState).toBe('pending');
    await waitFor(() => expect(result.current.requestState).toBe('granted'));
    expect(result.current.status).toBe('granted');
  });

  it('records a declined prompt', async () => {
    setup({ granted: false, request: () => Promise.resolve(false) });
    const { result } = renderHook(() => useSiteAccess());
    act(() => result.current.grant());
    await waitFor(() => expect(result.current.requestState).toBe('denied'));
    expect(result.current.status).toBe('not-granted');
  });

  it('skip() records the choice without calling Chrome', async () => {
    const env = setup({ granted: false });
    const { result } = renderHook(() => useSiteAccess());
    act(() => result.current.skip());
    expect(result.current.requestState).toBe('skipped');
    expect(env.request).not.toHaveBeenCalled();
  });
});
