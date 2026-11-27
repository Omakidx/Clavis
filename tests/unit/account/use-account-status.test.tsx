// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyAccountStatusChanged, onAccountStatusChanged } from '../../../lib/data/channel';
import { accountApi } from '../../../lib/ui-client/account-api';
import { useAccountStatus } from '../../../lib/ui-client/use-account-status';

afterEach(() => cleanup());

function Probe() {
  const status = useAccountStatus();
  return (
    <p data-testid="state">
      {status.state.status === 'ready' ? status.state.data.sync.state : status.state.status}
    </p>
  );
}

const reply = (state: 'syncing' | 'idle') => ({
  ok: true as const,
  data: {
    enabled: true,
    signedIn: true,
    sync: { state, pending: 0, rejected: 0 },
  },
});

describe('useAccountStatus', () => {
  it('re-reads when the background signals a status change, without waiting for the poll', async () => {
    let state: 'syncing' | 'idle' = 'syncing';
    const get = vi
      .spyOn(accountApi, 'getStatus')
      .mockImplementation(() => Promise.resolve(reply(state)));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('syncing'));
    state = 'idle';
    // What the background does when the sync ends (the poll is 5 s away).
    act(() => notifyAccountStatusChanged());
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('idle'), {
      timeout: 1500,
    });
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('re-reads when the page becomes visible and when the window gets focus', async () => {
    const get = vi
      .spyOn(accountApi, 'getStatus')
      .mockImplementation(() => Promise.resolve(reply('idle')));
    render(<Probe />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  });

  it('the signal carries nothing: no email, no token, no counts', async () => {
    const received: unknown[] = [];
    const channel = new BroadcastChannel('clavis-data');
    channel.onmessage = (event) => received.push(event.data);
    const stop = onAccountStatusChanged(() => undefined);
    notifyAccountStatusChanged();
    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toEqual({ accountStatus: true });
    stop();
    channel.close();
  });
});
